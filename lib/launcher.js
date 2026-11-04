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

import { existsSync as fsExistsSync, readdirSync as fsReaddirSync, statSync as fsStatSync, unlinkSync as fsUnlinkSync } from 'node:fs'
import { execFileSync as nodeExecFileSync, spawn as nodeSpawn } from 'node:child_process'
import { homedir as osHomedir } from 'node:os'

const WIN = process.platform === 'win32'
const MAC = process.platform === 'darwin'

/**
 * 家目录 / 数据目录 / 可执行文件名 —— 全部按平台算，不写死 Windows 路径。
 *
 * v0.4.1 之前这里到处都是 `process.env.USERPROFILE ?? 'C:/Users/' + process.env.USERNAME`，
 * 在 Linux/macOS 上两个变量都是 undefined，于是拼出 `C:/Users/.workbuddy/local-models`
 * 这种谁都不认识的路。`os.homedir()` 三个平台都认。
 */
export function homeDir() {
  try {
    const value = osHomedir()
    if (typeof value === 'string' && value.length > 0) return toSlash(value)
  } catch {
    // 掉到下面的兜底
  }
  const raw = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return toSlash(raw.length > 0 ? raw : '.')
}

/** XDG_DATA_HOME（Linux）/ Library/Application Support（macOS）/ LOCALAPPDATA（Windows）。 */
export function dataDir() {
  if (WIN) {
    const local = process.env.LOCALAPPDATA ?? ''
    if (local.length > 0) return toSlash(local)
    return homeDir() + '/AppData/Local'
  }
  if (MAC) return homeDir() + '/Library/Application Support'
  const xdg = process.env.XDG_DATA_HOME ?? ''
  return xdg.length > 0 ? toSlash(xdg) : homeDir() + '/.local/share'
}

/** 反斜杠统一成正斜杠：Node 与 Windows API 都认 `/`，日志里也更好读。 */
export function toSlash(value) {
  return String(value ?? '').split(String.fromCharCode(92)).join('/')
}

/**
 * 拼路径，顺手丢掉空段 —— 避免拼出 `undefined/Programs/...` 这种路。
 *
 * POSIX 绝对路径的开头斜杠必须留住：joinPath("/home/u", "models") 得是
 * /home/u/models，不能变成 home/u/models（那会变成相对路径，落到 cwd 下）。
 * Windows 的盘符（C:/x）不受影响。
 */
export function joinPath(...parts) {
  const keep = parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .map((part) => toSlash(part))
  if (keep.length === 0) return ''
  // 第一段的前导斜杠决定这条路径是不是绝对路径
  const leading = keep[0].startsWith('/') ? '/' : ''
  const body = keep.map((part) => part.replace(/^\/+|\/+$/g, '')).filter((part) => part.length > 0)
  return leading + body.join('/')
}

/** 平台上的可执行文件名：Windows 要 .exe，其它不要。 */
export function exeName(base) {
  return WIN ? base + '.exe' : base
}

/** execFileSync 的默认实现（可被 detectGpuBytes 的调用方覆盖）。 */
const defaultExecFileSync = nodeExecFileSync

