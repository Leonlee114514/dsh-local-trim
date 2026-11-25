/**
 * dsh-local-trim — 给小本地模型一套轻量 harness。
 *
 * 云端 provider 完全不受影响：所有裁剪都以 provider 为单位精确匹配，
 * 未命中路由时原样返回同一个 assembly 对象（引用相等）。
 *
 * 四层裁剪：
 *   1. 工具面   tools.restrict({ allow })  —— 只留本地模型真用得上的工具
 *   2. 提示词面 system-prompt/assemble 里按段名丢段、丢 context
 *   3. 注入面   把整份系统提示词换成一页纸，但保留头 80 / 尾 96 字符
 *   4. schema 面 截断工具 description，结构和 required 一字不动
 *
 * 不需要改动任何第三方插件的源码。如果机器上装了 dsh-purge，它的 assemble
 * guard 会被原样转发（见 installTakeover），本插件在它外层收尾。
 * 没装也照常工作 —— 那是可选增强，不是前提。
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BRIDGE_PREFIX, makeBridgeRoutes } from './bridge.js'
import { Config, resolveConfig } from './config.js'
import {
  DEFAULT_DROP_CONTEXTS,
  DEFAULT_DROP_SECTIONS,
  DEFAULT_INJECT,
  DEFAULT_KEEP,
  HUNG_HEAD_LEN,
  HUNG_TAIL_LEN,
  LIGHT_INJECT_PATH,
  LOG_PATH,
  RESERVED,
  TOOL_DESC_LIMIT,
  TOOL_PARAM_DESC_LIMIT,
  defaultInject,
  migrateLegacyList,
} from './defaults.js'

import {
  DEFAULT_ENDPOINTS,
  buildProfile,
  clearStaleCompat,
  normalizeEndpoint,
  probeEndpoint,
  probeFirstAvailable,
  registerProvider,
  unregisterProvider,
} from './provision.js'

import {
  appendModelToProfile,
  backendFor,
  buildImportProfile,
  findReusableProvider,
  parseImportInput,
  pickModel,
  planAlign,
  planReconcile,
  smokeTest,
  summarizeProvider,
} from './import-model.js'

import { buildPanelStatus, isLocalProvider, looksLocalName, looksLocalUrl } from './status.js'
import {
  checkModelFit,
  detectGpuInfo,
  estimateKvBytes,
  homeDir,
  launcherForPort,
  localModelDirs,
  normalizeLoadMode,
  ollamaModelFor,
  planLaunch,
  portOfBaseURL,
  readGgufMagic,
  readGgufMeta,
  runDetached,
  scanLocalModels,
  stopProcess,
  totalShardBytes,
  waitForEndpoint,
} from './launcher.js'

export { buildProfile, clearStaleCompat, normalizeEndpoint, probeEndpoint, probeFirstAvailable, registerProvider } from './provision.js'

export const name = 'dsh-local-trim'
export const inject = ['tools', 'systemPrompt']

// Config 让 dsh-settings 能识别本插件的可写字段（只有 .volatile() 的字段能在运行时改）。
export { Config } from './config.js'
// 常量也从这里再导出，老用法仍然有效。
export {
  DEFAULT_DROP_CONTEXTS,
  DEFAULT_DROP_SECTIONS,
  DEFAULT_INJECT,
  DEFAULT_KEEP,
  LIGHT_INJECT_PATH,
  defaultInject,
} from './defaults.js'


/** dsh-purge 用它把自己的 slot 挂在 prompt.assemble 的 getter 上。 */
const ASSEMBLE_GUARD = Symbol.for('dsh-purge.assembleGuard')

/**
 * 注入段的段名。
 *
 * 段名是跨插件的契约，不是本插件能随便挑的：
 *
 * - 装了 dsh-purge 时必须叫 `dsh-purge`。它按精确名工作（identity.js 里
 *   `section.name === "dsh-purge"` 跳过、保序、定位插入点），宿主也被它的补丁
 *   改成只保留 `name.startsWith("dsh-purge")` 的段。换个名字注入就被丢掉。
 * - 没装 dsh-purge 时叫这个名字就是纯拟合 —— 在一台从未装过它的机器上凭空
 *   造一个带第三方插件名字的段。所以用我们自己的名字。
 *
 * 读的时候两个名字都认：热装/热卸 dsh-purge 时，装配里可能残留上一个名字的段。
 */
const PURGE_SECTION = 'dsh-purge'
const OWN_SECTION = 'local-trim:inject'

/**
 * 这一段的正文是不是「注入正文」。
 *
 * 用前缀而不是精确名：dsh-purge 自己就按 `name.startsWith('dsh-purge')` 认段，
 * 它升级时可能把段名改成 `dsh-purge:v2` 之类。用精确名的话，改一次名我们就
 * 再也换不掉那段 25K 正文（只剩段裁剪在起作用，省 3.4K 而不是 28K）。
 */
const isInjectSection = (name) => name === OWN_SECTION || name.startsWith('dsh-purge')

/**
 * 这台机器上有没有 dsh-purge。
 *
 * 两条判据都不依赖它的包名或路径：它自己把原文 getter 挂在 globalThis 上，
 * 并把 slot 挂在 prompt.assemble 的访问器（或对象本身）上。都没有就是没装。
 */
function purgePresent(prompt) {
  try {
    if (typeof globalThis.__dshPurgeHungPrompt === 'function') return true
  } catch {
    /* 读 globalThis 不该抛，抛了就当没装 */
  }
  try {
    if (prompt && Object.getOwnPropertyDescriptor(prompt, 'assemble')?.get?.[ASSEMBLE_GUARD]) return true
    if (prompt?.[ASSEMBLE_GUARD]) return true
  } catch {
    /* 同上 */
  }
  return false
}

/** 标记「这个访问器是本插件装的」，避免重复接管。 */
const TAKEOVER = Symbol.for('dsh-local-trim.takeover')
// 每个 apply 调用一个独立 token：用来区分「本实例装的包装器」和「上一个实例
// 留下的、ctx 已失效的包装器」。后者必须叠加而不是跳过。
const INSTANCE = Symbol.for('dsh-local-trim.instance')

// 本地端点判定只有一份真值源：lib/status.js。
// 以前这里复制了一份正则，和 status.js 那份各自演化（连 `lm-studio` 都写重了两次），
// 结果是面板说「本地 2 个」而裁剪按另一套判据走。判定逻辑搬过去，这里只做转发。

/** 当前生效的 provider：先看会话选择投影，再退回 agent 的默认路由。 */
function providerOf(ctx, agent) {
  // [proj-guard] 原来这里裸调 ctx.get('sessionProjections') 与 stateOf()。
  // plan() 会在 agent/created 事件里直接调它，抛错就穿透整个事件分发；
  // 在 trimAssembly 里抛则被吞成「不裁」，面板还显示 provider-not-local —— 线索全丢。
  try {
    const projections = ctx.get('sessionProjections')
    const session = agent?.session
    if (projections !== undefined && session !== undefined) {
      const state = projections.stateOf(session, 'modelSelection')
      const picked = state?.pending ?? state?.lastUsed
      if (typeof picked?.provider === 'string' && picked.provider.length > 0) return picked.provider
    }
  } catch {
    /* 投影服务不可用 / stateOf 抛错时退回 agent.options */
  }
  const fromOptions = agent?.options?.provider
  return typeof fromOptions === 'string' && fromOptions.length > 0 ? fromOptions : undefined
}

