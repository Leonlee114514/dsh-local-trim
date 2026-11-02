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

import { existsSync as fsExistsSync } from 'node:fs'
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
    candidates: () => [
      process.env.LLAMA_SERVER_BIN,
      'C:/Users/' + (process.env.USERNAME ?? '') + '/AI/llama.cpp/llama-server.exe',
      'llama-server',
      'llama-server.exe',
    ].filter((item) => typeof item === 'string' && item.length > 0),
    // llama-server 必须带 -m 模型文件才能起，没有模型时不能瞎猜
    args: null,
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
  const known = launcherForPort(port)
  if (known === null) {
    return {
      ok: false,
      error: `不知道 ${port || '这个'} 端口该起什么后端；在高级配置里填一条启动命令就行`,
      tried: [],
    }
  }
  if (known.args === null) {
    return {
      ok: false,
      error: `${known.label} 需要模型参数才能起，插件不替你猜；在高级配置里填完整的启动命令`,
      tried: [],
    }
  }

  const candidates = known.candidates()
  const tried = []
  for (const candidate of candidates) {
    tried.push(candidate)
    // 裸名字（不含路径分隔符）交给系统 PATH 解析，自己也检查一下
    const looksBare = !candidate.includes('/') && !candidate.includes('\\')
    if (looksBare) {
      const resolved = whichOnPath(candidate, exists)
      if (resolved !== null) {
        return {
          ok: true,
          id: known.id,
          label: known.label,
          port: known.port,
          command: resolved,
          args: [...known.args],
          env: known.env(),
          source: 'known',
        }
      }
      continue
    }
    if (exists(candidate)) {
      return {
        ok: true,
        id: known.id,
        label: known.label,
        port: known.port,
        command: candidate,
        args: [...known.args],
        env: known.env(),
        source: 'known',
      }
    }
  }
  return { ok: false, error: `没找到 ${known.label} 的可执行文件`, tried }
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