/** 端口 → 后端识别。顺序无所谓，按端口查表。 */
export const KNOWN_LAUNCHERS = [
  {
    id: 'ollama',
    label: 'Ollama',
    port: 11434,
    // 候选按「命中概率」排，并且每个平台各有自己的一套 —— 这里原来只写了
    // C:/Users/<USER>/AI/ollama/ollama.exe 这种本机专属路径，换台机器就全靠
    // PATH 上的裸名字兜底。现在三个平台的官方安装位置都列上，最后才是裸名字。
    candidates: () => uniq([
      process.env.OLLAMA_BIN,
      ...(WIN
        ? [
            joinPath(homeDir(), 'AI/ollama/ollama.exe'),
            joinPath(dataDir(), 'Programs/Ollama/ollama.exe'),
            'C:/Program Files/Ollama/ollama.exe',
          ]
        : MAC
          ? ['/Applications/Ollama.app/Contents/Resources/ollama', '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama']
          : ['/usr/local/bin/ollama', '/usr/bin/ollama', '/snap/bin/ollama']),
      'ollama',
    ]),
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
    candidates: (io) => uniq([
      workbuddyBinary(io),
      process.env.LLAMA_SERVER_BIN,
      ...(WIN
        ? [joinPath(homeDir(), 'AI/llama.cpp/llama-server.exe'), joinPath(dataDir(), 'llama.cpp/llama-server.exe')]
        : MAC
          ? ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server']
          : ['/usr/local/bin/llama-server', '/usr/bin/llama-server']),
      exeName('llama-server'),
    ]),
    // llama-server 必须带 -m 模型文件才能起。配置里没写模型时，
    // 去已知的本地模型目录捡现成的 gguf。
    args: null,
    autoArgs: (io) => llamaCppAutoArgs(io),
    // 拼不出自动参数时给用户抄的示例。别用一套 llama.cpp 的写法套所有后端 ——
    // vLLM 认 --model 且不吃 gguf，照抄 -m 模型.gguf 只会报错。
    exampleArgs: (port) => ['-m', '<模型.gguf 的完整路径>', '--host', '127.0.0.1', '--port', String(port)],
    modelNoun: '模型文件',
    env: () => ({}),
  },
  {
    id: 'vllm',
    label: 'vLLM',
    port: 8000,
    candidates: () => uniq([process.env.VLLM_BIN, exeName('vllm'), 'vllm']),
    args: null,
    // vLLM 不做 gguf：它要 HuggingFace 格式的模型目录或仓库 id，参数是 --model。
    exampleArgs: (port) => ['--model', '<模型目录或 HF 仓库 id>', '--port', String(port)],
    modelNoun: '模型（目录或仓库 id）',
    env: () => ({}),
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    port: 1234,
    candidates: () => uniq([
      process.env.LMSTUDIO_BIN,
      ...(WIN
        ? [joinPath(dataDir(), 'LM-Studio/lms.exe'), 'C:/Program Files/LM Studio/resources/app/.webpack/lms.exe']
        : MAC
          ? ['/Applications/LM Studio.app/Contents/Resources/app/.webpack/lms', '/usr/local/bin/lms']
          : ['/usr/local/bin/lms', '/usr/bin/lms']),
      exeName('lms'),
      'lms',
    ]),
    // lms server start 不需要先给模型：模型是运行时按请求加载的。
    // 原来把 lmstudio 归进「必须带模型参数」那一档，面板会提示
    // 「需要模型文件才能起，插件不替你猜」—— 对 LM Studio 是错的。
    args: (port) => ['server', 'start', '--port', String(port || 1234)],
    env: () => ({}),
  },
]