/** 该 agent 当前可见的工具名（不含保留传输）。 */
function visibleNames(tools, agent) {
  let list
  try {
    list = tools.schemas(agent)
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  return list.map((schema) => String(schema?.name ?? '')).filter((n) => n.length > 0 && !RESERVED.has(n))
}

/** 按句子边界截断，尽量不留半句。 */
function clip(text, limit) {
  const s = String(text ?? '')
  if (!Number.isFinite(limit) || limit <= 0 || s.length <= limit) return s
  const floor = Math.floor(limit * 0.45)
  for (const sep of ['. ', '; ', '。', '；', ', ', '，', ' ']) {
    const at = s.lastIndexOf(sep, limit)
    if (at >= floor) return s.slice(0, at + sep.length).trimEnd()
  }
  return s.slice(0, limit).trimEnd()
}

/**
 * 宿主的 25K 兜底逻辑会拿这份文本的头 80 / 尾 96 字符做包含判断。
 *
 * 这个函数在 dsh-purge 那边是**很贵**的：它的实现依次走
 * refreshHungOperator → core.hungOperatorPrompt → readPromptInjectFileSync，
 * 每次可能读盘甚至过加密槽解密。而 trimAssembly 每轮装配都调一次。
 * 加 2 秒 TTL —— 装配连发时省掉重复取，人手改配置后最多 2 秒就生效。
 */
const HUNG_CACHE_TTL_MS = 2_000
// [P2-06-2026-11-26] reserveMb 的上限（MiB）。见 reserveBytesOf 里的说明。
const RESERVE_MB_CAP = 256 * 1024
// 缓存必须同时记住「这次缓存是哪个 fn 算出来的」。
// 只按时间戳缓存时，dsh-purge 被卸掉（或被热重载换成新函数）之后，
// 旧的 reference 还会在 TTL 内继续生效 —— 那段文本已经没人认了，留着只会
// 让 spliceInject 往注入里拼一段来路不明的头尾。
let hungCache = { at: 0, fn: undefined, value: undefined }

function hungReferenceText() {
  const now = Date.now()
  const fn = globalThis.__dshPurgeHungPrompt
  if (hungCache.at !== 0 && hungCache.fn === fn && now - hungCache.at < HUNG_CACHE_TTL_MS) {
    return hungCache.value
  }
  let value
  try {
    if (typeof fn === 'function') {
      const text = String(fn() ?? '').trim()
      value = text.length > 0 ? text.replace(/\r\n/g, '\n') : undefined
    }
  } catch {
    value = undefined
  }
  hungCache = { at: now, fn, value }
  return value
}

/**
 * 把整份注入换成轻量版，同时保留 reference 的头 80 / 尾 96 字符。
 * 宿主 agent-loop 只有在渲染结果同时包含这两段时才不会把全文再前置一遍。
 */
export function spliceInject(originalText, lightBody, reference) {
  const body = String(lightBody ?? '').trim()
  const original = String(originalText ?? '')
  if (body.length === 0) return original
  const ref = String(reference ?? '')

  // 短于取样窗口的 reference 没法切头尾，但它本身就很短 —— 整份带上即可。
  // 原来这里 return body，头尾都没留，宿主 agent-loop 的
  // `includes(tail) && includes(head)` 判定必然失败，于是把整份 hung prompt 再前置一遍，
  // 模型收到两份注入。带上整份 ref 的代价 ≤ 176 字符，换掉这个确定性缺陷。
  if (ref.length <= HUNG_HEAD_LEN + HUNG_TAIL_LEN) {
    if (ref.length === 0) return body
    const whole = `${ref}\n\n${body}`
    return original === whole || original.includes(whole) ? original : whole
  }
  const head = ref.slice(0, HUNG_HEAD_LEN)
  const tail = ref.slice(-HUNG_TAIL_LEN)

  // 正文自己就带了头 / 尾时不要重复拼（内置轻量注入的开头常与 head 相同）。
  const prefix = body.startsWith(head) ? '' : `${head}\n\n`
  const suffix = body.endsWith(tail) ? '' : `\n\n${tail}`
  const next = `${prefix}${body}${suffix}`

  // 幂等：上一轮已经拼成这个形态就直接返回。
  // 不能写成 `original.includes(body)` —— 轻量正文本来就是 prompt-inject 的缩略版，
  // 几乎总是原文的子串，那样判会让裁剪静默失效（面板却显示「已替换」）。
  return original === next ? original : next
}

export function apply(ctx, config = {}) {
  // ── 配置读取 ────────────────────────────────────────────────
  //
  // 声明了 Config（lib/config.js）之后，凡是 .volatile() 的字段，宿主传进来的
  // 不是值而是一个活引用对象 { get() {...}, [write](v) {...} }。直接
  // config.enabled !== false 会恒为 true（对象 !== false），所以这里统一走
  // resolveConfig() 现读 —— 面板保存后不需要重载插件，下一段请求就用新值。
  const read = () => resolveConfig(config)
  /** 面板允许的额外主机名（正常是空数组 = 只认回环名字）。 */
  const trustedHostsOf = (values) => {
    const list = Array.isArray(values?.trustedPanelHosts) ? values.trustedPanelHosts : []
    return list.map((item) => String(item ?? '').trim().toLowerCase()).filter((item) => item.length > 0)
  }

  /**
   * [P2-04-2026-11-26] 面板允许的额外对端地址（正常是空数组 = 只认回环）。
   * 与 trustedHostsOf 对称：主机名管 Host/Origin，地址管 TCP 对端，两道闸都得过。
   */
  const trustedPeersOf = (values) => {
    const list = Array.isArray(values?.trustedPanelPeers) ? values.trustedPanelPeers : []
    return list
      .map((item) => String(item ?? '').trim().toLowerCase().replace(/^\[|\]$/g, ''))
      .filter((item) => item.length > 0)
  }

  /** provider 名的归一化：面板里手输的名字常常带空白或大小写不一致。 */
  const normName = (value) => String(value ?? '').trim().toLowerCase()

  /** 生效路由。routes 为空数组 = 自动识别（见 isLocalRoute）；写了名字就只认名字。 */
  const routePlan = () => {
    const c = read()
    // routes 不是数组（没写、写错类型）时**不猜任何 provider 名**：按「没给名单」
    // 处理，走自动识别。原来这里兜底成 ['local-qwen'] —— 那是某一个 profile 里
    // 恰好存在的名字，换台机器就是一条永不命中的死路由。
    //
    // 必须归一化：原来直接 map(String)，面板里填 " Local-Qwen " 就让 routes.has
    // 永不命中，同时 autoDetect 又被关掉（数组非空）→ 本地 provider 被判云端，
    // 工具全开、提示词不裁，而面板只说 route-excluded。
    const explicit = Array.isArray(c.routes) ? c.routes.map(normName).filter((n) => n.length > 0) : null
    return {
      autoDetect: explicit === null || explicit.length === 0,
      routes: new Set(explicit ?? []),
    }
  }
  /** 面板保存的 routes 与自动注册的 provider 共用这个集合。 */
  const dynamicRoutes = new Set()
  const routes = {
    has: (p) => routePlan().routes.has(normName(p)) || dynamicRoutes.has(normName(p)),
    add: (p) => {
      dynamicRoutes.add(normName(p))
      return dynamicRoutes
    },
    delete: (p) => dynamicRoutes.delete(normName(p)),
    get size() {
      return new Set([...routePlan().routes, ...dynamicRoutes]).size
    },
    values: () => [...new Set([...routePlan().routes, ...dynamicRoutes])],
  }
  const autoDetect = () => routePlan().autoDetect

  /**
   * 配置里存的旧默认值。
   *
   * 这三个列表一旦被写进 profile 就永久留在那儿，「配置里有值」于是再也分不清
   * 「用户要这个」还是「上一版默认值忘了清」。从 0.5.1 升级上来的机器 keep 里还留着
   * 5 个 scoped 名（会让 tools.restrict 整批被拒），从 0.5.2 升级的还留着
   * `dsh-purge:anchor`（从来不存在）。判据与翻译规则见 defaults.js 的
   * migrateLegacyList()：有多余名字 = 用户自定义，一个字不改。
   */
  const lastLegacy = { keep: null, dropSections: null, dropContexts: null }
  const legacyReported = new Set()
  const migrateList = (kind, value, current) => {
    const hit = migrateLegacyList(value, current, kind)
    if (hit === null) {
      lastLegacy[kind] = null
      return null
    }
    lastLegacy[kind] = {
      version: hit.version,
      removed: hit.removed,
      added: hit.added,
      dropped: hit.dropped,
    }
    if (!legacyReported.has(`${kind}@${hit.version}`)) {
      legacyReported.add(`${kind}@${hit.version}`)
      const parts = []
      if (hit.added.length > 0) parts.push(`补上 ${hit.added.join(', ')}`)
      if (hit.dropped.length > 0) parts.push(`丢掉 ${hit.dropped.join(', ')}`)
      if (hit.removed.length > 0) parts.push(`你删过的 ${hit.removed.join(', ')} 保持不恢复`)
      report(`配置迁移：${kind} 仍是 ${hit.version} 的旧默认值，已按当前默认值解释（${parts.join('；')}）`)
    }
    return new Set(hit.next)
  }

  // [P2-09-2026-11-26] 空列表 = 回落内置默认白名单，不是「一个都不保留」。
  // 面板的 hint 已经写明这一点；这里留注释是因为「空 = 全保留」这个反直觉的
  // 语义在配置层看不出来，改的人很容易顺手把它改成「空 = 全裁」。
  const keepSet = () => {
    const c = read()
    if (!Array.isArray(c.keep) || c.keep.length === 0) return new Set(DEFAULT_KEEP)
    return migrateList('keep', c.keep, DEFAULT_KEEP) ?? new Set(c.keep.map(String))
  }
  const dropSectionSet = () => {
    const c = read()
    if (!Array.isArray(c.dropSections)) return new Set(DEFAULT_DROP_SECTIONS)
    return migrateList('dropSections', c.dropSections, DEFAULT_DROP_SECTIONS) ?? new Set(c.dropSections.map(String))
  }
  const dropContextSet = () => {
    const c = read()
    if (!Array.isArray(c.dropContexts)) return new Set(DEFAULT_DROP_CONTEXTS)
    return migrateList('dropContexts', c.dropContexts, DEFAULT_DROP_CONTEXTS) ?? new Set(c.dropContexts.map(String))
  }
  const enabled = () => read().enabled !== false
  const promptTrim = () => read().promptTrim !== false
  const schemaTrim = () => read().schemaTrim !== false
  /** 排障开关：打开后每次 assemble 都记「包装器进入/返回」的体积。 */
  const debugWrap = () => read().debugWrap === true
  const toolDescLimit = () => {
    const v = read().toolDescLimit
    return Number.isInteger(v) && v >= 0 ? v : TOOL_DESC_LIMIT
  }
  const toolParamDescLimit = () => {
    const v = read().toolParamDescLimit
    return Number.isInteger(v) && v >= 0 ? v : TOOL_PARAM_DESC_LIMIT
  }
  const selfCheck = () => read().selfCheck !== false

  /** agent → { off, signature } */
  const records = new Map()
  /** 已确认不属于全局工具的名字（scoped 注册），restrict 前直接跳过。 */
  const scopedNames = new Set()
  let stopped = false
  /**
   * applyRestrict 期间的重入闸。
   *
   * `tools.restrict()` 会同步触发 `tools/change` → planAll() → plan() 每一个 agent。
   * 那一路如果被放进来，就会在「刚装上、还没记进 records」的空窗里再装一次限制，
   * 于是同一份 disposer 叠两层、records 里的 off 只剩最里面那层 —— 越裁越窄且查不出来。
   * 所以重入必须挡。
   *
   * [pending-plan] 但挡掉不能等于丢掉：原来直接 `return`，于是被挡的那几个 agent
   * 就永远停在旧状态（包括本该被恢复成全开的那几个），直到下一次真实事件。
   * 现在挡掉时打一个 pending 记号，最外层收尾时补跑一遍。
   */
  let mutating = false
  let planPending = false
  /** 本实例的身份标记，用来识别自己装的 assemble 包装器（见 installTakeover）。 */
  const instanceToken = Symbol('dsh-local-trim instance')
  let inactiveSkips = 0
  let lastTrimSignature
  let lastSchemaSignature
  let injectSource = 'none'
  /** 上一次从 light-inject.md 读到的正文 + 文件戳（mtime:size），避免每次 assemble 都读盘。 */
  let injectCache = null

  // 日志轮转阈值：超过就改名成 .1（只留一代），避免无限增长。
  // dsh-purge 自己也有 PURGE_INTERNAL_LOG_MAX = 2MB，这里对齐同一个量级。
  const LOG_MAX_BYTES = 2 << 20
  let logReady = false

  /**
   * 一行日志。
   *
   * 写盘是同步的（appendFileSync），这是有意的取舍：这里每次最多写一行几十字节，
   * 落在已经打开的页缓存上，实测远低于一次 `statSync`；换成异步写反而要在
   * 进程退出/插件卸载时处理「最后几行没落盘」，而排障恰恰最需要最后几行。
   * 真正会拖住事件循环的是「日志无限增长后每次 append 都要找文件尾」和
   * 「读日志把整个文件读进内存」，这两条分别由 LOG_MAX_BYTES 轮转与
   * readLogTail 的 fd 定位解决，不是靠改同步/异步。
   */
  const report = (line) => {
    const text = `[${name}] ${line}`
    try {
      ctx.logger?.info?.(text)
    } catch {
      /* logger 不可用时只写文件 */
    }
    try {
      if (!logReady) {
        // [log-dir] 原来没有这一步：~/.dsh/local-llm/ 不存在时 appendFileSync 抛 ENOENT
        // 被下面的空 catch 吞掉，日志静默不落盘，排障时一个字的线索都没有。
        mkdirSync(dirname(LOG_PATH), { recursive: true })
        logReady = true
      }
      try {
        if (statSync(LOG_PATH).size > LOG_MAX_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.1`)
      } catch {
        /* 文件不存在或改名失败都不影响本次写入 */
      }
      appendFileSync(LOG_PATH, `${new Date().toISOString()} ${text}\n`)
    } catch {
      /* 磁盘不可写时忽略 */
    }
  }

  /**
   * 该 provider 是否是本地端点。三条判据任一命中即可：
   *   1) 写在 config.routes 里（精确名）
   *   2) config.autoDetectBaseURL（默认 true）且 llm 目录里这个 provider 的
   *      baseURL / defaultBaseURL 指向回环或私有网段
   *   3) 同上，且 provider 名字本身带 local/ollama/llama 等标记
   * 只读 llm 的公开目录，不改任何配置，也不触发网络请求。
   */
  /**
   * provider → baseURL 的缓存。
   *
   * 原来是个永不过期的 Map，只在 savePanel / importPanel / launchPanel 三处 clear。
   * 也就是说：用户在「设置 → 模型」里自己改了某个 provider 的地址，插件的路由判断
   * 会一直拿旧地址，直到那三个操作之一被触发 —— 表现就是「明明改成本机了，还是不裁剪」。
   * 加 30s 的 TTL：路由判断每次调用都在这一层，开销只有一次 Map.get + 一次比较。
   */
  const BASE_URL_TTL_MS = 30_000
  const baseUrlCache = new Map()
  const providerBaseUrl = (provider) => {
    const key = normName(provider)
    const cached = baseUrlCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < BASE_URL_TTL_MS) return cached.value
    let found
    try {
      const llm = ctx.get('llm')
      const entries = llm?.listConfigurableProviders?.() ?? []
      for (const entry of entries) {
        if (normName(entry?.provider) !== key) continue
        found = entry.baseURL ?? entry.defaultBaseURL ?? entry.baseUrl
        break
      }
    } catch {
      /* 没有 llm 服务时退回名字判断 */
    }
    baseUrlCache.set(key, { value: found, at: Date.now() })
    return found
  }

  /** 让某个 provider 的 baseURL 缓存失效（键是归一化后的名字）。 */
  const forgetBaseUrl = (provider) => baseUrlCache.delete(normName(provider))

  const isLocalRoute = (provider) => {
    if (typeof provider !== 'string' || provider.length === 0) return false
    if (routes.has(provider)) return true
    if (!autoDetect()) return false
    const baseURL = read().autoDetectBaseURL === false ? undefined : providerBaseUrl(provider)
    // [route-host] 有明确 baseURL 时以 host 为终裁，不再回落到名字正则。
    // 原来这里 `looksLocalUrl(baseURL)` 为 false 还会继续走 looksLocalName，于是
    // openrouter-llama-3 / together-llama / groq-llama-3.1-70b / llama-cloud 全被判成本地，
    // 结果是把云模型的工具裁成 15 个、把它的系统提示词换成轻量注入 —— 用户完全无感知。
    if (typeof baseURL === 'string' && baseURL.length > 0) return looksLocalUrl(baseURL)
    return looksLocalName(provider)
  }

  /**
   * 「如果不管配置，这个 provider 算不算本地」。
   *
   * 只用来出诊断文案。`routes` 一写名字、或 `autoDetectBaseURL` 一关，
   * isLocalRoute 就整体短路返回 false —— 这时候本地端点会被静默放行，
   * 面板上跟云端长得一模一样，用户完全看不出是自己把名单写窄了。
   */
  const looksLocalIgnoringConfig = (provider) => {
    // 与 isLocalRoute 的判据保持一致：有 baseURL 就以 host 为准，
    // 否则一个叫 `llama-cloud` 的云端 provider 会被诊断成「是你把名单写窄了」。
    const baseURL = providerBaseUrl(provider)
    if (typeof baseURL === 'string' && baseURL.length > 0) return looksLocalUrl(baseURL)
    return looksLocalName(provider)
  }

  /**
   * 读轻量注入正文：config.injectText > 文件 > 内置默认。
   *
   * 每次取用时现读 —— 面板保存 injectText、或用户直接改 light-inject.md，
   * 下一轮 assemble 就该换新正文。原来这里在 apply() 里只算一次，
   * 面板上那个「改完点保存即生效」的承诺是假的（README:387）。
   * 现读的成本用一次 stat 挡掉：文件没变就复用上一次的结果。
   */
  const resolveInject = () => {
    const injectText = read().injectText
    let stamp = 'config'
    if (typeof injectText === 'string' && injectText.trim().length > 0) {
      injectSource = 'config'
      return injectText.trim()
    }
    try {
      const info = statSync(LIGHT_INJECT_PATH)
      stamp = `file:${info.mtimeMs}:${info.size}`
      if (injectCache !== null && injectCache.stamp === stamp) {
        injectSource = LIGHT_INJECT_PATH
        return injectCache.text
      }
      const text = readFileSync(LIGHT_INJECT_PATH, 'utf8').trim()
      if (text.length > 0) {
        injectSource = LIGHT_INJECT_PATH
        injectCache = { stamp, text }
        return text
      }
    } catch {
      /* 没文件就走内置 */
    }
    injectSource = 'builtin'
    // 内置正文按当前 keep 集合现渲染：不留「说了但没给」的幽灵工具名。
    // keep 是 .volatile() 的活引用，面板改完下一轮就在这里生效。
    return defaultInject([...keepSet()]).trim()
  }
  /** 当前生效的注入正文（每次现读，用于 splice / 面板 / 自检）。 */
  const currentInject = () => resolveInject()

  /**
   * 补注入段时该用的段名。
   *
   * 装了 dsh-purge 就沿用它的名字：宿主被它的补丁改成只保留
   * `name.startsWith('dsh-purge')` 的段，换名字注入会被丢掉。
   * 没装就用本插件自己的名字，不在陌生机器上冒用第三方插件的段名。
   */
  const injectSectionName = () => {
    let prompt
    try {
      prompt = ctx.systemPrompt
    } catch {
      prompt = undefined
    }
    return purgePresent(prompt) ? PURGE_SECTION : OWN_SECTION
  }
  // 启动时先方言一次，让 injectSource 立刻有真实值（自检与面板都读它）。
  currentInject()

  // ─────────────────────────── 工具面 ───────────────────────────

  const release = (agent) => {
    const record = records.get(agent)
    if (record === undefined) return
    records.delete(agent)
    try {
      record.off?.()
    } catch (error) {
      report(`restriction cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 装限制。restrict() 遇到 scoped 注册名会整批拒绝，所以从错误消息里把
   * 被拒的名字抠出来记住，下一轮直接跳过——比依赖 view() 私有字段跨版本安全。
   */
  const applyRestrict = (tools, allow, learned) => {
    let candidates = allow.filter((n) => !learned.has(n))
    for (let round = 0; round < 4; round += 1) {
      if (candidates.length === 0) return undefined
      try {
        return tools.restrict({ allow: candidates })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const listed = /unknown global tool(?:s)? (.+?); known global tools:/.exec(message)
        if (listed === null) throw error
        const unknown = new Set([...listed[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]))
        if (unknown.size === 0) throw error
        for (const n of unknown) learned.add(n)
        candidates = candidates.filter((n) => !learned.has(n))
        report(`restrict 剔除非全局名（scoped 注册本就豁免）: ${[...unknown].join(', ')}`)
      }
    }
    return undefined
  }

  const plan = (agent) => {
    // stopped 优先于 enabled：插件已卸载时不该再改动任何 agent。
    if (stopped) return
    if (mutating) {
      // [pending-plan] 记下来，别丢。收尾时由最外层那一轮补算。
      planPending = true
      return
    }
    // [trim-off] enabled=false 必须连已经生效的白名单一起撤掉。
    // 原来这里是 `if (!enabled() || stopped || mutating) return` —— 早退在 release 之前，
    // 于是「关掉插件」只停了新裁剪，已 restrict 的 agent 永远停在白名单状态（工具永久缺失），
    // 直到 agent 销毁。只有 provider 从本地变云端（下面 !active 分支）才会恢复。
    if (!enabled()) {
      if (records.has(agent)) {
        release(agent)
        report(`${agent.id ?? 'agent'} → 裁剪已关闭，已恢复全部工具`)
      }
      return
    }
    const provider = providerOf(ctx, agent)
    const active = provider !== undefined && isLocalRoute(provider)

    if (!active) {
      // 云端模型：不留任何限制。
      if (records.has(agent)) {
        release(agent)
        report(`${agent.id ?? 'agent'} → provider ${provider ?? '(none)'} 不在裁剪名单，已恢复全部工具`)
      }
      return
    }

    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.restrict !== 'function') return

    const names = visibleNames(tools, agent)
    if (names === undefined || names.length === 0) return

    const keep = keepSet()
    const allow = names.filter((n) => keep.has(n))
    if (allow.length === 0) {
      // 白名单把可见工具全排除了 —— 这时候留着上一轮的限制等于「用户在面板里
      // 清空了 keep，但工具面还是旧的那套」，所以必须释放。
      if (records.has(agent)) {
        release(agent)
        report(`${agent.id ?? 'agent'} 的可见工具里没有任何一项在白名单内，已恢复全部工具`)
        return
      }
      report(`${agent.id ?? 'agent'} 的可见工具里没有任何一项在白名单内，跳过裁剪`)
      return
    }

    const signature = `${provider}|${allow.join(',')}`
    const record = records.get(agent)
    if (record?.signature === signature) return

    const previous = record?.off
    records.delete(agent)
    if (previous !== undefined) {
      try {
        previous()
      } catch {
        /* 旧 disposer 失败不阻止新限制 */
      }
    }

    const outermost = !mutating
    mutating = true
    try {
      const off = applyRestrict(tools, allow, scopedNames)
      if (off === undefined) {
        report(`${agent.id ?? 'agent'} @ ${provider}: 白名单里没有可 restrict 的全局工具，跳过`)
        return
      }
      records.set(agent, { off, signature })
      report(`${agent.id ?? 'agent'} @ ${provider}: 保留 ${allow.length} 项、裁掉 ${names.length - allow.length} 项`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 子 agent 的 fiber 常在 plan 跑完前被销毁，这时 restrict 必然抛 INACTIVE_EFFECT。
      if (message.includes('inactive context')) {
        records.delete(agent)
        inactiveSkips += 1
        if (inactiveSkips === 1) report('restrict 跳过已销毁的 agent fiber（inactive context），后续同类不再记录')
      } else {
        report(`restrict failed: ${message}`)
      }
    } finally {
      if (outermost) {
        mutating = false
        // [pending-plan] 被这道闸挡掉的那些 agent 在这里补算。加一道上限，
        // 免得「补算又触发 tools/change 又补算」自激成死循环。
        for (let round = 0; planPending && round < 3; round += 1) {
          planPending = false
          planAll()
        }
        planPending = false
      }
    }
  }

  const planAll = () => {
    // [trim-off] 不能在这里按 enabled 早退：enabled 关掉时 plan() 还要负责
    // 把已经装上的 restrict 撤掉，否则工具面永远停在旧白名单。
    if (stopped) return
    let agents
    try {
      agents = ctx.get('agents')
    } catch {
      return
    }
    const list = typeof agents?.list === 'function' ? agents.list() : []
    for (const agent of list ?? []) plan(agent)
  }

  // ─────────────────────────── schema 面 ───────────────────────────

  /**
   * 量一段 schema 的字节数，量不出来就返回 null。
   *
   * 真实宿主的 tool schema 一定能 JSON 序列化（它最终要发给模型 API），
   * 但第三方插件注册工具时可能塞进循环引用、BigInt、或者深到爆栈的对象。
   * 以前这里是裸 JSON.stringify：一旦抛错就穿出 trimAssembly，被外层
   * catch 吞掉，于是**提示词裁剪、注入替换、context 裁剪一起失效** ——
   * 面板只显示「未裁剪」，看起来像「这台机器没得裁」。
   * 现在量不出来就跳过该条的统计，绝不拖累别的层。
   */
  const schemaBytes = (value) => {
    try {
      return JSON.stringify(value ?? {}).length
    } catch {
      return null
    }
  }

  const slimSchema = (schema, seen = new WeakSet(), depth = 0) => {
    if (Array.isArray(schema)) return schema.map((item) => slimSchema(item, seen, depth + 1))
    if (schema === null || typeof schema !== 'object') return schema
    // 循环引用：原样交回去，不递归。判完记得从 seen 里退出，
    // 否则同一个对象在兄弟位置出现两次会被误判成环。
    if (seen.has(schema)) return schema
    seen.add(schema)
    const out = {}
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'description' && typeof value === 'string') {
        // 参数级描述（嵌在 properties 里的）用参数上限，工具级顶层描述用工具上限。
        // 原来写的是 `schema.type === 'object' ? 参数上限 : 工具上限` —— 判的是「当前
        // 这个对象是不是 object 类型」，于是嵌套的 string 参数全都拿到 140（工具级），
        // 与意图正好相反。
        const limit = depth === 0 ? toolDescLimit() : toolParamDescLimit()
        out[key] = clip(value, limit)
        continue
      }
      out[key] = slimSchema(value, seen, depth + 1)
    }
    seen.delete(schema)
    return out
  }

  const slimToolSchemas = (list) => {
    if (!schemaTrim() || !Array.isArray(list) || list.length === 0) return list
    let slimmed
    try {
      slimmed = list.map((item) => slimSchema(item))
    } catch {
      // 递归本身也可能炸（深度几千层 → RangeError）。这一层放弃瘦身，
      // 但提示词面照常裁 —— schema 面失败不该让整份裁剪归零。
      return list
    }
    // 没有任何一项真的变短 → 交回原数组。否则 `tools === assembly.tools` 永远为 false，
    // trimAssembly 的 nothing-matched 早退永不成立，每轮白做一次全量 map。
    const changed = slimmed.some((item, index) => item !== list[index])
    if (!changed) return list
    // 体积统计只在排障时算：这里两次全量 JSON.stringify，而签名相同的轮次占绝大多数。
    if (debugWrap()) {
      const sumBytes = (items) => {
        let total = 0
        for (const item of items) {
          const bytes = schemaBytes(item)
          if (bytes === null) return null
          total += bytes
        }
        return total
      }
      const before = sumBytes(list)
      const after = sumBytes(slimmed)
      const signature =
        before === null || after === null
          ? `tools|${list.length}|?`
          : `tools|${list.length}|${before}>${after}`
      if (signature !== lastSchemaSignature) {
        lastSchemaSignature = signature
        report(
          before === null || after === null
            ? `tool schema 瘦身: ${list.length} 项（体积量不出来，已跳过统计）`
            : `tool schema 瘦身: ${list.length} 项 ${before}→${after} 字节（省 ${before - after}）`,
        )
      }
    }
    return slimmed
  }

  // ─────────────────────────── 提示词面 ───────────────────────────

  // 最近一次 assemble 的体积，面板拿它画「省了多少」。
  // charsIn 是内层（宿主 / dsh-purge）给出的原始装配，charsOut 是我们交出去的。
  let lastTrim = null
  let lastWrapSignature = ''

  // [chars-not-bytes] 它数的是 String.length，也就是 UTF-16 码元个数，不是字节数。
  // 中文一个字算 1（UTF-8 下是 3 字节），面板文案说的也是「字符」，所以数得对；
  // 但名字叫 bytes 会让人在读代码时按 MB 去理解，进而误判「省了几个字节」。
  const charsOfAssembly = (assembly) =>
    (assembly?.sections ?? []).reduce((sum, section) => sum + String(section?.text ?? '').length, 0)

  // trimAssembly 为什么原样放行。面板要能回答「为什么这次一个字都没裁」，
  // 而三种原因对应三种完全不同的处置：
  //   provider-not-local  云端 provider，设计如此，不用管
  //   route-excluded      看着是本地，但配置把自动识别关了（routes / autoDetectBaseURL）
  //   no-provider         拿不到 provider 名，去查 providerOf 那条路
  //   nothing-matched     本地 provider 但没段落命中，段名可能随插件升级失效了
  // 混成一句「未裁剪」等于把线索丢了，所以这里带出来。
  let lastSkipReason = ''
  /** 「开了 schema 瘦身但装配里没有 tools」这句日志只打一次，别每轮刷屏。 */
  let schemaToolsWarned = false

  /**
   * @param {string} [skipReason] 这次 trimAssembly 原样放行的原因。
   *
   * 必须是**传进来**的，不能读模块级的 lastSkipReason：装配是可以并发的
   * （两个 agent 同时起请求），共享那个变量时后一个的 'provider-not-local'
   * 会被前一个的 'nothing-matched' 串成假线索。调用方在同一次同步调用里
   * 拿到原因再传进来，就没有串味的机会。
   */
  const recordTrim = (before, after, agent, skipReason = '') => {
    const charsIn = charsOfAssembly(before)
    const charsOut = charsOfAssembly(after)
    const provider = providerOf(ctx, agent)
    lastTrim = {
      charsIn,
      charsOut,
      sectionsIn: (before?.sections ?? []).length,
      sectionsOut: (after?.sections ?? []).length,
      contextsIn: (before?.contexts ?? []).length,
      contextsOut: (after?.contexts ?? []).length,
      provider: provider ?? '',
      // 这次装配到底该不该被裁 —— 面板据此判断「未裁剪」是不是正常现象。
      local: provider !== undefined && isLocalRoute(provider),
      reason: charsIn === charsOut ? skipReason : '',
      at: Date.now(),
    }
    if (!debugWrap()) return
    // 只在这个签名变化时打一行：以前每次 assemble 都打两行，日志被刷到几百 KB。
    const signature = `${charsIn}>${charsOut}`
    if (signature === lastWrapSignature) return
    lastWrapSignature = signature
    report(
      `包装器：${(before?.sections ?? []).length} 段 / ${charsIn} 字符 → ` +
        `${(after?.sections ?? []).length} 段 / ${charsOut} 字符`,
    )
  }

  const trimAssembly = (assembly, agent, sink = {}) => {
    // 每条早退都要留下「为什么没裁」，否则面板只能干瞪眼说不清。
    // sink 是给调用方的一份副本：lastSkipReason 是模块级变量，并发装配时会串味。
    const skip = (reason) => {
      lastSkipReason = reason
      sink.reason = reason
      return reason
    }
    skip('')
    // [trim-off] stopped / enabled 必须在**装配入口**就拦，而不是只在 plan() 里拦。
    // 原来只检查 promptTrim：拆掉插件后（stopped=true）访问器还挂在 prompt.assemble 上，
    // 继续按旧配置裁；面板把 enabled 关掉也只停了工具面，提示词照裁 —— 两个开关都是装饰品。
    if (stopped || !enabled()) {
      skip('disabled')
      return assembly
    }
    if (!promptTrim()) {
      skip('trim-disabled')
      return assembly
    }
    const provider = providerOf(ctx, agent)
    if (provider === undefined) {
      skip('no-provider')
      return assembly
    }
    if (!isLocalRoute(provider)) {
      // 地址 / 名字看着就是本地，但配置把自动识别关掉了（routes 写了别的名字，
      // 或 autoDetectBaseURL: false）。这跟「真的是云端 provider」是两件事：
      // 前者是用户自己把名单写窄了，得指出来，否则面板上一模一样、查不出来。
      skip(looksLocalIgnoringConfig(provider) ? 'route-excluded' : 'provider-not-local')
      return assembly
    }
    if (assembly === null || typeof assembly !== 'object' || !Array.isArray(assembly.sections)) {
      skip('no-sections')
      return assembly
    }

    const sections = assembly.sections
    const contexts = Array.isArray(assembly.contexts) ? assembly.contexts : []
    const before = sections.reduce((sum, s) => sum + String(s?.text ?? '').length, 0)
    const reference = hungReferenceText()
    // 集合提到循环外：原来每段 / 每 context 各调一次 dropSectionSet()/dropContextSet()，
    // 而它们每次都走全量 read() + migrateLegacyList()。40 段 + 10 context = 50 次迁移判定。
    const dropSections = dropSectionSet()
    const dropContexts = dropContextSet()
    const injectBody = currentInject()

    const keptSections = []
    let droppedSectionBytes = 0
    let injectReplaced = false

    for (const section of sections) {
      const sectionName = String(section?.name ?? '')
      if (dropSections.has(sectionName)) {
        droppedSectionBytes += String(section?.text ?? '').length
        continue
      }
      if (isInjectSection(sectionName)) {
        const original = String(section?.text ?? '')
        // 空槽（dsh-purge 心跳后正文被清空）也要算「已处理」：
        // 原来这里 push 完就 continue，没置 injectReplaced，于是下面又 unshift 一段同名段，
        // 同一次装配出现两个注入段，模型收到两遍。
        injectReplaced = true
        if (original.length === 0) {
          keptSections.push(
            injectBody.length === 0
              ? section
              : { ...section, text: spliceInject('', injectBody, reference), interpolate: false },
          )
          continue
        }
        keptSections.push({
          ...section,
          text: spliceInject(original, injectBody, reference),
          // 必须关掉插值：renderPrompt 会拿 assembly.variables 改写正文，
          // 一旦被改写，头80/尾96 取样就失配，宿主会把整份原文再前置一遍。
          interpolate: false,
        })
        continue
      }
      keptSections.push(section)
    }

    // 装配里没有注入段（没装 dsh-purge，或者它这轮没给段）：补一段。
    // 段名跟着「有没有 dsh-purge」走，见 isInjectSection 上面的说明。
    // 宿主在 complete-section 路径上只保留 startsWith('dsh-purge') 的段，
    // 所以有 complete 段时一律用 PURGE_SECTION，否则注入会被整段丢弃且毫无日志。
    if (!injectReplaced) {
      keptSections.unshift({
        name: assembly.sections.some((s) => s?.complete === true) ? PURGE_SECTION : injectSectionName(),
        text: spliceInject('', injectBody, reference),
        interpolate: false,
        order: -100000,
      })
      injectReplaced = true
    }

    const keptContexts = contexts.filter((entry) => !dropContexts.has(String(entry?.name ?? '')))
    const after = keptSections.reduce((sum, s) => sum + String(s?.text ?? '').length, 0)
    // [schema-tools-missing] 宿主的 `system-prompt/assemble` 瀑布只在**正常路径**上
    // 把 tools 并进返回值；complete-section 路径返回的是 `{sections, contexts}`，
    // 工具面根本不在这份装配里（它作为上下文参数另走一条）。于是 schemaTrim
    // 打开着、面板也显示「开启」，实际一次都没瘦身 —— 用户量了半天字节数不变。
    // 这里在第一次看到「开了瘦身但装配里没有 tools」时说一句，且只说一次。
    if (schemaTrim() && !Array.isArray(assembly?.tools) && !schemaToolsWarned) {
      schemaToolsWarned = true
      report(
        'schema 瘦身在这条装配路径上不生效：宿主这次给的装配里没有 tools 数组' +
          '（complete-section 路径只带 sections/contexts）。提示词面照常裁，工具描述原样。',
      )
    }
    const tools = slimToolSchemas(assembly?.tools)

    // 早退必须比内容，不能只比数量。注入段被 spliceInject 换过正文、段数却没变的时候，
    // 只比数量会把「注入替换」和「schema 瘦身」两件事一起丢掉 —— 插件看起来在跑，
    // 实际一个字节都没裁。这就是 v0.3.9 那两个静默失效里的第一个。
    const sameSections =
      keptSections.length === sections.length && keptSections.every((section, index) => section === sections[index])
    // contexts 的比对与 sections 保持对称：filter 只减不增，但统一用引用比较，
    // 免得以后有人在 filter 里换了元素身份而这里看不出来。
    const sameContexts =
      keptContexts.length === contexts.length && keptContexts.every((entry, index) => entry === contexts[index])
    if (sameSections && sameContexts && tools === assembly?.tools) {
      // 走到这里说明 provider 是本地、但有东西可裁的前提不成立：一个段名都没命中。
      // 这跟「云端放行」完全不是一回事，面板上必须分开说。
      skip('nothing-matched')
      return assembly
    }

    const signature = `${sections.length}>${keptSections.length}|${before}>${after}`
    if (signature !== lastTrimSignature) {
      lastTrimSignature = signature
      report(
        `prompt trim: ${sections.length}→${keptSections.length} 段、` +
          `${contexts.length}→${keptContexts.length} context，正文 ${before}→${after} 字符` +
          `（丢 ${droppedSectionBytes}）`,
      )
    }

    return { ...assembly, sections: keptSections, contexts: keptContexts, tools }
  }

  // ──────────────────── 接管 prompt.assemble ────────────────────
  //
  // 顺序：原生 assemble 内部跑完 system-prompt/assemble 瀑布 → 返回 →
  // dsh-purge 的 installAssembleGuard 用它自己包的那层再把整份 prompt-inject.md 置顶。
  // 所以只挂瀑布永远会被它覆盖。做法：把 prompt.assemble 换成自己的访问器，
  // 但在 getter 上转发 dsh-purge 的 ASSEMBLE_GUARD slot —— 它每 400ms 心跳时
  // 读到 desc.get[ASSEMBLE_GUARD] 仍然存在，只会刷新自己 slot.rewrite，
  // 不会重装访问器覆盖我们。我们因此在最外层拿到最终结果。
  //
  // 好处：不需要改任何第三方源码，dsh-purge 升级也不影响。

  let takeoverState = { ok: false, via: 'none', reason: '' }
  /** 装访问器之前的原 descriptor，卸载时原样恢复。 */
  let savedDescriptor
  /** 装过访问器没有（区分「本来就没有该属性」与「有但没装过」）。 */
  let takeoverInstalled = false

  const installTakeover = () => {
    if (stopped) return takeoverState
    let prompt
    try {
      prompt = ctx.systemPrompt
    } catch (error) {
      takeoverState = { ok: false, via: 'none', reason: String(error?.message ?? error) }
      return takeoverState
    }
    if (!prompt) {
      takeoverState = { ok: false, via: 'none', reason: 'ctx.systemPrompt 为空' }
      return takeoverState
    }

    let desc
    try {
      desc = Object.getOwnPropertyDescriptor(prompt, 'assemble')
    } catch {
      desc = undefined
    }
    // 只认「本实例」装的包装器。跨实例的 TAKEOVER 标记不能跳过：
    // 热重载后旧实例留在最外层，它的 ctx 已失效 → providerOf 返回 undefined →
    // 它自己的 trimAssembly 原样放行，而它内层仍会调 dsh-purge 把整份原文灌回去。
    // 所以这里必须再叠一层本实例的包装，而不是看到标记就放弃。
    if (desc?.get && desc.get[INSTANCE] === instanceToken) {
      takeoverState = { ok: true, via: takeoverState.via === 'none' ? 'already' : takeoverState.via, reason: '' }
      return takeoverState
    }

    const hasPurgeAccessor = typeof desc?.get === 'function'

    const wrapInner = (callInner) =>
      async function assembleWithLocalTrim(...args) {
        let assembled
        try {
          assembled = await callInner(...args)
        } catch (error) {
          // 不能再交空装配给宿主：`{sections:[],contexts:[],tools:[]}` 会让模型什么身份
          // 与规则都收不到，而日志里一行痕迹都没有 —— 症状是「提示词整份消失」而非报错。
          report(`装配失败，抛给宿主: ${String(error?.message ?? error)}`)
          throw error
        }
        const agent = args[0]?.agent
        if (agent === undefined) return assembled
        const reference = assembled
        let out = assembled
        // [no-swallow] 空 catch 在这里等于「裁剪崩了也照常返回原文，日志一个字没有」，
        // 面板只会说 nothing-matched。留痕，但不中断装配。
        const sink = {}
        try {
          out = trimAssembly(assembled, agent, sink)
        } catch (error) {
          report(`接管层裁剪失败，这次原样放行: ${String(error?.message ?? error)}`)
          out = assembled
        }
        try {
          recordTrim(reference, out, agent, sink.reason)
        } catch {
          /* 面板数据不能影响装配 */
        }
        return out
      }

    // holder.call(args) 才是真正去调内层 assemble 的东西。
    // 装了 dsh-purge 时必须**每次调用时**再读一次 desc.get，因为它的心跳
    // 只会刷新 slot.rewrite，getter 本身稳定；但万一它被重装，这里也能跟上。
    const holder = { call: undefined, fn: undefined }
    if (hasPurgeAccessor) {
      holder.call = (...args) => {
        const fn = desc.get.call(prompt)
        return typeof fn === 'function' ? fn.apply(prompt, args) : undefined
      }
    } else {
      let original
      try {
        original = prompt.assemble
      } catch (error) {
        takeoverState = { ok: false, via: 'none', reason: `读 assemble 抛错：${error?.message ?? error}` }
        return takeoverState
      }
      if (typeof original !== 'function') {
        takeoverState = { ok: false, via: 'none', reason: 'assemble 不是函数' }
        return takeoverState
      }
      holder.call = (...args) => original.apply(prompt, args)
    }
    holder.fn = wrapInner(holder.call)
    holder.fn[TAKEOVER] = true

    const getter = function localTrimAssemble() {
      return holder.fn
    }
    getter[TAKEOVER] = true
    getter[INSTANCE] = instanceToken
    // 把 dsh-purge 的 slot 原样转发，让它自己的心跳继续能刷新 rewriteFn。
    const purgeSlot = (hasPurgeAccessor && desc.get[ASSEMBLE_GUARD]) || prompt[ASSEMBLE_GUARD]
    if (purgeSlot) getter[ASSEMBLE_GUARD] = purgeSlot

    try {
      savedDescriptor = desc
      Object.defineProperty(prompt, 'assemble', {
        configurable: true,
        enumerable: desc ? desc.enumerable !== false : true,
        get: getter,
        set(next) {
          if (typeof next !== 'function') return
          holder.call = (...args) => next.apply(prompt, args)
          holder.fn = wrapInner(holder.call)
          holder.fn[TAKEOVER] = true
        },
      })
      takeoverInstalled = true
      takeoverState = {
        ok: true,
        via: purgeSlot ? 'accessor+purge-slot' : hasPurgeAccessor ? 'accessor' : 'accessor-native',
        reason: '',
      }
    } catch (error) {
      takeoverState = { ok: false, via: 'none', reason: `defineProperty 失败：${error?.message ?? error}` }
    }
    return takeoverState
  }

  /**
   * 把 prompt.assemble 恢复成我们装之前的样子。
   *
   * 原来清理函数只设 stopped=true 就完事，访问器留在最外层继续裁 ——
   * 拆掉插件后提示词还在被改，且完全没有痕迹。这里精确还原 descriptor。
   */
  const uninstallTakeover = () => {
    if (!takeoverInstalled) return
    takeoverInstalled = false
    let prompt
    try {
      prompt = ctx.systemPrompt
    } catch {
      return
    }
    if (!prompt) return
    try {
      if (savedDescriptor === undefined) delete prompt.assemble
      else Object.defineProperty(prompt, 'assemble', savedDescriptor)
    } catch (error) {
      report(`还原 prompt.assemble 失败: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * 保证接管存在。
   *
   * 原来是「apply 那刻 promptTrim() 为真才装，重试窗口 6 秒」—— 用户在面板里
   * 把 promptTrim 从 false 打开后，包装器永不再装（要重启宿主才行），
   * 而面板照常显示「裁剪已开启」。这里在每次 assemble 前补一次，
   * 加一个低频兜底定时器，代价是一次属性读取。
   */
  const ensureTakeover = () => {
    if (stopped || takeoverInstalled || !promptTrim()) return
    installTakeover()
  }

  // ─────────────────────────── 事件挂载 ───────────────────────────

  ctx.on('agent/created', ({ agent }) => {
    plan(agent)
    // 热重载时 apply 在 HMR 事务里，写 settings 会被拒；这里由真实请求路径触发，
    // 事务已结束，是「一步到位」唯一可靠的写入时机。
    if (provisionConfig !== null && !provisionDone) runProvisionOnce('真实请求')
    return undefined
  })

  ctx.on('agent/disposed', ({ agent }) => {
    release(agent)
    return undefined
  })

  // 模型切换是用户点确认时立刻写入的，早于下一轮请求。
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'model/selection') return undefined
    const agents = ctx.get('agents')
    const list = typeof agents?.list === 'function' ? agents.list() : []
    for (const agent of list ?? []) if (agent?.session === session) plan(agent)
    return undefined
  })

  ctx.on('tools/change', () => {
    planAll()
    return undefined
  })

  // 瀑布里的裁剪：没有 dsh-purge 时这就是唯一一道；装了它时这里先裁一遍
  // （省得它处理完整 25K），最终结果由 installTakeover 的最外层再收一次。
  // 注意 waterfall 的 next() 不收参数，必须在 await next() 之后改返回值。
  ctx.on(
    'system-prompt/assemble',
    async (_assembly, context, next) => {
      const agent = context?.agent
      if (agent === undefined) return next()
      // 面板刚把 promptTrim 打开时，包装器可能还没装 —— 这里补一次。
      ensureTakeover()
      plan(agent)
      const result = await next()
      try {
        return trimAssembly(result, agent)
      } catch (error) {
        // [no-swallow] 原来这里是空 catch —— 裁剪抛错就静默退回未裁装配，
        // 面板显示的还是「一个段都没命中」，用户永远查不到真正的原因。
        // 这里必须留痕：装配本身不能因为裁剪失败而中断，但也不能装作没事。
        report(`瀑布裁剪失败，这次原样放行: ${String(error?.message ?? error)}`)
        return result
      }
    },
    { global: true, prepend: true },
  )

  // 插件的 effect 清理：撤销限制、还原 prompt.assemble。
  ctx.effect(
    () => () => {
      stopped = true
      for (const agent of [...records.keys()]) release(agent)
      uninstallTakeover()
    },
    'dsh-local-trim: lifecycle',
  )

  planAll()
  for (const delay of [1200, 4000, 9000]) {
    const timer = setTimeout(planAll, delay)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  if (promptTrim()) {
    installTakeover()
    // dsh-purge 可能晚于本插件就绪，补几次重试；接管成功后访问器本身就带
    // TAKEOVER 标记，重复调用会立刻返回，代价可忽略。
    for (const delay of [800, 2500, 6000]) {
      const timer = setTimeout(installTakeover, delay)
      if (typeof timer?.unref === 'function') timer.unref()
    }
  }
  {
    // 低频兜底：面板把 promptTrim 打开、或热重载后包装器被别家顶掉，都能自愈。
    const timer = setInterval(ensureTakeover, 30_000)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  // ─────────────────────── 一步到位：注册本地 provider ───────────────────────
  //
  // provision 默认开启，但只在「当前一个可用的本地 provider 都没有」时才动手：
  // 已经有能连上的本地端点就完全跳过，不会覆盖任何人的现有配置。
  //
  //   provision: false                         关闭
  //   provision: true                          探测内置端口表，命中即注册
  //   provision: { endpoint, provider, ... }   指定端点 / provider id

  const provisionConfig = (() => {
    const raw = read().provision
    if (raw === false) return null
    if (raw === true || raw === undefined) return {}
    if (typeof raw === 'object' && raw !== null) return raw
    return {}
  })()

  /** 注册成功后写进来，用于日志与自检展示。 */
  let provisionState = { status: provisionConfig === null ? 'disabled' : 'pending', provider: '', detail: '' }

  /**
   * llm-pi-ai 命名空间的当前 revision。
   *
   * [cas-guard] 以前调用点写的是 `settings.describe?.().find(...)?.revision`，
   * 取不到时把 undefined 传给 settings.update，而 dsh-settings 的并发校验是
   * `if (expected !== void 0 && descriptor.revision !== expected) throw` —— undefined
   * 等于「跳过校验」，于是两个面板并发保存时后写静默覆盖先写，用户改的字段没了。
   * 拿不到 revision 就不该写。
   */
  const llmRevision = async (settings) => {
    try {
      const rows = await settings?.describe?.()
      const row = Array.isArray(rows) ? rows.find((item) => item?.ns === LLM_NS) : undefined
      const revision = row?.revision
      return Number.isInteger(revision) ? revision : undefined
    } catch {
      return undefined
    }
  }

  const settingsService = async () => {
    // settings 是可选依赖：没装 dsh-settings 时这一步静默跳过。
    try {
      const direct = ctx.get('settings')
      if (direct !== undefined) return direct
    } catch {
      /* 走 inject 兜底 */
    }
    return await new Promise((resolve) => {
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      try {
        ctx.inject(['settings'], (child) => {
          done(child.settings)
        })
      } catch {
        done(undefined)
      }
      const timer = setTimeout(() => done(undefined), 4000)
      if (typeof timer?.unref === 'function') timer.unref()
    })
  }

  /**
   * 写 settings 会走 configEditor.edit() → hmr.runExclusive()。
   * 插件热重载期间，apply() 整条激活链都跑在 HMR 的 AsyncLocalStorage 事务里，
   * 连 setTimeout 回调都会继承那个 store，所以「等一下再写」逃不出去 ——
   * 会一直撞 `HMR transactions cannot be nested`。
   *
   * 真正的逃逸点是「不在这条激活链上产生的事件」：agent/created、tools/change
   * 都由真实请求路径触发，那时事务早已结束。所以：
   *   · 冷启动（用户装完插件重启 DSH）：apply 不在事务里，第一次就成功；
   *   · 热重载：先记下待办，等下一个真实事件再写。
   */
  let provisionDone = false
  let provisionRunning = false

  const runProvisionOnce = (reason) => {
    if (provisionConfig === null || provisionDone || provisionRunning || stopped) return
    provisionRunning = true
    Promise.resolve()
      .then(provision)
      .then(() => {
        provisionRunning = false
        // 「已注册」「已有可用 provider」都算有结论，不再重试；其余状态留着下次事件再试。
        if (provisionState.status === 'registered' || provisionState.status === 'existing') {
          provisionDone = true
          report(`一步到位（${reason}）：${provisionState.detail}`)
        } else if (provisionState.status === 'failed') {
          provisionDone = true
          report(`一步到位（${reason}）：${provisionState.detail}`)
        } else {
          report(`一步到位（${reason}）：${provisionState.detail}`)
        }
      })
      .catch((error) => {
        provisionRunning = false
        provisionState = { status: 'failed', provider: '', detail: String(error?.message ?? error) }
        report(`一步到位（${reason}）：探测阶段异常 —— ${provisionState.detail}`)
      })
  }

  /**
   * 写 provider 时重试一次 —— 只在「revision 冲突」这一种情况下重试。
   *
   * 原来这行是 `const registerProviderWithRetry = registerProvider`，名字里有 Retry
   * 而实现里一次都不重试：启动期 provision 拿到 revision 之后，用户（或另一个窗口）
   * 恰好保存了一次设置，`settings.update` 的 CAS 就失败，一步到位整段放弃，
   * 面板上「先跑通再说」的结果在第一次就固定成 failed。
   *
   * 重试是安全的：registerProvider 每次都重新 describe() 拿最新 revision，
   * 写的是**同一条** provider（键名固定），不会覆盖别人的改动。
   * 其余错误（服务不可用 / 找不到 ns / 已存在）重试也没用，直接抛出。
   */
  const registerProviderWithRetry = async (input) => {
    try {
      return await registerProvider(input)
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!/revision|conflict|冲突|concurrent/i.test(message)) throw error
      report(`写 ${input?.provider ?? '?'} 时撞上 revision 冲突，重读一次再写: ${message}`)
      return await registerProvider(input)
    }
  }

  /**
   * [P2-05-2026-11-26] 「交回后端自己的模板」要真的把旧 compat 删掉。
   *
   * buildProfile({ chatTemplateKwargs: null }) 只是「不写 compat」，而写入走
   * settings.update → mergeLayers：缺键 = 不动 ⇒ 上次写的 compat 一直留着，
   * 用户勾了「用后端模板」却仍在发 chat_template_kwargs。这里补那一步，
   * 失败只 report（配置已经写进去了，不该因为清理残留而整段失败）。
   *
   * @returns {Promise<string>} 一句可以拼进 detail 的补充说明（没事发生时是空串）
   */
  const clearCompatQuietly = async (settings, provider) => {
    try {
      const result = await clearStaleCompat({ settings, provider, ns: LLM_NS })
      if (result.cleared === true) {
        report(`${provider} 上残留的 compat 已清掉（改为交给后端自己的模板）`)
        return '；已清掉旧的 compat'
      }
      if (result.inherited === true) return `；旧的 compat 来自下层配置，删不掉（${result.reason}）`
      if (result.already === true) return ''
      report(`清 ${provider} 的旧 compat 没成 —— ${String(result.reason ?? '原因不明')}`)
      return ''
    } catch (error) {
      report(`清 ${provider} 的旧 compat 失败 —— ${String(error?.message ?? error)}`)
      return ''
    }
  }

  /**
   * 启动期对账的静默包装：出错只写日志，绝不因为对账失败而中断 provision。
   * 返回一句可以拼进 detail 的补充说明（没事发生时是空串）。
   */
  const reconcileQuietly = async () => {
    try {
      const result = await reconcilePanel({ apply: true })
      if (result?.ok !== true) return `；对账跳过（${String(result?.error ?? '原因不明')}）`
      const done = (result.actions ?? []).filter((item) => item.applied === true)
      if (done.length === 0) return ''
      report(`启动对账：${result.message}`)
      return `；对账${result.message}`
    } catch (error) {
      report(`启动对账失败 —— ${String(error?.message ?? error)}`)
      return ''
    }
  }
  /** 已在 llm 目录里的 provider 哪些能连上（只看本地端点）。 */
  const reachableLocalProviders = async (fetchImpl) => {
    const found = []
    let entries = []
    try {
      entries = ctx.get('llm')?.listConfigurableProviders?.() ?? []
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const baseURL = entry?.baseURL ?? entry?.defaultBaseURL ?? entry?.baseUrl
      if (typeof baseURL !== 'string' || !looksLocalUrl(baseURL)) continue
      const probe = await probeEndpoint({ baseURL, fetchImpl, timeoutMs: 2000 })
      if (probe.ok) found.push({ provider: entry.provider, baseURL: probe.baseURL, models: probe.models })
    }
    return found
  }

  const provision = async () => {
    if (provisionConfig === null) return
    const fetchImpl = typeof fetch === 'function' ? fetch : undefined
    if (fetchImpl === undefined) {
      provisionState = { status: 'skipped', provider: '', detail: '运行时不提供 fetch' }
      return
    }

    const existing = await reachableLocalProviders(fetchImpl)
    if (existing.length > 0) {
      const ids = existing.map((item) => item.provider)
      // [explicit-endpoint] 用户明确指定了 endpoint 就必须尊重：
      // 原来只要有一条现成的本地 provider 可达就整段早退，
      // 于是 `provision.endpoint: 'http://127.0.0.1:8081/v1'` 写了等于没写，
      // 配置里连提都不提一句 —— 用户只能看到「已有可用的本地 provider」然后自己去猜。
      const want = typeof provisionConfig.endpoint === 'string' ? normalizeEndpoint(provisionConfig.endpoint) : ''
      const hit = want.length === 0 ? undefined : existing.find((item) => normalizeEndpoint(item.baseURL) === want)
      if (want.length > 0 && hit === undefined) {
        provisionState = {
          status: 'pending-explicit',
          provider: ids[0],
          detail: `已有可用的本地 provider：${ids.join(', ')}；但你指定的 ${want} 现在连不上，这次没写配置`,
        }
        report(`一步到位：指定的 endpoint ${want} 探测失败，保留现有配置不动`)
        return
      }
      // 已经有能连上的本地 provider，不新建任何东西 —— 但要跟后端对一次账：
      // 用户在 Ollama 那边删掉的模型，配置里还挂着的话选择器里就是一条死模型。
      // 对账只做减法（摘死模型 / 全死才删 provider），绝不补模型。
      const reconciled = provisionConfig.reconcile === false ? '' : await reconcileQuietly()
      provisionState = {
        status: 'existing',
        provider: hit?.provider ?? ids[0],
        detail: `已有可用的本地 provider：${ids.join(', ')}（未新建任何配置）` + reconciled,
      }
      return
    }

    const candidate =
      typeof provisionConfig.endpoint === 'string' && provisionConfig.endpoint.trim().length > 0
        ? { endpoint: provisionConfig.endpoint }
        : (() => {
            const list = Array.isArray(provisionConfig.endpoints) && provisionConfig.endpoints.length > 0
              ? provisionConfig.endpoints
              : DEFAULT_ENDPOINTS
            return { endpoints: list }
          })()

    const probe =
      candidate.endpoint !== undefined
        ? await probeEndpoint({ baseURL: candidate.endpoint, fetchImpl, timeoutMs: 3000 })
        : await probeFirstAvailable({ endpoints: candidate.endpoints, fetchImpl, timeoutMs: 2500 })

    if (!probe.ok) {
      const tries = (probe.tried ?? [{ baseURL: probe.baseURL, attempts: probe.attempts }])
        .map((item) => `${item.baseURL || '(空)'}：${(item.attempts ?? []).map((a) => a.reason).join(' / ') || '无响应'}`)
        .join('；')
      provisionState = {
        status: 'none',
        provider: '',
        detail: `没有探测到本地推理服务。试过 ${tries}。启动你的后端，或在 config.provision.endpoint 里指定地址`,
      }
      return
    }

    const providerId = (() => {
      if (typeof provisionConfig.provider === 'string' && provisionConfig.provider.trim().length > 0) {
        return provisionConfig.provider.trim()
      }
      const port = (() => {
        try {
          return new URL(probe.baseURL).port
        } catch {
          return ''
        }
      })()
      const suffix = { '8090': 'llamacpp', '11434': 'ollama', '8000': 'vllm', '1234': 'lmstudio' }[port]
      return suffix !== undefined ? `local-${suffix}` : 'local'
    })()

    const profile = buildProfile({
      provider: providerId,
      baseURL: probe.baseURL,
      models: probe.models,
      ...(typeof provisionConfig.displayName === 'string' ? { displayName: provisionConfig.displayName } : {}),
      ...(Number(provisionConfig.defaultContextWindow) > 0
        ? { defaultContextWindow: Number(provisionConfig.defaultContextWindow) }
        : {}),
      ...(Number(provisionConfig.defaultMaxTokens) > 0
        ? { defaultMaxTokens: Number(provisionConfig.defaultMaxTokens) }
        : {}),
      ...('chatTemplateKwargs' in provisionConfig
        ? { chatTemplateKwargs: provisionConfig.chatTemplateKwargs }
        : {}),
      // 只有用户显式给了凭据引用才写。默认不写 —— 见 buildProfile 里的说明。
      ...(typeof provisionConfig.apiKeyEnv === 'string' && provisionConfig.apiKeyEnv.trim().length > 0
        ? { apiKeyEnv: provisionConfig.apiKeyEnv.trim() }
        : {}),
    })

    const settings = await settingsService()
    let result
    try {
      result = await registerProviderWithRetry({
        settings,
        provider: providerId,
        profile,
        overwrite: provisionConfig.overwrite === true,
      })
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/HMR transactions cannot be nested/i.test(message)) {
        // 热重载场景：留到下一个真实事件（agent/created / tools/change）再写。
        provisionState = {
          status: 'deferred',
          provider: providerId,
          detail: `${probe.baseURL} 可用，等下一个真实请求时写入 ${providerId}（热重载期间不能改配置）`,
        }
        return
      }
      throw error
    }

    if (result.registered) {
      routes.add(providerId)
      forgetBaseUrl(providerId)
      // [P2-05-2026-11-26] 勾了「用后端自己的模板」时，buildProfile 只是不写 compat；
      // 上次写进去的 compat 还留在 settings 里，必须显式删。
      const compatNote =
        provisionConfig.chatTemplateKwargs === null
          ? await clearCompatQuietly(settings, providerId)
          : ''
      // 新 provider 刚上线，已有会话的工具面还没按它算过，补一轮。
      planAll()
      const modelIds = profile.models.map((item) => `${item.id}@${item.contextWindow}`).join(', ')
      provisionState = {
        status: 'registered',
        provider: providerId,
        detail: `${probe.baseURL} → ${providerId}（${modelIds}）。已写入 llm-pi-ai.providers，无需重启；在模型选择器里选 ${providerId}/${profile.models[0]?.id ?? ''}${compatNote}`,
      }
      return
    }

    // 「已存在」不是失败：说明这个 provider 早就配好了，端点也刚探测通过，
    // 正是我们想要的状态，只是不需要写配置。
    if (/已存在/.test(String(result.reason ?? ''))) {
      routes.add(providerId)
      forgetBaseUrl(providerId)
      provisionState = {
        status: 'existing',
        provider: providerId,
        detail: `${probe.baseURL} 已有配置好的 ${providerId}（未覆盖）`,
      }
      return
    }

    provisionState = {
      status: 'failed',
      provider: providerId,
      detail: `${probe.baseURL} 可用，但注册失败：${result.reason ?? '未知原因'}`,
    }
  }

  if (provisionConfig !== null) {
    // 不阻塞插件加载：探测是网络操作，失败了也只是少一行日志。
    runProvisionOnce('启动')
  }

  // ────────────────────── 控制面板：HTTP bridge ──────────────────────
  //
  // client.js 跑在浏览器里，碰不到 cordis 服务，只能走 HTTP。宿主侧在这里
  // 注册 4 条 exact 路由（/api/dsh-local-trim/*），全部同源 + 回环校验。
  //
  // 写配置走 settings.update(ns, patch, revision)：
  //   · ns 是本插件在 cordis.patch.yml 里的条目 id（默认 local-tool-trim）
  //   · 只有 lib/config.js 里声明了 .volatile() 的字段可写，宿主逐路径校验
  //   · 面板请求不在 HMR 激活链上，所以不会撞 "HMR transactions cannot be nested"

  const settingsNamespace = (() => {
    try {
      return ctx.fiber?.entry?.options?.id ?? 'local-tool-trim'
    } catch {
      return 'local-tool-trim'
    }
  })()

  /**
   * 读日志尾部。
   *
   * [log-tail] 原来是一次 `readFileSync(LOG_PATH)` 全量读进来再 slice：
   * 日志上限 2MB 时还好，但用户手改过 LOG_PATH 或轮转没生效、文件涨到几百 MB 时，
   * 面板点一次「看日志」就把整个文件拉进内存再丢掉 99% —— 而且这是**同步**读，
   * 期间整个宿主的事件循环停住。改成按 fd 读最后 N 字节。
   */
  const readLogTail = (bytes) => {
    let fd
    try {
      const size = statSync(LOG_PATH).size
      const want = Math.min(Math.max(0, Number(bytes) || 0), size)
      if (want === 0) return { path: LOG_PATH, bytes: 0, text: '', truncated: size > 0 }
      fd = openSync(LOG_PATH, 'r')
      const buffer = Buffer.allocUnsafe(want)
      const read = readSync(fd, buffer, 0, want, size - want)
      const tail = buffer.subarray(0, read).toString('utf8')
      return { path: LOG_PATH, bytes: read, text: tail, truncated: size > want }
    } catch (error) {
      return { path: LOG_PATH, bytes: 0, text: '', error: String(error?.message ?? error) }
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* 关不掉也没别的办法 */
        }
      }
    }
  }

  const describePanel = async () => {
    const settings = await settingsService()
    const current = read()
    let values = current
    let revision
    let writable = false
    try {
      const row = settings?.describe?.(undefined)?.find?.((item) => item.ns === settingsNamespace)
      if (row !== undefined) {
        revision = row.revision
        writable = true
        values = { ...current, ...resolveConfig(row.value ?? {}) }
      }
    } catch (error) {
      report('控制面板：读取 settings 失败 —— ' + String(error?.message ?? error))
    }
    return {
      values,
      revision,
      writable,
      namespace: settingsNamespace,
      documentPath: (() => {
        try {
          return settings?.documentPath
        } catch {
          return undefined
        }
      })(),
      provision: { status: provisionState.status, provider: provisionState.provider, detail: provisionState.detail },
      routes: routes.values(),
      autoDetect: autoDetect(),
      lightBody: { chars: currentInject().length, source: injectSource },
      logPath: LOG_PATH,
      // 顺手把三个集合算一遍，保证 lastLegacy 是最新的（面板要据此显示「这套值是旧默认值」）。
      legacy: (() => {
        keepSet()
        dropSectionSet()
        dropContextSet()
        return {
          keep: lastLegacy.keep,
          dropSections: lastLegacy.dropSections,
          dropContexts: lastLegacy.dropContexts,
        }
      })(),
    }
  }

  const savePanel = async (patch, revision) => {
    const settings = await settingsService()
    if (settings?.update === undefined) return { saved: false, error: 'settings 服务不可用' }
    const rows = settings.describe?.(undefined) ?? []
    const row = rows.find((item) => item.ns === settingsNamespace)
    if (row === undefined) {
      return {
        saved: false,
        error:
          '设置条目 "' +
          settingsNamespace +
          '" 还没有可写字段。装完插件后请重启一次 DSH（或热重载），让它读到 Config。',
      }
    }
    const expected = Number.isInteger(revision) ? revision : row.revision
    try {
      await settings.update(settingsNamespace, patch, expected)
    } catch (error) {
      const text = String(error?.message ?? error)
      // 这台机器的插件配置整段写在 profile 的 cordis.patch.yml（home patch 层）。
      // settings.update 要求「合成后的 config 与我要写的完全一致」，而 patch 里还有
      // routes / dropSections 这些面板不负责的键，于是整段写入会被拒。这不是配错了，
      // 是层级问题：要么改那一层文件，要么让面板接管。
      if (/overridden by a home patch|command-line overlay/i.test(text)) {
        return {
          saved: false,
          error:
            '这份配置整段来自 profile 的 cordis.patch.yml（home patch 层），面板不能整段覆盖。' +
            '两条路：① 直接改那个文件里 ' + settingsNamespace + '.config 的对应键；' +
            '② 把 patch 里这个插件的 config 段删掉，重启后面板就能接管。',
          documentPath: (() => {
            try {
              return settings.documentPath
            } catch {
              return undefined
            }
          })(),
        }
      }
      return { saved: false, error: text }
    }
    baseUrlCache.clear()
    // [scoped-clear] 用户可能就是来修「某个工具名写错了导致 restrict 整批被拒」的：
    // 修好之后必须给这个名字一次重新尝试的机会，否则它永远是「学到的非全局名」，
    // 面板上保留着它、日志里只说「剔除非全局名」，谁都看不出是被永久拉黑了。
    scopedNames.clear()
    // 面板可能刚改了 routes / keep / dropSections，立刻重算一遍工具面。
    planAll()
    // [revision-after] `row.revision + 1` 是猜的：settings.update 期间别人也可能写一次，
    // 或者宿主对一次 update 推进不止一格。猜错的后果是面板下一次保存拿着过期 revision
    // 撞 CAS（用户看到「revision 冲突」却什么都没同时改）。回读一次，拿不到才退回 +1。
    let nextRevision = row.revision + 1
    try {
      const after = settings.describe?.().find((item) => item?.ns === settingsNamespace)
      if (Number.isInteger(after?.revision)) nextRevision = after.revision
    } catch {
      /* 拿不到就用推测值，面板下次保存时服务端会再校验一次 */
    }
    return { saved: true, values: resolveConfig(read()), revision: nextRevision }
  }

  const probePanel = async (input) => {
    const fetchImpl = typeof fetch === 'function' ? fetch : undefined
    if (fetchImpl === undefined) return { ok: false, error: '运行时不提供 fetch' }
    const endpoints =
      Array.isArray(input?.endpoints) && input.endpoints.length > 0 ? input.endpoints : DEFAULT_ENDPOINTS
    const timeoutMs = Number.isInteger(input?.timeoutMs) ? input.timeoutMs : 2500
    if (typeof input?.endpoint === 'string' && input.endpoint.trim().length > 0) {
      const single = await probeEndpoint({ baseURL: input.endpoint, fetchImpl, timeoutMs })
      return {
        ok: single.ok,
        results: [
          {
            baseURL: single.baseURL || normalizeEndpoint(input.endpoint),
            ok: single.ok,
            models: single.models ?? [],
            attempts: single.attempts ?? [],
          },
        ],
      }
    }
    // [probe-parallel] 四个预置端点原来是 for-await 串行，最坏 4 × 2500ms = 10s，
    // 面板点一下「探测」就转十秒 —— 而这几条探测彼此独立，纯粹在等超时。
    // 并发发出去，最坏只等一个 timeoutMs。probeEndpoint 自己兜住了网络异常
    // （失败也返回 {ok:false} 而不是抛），这里再加一层 catch 防注入实现漏抛。
    // 去重：用户把 endpoints 写成重复值时别对同一个地址发两遍。
    const targets = []
    const seenTargets = new Set()
    for (const endpoint of endpoints) {
      const key = normalizeEndpoint(endpoint)
      if (key.length === 0 || seenTargets.has(key)) continue
      seenTargets.add(key)
      targets.push(endpoint)
    }
    const results = await Promise.all(
      targets.map(async (endpoint) => {
        try {
          const probe = await probeEndpoint({ baseURL: endpoint, fetchImpl, timeoutMs })
          return {
            baseURL: probe.baseURL || normalizeEndpoint(endpoint),
            ok: probe.ok,
            models: probe.models ?? [],
            attempts: probe.attempts ?? [],
          }
        } catch (error) {
          return {
            baseURL: normalizeEndpoint(endpoint),
            ok: false,
            models: [],
            attempts: [],
            error: String(error?.message ?? error),
          }
        }
      }),
    )
    return { ok: results.some((item) => item.ok), results }
  }

  // ───────────────────── 面板：状态 / 点灯 / 导入 / 试跑 ─────────────────────

  const LLM_NS = 'llm-pi-ai'
  const onlineCache = new Map()
  const ONLINE_TTL_MS = 15_000

  const runtimeFetch = () => (typeof fetch === 'function' ? fetch : undefined)

  /**
   * 取某个 profile 声明的那条凭据的值，用来给试跑请求带上 Authorization。
   * 不写死变量名：profile 里声明了 `apiKeyEnv` 才去找，找不到就返回 undefined
   * （本地后端本来就不需要 key，硬塞假 Bearer 反而会让开了 --api-key 的后端 401）。
   */
  const apiKeyForProfile = async (profile) => {
    const ref = profile?.apiKeyEnv
    if (typeof ref !== 'string' || ref.trim().length === 0) return undefined
    const name = ref.trim()
    try {
      const credentials = ctx.get('credentials')
      const hit = credentials === undefined ? undefined : await credentials.resolve(name)
      const value = hit?.value
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // 凭据服务不可用就退回环境变量
    }
    try {
      const value = globalThis.process?.env?.[name]
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  /** 从 settings 里读出 llm-pi-ai 的 provider 表：[{ id, profile }]。 */
  const readLlmProviders = async () => {
    const settings = await settingsService()
    let rows = []
    try {
      rows = settings?.describe?.(undefined) ?? []
    } catch {
      return []
    }
    const row = rows.find?.((item) => item?.ns === LLM_NS)
    const providers = row?.value?.providers
    if (providers === null || typeof providers !== 'object') return []
    return Object.entries(providers).map(([id, profile]) => ({ id, profile: profile ?? {} }))
  }

  /**
   * 给本地 provider 点灯：GET /v1/models，15 秒内复用上一次结果。
   *
   * 并发跑。原来是 `for (const entry of providers) { await probeEndpoint(...) }`，
   * 串行点灯 —— 4 个本地 provider 各自连不上的时候要干等 4 × 1.5s，面板转圈六秒。
   * 现在按 6 路并发（再多也没意义：本机通常就那么几个 provider），
   * 同时给每个 provider 单独兜住异常，一个炸了不影响别人点灯。
   */
  const CHECK_CONCURRENCY = 6
  const checkPanel = async (input = {}) => {
    const fetchImpl = runtimeFetch()
    const providers = Array.isArray(input?.providers) && input.providers.length > 0
      ? input.providers
      : await readLlmProviders()
    const force = input?.force === true
    const timeoutMs = Number.isInteger(input?.timeoutMs) ? input.timeoutMs : 1500
    const now = Date.now()
    const online = {}

    const targets = []
    for (const entry of providers) {
      const id = String(entry?.id ?? '')
      if (id.length === 0) continue
      const baseURL = String(entry?.profile?.baseURL ?? '')
      if (!isLocalProvider(id, baseURL)) continue
      const cached = onlineCache.get(id)
      if (!force && cached !== undefined && now - cached.at < ONLINE_TTL_MS) {
        online[id] = { ok: cached.ok, ms: cached.ms, error: cached.error, models: cached.models }
        continue
      }
      targets.push({ id, baseURL })
    }

    const light = async ({ id, baseURL }) => {
      if (fetchImpl === undefined || baseURL.length === 0) {
        const value = { ok: false, ms: 0, error: baseURL.length === 0 ? '没有 baseURL' : '运行时不提供 fetch' }
        onlineCache.set(id, { ...value, at: now })
        online[id] = value
        return
      }
      const startedAt = Date.now()
      let probe
      try {
        probe = await probeEndpoint({ baseURL, fetchImpl, timeoutMs })
      } catch (error) {
        probe = { ok: false, error: String(error?.message ?? error) }
      }
      const value = {
        ok: probe.ok === true,
        ms: Date.now() - startedAt,
        // 后端此刻**真的有**哪些模型。这条信息原来拿到了又被扔掉，面板只好显示
        // 配置里的声明数 —— 用户 `ollama rm` 之后声明还在，面板照旧写「5 模型」，
        // 于是一屏僵尸。带上清单，面板才能跟配置求差；连 contextWindow 一起留着，
        // 「对齐」时新补进来的模型才不会丢掉上下文长度。
        ...(probe.ok === true
          ? {
              models: (probe.models ?? [])
                .map((model) => ({ id: String(model?.id ?? ''), contextWindow: Number(model?.contextWindow) || 0 }))
                .filter((model) => model.id.length > 0),
            }
          // attempts 里放的是 `reason`（`ECONNREFUSED` / `status 404` / `no models listed`），
          // 原来读的是 `error` —— 那个键不存在，于是每一行都只写「连不上：连不上」。
          : { error: probe.attempts?.[0]?.reason ?? probe.error ?? '连不上' }),
      }
      onlineCache.set(id, { ...value, at: now })
      online[id] = value
    }

    for (let index = 0; index < targets.length; index += CHECK_CONCURRENCY) {
      await Promise.all(targets.slice(index, index + CHECK_CONCURRENCY).map(light))
    }
    return { online, checkedAt: now }
  }

  /** 面板主视图：接管状态 + 最近一次裁剪收益 + provider 表。 */
  /**
   * 每个 provider 声明的凭据引用是否真的能解析到值。
   * 宿主对「声明了 ref 但解析不到」的处理是抛 MISSING_CREDENTIAL，llm-pi-ai 的 listModels
   * 把它吞成空数组，模型目录再过滤掉空组 —— 用户在模型选择器里只会看到「没有这个 provider」，
   * 完全看不到原因。这里把状态取出来，让面板替他说话。
   */
  const credentialStates = async (providers) => {
    const out = {}
    let credentials
    try {
      credentials = ctx.get('credentials')
    } catch {
      credentials = undefined
    }
    for (const entry of Array.isArray(providers) ? providers : []) {
      const ref = entry?.profile?.apiKeyEnv
      if (typeof ref !== 'string' || ref.trim().length === 0) continue
      const name = ref.trim()
      let configured
      try {
        const described = credentials === undefined ? undefined : await credentials.describe(name)
        configured = described?.configured === true
      } catch {
        configured = undefined
      }
      if (configured !== true) {
        try {
          const value = globalThis.process?.env?.[name]
          if (typeof value === 'string' && value.length > 0) configured = true
        } catch {
          // 读不到环境变量就维持原判断
        }
      }
      out[String(entry?.id ?? '')] = { ref: name, configured }
    }
    return out
  }

  const statusPanel = async (input = {}) => {
    const base = await describePanel()
    const providers = await readLlmProviders()
    let online = {}
    if (input?.online !== false) {
      try {
        online = (await checkPanel({ providers, force: input?.force === true })).online
      } catch (error) {
        report('控制面板：点灯失败 —— ' + String(error?.message ?? error))
      }
    }
    return {
      status: {
        ...buildPanelStatus({
          takeover: takeoverState,
          values: base.values,
          trim: lastTrim,
          lightBody: base.lightBody,
          provision: base.provision,
          providers,
          credentials: await credentialStates(providers),
          online,
          revision: base.revision,
          writable: base.writable,
          logPath: base.logPath,
          clientHost,
          legacy: base.legacy,
        }),
        // 面板要显示「哪些端口上是我起的后端」，好给「停止」按钮。
        launched: launchedList(),
      },
      values: base.values,
      revision: base.revision,
      writable: base.writable,
    }
  }

  /**
   * 导入一个本地模型：探测端点 → 挑模型 → 写进 llm-pi-ai providers → 立刻试跑一次。
   * 试跑失败不回收配置：配置已经落地，面板会显示「导入成功但试跑失败」+ 后端原文，
   * 用户改完端点或拉起后端后点「试跑」就行，不用重新导入。
   */
  const importPanel = async (input = {}) => {
    const fetchImpl = runtimeFetch()
    if (fetchImpl === undefined) return { ok: false, error: '运行时不提供 fetch' }
    const parsed = parseImportInput(input)
    if (parsed.ok !== true) return { ok: false, error: parsed.error }

    const probe = await probeEndpoint({ baseURL: parsed.endpoint, fetchImpl, timeoutMs: 4000 })
    const attempts = probe.attempts ?? []
    if (probe.ok !== true) {
      return {
        ok: false,
        endpoint: parsed.endpoint,
        error: `连不上 ${parsed.endpoint}`,
        attempts,
      }
    }
    const picked = pickModel(probe.models ?? [], parsed.model)
    if (picked === undefined) {
      const live = (probe.models ?? []).map((model) => model.id)
      // [P2-12-2026-11-26] 原来只说「端点里没有模型 X」——X 是**用户写的**那个名字，
      // 但读的人以为 X 是后端报的名字，于是去后端里找一个根本不存在的 id。
      // 把两侧都摆出来：你写的是什么、后端实际报了什么。
      const wanted = String(parsed.model ?? '').trim()
      const said = wanted.length === 0 ? '' : `你写的是 "${wanted}"，`
      return {
        ok: false,
        endpoint: probe.baseURL || parsed.endpoint,
        error:
          live.length === 0
            ? `${said}但这个端点一个模型都没报（后端刚起来还没加载完？）`
            : `${said}后端报的是 ${live.join(', ')} —— 名字对不上，改成一个上面列出的 id`,
        models: live,
        attempts,
      }
    }

    const endpoint = probe.baseURL || parsed.endpoint
    // 同一后端只该有一条 provider。用户没指定 provider id 时（id 是我们按端口 + 模型名
    // 猜的），先看这个端点是不是已经有一条 `local-<后端>` —— 有就把模型追进去，
    // 而不是再长出一条单模型 provider。历史上每导入一次就多一条，面板上半截因此越拉越长。
    const providersNow = await readLlmProviders()
    const reusable = parsed.explicitProvider === true
      ? undefined
      : findReusableProvider(providersNow, endpoint, backendFor(endpoint, picked.id))
    // [no-wipe] 用户显式指定了 provider id + 勾了「覆盖」时，原路径会用
    // buildImportProfile 造一个**只含本次那一个模型**的 profile，而 settings.update
    // 走 mergeLayers 对数组是整体替换 —— 那条 provider 下原有的 N 个模型一键消失。
    // 显式指定 id 的本意是「改写这条」，不是「删掉它其余的模型」。
    const explicitTarget =
      parsed.explicitProvider === true
        ? providersNow.find((entry) => String(entry?.id ?? '') === parsed.provider)
        : undefined
    const explicitAppended =
      explicitTarget === undefined
        ? undefined
        : appendModelToProfile({
            profile: explicitTarget.profile,
            modelId: picked.id,
            contextWindow: picked.contextWindow,
            maxTokens: picked.maxTokens ?? parsed.maxTokens,
          })
    if (explicitAppended !== undefined && explicitAppended.ok !== true) {
      return { ok: false, endpoint, error: explicitAppended.error }
    }
    const appended = reusable === undefined
      ? undefined
      : appendModelToProfile({
          profile: reusable.profile,
          modelId: picked.id,
          contextWindow: picked.contextWindow,
          maxTokens: picked.maxTokens ?? parsed.maxTokens,
        })
    if (appended !== undefined && appended.ok !== true) {
      return { ok: false, endpoint, error: appended.error }
    }

    const providerId = reusable === undefined ? parsed.provider : reusable.id
    const profile =
      explicitAppended !== undefined && explicitAppended.changed === true
        ? { ...explicitAppended.profile }
        : appended !== undefined && appended.changed === true
          ? appended.profile
          : buildImportProfile({ ...parsed, model: picked.id }, { ...probe, ...picked })
    const settings = await settingsService()
    let registered = false
    let reason = ''
    try {
      const result = await registerProvider({
        settings,
        provider: providerId,
        profile,
        ns: LLM_NS,
        // 复用/改写已有条目时它必然「已存在」，不 overwrite 就会被 registerProvider 挡回去。
        overwrite:
          parsed.overwrite === true ||
          (reusable !== undefined && appended?.changed === true) ||
          (explicitTarget !== undefined && explicitAppended?.changed === true),
      })
      registered = result?.registered === true
      reason = String(result?.reason ?? '')
    } catch (error) {
      return { ok: false, error: '写入 settings 失败：' + String(error?.message ?? error) }
    }

    // [P2-05-2026-11-26] import 路径同理：thinking=true → buildImportProfile 传 null
    // = 「不写 compat」，而上次留下的 compat 不会因为「不写」而消失。
    const compatNote =
      parsed.thinking === true ? await clearCompatQuietly(settings, providerId) : ''

    const smoke = await smokeTest({
      fetchImpl,
      baseURL: profile.baseURL,
      model: picked.id,
      apiKey: await apiKeyForProfile(profile),
      timeoutMs: smokeTimeoutMs(),
      chatTemplateKwargs: profile.compat?.chatTemplateKwargs,
      maxTokens: 64,
    })
    onlineCache.delete(providerId)
    baseUrlCache.clear()
    planAll()

    return {
      ok: true,
      endpoint,
      provider: providerId,
      model: picked.id,
      models: (probe.models ?? []).map((model) => model.id),
      registered,
      // 面板要能说清「这次是新建了一条，还是把模型追加进了已有那条」——
      // 不说清的话用户会以为又长出一条 provider，然后去手动删。
      ...(reusable !== undefined
        ? {
            reused: providerId,
            ...(appended?.changed === true ? { appended: picked.id } : { alreadyThere: true }),
          }
        : {}),
      ...(reason.length > 0 ? { reason } : {}),
      ...(compatNote.length > 0 ? { compatNote } : {}),
      summary: summarizeProvider(providerId, profile),
      smoke,
    }
  }

  /**
   * 「试跑」一轮请求的超时（毫秒）。端口通了不等于能出字 —— 第一次请求常常还在把
   * 权重读进内存，大模型冷加载比之后每次慢一个数量级，所以默认给 60 秒且可配。
   * 和 launchTimeout 一样上下都夹：太短一定假失败，太长用户以为卡死。
   */
  const smokeTimeoutMs = () => {
    const raw = Number(resolveConfig(config).smokeTimeout)
    return (Number.isFinite(raw) ? Math.min(Math.max(raw, 5), 600) : 60) * 1000
  }

  /** 对已经注册的 provider 跑一次最小真实请求（面板上的「试跑」按钮）。 */
  const testPanel = async (input = {}) => {
    const fetchImpl = runtimeFetch()
    if (fetchImpl === undefined) return { ok: false, error: '运行时不提供 fetch' }
    const provider = String(input?.provider ?? '').trim()
    if (provider.length === 0) return { ok: false, error: '先选一个 provider' }
    const providers = await readLlmProviders()
    const entry = providers.find((item) => item.id === provider)
    if (entry === undefined) return { ok: false, error: `settings 里没有 provider "${provider}"` }
    const models = Array.isArray(entry.profile?.models) ? entry.profile.models : []
    const model = String(input?.model ?? models[0]?.id ?? '').trim()
    if (model.length === 0) return { ok: false, error: `provider "${provider}" 没有配模型` }
    const smoke = await smokeTest({
      fetchImpl,
      baseURL: String(entry.profile?.baseURL ?? ''),
      model,
      apiKey: await apiKeyForProfile(entry.profile),
      timeoutMs: Number.isInteger(input?.timeoutMs) ? input.timeoutMs : smokeTimeoutMs(),
      // 已注册 provider 的 compat 里带过来的思考开关，试跑时照样应用，
      // 否则面板上点「试跑」看到的是空 content（token 全花在 reasoning 上）。
      chatTemplateKwargs: entry.profile?.compat?.chatTemplateKwargs,
      maxTokens: 64,
    })
    onlineCache.delete(provider)
    return { ok: smoke.ok === true, provider, model, smoke }
  }

  /**
   * 面板上的「本机模型」：把磁盘上已下好的 gguf 列出来。
   * 这是「下好就能用」的第一步 —— 先让用户看见模型，再用它去起服务。
   */
  // 显存只问一次并缓存：nvidia-smi 是子进程，modelsPanel 每个模型都问一遍太浪费。
  // 缓存 60 秒（显存会被别的程序占用，但总量基本不变，问的是 memory.total）。
  let gpuBytesCache = { info: null, at: 0 }
  const gpuInfo = () => {
    const now = Date.now()
    if (gpuBytesCache.info !== null && now - gpuBytesCache.at < 60_000) return gpuBytesCache.info
    const info = detectGpuInfo()
    gpuBytesCache = { info, at: now }
    return info
  }
  const gpuBytes = () => gpuInfo().bytes

  // [P1-21-2026-11-25] 这个面板是「本机模型」的粗略预检，但它原来完全不管加载模式：
  // checkModelFit 拿不到 loadMode 就按 mmap（会走 page cache、可回收）算，
  // 而用户在同一条模型上点「采用」时选的是 none/mlock（锁进内存、不可回收），
  // 于是列表里绿油油、采用时才被告知装不下 —— 同一份数据两个答案。
  // 现在把 loadMode 从桥接层透进来，两边用同一个口径。
  const modelsPanel = async (input = {}) => {
    const loadMode = normalizeLoadMode(input?.loadMode)
    const dirs = modelDirsForPanel()
    const list = scanLocalModels({ depth: 2, dirs })
    const reserveBytes = reserveBytesOf()
    const gpu = gpuInfo()
    return {
      ok: true,
      dirs,
      truncated: list.truncated === true,
      scannedEntries: list.scannedEntries ?? 0,
      // 真读了几个文件的 GGUF KV（按体积降序取前 N 个）。面板不用显示，但排障要能看见：
      // 用户问「为什么这个没名字」时，先看它是超了上限还是元数据里本来就没 general.name。
      metaReads: list.metaReads ?? 0,
      // 哪些目录没读成、为什么（EACCES / EPERM / 名字非法…）。空列表和「读不到」
      // 在面板上都长成「一个模型都没有」，不说清楚用户会以为插件没扫对地方。
      dirErrors: Array.isArray(list.dirErrors) ? list.dirErrors : [],
      gpu,
      totalMemBytes: totalmem(),
      freeMemBytes: freemem(),
      reserveBytes,
      models: list.map((item) => ({
        path: item.path,
        name: item.name,
        dir: item.dir,
        sizeBytes: item.sizeBytes,
        mmproj: item.mmproj,
        // 来源与可读名：面板要靠这些区分「一个 15.8G 的 gguf」和「ollama 里的 qwen3:14b」。
        // blob 的文件名是 sha256-…，不给 tags/readableName 的话用户看见的就是一串摘要。
        source: item.source ?? 'local',
        origin: item.origin ?? 'local',
        tags: Array.isArray(item.tags) ? item.tags : [],
        readableName: item.readableName ?? item.name,
        ...(item.engine === undefined ? {} : { engine: item.engine }),
        ...(item.port === undefined ? {} : { port: item.port }),
        ...(item.quantization === undefined ? {} : { quantization: item.quantization }),
        ...(item.architecture === undefined ? {} : { architecture: item.architecture }),
        ...(item.modelName === undefined ? {} : { modelName: item.modelName }),
        ...(item.contextLength === undefined ? {} : { contextLength: item.contextLength }),
        ...(item.sizeLabel === undefined ? {} : { sizeLabel: item.sizeLabel }),
        // [shard-visible] 分片模型在面板上要说清楚「这是 4 片里的第一片，体积是总和」，
        // 否则用户会拿 16GB 的文件去和 4GB 的 free 比，觉得数字不对。
        ...(item.shardCount === undefined ? {} : { shardCount: item.shardCount }),
        // general.name 的整串（常常带内部编号），面板拿它做悬停详情，不当显示名
        ...(item.fullName === undefined ? {} : { fullName: item.fullName }),
        fit: checkModelFit({
          sizeBytes: item.sizeBytes,
          // 面板这一列是「这个文件起得来吗」的粗略答案：上下文按 llama.cpp 的默认
          // -c 65536 算 KV cache。维度来自 gguf 自己的 KV（decorateWithGgufMeta 读的），
          // 读不到就是 0，此时等同于只看权重 —— 不拿猜的数把用户吓退。
          kvBytes: estimateKvBytes({
            blockCount: item.blockCount,
            embeddingLength: item.embeddingLength,
            headCount: item.headCount,
            headCountKv: item.headCountKv,
            contextTokens: item.contextLength > 0 ? item.contextLength : 65536,
          }),
          totalMemBytes: totalmem(),
          freeMemBytes: freemem(),
          gpuBytes: gpu.bytes,
          reserveBytes,
          unified: gpu.unified === true,
          // 同一口径：采用时按哪种加载模式起，列表这里就按哪种算。
          loadMode,
        }),
      })),
    }
  }

  /**
   * 删一条 provider 配置（面板上的删除键）。
   *
   * 注意删的是 **settings 里的那一条 llm-pi-ai.providers[<id>]**，不是磁盘上的 gguf。
   * 权重文件是你的，插件没有理由替你删；僵尸的是配置 —— 比如指向一个从没起来过的
   * 端口、或者同一个端口注册了两遍的那几条。
   *
   * 三件面板相关的事：
   *   1. 先记下它指向哪、有几个模型，回给面板做「删了就是这个后果」的说明；
   *   2. 删成功后清在线缓存与 baseURL 缓存，否则刚删完路由判定还拿旧地址；
   *   3. 删不掉（继承自下层 patch）要如实说，不能凭 promise 成功就报成功。
   */
  const deletePanel = async (input = {}) => {
    const provider = String(input?.provider ?? input?.id ?? '').trim()
    if (provider.length === 0) {
      return { ok: false, error: '要说清删哪个 provider（传 provider 或 id）' }
    }
    const settings = await settingsService()
    // 删之前先记下这条长什么样：删完就读不到了，而面板要靠它说「你删掉的是这些」。
    const before = (await readLlmProviders()).find((entry) => entry?.id === provider)
    const result = await unregisterProvider({ settings, provider, ns: LLM_NS })
    if (result.removed !== true) {
      return { ok: false, provider, inherited: result.inherited === true, error: String(result.reason ?? '删不掉') }
    }

    onlineCache.delete(provider)
    baseUrlCache.clear()
    // [ghost-route] 自动注册时会 routes.add(providerId)，但删掉的路径上从来没有
    // routes.delete —— dynamicRoutes 只增不减，于是「删掉 provider」之后那条名字
    // 仍然算生效路由：面板列表里它一直挂着、isLocalRoute 也会为它返回 true。
    // 名字还在、provider 却没了，等于给一个不存在的后端留了张永久通行证。
    routes.delete(provider)
    planAll()
    const summary = before === undefined ? '' : summarizeProvider(provider, before.profile ?? {})
    report(`面板删除 provider ${provider}`)
    return {
      ok: true,
      provider,
      already: result.already === true,
      summary,
      message:
        (result.already === true ? `${provider} 本来就不在，没动` : `已删除 provider ${provider}`) +
        '；磁盘上的 gguf 没动，随时可以再导入',
    }
  }

  /**
   * 把一条 provider 的 models 对齐到后端此刻真的有的那份清单。
   *
   * 面板上那条「5 模型 · 2 个已不在后端」的警告，要有一个按钮把它变成动作：
   * 否则用户看到红字只能自己去翻 cordis.patch.yml。这里做的事很小 —— 探测一次、
   * 算差集、把新的 models 数组写回去，不动 baseURL / displayName / compat 这些
   * 用户自己的设置。判活跟面板用同一个 `sameModel`，所以面板标红几条这里就改几条。
   *
   * 写回为什么是安全的：`settings.update` 走 `mergeLayers`，它对数组是**整体替换**，
   * 所以新的 models 数组会原样覆盖旧的，不会跟旧的按索引合并出奇怪的结果。
   *
   * 全部模型都不在时**不动**：把 models 改成空数组在 llm-pi-ai 里是配置错误，
   * 不是「停用」。那种情况该做的是删 provider（面板上有删除键），所以直接说清楚。
   */
  const alignPanel = async (input = {}) => {
    const provider = String(input?.provider ?? input?.id ?? '').trim()
    if (provider.length === 0) {
      return { ok: false, error: '要说清对齐哪个 provider（传 provider 或 id）' }
    }
    const settings = await settingsService()
    const before = (await readLlmProviders()).find((entry) => entry?.id === provider)
    if (before === undefined) {
      return { ok: false, provider, error: `settings 里没有 provider "${provider}"，先刷新面板` }
    }
    const profile = before.profile ?? {}
    const baseURL = String(profile.baseURL ?? '')
    if (baseURL.length === 0) {
      return { ok: false, provider, error: '这条 provider 没有 baseURL，没法问后端有哪些模型' }
    }

    const fetchImpl = runtimeFetch()
    if (fetchImpl === undefined) {
      return { ok: false, provider, error: '运行时不提供 fetch' }
    }
    const probe = await probeEndpoint({ baseURL, fetchImpl, timeoutMs: 4000 })
    if (probe.ok !== true) {
      // 连不上就不改配置：探测失败跟「后端一个模型都没有」是两回事，
      // 这时候对齐会把整条 provider 的模型清空 —— 那是数据丢失，不是对齐。
      const reason = probe.attempts?.[0]?.reason ?? probe.error ?? '连不上'
      return { ok: false, provider, error: `后端连不上（${reason}），配置没动` }
    }

    const declared = Array.isArray(profile.models) ? profile.models : []
    // llama.cpp 的 /v1/models 只报当前加载的那一个模型，「没在清单里」不等于「没装」，
    // 所以对它禁止摘除（对账路径早就有这层保护，对齐路径原来漏了）。
    const backend = backendFor(baseURL, '')
    const enumeratesAll =
      probe.via === 'ollama' || backend === 'ollama' || backend === 'vllm' || backend === 'lmstudio'
    const plan = planAlign({
      declared,
      live: probe.models ?? [],
      fallbackMaxTokens: Number(profile.defaultMaxTokens) || 0,
      allowRemoval: enumeratesAll,
    })
    if (plan.ok !== true) return { ok: false, provider, error: plan.error }
    if (plan.changed !== true) {
      return {
        ok: true,
        provider,
        changed: false,
        kept: plan.kept,
        removed: [],
        added: [],
        message:
          `${provider} 的 ${plan.models.length} 个模型跟后端一致，没动` +
          (enumeratesAll ? '' : '（这个后端只报当前加载的模型，没做摘除）'),
      }
    }

    const next = { ...profile, models: plan.models }
    // [cas-guard] revision 取不到就不写：settings 的 undefined expected 会跳过并发校验。
    const expected = await llmRevision(settings)
    if (expected === undefined) {
      return { ok: false, provider, error: '拿不到 llm-pi-ai 的当前 revision，为避免覆盖别人的改动，这次没写' }
    }
    try {
      await settings.update(LLM_NS, { providers: { [provider]: next } }, expected)
    } catch (error) {
      return { ok: false, provider, error: String(error?.message ?? error) }
    }

    // 写完立刻作废两处缓存：在线结果里带着旧的模型清单（15 秒 TTL），
    // 不踢掉的话面板刷新后还是旧的红字，用户会以为没生效。
    onlineCache.delete(provider)
    baseUrlCache.clear()
    planAll()
    report(`面板对齐 provider ${provider}：摘掉 ${plan.removed.length} 条，补上 ${plan.added.length} 条`)
    return {
      ok: true,
      provider,
      changed: true,
      kept: plan.kept,
      removed: plan.removed,
      added: plan.added,
      message:
        `已对齐 ${provider}：` +
        (plan.removed.length > 0 ? `摘掉 ${plan.removed.length} 条（${plan.removed.join(', ')}）` : '没摘条目') +
        (plan.added.length > 0 ? `，补上 ${plan.added.length} 条（${plan.added.join(', ')}）` : '') +
        (plan.kept.length > 0 ? `，保留 ${plan.kept.length} 条` : ''),
    }
  }

  /**
   * 对账：把「后端已经没有的模型」从 provider 里摘掉，一条都不剩时整条 provider 也删掉。
   *
   * 跟「对齐」的区别：对齐是用户点按钮说「我要这份清单跟后端一样」，所以活的还会补进来；
   * 对账是维护动作，只做减法 —— 悄悄往 provider 里加模型等于替用户改模型选择器。
   *
   * 三条铁律：
   *   1. 探测失败一律不动。连不上跟「后端一个模型都没有」是两回事，混了就是数据丢失。
   *   2. 只对「会把装了的模型全报出来」的后端动手。llama.cpp 只报当前加载的那一个，
   *      它说「只有 A」可能只是没加载 B —— 这时候摘模型是错的，宁可跳过。
   *   3. 只碰本地 provider。云端的模型清单不归这里管，也没有「本机删了模型」这回事。
   */
  const reconcilePanel = async (input = {}) => {
    const only = String(input?.provider ?? input?.id ?? '').trim()
    // [apply-default] 默认必须是「只报告」。这个函数从 bridge 的 HTTP 路由直接暴露，
    // 缺省即写配置（还可能是删 provider）等于一个 GET 式请求就能毁掉配置；
    // 面板上要写就显式传 apply: true。
    const apply = input?.apply === true
    const settings = await settingsService()
    const providers = await readLlmProviders()
    const fetchImpl = runtimeFetch()
    if (fetchImpl === undefined) return { ok: false, error: '运行时不提供 fetch' }

    const targets = providers.filter((entry) => {
      const id = String(entry?.id ?? '')
      if (id.length === 0) return false
      if (only.length > 0 && id !== only) return false
      return isLocalProvider(id, String(entry?.profile?.baseURL ?? ''))
    })
    if (only.length > 0 && targets.length === 0) {
      return { ok: false, provider: only, error: `settings 里没有本地 provider "${only}"` }
    }

    const actions = []
    let changed = false
    for (const entry of targets) {
      const provider = String(entry?.id ?? '')
      const profile = entry?.profile ?? {}
      const baseURL = String(profile.baseURL ?? '')
      if (baseURL.length === 0) {
        actions.push({ provider, action: 'skip', reason: '没有 baseURL' })
        continue
      }
      const probe = await probeEndpoint({ baseURL, fetchImpl, timeoutMs: 4000 })
      if (probe.ok !== true) {
        const reason = probe.attempts?.[0]?.reason ?? probe.error ?? '连不上'
        actions.push({ provider, action: 'skip', reason: `后端连不上（${reason}），没动` })
        continue
      }
      // 一次只报当前加载模型的后端（llama.cpp）分不清「没装」和「没加载」。
      const backend = backendFor(baseURL, '')
      const enumeratesAll = probe.via === 'ollama' || backend === 'ollama' || backend === 'vllm' || backend === 'lmstudio'
      if (!enumeratesAll) {
        actions.push({ provider, action: 'skip', reason: `${backend || '这个'} 后端只报当前加载的模型，分不清「没装」和「没加载」，没动` })
        continue
      }

      const declared = Array.isArray(profile.models) ? profile.models : []
      const plan = planReconcile({ declared, live: probe.models ?? [] })
      if (plan.ok !== true) {
        actions.push({ provider, action: 'skip', reason: plan.error })
        continue
      }
      if (plan.action === 'keep') {
        actions.push({ provider, action: 'keep' })
        continue
      }
      if (apply !== true) {
        actions.push({ provider, action: plan.action, removed: plan.removed, applied: false })
        continue
      }
      if (plan.action === 'prune') {
        // [cas-guard] 每条 provider 单独取 revision（前一条的写入会推进它），
        // 取不到就不写 —— 见 llmRevision 的说明。
        const expected = await llmRevision(settings)
        if (expected === undefined) {
          actions.push({ provider, action: 'skip', reason: '拿不到 llm-pi-ai 的当前 revision，没敢写' })
          continue
        }
        try {
          await settings.update(LLM_NS, { providers: { [provider]: { ...profile, models: plan.models } } }, expected)
        } catch (error) {
          actions.push({ provider, action: 'skip', reason: String(error?.message ?? error) })
          continue
        }
        changed = true
        actions.push({ provider, action: 'prune', removed: plan.removed, applied: true })
        report(`对账 provider ${provider}：后端没有 ${plan.removed.join(', ')}，已摘掉`)
        continue
      }
      // action === 'remove'：一个都不剩了。删 provider 是破坏性动作，只在这里做一次。
      const result = await unregisterProvider({ settings, provider, ns: LLM_NS })
      if (result.removed !== true) {
        actions.push({ provider, action: 'skip', reason: String(result.reason ?? '删不掉') })
        continue
      }
      changed = true
      // [P1-18-2026-11-25] 走 remove 分支时也要把动态路由摘掉。
      //
      // 原来只有 deletePanel 那条路径 `routes.delete(provider)`；对账删 provider 之后
      // 名字还留在 dynamicRoutes 里，于是 isLocalRoute 继续为它返回 true —— 一条已经
      // 不存在的 provider 永远算「本地」，裁剪规则、接管判定、面板列表都被它带偏。
      // 全文件 routes.add 只有两处（自动注册 + 面板注册），routes.delete 原来只有一处。
      routes.delete(provider)
      actions.push({ provider, action: 'remove', removed: plan.removed, applied: true })
      report(`对账 provider ${provider}：${plan.removed.join(', ')} 全都不在后端了，已删掉这条 provider`)
    }

    if (changed) {
      for (const item of actions) if (item.applied === true) onlineCache.delete(item.provider)
      baseUrlCache.clear()
      planAll()
    }

    const done = actions.filter((item) => item.applied === true)
    return {
      ok: true,
      changed,
      actions,
      ...(only.length > 0 ? { provider: only } : {}),
      message:
        done.length === 0
          ? (actions.length === 0 ? '没有本地 provider，没什么可对账的' : '后端跟配置对得上，没动')
          : done
              .map((item) => (item.action === 'remove'
                ? `删掉 ${item.provider}（${item.removed.length} 个模型全没了）`
                : `${item.provider} 摘掉 ${item.removed.length} 个（${item.removed.join(', ')}）`))
              .join('；'),
    }
  }

  /**
   * 哪些 provider 提到的模型 id 看起来就是这个文件。
   *
   * 只能靠猜：llama-server 的 alias 是启动参数里自己起的名字（本机是 local_model），
   * 和文件名 local_model.gguf 去掉后缀相同 —— 这是最常见的约定，但不是规范。
   * 所以两边都只用来「提示」，绝不拿它去阻止删除或者自动改配置。
   */
  const providersUsingModel = async (filePath) => {
    const base = String(filePath ?? '')
      .split('/')
      .pop()
    const stem = String(base ?? '').replace(/\.gguf$/i, '').toLowerCase()
    if (stem.length === 0) return []
    const hit = []
    for (const entry of await readLlmProviders()) {
      const models = Array.isArray(entry?.profile?.models) ? entry.profile.models : []
      const ids = models.map((model) => String(model?.id ?? '').trim().toLowerCase()).filter((id) => id.length > 0)
      // [exact-or-token] 原来用 `id.includes(stem)`：stem 短一点就命中一大片
      // （`qwen.gguf` 的 stem 是 `qwen`，`qwen3-32b` / `qwen2.5-coder` 全算「这个文件在用」），
      // 面板于是列出一堆无关 provider，用户不敢删了。
      // 改成「完全相等」或「按 `:` `/` `.` `-` `_` 切词后某一段完全相等」。
      const tokens = (id) => id.split(/[:/.\-_\s]+/).filter((part) => part.length > 0)
      if (ids.some((id) => id === stem || tokens(id).includes(stem))) hit.push(String(entry?.id ?? '?'))
    }
    return hit
  }

  /**
   * 面板要展示「去哪找过」，所以目录清单也带回去。
   *
   * 除了插件内建的跨平台目录（modelRoots），还加两处用户可配的：
   *   - 配置项 modelDirs（面板/配置文件里手填的目录，支持 ~）
   *   - 环境变量 DSH_LOCAL_MODELS_DIR（在 modelRoots 里已经排最前）
   * 这样「模型不在常规位置」的机器不用改代码。
   */
  const modelDirsForPanel = () => {
    const extra = []
    try {
      const configured = resolveConfig(config).modelDirs
      if (Array.isArray(configured)) extra.push(...configured)
    } catch {
      // 配置读不到就算了，内建目录仍然可用
    }
    const custom = String(process.env.DSH_LOCAL_MODELS_DIR ?? '').trim()
    if (custom.length > 0) extra.push(custom)
    const all = [
      ...extra.map((dir) => expandHome(String(dir ?? '').trim())).filter((dir) => dir.length > 0),
      ...(() => {
        try {
          return localModelDirs()
        } catch {
          return []
        }
      })(),
    ]
    return all.filter((dir, index) => all.indexOf(dir) === index)
  }

  /** `~/models` → `<home>/models`；其它原样（含相对路径）。 */
  const expandHome = (dir) => {
    if (dir.length === 0) return ''
    if (dir === '~') return homeDir()
    if (dir.startsWith('~/') || dir.startsWith('~' + String.fromCharCode(92))) return homeDir() + dir.slice(1)
    return dir.split(String.fromCharCode(92)).join('/')
  }

  /**
   * 预检预留内存（MiB → 字节）。配置项 reserveMb 说了算，0 = 不预留。
   *
   * [P2-06-2026-11-26] 加个上限。原来只判 `>= 0`：配成 999999999 MiB 时预留量算成 1e15 字节，
   * 比任何机器的内存都大 ⇒ 每个模型都被判 risky，而且这种「全都 risky」看不出是配置写错。
   * launchTimeout / smokeTimeout 都夹了上限，这里漏了。256 GiB 足够盖住现有工作站，
   * 再往上只可能是笔误。
   */
  const reserveBytesOf = () => {
    const raw = Number(resolveConfig(config).reserveMb)
    const fallback = 2048
    const mib = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, RESERVE_MB_CAP) : fallback
    return mib * 1024 * 1024
  }

  /** 取一个模型文件的体积（拿不到就 0，预检退化成 unknown 而不是报错）。 */
  const sizeOfModel = (path) => {
    try {
      const info = statSync(path)
      return Number.isFinite(info.size) ? info.size : 0
    } catch {
      return 0
    }
  }

  /**
   * 面板上的「一键配置」：选一个已下好的模型 → 起服务 → 写 provider → 试跑。
   *
   * 这是把三件原本要手工串起来的事合成一条链：
   *   1. 用选中的模型起服务（llama.cpp 走 8090，Ollama 走它自己的 11434）；
   *   2. 等服务真应答；
   *   3. 复用 importPanel 的注册逻辑写进 llm-pi-ai，然后 smoke 一次。
   * 任何一步失败都带着上一步的结果返回，不让用户猜卡在哪。
   *
   * v0.4.5：入参不再要求路径一定带 `.gguf` 后缀 —— Ollama 的权重存在
   * `blobs/sha256-…`，没有后缀但确实是 GGUF。判定改成「扩展名或文件头魔数」。
   * 另外 Ollama 的模型**不该**再拿 blob 路径去起一个 llama-server：那是 ollama 自己
   * 按 tag 加载的模型，我们要做的只是确认 11434 在应答，然后把 tag 当模型 id 注册。
   */
  const adoptPanel = async (input = {}) => {
    const fetchImpl = runtimeFetch()
    if (fetchImpl === undefined) return { ok: false, error: '运行时不提供 fetch' }
    const modelPath = String(input?.modelPath ?? input?.path ?? '').trim()
    if (modelPath.length === 0) return { ok: false, error: '先选一个本机模型文件（.gguf 或 Ollama 的模型）' }
    // 认模型文件：扩展名 → Ollama 清单里的名字 → 文件头魔数，三条命中任一就算。
    // 顺序是有讲究的：ollama 的 blob 没有后缀，但它在 manifest 里有名字，
    // 认出来就不用再开文件读那 4 个字节；反过来一个非 GGUF 的 ollama 模型
    // （ollama 以后换了格式）也仍然该能一键用起来。
    const byExt = /\.gguf$/i.test(modelPath)
    const ollamaItem = byExt ? undefined : ollamaModelFor(modelPath)
    const ollamaTag = Array.isArray(ollamaItem?.tags) && ollamaItem.tags.length > 0 ? ollamaItem.tags[0] : ''
    const magicHead = byExt || ollamaTag.length > 0 ? '' : readGgufMagic(modelPath)
    if (!byExt && ollamaTag.length === 0 && magicHead !== 'GGUF') {
      return {
        ok: false,
        error: '这个文件不是 GGUF，也不是 Ollama 的模型（扩展名不是 .gguf，在 Ollama 清单里没这个名字，文件头也不是 GGUF）：' + modelPath,
      }
    }
    // 这条路径是不是 Ollama 存储里的 blob？是就按 ollama 那套走（11434 + tag 当模型名）。
    // 认不出来（普通机器没装 ollama、或这就是个放别处的 gguf）则为 undefined，照旧走 llama.cpp。
    const wantedPort = Number(input?.port) || 0
    // 用户显式点了别的端口时不抢：那个 blob 本身就是合法 GGUF，拿去喂 llama-server 也能起
    // （只是 ollama 那边还在时会有两份内存）。没点端口、或者点的就是 ollama 的端口 → 走 ollama。
    const useOllama = ollamaTag.length > 0 && (wantedPort === 0 || wantedPort === (Number(ollamaItem.port) || 11434))
    // 普通 .gguf 落在一个「别的引擎的端口」上时必须改口 —— 后台那个服务根本不认这个文件。
    // 现场（2026-11-05）：面板选过 ollama 的模型后端口被粘在 11434，接着选 workbuddy 的
    // local_model.gguf，于是探到 Ollama 在应答就整条借它的端口，wanted 'local_model' 在
    // /v1/models 里对不上，兜底抓列表第一个（embedding 模型常排第一），装出一个指向别人的
    // provider。模型的归属由文件决定，不由上一次点的东西决定。
    // 只对「已知引擎的端口」改口：用户填个 9999 想喂自己的 llama-server，那是他的自由。
    const foreign = useOllama || wantedPort === 0 ? null : launcherForPort(wantedPort)
    const portConflict = foreign !== null && foreign.id !== 'llamacpp'
    //
    const alias = String(input?.alias ?? input?.model ?? '').trim()
    const contextTokens = Number(input?.contextWindow) || 65536
    // 想对上的名字优先级：用户填的 alias → ollama 的 tag（`qwen3:14b`，ollama 就是按这个报
    // 模型 id 的）→ 文件名去后缀（blob 的文件名是 sha256-…，所以这一步对 ollama 没意义，
    // 全靠上一行）。改口挑端口时就要用它，所以提到这里算。
    const wanted =
      alias.length > 0
        ? alias
        : useOllama
          ? ollamaTag
          : modelPath.replace(/.*[\\/]/, '').replace(/\.gguf$/i, '')
    // [P1-20-2026-11-25] portConflict 时原来是硬编码 8090：万一 8090 上正跑着**别的**引擎，
    // 后面 probeEndpoint 会 ok:true → launch.already:true，于是面板把「借用了别人的后端」
    // 报成「本来就在跑，跳过拉起」，再把这个文件注册成那个后端的模型。改口的目的是
    // 「换到一个不会打架的端口」，所以这里真的去找：8090 起依次试到 8099。
    // 判定分三种，不能只看「有没有应答」——
    //   · 没人应答 → 就用它（launchPanel 会在这个端口上把 llama.cpp 起起来）；
    //   · 有人应答、而且它报的模型里就有 wanted → 也用它（那才是真正的「本来就在跑」，
    //     白起一份 llama-server 会多占一份显存）；
    //   · 有人应答、但报的不是这个模型 → 跳过（这正是要躲的那种「别人的后端」）。
    const freePortFor = async (start) => {
      for (let candidate = start; candidate < start + 10; candidate += 1) {
        const probe = await probeEndpoint({ baseURL: 'http://127.0.0.1:' + candidate, fetchImpl, timeoutMs: 400 })
        if (probe.ok !== true) return candidate
        if (pickModel(probe.models ?? [], wanted) !== undefined) return candidate
      }
      return 0
    }
    const fallbackPort = portConflict ? await freePortFor(8090) : 0
    if (portConflict && fallbackPort === 0) {
      return {
        ok: false,
        modelPath,
        error:
          '端口 ' + wantedPort + ' 是 ' + foreign.label + ' 的，这个文件要改用 llama.cpp，' +
          '但 8090–8099 全被占用了。先关掉一个再试（别让面板去借别人的后端）',
      }
    }
    const port = useOllama ? Number(ollamaItem.port) || 11434 : portConflict ? fallbackPort : wantedPort || 8090
    const portNote = portConflict
      ? '端口 ' + wantedPort + ' 是 ' + foreign.label + ' 的，这个文件是普通 GGUF，改用 ' + port + '（llama.cpp）'
      : ''
    const baseURL = normalizeEndpoint('http://127.0.0.1:' + port)

    // 起服务之前先算一遍账：这个 gguf 有多大，显存和内存各能装多少。
    // 注意算的是「显存装不下的那部分」——gguf 走 mmap 时落在可回收的 page cache，
    // 拿全长去比内存会把 15.8GB/14.4GB 判成 risky（v0.4.0 就是这么错的）。
    // [shard-total] 分片模型（`x-00001-of-00004.gguf`）主分片只有全量的四分之一，
    // 只拿 statSync 主分片去比内存，16GB 的模型会被当成 4GB，预检全绿、起来才炸。
    const sizeBytes =
      Number(input?.sizeBytes) > 0 ? Number(input.sizeBytes) : totalShardBytes(modelPath)
    // [kv-cache] KV cache 不属于权重文件，随上下文长度线性长。默认 -c 65536 下
    // 8B 级模型常见 4–8GB，只比权重再大也漏掉这一整块。维度从 gguf 自己的 KV 里读，
    // 读不到就是 0（估算函数不会瞎猜），读到了才算进预检。
    const dims =
      useOllama || ollamaTag.length > 0
        ? {}
        : (() => {
            try {
              return readGgufMeta(modelPath) ?? {}
            } catch {
              return {}
            }
          })()
    const arch = String(dims['general.architecture'] ?? '').trim()
    const dim = (suffix) => {
      const raw = Number(dims[(arch.length > 0 ? arch : 'general') + '.' + suffix] ?? dims[suffix])
      return Number.isFinite(raw) && raw > 0 ? raw : 0
    }
    const kvBytes = estimateKvBytes({
      blockCount: dim('block_count'),
      embeddingLength: dim('embedding_length'),
      headCount: dim('attention.head_count') || dim('head_count'),
      headCountKv: dim('attention.head_count_kv') || dim('head_count_kv'),
      contextTokens,
    })
    const loadMode = normalizeLoadMode(input?.loadMode)
    // sizeBytes / gpuBytes / totalMemBytes 三个都可以从入参覆盖，只给测试和诊断用：
    // CI 的 runner 上没有 nvidia-smi、内存也只有 15.6GB，不覆盖的话这条判定在 CI 上
    // 永远是 risky，等于测不到逻辑。生产调用一律走默认值。
    const gpuTotal = Number(input?.gpuBytes) > 0 ? Number(input.gpuBytes) : gpuBytes()
    const memTotal = Number(input?.totalMemBytes) > 0 ? Number(input.totalMemBytes) : totalmem()
    const fit = checkModelFit({
      sizeBytes,
      kvBytes,
      totalMemBytes: memTotal,
      freeMemBytes: freemem(),
      gpuBytes: gpuTotal,
      reserveBytes: reserveBytesOf(),
      loadMode,
      // 统一内存（Apple Silicon / 核显）时显存和内存是同一个池子，
      // 再按 sizeBytes - gpuBytes 算就是双重扣除，会把 24GB 的 Mac 算成很宽松。
      unified: gpuInfo().unified === true,
    })
    if (fit.level === 'risky' && input?.confirmHeavy !== true) {
      return {
        ok: false,
        stage: 'precheck',
        modelPath,
        port,
        sizeBytes,
        fit,
        loadMode,
        needsConfirm: true,
        error: fit.label + '。确认要起，请在面板上勾「我知道会很慢」再点一次',
      }
    }

    const before = await probeEndpoint({ baseURL, fetchImpl, timeoutMs: 1200 })
    let launch = {
      ok: true,
      already: true,
      pid: 0,
      ms: 0,
      attempts: 0,
      baseURL,
      models: (before.models ?? []).map((model) => model.id),
    }
    if (before.ok !== true) {
      // Ollama 的模型不能当文件塞给 llama-server：那需要 ollama 自己按 tag 加载。
      // 所以这里起的其实是 `ollama serve`（不带 modelPath），模型名后面用 tag 去对。
      // 反过来，如果用户明确点了别的端口（就是要拿这个 blob 再喂一份 llama-server），照旧传路径。
      launch = await launchPanel({
        port,
        baseURL,
        ...(useOllama ? {} : { modelPath }),
        alias: alias.length > 0 ? alias : undefined,
        ctx: contextTokens,
        loadMode,
      })
      if (launch.ok !== true) {
        return {
          ok: false,
          stage: 'launch',
          modelPath,
          port,
          sizeBytes,
          fit,
          // [P1-20-2026-11-25] 改过口却没起得来时，更得把「端口从哪改到哪」说出来 ——
          // 否则用户只看到一句「没找到 llama.cpp」，会以为还在原来的端口上折腾。
          ...(portNote.length > 0 ? { portRedirected: true, portNote } : {}),
          error: launch.error,
          tried: launch.tried ?? [],
          command: launch.command,
        }
      }
    }

    // 服务起来了，但报的别名可能和我们给的不一样（llama-server 单模型时对 model
    // 字段是宽松的），所以真实模型 id 以 /v1/models 为准。
    const liveModels = (launch.models ?? []).map((id) => ({ id }))
    // wanted 在上面（改口挑端口时）已经算过，这里直接用同一份 —— 挑端口和核对模型 id
    // 必须是同一个名字，否则「挑到能复用的端口」和「名字对不上就报错」会互相打架。
    //
    // [P1-19-2026-11-25] 这里原来还有 `?? (liveModels.length === 1 ? liveModels[0] : undefined)`：
    // 端口上只跑着**一个别人的**模型时，wanted 对不上也会把这个模型当成「就是它」，
    // 于是把 A 文件注册成 B 模型 —— 而下面那句错误文案写的正是「别猜一个用」。
    // 兜底和文案必须二选一，选文案：猜错会把一个指向别人权重的 provider 写进配置，
    // 报错只是多点一次。
    const picked = pickModel(liveModels, wanted)
    if (picked === undefined) {
      return {
        ok: false,
        stage: 'probe',
        modelPath,
        port,
        // [P1-19-2026-11-25] 预检是起服务之前就算完的，跟「名字对不上」无关：这条失败也把
        // sizeBytes / fit / loadMode 带回去，前端才有东西可展示（否则用户只看到一句报错，
        // 连「这个模型到底装不装得下」都不知道）。
        sizeBytes,
        fit,
        loadMode,
        ...(portNote.length > 0 ? { portRedirected: true, portNote } : {}),
        error:
          '端口 ' + port + ' 起来了但报的模型里没有 ' + wanted + '（报的是 ' +
          liveModels.map((item) => item.id).join(', ') + '）。别猜一个用 —— 先确认这个文件喂给了正确的后端',
        launch,
      }
    }

    // provider id 只在用户真的填了才透传；留空就交给 importPanel 按端口 + 模型名生成。
    const wantedProvider = String(input?.provider ?? '').trim()
    const imported = await importPanel({
      endpoint: 'http://127.0.0.1:' + port,
      model: picked.id,
      thinking: input?.thinking === true,
      overwrite: input?.overwrite === true,
      ...(wantedProvider.length > 0 ? { provider: wantedProvider } : {}),
    })
    return {
      ok: imported.ok === true,
      stage: imported.ok === true ? 'ready' : 'register',
      modelPath,
      port,
      baseURL,
      sizeBytes,
      fit,
      loadMode,
      ...(portNote.length > 0 ? { portRedirected: true, portNote } : {}),
      launch,
      provider: imported.provider,
      model: imported.model,
      registered: imported.registered,
      ...(imported.reason ? { reason: imported.reason } : {}),
      smoke: imported.smoke,
      ...(imported.ok === true ? {} : { error: imported.error }),
    }
  }


  /**
   * 面板自己拉起来的后端：port → { pid, label, command, at }。
   *
   * 只登记「本插件 spawn 的」进程。stop 路由只肯动这张表里的 pid ——
   * 用户的 ollama serve、或者自己手起的 llama.cpp，一概不碰。
   */
  const launched = new Map()

  /**
   * 面板上的「拉起后端」：找到这台机器上的后端 → 起一个脱离宿主的进程 →
   * 等到 /v1/models 真应答才回话。已经活着就直接说「本来就在跑」，不重复起。
   */
  const launchPanel = async (input = {}) => {
    const fetchImpl = runtimeFetch()
    if (fetchImpl === undefined) return { ok: false, error: '运行时不提供 fetch' }
    const baseURLInput = String(input?.baseURL ?? input?.endpoint ?? '')
    const port = Number(input?.port) || portOfBaseURL(baseURLInput) || 11434
    const baseURL = normalizeEndpoint(baseURLInput.length > 0 ? baseURLInput : `http://127.0.0.1:${port}`)

    const before = await probeEndpoint({ baseURL, fetchImpl, timeoutMs: 1200 })
    if (before.ok === true) {
      return {
        ok: true,
        already: true,
        port,
        baseURL: before.baseURL,
        models: (before.models ?? []).map((model) => model.id),
        message: `端口 ${port} 本来就在应答，没有重复拉起`,
      }
    }

    const plan = planLaunch({
      port,
      customCommand: resolveConfig(config).launchCommand,
      alias: input.alias ?? input.model,
      ctx: input.ctx,
      modelPath: input.modelPath,
      // 面板上的「加载方式」要一路传到拼参数那一层；丢了它等于用户白选。
      loadMode: normalizeLoadMode(input.loadMode),
    })
    if (plan.ok !== true) {
      return { ok: false, port, error: plan.error, tried: plan.tried ?? [] }
    }

    const started = await runDetached({ command: plan.command, args: plan.args, env: plan.env })
    if (started.ok !== true) {
      return { ok: false, port, error: '起进程失败：' + String(started.error ?? ''), command: plan.command }
    }
    report(`拉起 ${plan.label}：${plan.command} ${plan.args.join(' ')} (pid ${started.pid})`)
    if (started.pid > 0) {
      launched.set(port, { pid: started.pid, label: plan.label, command: plan.command, at: Date.now() })
    }

    const rawTimeout = Number(resolveConfig(config).launchTimeout)
    // 上下都要夹：3s 太短（冷启动还没开始加载），600s 太长（用户以为卡死了）。
    // 之前只有 Math.max(3, …) —— 填个 100000 就会安静地等 27 小时。
    const timeoutSec = Number.isFinite(rawTimeout) ? Math.min(Math.max(rawTimeout, 3), 600) : 20
    const timeoutMs = timeoutSec * 1000
    const ready = await waitForEndpoint({
      timeoutMs,
      probe: () => probeEndpoint({ baseURL, fetchImpl, timeoutMs: 1500 }),
    })

    // 没起来就把自己刚拉的那个进程收掉，别留一个吃 17GB 内存的僵尸在后台。
    let reaped = null
    if (ready.ok !== true && started.pid > 0) {
      reaped = await stopProcess({ pid: started.pid, expectedCommand: plan.command })
      if (reaped.ok === true) launched.delete(port)
      report(`拉起失败，回收 pid ${started.pid}：${reaped.ok === true ? '已退出' : reaped.error}`)
    }

    for (const key of [...onlineCache.keys()]) onlineCache.delete(key)
    baseUrlCache.clear()

    return {
      ok: ready.ok === true,
      port,
      label: plan.label,
      command: plan.command,
      args: plan.args,
      pid: started.pid,
      ms: ready.ms,
      attempts: ready.attempts,
      timeoutSec,
      // 这两个是给面板/日志解释用的：用户看到「参数少了」时要知道原因在引擎版本，
      // 不是插件忘拼了。
      modernEngine: plan.modernEngine !== false,
      dropped: Array.isArray(plan.dropped) ? plan.dropped : [],
      loadMode: plan.loadMode ?? '',
      // [P2-14-2026-11-26] 挑的是哪个文件、为什么挑它，一路透到面板。
      picked: plan.picked ?? null,
      baseURL: ready.ok === true ? normalizeEndpoint(baseURL) : baseURL,
      models: (ready.models ?? []).map((model) => model.id),
      ...(reaped === null ? {} : { reaped: reaped.ok === true }),
      ...(ready.ok === true ? {} : { error: ready.error }),
    }
  }

  /**
   * 面板上的「停止后端」：只停 launch / adopt 自己起过的那个 pid。
   *
   * 不按端口杀 —— 端口上跑的可能根本不是我们起的（用户的 ollama serve 就在 11434）。
   * 表里没有这个端口就直说，让用户自己去关。
   */
  const stopPanel = async (input = {}) => {
    const port = Number(input?.port) || portOfBaseURL(String(input?.baseURL ?? '')) || 0
    if (port <= 0) return { ok: false, error: '要说清停哪个端口（或传 baseURL）' }

    const row = launched.get(port)
    if (row === undefined) {
      return {
        ok: false,
        port,
        error: `端口 ${port} 上没有本插件拉起的进程；手动起的后端请自己停`,
        launched: [...launched.keys()],
      }
    }

    const stopped = await stopProcess({ pid: row.pid, expectedCommand: row.command })
    if (stopped.ok !== true) {
      return { ok: false, port, pid: row.pid, error: stopped.error, launched: [...launched.keys()] }
    }
    launched.delete(port)
    for (const key of [...onlineCache.keys()]) onlineCache.delete(key)
    baseUrlCache.clear()
    report(`面板停止 ${row.label}：pid ${row.pid}（${stopped.signal}）`)

    return {
      ok: true,
      port,
      pid: row.pid,
      label: row.label,
      signal: stopped.signal,
      already: stopped.already === true,
      ms: stopped.ms,
      message: `已停掉 ${row.label}（pid ${row.pid}）`,
      launched: [...launched.keys()],
    }
  }

  /** 面板要展示的「我起过哪些后端」。 */
  const launchedList = () => [...launched.entries()].map(([port, row]) => ({ port, ...row }))

  // webServer 是可选依赖；没有它（比如非 web 端）就静默跳过。
  try {
    ctx.inject(['webServer'], (sctx) => {
      if (typeof sctx.webServer?.register !== 'function') return
      sctx.effect(
        () =>
          makeBridgeRoutes(
            {
              ns: settingsNamespace,
              read: describePanel,
              save: savePanel,
              probe: probePanel,
              log: async (bytes) => readLogTail(bytes),
              status: statusPanel,
              check: checkPanel,
              importModel: importPanel,
              testModel: testPanel,
              launch: launchPanel,
              stop: stopPanel,
              models: modelsPanel,
              adopt: adoptPanel,
              delete: deletePanel,
              align: alignPanel,
              reconcile: reconcilePanel,
            },
            {
              // [gap-guard] 配置里读不到有效数字时交给 bridge 自己回落默认值。
              minGapMs: Number(resolveConfig(config).bridgeThrottleMs),
              // [bridge-log] 异常原文只进日志，不进 HTTP 响应。
              logger: (line) => report(line),
              // 默认只认本机；要局域网访问 GUI 时在 panel 配置里显式放开。
              trustedHosts: new Set(trustedHostsOf(resolveConfig(config))),
              // [P2-04-2026-11-26] 以前这里是恒空的 new Set()：局域网放行那条分支
              // 在 isBridgeRequestAllowed 里永远走不到。现在跟 trustedPanelHosts 一样读配置。
              trustedPeers: new Set(trustedPeersOf(resolveConfig(config))),
            },
          ).map((route) => sctx.webServer.register(route)),
        'dsh-local-trim: control panel bridge',
      )
      report(
        '控制面板 bridge 已挂载：' +
          BRIDGE_PREFIX +
          '/{describe,save,probe,log,status,check,import,test,launch,stop,models,adopt,delete,align,reconcile}',
      )
    })
  } catch (error) {
    report('控制面板 bridge 未挂载 —— ' + String(error?.message ?? error))
  }

  /**
   * client 半边的宿存在性。
   *
   * 面板挂在 `plugins.detail.section` 槽位上，这个槽位由
   * `@deepseek-ai/dsh-client-ui-plugin-manager` 声明，而那个包只随
   * `@deepseek-ai/dsh-web-app` 一起装。换句话说：
   *
   *   web profile（dsh-base + dsh-web-app）      → 有 clientModules 服务，面板能出现
   *   headless / sdk / acp profile               → 没有，ctx.inject(['clientModules'])
   *                                                的回调**永远不触发**
   *
   * 原来这里只挂了 inject，缺服务时回调不跑，于是「一行日志都不打」—— 用户装完
   * 没有任何提示，日志里也查不到，只能猜。这不是裁剪坏了（lib 半边照跑），
   * 但「装了没反应」是最难自己排的一类问题，所以必须主动探测并说清楚。
   */
  const clientHost = { state: 'unknown', detail: '' }

  const noteClientHost = (state, detail) => {
    if (clientHost.state === state) return
    clientHost.state = state
    clientHost.detail = detail
    report(
      state === 'ready'
        ? 'client 半边有宿主 —— ' + detail
        : 'client 半边没有宿主 —— ' + detail,
    )
  }

  try {
    const reviveClientHalf = (clientModules) => {
      if (clientModules === null || clientModules === undefined) return
      let hasBundle = false
      try {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
        hasBundle = typeof pkg?.dsh?.client?.platform === 'string'
      } catch {
        hasBundle = false
      }
      if (hasBundle && clientModules.pkgMeta instanceof Map && typeof clientModules.flush === 'function') {
        clientModules.pkgMeta.clear()
        if (clientModules.dirty instanceof Set) clientModules.dirty.add(name)
        clientModules.flush((error) => report('client 半边重扫失败 —— ' + String(error?.message ?? error)))
        const entries = clientModules.composed?.entries
        const listed = Array.isArray(entries) && entries.some((row) => row?.id === name)
        report(
          listed
            ? '控制面板 UI 已进入 client 条目表（刷新页面即可在插件详情页看到）'
            : '控制面板 UI 已声明，但宿主还没把它编进条目表 —— 需要完整重启一次 DSH（只重载插件不够）',
        )
        noteClientHost('ready', listed ? '面板已编进条目表' : '面板已声明，等宿主重启')
      }
    }
    ctx.inject(['clientModules'], (sctx) => {
      try {
        reviveClientHalf(sctx.clientModules)
        if (clientHost.state !== 'ready') noteClientHost('ready', 'clientModules 服务可用')
      } catch (error) {
        report('client 半边自愈跳过 —— ' + String(error?.message ?? error))
      }
    })
  } catch (error) {
    report('client 半边自愈跳过 —— ' + String(error?.message ?? error))
  }

  // 先看 profile 自己的 bundle 清单 —— 这是唯一不依赖服务注册时序的证据。
  // 面板槽位只有 dsh-web-app 带（client-ui-plugin-manager 只被它依赖），
  // 所以清单里没有 web-app 就一定画不出面板，不用等定时器、也不用等进程活到 1.5 秒。
  // 向上找带 dsh.profile.bundles 的 package.json，而不是写死 '../../../'：
  // 源码以 link: 挂进 profile 时模块的真实路径在源码目录里，层级和装到 node_modules 时不同，
  // 写死层数会指向一个不存在的文件（而且是静默失败）。找不到就返回 undefined，交给下面的探测。
  const profileHasWebApp = () => {
    let dir
    try {
      dir = fileURLToPath(new URL('.', import.meta.url))
    } catch {
      return undefined
    }
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        const bundles = manifest?.dsh?.profile?.bundles
        if (Array.isArray(bundles)) {
          const names = bundles.map((entry) => (typeof entry === 'string' ? entry : entry?.name ?? ''))
          return names.some((entry) => /(?:^|\/)dsh-web-app$/.test(entry))
        }
      } catch {
        /* 这一层没有 / 读不了，继续往上 */
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return undefined
  }

  const NO_HOST_DETAIL =
    '这个 profile 没有 client-modules 服务，面板不会出现（裁剪照常生效）。' +
    '面板由 @deepseek-ai/dsh-client-ui-plugin-manager 提供，它只随 dsh-web-app 一起装 —— ' +
    'headless / sdk / acp profile 都没有它。要看面板就用 web profile，或在浏览器里打开 DSH Web。'

  const webAppHint = profileHasWebApp()
  if (webAppHint === false) {
    noteClientHost('missing', `${NO_HOST_DETAIL}（profile 的 bundle 清单里没有 dsh-web-app）`)
  }

  // 兜底探测：inject 的回调不触发时（服务根本不存在），这里必须自己看一眼。
  // 放在定时器里而不是 apply 里直接判，是因为服务可能晚于插件注册；
  // unref 掉，不让它拖住宿主退出。
  const probeClientHost = () => {
    if (stopped || clientHost.state === 'ready') return
    let present = false
    try {
      present = ctx.get('clientModules') !== undefined && ctx.get('clientModules') !== null
    } catch {
      present = false
    }
    if (present) {
      noteClientHost('ready', 'clientModules 服务可用')
      return
    }
    noteClientHost('missing', NO_HOST_DETAIL)
  }
  for (const delay of [1500, 6000]) {
    try {
      const timer = setTimeout(probeClientHost, delay)
      timer.unref?.()
    } catch {
      /* 定时器不可用就算了，自检那一行会显示 unknown */
    }
  }

  // ─────────────────────────── 启动自检 ───────────────────────────

  if (selfCheck()) {
    const lines = []
    const mark = (ok) => (ok ? '✓' : '✗')

    let toolsOk = false
    try {
      toolsOk = typeof ctx.get('tools')?.restrict === 'function'
    } catch {
      toolsOk = false
    }
    lines.push(`  ${mark(toolsOk)} tools 服务          ${toolsOk ? '可 restrict' : '不可用（工具面裁剪不会生效）'}`)

    let promptOk = false
    try {
      promptOk = typeof ctx.systemPrompt === 'object' && ctx.systemPrompt !== null
    } catch {
      promptOk = false
    }
    lines.push(
      `  ${mark(promptOk)} systemPrompt 服务   ${promptOk ? '可用' : '不可用（提示词面裁剪不会生效）'}`,
    )

    // 这两行最容易说谎：installTakeover 在本函数之后还有 800/2500/6000ms 三次重试，
    // dsh-purge 也可能比本插件晚就绪。自检跑在这一刻，拿到的只是「刚启动时的实况」。
    // 所以先按实况写（别把「还没轮到」说成「失败」），6.5 秒后再复核一次：
    // 结论变了才补一行更正，没变就一个字都不说，免得日志里多噪音。
    const takeoverSnapshot = () => ({
      purge: purgePresent(promptOk ? ctx.systemPrompt : undefined),
      ok: promptTrim() ? takeoverState.ok : true,
      via: promptTrim() ? takeoverState.via : 'disabled',
      reason: takeoverState.reason,
    })
    const boot = takeoverSnapshot()
    lines.push(
      `  ${mark(true)} dsh-purge（可选）  ${
        boot.purge
          ? '已装 → 注入段沿用它的段名，本插件在其外层收尾'
          : '此刻未装（也可能比本插件晚就绪）→ 注入段用本插件自己的段名'
      }`,
    )
    lines.push(`  ${mark(boot.ok)} assemble 接管       ${boot.ok ? boot.via : `失败：${boot.reason}`}`)

    lines.push(
      `  ${mark(true)} 轻量注入正文        ${currentInject().length} 字符，来源 ${
        injectSource === 'builtin' ? '内置默认' : injectSource
      }`,
    )
    lines.push(`  ${mark(keepSet().size > 0)} 工具白名单          ${keepSet().size} 项`)
    lines.push(
      `  ${mark(true)} 裁剪段落            ${dropSectionSet().size} 段 + ${dropContextSet().size} 个 context`,
    )
    lines.push(
      `  ${mark(routes.size > 0 || autoDetect())} 生效路由            ${
        autoDetect()
          ? `自动识别（baseURL 解析出的 hostname 是回环/私有网段；没有 baseURL 时才看名字）`
          : routes.values().join(', ')
      }`,
    )
    lines.push(`  ${mark(true)} schema 瘦身         ${schemaTrim() ? `description ${toolDescLimit()} / 参数 ${toolParamDescLimit()}` : '关闭'}`)
    lines.push(
      `  ${mark(provisionState.status !== 'failed')} 一步到位            ${
        provisionConfig === null
          ? '关闭（config.provision: false）'
          : provisionState.status === 'pending'
            ? '探测中（端点可用时会自动注册，见下方日志）'
            : provisionState.detail
      }`,
    )
    // 面板能不能出现，取决于这个 profile 有没有 client-modules 服务。
    // apply 这一刻服务可能还没注册完，所以「未知」要如实说成待探测，
    // 「没有宿主」是 profile 的选择，不是故障 —— 用 · 而不是 ✗，否则 headless 用户
    // 会以为插件坏了，而裁剪其实完全正常。只有待探测才需要提醒（马上会自己落定）。
    // 别在 web profile 上误报「面板不可用」吓人。
    const hostMark = clientHost.state === 'ready' ? '✓' : clientHost.state === 'missing' ? '·' : '…'
    lines.push(
      `  ${hostMark} client 半边         ${
        clientHost.state === 'ready'
          ? '有宿主（面板可用）'
          : clientHost.state === 'missing'
            ? '没有宿主（面板不会出现，裁剪照常生效）'
            : '待探测（1.5 秒后自动判定并写一行日志）'
      }`,
    )

    const fatal = []
    if (!toolsOk && promptOk === false) fatal.push('tools 与 systemPrompt 都不可用')
    if (promptTrim() && !boot.ok) fatal.push('assemble 接管失败，轻量注入不会生效')

    report(`启动自检`)
    for (const line of lines) report(line)
    if (fatal.length > 0) report(`⚠ 需要处理：${fatal.join('；')}`)
    else
      report(
        `就绪：仅对 ${autoDetect() ? '本地端点（自动识别）' : routes.values().join(', ')} 生效，其它 provider 原样放行`,
      )

    // 复核：上面两行是「刚启动那一刻」的实况，而接管还有三次重试、dsh-purge 也可能
    // 晚一步。6500ms 覆盖完 [800, 2500, 6000] 之后再看一眼，结论变了才补一行，
    // 没变就闭嘴 —— 日志里多一行「还是老样子」只会让人以为出了什么事。
    if (promptTrim()) {
      const timer = setTimeout(() => {
        try {
          const now = takeoverSnapshot()
          if (now.purge !== boot.purge) {
            report(
              `复核：dsh-purge 已就绪 → 注入段从下一次 assemble 起沿用它的段名（${
                now.purge ? '已装' : '又不见了'
              }）`,
            )
          }
          if (now.ok !== boot.ok || now.via !== boot.via) {
            report(
              now.ok
                ? `复核：assemble 接管已生效（${now.via}，启动时是 ${boot.via}）`
                : `复核：assemble 接管仍然失败（${now.reason}）`,
            )
          }
        } catch (error) {
          report('复核失败：' + String(error?.message ?? error))
        }
      }, 6500)
      if (typeof timer?.unref === 'function') timer.unref()
    }
  }
}
