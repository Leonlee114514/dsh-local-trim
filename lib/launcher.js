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

import {
  closeSync as fsCloseSync,
  existsSync as fsExistsSync,
  openSync as fsOpenSync,
  readSync as fsReadSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  statSync as fsStatSync,
} from 'node:fs'
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

/** GGUF 的文件头魔数（前 4 字节就是这四个 ASCII 字符）。 */
const GGUF_MAGIC = 'GGUF'

/**
 * Ollama manifest 里指向权重那一层的 mediaType。
 * adapter / mmproj / projector 是视觉投影，不能当主模型。
 */
const OLLAMA_MODEL_LAYER = /application\/vnd\.ollama\.image\.model/i
const OLLAMA_ADAPTER_LAYER = /(adapter|mmproj|projector)/i

/**
 * 读文件前 4 字节当魔数。
 *
 * 为什么必须读内容而不能只看扩展名：**Ollama 存的 blob 根本没有扩展名** ——
 * 磁盘上是 `blobs/sha256-a3de86cd…`，里面是一个完整的 GGUF。只认 `.gguf` 的
 * 扫描器永远看不见用户 `ollama pull` 下来的那几个模型（这就是 v0.4.4 只列出
 * 一个模型的原因）。反过来 HF 的 `*.bin`、安装器、iso 也都很大，所以必须真读
 * 魔数才不会把它们当模型列出来。
 *
 * 只读 4 字节，用完立刻 close。任何异常都回空串（= 判为不是模型），不让扫描炸掉。
 */
export function readGgufMagic(path, io = {}) {
  if (typeof io.readHead === 'function') {
    try {
      return String(io.readHead(path) ?? '').slice(0, 4)
    } catch {
      return ''
    }
  }
  let fd = null
  try {
    fd = fsOpenSync(path, 'r')
    const buffer = Buffer.alloc(4)
    const got = fsReadSync(fd, buffer, 0, 4, 0)
    return got > 0 ? buffer.toString('latin1', 0, got) : ''
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        fsCloseSync(fd)
      } catch {
        /* 关不掉也不影响判定结果 */
      }
    }
  }
}

/**
 * 读 GGUF 文件自己的 KV 元数据（v0.4.6 的核心）。
 *
 * 为什么不能「读头部一大块再解析」：llama.cpp 把 `general.file_type` 写在
 * **所有 tokenizer 键之后**，而 `tokenizer.ggml.tokens` 是十几万条字符串、
 * `tokenizer.chat_template` 几百 KB —— 固定大小的头窗口必然停在它们前面，
 * 于是量化永远读不到（本机实测：256KB / 1MB 窗口都只拿到前 33 个键）。
 *
 * 所以这里按 KV 布局逐条走位，遇到大数组 / 长字符串**只移动指针不复制载荷**：
 * 读才是成本，seek 是免费的。字符串数组是**交错存储**（8 字节长度 + 载荷，循环），
 * 不是一张长度表 —— 按长度表算会把载荷的首字节当成下一条的长度，
 * 本机那层 248320 条 token 就被算出过 `2.7e22` 这种天文数字。
 *
 * 成本闸：单文件最多读 `maxMetaBytes`（默认 24MB）。读满就带着已拿到的键返回 ——
 * `general.name` 这些排在 tokens 之前，所以最坏情况只是不标量化，不会连名字都没有。
 * 任何异常都回空对象（= 不补元数据），绝不让扫描炸掉。
 *
 * io 可注入：`readMeta`（直接给整个 kv，测试最省事）、`readRange(path,pos,n)` +
 * `fileSize(path)`（内存里的假文件）、否则走真实 fs。
 */
const GGUF_ELEM_SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
const GGUF_META_CHUNK = 256 * 1024

