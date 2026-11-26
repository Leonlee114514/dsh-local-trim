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
import { execFile, execFileSync as nodeExecFileSync, spawn as nodeSpawn } from 'node:child_process'
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
 *
 * 两件必须在这里做的事（用户手填的路径都会经过这儿）：
 *   - 展开开头的 `~`：`DSH_LOCAL_MODELS_DIR=~/models` 原来变成字面量 `~/models`，
 *     那个目录永远不存在，扫描结果就是「一个模型都没有」而且没有任何报错。
 *   - 归一 `..` / `.`：`~/models/../weights` 里的 `..` 交给 fs 解析也行，
 *     但拼出来的字符串会原样出现在面板的「找过哪些目录」里，读起来像路径算错了。
 */
export function joinPath(...parts) {
  const keep = parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .map((part) => toSlash(part))
  if (keep.length === 0) return ''
  // 开头的 `~` 只认第一段（`a/~/b` 里的 `~` 是普通目录名）
  const expanded = keep.map((part, index) => {
    if (index !== 0) return part
    if (part === '~') return homeDir()
    if (part.startsWith('~/')) return homeDir() + part.slice(1)
    return part
  })
  // 第一段的前导斜杠决定这条路径是不是绝对路径
  //
  // [L5b-2026-11-26] UNC 路径（`\\NAS\share\models`，toSlash 之后是
  // `//NAS/share/models`）的前两段是「服务器 / 共享名」，它们才是根。原来只留一个
  // 前导斜杠，`//` 被压成 `/NAS/share/models` —— 变成当前盘根下的路径，扫描结果
  // 就是「一个模型都没有」而且不报错；`..` 还能一路退到 `/`。
  // 网络盘上放 gguf（README 明确支持用环境变量指目录）就是这么静默丢的。
  const uncMatch = /^\/\/([^/]+)\/([^/]+)/.exec(expanded[0])
  const uncRoot = uncMatch === null ? '' : '//' + uncMatch[1] + '/' + uncMatch[2]
  const leading = uncRoot.length > 0 ? '' : expanded[0].startsWith('/') ? '/' : ''
  // UNC 的两段先摘出去，剩下的按相对路径归一 —— `..` 退到共享名就停。
  const body = uncRoot.length > 0 ? [expanded[0].slice(uncRoot.length), ...expanded.slice(1)] : expanded
  const segments = []
  // [L5-2026-11-26] 根必须认出来，否则 `..` 会把盘符也 pop 掉：
  // joinPath('C:/models', '..', '..') 原来是 `models` 和 `C:` 各被弹一次 → 返回 ''，
  // 一个绝对路径被「归一」成了空串（调用方拿去 fs 就变成当前工作目录）。
  // 盘符（Windows）和开头的 `/`（POSIX）都是根：退到它就停。
  // 只在第一段上认盘符 —— `a/C:/b` 里的 `C:` 只是名字里带冒号的目录。
  const driveRoot = /^[A-Za-z]:$/.test(expanded[0].split('/')[0]) ? expanded[0].split('/')[0] : ''
  // 盘符是真占一格的段（`C:` 会被 split 成 ['C:', …]），POSIX 的开头斜杠不占段
  // （它是 leading，不进 segments）—— 所以这里只有盘符算 1，斜杠算 0。
  const rootSegments = driveRoot.length > 0 ? 1 : 0
  for (const part of body) {
    for (const piece of part.split('/')) {
      if (piece.length === 0 || piece === '.') continue
      if (piece === '..') {
        // 绝对路径能一直往上退到根；相对路径退到空就停，不越过开头
        if (segments.length > rootSegments) segments.pop()
        continue
      }
      segments.push(piece)
    }
  }
  // 盘符退到头时补回斜杠：`C:` 单独一段在 Windows 上指「C 盘的当前目录」，
  // 而 `C:/` 才是盘根 —— 归一化的结果必须是后者。
  if (driveRoot.length > 0 && segments.length === 1 && segments[0] === driveRoot) return driveRoot + '/'
  // UNC 的根是 `//server/share` 两段，退到它就停（不能再往上，也不能把它当普通目录名）
  if (uncRoot.length > 0) return segments.length === 0 ? uncRoot : uncRoot + '/' + segments.join('/')
  return leading + segments.join('/')
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
    // 顺序刻意如此：显式环境变量 → 官方安装位置 → 目录约定 → PATH 裸名字。
    // 反了就会「这台机器恰好放在 ~/AI 下」压过所有人的标准安装，换台机器等于
    // 全靠裸名字兜底；而两台都装了的机器上，被选中的是那个非官方的副本。
    candidates: () => uniq([
      process.env.OLLAMA_BIN,
      ...(WIN
        ? [
            joinPath(dataDir(), 'Programs/Ollama/ollama.exe'),
            'C:/Program Files/Ollama/ollama.exe',
            joinPath(homeDir(), 'AI/ollama/ollama.exe'),
          ]
        : MAC
          ? ['/Applications/Ollama.app/Contents/Resources/ollama', '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama']
          : ['/usr/local/bin/ollama', '/usr/bin/ollama', '/snap/bin/ollama']),
      'ollama',
    ]),
    args: ['serve'],
    // [port-honor] OLLAMA_HOST 里的端口必须跟着用户选的端口走。
    // 原来硬编码 11434：用户把端口改成 11435 后，`ollama serve` 仍然监听 11434，
    // 面板去探 11435 永远超时，然后把刚起的进程收掉。
    env: (port) => ({
      OLLAMA_HOST: `127.0.0.1:${Number(port) > 0 ? Number(port) : 11434}`,
      ...(process.env.OLLAMA_MODELS ? {} : modelsDirHint()),
    }),
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    port: 8090,
    // 同 ollama：显式变量 → 官方/包管理器位置 → 目录约定（~/.workbuddy 下的构建）
    // → PATH 裸名字。workbuddyBinary 曾经排第一，那等于「谁家装过 WorkBuddy 就永远
    // 用它那副本」—— 换台机器这个函数返回空串，白排一位。
    candidates: (io) => uniq([
      process.env.LLAMA_SERVER_BIN,
      ...(WIN
        ? [joinPath(dataDir(), 'llama.cpp/llama-server.exe'), joinPath(homeDir(), 'AI/llama.cpp/llama-server.exe')]
        : MAC
          ? ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server']
          : ['/usr/local/bin/llama-server', '/usr/bin/llama-server']),
      workbuddyBinary(io),
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
  // 官方默认位置在前，本机目录约定（~/AI/models/ollama）垫后：前者是所有 ollama
  // 安装方式都认的地方，后者只是「有人习惯把东西都放 ~/AI」。
  const guesses = WIN
    ? [joinPath(homeDir(), '.ollama/models'), joinPath(dataDir(), 'ollama/models'), joinPath(homeDir(), 'AI/models/ollama')]
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

/**
 * 从 baseURL 里取端口。取不到返回 0（交给调用方的默认值）。
 *
 * [ipv6-port] IPv6 字面量没写端口时不能回落到 80/443 —— `http://[::1]/v1` 指的是
 * 本机 80，但本地推理后端全在 8090/11434/8000/1234。原来 IPv6 分支靠
 * `:[^/:]+` 匹配失败 → `match[2] === undefined` → 直接回 80，于是面板把
 * `[::1]` 的自定义端点当成 80 端口，去拉一个不存在的后端。
 * 现在：明确 http/https 的默认端口只在「确实没写端口且不是回环字面量」时才用。
 */
export function portOfBaseURL(baseURL) {
  const text = String(baseURL ?? '').trim()
  // [P1-15-2026-11-25] 别再手写正则拆 URL 了，交给 WHATWG URL。
  //
  // 原来那条 `([^/:?#]+|\[[^\]]+\])(?::(\d+))?` 有四个实测错误：
  //   http://[::1]:8080/v1        → 0     （`[^/:?#]+` 先赢，只吃到 '['，:8080 没进 match[2]）
  //   http://[::ffff:127.0.0.1]:9000/v1 → 0 （同上）
  //   http://user:pw@h:8080/v1    → 80    （userinfo 整个被当成主机名吃掉）
  //   http://h:abc/v1             → 80    （非数字端口匹配失败，回落成默认端口）
  // 前两个直接影响 launchPanel/stopPanel 以 port 为 key 的 launched 表（会去拉/停错端口），
  // 后两个把「端口写错了」伪装成「用的是默认端口」。
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    // 不是绝对 URL。只有「看起来就是个 host[:port][/path]」时才补协议再试 ——
    // 随便一个词（"nonsense"）被当成主机名会解析成 80 端口，那比回 0 更误导：
    // 调用方拿到 80 会去探一个根本不存在的后端，拿到 0 才知道「这里没端口」。
    if (!/[:/]/.test(text) || !/^[^\s/?#@]+(\/|$)/.test(text)) return 0
    try {
      parsed = new URL('http://' + text)
    } catch {
      return 0
    }
  }
  if (parsed.port !== '') {
    const port = Number(parsed.port)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
  }
  // IPv6 字面量（`[::1]`、`[::ffff:127.0.0.1]`）没写端口时回 0，让调用方用后端默认端口。
  // 原来这里统一回 80：本地推理后端全在 8090/11434/8000/1234，把回环字面量当 80
  // 只会让面板去拉一个根本不存在的后端。
  if (parsed.hostname.startsWith('[')) return 0
  if (parsed.protocol === 'https:') return 443
  if (parsed.protocol === 'http:') return 80
  return 0
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
    let parts = []
    try {
      parts = splitCommand(custom)
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), tried: [] }
    }
    // [empty-custom] 引号吃掉整条命令时不能假装成功。
    // `""`、`''`、或者只剩一对未闭合的引号，splitCommand 会给出空数组；
    // 原来照样 return ok:true + command:undefined，一路走到 spawn 才报 ENOENT，
    // 而 runDetached 那时已经改成异步 —— 用户看到的是「起进程失败：」后面什么都没有。
    if (parts.length === 0) {
      return { ok: false, error: '启动命令是空的（或者只有引号），填一条完整命令', tried: [] }
    }
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
        env: known.env(port || known.port),
        source: 'discovered',
        model: auto.model,
        // [P2-14-2026-11-26] 一路透到面板：挑的是哪个文件、为什么挑它。
        picked: auto.picked ?? null,
        loadMode: auto.loadMode ?? '',
        // 引擎代际要一路透出来：面板/日志靠它解释「为什么这条参数没拼」，
        // 否则用户只看到「少了 --fit」却不知道是自己版本老。
        modernEngine: auto.modernEngine !== false,
        // [P1-05-2026-11-25] KV 量化类型一路透到预检，别让「启动下 q8_0、预检按 f16 算」两套口径。
        cacheType: typeof auto.cacheType === 'string' ? auto.cacheType : '',
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
  // [port-honor] 用户自选端口必须一路用到底。
  //
  // 原来固定写 `known.port`：用户在面板里把 ollama 端口改成 11435，拉起命令照样
  // 是 `ollama serve` + env 里硬编码的 11434，plan 还回报 port:11434 —— 于是
  // 面板去探 11434（探到的是别人的服务）、真正拉起来的那个没人等，
  // waitForEndpoint 超时后把刚起的进程收掉，用户看到「起不来」。
  const targetPort = port > 0 ? port : known.port
  const fixedArgs = typeof known.args === 'function' ? known.args(targetPort) : [...known.args]
  return {
    ok: true,
    id: known.id,
    label: known.label,
    port: targetPort,
    command: probe.command,
    args: fixedArgs,
    env: known.env(targetPort),
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

/**
 * 目录枚举：出错当空目录（Windows 上不存在/没权限都会抛）。
 *
 * 只给「调用方确实分不清」的地方用。要让用户知道「这个目录没读成」时，
 * 走 `listDirDetailed` —— 把 EACCES 读成「这个目录没有模型」是最难查的一类
 * 现场：用户明明把 gguf 放在那儿，面板说一个都没有。
 */
function safeListDir(dir) {
  try {
    return fsReaddirSync(dir)
  } catch {
    return []
  }
}

/** 枚举目录，失败时把原因带出来（而不是变成「空目录」）。 */
function listDirDetailed(dir) {
  try {
    return { names: fsReaddirSync(dir), error: '' }
  } catch (error) {
    const code = String(error?.code ?? '')
    if (code === 'ENOENT' || code === 'ENOTDIR') return { names: [], error: '' }
    return { names: [], error: code.length > 0 ? code : String(error?.message ?? error) }
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
  // [L8-2026-11-26] 原来是无比较器的 sort()：按 UTF-16 码位排，`b9999` 会排在
  // `b11012` 后面。llama.cpp 的 build 号是十进制且会跨到五位数，于是每次升级都
  // 有可能被判定成「更旧的构建」——用户以为用上了新二进制，实际还在跑旧的。
  // numeric: true 让数字段按数值比，`b11012` 才 > `b9999`。
  builds.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
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
  // [P1-02-2026-11-25] 短参不只一个字符：`-ngl`（老版 llama.cpp 的分层数写法）
  // 这种三字符短参原来抓不到，于是「--help 只写了 -ngl」的构建被判成不支持 GPU 分层。
  // 放宽到 `-[a-zA-Z][a-zA-Z0-9-]*`；前边界仍要求空白/逗号/括号，后边界仍要求
  // 空白/逗号/右括号/行尾，所以命令行示例里的 `- x`、负数、裸 `--` 都不会被当成参数。
  for (const match of source.matchAll(/(^|[\s,(\[])(-[a-zA-Z][a-zA-Z0-9-]*)(?=[\s,)\]]|$)/g)) {
    flags.add(match[2].toLowerCase())
  }
  return flags.size > 0 ? flags : null
}

const helpCapsCache = new Map()

/**
 * 缓存键：路径 + 文件的 mtime/大小。
 *
 * 原来只用命令字符串当键，于是「同一条路径」永久命中 —— 用户换了/升级了
 * llama-server（同一个安装位置覆盖成新版本），插件还按旧二进制的 --help 结果裁参数：
 * 新版本加的 `--load-mode` 被当成不支持丢掉，或者反过来把已经删掉的参数塞回去。
 * 文件指纹变了就当新命令重新探一次；拿不到 stat（假 fs、远端路径）就退回只用路径。
 */
function capsCacheKey(command) {
  try {
    const st = fsStatSync(command)
    return command + '\u0000' + st.size + ':' + st.mtimeMs
  } catch {
    return command
  }
}

/** 探测并缓存某个可执行文件支持的参数集合（同一个文件只跑一次 --help）。 */
export function probeHelpCaps(command, exec = defaultExecFileSync) {
  const key = String(command ?? '').trim()
  if (key.length === 0) return null
  const cacheKey = capsCacheKey(key)
  if (helpCapsCache.has(cacheKey)) return helpCapsCache.get(cacheKey)
  let flags = null
  try {
    const help = exec(key, ['--help'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 })
    flags = parseHelpFlags(help)
  } catch (error) {
    // 有些二进制把 --help 打到 stderr 然后非零退出，stdout 拿不到就再试一次
    const stderr = String(error?.stderr ?? '')
    flags = stderr.length > 0 ? parseHelpFlags(stderr) : null
  }
  // [P1-06-2026-11-25] 探不出来（null）不进缓存。
  //
  // 原来无条件 set，于是「二进制被占用 / 权限不足 / 8s 超时」这种**瞬时**失败
  // 会被永久固化成「这个文件没有能力」——之后无论重启插件还是重试都还是 null，
  // 只能靠文件指纹变化（升级二进制）才解开。null 的语义是「我不知道」，
  // 而「不知道」必须每次重新问，不能记成答案。
  if (flags !== null) helpCapsCache.set(cacheKey, flags)
  return flags
}

// [P1-02-2026-11-25] 同一个参数在不同版本/不同分支的 --help 里有不同写法。
//
// 实测：某些构建把分层数写成 `--gpu-layers N`（没有 `--n-gpu-layers`），
// 老版本只认 `-ngl`。原来 keepFlag 是严格 `caps.has(flag)`，于是
// `push('--n-gpu-layers', ...)` 判定「引擎不支持」整条丢掉 —— 模型静默纯 CPU 跑，
// 面板上只有一条不起眼的 dropped，用户不会意识到损失了全部 GPU 加速。
// 这里给每个已知 flag 一张等价写法表，命中任意一种就算支持，并且**用引擎自己
// 那个写法下发**（不能把 `--n-gpu-layers` 塞给只认 `--gpu-layers` 的二进制，
// 那会直接 invalid argument 起不来 —— 保留参数却拼错名字，比丢掉更糟）。
const FLAG_ALIASES = new Map([
  ['--n-gpu-layers', ['--n-gpu-layers', '--gpu-layers', '-ngl']],
  ['--gpu-layers', ['--gpu-layers', '--n-gpu-layers', '-ngl']],
  ['-ngl', ['-ngl', '--n-gpu-layers', '--gpu-layers']],
  ['--ctx-size', ['--ctx-size', '-c']],
  ['-c', ['-c', '--ctx-size']],
  ['--n-predict', ['--n-predict', '-n']],
  ['--parallel', ['--parallel', '-np']],
  ['--load-mode', ['--load-mode']],
])

/**
 * 解析一个 flag 在本引擎里该用哪个写法。
 *
 * 返回引擎认的那个拼写；不支持返回 null；探不出能力（caps 为 null）返回原样
 * —— 「我不知道」不等于「不支持」，保持旧行为。
 */
function resolveFlag(caps, flag) {
  const lower = String(flag).toLowerCase()
  if (caps === null || caps === undefined) return lower
  const candidates = FLAG_ALIASES.get(lower) ?? [lower]
  for (const candidate of candidates) {
    if (caps.has(candidate)) return candidate
  }
  return null
}

/** 只在「确认支持」或「探不出来」时保留某个参数（探不出来不裁剪，保持旧行为）。 */
function keepFlag(caps, flag) {
  return resolveFlag(caps, flag) !== null
}

/**
 * 拼 llama-server 的参数。挑模型规则：优先 local_model.gguf，否则按名字排序取第一个；
 * 带 .mmproj. 的是视觉投影，不能当主模型。
 * 参数取一个「多数机器都不出错」的保守组合：q8_0 KV + 单 slot + --fit on + --jinja。
 * 各参数的可用性差异（老版本 llama.cpp 没有 --load-mode / --fit）由 --help 能力探测兜底，
 * 见 capsFor()。
 */
export function llamaCppAutoArgs(io = {}) {
  const explicit = String(io.modelPath ?? '').trim()
  let model
  let preferred
  // [P2-14-2026-11-26] 把「挑了哪个、为什么挑它」一起透出去。
  // 原来只回 model 路径，面板上看到的是 llama-server 的 -m 参数 —— 用户没法知道
  // 这是他自己选的、还是插件在三个目录里按体积挑的（挑错了也没处说理）。
  let pickReason = ''
  if (explicit.length > 0) {
    // 面板上选定了某个 gguf，就用它，不再去目录里猜
    model = explicit.split(String.fromCharCode(92)).join('/')
    preferred = model.slice(model.lastIndexOf('/') + 1)
    pickReason = '用你指定的模型'
  } else {
    // 没指定 gguf：按 localModelDirs() 的顺序找第一个 —— 原来只认 WorkBuddy 的
    // ~/.workbuddy/local-models/files，换台机器（或用户把模型放 ~/models）就报「没模型」。
    const listDir = io.listDir ? io.listDir : safeListDir
    const dirs = Array.isArray(io.dirs) ? io.dirs : localModelDirs()
    const statSize = typeof io.statSize === 'function' ? io.statSize : safeSize
    // [pick-largest] 挑哪个模型不能看字典序，也不能「第一个有 gguf 的目录永远赢」。
    //
    // 原来 `files.slice().sort()[0]` 取的是字典序第一个（`a.gguf` 排在
    // `qwen3-32b.gguf` 前面），再加上 `picked = {...}; break` 命中第一个目录就收工 ——
    // 于是 ~/models 里躺着一个随手下的 1B 别名文件，用户点了「一键拉起」跑起来的是它，
    // 而 32B 那个连看都没看。改法：所有目录、所有候选都过一遍，按文件体积取最大的；
    // 体积拿不到（假 fs / 权限）才退回原来的顺序，保持可预测。
    // local_model.gguf 是 WorkBuddy 的固定名，优先它 —— 那是用户明确选过的那一份。
    let picked = null
    for (const dir of dirs) {
      // [regex-dot] `.gguf` / `.mmproj.` 的点必须转义，否则 `.` 通配一位 ——
      // `aXgguf` 这种名字会被当成模型文件拉起来（llama-server 直接报 unknown model）。
      const files = listDir(dir).filter((name) => /\.gguf$/i.test(name) && !/\.mmproj\./i.test(name))
      if (files.length === 0) continue
      const fixed = files.find((item) => /^local_model\.gguf$/i.test(item))
      const candidates = fixed === undefined ? files : [fixed]
      for (const name of candidates) {
        const sizeBytes = Number(statSize(dir + '/' + name)) || 0
        if (picked === null || sizeBytes > picked.sizeBytes) {
          picked = { dir, name, sizeBytes, fixed: fixed !== undefined }
        }
      }
      if (picked !== null && picked.sizeBytes === 0 && fixed !== undefined) {
        // 体积全拿不到又没有更大的可比时，固定名那份已经足够，别再翻后面的目录。
        break
      }
    }
    if (picked === null) return { ok: false, reason: 'no-model', dirs }
    preferred = picked.name
    model = picked.dir + '/' + picked.name
    // [P2-14-2026-11-26] 挑模型的三种来由要能分开说，否则用户看到「跑起来的是个 1B」
    // 只能猜是插件瞎选、还是他自己把 local_model.gguf 换掉了。
    pickReason = picked.fixed === true
      ? '目录里有 local_model.gguf（固定名），优先用它'
      : picked.sizeBytes > 0
        ? '没指定模型，在本地目录里挑了体积最大的一个'
        : '没指定模型，体积读不到，按目录顺序取了第一个'
  }
  // [P1-14-2026-11-25] `Number(x) || 默认值` 只挡得住 0/NaN：
  // 负数（port: -1）和空串（alias: ''）都能穿过 —— 负端口直接让 llama-server 起不来，
  // 空 alias 会让 /v1/models 报一个空 id，面板拿它去对账永远对不上。
  // 这里逐项校验范围，不合格才回落。
  const rawPort = Number(io.port)
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? Math.floor(rawPort) : 8090
  const rawCtx = Number(io.ctx)
  // 下限 512：再小的上下文连一份系统提示都放不下，纯属填错。
  const ctx = Number.isFinite(rawCtx) && rawCtx >= 512 ? Math.floor(rawCtx) : 65536
  const rawAlias = io.alias === null || io.alias === undefined ? '' : String(io.alias).trim()
  const alias = rawAlias.length > 0 ? rawAlias : preferred.replace(/\.gguf$/i, '')
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
  // [P1-02-2026-11-25] 下发时用引擎自己的写法（resolveFlag 选中的那个候选），
  // 而不是调用方写的那个 —— 只认 --gpu-layers 的二进制收到 --n-gpu-layers 会直接
  // invalid argument 起不来。
  const push = (flag, ...values) => {
    const resolved = resolveFlag(caps, flag)
    if (resolved !== null) optional.push(resolved, ...values)
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
  // [P1-05-2026-11-25] 这里下什么 KV 类型，预检就得按什么类型算字节数。
  // 原来两处各说各话：启动时下 q8_0，estimateKvBytes 却按 f16（2 B/elem）估，
  // 一个 27B MoE 在 65536 上下文下被多算 4~5GB，本来装得下的模型被标成 risky。
  // 所以把实际下发的类型带出去（没下发就是空串 = 引擎默认），让调用方按同一口径算。
  const cacheType = modernEngine ? DEFAULT_KV_CACHE_TYPE : ''
  if (cacheType.length > 0) {
    push('--cache-type-k', cacheType)
    push('--cache-type-v', cacheType)
  }
  if (loadMode.length > 0) push('--load-mode', loadMode)
  push('-c', String(ctx))
  push('--n-predict', '8192')

  return {
    ok: true,
    model,
    port,
    // [P2-14-2026-11-26] 面板/日志要能解释「为什么是这个文件」。
    picked: { path: model, name: preferred, reason: pickReason },
    args: ['-m', model, '--host', '127.0.0.1', '--port', String(port), ...optional],
    loadMode: loadMode.length > 0 && keepFlag(caps, '--load-mode') ? loadMode : '',
    modernEngine,
    // 空串 = 没给引擎指定 KV 类型，按引擎自己的默认算
    cacheType: cacheType.length > 0 && keepFlag(caps, '--cache-type-k') ? cacheType : '',
    dropped,
  }
}

/**
 * 现代引擎默认下发的 KV cache 类型。
 *
 * [D1-2026-11-26] 这个值原来只活在 llamaCppAutoArgs 里（`cacheType = modernEngine ? 'q8_0' : ''`），
 * 而两处面板预检（modelsPanel / adoptPanel）各算各的 KV 字节数，从没传过类型 ⇒ 按 f16
 * 估 ⇒ 高估 1.88×。实测 64 层 / 5120 hidden / 40 head / 8 kv head / 65536 ctx：
 * f16 16384 MiB、q8_0 8704 MiB，本来装得下的模型被标成 risky 挡在确认框前。
 *
 * 导出来给预检用，两侧从此同源。改这里一处就同时改了「下发的参数」和「预检的口径」。
 */
export const DEFAULT_KV_CACHE_TYPE = 'q8_0'

/** b11012 认的五个加载模式；空串 = 不传，交给引擎自己选。 */
export const LOAD_MODES = ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock']

/**
 * 校验并归一化加载模式，认不出来的当没填。
 *
 * [load-mode-normalize] 原来只做精确匹配，于是界面/配置里常见的写法全静默变空串：
 * `mlock+mmap`（顺序反了）、`mmap + mlock`（带空格）、`MLOCK`（已 lowercase 能过）、
 * `gpu`、`no-mmap`、`off`。用户明明选了「锁定内存」，插件却按「不传」处理，
 * 而且在面板上看不出任何差别 —— 静默降级比报错更难查。
 * 现在先抹掉空白/下划线/横线并按 `+` 拆开，把同义词映射到白名单里的五个值；
 * 仍然认不出来就当没填（保持「不传 = 交给自己选」的旧语义）。
 */
export function normalizeLoadMode(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text.length === 0) return ''
  if (LOAD_MODES.includes(text)) return text
  const parts = text
    .replace(/[\s_-]+/g, '')
    .split('+')
    .filter((part) => part.length > 0)
  if (parts.length === 0) return ''
  const alias = {
    pagecache: 'mmap',
    cached: 'mmap',
    disk: 'none',
    direct: 'none',
    nolock: 'none',
    no: 'none',
    off: 'none',
    false: 'none',
    lock: 'mlock',
    locked: 'mlock',
    pin: 'mlock',
    auto_: 'auto',
  }
  const mapped = parts.map((part) => (alias[part] !== undefined ? alias[part] : part))
  if (mapped.length === 1) return LOAD_MODES.includes(mapped[0]) ? mapped[0] : ''
  if (mapped.length === 2) {
    const set = new Set(mapped)
    if (set.has('mmap') && set.has('mlock')) return 'mmap+mlock'
    if (set.has('auto') && set.has('mmap')) return 'mmap'
    if (set.has('auto') && set.has('mlock')) return 'mlock'
    if (set.has('none')) return 'none'
  }
  return ''
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
    ...flat,
    // 目录约定（有人习惯把模型都堆在 ~/AI 下）排在通用位置之后，
    // 免得一个私人习惯压过 llama.cpp / LM Studio 的标准布局。
    joinPath(home, 'AI/models'),
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
    // 只认「整整 4 字节且是 GGUF」：文件不足 4 字节时原来返回 'GGU' 这种短串，
    // 与调用方的 `magicHead !== 'GGUF'` 恰好也能否掉，但短串再被拿去显示就变成
    // 「文件头是 GGU」这种读起来像解析出错的文案。凑不满 4 字节就当没读到。
    if (got !== 4) return ''
    return buffer.toString('latin1', 0, 4)
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
  // [gguf-partial] 半途而废时返回已经拿到的键 —— 前面读到的是真的。
  // 但必须让调用方看得出「这份 kv 不完整」：原来直接 return kv，契约上等于
  // 「读完了」，于是缺 general.name 会被当成「这个文件本来就没名字」，
  // 排障时看不出是解析中途撞上限。用不可枚举属性标一下，JSON/遍历都不受影响。
  const bail = () => {
    try {
      Object.defineProperty(kv, 'partial', { value: true, enumerable: false })
    } catch {
      /* 冻结对象之类：标记失败不影响已有键 */
    }
    return kv
  }
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
    // [gguf-v1] v1 的布局差别只有两处：version 之后紧跟 n_tensors(u32)、n_kv(u32)，
    // 头一共 16 字节；v2+ 中间多了个 u64 n_tensors，n_kv 落在 offset 16。
    // KV 的编码（u64 长度前缀 + u32 类型）两版一致，所以只需把读头的位置分开。
    const version = head.readUInt32LE(4)
    if (version < 1) return {}
    let nKv
    if (version === 1) {
      nKv = head.readUInt32LE(12)
      pos = 16
      bytesRead = 16
    } else {
      nKv = u64(head, 16)
    }
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
        // [gguf-chunk] 别一律读满 256KB：数组通常只有几十条，读满会把
        // 后面的权重数据一起拉进来（`cost()` 也就按 256KB 一路记账），
        // 一个 4096 条的 token 表直接把 maxReadBytes 吃光、剩下的键全读不到。
        // 有文件大小时按「这里还剩多少」收窄，没有就退回整块。
        const span = fileSize > 0 ? fileSize - pos : GGUF_META_CHUNK
        const chunk = readAt(pos, Math.max(1, Math.min(GGUF_META_CHUNK, span)))
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
    // [P1-12-2026-11-25] 读到一半抛异常时，kv 里已经有前面解析出来的键了。
    // 直接原样返回，调用方分不清「这个文件只有这些键」和「文件被读坏了，后面都没读到」——
    // 前者可以照常按缺省处理，后者必须去怀疑文件本身（截断的 GGUF 是常见事故）。
    // 挂一个不可枚举的 partial 标记：JSON.stringify 与 deepEqual 都不受影响，
    // 但调用方可以 `if (meta.partial === true)` 单独走一条「元数据不完整」的路。
    Object.defineProperty(kv, 'partial', { value: true, enumerable: false })
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
  // GGUF 里的数字是按 IEEE754 存下来的，畸形/恶意文件可能塞进 1e400 —— Number() 会把它变成
  // Infinity，而 `Infinity > 0` 成立，于是这条 Infinity 被当成上下文长度写进 patch，
  // 面板上显示成一串怪东西、下游按它算显存也会溢出。只认有限正数。
  const contextRaw = Number(
    meta[(architecture.length > 0 ? architecture : 'general') + '.context_length'] ?? meta['context_length'],
  )
  const contextLength = Number.isFinite(contextRaw) && contextRaw > 0 ? contextRaw : 0
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
  // [gguf-dims] KV cache 的体量由「层数 x 上下文 x 每层 KV 维度」决定，不是由文件大小
  // 决定。这里顺手把三个维度读出来（键名带架构前缀，ollama 的 json 里也长这样）：
  //   <arch>.block_count / <arch>.embedding_length / <arch>.head_count(_kv)
  // 缺任何一个都留空 —— 估算函数会自己回 0，绝不拿猜的值去“补”。
  const dimKey = (suffix) => {
    const raw = Number(meta[(architecture.length > 0 ? architecture : 'general') + '.' + suffix] ?? meta[suffix])
    return Number.isFinite(raw) && raw > 0 ? raw : 0
  }
  const blockCount = dimKey('block_count')
  const embeddingLength = dimKey('embedding_length')
  const headCount = dimKey('attention.head_count') || dimKey('head_count')
  // 多数 GQA 模型的 KV 头数比 Q 头数少（8 对 32 很常见），缺这个键按 headCount 算会把
  // KV cache 高估 4 倍，所以单独读、读到才用。
  const headCountKv = dimKey('attention.head_count_kv') || dimKey('head_count_kv')
  if (blockCount > 0) patch.blockCount = blockCount
  if (embeddingLength > 0) patch.embeddingLength = embeddingLength
  if (headCount > 0) patch.headCount = headCount
  if (headCountKv > 0) patch.headCountKv = headCountKv
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
      ? [joinPath(home, '.ollama/models'), joinPath(dataDir(), 'ollama/models'), joinPath(home, 'AI/models/ollama')]
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
  19: 'Q8_K',
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
  // 32 起是带 SIMD 布局后缀的量化（llama.cpp 的 repack 版本）。缺这些键的后果不是崩溃，
  // 而是「明明是个标准的 Q4_0_4_4 却一个字都不显示量化」，排障时以为元数据解析坏了。
  32: 'Q4_0_4_4',
  33: 'Q4_0_4_8',
  34: 'Q4_0_8_8',
  35: 'TQ1_0',
  36: 'TQ2_0',
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
  // 目录判定：true=目录 / false=文件 / null=问不出来（此时按名字猜）。
  const statIsDir =
    typeof io.statIsDir === 'function'
      ? io.statIsDir
      : (path) => {
          try {
            return fsStatSync(path).isDirectory()
          } catch {
            return null
          }
        }
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
  // [regex-escape] 目录名必须转义才能进 RegExp。
  // 原来直接拼字符串：`shallowDirs: ['Download(s']` 会抛
  // `SyntaxError: Invalid regular expression: /[\\/]Download(s$/: Unterminated group`，
  // 而 modelsPanel 调用链上没有 try/catch → 整个面板路由炸掉。
  // 名字里的 `.`/`(`/`[` 之类很常见（`v1.0`、`模型(备份)`），不只是恶意输入的问题。
  const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const shallowPatterns = shallowDirs.map((name) => new RegExp('[\\\\/]' + escapeRe(name) + '$'))
  const isShallow = (dir) => shallowPatterns.some((pattern) => pattern.test(dir))

  const found = []
  const seen = new Set()
  // 同一个文件可能被两条路扫到（ollama 的 blob + 硬链接到 ~/models）。按 inode 收敛。
  const seenFile = new Map()
  let entries = 0
  let magicReads = 0
  let truncated = false
  // [dir-errors] 哪些目录没读成、为什么。面板把它显示出来 ——
  // 「目录没权限」和「目录里没有模型」看起来都是空列表，但处理方式完全不同。
  const dirErrors = []

  const add = (entry) => {
    // [dedupe-fallback] fileId 拿不到 inode（stat 失败、注入的 statId 没给、FAT/exFAT 之类）
    // 时不能直接放弃去重：同一份 GGUF 会同时从 ollama 的 blobs 和硬链接目录被扫到，
    // 列表里就出现两条一模一样的「同名同大小」条目，用户以为是两个模型。
    // 退化成「归一化路径」当键 —— 大小写与分隔符统一，Windows 上 C:\Models\a.gguf 与
    // c:/models/a.gguf 是同一个文件。
    const id = fileId(entry.path, io)
      ?? 'path:' + String(entry.path ?? '').replace(/\\/g, '/').toLowerCase()
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

  // [depth-base] level 从 0 起算（0 = 目录本身，1 = 它下面一层）。
  // 原来从 1 起算，于是 `depth: 2` 只往下走一层，LM Studio 的标准布局
  // `~/.lmstudio/models/<publisher>/<repo>/<file>.gguf` 永远扫不到 ——
  // 顶层是 models，publisher 是第 1 层、repo 是第 2 层，文件在第 3 层。
  const walk = (dir, level, limit) => {
    if (truncated || level > limit || seen.has(dir)) return
    seen.add(dir)
    let names = []
    if (typeof io.listDir === 'function') {
      // 注入进来的枚举函数（测试用）按老契约只返回数组，异常即「没这个目录」
      try {
        names = listDir(dir)
      } catch {
        return
      }
    } else {
      const listed = listDirDetailed(dir)
      names = listed.names
      if (listed.error.length > 0) dirErrors.push({ dir, error: listed.error })
      if (names.length === 0 && listed.error.length > 0) return
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
        // [shard-scan] 分片模型在目录里是 4 个文件（`x-00001-of-00004.gguf` … `x-00004-of-00004.gguf`）。
        // 全列出来，用户在面板上就会看到 4 条「同名模型」各 4GB，挑哪条都只起第一片；
        // 体积也只按 4GB 算。这里只保留第一片、体积换成全量之和 —— llama.cpp 也只吃第一片。
        const shard = shardInfo(name)
        // [P1-10-2026-11-25] 原来无条件 index > 1 就 continue：只要第一片丢了（下载中断、
        // 用户手动删了、只拷了后三片），整组在面板里一条都不出现 —— 用户看着空列表
        // 以为盘上没有模型，而磁盘上明明躺着 12GB。
        // 现在：组里还有更靠前的片就照旧跳过（由那一片代表整组）；
        // 没有更靠前的片 = 这就是现有最小的一片，让它当代表，并标 shardMissing。
        const shardScan = shard === null ? null : scanShardGroup(dir, shard, listDir)
        if (shardScan !== null && shardScan.lowest < shard.index) continue
        const shardTotal = shard === null ? 0 : totalShardBytes(full, { listDir, statSize })
        add({
          path: full,
          name,
          dir,
          sizeBytes: shardTotal > 0 ? shardTotal : sizeBytes,
          ...(shard === null ? {} : { shardCount: shard.count }),
          // 缺片要说出来：体积按现有这一片算（[P1-09] 低估比高估安全），
          // 但得让人知道这不是完整模型，否则起服务时才 OOM。
          ...(shardScan !== null && shardScan.present < shard.count ? { shardMissing: true } : {}),
          // .mmproj. 是视觉投影，单独标出来，别让人当主模型选
          mmproj: /\.mmproj\./i.test(name),
          source,
          origin: source,
          tags: [],
        })
        continue
      }
      // 目录：只在看起来像模型库的名字上继续往下走一层（ollama/manifests 是 v0.4.5 补的）
      //
      // [dir-check] 判目录不能靠 `exists(full + '/')`。Windows 上 Node 的
      // `existsSync('C:/Windows/notepad.exe/')` 返回 **true**（实测，见 test/launcher.mjs），
      // 于是每个普通文件都被当成「目录」走进去，进去 listDir 失败返回空 —— 结果是
      // 名字里带 model/hub 的真实子目录反而不会被命中判定覆盖。
      // 这里显式问「是不是目录」，注入 statIsDir 方便离线测。
      if (/^[^.]/.test(name) && level < limit) {
        const isDir = statIsDir(full)
        if (isDir === true) walk(full, level + 1, limit)
        else if (isDir === null && /model|gguf|lmstudio|hub|blobs|files|ollama|manifests|sha256/i.test(name)) {
          walk(full, level + 1, limit)
        }
      }
    }
  }

  for (const dir of dirs) {
    if (truncated) break
    if (typeof dir !== 'string' || dir.length === 0) continue
    if (!exists(dir)) continue
    walk(dir, 0, isShallow(dir) ? 0 : depth)
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
  found.dirErrors = dirErrors
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

/**
 * Windows 的可执行后缀表。读 PATHEXT（用户/安装程序会往里加 `.PY`、`.PS1` 之类），
 * 读不到才退回系统默认那一组。保持原有顺序，空串放最前面 —— 「名字里已经带后缀」
 * 这种情况要能被原样命中。
 */
function windowsExecExtensions() {
  const raw = String(process.env.PATHEXT ?? '')
  const listed = raw
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0 && item.startsWith('.'))
  const base = listed.length > 0 ? listed : ['.com', '.exe', '.bat', '.cmd']
  return ['', ...new Set(base)]
}

/** PATH 拆成目录列表。`envPathValue()` 已经处理了 Windows 的大小写与空值。 */
function pathValueToDirs() {
  const sep = WIN ? ';' : ':'
  return envPathValue().split(sep)
}

/**
 * 在 PATH 里找一个裸命令。Windows 上按 PATHEXT 补后缀。
 *
 * [P2-03-2026-11-26] 两处原来都太窄：
 *   ① 后缀写死 `['', '.exe', '.cmd', '.bat']` —— 漏掉 `.com`（`ollama.com` 少见但合法）、
 *      `.ps1`，也漏掉用户自己往 PATHEXT 里加的后缀；系统是怎么解析的，就该照它来。
 *   ② 只看 PATH，不试 cwd —— 而 Windows 的 `CreateProcess` 会搜当前目录，
 *      于是「把 llama-server.exe 放在当前目录、命令行写裸名」这种最常见的本地玩法反而找不到。
 *      cwd 排在 PATH **之后**：PATH 是用户显式配的，优先级该更高；这里只是补上「都没找到再试一次」。
 */
export function whichOnPath(name, exists = safeExists) {
  const extensions = WIN ? windowsExecExtensions() : ['']
  const dirs = pathValueToDirs()
  // POSIX 里 PATH 的空项本身就是「当前目录」，Windows 没有这个约定，补在末尾。
  if (WIN && !dirs.includes('.')) dirs.push('.')
  for (const dir of dirs) {
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
  if (quoted) {
    // [unclosed-quote] 未闭合的引号原来是静默吞掉后面所有字符：`llama-server "D:\models\a.gguf`
    // 会变成 ['llama-server', 'D:\models\a.gguf'] 看起来正常，但 `-m "a b` 这种
    // 会把参数和值粘成一段，最后 spawn 出来的进程行为完全不对，用户还以为命令写对了。
    // 抛出去让 planLaunch 变成一条能读的报错，别让半条命令一路走到 spawn。
    throw new Error('启动命令里的引号没闭合：' + text)
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
 *
 * [spawn-async] 必须是 async，且必须吃掉 child 的 'error' 事件。
 *
 * 原来这里是同步 try/catch + `child.unref()`。但 spawn 的失败（ENOENT / EACCES /
 * EINVAL）不是同步抛的 —— Node 在下一个 tick 通过 'error' 事件抛。同步 catch 永远
 * 抓不到，函数照样返回 {ok:true, pid:0}，然后那个没人监听的 'error' 事件变成
 * uncaughtException，**直接打死 DSH 宿主**（本机实测：命令写错一个字母就整个宿主退出，
 * 且日志里只有一句 ENOENT，看不出是哪个插件干的）。
 *
 * 这里改成等 'spawn' 或 'error' 之一，忽略 'error' 之后的 unref，并把错误交给调用方。
 */
export async function runDetached(input) {
  const spawnImpl = typeof input.spawnImpl === 'function' ? input.spawnImpl : nodeSpawn
  // [cmd-shell] whichOnPath 在 Windows 上可能返回 .cmd / .bat（很多工具只发这两种包装），
  // 而 Node 的 spawn 不走 shell 时只认 PE 可执行文件 —— 直接 spawn 一个 .cmd 会
  // EINVAL，用户看到的是「起进程失败：spawn EINVAL」，完全联想不到是扩展名的问题。
  // 只有这两种扩展名才开 shell；.exe 一律不开，免得白白多一层 cmd.exe 影响
  // detached 与 pid（开了 shell 时 child.pid 是 cmd.exe 的 pid，杀树要走 taskkill 才连得上）。
  const commandText = String(input.command ?? '')
  // [test-seam] 同 stopProcess：Windows 才走的分支在 Linux CI 上永远跑不到，
  // 没有注入口就只能靠真机手测 —— 那正是「.cmd 假成功」一路活到发版的原因。
  const platform = typeof input.platform === 'string' && input.platform.length > 0 ? input.platform : process.platform
  const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(commandText)
  // [L3-2026-11-26] 走 shell 时真正被 spawn 的是 cmd.exe：脚本本体不存在，cmd.exe
  // 也照样起得来（它打印一句「不是内部或外部命令」就退出），于是 runDetached 报
  // 「已启动 pid 1234」，面板显示在跑，之后 waitForEndpoint 一直连不上，日志里什么
  // 都没有 —— 用户完全看不出是路径的问题。进 shell 之前先确认脚本真的在。
  const existsImpl = typeof input.exists === 'function' ? input.exists : safeExists
  if (needsShell && !existsImpl(commandText)) {
    return {
      ok: false,
      error: '要启动的脚本不存在：' + commandText + '（多半是它被卸载、挪了位置，或者是个只留了包装名的 shim）',
    }
  }
  // [P0-A-2026-11-25] shell:true 时 Node 只把 [command, ...args] 用空格拼起来交给
  // `cmd.exe /d /s /c`，**一个字符都不转义**：参数里出现 & | < > ^ % ! 就变成 cmd 语法，
  // 能把任意命令接在 llama-server 后面执行。文件名来自下载的 gguf、alias 来自面板输入，
  // 都是不可信内容。这里不尝试转义 —— cmd 没有能表达引号的转义序列，转义的边界情况
  // 比重写整条命令行更难测 —— 直接拒绝启动，并把是哪个参数报出来。
  const SHELL_UNSAFE = /[&|<>^%!"\r\n]/
  if (needsShell) {
    const unsafe = [commandText, ...(input.args ?? [])].find((value) => SHELL_UNSAFE.test(String(value ?? '')))
    if (unsafe !== undefined) {
      return {
        ok: false,
        error:
          '拒绝用 shell 启动：参数里含 cmd 元字符（& | < > ^ % ! " 或换行），' +
          'cmd.exe 会把它当成命令分隔符去执行 —— ' + String(unsafe),
      }
    }
  }
  // shell 模式下 Node 只是把 [command, ...args] 用空格拼起来交给 cmd.exe，
  // 带空格的参数得自己加引号，否则 `--model D:\my models\a.gguf` 会被拆成两个。
  // [P1-01-2026-11-25] command 也要走同一条引号路径：`C:\Program Files\x\a.cmd`
  // 不加引号时 cmd 只会去找 `C:\Program`，而 spawn 照样返回 cmd.exe 的 pid 被当成功。
  const quoteForShell = (value) => {
    const text = String(value ?? '')
    return text.length === 0 || /[\s"]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
  }
  const spawnArgs = needsShell ? (input.args ?? []).map(quoteForShell) : input.args ?? []
  const spawnCommand = needsShell ? quoteForShell(commandText) : input.command
  return await new Promise((resolve) => {
    let child
    const done = (value) => resolve(value)
    try {
      child = spawnImpl(spawnCommand, spawnArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: input.cwd,
        env: mergeEnv(process.env, input.env),
        ...(needsShell ? { shell: true } : {}),
      })
    } catch (error) {
      // 参数类型错误之类的同步抛出。
      done({ ok: false, error: String(error?.message ?? error) })
      return
    }
    if (child === null || typeof child !== 'object') {
      done({ ok: false, error: 'spawn 没有返回子进程对象' })
      return
    }
    // 先挂 error 监听，再解绑 —— 顺序反了会在两者之间漏掉事件。
    // 这个监听在 spawn 成功后也要留着：常驻进程后来崩了也不该打死宿主。
    child.once?.('error', (error) => {
      done({ ok: false, error: String(error?.message ?? error) })
    })
    child.once?.('spawn', () => {
      if (typeof child.unref === 'function') child.unref()
      done({ ok: true, pid: Number(child.pid) || 0 })
    })
    // 有些 spawn 实现（老版本 / mock）不发 'spawn' 事件：下一个 tick 直接按 pid 判。
    // [L3-2026-11-26] 这条兜底在 shell 模式下等于绕过判断：pid 是 cmd.exe 的 pid，
    // cmd.exe 起得来不代表脚本跑得起来。shell 模式只认 'spawn' / 'error' / 兜底计时器。
    if (!needsShell) {
      setImmediate(() => {
        const pid = Number(child?.pid) || 0
        if (pid > 0) {
          if (typeof child.unref === 'function') child.unref()
          done({ ok: true, pid })
        }
      })
    }
    // 兜底：既没 'spawn' 也没 'error'、pid 也拿不到时不能永远挂着。
    const guard = setTimeout(() => done({ ok: false, error: 'spawn 之后 2000ms 内既没 ready 也没报错' }), 2_000)
    if (typeof guard?.unref === 'function') guard.unref()
  })
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
 * @param {{sizeBytes?: number, kvBytes?: number, totalMemBytes?: number, freeMemBytes?: number,
 *   gpuBytes?: number, reserveBytes?: number, loadMode?: string}} input
 *   `sizeBytes` 是权重总量（分片模型要传 `totalShardBytes` 的和），`kvBytes` 是
 *   `estimateKvBytes` 算出的 KV cache —— 两者相加才是真正要占的内存。
 */
// ---------------------------------------------------------------------------
// GGUF 分片与 KV cache
// ---------------------------------------------------------------------------

/** `model-00002-of-00004.gguf` 这种分片名。llama.cpp 只吃第一片，体积却是全部之和。 */
const SHARD_PATTERN = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i

/**
 * 从文件名里认出分片：`{ base, index, count }`，不是分片回 null。
 *
 * 为什么需要它：`checkModelFit` 只看主分片那一个文件的 size，于是
 * 4 片各 4GB 的 16GB 模型被当成 4GB，预检一路绿灯，起来之后才发现装不下。
 */
export function shardInfo(name) {
  const match = SHARD_PATTERN.exec(String(name ?? ''))
  if (match === null) return null
  const index = Number(match[2])
  const count = Number(match[3])
  if (!Number.isFinite(index) || !Number.isFinite(count) || count < 2 || index < 1 || index > count) return null
  return { base: match[1], index, count }
}

/**
 * 同目录里这一组分片现在有哪些（[P1-10-2026-11-25]）。
 * 面板要知道「现有最小的是第几片」「总共到了几片」—— 否则第一片丢了整组就消失。
 * 返回 { lowest, present }：lowest = 现有最小 index（一片都没列出时回 count + 1），
 * present = 现有片数。目录读不成时按「只看到手上这一片」算，不假装完整。
 */
function scanShardGroup(dir, shard, listDir) {
  const read = typeof listDir === 'function' ? listDir : safeListDir
  let lowest = shard.count + 1
  let present = 0
  let names = []
  try {
    names = read(dir)
  } catch {
    names = []
  }
  for (const item of names) {
    const other = shardInfo(item)
    if (other === null || other.base !== shard.base || other.count !== shard.count) continue
    present += 1
    if (other.index < lowest) lowest = other.index
  }
  return { lowest, present }
}

/**
 * 一个 gguf 连同它的分片一共多少字节。不是分片就退化成它自己的大小。
 *
 * `io.listDir` / `io.statSize` 可注入（离线测试）。
 */
export function totalShardBytes(path, io = {}) {
  const statSize = typeof io.statSize === 'function' ? io.statSize : safeSize
  const listDir = typeof io.listDir === 'function' ? io.listDir : safeListDir
  const slash = String(path ?? '').replace(/\\/g, '/')
  const cut = slash.lastIndexOf('/')
  const dir = cut >= 0 ? slash.slice(0, cut) : ''
  const name = cut >= 0 ? slash.slice(cut + 1) : slash
  const own = Number(statSize(path)) || 0
  const shard = shardInfo(name)
  if (shard === null) return own
  let total = 0
  let seen = 0
  for (const item of listDir(dir)) {
    const other = shardInfo(item)
    if (other === null || other.base !== shard.base || other.count !== shard.count) continue
    total += Number(statSize(dir.length > 0 ? dir + '/' + item : item)) || 0
    seen += 1
  }
  // [P1-09-2026-11-25] 只有 1..count 全都在才算「全量」，否则退回主分片自己的大小。
  // 原来 seen > 0 就返回 total：手上只有 00002 那一片时，面板显示 4GB，
  // 用户以为模型是 4GB —— 真起服务才 OOM，或者下载中断留下的残片被当成完整模型选走。
  // 低估（只报这一片）会让人去查目录，高估（报全量）会让人以为装得下，前者安全。
  return seen === shard.count ? total : own
}

// [P1-05-2026-11-25] KV cache 的量化类型 → 每元素字节数。
// 数字来自 llama.cpp 的 block 布局：q8_0 每 32 个元素存 32 字节 + 1 个 fp16 scale（2 字节）= 34/32。
// 只收 KV cache 真支持的那几种（--cache-type-k/v 的取值）；认不出的类型按 f16 算并让调用方看见。
const KV_CACHE_BYTES = new Map([
  ['f16', 2],
  ['fp16', 2],
  ['bf16', 2],
  ['f32', 4],
  ['fp32', 4],
  ['q8_0', 34 / 32],
  ['q8_1', 36 / 32],
  ['q5_1', 24 / 32],
  ['q5_0', 22 / 32],
  ['q4_1', 20 / 32],
  ['q4_0', 18 / 32],
  ['iq4_nl', 18 / 32],
])

function kvBytesForType(value) {
  if (typeof value !== 'string') return null
  const bytes = KV_CACHE_BYTES.get(value.trim().toLowerCase())
  return bytes === undefined ? null : bytes
}

/**
 * K 与 V 各占一份存储，所以「每元素字节」在这里是 (K + V) / 2 的平均值 ——
 * estimateKvBytes 的公式里那个 2 就是 K、V 两份，乘回去刚好是 K + V。
 *
 * [D3-2026-11-26] 所以「取平均是错的」这个怀疑不成立：两侧同类型时 avg×2 = 2×单侧，
 * 两侧不同类型时 avg×2 = K + V，都对。**真正错的是缺一侧的时候**：那时用已知那侧
 * 乘 2，等于假设另一侧跟它同类型。K 给了 q8_0、V 没给（引擎默认 f16）时会低估。
 * 现在缺的那侧按 f16（2 字节）补齐再取平均。
 */
function resolveBytesPerElement(input) {
  const explicit = Number(input.bytesPerElement)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const fromK = kvBytesForType(input.cacheTypeK)
  const fromV = kvBytesForType(input.cacheTypeV)
  if (fromK === null && fromV === null) return 2
  return ((fromK ?? 2) + (fromV ?? 2)) / 2
}

/**
 * KV cache 要占多少字节。
 *
 * llama.cpp 的公式（每个 token、每层、K 与 V 各一份）：
 *   `2 * block_count * context * (embedding_length / head_count * head_count_kv) * 每元素字节`
 * 每元素字节默认按 f16（2 字节）。没给全维度就回 0 —— 宁可少算，也不拿猜的数把用户吓退。
 *
 * [P1-05-2026-11-25] 但 llamaCppAutoArgs 给现代引擎默认下的是 `--cache-type-k/v q8_0`，
 * 实际只有 ≈1.0625 字节/元素（32 个 q8_0 block = 34 字节 / 32 元素），按 f16 算会高估 1.88×。
 * 所以除了 bytesPerElement，还认 cacheTypeK / cacheTypeV：调用方知道引擎下什么类型就传什么，
 * 不知道就保持缺省（仍按 f16 算，宁可高估也不低估 —— 低估会让用户在起服务时才 OOM）。
 *
 * 为什么值得算：默认 `-c 65536` 下，8B 级模型的 KV cache 常见 4–8GB，
 * 27B MoE 能到 10GB+；只比文件大小的预检会把这部分完全漏掉。
 */
export function estimateKvBytes(input = {}) {
  const blockCount = Number(input.blockCount)
  const embeddingLength = Number(input.embeddingLength)
  const headCount = Number(input.headCount)
  const contextTokens = Number(input.contextTokens)
  const bytesPerElement = resolveBytesPerElement(input)
  if (![blockCount, embeddingLength, headCount, contextTokens].every((n) => Number.isFinite(n) && n > 0)) return 0
  const kvHeads = Number(input.headCountKv) > 0 ? Number(input.headCountKv) : headCount
  // head_dim 由 hidden / head_count 得到；GQA 下再乘 KV 头数就是每层 K（或 V）的宽度
  const kvWidth = (embeddingLength / headCount) * kvHeads
  if (!Number.isFinite(kvWidth) || kvWidth <= 0) return 0
  return Math.round(2 * blockCount * contextTokens * kvWidth * bytesPerElement)
}

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
    input.reserveBytes !== null && input.reserveBytes !== undefined && Number.isFinite(reserveInput) && reserveInput >= 0
      ? reserveInput
      : 2048 * 1024 * 1024
  const gib = (bytes) => Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10
  // [kv-bytes] KV cache 是独立于权重的一块内存，随上下文长度线性长。
  // 默认 -c 65536 下它常有权重的 10%–30%，只比文件大小的预检会把它整个漏掉。
  // 调用方拿不到维度（老 gguf、ollama 那条走 json）时传 0，这里就等同于没有这一项。
  const kvBytes = Number(input.kvBytes) > 0 ? Number(input.kvBytes) : 0
  // 分片模型的主分片只有一个片的大小；调用方用 totalShardBytes 传全量进来。
  const footprint = sizeBytes + kvBytes
  const sizeGib = gib(footprint)
  const kvGib = gib(kvBytes)
  // 面板上要多说一句「其中 KV 几 GB」，否则用户看到 4GB 的模型被判「要 12GB 内存」会以为算错了
  const kvNote = kvBytes > 0 ? `（含 KV cache ${kvGib}GB）` : ''

  // 显存装得下的部分不占系统内存。装不下的那部分才是宿主要接的量。
  const hostBytes = unified ? footprint : Math.max(footprint - gpuBytes, 0)
  const hostGib = gib(hostBytes)
  // [budget-cap] 预算的绝对上限是「整机内存 - 预留」，不能被「此刻恰好空」突破。
  //
  // 原来写的是 `Math.max(totalMemBytes - reserveBytes, freeMemBytes, 0)`：freeMem 比
  // total-reserve 大时（reserve 调大、或 total 探测失败而 free 拿到了）就用 freeMem，
  // 预算能超过整机物理内存。
  //
  // [P1-03-2026-11-25] 这里原来分两步：cap = total>0 ? max(total-reserve,0) : 0，
  // 然后 capacity = cap>0 ? cap : freeMem。reserve 被配得比 total 还大时 cap 正好被钳成 0，
  // 于是「预留吃掉全部内存」这个结论被 freeMem 顶掉，后面那条 budget===0 的 risky 分支
  // 永远进不去 —— 兜底条件写成了主条件。现在一步算完：有 total 就只认 total-reserve。
  const capacity =
    totalMemBytes > 0 ? Math.max(totalMemBytes - reserveBytes, 0) : freeMemBytes > 0 ? freeMemBytes : 0
  // 匿名内存模式：不走 mmap，就等于要求 hostBytes 真驻留 RAM。
  //
  // [P1-04-2026-11-25] 原来是 `=== 'none' || === 'mlock'` 的精确匹配，漏掉
  // 'mmap+mlock'（面板 loadMode 下拉里真实存在的一档）—— 那一档锁页同样要求真驻留，
  // 却被当成 mmap 走宽松口径，预检给出「内存够用」。
  const loadMode = typeof input.loadMode === 'string' ? input.loadMode : ''
  const anonymous = loadMode === 'none' || loadMode.includes('mlock')
  // [budget-free] 只有「真吃 RAM」的模式才该受「此刻空多少」约束。
  //
  // 走 mmap 时模型落在 file-backed page cache，可回收 —— 这台机器实测
  // available 只剩 1.2GB 也能跑 15.8GB 的 MoE（热权重在显存里，冷专家按需换入）。
  // 拿 freeMem 卡 mmap 会把正常配置全判成 warn，那是另一种误判。
  // 匿名 / mlock 才是必须真占住：这时 freeMem 才是硬约束。
  const budget = anonymous && freeMemBytes > 0 ? Math.min(capacity, freeMemBytes) : capacity
  const ratio = budget > 0 ? hostBytes / budget : 0
  const rounded = Math.round(ratio * 100) / 100
  const base = { sizeBytes, kvBytes, footprint, totalMemBytes, freeMemBytes, gpuBytes, unified, hostBytes, ratio: rounded }
  // 统一内存时 totalMemBytes 已经是那一整个池子，再加 gpuBytes 会重复计数。
  const ceiling = unified ? totalMemBytes : totalMemBytes + gpuBytes

  // [budget-unknown] 两个内存数字都拿不到时不能判 ok。
  //
  // 原来 budget=0 → ratio=0，一路落到最后一个 return 的 level:'ok'
  // （label 还会写「内存够用」）。这是「拿不到信息」被当成「没有风险」的典型：
  // 内存探测失败的机器上，预检永远绿灯。
  if (budget === 0 && totalMemBytes === 0 && freeMemBytes === 0) {
    return { ...base, level: 'unknown', label: `模型 ${sizeGib}GB，但拿不到本机内存信息，预检跳过（不做判断）` }
  }
  // 有总量但预算被预留吃光：明确说清是预留太大，而不是「够用」。
  if (budget === 0) {
    return {
      ...base,
      level: 'risky',
      label: `预留 ${gib(reserveBytes)}GB 已经吃掉全部可用内存（总 ${gib(totalMemBytes)}GB），把 reserveMb 调小`,
    }
  }

  // 硬拦：显存 + 内存都塞不下。这时候不是快慢问题，是必然加载失败。
  if (totalMemBytes > 0 && footprint > ceiling) {
    return {
      ...base,
      level: 'risky',
      label:
        `模型 ${sizeGib}GB${kvNote}，${unified ? '统一内存' : '显存 ' + gib(gpuBytes) + 'GB + 内存'} ` +
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
        `模型 ${sizeGib}GB${kvNote}，显存外的 ${hostGib}GB 超过内存预算 ${gib(budget)}GB。` +
        'mmap 会让它照跑，只是开头一段明显慢（专家要按需从盘里换进来）',
    }
  }
  if (ratio >= 0.5) {
    return {
      ...base,
      level: 'ok',
      label: unified
        ? `模型 ${sizeGib}GB 落在统一内存 ${gib(totalMemBytes)}GB 里，加载时会顿一下，之后正常`
        : `模型 ${sizeGib}GB${kvNote}（显存外 ${hostGib}GB），加载时会顿一下，之后正常`,
    }
  }
  return {
    ...base,
    level: 'ok',
    label: unified
      ? `模型 ${sizeGib}GB，统一内存 ${gib(totalMemBytes)}GB 够用`
      : `模型 ${sizeGib}GB${kvNote}，显存 ${gib(gpuBytes)}GB 挑大梁，内存够用`,
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
  // [multi-gpu] 多卡要相加，不能只取第一张。
  // llama.cpp 的 `-ts` / vLLM 的 tensor-parallel 会把模型摊到所有卡上，可用显存是总和；
  // 原来 take-first 让「2×24GB」被当成 24GB，一个 30GB 的模型被判「装不下」。
  let nvidiaMiB = 0
  for (const line of lines(run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']))) {
    const mib = Number(line)
    if (Number.isFinite(mib) && mib > 0) nvidiaMiB += mib
  }
  if (nvidiaMiB > 0) return { bytes: Math.round(nvidiaMiB * 1024 * 1024), vendor: 'nvidia', unified: false }

  // 2) AMD ROCm。带单位的先试 —— 否则 "VRAM Total Memory (B): 24.0 GiB"
  // 会被纯数字那条抢先匹配成 24 字节。
  const rocm = run('rocm-smi', ['--showmeminfo', 'vram'])
  // [P1-08-2026-11-25] 多卡要相加，跟上面 NVIDIA 分支同一个道理（[multi-gpu]）。
  // 原来是 .match() 只取第一张：双卡 24G+24G 被当成 24G，30G 的模型被判「装不下」。
  // 用 matchAll 把每一张卡的 VRAM 都累加；只有一张卡时结果与旧行为一致。
  const rocmUnitPattern = /VRAM Total Memory \(B(?:ytes)?\):\s*([\d.]+)\s*(GiB|MiB|GB|MB)/gi
  let amdBytes = 0
  for (const hit of rocm.matchAll(rocmUnitPattern)) {
    const value = Number(hit[1])
    const unit = String(hit[2]).toLowerCase()
    const scale = unit === 'gib' ? 1024 ** 3 : unit === 'mib' ? 1024 ** 2 : unit === 'gb' ? 1000 ** 3 : 1000 ** 2
    if (Number.isFinite(value) && value > 0) amdBytes += Math.round(value * scale)
  }
  if (amdBytes > 0) return { bytes: amdBytes, vendor: 'amd', unified: false }
  const rocmBytePattern = /VRAM Total Memory \(B\):\s*(\d+)\s*$/gm
  for (const hit of rocm.matchAll(rocmBytePattern)) {
    const bytes = Number(hit[1])
    if (Number.isFinite(bytes) && bytes > 0) amdBytes += bytes
  }
  if (amdBytes > 0) return { bytes: amdBytes, vendor: 'amd', unified: false }

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
 * Windows 的 pid 核对只能比映像名：期望值是启动命令（可能是完整路径、可能不带 .exe），
 * 实际值是 tasklist 给的映像名（llama-server.exe）。比最后一段、忽略大小写、
 * 补不补 .exe 都算同一个。
 *
 * [L12-2026-11-26] 只认「像不像同一个可执行文件」，不认「是不是同一次启动」—— 两个
 * 同名的 llama-server 仍会互相认成自己。这是 Windows 上不提权能拿到的上限；比起原来
 * 完全不核，它挡住的是「pid 被复用一个完全不相干的进程」这类真事故。
 */
function sameImageName(expected, actual) {
  const tail = (value) =>
    String(value ?? '')
      .trim()
      .replace(/^"+|"+$/g, '')
      .split(/[\\/]/)
      .pop()
      .toLowerCase()
  const wantRaw = tail(expected)
  const gotRaw = tail(actual)
  const bare = (value) => value.replace(/\.exe$/, '')
  const want = bare(wantRaw)
  const got = bare(gotRaw)
  if (want.length === 0 || got.length === 0) return true
  if (want === got) return true
  // [L12b-2026-11-26] .cmd / .bat 走的是 shell:true（见 runDetached 的 needsShell），
  // 真正被 spawn 的是 cmd.exe，pid 也是 cmd.exe 的 —— 拿它跟「pnpm.cmd」比必然不等，
  // 于是每次「停止」都报「pid 被复用了，不动它」，后端根本杀不掉。
  // 这里把 cmd.exe 认成「可能是任何 .cmd/.bat 的包装器」：精度仍是「像不像」这一档，
  // 但至少 .cmd 用户能停下自己的后端；映像名对不上的（chrome.exe 之类）照旧拦。
  return /\.(cmd|bat)$/.test(wantRaw) && (gotRaw === 'cmd' || gotRaw === 'cmd.exe')
}

/**
 * 读一个进程的「身份」用于 pid 复用核对。读不到回 null（调用方据此跳过核对）。
 *
 * Linux 走 /proc/<pid>/cmdline（完整命令行），macOS 走 ps -o command=（完整命令行），
 * Windows 走 tasklist 的 CSV 输出 —— 只能拿到映像名（可执行文件名），但**不需要管理员
 * 权限**：读别人的完整命令行才需要提权，读映像名不需要。
 *
 * [L12-2026-11-26] 原来 Windows 直接 return null，于是 stopProcess 的核对在 Windows 上
 * 恒被跳过：面板起了 pid 1234，进程自己崩了，系统把 1234 分给用户的构建任务，此时点
 * 「停止」会 taskkill /T /F 整棵树 —— 这是这个插件里唯一有破坏性的缺陷。映像名虽然不如
 * 命令行精确，但足以挡住「完全不相干的进程」这一类，比什么都不核强得多。
 */
async function readProcessCommand(pid, input = {}, platform = process.platform) {
  if (typeof input.readCommand === 'function') {
    try {
      return String(input.readCommand(pid) ?? '')
    } catch {
      return null
    }
  }
  const run = typeof input.execFileSync === 'function' ? input.execFileSync : nodeExecFileSync
  try {
    if (platform === 'linux') {
      const raw = fsReadFileSync(`/proc/${pid}/cmdline`)
      return raw.toString('utf8').split(String.fromCharCode(0)).filter((part) => part.length > 0).join(' ')
    }
    if (platform === 'darwin') {
      return String(run('ps', ['-p', String(pid), '-o', 'command=']) ?? '').trim()
    }
    if (platform === 'win32') {
      // CSV 格式：第一列是映像名，带引号；进程不存在时输出的是「信息: 没有…」那行，不匹配。
      const raw = String(
        run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 4000, windowsHide: true }) ?? '',
      )
      const line = raw.split(/\r?\n/).find((row) => row.trim().startsWith('"'))
      if (line === undefined) return null
      const name = line.split('","')[0].replace(/^"/, '').trim()
      return name.length > 0 ? name : null
    }
  } catch {
    return null
  }
  return null
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
  // [P1-13-2026-11-25] 先转数字再判：Number.isFinite('1500') 是 false，
  // 从 query/JSON 传进来的字符串会被静默换成默认 1500，用户填的等待时间根本不生效；
  // 负数/0 同样没意义（等 0 毫秒等于不等），一并回落到默认。
  const rawWaitMs = Number(input.waitMs)
  const waitMs = Number.isFinite(rawWaitMs) && rawWaitMs > 0 ? rawWaitMs : 1500

  if (!alive(pid)) return { ok: true, pid, already: true, signal: 'none', ms: 0 }

  const startedAt = Date.now()
  // 成功回 undefined、失败回字符串 —— 用 undefined 而不是 ''，
  // 才能把「没发过信号」和「发了并且成功」分开（[P1-11-2026-11-25]）。
  const send = (signal) => {
    try {
      kill(pid, signal)
      return undefined
    } catch (error) {
      if (error?.code === 'ESRCH') return undefined
      return String(error?.message ?? error)
    }
  }

  // [kill-tree] 必须整棵树杀。
  //
  // runDetached 用的是 detached:true，于是子进程自成 process group。Windows 上
  // `pnpm exec llama-server` / `.cmd` 包装器会再拉一层真实进程；POSIX 上 shell
  // 包装同理。原来只对单个 pid 发信号，父进程死了、孙进程还在，8090 端口继续
  // 被占着 —— 面板显示「已停止」，下次拉起却报 already，用户只能去任务管理器。
  //
  // Windows：taskkill /T /F 直接按进程树杀（Node 没有等价 API）。
  // POSIX：杀整个进程组 → `kill(-pid, sig)`；进程组不存在时退回单 pid。
  // 注入了 kill 的调用方（离线单测 / 外部进程模型）自己掌管进程语义：
  // 那边没有真实进程树可以 taskkill，硬走 taskkill 只会去杀一个碰巧同号的进程。
  // [test-seam] 平台判定也走注入：Windows 的 taskkill 分支在 CI 的 Linux runner 上
  // 根本走不到，没有注入口就只能靠真机手测 —— 这正是一个 P0（停不掉后端）能活到
  // 发版的原因。CI 里伪造 win32 + 注入 execFileImpl，就能把整条 taskkill 路径跑一遍。
  const platform =
    typeof input.platform === 'string' && input.platform.length > 0 ? input.platform : process.platform
  const injected = typeof input.kill === 'function'
  const execFileImpl =
    typeof input.execFileImpl === 'function'
      ? input.execFileImpl
      : !injected && platform === 'win32'
        ? execFile
        : undefined

  // 返回值约定（[P1-11-2026-11-25]）：成功 = undefined，失败 = 原因字符串。
  // 原来无论 taskkill 成功失败都 return ''，调用方 `if (first.length > 0)` 永远不成立 ——
  // 权限不足杀不掉时它照样往下走，白等满 waitMs 才补 SIGKILL，最后才报「还在」，
  // 中间那 1.5 秒的等待和「SIGTERM 没成功」这个事实全被吞掉了。
  const killTree = async (signal) => {
    if (platform === 'win32' && execFileImpl !== undefined) {
      // [L1-2026-11-26] Windows 上没有「先礼」的那一半：不带 /F 的 taskkill 对
      // 自成进程组的 console 子进程会直接失败（本机 win-arm64 实测 exit 255，
      // stderr「只能强制终止此进程(带 /F 选项)」），于是第一轮必然报错、后端不停。
      // 这里一律带 /F。「先等 waitMs 再补一刀」的礼留在调用层（先发→等→再发）。
      const args = ['/PID', String(pid), '/T', '/F']
      return await new Promise((done) => {
        const finish = (error, stdout, stderr) => {
          if (error === null || error === undefined) return done(undefined)
          // [L2-2026-11-26] taskkill 的输出走系统代码页（中文 Windows 是 GBK），
          // Node 按 UTF-8 解码会把整段中文压成 U+FFFD —— 原来那条
          // /没有找到|找不到/ 在中文 Windows 上一次都没命中过，「进程已经没了」
          // 于是被当成失败。文本不可信时改用退出码：128 = 没有这个进程（本机
          // win-arm64 实测），0/255/1 之外的语义都算真失败。
          const code = Number(error?.code)
          const detail = String(stderr ?? '').trim() || String(stdout ?? '').trim() || String(error?.message ?? error)
          if (/not found|没有找到|找不到|no running instance/i.test(detail)) return done(undefined)
          if (code === 128) return done(undefined)
          const reason = /�/.test(detail)
            ? `taskkill 退出码 ${Number.isFinite(code) ? code : '未知'}（系统输出不是 UTF-8，无法显示原文）`
            : detail
          done(reason)
        }
        try {
          execFileImpl('taskkill', args, { windowsHide: true }, finish)
        } catch (error) {
          done(String(error?.message ?? error))
        }
      })
    }
    if (platform !== 'win32') {
      try {
        kill(-pid, signal)
        return undefined
      } catch (error) {
        if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') return String(error?.message ?? error)
        // 不是进程组长（或者权限不够杀组）：退回单 pid。
        return send(signal)
      }
    }
    return send(signal)
  }

  // [pid-identity] 杀之前先确认这个 pid 还是我们起的那个进程。
  //
  // pid 会被复用：面板起了 pid 1234，用户手动停掉（或它自己崩了），过一会儿系统把
  // 1234 分给了别的进程。这时点「停止」就会去杀一个无关进程 —— 运气好是 EPERM，
  // 运气不好把用户的构建任务杀了。调用方可以把启动命令传进来，这里做一次核对。
  //
  // [L12-2026-11-26] Windows 以前整段跳过：读别人的完整命令行要管理员权限，所以干脆
  // 不核。代价是这台机器上唯一有破坏性的路径无人看守 —— pid 复用后 taskkill /T /F 会把
  // 无关进程整棵树干掉。现在 Windows 改读 tasklist 的映像名（不需要提权）：精度不如
  // 命令行，但足以挡住「完全不相干的进程」。命令行为空 / 读不到时仍然跳过（宁可不核，
  // 也不能因为读不到就把正常停止拦下来）。
  const expected = String(input.expectedCommand ?? '').trim()
  if (expected.length > 0) {
    const actual = await readProcessCommand(pid, input, platform)
    if (actual !== null && actual.length > 0) {
      const mismatch =
        platform === 'win32'
          ? !sameImageName(expected, actual)
          : !actual.includes(expected)
      if (mismatch) {
        return {
          ok: false,
          pid,
          error: `pid ${pid} 现在跑的是「${actual.slice(0, 120)}」，不是本插件起的「${expected}」；pid 被复用了，不动它`,
        }
      }
    }
  }

  // [L1-2026-11-26] 第一刀失败不是终点。
  //
  // 原来这里 `if (first) return`，后面的 SIGKILL 永远走不到。Windows 上不带 /F 的
  // taskkill 对 console 子进程必然失败，于是「SIGTERM 失败」直接变成终态：后端一直
  // 活着，面板报个错，用户只能开任务管理器手动 taskkill /F。现在把失败原因记下来，
  // 照样等、照样补 SIGKILL；真没杀掉时再把第一刀的原因一并报出来，别让用户只看到
  // 「SIGKILL 还在」而不知道前因。
  const first = await killTree('SIGTERM')
  const firstError = typeof first === 'string' && first.length > 0 ? first : ''
  const firstNote = firstError.length > 0 ? '；SIGTERM 阶段也失败过：' + firstError : ''

  const step = 150
  for (let waited = 0; waited < waitMs; waited += step) {
    await sleep(step)
    if (!alive(pid)) {
      return {
        ok: true,
        pid,
        signal: 'SIGTERM',
        ms: Date.now() - startedAt,
        ...(firstError.length > 0 ? { warn: 'SIGTERM 报了失败，但进程已经退出：' + firstError } : {}),
      }
    }
  }

  const second = await killTree('SIGKILL')
  if (typeof second === 'string' && second.length > 0) {
    return { ok: false, pid, error: 'SIGKILL 失败：' + second + firstNote }
  }
  await sleep(step)
  if (alive(pid)) return { ok: false, pid, error: 'pid ' + pid + ' 发了 SIGKILL 还在' + firstNote }
  return { ok: true, pid, signal: 'SIGKILL', ms: Date.now() - startedAt, ...(firstError.length > 0 ? { warn: firstNote } : {}) }
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

  // [deadline] 必须是一个真正的时间上限。
  //
  // 原来 `while (now() - startedAt < timeoutMs) { await probe(); await sleep(interval) }`：
  // probe 自己没超时、或者请求挂在网络上，循环就永远不回来 —— 面板转圈，用户只能刷新。
  // 而且超时后还要白等一个完整 interval（实测 timeoutMs:2000 耗了 3008ms）。
  // 现在：每次 probe 与剩余时间赛跑，时间到就当它失败。
  // 首参可以是 thunk 也可以是现成 promise：thunk 里的同步抛会在这里被接住（[P1-07-2026-11-25]）。
  const raceWithDeadline = async (work, ms) => {
    if (!(ms > 0)) return { ok: false, error: 'timeout' }
    let timer = null
    const guard = new Promise((done) => {
      timer = setTimeout(() => done({ ok: false, error: 'timeout' }), ms)
      if (typeof timer?.unref === 'function') timer.unref()
    })
    const started = typeof work === 'function' ? Promise.resolve().then(work) : Promise.resolve(work)
    try {
      return await Promise.race([started.catch((error) => ({ ok: false, error: String(error?.message ?? error) })), guard])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  while (true) {
    const left = timeoutMs - (now() - startedAt)
    if (left <= 0) break
    attempts += 1
    // [P1-07-2026-11-25] probe() 必须在 try 里求值。原来写成 raceWithDeadline(input.probe(), left)，
    // 实参先于函数体求值 —— probe 同步抛（注入的探针、或者里面某个 URL 解析炸了）就直接冲出
    // while 循环，调用方拿到的是 rejected promise：launchPanel 的 ready 失败分支被跳过，
    // 刚拉起来的 llama-server 没人回收，launched 表里也没记录。
    const result = await raceWithDeadline(() => input.probe(), left)
    if (result?.ok === true) {
      return { ok: true, ms: now() - startedAt, attempts, models: result.models ?? [] }
    }
    lastError = result?.error === 'timeout' ? `单次探测超过剩余 ${Math.round(left)}ms` : String(result?.error ?? '连不上')
    const after = timeoutMs - (now() - startedAt)
    if (after <= 0) break
    // 只剩不到一个间隔就别再睡了，直接进入下一轮（那里 left<=0 会退出）。
    await sleep(Math.min(intervalMs, after))
  }
  return {
    ok: false,
    ms: now() - startedAt,
    attempts,
    error: `等了 ${Math.round(timeoutMs / 1000)} 秒还没起来（最后一次：${lastError || '一次都没探'}）`,
  }
}
