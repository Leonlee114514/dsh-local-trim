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
import { execFileSync as nodeExecFileSync, spawn as nodeSpawn } from 'node:child_process'

const WIN = process.platform === 'win32'

/** execFileSync 的默认实现（可被 detectGpuBytes 的调用方覆盖）。 */
const defaultExecFileSync = nodeExecFileSync

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
      ? known.autoArgs({
          ...io,
          port,
          alias: input.alias,
          ctx: input.ctx,
          modelPath: input.modelPath,
          // noMmap 是 v0.4.0 的旧入口，保留兼容：转成 load-mode none。
          loadMode: normalizeLoadMode(input.loadMode ?? (input.noMmap === true ? 'none' : '')),
        })
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
  // 加载模式：b11012 用 `--load-mode auto|none|mmap|mlock|mmap+mlock`，
  // 没有 `--no-mmap`（那是老版 llama.cpp 的参数，传进去直接
  // `error: invalid argument: --no-mmap` 起不来）。
  // 默认不传 —— mmap 是 b11012 的 auto 行为，也是 MoE 按需换入专家的前提。
  const loadMode = normalizeLoadMode(io.loadMode ?? (io.noMmap === true ? 'none' : ''))
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
      ...(loadMode.length > 0 ? ['--load-mode', loadMode] : []),
      '-c', String(ctx),
      '--n-predict', '8192',
    ],
    loadMode,
  }
}

/** b11012 认的五个加载模式；空串 = 不传，交给引擎自己选。 */
export const LOAD_MODES = ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock']

/** 校验并归一化加载模式，认不出来的当没填。 */
export function normalizeLoadMode(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return LOAD_MODES.includes(text) ? text : ''
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
 * io 全部可注入：exists / listDir / statSize / dirs / depth / maxModels / maxEntries。
 *
 * 边界：`~/Downloads` 这种目录可能有几万个文件，`node_modules` 式的深坑更多。
 * 所以这里三道上限 —— 单目录读入条数、总访问节点数、命中模型数 —— 任意一道满了就停，
 * 并在返回值里带上 `truncated`，让面板能说「只扫了前 N 个」而不是假装扫全了。
 */
export function scanLocalModels(io = {}) {
  const exists = typeof io.exists === 'function' ? io.exists : safeExists
  const listDir = typeof io.listDir === 'function' ? io.listDir : safeListDir
  const statSize = typeof io.statSize === 'function' ? io.statSize : safeSize
  const dirs = Array.isArray(io.dirs) ? io.dirs : localModelDirs()
  const depth = Number(io.depth) > 0 ? Number(io.depth) : 2
  const maxModels = Number(io.maxModels) > 0 ? Number(io.maxModels) : 300
  const maxEntries = Number(io.maxEntries) > 0 ? Number(io.maxEntries) : 20_000
  // Downloads 只扫一层：里面通常是压缩包和安装器，套一层子目录就是别人解压出来的项目树。
  const shallowDirs = Array.isArray(io.shallowDirs)
    ? io.shallowDirs
    : ['Downloads', 'downloads', '下載']
  const isShallow = (dir) => shallowDirs.some((name) => new RegExp('[\\\\/]' + name + '$').test(dir))

  const found = []
  const seen = new Set()
  let entries = 0
  let truncated = false

  const walk = (dir, level, limit) => {
    if (truncated || level > limit || seen.has(dir)) return
    seen.add(dir)
    let names = []
    try {
      names = listDir(dir)
    } catch {
      return
    }
    for (const name of names) {
      entries += 1
      if (entries > maxEntries || found.length >= maxModels) {
        truncated = true
        return
      }
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
      if (/^[^.]/.test(name) && level < limit) {
        if (exists(full + '/')) walk(full, level + 1, limit)
        else if (/model|gguf|lmstudio|hub|blobs|files/i.test(name)) walk(full, level + 1, limit)
      }
    }
  }

  for (const dir of dirs) {
    if (truncated) break
    if (typeof dir !== 'string' || dir.length === 0) continue
    if (!exists(dir)) continue
    walk(dir, 1, isShallow(dir) ? 1 : depth)
  }

  found.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))
  // 数组本身照旧返回（老调用方按数组用），额外信息挂在 found 上。
  found.truncated = truncated
  found.scannedEntries = entries
  return found
}

function safeSize(path) {
  try {
    return fsStatSync(path).size
  } catch {
    return 0
  }
}

/** 读宿主 PATH —— 键名在 bash 里是 PATH、在 PowerShell 里是 Path，两种都得认。 */
export function envPathValue(env = process.env) {
  if (typeof env?.PATH === 'string' && env.PATH.length > 0) return env.PATH
  if (typeof env?.Path === 'string' && env.Path.length > 0) return env.Path
  for (const name of Object.keys(env ?? {})) {
    if (/^path$/i.test(name) && typeof env[name] === 'string' && env[name].length > 0) return env[name]
  }
  return ''
}