export function readGgufMeta(path, io = {}) {
  if (typeof io.readMeta === 'function') {
    try {
      return io.readMeta(path) ?? {}
    } catch {
      return {}
    }
  }
  const maxReadBytes = Number(io.maxMetaBytes) > 0 ? Number(io.maxMetaBytes) : 24 * 1024 * 1024
  const maxSkipBytes = Number(io.maxMetaSkip) > 0 ? Number(io.maxMetaSkip) : 2 * 1024 * 1024 * 1024
  const maxKvs = Number(io.maxMetaKvs) > 0 ? Number(io.maxMetaKvs) : 4096

  const virtual = typeof io.readRange === 'function'
  let fd = null
  let fileSize = 0
  if (virtual) {
    fileSize = Number(typeof io.fileSize === 'function' ? io.fileSize(path) : Number.MAX_SAFE_INTEGER) || 0
  } else {
    try {
      fd = fsOpenSync(path, 'r')
      fileSize = fsStatSync(path).size
    } catch {
      if (fd !== null) try { fsCloseSync(fd) } catch { /* 已经废了 */ }
      return {}
    }
  }
  const readAt = (pos, n) => {
    if (n <= 0) return Buffer.alloc(0)
    if (virtual) {
      try {
        const buf = io.readRange(path, pos, n)
        if (buf === null || buf === undefined) return null
        const out = Buffer.from(buf)
        // 短读 = 文件被截断/游标已经错了：宁可停在这里，也别把半截字节当值用
        return out.length === n ? out : null
      } catch {
        return null
      }
    }
    const buf = Buffer.alloc(n)
    try {
      return fsReadSync(fd, buf, 0, n, pos) === n ? buf : null
    } catch {
      return null
    }
  }

  const kv = {}
  const bail = () => kv // 半途而废也算成功：前面拿到的键照样有用
  try {
    let pos = 0
    let bytesRead = 0
    let bytesSkipped = 0
    const cost = (n) => {
      bytesRead += n
      return bytesRead <= maxReadBytes
    }
    // seek 不花钱，但必须还在文件里 —— 越界就是游标已经错了，立刻停
    const skip = (n) => {
      bytesSkipped += n
      if (bytesSkipped > maxSkipBytes) return false
      if (fileSize > 0 && pos + n > fileSize) return false
      pos += n
      return true
    }
    const u64 = (buf, off) => {
      const value = Number(buf.readBigUInt64LE(off))
      return Number.isSafeInteger(value) ? value : null
    }

    const head = readAt(0, 24)
    pos = 24
    bytesRead = 24
    if (head === null || head.toString('latin1', 0, 4) !== GGUF_MAGIC) return {}
    if (head.readUInt32LE(4) < 2) return {} // v1 用 u32 长度，这里不支持（也基本见不到）
    const nKv = u64(head, 16)
    if (nKv === null || nKv < 0 || nKv > maxKvs) return {}

    const readKey = () => {
      const lb = readAt(pos, 8)
      if (lb === null || !cost(8)) return null
      const len = u64(lb, 0)
      if (len === null || len < 0 || len > 2048) return null
      const raw = readAt(pos + 8, len)
      if (raw === null || !cost(len)) return null
      pos += 8 + len
      return raw.toString('utf8')
    }
    const readStringValue = () => {
      const lb = readAt(pos, 8)
      if (lb === null || !cost(8)) return null
      const len = u64(lb, 0)
      if (len === null || len < 0) return null
      pos += 8
      if (len > 256 * 1024) return skip(len) ? undefined : null // chat_template 这种：只走位
      const raw = readAt(pos, len)
      if (raw === null || !cost(len)) return null
      pos += len
      return raw.toString('utf8')
    }
    // 交错存储的字符串数组：块内走位，跨块续读；不复制 token 文本
    const skipStringArray = (count) => {
      let remaining = count
      while (remaining > 0) {
        const chunk = readAt(pos, GGUF_META_CHUNK)
        if (chunk === null) {
          const lb = readAt(pos, 8)
          if (lb === null || !cost(8)) return false
          const len = u64(lb, 0)
          if (len === null || len < 0) return false
          pos += 8
          if (!skip(len)) return false
          remaining -= 1
          continue
        }
        if (!cost(chunk.length)) return false
        let off = 0
        let done = 0
        while (done < remaining && off + 8 <= chunk.length) {
          const len = u64(chunk, off)
          if (len === null || len < 0) return false
          if (done === 0 && off + 8 + len > chunk.length) {
            // 第一条就跨块：前缀已在手里，载荷直接 seek
            pos += 8
            if (!skip(len)) return false
            done = 1
            continue
          }
          if (off + 8 + len > chunk.length) break
          off += 8 + len
          done += 1
        }
        if (done === 0) return false
        pos += off
        remaining -= done
      }
      return true
    }
    const readArrayValue = () => {
      const eb = readAt(pos, 12)
      if (eb === null || !cost(12)) return null
      const elemType = eb.readUInt32LE(0)
      const count = u64(eb, 4)
      pos += 12
      if (count === null || count < 0) return null
      if (elemType === 8) return skipStringArray(count) ? undefined : null
      const elemSize = GGUF_ELEM_SIZE[elemType]
      if (elemSize === undefined) return null // 嵌套数组之类：不认就停，保住已有的键
      if (count > 64) return skip(count * elemSize) ? undefined : null
      const block = readAt(pos, count * elemSize)
      if (block === null || !cost(count * elemSize)) return null
      pos += count * elemSize
      const out = []
      for (let i = 0; i < count; i++) {
        const at = i * elemSize
        out.push(elemType === 4 ? block.readUInt32LE(at) : elemType === 5 ? block.readInt32LE(at)
          : elemType === 6 ? block.readFloatLE(at) : elemType === 2 ? block.readUInt16LE(at)
          : elemType === 3 ? block.readInt16LE(at) : elemType === 10 ? Number(block.readBigUInt64LE(at))
          : elemType === 11 ? Number(block.readBigInt64LE(at)) : elemType === 12 ? block.readDoubleLE(at)
          : elemType === 1 ? block.readInt8(at) : elemType === 7 ? block.readUInt8(at) !== 0 : block.readUInt8(at))
      }
      return out
    }
    const readScalar = (type) => {
      const size = GGUF_ELEM_SIZE[type]
      if (size === undefined) return null
      const raw = readAt(pos, size)
      if (raw === null || !cost(size)) return null
      pos += size
      return type === 0 ? raw.readUInt8(0) : type === 1 ? raw.readInt8(0)
        : type === 2 ? raw.readUInt16LE(0) : type === 3 ? raw.readInt16LE(0)
        : type === 4 ? raw.readUInt32LE(0) : type === 5 ? raw.readInt32LE(0)
        : type === 6 ? raw.readFloatLE(0) : type === 7 ? raw.readUInt8(0) !== 0
        : type === 10 ? Number(raw.readBigUInt64LE(0)) : type === 11 ? Number(raw.readBigInt64LE(0))
        : raw.readDoubleLE(0)
    }

    for (let i = 0; i < nKv; i++) {
      const key = readKey()
      if (typeof key !== 'string') return bail()
      const tb = readAt(pos, 4)
      if (tb === null || !cost(4)) return bail()
      const type = tb.readUInt32LE(0)
      pos += 4
      let value
      if (type === 8) value = readStringValue()
      else if (type === 9) value = readArrayValue()
      else value = readScalar(type)
      if (value === null) return bail()
      if (value !== undefined) kv[key] = value
    }
    return kv
  } catch {
    return kv
  } finally {
    if (fd !== null) {
      try {
        fsCloseSync(fd)
      } catch {
        /* 关掉就行 */
      }
    }
  }
}

