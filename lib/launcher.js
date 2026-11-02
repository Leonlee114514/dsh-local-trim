/**
 * 「一键拉起后端」—— 面板上的按钮真正要做的事。
 *
 * 目标不是「随便 exec 一条命令」，而是：端点连不上时，插件自己找出这台机器上
 * 装没装那个后端，起一个脱离宿主的进程，然后**等到端口真的应答**再回来。
 *
 * 三条硬约束（都是踩过的坑）：
 *  1. 子进程必须 detached + unref + stdio:'ignore'。宿主重启/热重载时不能把用户的
 *     推理服务一起带走，反过来服务吐的日志也不能污染宿主的 stdout。
 *  2. 拉起之后不能立刻回「成功」—— 模型加载要几秒到几十秒，面板必须等到 /v1/models
 *     真应答（或超时）才下结论，否则点完按钮还是红灯。
 *  3. 找不到可执行文件时说清楚找了哪些路径，而不是抛一个 ENOENT。
 *
 * 这里所有副作用都走依赖注入（existsSync / spawnImpl / probe / sleep），
 * 所以能离线单测，不需要真起进程。
 */

import { existsSync as fsExistsSync, readdirSync as fsReaddirSync, statSync as fsStatSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'

const WIN = process.platform === 'win32'

/** 端口 → 后端识别。顺序无所谓，按端口查表。 */
export const KNOWN_LAUNCHERS = [
  {
    id: 'ollama',
    label: 'Ollama',
    port: 11434,
    // 常见的安装位置 + PATH 上的裸名字，先找到哪个用哪个
    candidates: () => [
      process.env.OLLAMA_BIN,
      'C:/Users/' + (process.env.USERNAME ?? '') + '/AI/ollama/ollama.exe',
      process.env.LOCALAPPDATA + '/Programs/Ollama/ollama.exe',
      'C:/Program Files/Ollama/ollama.exe',
      'ollama',
    ].filter((item) => typeof item === 'string' && item.length > 0),
    args: ['serve'],
    env: () => ({
      OLLAMA_HOST: '127.0.0.1:11434',
      ...(process.env.OLLAMA_MODELS ? {} : modelsDirHint()),
    }),
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    port: 8090,
    candidates: (io) => [
      workbuddyBinary(io),
      process.env.LLAMA_SERVER_BIN,
      'C:/Users/' + (process.env.USERNAME ?? '') + '/AI/llama.cpp/llama-server.exe',
      'llama-server',
      'llama-server.exe',
    ].filter((item) => typeof item === 'string' && item.length > 0),
    // llama-server 必须带 -m 模型文件才能起。配置里没写模型时，
    // 去 WorkBuddy 的本地模型目录捡现成的 gguf（那里已经有下好的 35B）。
    args: null,
    autoArgs: (io) => llamaCppAutoArgs(io),
    env: () => ({}),
  },
  {
    id: 'vllm',
    label: 'vLLM',
    port: 8000,
    candidates: () => [process.env.VLLM_BIN, 'vllm', 'vllm.exe'].filter(Boolean),
    args: null,
    env: () => ({}),
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    port: 1234,
    candidates: () => [
      process.env.LMSTUDIO_BIN,
      process.env.LOCALAPPDATA + '/LM-Studio/lms.exe',
      'lms',
    ].filter((item) => typeof item === 'string' && item.length > 0),
    args: null,
    env: () => ({}),
  },
]

/** 常见模型目录，用来给 ollama 补 OLLAMA_MODELS（不猜磁盘上不存在的路径）。 */
function modelsDirHint() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const guesses = [
    home + '/AI/models/ollama',
    process.env.LOCALAPPDATA + '/ollama/models',
    home + '/.ollama/models',
  ]
  for (const guess of guesses) {
    if (typeof guess === 'string' && guess.length > 0 && safeExists(guess)) return { OLLAMA_MODELS: guess }
  }
  return {}
}

function safeExists(path) {
  try {
    return fsExistsSync(path)
  } catch {
    return false
  }
}

export function launcherForPort(port) {
  return KNOWN_LAUNCHERS.find((item) => item.port === Number(port)) ?? null
}