/** 在 PATH 里找一个裸命令。Windows 上补 .exe / .cmd。 */
export function whichOnPath(name, exists = safeExists) {
  const pathValue = envPathValue()
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
 * 合并环境变量，按「大小写不敏感」去重。
 *
 * Windows 的 `process.env` 键长什么样取决于启动它的 shell：bash 里是 `PATH`，
 * PowerShell 里是 `Path`。直接 `{ ...process.env, ...extra }` 很容易拼出
 * `{ Path: '...', PATH: '...' }` 这种双键 —— Node 在 Windows 上按自己认的那一个取值，
 * 子进程于是可能一个 PATH 都拿不到（实测表现为 spawn ENOENT，连 node 都找不到）。
 *
 * 规则：后写的覆盖先写的，同名判定用 toUpperCase 比较，保留后写的那个键名。
 */
export function mergeEnv(base, extra) {
  const out = {}
  const keyOf = (name) => String(name).toUpperCase()
  const seen = new Map()
  const push = (source) => {
    for (const name of Object.keys(source ?? {})) {
      const value = source[name]
      if (value === undefined) continue
      const slot = keyOf(name)
      const previous = seen.get(slot)
      if (previous !== undefined) delete out[previous]
      out[name] = value
      seen.set(slot, name)
    }
  }
  push(base)
  push(extra)
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
      env: mergeEnv(process.env, input.env),
    })
    // 常驻进程：解绑，别让宿主的生命周期管它
    if (typeof child.unref === 'function') child.unref()
    return { ok: true, pid: Number(child.pid) || 0 }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * 拉起之前的资源预检。
 *
 * 第一版是错的，这里记下来免得再错一次。v0.4.0 拿 gguf 全长去比「整机内存 - 2GB」，
 * 15.8GB / 14.4GB 算出 ratio 1.1 → 直接判 risky，还自动改 `--no-mmap`。两条都站不住：
 *  1. gguf 是通过 mmap 读的，落在 **file-backed page cache** 里，可回收。
 *     实测这台机器跑着 27.2B MoE：WorkingSet 285–691MB、Private 19GB（全是 file-backed），
 *     系统 Available 还有 2.2GB，任务管理器不会爆，也不换页 —— 因为热权重主流在显存里
 *     （VRAM 14289/14848 MiB，util 87–93%，SM 时钟 2444/3003MHz）。
 *  2. b11012 根本不认 `--no-mmap`（`error: invalid argument`），加了必然起不来。
 *
 * 所以真正该问的不是「gguf 比内存大不大」，而是「显存装不下的那部分，落在哪」：
 *  - 走 mmap（默认）→ 落在 page cache，可回收，代价只是首 token 慢，不是卡死；
 *  - 走 none/mlock（匿名内存/锁页）→ 真吃 RAM，这时候才可能换页、可能卡死。
 *
 * 唯一的硬拦条件是「显存 + 内存都装不下」——那不是慢，是必然失败。
 *
 * @param {{sizeBytes?: number, totalMemBytes?: number, freeMemBytes?: number,
 *   gpuBytes?: number, reserveBytes?: number, loadMode?: string}} input
 */
export function checkModelFit(input = {}) {
  const sizeBytes = Number(input.sizeBytes)
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { level: 'unknown', sizeBytes: 0, label: '没拿到模型体积，不做预检', ratio: 0 }
  }
  const totalMemBytes = Number(input.totalMemBytes) > 0 ? Number(input.totalMemBytes) : 0
  const freeMemBytes = Number(input.freeMemBytes) > 0 ? Number(input.freeMemBytes) : 0
  const gpuBytes = Number(input.gpuBytes) > 0 ? Number(input.gpuBytes) : 0
  // 给系统留 2048MiB：Windows 自己、宿主、浏览器都要吃内存。
  const reserveBytes = Number(input.reserveBytes) > 0 ? Number(input.reserveBytes) : 2048 * 1024 * 1024
  const gib = (bytes) => Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10
  const sizeGib = gib(sizeBytes)

  // 显存装得下的部分不占系统内存。装不下的那部分才是宿主要接的量。
  const hostBytes = Math.max(sizeBytes - gpuBytes, 0)
  const hostGib = gib(hostBytes)
  const budget = Math.max(totalMemBytes - reserveBytes, freeMemBytes, 0)
  const ratio = budget > 0 ? hostBytes / budget : 0
  // 匿名内存模式：不走 mmap，就等于要求 hostBytes 真驻留 RAM。
  const anonymous = input.loadMode === 'none' || input.loadMode === 'mlock'
  const rounded = Math.round(ratio * 100) / 100
  const base = { sizeBytes, totalMemBytes, freeMemBytes, gpuBytes, hostBytes, ratio: rounded }

  // 硬拦：显存 + 内存都塞不下。这时候不是快慢问题，是必然加载失败。
  if (totalMemBytes > 0 && sizeBytes > totalMemBytes + gpuBytes) {
    return {
      ...base,
      level: 'risky',
      label:
        `模型 ${sizeGib}GB，显存 ${gib(gpuBytes)}GB + 内存 ${gib(totalMemBytes)}GB 都装不下，` +
        '加载必然失败；换个小一号的量化',
    }
  }
  // 匿名模式装不下：会真换页/锁页，这时候确实可能把机器拖死。
  if (anonymous && ratio >= 0.9) {
    return {
      ...base,
      level: 'risky',
      label:
        `用了 load-mode=${input.loadMode}（不走 mmap），显存外的 ${hostGib}GB 要真占内存，` +
        `预算只有 ${gib(budget)}GB，会换页卡死。去掉 load-mode 让它走 mmap`,
    }
  }
  // mmap 装不下：只是首 token 要反复从盘里捞专家，慢，但内存可回收。
  if (ratio >= 0.9) {
    return {
      ...base,
      level: 'warn',
      label:
        `模型 ${sizeGib}GB，显存外的 ${hostGib}GB 超过内存预算 ${gib(budget)}GB。` +
        'mmap 会让它照跑，只是开头一段明显慢（专家要按需从盘里换进来）',
    }
  }
  if (ratio >= 0.5) {
    return {
      ...base,
      level: 'ok',
      label: `模型 ${sizeGib}GB（显存外 ${hostGib}GB），加载时会顿一下，之后正常`,
    }
  }
  return {
    ...base,
    level: 'ok',
    label: `模型 ${sizeGib}GB，显存 ${gib(gpuBytes)}GB 挑大梁，内存够用`,
  }
}