/**
 * 把 GGUF 元数据折进扫描条目：可读名、量化、上下文上限，以及
 * **`general.type === 'mmproj'` 也算视觉投影** —— 投影被改名成 `local_model.gguf`
 * 时，只靠文件名里的 `.mmproj.` 会漏，让人当主模型选（llama-server 起得来但答不了）。
 */
export function decorateWithGgufMeta(entry, meta = {}) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  const architecture = text(meta['general.architecture'])
  const fullName = text(meta['general.name'])
  const basename = text(meta['general.basename'])
  const sizeLabel = text(meta['general.size_label'])
  const fileType = Number(meta['general.file_type'])
  const contextLength = Number(
    meta[(architecture.length > 0 ? architecture : 'general') + '.context_length'] ?? meta['context_length'],
  )
  const patch = {}
  if (fullName.length > 0) patch.modelName = fullName
  if (architecture.length > 0) patch.architecture = architecture
  if (sizeLabel.length > 0) patch.sizeLabel = sizeLabel
  if (contextLength > 0) patch.contextLength = contextLength
  if (Number.isFinite(fileType) && FILE_TYPE_LABELS[fileType] !== undefined) patch.quantization = FILE_TYPE_LABELS[fileType]
  if (text(meta['general.license']).length > 0) patch.license = text(meta['general.license'])
  // 紧凑显示名：basename + size_label（`Qwen36_35B A3B`），比整串 general.name 好认
  const compact =
    basename.length > 0 && sizeLabel.length > 0
      ? basename.includes(sizeLabel)
        ? basename
        : basename + ' ' + sizeLabel
      : basename.length > 0
        ? basename
        : fullName
  if (compact.length > 0) patch.readableName = compact
  if (patch.readableName === undefined && fullName.length > 0) patch.readableName = fullName
  if (fullName.length > 0) patch.fullName = fullName
  if (text(meta['general.type']) === 'mmproj') patch.mmproj = true
  Object.assign(entry, patch)
  return entry
}

/**
 * 文件是不是 GGUF：扩展名命中，或者魔数命中（后者覆盖无后缀的 blob）。
 * 明确不是权重的后缀直接排除，省掉开文件的开销。
 */
function looksLikeGguf(name, magic) {
  if (/\.gguf$/i.test(name)) return true
  if (/\.(bin|safetensors|json|md|txt|zip|ggml|log|py|sh|ya?ml|lock|part|tmp|exe|msi|dmg|deb|iso|7z|rar)$/i.test(name)) {
    return false
  }
  return magic === GGUF_MAGIC
}