export function portOfBaseURL(baseURL) {
  const match = /^[a-z]+:\/\/([^/:]+|\[[^\]]+\])(?::(\d+))?/i.exec(String(baseURL ?? ''))
  if (match === null) return 0
  if (match[2] !== undefined) return Number(match[2])
  return String(baseURL).toLowerCase().startsWith('https://') ? 443 : 80
}

/**
 * 决定「这个端口该怎么拉起来」。
 * @param {{port?: number, customCommand?: string, existsSync?: (p: string) => boolean}} input
 * @returns {{ok: true, id: string, label: string, port: number, command: string, args: string[],
 *            env: Record<string, string>, source: 'custom'|'known'}
 *          | {ok: false, error: string, tried: string[]}}
 */
export function planLaunch(input = {}) {
  const exists = typeof input.existsSync === 'function' ? input.existsSync : safeExists
  const listDir = typeof input.listDir === 'function' ? input.listDir : safeListDir
  const custom = String(input.customCommand ?? '').trim()
  if (custom.length > 0) {
    const parts = splitCommand(custom)
    return {
      ok: true,
      id: 'custom',
      label: parts[0],
      port: Number(input.port) || 0,
      command: parts[0],
      args: parts.slice(1),
      env: {},
      source: 'custom',
    }
  }

  const port = Number(input.port) || 0
  const io = { exists, listDir }
  let known = launcherForPort(port)
  if (known === null && String(input.modelPath ?? '').trim().length > 0) {
    // 一键配置允许用户自选端口。端口不在表里不代表后端不认识 ——
    // 给了 gguf 就说明意图是 llama.cpp，按它处理，端口照用户填的用。
    known = KNOWN_LAUNCHERS.find((item) => item.id === 'llamacpp') ?? null
  }
  if (known === null) {
    return {
      ok: false,
      error: `不知道 ${port || '这个'} 端口该起什么后端；在高级配置里填一条启动命令就行`,
      tried: [],
    }
  }
  if (known.args === null) {
    // 这类后端（llama.cpp / vLLM / lms）必须带模型参数。但「没装」和
    // 「装了但要模型文件」是两件完全不同的事：前者该去装，后者该去填命令。
    // 所以先找一遍可执行文件，再决定报哪一句。
    const probe = resolveCommand(known, io)
    if (probe.command === null) {
      return {
        ok: false,
        error: `本机没找到 ${known.label} 的可执行文件（它本该在 ${port || known.port} 端口应答）`,
        tried: probe.tried,
      }
    }
    // 配置里没给命令时，先看插件自己能不能拼出来（WorkBuddy 的 llama.cpp +
    // 已下好的 gguf 就是现成的一对），拼得出来就别让用户手抄命令。
    const auto = typeof known.autoArgs === 'function'
      ? known.autoArgs({ ...io, port, alias: input.alias, ctx: input.ctx, modelPath: input.modelPath })
      : null
    if (auto && auto.ok === true) {
      return {
        ok: true,
        id: known.id,
        label: known.label,
        port: port || known.port,
        command: probe.command,
        args: auto.args,
        env: known.env(),
        source: 'discovered',
        model: auto.model,
      }
    }
    return {
      ok: false,
      error:
        `${known.label} 需要模型文件才能起，插件不替你猜。已找到 ${probe.command}，` +
        `在高级配置里填一条完整命令即可（例如：${probe.command} -m 模型.gguf --host 127.0.0.1 --port ${port || known.port}）`,
      tried: probe.tried,
    }
  }

  const probe = resolveCommand(known, io)
  if (probe.command === null) {
    return { ok: false, error: `没找到 ${known.label} 的可执行文件`, tried: probe.tried }
  }
  return {
    ok: true,
    id: known.id,
    label: known.label,
    port: known.port,
    command: probe.command,
    args: [...known.args],
    env: known.env(),
    source: "known",
  }
}

/** 按 candidates 找可执行文件：返回命中的那条，以及试过的清单。 */
function resolveCommand(known, io) {
  const exists = io.exists
  const tried = []
  for (const candidate of known.candidates(io)) {
    tried.push(candidate)
    // 带路径分隔符的直接看文件在不在；裸名字交给 PATH 解析（Windows 还要补 .exe）
    const separators = candidate.includes("/") || candidate.includes(String.fromCharCode(92))
    if (!separators) {
      const hit = whichOnPath(candidate, exists)
      if (hit !== null) return { command: hit, tried }
      continue
    }
    if (exists(candidate)) return { command: candidate, tried }
  }
  return { command: null, tried }
}