/**
 * 显存总量（MiB → 字节）。拿不到就 0，预检退化成「不算显存」而不是报错。
 *
 * NVIDIA 驱动对 `--query-compute-apps=used_memory` 报 `[N/A]`（实测），
 * 所以只能问 `memory.total`。多卡时取第一张 —— 这台机器只有一张。
 */
export function detectGpuBytes(exec = defaultExecFileSync) {
  try {
    const out = String(
      exec('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 4000 }) ?? '',
    )
    const first = out.split('\n')[0].trim()
    const mib = Number(first)
    return Number.isFinite(mib) && mib > 0 ? mib * 1024 * 1024 : 0
  } catch {
    return 0
  }
}

/**
 * pid 还活着吗。signal 0 只做存在性检查，不真的发信号。
 * Windows 上 EPERM 也算活着（进程存在但不让碰）。
 */
export function isProcessAlive(pid, kill = process.kill) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    kill(value, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 停掉一个进程（连同它的子进程）。
 *
 * 面板只能起不能停这件事本身是缺陷：17GB 的 llama-server 一旦起来，用户唯一的
 * 收场手段是开任务管理器。这里给它配一个对偶操作，并且：
 *  - 只接受「面板自己起的 pid」（由调用方保证，这里只负责杀）；
 *  - 先礼后兵：SIGTERM → 等 waitMs → 还活着就 SIGKILL；
 *  - 全程走注入的 kill / sleep / alive，方便离线单测；
 *  - 不存在的 pid 直接算成功（幂等），不报错。
 *
 * @param {{pid: number, kill?: Function, alive?: Function, waitMs?: number,
 *   sleep?: (ms: number) => Promise<void>}} input
 */
export async function stopProcess(input) {
  const pid = Number(input?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: '没有可停的 pid' }
  const kill = typeof input.kill === 'function' ? input.kill : process.kill
  const alive = typeof input.alive === 'function' ? input.alive : (value) => isProcessAlive(value, kill)
  const sleep = typeof input.sleep === 'function' ? input.sleep : (ms) => new Promise((done) => setTimeout(done, ms))
  const waitMs = Number.isFinite(input.waitMs) ? Number(input.waitMs) : 1500

  if (!alive(pid)) return { ok: true, pid, already: true, signal: 'none', ms: 0 }

  const startedAt = Date.now()
  const send = (signal) => {
    try {
      kill(pid, signal)
      return ''
    } catch (error) {
      if (error?.code === 'ESRCH') return ''
      return String(error?.message ?? error)
    }
  }

  const first = send('SIGTERM')
  if (first.length > 0) return { ok: false, pid, error: 'SIGTERM 失败：' + first }

  const step = 150
  for (let waited = 0; waited < waitMs; waited += step) {
    await sleep(step)
    if (!alive(pid)) return { ok: true, pid, signal: 'SIGTERM', ms: Date.now() - startedAt }
  }
  if (!alive(pid)) return { ok: true, pid, signal: 'SIGTERM', ms: Date.now() - startedAt }

  const second = send('SIGKILL')
  if (second.length > 0) return { ok: false, pid, error: 'SIGKILL 失败：' + second }
  await sleep(step)
  if (alive(pid)) return { ok: false, pid, error: `pid ${pid} 发了 SIGKILL 还在` }
  return { ok: true, pid, signal: 'SIGKILL', ms: Date.now() - startedAt }
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