/** 从所在目录猜来源，面板上要显示「Ollama / LM Studio / WorkBuddy / 下载目录」。 */
function originOf(dir) {
  const text = String(dir ?? '').toLowerCase()
  if (/ollama/.test(text)) return 'ollama'
  if (/lm[-_.]?studio/.test(text)) return 'lmstudio'
  if (/workbuddy/.test(text)) return 'workbuddy'
  if (/huggingface|\.cache[\\/]hub/.test(text)) return 'huggingface'
  if (/download|下載/.test(text)) return 'downloads'
  return 'local'
}

/** 文件的身份（同 dev + 同 ino = 同一个文件，硬链接算重复）。拿不到回 null → 不去重。 */
function fileId(path, io) {
  if (typeof io.statId === 'function') {
    try {
      const id = io.statId(path)
      if (id != null && id.dev !== undefined && id.ino !== undefined) return id.dev + ':' + id.ino
    } catch {
      /* 注入实现没给就按路径去重 */
    }
    return null
  }
  try {
    const st = fsStatSync(path)
    if (st.ino === undefined || st.dev === undefined) return null
    return st.dev + ':' + st.ino
  } catch {
    return null
  }
}

/**
 * Ollama 模型库根目录候选。
 *
 * 顺序：`OLLAMA_MODELS`（官方认这个，把模型放在自定义盘的人全靠它）→ 各平台默认位置。
 * 默认位置和 `modelsDirHint()` 用同一套 guess，不在这里另发明一份。
 */
export function ollamaModelRoots(io = {}) {
  const exists =
    typeof io.exists === 'function' ? io.exists : typeof io.existsSync === 'function' ? io.existsSync : safeExists
  const listDir = typeof io.listDir === 'function' ? io.listDir : safeListDir
  const env = typeof io.env === 'object' && io.env !== null ? io.env : process.env
  const home = homeDir()
  const fromEnv = String(env?.OLLAMA_MODELS ?? '').trim()
  const guesses = [
    ...(fromEnv.length > 0 ? [toSlash(fromEnv)] : []),
    ...(WIN
      ? [joinPath(home, 'AI/models/ollama'), joinPath(dataDir(), 'ollama/models'), joinPath(home, '.ollama/models')]
      : MAC
        ? [joinPath(home, '.ollama/models'), '/usr/share/ollama/.ollama/models']
        : [
            joinPath(home, '.ollama/models'),
            '/usr/share/ollama/.ollama/models',
            '/usr/lib/ollama/models',
            '/opt/ollama/models',
          ]),
  ]
  const out = []
  for (const guess of guesses) {
    if (typeof guess !== 'string' || guess.length === 0) continue
    if (out.includes(guess)) continue
    // 「目录存在」还不够：真的长得像 ollama 存储才算，否则把 ~/ollama 这种普通目录当库
    if (!exists(guess)) continue
    const looksLikeStore =
      exists(joinPath(guess, 'manifests')) ||
      exists(joinPath(guess, 'manifests-v2')) ||
      exists(joinPath(guess, 'blobs')) ||
      listDir(guess).some((name) => /^(manifests|manifests-v2|blobs)$/i.test(name))
    if (looksLikeStore) out.push(guess)
  }
  return out
}

/**
 * 从 Ollama 的存储里还原「这些 blob 叫什么名字」。
 *
 * blob 的文件名是摘要不是名字；名字在 `manifests/<host>/<ns>/<name>/<tag>` 这条
 * **路径**里（文件内容只有一堆 digest）。所以这里做的是：走 manifests 树 →
 * 从路径拼出 `name:tag` → 读 JSON 找 `image.model` 那一层的 digest → 指回
 * `blobs/sha256-<digest>`。一个 blob 被多个 tag 引用时合并成一条。
 * 再读 `metadata/sha256-<digest>.json` 的 GGUF kv 当可读名/量化/上下文。
 */