/** 去重同时保序：候选表里同一个路径出现两次会让「找过：」提示重复。 */
function uniq(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (typeof item !== 'string' || item.length === 0) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** 常见模型目录，用来给 ollama 补 OLLAMA_MODELS（不猜磁盘上不存在的路径）。 */
function modelsDirHint() {
  const guesses = WIN
    ? [joinPath(homeDir(), 'AI/models/ollama'), joinPath(dataDir(), 'ollama/models'), joinPath(homeDir(), '.ollama/models')]
    : MAC
      ? [joinPath(homeDir(), '.ollama/models'), '/usr/share/ollama/.ollama/models']
      : [joinPath(homeDir(), '.ollama/models'), '/usr/share/ollama/.ollama/models', '/usr/lib/ollama/models']
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
  // 注入名历史上不统一（exists / existsSync 都有人写），两个都认，
  // 否则调用方传了 exists 却被静默忽略 —— 测试里就踩过这个。
  const exists =
    typeof input.existsSync === 'function'
      ? input.existsSync
      : typeof input.exists === 'function'
        ? input.exists
        : safeExists
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
    // 先问二进制自己认哪些参数，别拿某台机器的结论当普适规则
    const caps = input.caps ?? probeHelpCaps(probe.command, input.exec ?? defaultExecFileSync)
    const auto = typeof known.autoArgs === 'function'
      ? known.autoArgs({
          ...io,
          port,
          alias: input.alias,
          ctx: input.ctx,
          modelPath: input.modelPath,
          caps,
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
        loadMode: auto.loadMode ?? '',
        // 引擎代际要一路透出来：面板/日志靠它解释「为什么这条参数没拼」，
        // 否则用户只看到「少了 --fit」却不知道是自己版本老。
        modernEngine: auto.modernEngine !== false,
        dropped: Array.isArray(auto.dropped) ? auto.dropped : [],
      }
    }
    // 示例按后端各给一套：vLLM 用 --model，llama.cpp 用 -m，写法不能互换。
    const how =
      typeof known.exampleArgs === 'function'
        ? known.exampleArgs(port || known.port)
        : ['<按它自己的文档补参数>']
    return {
      ok: false,
      error:
        `${known.label} 需要${known.modelNoun ?? '模型文件'}才能起，插件不替你猜。已找到 ${probe.command}，` +
        `在高级配置里填一条完整命令即可（例如：${[probe.command, ...how].join(' ')}）`,
      tried: probe.tried,
    }
  }

  const probe = resolveCommand(known, io)
  if (probe.command === null) {
    return { ok: false, error: `没找到 ${known.label} 的可执行文件`, tried: probe.tried }
  }
  // args 既可能是数组（固定参数），也可能是 (port) => string[]（端口要传进去的那种）
  const fixedArgs = typeof known.args === 'function' ? known.args(known.port) : [...known.args]
  return {
    ok: true,
    id: known.id,
    label: known.label,
    port: known.port,
    command: probe.command,
    args: fixedArgs,
    env: known.env(),
    source: 'known',
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
 * 「插件自带的本地模型目录」有没有一个通用位置？
 *
 * 原来这里硬编码 WorkBuddy 的布局（`~/.workbuddy/local-models`）—— 那是这台机器上
 * 恰好放着 35B 的地方，换台机器就一文不值。现在改成：
 *   1. `DSH_LOCAL_MODELS_DIR` 环境变量优先（谁都能指自己放 gguf 的目录）；
 *   2. 否则按平台给一组通用位置（llama.cpp 惯例的 `~/models`、Ollama、LM Studio 等）。
 * WorkBuddy 的路径降级成「候选之一」，不再是唯一来源。
 */
export function modelRoots() {
  const home = homeDir()
  const data = dataDir()
  const roots = []
  const custom = String(process.env.DSH_LOCAL_MODELS_DIR ?? '').trim()
  if (custom.length > 0) roots.push(toSlash(custom))
  roots.push(
    joinPath(home, 'models'),
    joinPath(home, 'llama.cpp/models'),
    joinPath(home, '.cache/llama.cpp'),
    joinPath(home, '.lmstudio/models'),
    joinPath(data, 'LM-Studio/models'),
    // 兼容：本机（以及任何装过 WorkBuddy 的机器）已有的下载目录
    joinPath(home, '.workbuddy/local-models'),
  )
  return roots
}

/** WorkBuddy 布局的兼容入口（老调用方还在用）。找不到就是空目录，不抛。 */
export function workbuddyRoot() {
  return joinPath(homeDir(), '.workbuddy/local-models')
}

/** 在 WorkBuddy 的 build 目录里挑一个 llama-server 可执行文件（不限于 .exe）。 */
function workbuddyBinary(io = {}) {
  const file = exeName('llama-server')
  const base = workbuddyRoot() + '/bin'
  // io 是可选的：调用方不注入就用真实文件系统。原来这里直接 io.listDir(...)，
  // 任何人以 candidates() 无参枚举都会 TypeError 而不是「找不到」。
  const listDir = typeof io.listDir === 'function' ? io.listDir : safeListDir
  const exists = typeof io.exists === 'function' ? io.exists : safeExists
  const builds = listDir(base).filter((name) => exists(base + '/' + name + '/' + file))
  if (builds.length === 0) return null
  builds.sort()
  return base + '/' + builds[builds.length - 1] + '/' + file
}

/**
 * 从 `--help` 的输出里抠出这个二进制到底认哪些参数。
 *
 * 为什么不能靠版本号猜：老版本 llama.cpp 根本没有 `--load-mode` 和 `--fit`，
 * 而 v0.4.0 就是因为把 `--no-mmap` 当普适参数写死，导致点一下「一键拉起」直接
 * `error: invalid argument`。参数支持是能力问题，能力只能问二进制自己 ——
 * 而它恰好会把全部参数列在 `--help` 里（本机 b11012 的输出 59KB，含 `--load-mode`）。
 *
 * 返回的 Set 元素是带前导 `--` 的 flag 名。探不出来（命令不存在 / 超时 / 输出为空）
 * 返回 null —— 调用方据此「不裁剪」，而不是「一律裁掉」。
 */
export function parseHelpFlags(helpText) {
  const flags = new Set()
  const source = String(helpText ?? '')
  // 长参数：--load-mode、--n-gpu-layers
  for (const match of source.matchAll(/(--[a-z0-9][a-z0-9-]*)/gi)) {
    flags.add(match[1].toLowerCase())
  }
  // 短参数：-c、-m、-t。-c 是 --ctx-size 的短写，只认长参数的话会被误判成
  // 「引擎不支持上下文长度」而整条丢掉 —— 实测 b11012 就这么丢过 -c 65536。
  // 用前后边界排除掉命令行示例里的单个短横（`- `、`--`）和负号。
  for (const match of source.matchAll(/(^|[\s,(\[])(-[a-zA-Z])(?=[\s,)\]]|$)/g)) {
    flags.add(match[2])
  }
  return flags.size > 0 ? flags : null
}

const helpCapsCache = new Map()

/** 探测并缓存某个可执行文件支持的参数集合（同一个路径只跑一次 --help）。 */
export function probeHelpCaps(command, exec = defaultExecFileSync) {
  const key = String(command ?? '').trim()
  if (key.length === 0) return null
  if (helpCapsCache.has(key)) return helpCapsCache.get(key)
  let flags = null
  try {
    const help = exec(key, ['--help'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 })
    flags = parseHelpFlags(help)
  } catch (error) {
    // 有些二进制把 --help 打到 stderr 然后非零退出，stdout 拿不到就再试一次
    const stderr = String(error?.stderr ?? '')
    flags = stderr.length > 0 ? parseHelpFlags(stderr) : null
  }
  helpCapsCache.set(key, flags)
  return flags
}

/** 只在「确认支持」或「探不出来」时保留某个参数（探不出来不裁剪，保持旧行为）。 */
function keepFlag(caps, flag) {
  if (caps === null || caps === undefined) return true
  return caps.has(String(flag).toLowerCase())
}

/**
 * 拼 llama-server 的参数。挑模型规则：优先 local_model.gguf，否则按名字排序取第一个；
 * 带 .mmproj. 的是视觉投影，不能当主模型。
 * 参数取一个「多数机器都不出错」的保守组合：q8_0 KV + 单 slot + --fit on + --jinja。
 * 各参数的可用性差异（老版本 llama.cpp 没有 --load-mode / --fit）由 --help 能力探测兜底，
 * 见 capsFor()。
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
    // 没指定 gguf：按 localModelDirs() 的顺序找第一个 —— 原来只认 WorkBuddy 的
    // ~/.workbuddy/local-models/files，换台机器（或用户把模型放 ~/models）就报「没模型」。
    const listDir = io.listDir ? io.listDir : safeListDir
    const dirs = Array.isArray(io.dirs) ? io.dirs : localModelDirs()
    let picked = null
    for (const dir of dirs) {
      const files = listDir(dir).filter((name) => /.gguf$/i.test(name) && !/.mmproj./i.test(name))
      if (files.length === 0) continue
      const name = files.find((item) => /^local_model.gguf$/i.test(item)) ?? files.slice().sort()[0]
      picked = { dir, name }
      break
    }
    if (picked === null) return { ok: false, reason: 'no-model', dirs }
    preferred = picked.name
    model = picked.dir + '/' + picked.name
  }
  const port = Number(io.port) || 8090
  const ctx = Number(io.ctx) || 65536
  const alias = String(io.alias ?? preferred.replace(/.gguf$/i, ''))
  // 加载模式：b11012 用 `--load-mode auto|none|mmap|mlock|mmap+mlock`，
  // 没有 `--no-mmap`（那是老版 llama.cpp 的参数，传进去直接
  // `error: invalid argument: --no-mmap` 起不来）。
  // 默认不传 —— mmap 是 b11012 的 auto 行为，也是 MoE 按需换入专家的前提。
  const loadMode = normalizeLoadMode(io.loadMode ?? (io.noMmap === true ? 'none' : ''))
  // 能力过滤：拿不到 caps 就不裁（保持旧行为）；拿到了就只留它真认的。
  // 必给的三个（-m / --host / --port）任何版本都有，不过滤。
  const caps = io.caps ?? null
  const optional = []
  const dropped = []
  const push = (flag, ...values) => {
    if (keepFlag(caps, flag)) optional.push(flag, ...values)
    else if (!dropped.includes(flag)) dropped.push(flag)
  }
  // 引擎代际：`--fit` 是较新的开关（自带自动分层）。没有它的老版本既不肯收
  // `--n-gpu-layers auto`（只认数字），KV 量化的类型表也窄，所以按「有没有 --fit」
  // 分成两套组合，而不是把新参数硬塞给老二进制。caps 探不出来（null）时按新引擎走
  // —— 宁可参数多、由引擎自己报错，也别因为探测失败把能用的裁掉。
  const modernEngine = caps === null || caps.has('--fit')
  push('--alias', alias)
  push('--n-gpu-layers', modernEngine ? 'auto' : '99')
  push('--fit', 'on')
  push('--parallel', '1')
  push('--jinja')
  if (modernEngine) {
    push('--cache-type-k', 'q8_0')
    push('--cache-type-v', 'q8_0')
  }
  if (loadMode.length > 0) push('--load-mode', loadMode)
  push('-c', String(ctx))
  push('--n-predict', '8192')

  return {
    ok: true,
    model,
    port,
    args: ['-m', model, '--host', '127.0.0.1', '--port', String(port), ...optional],
    loadMode: loadMode.length > 0 && keepFlag(caps, '--load-mode') ? loadMode : '',
    modernEngine,
    dropped,
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
 * 目录来源全部走 `modelRoots()`（按平台算 + 认 `DSH_LOCAL_MODELS_DIR`），
 * 不再写死某台机器的 `C:/Users/<USER>/...`；`Downloads` 三平台都有，语义一致。
 * 每层只扫 depth 层，避免把整个磁盘翻一遍。
 */
export function localModelDirs() {
  const home = homeDir()
  const roots = modelRoots().map((dir) => joinPath(dir, 'files'))
  // llama.cpp 惯例：weights 直接摊在 ~/models 下，不再套 files/ 一层
  const flat = modelRoots().filter((dir) => !/\.workbuddy[\\/]local-models$/.test(dir))
  return [
    ...roots,
    joinPath(workbuddyRoot(), 'files'),
    joinPath(home, 'AI/models'),
    ...flat,
    joinPath(dataDir(), 'LM-Studio/models'),
    joinPath(home, 'Downloads'),
  ].filter((dir, index, all) => typeof dir === 'string' && dir.length > 0 && all.indexOf(dir) === index)
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
  const exists =
    typeof io.exists === 'function' ? io.exists : typeof io.existsSync === 'function' ? io.existsSync : safeExists
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

/**
 * 删掉一个本机模型文件。
 *
 * 这是唯一一个真的会动用户磁盘的操作，所以规矩定得死：
 *  1. 只认 .gguf（包括 .mmproj.gguf）—— 别的一律不动，误点到目录也不会递归删；
 *  2. 必须落在扫描目录里 —— 传个 ../ 或者绝对路径指到系统文件，直接拒；
 *  3. 不存在就如实说「已经不在了」，不当成功；
 *  4. 删失败（权限、被占用、只读盘）把系统错误原样带回来，不吞成 false。
 *
 * 用 unlink 而不是 rm -rf：模型是一个文件，删文件出错的代价远小于删目录。
 */
export function deleteLocalModel(io = {}) {
  const exists =
    typeof io.exists === 'function' ? io.exists : typeof io.existsSync === 'function' ? io.existsSync : safeExists
  const statSize = typeof io.statSize === 'function' ? io.statSize : safeSize
  const unlink = typeof io.unlink === 'function' ? io.unlink : fsUnlinkSync
  const dirs = Array.isArray(io.dirs) ? io.dirs : localModelDirs()

  const target = toSlash(String(io.path ?? '').trim())
  if (target.length === 0) return { ok: false, error: '要说清删哪个文件' }
  if (!/\.gguf$/i.test(target)) {
    return { ok: false, path: target, error: '只肯删 .gguf 文件（目录不会被递归删除）' }
  }

  const roots = dirs
    .filter((dir) => typeof dir === 'string')
    .map((dir) => toSlash(dir).replace(/\/+$/, ''))
    .filter((dir) => dir.length > 0)
  const inside = roots.some((dir) => target === dir || target.startsWith(dir + '/'))
  if (!inside) {
    return {
      ok: false,
      path: target,
      error: '这个文件不在模型的扫描目录里，拒绝删除',
      dirs: roots,
    }
  }

  if (!exists(target)) return { ok: false, path: target, error: '文件已经不在了（可能刚被删过）' }

  const sizeBytes = statSize(target)
  try {
    unlink(target)
  } catch (error) {
    return {
      ok: false,
      path: target,
      sizeBytes,
      error: '删除失败：' + String(error?.message ?? error),
    }
  }

  const parts = target.split('/')
  return {
    ok: true,
    path: target,
    name: parts[parts.length - 1] ?? target,
    sizeBytes,
    freedBytes: sizeBytes,
  }
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
  let quoteChar = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    // POSIX 上单引号也是引号（`'/opt/my models/llama-server' -m x`），
    // Windows 的 cmd 不认单引号，那边就当普通字符。
    const isQuote = char === '"' || (!WIN && char === "'")
    if (isQuote) {
      if (quoted && char === quoteChar) {
        quoted = false
        quoteChar = ''
      } else if (!quoted) {
        quoted = true
        quoteChar = char
      } else {
        current += char
      }
      continue
    }
    // POSIX 的转义：反斜杠让下一个字符原样进来。Windows 的反斜杠是路径分隔符，不动。
    if (!WIN && char === String.fromCharCode(92) && index + 1 < text.length && quoted !== true) {
      index += 1
      current += text[index]
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
  // 统一内存（Apple Silicon / 部分核显）：显存与内存是同一个池子，
  // 拿 sizeBytes - gpuBytes 会双重扣除，把「32GB 的 Mac 装 20GB 模型」算成很宽松。
  // 这种情况下整份模型都落在同一个池里，直接按 sizeBytes 比内存。
  const unified = input.unified === true
  // 给系统留 2048MiB：Windows 自己、宿主、浏览器都要吃内存。
  // reserveBytes 显式给 0 表示「不预留」（配置项 reserveMb: 0），不能当成没填 ——
  // 否则用户把预留调小时反而被悄悄改回 2GB。
  const reserveInput = Number(input.reserveBytes)
  const reserveBytes =
    Number.isFinite(reserveInput) && reserveInput >= 0 ? reserveInput : 2048 * 1024 * 1024
  const gib = (bytes) => Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10
  const sizeGib = gib(sizeBytes)

  // 显存装得下的部分不占系统内存。装不下的那部分才是宿主要接的量。
  const hostBytes = unified ? sizeBytes : Math.max(sizeBytes - gpuBytes, 0)
  const hostGib = gib(hostBytes)
  const budget = Math.max(totalMemBytes - reserveBytes, freeMemBytes, 0)
  const ratio = budget > 0 ? hostBytes / budget : 0
  // 匿名内存模式：不走 mmap，就等于要求 hostBytes 真驻留 RAM。
  const anonymous = input.loadMode === 'none' || input.loadMode === 'mlock'
  const rounded = Math.round(ratio * 100) / 100
  const base = { sizeBytes, totalMemBytes, freeMemBytes, gpuBytes, unified, hostBytes, ratio: rounded }
  // 统一内存时 totalMemBytes 已经是那一整个池子，再加 gpuBytes 会重复计数。
  const ceiling = unified ? totalMemBytes : totalMemBytes + gpuBytes

  // 硬拦：显存 + 内存都塞不下。这时候不是快慢问题，是必然加载失败。
  if (totalMemBytes > 0 && sizeBytes > ceiling) {
    return {
      ...base,
      level: 'risky',
      label:
        `模型 ${sizeGib}GB，${unified ? '统一内存' : '显存 ' + gib(gpuBytes) + 'GB + 内存'} ` +
        `${gib(totalMemBytes)}GB 都装不下，加载必然失败；换个小一号的量化`,
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
      label: unified
        ? `模型 ${sizeGib}GB 落在统一内存 ${gib(totalMemBytes)}GB 里，加载时会顿一下，之后正常`
        : `模型 ${sizeGib}GB（显存外 ${hostGib}GB），加载时会顿一下，之后正常`,
    }
  }
  return {
    ...base,
    level: 'ok',
    label: unified
      ? `模型 ${sizeGib}GB，统一内存 ${gib(totalMemBytes)}GB 够用`
      : `模型 ${sizeGib}GB，显存 ${gib(gpuBytes)}GB 挑大梁，内存够用`,
  }
}

/**
 * 显存总量 / 厂商。拿不到就 0，预检退化成「不算显存」而不是报错。
 *
 * 三个平台 + 三类厂商都试一遍，谁先答上来算谁：
 *   - NVIDIA：`nvidia-smi --query-gpu=memory.total`（Linux / macOS / Windows 通用，
 *     Windows 上它在 system32，靠 PATH 就能找到）
 *   - AMD：`rocm-smi --showmeminfo vram`，输出 `VRAM Total Memory (B): 17163091968`
 *   - Apple Silicon：统一内存，没有独立 VRAM —— 整个 RAM 都能给 GPU 用，
 *     所以拿 `sysctl -n hw.memsize` 的四分之一当「GPU 侧可用」的粗估，
 *     并标记 `unified: true`，让调用方知道这不是真 VRAM
 *   - Intel 核显 / 无独显：返回 0（不猜）
 *
 * `detectGpuInfo()` 返回 `{ bytes, vendor, unified }`；`detectGpuBytes()` 只返回字节数
 * （老调用方兼容）。
 */
export function detectGpuInfo(exec = defaultExecFileSync, platform = process.platform) {
  const run = (command, args) => {
    try {
      return String(exec(command, args, { timeout: 4000 }) ?? '')
    } catch {
      return ''
    }
  }
  const lines = (text) =>
    String(text)
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

  // 1) NVIDIA
  for (const line of lines(run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']))) {
    const mib = Number(line)
    if (Number.isFinite(mib) && mib > 0) {
      return { bytes: Math.round(mib * 1024 * 1024), vendor: 'nvidia', unified: false }
    }
  }

  // 2) AMD ROCm。带单位的先试 —— 否则 "VRAM Total Memory (B): 24.0 GiB"
  // 会被纯数字那条抢先匹配成 24 字节。
  const rocm = run('rocm-smi', ['--showmeminfo', 'vram'])
  const rocmUnits = rocm.match(/VRAM Total Memory \(B(?:ytes)?\):\s*([\d.]+)\s*(GiB|MiB|GB|MB)/i)
  if (rocmUnits) {
    const value = Number(rocmUnits[1])
    const unit = rocmUnits[2].toLowerCase()
    const scale = unit === 'gib' ? 1024 ** 3 : unit === 'mib' ? 1024 ** 2 : unit === 'gb' ? 1000 ** 3 : 1000 ** 2
    if (Number.isFinite(value) && value > 0) {
      return { bytes: Math.round(value * scale), vendor: 'amd', unified: false }
    }
  }
  const rocmBytes = rocm.match(/VRAM Total Memory \(B\):\s*(\d+)\s*$/m)
  if (rocmBytes) {
    const bytes = Number(rocmBytes[1])
    if (Number.isFinite(bytes) && bytes > 0) return { bytes, vendor: 'amd', unified: false }
  }

  // 3) Apple Silicon：统一内存，取四分之一作为 GPU 侧粗估
  if (platform === 'darwin') {
    const total = Number(lines(run('sysctl', ['-n', 'hw.memsize']))[0])
    if (Number.isFinite(total) && total > 0) {
      return { bytes: Math.round(total / 4), vendor: 'apple', unified: true }
    }
  }

  return { bytes: 0, vendor: 'none', unified: false }
}

/** 只要字节数（0 = 没检测到独显 / 检测失败）。 */
export function detectGpuBytes(exec = defaultExecFileSync, platform = process.platform) {
  return detectGpuInfo(exec, platform).bytes
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