/** 目录枚举：出错当空目录（Windows 上不存在/没权限都会抛）。 */
function safeListDir(dir) {
  try {
    return fsReaddirSync(dir)
  } catch {
    return []
  }
}

/**
 * WorkBuddy 的本地模型布局 —— 这台机器上真正放着 35B 的地方：
 *   ~/.workbuddy/local-models/bin/<build>/llama-server.exe
 *   ~/.workbuddy/local-models/files/*.gguf
 * 插件不自带模型，但已经下好的那一份可以直接借来用：
 * 让用户为同一次「拉起」再下一次 20GB 不合理。
 */
export function workbuddyRoot() {
  const home = process.env.USERPROFILE ?? 'C:/Users/' + (process.env.USERNAME ?? '')
  return home.split(String.fromCharCode(92)).join('/') + '/.workbuddy/local-models'
}

/** 在 WorkBuddy 的 build 目录里挑最新一个 llama-server.exe。 */
function workbuddyBinary(io) {
  const base = workbuddyRoot() + '/bin'
  const builds = io.listDir(base).filter((name) => io.exists(base + '/' + name + '/llama-server.exe'))
  if (builds.length === 0) return null
  builds.sort()
  return base + '/' + builds[builds.length - 1] + '/llama-server.exe'
}

/**
 * 拼 llama-server 的参数。挑模型规则：优先 local_model.gguf，否则按名字排序取第一个；
 * 带 .mmproj. 的是视觉投影，不能当主模型。
 * 参数按这台机器的实测结论取：q8_0 KV + 单 slot + --fit on，权重 17GB 才压得住上下文。
 */
export function llamaCppAutoArgs(io = {}) {
  const root = workbuddyRoot()
  const explicit = String(io.modelPath ?? '').trim()
  let model
  let preferred
  if (explicit.length > 0) {
    // 面板上选定了某个 gguf，就用它，不再去目录里猜
    model = explicit.split(String.fromCharCode(92)).join('/')
    preferred = model.slice(model.lastIndexOf('/') + 1)
  } else {
    const files = (io.listDir ? io.listDir : safeListDir)(root + '/files')
      .filter((name) => /.gguf$/i.test(name) && !/.mmproj./i.test(name))
    if (files.length === 0) return { ok: false, reason: 'no-model' }
    preferred = files.find((name) => /^local_model.gguf$/i.test(name)) ?? files.slice().sort()[0]
    model = root + '/files/' + preferred
  }
  const port = Number(io.port) || 8090
  const ctx = Number(io.ctx) || 65536
  const alias = String(io.alias ?? preferred.replace(/.gguf$/i, ''))
  return {
    ok: true,
    model,
    args: [
      '-m', model,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--alias', alias,
      '--n-gpu-layers', 'auto',
      '--fit', 'on',
      '--parallel', '1',
      '--jinja',
      '--cache-type-k', 'q8_0',
      '--cache-type-v', 'q8_0',
      '-c', String(ctx),
      '--n-predict', '8192',
    ],
  }
}

/**
 * 本机已经下好的 gguf 清单。
 *
 * 「下好一个模型」和「DSH 里能用它」之间原来隔着一整段手工活：找二进制、拼参数、
 * 起服务、写 provider。这里只负责第一步 —— 把磁盘上真实存在的模型文件列出来，
 * 让面板能直接拿它去起服务，而不是要求用户先把服务跑起来再去「导入端点」。
 *
 * 目录按命中概率排：WorkBuddy 的下载目录、AI/models、用户目录下的 models、
 * 以及 LM Studio 的默认缓存。每层只扫 depth 层，避免把整个磁盘翻一遍。
 */
export function localModelDirs() {
  const home = (process.env.USERPROFILE ?? 'C:/Users/' + (process.env.USERNAME ?? '')).split(String.fromCharCode(92)).join('/')
  const local = String(process.env.LOCALAPPDATA ?? home + '/AppData/Local').split(String.fromCharCode(92)).join('/')
  return [
    workbuddyRoot() + '/files',
    home + '/AI/models',
    home + '/models',
    home + '/.lmstudio/models',
    local + '/LM-Studio/models',
    home + '/Downloads',
  ]
}