export function scanOllamaModels(io = {}) {
  const exists =
    typeof io.exists === 'function' ? io.exists : typeof io.existsSync === 'function' ? io.existsSync : safeExists
  const listDir = typeof io.listDir === 'function' ? io.listDir : safeListDir
  const statSize = typeof io.statSize === 'function' ? io.statSize : safeSize
  const readText = typeof io.readText === 'function' ? io.readText : safeReadText
  const roots = Array.isArray(io.roots) ? io.roots : ollamaModelRoots(io)
  const maxEntries = Number(io.maxEntries) > 0 ? Number(io.maxEntries) : 4_000

  const byBlob = new Map()
  let entries = 0
  let truncated = false
  let currentRoot = ''

  const push = (hex, tag, declaredSize) => {
    if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) return
    const path = joinPath(currentRoot, 'blobs', 'sha256-' + hex)
    let item = byBlob.get(path)
    if (item === undefined) {
      item = { path, tags: [], declaredSize: 0, root: currentRoot }
      byBlob.set(path, item)
    }
    if (typeof tag === 'string' && tag.length > 0 && !item.tags.includes(tag)) item.tags.push(tag)
    if (declaredSize > 0 && item.declaredSize === 0) item.declaredSize = declaredSize
  }

  /** 读一个候选 manifest。返回 true 表示它确实是 manifest（当文件处理掉）。 */
  const readManifest = (file, tag) => {
    // 先卡体积：manifest 是一两 KB 的 JSON。真目录 stat 会失败 → 0 → 去读也是空，
    // 不花代价；万一树里出现大文件也不至于整份读进内存。
    if (statSize(file) > 2_000_000) return false
    const text = readText(file)
    if (typeof text !== 'string' || text.length === 0) return false
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return false
    }
    const layers = Array.isArray(parsed?.layers) ? parsed.layers : []
    if (layers.length === 0) return false
    for (const layer of layers) {
      const media = String(layer?.mediaType ?? '')
      const digest = String(layer?.digest ?? '')
      if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) continue
      // 权重层才收；adapter/mmproj 这些投影层不是主模型，别的 mediaType
      // （license/template/params/config）也不是模型，直接跳过
      if (OLLAMA_MODEL_LAYER.test(media) && !OLLAMA_ADAPTER_LAYER.test(media)) {
        push(digest.slice(7), tag, Number(layer?.size) || 0)
      }
    }
    return true
  }

  /**
   * 走 manifests 目录树。
   *
   * 注意这里**不能**用 `exists(path + '/')` 判目录：Windows 上它对文件也返回 true
   * （尾斜杠被路径解析吃掉），那样每个 manifest 都会被当成目录递归下去、一个都读不到。
   * 所以按内容分岔：能 parse 出 layers 的就是 manifest，否则当目录继续下钻。
   */
  const walkManifest = (dir, prefix, level) => {
    if (truncated || level > 8) return
    for (const name of listDir(dir)) {
      entries += 1
      if (entries > maxEntries) {
        truncated = true
        return
      }
      const full = dir + '/' + name
      const rel = prefix.length > 0 ? prefix + '/' + name : name
      // 路径 <host>/<ns>/<name>/<tag>：名字是最后两级，tag 常常就是 latest
      const parts = rel.split('/')
      const tag = parts[parts.length - 1]
      const model = parts[parts.length - 2] ?? ''
      if (model.length > 0 && readManifest(full, tag === 'latest' ? model : model + ':' + tag)) continue
      walkManifest(full, rel, level + 1)
    }
  }

  for (const root of roots) {
    currentRoot = root
    for (const manifestDirName of ['manifests', 'manifests-v2']) {
      const dir = joinPath(root, manifestDirName)
      // 不用 `exists(dir + '/')` 判目录：那个写法在 Windows 上对文件也返回 true，
      // 而且这里本来就先 listDir —— 不是目录就是空数组，循环自然不进。
      if (!exists(dir)) continue
      walkManifest(dir, '', 0)
    }
  }

  const out = []
  for (const item of byBlob.values()) {
    if (item.tags.length === 0) continue
    if (!exists(item.path)) continue
    const meta = readOllamaMetadata(item, { readText })
    out.push({
      path: item.path,
      name: displayNameOf(item, meta),
      dir: joinPath(item.root, 'blobs'),
      sizeBytes: statSize(item.path) || item.declaredSize,
      mmproj: false,
      source: 'ollama',
      origin: 'ollama',
      tags: item.tags.slice(),
      readableName: displayNameOf(item, meta),
      // ollama 的模型由 `ollama serve` 自己按 tag 加载，不该再拿 blob 路径去起 llama-server
      engine: 'ollama',
      port: 11434,
      ...meta,
    })
  }
  out.truncated = truncated
  out.scannedEntries = entries
  return out
}

/**
 * GGUF `general.file_type` 的枚举值 → 量化名。
 * 对应关系照 llama.cpp 的 `ggmlFileType` 表；只列常见的，不认识的编号不显示，不瞎猜。
 */
/**
 * GGUF `general.file_type` 的数字 → 量化名。
 *
 * 这个数字就是 llama.cpp 的 **`ggml_type` 枚举原值**（不是另一套「文件类型」编号）：
 * 4/5 是早年被移除的 Q4_2/Q4_3，所以中间留空；19 之后是 IQ 系列。
 * 本机实测校准过：qwen3:8b / qwen3:14b 的 `general.file_type` = 15，
 * `ollama show` 报的 quantization = Q4_K_M —— 对不上就说明表错位，别照抄记忆。
 * 不认识的编号一律不显示（宁可不标，也不瞎猜一个量化名给人看）。
 */
const FILE_TYPE_LABELS = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  6: 'Q5_0',
  7: 'Q5_1',
  8: 'Q8_0',
  9: 'Q8_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  20: 'IQ2_XXS',
  21: 'IQ2_XS',
  22: 'IQ3_XXS',
  23: 'IQ1_S',
  24: 'IQ4_NL',
  25: 'IQ3_S',
  26: 'IQ3_M',
  27: 'IQ2_S',
  28: 'IQ2_M',
  29: 'IQ4_XS',
  30: 'IQ1_M',
  31: 'BF16',
}

/**
 * 给定一个路径，判断它是不是 Ollama 存储里的权重 blob，是就带回它的 tag 等信息。
 *
 * adopt 需要这个：Ollama 的模型不能用 `-m <blob路径>` 去起 llama-server ——
 * ollama 是按 tag 加载的（`qwen3:14b`），blob 文件名只是摘要。认出来源之后，
 * adopt 只要确认 11434 在应答，然后拿 tag 当模型 id 注册就对了。
 */
export function ollamaModelFor(path, io = {}) {
  const needle = toSlash(String(path ?? '')).toLowerCase()
  if (needle.length === 0) return undefined
  const list = Array.isArray(io.models) ? io.models : scanOllamaModels(io)
  return list.find((item) => toSlash(String(item.path)).toLowerCase() === needle)
}

/** `metadata/sha256-<digest>.json` 里的 GGUF kv → 面板要用的可读字段（全部可选）。 */
function readOllamaMetadata(item, io) {
  const readText = typeof io.readText === 'function' ? io.readText : safeReadText
  const hex = String(item.path).replace(/^.*sha256-/, '')
  const text = readText(joinPath(item.root, 'metadata', 'sha256-' + hex + '.json'))
  if (typeof text !== 'string' || text.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  const kv = parsed?.kv ?? {}
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : undefined)
  const architecture = String(kv['general.architecture'] ?? '')
  const contextLength =
    num(kv[(architecture.length > 0 ? architecture : 'general') + '.context_length']) ?? num(kv['context_length'])
  const fileType = num(kv['general.file_type'])
  const modelName = String(kv['general.name'] ?? '')
  return {
    ...(architecture.length > 0 ? { architecture } : {}),
    ...(modelName.length > 0 ? { modelName } : {}),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(fileType === undefined || FILE_TYPE_LABELS[fileType] === undefined
      ? {}
      : { quantization: FILE_TYPE_LABELS[fileType] }),
  }
}

/** 显示名：优先 tag（`qwen3:14b` 是用户认知里的名字），其次 GGUF 的 general.name，最后才是 sha256-…。 */
function displayNameOf(item, meta) {
  const tag = item.tags[0] ?? ''
  if (tag.length > 0) return tag
  const pretty = typeof meta?.modelName === 'string' ? meta.modelName : ''
  if (pretty.length > 0) return pretty
  return String(item.path).replace(/^.*[\\/]/, '')
}