/**
 * 列 gguf。返回 [{ path, name, dir, sizeBytes, mmproj }]，按大小降序（大的通常是想用的那个）。
 * io 全部可注入：exists / listDir / statSize / dirs。
 */
export function scanLocalModels(io = {}) {
  const exists = typeof io.exists === 'function' ? io.exists : safeExists
  const listDir = typeof io.listDir === 'function' ? io.listDir : safeListDir
  const statSize = typeof io.statSize === 'function' ? io.statSize : safeSize
  const dirs = Array.isArray(io.dirs) ? io.dirs : localModelDirs()
  const depth = Number(io.depth) > 0 ? Number(io.depth) : 2
  const found = []
  const seen = new Set()

  const walk = (dir, level) => {
    if (level > depth || seen.has(dir)) return
    seen.add(dir)
    let names = []
    try {
      names = listDir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = dir + '/' + name
      if (/.gguf$/i.test(name)) {
        found.push({
          path: full,
          name,
          dir,
          sizeBytes: statSize(full),
          // .mmproj. 是视觉投影，单独标出来，别让人当主模型选
          mmproj: /.mmproj./i.test(name),
        })
        continue
      }
      // 目录：只在看起来像模型库的名字上继续往下走一层
      if (/^[^.]/.test(name) && level < depth) {
        if (exists(full + '/')) walk(full, level + 1)
        else if (/model|gguf|lmstudio|hub|blobs|files/i.test(name)) walk(full, level + 1)
      }
    }
  }

  for (const dir of dirs) {
    if (typeof dir === 'string' && dir.length > 0 && exists(dir)) walk(dir, 1)
  }

  found.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))
  return found
}

function safeSize(path) {
  try {
    return fsStatSync(path).size
  } catch {
    return 0
  }
}

/** 在 PATH 里找一个裸命令。Windows 上补 .exe / .cmd。 */
export function whichOnPath(name, exists = safeExists) {
  const pathValue = process.env.PATH ?? ''
  const sep = WIN ? ';' : ':'
  const extensions = WIN ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of pathValue.split(sep)) {
    if (dir.length === 0) continue
    for (const ext of extensions) {
      const full = (dir.endsWith('\\') || dir.endsWith('/') ? dir : dir + (WIN ? '\\' : '/')) + name + ext
      if (exists(full)) return full
    }
  }
  return null
}

/** 极简命令行切分：认双引号，别的不折腾。 */
export function splitCommand(command) {
  const out = []
  const text = String(command ?? '')
  let current = ''
  let quoted = false
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) {
        out.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * 起一个脱离宿主的进程。返回 pid（拿不到就是 0）。
 * 不等待退出：`serve` 这种是常驻进程，等到退出就等于永远不返回。
 */
export function runDetached(input) {
  const spawnImpl = typeof input.spawnImpl === 'function' ? input.spawnImpl : nodeSpawn
  try {
    const child = spawnImpl(input.command, input.args ?? [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
    })
    // 常驻进程：解绑，别让宿主的生命周期管它
    if (typeof child.unref === 'function') child.unref()
    return { ok: true, pid: Number(child.pid) || 0 }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * 等端口真应答：反复探 /v1/models，直到 ok 或超时。
 * @param {{probe: () => Promise<{ok: boolean}>, timeoutMs?: number, intervalMs?: number,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number}} input
 */
export async function waitForEndpoint(input) {
  const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 20000
  const intervalMs = Number(input.intervalMs) > 0 ? Number(input.intervalMs) : 500
  const sleep = typeof input.sleep === 'function' ? input.sleep : (ms) => new Promise((done) => setTimeout(done, ms))
  const now = typeof input.now === 'function' ? input.now : Date.now
  const startedAt = now()
  let attempts = 0
  let lastError = ''

  while (now() - startedAt < timeoutMs) {
    attempts += 1
    const result = await input.probe()
    if (result?.ok === true) {
      return { ok: true, ms: now() - startedAt, attempts, models: result.models ?? [] }
    }
    lastError = String(result?.error ?? '连不上')
    await sleep(intervalMs)
  }
  return {
    ok: false,
    ms: now() - startedAt,
    attempts,
    error: `等了 ${Math.round(timeoutMs / 1000)} 秒还没起来（最后一次：${lastError}）`,
  }
}