function safeReadText(path) {
  try {
    return fsReadFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 两条指向同一个文件的记录该留哪条：有 tag / 知道来自 ollama 的赢。
 * 落选那条的 tag 合并进赢家（同一个 blob 被多个 tag 引用的情况不能丢名字）。
 */
function mergeDuplicate(winner, loser) {
  const tags = [...(winner.tags ?? []), ...(loser.tags ?? [])].filter((tag, index, all) => all.indexOf(tag) === index)
  if (tags.length > 0) {
    winner.tags = tags
    if (typeof winner.readableName !== 'string' || winner.readableName.length === 0) winner.readableName = tags[0]
    if (winner.name === undefined || /^sha256-/.test(String(winner.name))) winner.name = tags[0]
  }
  if ((winner.sizeBytes || 0) === 0) winner.sizeBytes = loser.sizeBytes || 0
  if (winner.source !== 'ollama' && loser.source === 'ollama') {
    winner.source = 'ollama'
    winner.origin = 'ollama'
    winner.engine = 'ollama'
  }
  return winner
}

function nameScore(item) {
  return (Array.isArray(item.tags) && item.tags.length > 0 ? 2 : 0) + (item.source === 'ollama' ? 1 : 0)
}

/**
 * 列本机可用的模型文件。返回 [{ path, name, dir, sizeBytes, mmproj, source, tags }]，
 * 按大小降序（大的通常是想用的那个）。
 * io 全部可注入：exists / listDir / statSize / statId / readHead / readText / env / dirs /
 * depth / maxModels / maxEntries / ollama。
 *
 * 边界：`~/Downloads` 这种目录可能有几万个文件，`node_modules` 式的深坑更多。
 * 所以这里有四道上限 —— 总访问节点数、命中模型数、魔数读取次数、ollama manifest 条目数 ——
 * 任意一道满了就停，并在返回值里带上 `truncated`，让面板能说「只扫了前 N 个」而不是假装扫全了。
 *
 * v0.4.5 补掉两个漏判：
 *  1. **只认 `.gguf` 扩展名** → Ollama 的 `blobs/sha256-…` 永远扫不到（无后缀，且被 depth 挡在第三层）。
 *     现在够大的文件读 4 字节魔数，是 GGUF 就收。
 *  2. **不看 Ollama 存储的 manifest** → 就算扫到 blob 也不知道它叫 `qwen3:14b`。
 *     现在额外走 `scanOllamaModels()`，把 tag 名字和量化元数据还原回来。
 */
export function scanLocalModels(io = {}) {
  const exists =
    typeof io.exists === 'function' ? io.exists : typeof io.existsSync === 'function' ? io.existsSync : safeExists
  const listDir = typeof io.listDir === 'function' ? io.listDir : safeListDir
  const statSize = typeof io.statSize === 'function' ? io.statSize : safeSize
  const magic = typeof io.readHead === 'function' ? io.readHead : readGgufMagic
  const dirs = Array.isArray(io.dirs) ? io.dirs : localModelDirs()
  const depth = Number(io.depth) > 0 ? Number(io.depth) : 2
  const maxModels = Number(io.maxModels) > 0 ? Number(io.maxModels) : 300
  const maxEntries = Number(io.maxEntries) > 0 ? Number(io.maxEntries) : 20_000
  // 魔数读取要开文件，磁盘大的目录（iso、视频）不能无限试，次数封顶。
  const maxMagic = Number(io.maxMagic) > 0 ? Number(io.maxMagic) : 600
  // GGUF 再小也是几百 MB 起；拿它当「值不值得开文件读 4 字节」的闸。
  const minGgufBytes = Number(io.minGgufBytes) > 0 ? Number(io.minGgufBytes) : 8 * 1024 * 1024
  // Downloads 只扫一层：里面通常是压缩包和安装器，套一层子目录就是别人解压出来的项目树。
  const shallowDirs = Array.isArray(io.shallowDirs)
    ? io.shallowDirs
    : ['Downloads', 'downloads', '下載']
  const isShallow = (dir) => shallowDirs.some((name) => new RegExp('[\\\\/]' + name + '$').test(dir))

  const found = []
  const seen = new Set()
  // 同一个文件可能被两条路扫到（ollama 的 blob + 硬链接到 ~/models）。按 inode 收敛。
  const seenFile = new Map()
  let entries = 0
  let magicReads = 0
  let truncated = false

  const add = (entry) => {
    const id = fileId(entry.path, io)
    if (id !== null) {
      const earlier = seenFile.get(id)
      if (earlier !== undefined) {
        // 留下更有名字的那条，另一条的 tag 合并过来
        if (nameScore(entry) > nameScore(earlier)) {
          const loser = earlier
          seenFile.set(id, mergeDuplicate(entry, loser))
          const at = found.indexOf(loser)
          if (at >= 0) found.splice(at, 1, entry)
        } else {
          mergeDuplicate(earlier, entry)
        }
        return
      }
      seenFile.set(id, entry)
    }
    found.push(entry)
  }

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
      const byExt = /\.gguf$/i.test(name)
      // 命中判定：扩展名是 .gguf，或者（**没有扩展名**、够大、没读超上限）文件头魔数是 GGUF。
      // 后者专门为了 Ollama 的 blobs/sha256-… —— 那种文件根本没有扩展名。
      // 只碰「没有点号」的名字：一个目录里绝大多数文件都带后缀，别为它们白开一次 stat。
      const noExt = !byExt && !name.includes('.')
      let gguf = byExt
      let sizeBytes = 0
      if (byExt) {
        sizeBytes = statSize(full)
      } else if (noExt && magicReads < maxMagic) {
        const candidateSize = statSize(full)
        if (candidateSize >= minGgufBytes) {
          magicReads += 1
          if (looksLikeGguf(name, magic(full))) {
            gguf = true
            sizeBytes = candidateSize
          }
        }
      }
      if (gguf) {
        const source = originOf(dir)
        add({
          path: full,
          name,
          dir,
          sizeBytes,
          // .mmproj. 是视觉投影，单独标出来，别让人当主模型选
          mmproj: /\.mmproj\./i.test(name),
          source,
          origin: source,
          tags: [],
        })
        continue
      }
      // 目录：只在看起来像模型库的名字上继续往下走一层（ollama/manifests 是 v0.4.5 补的）
      if (/^[^.]/.test(name) && level < limit) {
        if (exists(full + '/')) walk(full, level + 1, limit)
        else if (/model|gguf|lmstudio|hub|blobs|files|ollama|manifests|sha256/i.test(name)) walk(full, level + 1, limit)
      }
    }
  }

  for (const dir of dirs) {
    if (truncated) break
    if (typeof dir !== 'string' || dir.length === 0) continue
    if (!exists(dir)) continue
    walk(dir, 1, isShallow(dir) ? 1 : depth)
  }
  // Ollama 的模型走它自己那套存储（blobs + manifests），普通目录扫描要么看不见
  // （没有 .gguf 后缀 + depth 挡在第三层），要么看见了也不知道它叫 qwen3:14b。
  // 这里单独补一趟，并把结果按 inode 并进上面的清单。ollama 没装/读不到都不影响主清单。
  //
  // 但这一趟默认**不参与**注入了假目录视图的调用（单元测试的 `exists: () => true`
  // 会让标准位置都被当成 ollama 存储，然后沿着假树一路下钻到条目上限，顺便谎报 truncated）。
  // 要测它就得显式给 `ollamaRoots` 或 `ollama: true` —— 假 fs 必须自己把 ollama 那棵树也编出来。
  const hasCustomFs =
    typeof io.exists === 'function' || typeof io.existsSync === 'function' || typeof io.listDir === 'function'
  const runOllama = io.ollama !== false && (Array.isArray(io.ollamaRoots) || io.ollama === true || !hasCustomFs)
  if (runOllama) {
    try {
      const extra = scanOllamaModels({
        exists,
        listDir,
        statSize,
        readText: io.readText,
        statId: io.statId,
        env: io.env,
        roots: io.ollamaRoots,
      })
      for (const item of extra) {
        if (found.length >= maxModels) {
          truncated = true
          break
        }
        add(item)
      }
      if (extra.truncated === true) truncated = true
      entries += extra.scannedEntries | 0
    } catch {
      /* 兜底：ollama 那趟整体炸了也不能让本机模型清单变空 */
    }
  }

  found.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))

  // v0.4.6：读 GGUF 自己的 KV，把被改名的文件还原成真名（workbuddy 会把任何模型都叫
  // `local_model.gguf`，35B 的线索只在 `general.name` / `general.basename` 里）。
  // 成本是每文件最多读 24MB（只走指针不复制载荷，本机 15.8GB 的 35B 实测 18ms），
  // 但一台机可能有几百个 gguf，所以按体积从大到小只补前 `maxMetaReads` 个 ——
  // 用户要点的那几个通常就是最大的；投影文件本身也小，落在窗口外正好省一次读。
  // 文件名里带 `.mmproj.` 的跳过（已经标成投影了，读它不改变任何决定）。
  const maxMetaReads = Number(io.maxMetaReads) > 0 ? Number(io.maxMetaReads) : 40
  let metaReads = 0
  if (io.ggufMeta !== false) {
    const metaIo = {
      readMeta: io.readMeta,
      readRange: io.readRange,
      fileSize: io.fileSize,
      maxMetaBytes: io.maxMetaBytes,
    }
    for (const entry of found) {
      if (entry.mmproj === true) continue
      // Ollama 那条已经从 metadata/sha256-*.json 拿到了名字和量化，别再开 5GB 文件
      if (entry.source === 'ollama' && entry.quantization !== undefined && entry.modelName !== undefined) continue
      if (metaReads >= maxMetaReads) break
      metaReads += 1
      let meta = {}
      try {
        meta = readGgufMeta(entry.path, metaIo) ?? {}
      } catch {
        meta = {}
      }
      decorateWithGgufMeta(entry, meta)
      // Ollama 那条：tag 是用户认知里的名字，也是必须发给 11434 的模型 id，
      // 元数据名（"Qwen3 14B"）当副标题看，不能把 name 顶掉。
      if (entry.source === 'ollama' && Array.isArray(entry.tags) && entry.tags.length > 0) {
        entry.readableName = entry.tags[0]
      }
    }
  }

  // 数组本身照旧返回（老调用方按数组用），额外信息挂在 found 上。
  found.truncated = truncated
  found.scannedEntries = entries
  found.magicReads = magicReads
  found.metaReads = metaReads
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
