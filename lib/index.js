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
 * 不需要改动任何第三方插件的源码。dsh-purge 的 assemble guard 通过接管
 * prompt.assemble 访问器在它外层收尾（见 installTakeover）。
 */

import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'

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
} from './defaults.js'

import {
  DEFAULT_ENDPOINTS,
  buildProfile,
  normalizeEndpoint,
  probeEndpoint,
  probeFirstAvailable,
  registerProvider,
} from './provision.js'

import {
  buildImportProfile,
  parseImportInput,
  pickModel,
  smokeTest,
  summarizeProvider,
} from './import-model.js'

import { buildPanelStatus, isLocalProvider } from './status.js'
import {
  checkModelFit,
  detectGpuInfo,
  homeDir,
  localModelDirs,
  normalizeLoadMode,
  planLaunch,
  portOfBaseURL,
  runDetached,
  scanLocalModels,
  stopProcess,
  waitForEndpoint,
} from './launcher.js'

export { buildProfile, normalizeEndpoint, probeEndpoint, probeFirstAvailable, registerProvider } from './provision.js'

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
} from './defaults.js'


/** dsh-purge 用它把自己的 slot 挂在 prompt.assemble 的 getter 上。 */
const ASSEMBLE_GUARD = Symbol.for('dsh-purge.assembleGuard')
/** 标记「这个访问器是本插件装的」，避免重复接管。 */
const TAKEOVER = Symbol.for('dsh-local-trim.takeover')
// 每个 apply 调用一个独立 token：用来区分「本实例装的包装器」和「上一个实例
// 留下的、ctx 已失效的包装器」。后者必须叠加而不是跳过。
const INSTANCE = Symbol.for('dsh-local-trim.instance')

/**
 * 本地端点的 baseURL 特征：回环地址、私有网段、容器内常见主机名。
 * ollama / llama.cpp / vLLM / LM Studio / text-generation-webui 都跑在这些地址上。
 */
const LOCAL_HOST_PATTERN =
  /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|host\.docker\.internal|10\.\d|192\.168\.\d|172\.(?:1[6-9]|2\d|3[01])\.)/i

/** provider 名本身的本地特征（配置里没写 baseURL 时的兜底判断）。 */
const LOCAL_NAME_PATTERN = /(?:^|[-_])(?:local|ollama|llama|vllm|lmstudio|lm-studio|lm-studio|tgw|kobold|sglang|tabby|jan)(?:$|[-_])/i

function looksLocalUrl(value) {
  return typeof value === 'string' && value.trim().length > 0 && LOCAL_HOST_PATTERN.test(value.trim())
}

function looksLocalName(provider) {
  const id = String(provider ?? '')
  return id.length > 0 && (LOCAL_NAME_PATTERN.test(id) || /^ollama/i.test(id))
}

/** 当前生效的 provider：先看会话选择投影，再退回 agent 的默认路由。 */
function providerOf(ctx, agent) {
  const projections = ctx.get('sessionProjections')
  const session = agent?.session
  if (projections !== undefined && session !== undefined) {
    const state = projections.stateOf(session, 'modelSelection')
    const picked = state?.pending ?? state?.lastUsed
    if (typeof picked?.provider === 'string' && picked.provider.length > 0) return picked.provider
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

/** 宿主的 25K 兜底逻辑会拿这份文本的头 80 / 尾 96 字符做包含判断。 */
function hungReferenceText() {
  try {
    const fn = globalThis.__dshPurgeHungPrompt
    if (typeof fn !== 'function') return undefined
    const text = String(fn() ?? '').trim()
    return text.length > 0 ? text.replace(/\r\n/g, '\n') : undefined
  } catch {
    return undefined
  }
}

/**
 * 把整份注入换成轻量版，同时保留 reference 的头 80 / 尾 96 字符。
 * 宿主 agent-loop 只有在渲染结果同时包含这两段时才不会把全文再前置一遍。
 */
export function spliceInject(originalText, lightBody, reference) {
  const body = String(lightBody ?? '').trim()
  const original = String(originalText ?? '')
  if (body.length === 0) return original
  if (original.includes(body)) return original
  const ref = String(reference ?? '')
  if (ref.length <= HUNG_HEAD_LEN + HUNG_TAIL_LEN) return body
  const head = ref.slice(0, HUNG_HEAD_LEN)
  const tail = ref.slice(-HUNG_TAIL_LEN)
  return `${head}\n\n${body}\n\n${tail}`
}

export function apply(ctx, config = {}) {
  // ── 配置读取 ────────────────────────────────────────────────
  //
  // 声明了 Config（lib/config.js）之后，凡是 .volatile() 的字段，宿主传进来的
  // 不是值而是一个活引用对象 { get() {...}, [write](v) {...} }。直接
  // config.enabled !== false 会恒为 true（对象 !== false），所以这里统一走
  // resolveConfig() 现读 —— 面板保存后不需要重载插件，下一段请求就用新值。
  const read = () => resolveConfig(config)

  /** 生效路由。routes 为空数组 = 自动识别（见 isLocalRoute）；写了名字就只认名字。 */
  const routePlan = () => {
    const c = read()
    const explicit = Array.isArray(c.routes) ? c.routes.map(String) : null
    return {
      autoDetect: explicit !== null && explicit.length === 0,
      routes: new Set(explicit === null ? ['local-qwen'] : explicit),
    }
  }
  /** 面板保存的 routes 与自动注册的 provider 共用这个集合。 */
  const dynamicRoutes = new Set()
  const routes = {
    has: (p) => routePlan().routes.has(p) || dynamicRoutes.has(p),
    add: (p) => {
      dynamicRoutes.add(p)
      return dynamicRoutes
    },
    delete: (p) => dynamicRoutes.delete(p),
    get size() {
      return new Set([...routePlan().routes, ...dynamicRoutes]).size
    },
    values: () => [...new Set([...routePlan().routes, ...dynamicRoutes])],
  }
  const autoDetect = () => routePlan().autoDetect
  const keepSet = () => {
    const c = read()
    return new Set((Array.isArray(c.keep) && c.keep.length > 0 ? c.keep : DEFAULT_KEEP).map(String))
  }
  const dropSectionSet = () => {
    const c = read()
    return new Set((Array.isArray(c.dropSections) ? c.dropSections : DEFAULT_DROP_SECTIONS).map(String))
  }
  const dropContextSet = () => {
    const c = read()
    return new Set((Array.isArray(c.dropContexts) ? c.dropContexts : DEFAULT_DROP_CONTEXTS).map(String))
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
  let mutating = false
  /** 本实例的身份标记，用来识别自己装的 assemble 包装器（见 installTakeover）。 */
  const instanceToken = Symbol('dsh-local-trim instance')
  let inactiveSkips = 0
  let lastTrimSignature
  let lastSchemaSignature
  let injectSource = 'none'
  /** 上一次从 light-inject.md 读到的正文 + 文件戳（mtime:size），避免每次 assemble 都读盘。 */
  let injectCache = null

  const report = (line) => {
    const text = `[${name}] ${line}`
    try {
      ctx.logger?.info?.(text)
    } catch {
      /* logger 不可用时只写文件 */
    }
    try {
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
    const cached = baseUrlCache.get(provider)
    if (cached !== undefined && Date.now() - cached.at < BASE_URL_TTL_MS) return cached.value
    let found
    try {
      const llm = ctx.get('llm')
      const entries = llm?.listConfigurableProviders?.() ?? []
      for (const entry of entries) {
        if (entry?.provider !== provider) continue
        found = entry.baseURL ?? entry.defaultBaseURL ?? entry.baseUrl
        break
      }
    } catch {
      /* 没有 llm 服务时退回名字判断 */
    }
    baseUrlCache.set(provider, { value: found, at: Date.now() })
    return found
  }

  const isLocalRoute = (provider) => {
    if (typeof provider !== 'string' || provider.length === 0) return false
    if (routes.has(provider)) return true
    if (!autoDetect()) return false
    if (read().autoDetectBaseURL !== false && looksLocalUrl(providerBaseUrl(provider))) return true
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
    return DEFAULT_INJECT.trim()
  }
  /** 当前生效的注入正文（每次现读，用于 splice / 面板 / 自检）。 */
  const currentInject = () => resolveInject()
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
    if (!enabled() || stopped || mutating) return
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

    const allow = names.filter((n) => keepSet().has(n))
    if (allow.length === 0) {
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
      mutating = false
    }
  }

  const planAll = () => {
    if (!enabled() || stopped) return
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

  const slimSchema = (schema) => {
    if (Array.isArray(schema)) return schema.map(slimSchema)
    if (schema === null || typeof schema !== 'object') return schema
    const out = {}
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'description' && typeof value === 'string') {
        const limit = schema.type === 'object' ? toolParamDescLimit() : toolDescLimit()
        out[key] = clip(value, limit)
        continue
      }
      out[key] = slimSchema(value)
    }
    return out
  }

  const slimToolSchemas = (list) => {
    if (!schemaTrim() || !Array.isArray(list) || list.length === 0) return list
    const before = list.reduce((sum, s) => sum + JSON.stringify(s ?? {}).length, 0)
    const slimmed = list.map(slimSchema)
    const after = slimmed.reduce((sum, s) => sum + JSON.stringify(s ?? {}).length, 0)
    const signature = `tools|${list.length}|${before}>${after}`
    if (signature !== lastSchemaSignature) {
      lastSchemaSignature = signature
      report(`tool schema 瘦身: ${list.length} 项 ${before}→${after} 字节（省 ${before - after}）`)
    }
    return slimmed
  }

  // ─────────────────────────── 提示词面 ───────────────────────────

  // 最近一次 assemble 的体积，面板拿它画「省了多少」。
  // charsIn 是内层（宿主 / dsh-purge）给出的原始装配，charsOut 是我们交出去的。
  let lastTrim = null
  let lastWrapSignature = ''

  const bytesOfAssembly = (assembly) =>
    (assembly?.sections ?? []).reduce((sum, section) => sum + String(section?.text ?? '').length, 0)

  const recordTrim = (before, after, agent) => {
    const charsIn = bytesOfAssembly(before)
    const charsOut = bytesOfAssembly(after)
    lastTrim = {
      charsIn,
      charsOut,
      sectionsIn: (before?.sections ?? []).length,
      sectionsOut: (after?.sections ?? []).length,
      contextsIn: (before?.contexts ?? []).length,
      contextsOut: (after?.contexts ?? []).length,
      provider: providerOf(ctx, agent) ?? '',
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

  const trimAssembly = (assembly, agent) => {
    if (!promptTrim()) return assembly
    const provider = providerOf(ctx, agent)
    if (provider === undefined || !isLocalRoute(provider)) return assembly
    if (assembly === null || typeof assembly !== 'object' || !Array.isArray(assembly.sections)) return assembly

    const sections = assembly.sections
    const contexts = Array.isArray(assembly.contexts) ? assembly.contexts : []
    const before = sections.reduce((sum, s) => sum + String(s?.text ?? '').length, 0)
    const reference = hungReferenceText()

    const keptSections = []
    let droppedSectionBytes = 0
    let injectReplaced = false

    for (const section of sections) {
      const sectionName = String(section?.name ?? '')
      if (dropSectionSet().has(sectionName)) {
        droppedSectionBytes += String(section?.text ?? '').length
        continue
      }
      if (sectionName === 'dsh-purge') {
        const original = String(section?.text ?? '')
        if (original.length === 0) {
          keptSections.push(section)
          continue
        }
        keptSections.push({
          ...section,
          text: spliceInject(original, currentInject(), reference),
          // 必须关掉插值：renderPrompt 会拿 assembly.variables 改写正文，
          // 一旦被改写，头80/尾96 取样就失配，宿主会把整份原文再前置一遍。
          interpolate: false,
        })
        injectReplaced = true
        continue
      }
      keptSections.push(section)
    }

    // 没装 dsh-purge 时没有注入段：补一段，宿主会按前缀把它提到最前。
    if (!injectReplaced) {
      keptSections.unshift({
        name: 'dsh-purge',
        text: spliceInject('', currentInject(), reference),
        interpolate: false,
        order: -100000,
      })
      injectReplaced = true
    }

    const keptContexts = contexts.filter((entry) => !dropContextSet().has(String(entry?.name ?? '')))
    const after = keptSections.reduce((sum, s) => sum + String(s?.text ?? '').length, 0)
    const tools = slimToolSchemas(assembly?.tools)

    // 早退必须比内容，不能只比数量。注入段被 spliceInject 换过正文、段数却没变的时候，
    // 只比数量会把「注入替换」和「schema 瘦身」两件事一起丢掉 —— 插件看起来在跑，
    // 实际一个字节都没裁。这就是 v0.3.9 那两个静默失效里的第一个。
    const sameSections =
      keptSections.length === sections.length && keptSections.every((section, index) => section === sections[index])
    const sameContexts = keptContexts.length === contexts.length
    if (sameSections && sameContexts && tools === assembly?.tools) return assembly

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
        } catch {
          return { sections: [], contexts: [], tools: [] }
        }
        const agent = args[0]?.agent
        if (agent === undefined) return assembled
        const reference = assembled
        let out = assembled
        try {
          out = trimAssembly(assembled, agent)
        } catch {
          out = assembled
        }
        try {
          recordTrim(reference, out, agent)
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
      plan(agent)
      const result = await next()
      try {
        return trimAssembly(result, agent)
      } catch {
        return result
      }
    },
    { global: true, prepend: true },
  )

  // 插件的 effect 清理：撤销限制、摘掉访问器标记。
  ctx.effect(
    () => () => {
      stopped = true
      for (const agent of [...records.keys()]) release(agent)
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

  const registerProviderWithRetry = registerProvider

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
      provisionState = {
        status: 'existing',
        provider: ids[0],
        detail: `已有可用的本地 provider：${ids.join(', ')}（未写入任何配置）`,
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
      baseUrlCache.delete(providerId)
      // 新 provider 刚上线，已有会话的工具面还没按它算过，补一轮。
      planAll()
      const modelIds = profile.models.map((item) => `${item.id}@${item.contextWindow}`).join(', ')
      provisionState = {
        status: 'registered',
        provider: providerId,
        detail: `${probe.baseURL} → ${providerId}（${modelIds}）。已写入 llm-pi-ai.providers，无需重启；在模型选择器里选 ${providerId}/${profile.models[0]?.id ?? ''}`,
      }
      return
    }

    // 「已存在」不是失败：说明这个 provider 早就配好了，端点也刚探测通过，
    // 正是我们想要的状态，只是不需要写配置。
    if (/已存在/.test(String(result.reason ?? ''))) {
      routes.add(providerId)
      baseUrlCache.delete(providerId)
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

  const readLogTail = (bytes) => {
    try {
      const text = readFileSync(LOG_PATH, 'utf8')
      const tail = text.length > bytes ? text.slice(-bytes) : text
      return { path: LOG_PATH, bytes: tail.length, text: tail }
    } catch (error) {
      return { path: LOG_PATH, bytes: 0, text: '', error: String(error?.message ?? error) }
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
    // 面板可能刚改了 routes / keep / dropSections，立刻重算一遍工具面。
    planAll()
    return { saved: true, values: resolveConfig(read()), revision: row.revision + 1 }
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
    const results = []
    for (const endpoint of endpoints) {
      const probe = await probeEndpoint({ baseURL: endpoint, fetchImpl, timeoutMs })
      results.push({
        baseURL: probe.baseURL || normalizeEndpoint(endpoint),
        ok: probe.ok,
        models: probe.models ?? [],
        attempts: probe.attempts ?? [],
      })
    }
    return { ok: results.some((item) => item.ok), results }
  }

  // ───────────────────── 面板：状态 / 点灯 / 导入 / 试跑 ─────────────────────

  const LLM_NS = 'llm-pi-ai'
  const onlineCache = new Map()
  const ONLINE_TTL_MS = 15_000

  const runtimeFetch = () => (typeof fetch === 'function' ? fetch : undefined)

  const apiKeyFromEnv = () => {
    try {
      const value = globalThis.process?.env?.DSH_LOCAL_LLM_API_KEY
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
        online[id] = { ok: cached.ok, ms: cached.ms, error: cached.error }
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
        ...(probe.ok === true ? {} : { error: probe.attempts?.[0]?.error ?? probe.error ?? '连不上' }),
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
          online,
          revision: base.revision,
          writable: base.writable,
          logPath: base.logPath,
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
      return {
        ok: false,
        endpoint: probe.baseURL || parsed.endpoint,
        error: `端点里没有模型 "${parsed.model}"`,
        models: (probe.models ?? []).map((model) => model.id),
        attempts,
      }
    }

    const profile = buildImportProfile({ ...parsed, model: picked.id }, { ...probe, ...picked })
    const settings = await settingsService()
    let registered = false
    let reason = ''
    try {
      const result = await registerProvider({
        settings,
        provider: parsed.provider,
        profile,
        ns: LLM_NS,
        overwrite: parsed.overwrite === true,
      })
      registered = result?.registered === true
      reason = String(result?.reason ?? '')
    } catch (error) {
      return { ok: false, error: '写入 settings 失败：' + String(error?.message ?? error) }
    }

    const smoke = await smokeTest({
      fetchImpl,
      baseURL: profile.baseURL,
      model: picked.id,
      apiKey: apiKeyFromEnv(),
      timeoutMs: 30_000,
      chatTemplateKwargs: profile.compat?.chatTemplateKwargs,
      maxTokens: 64,
    })
    onlineCache.delete(parsed.provider)
    baseUrlCache.clear()
    planAll()

    return {
      ok: true,
      endpoint: probe.baseURL || parsed.endpoint,
      provider: parsed.provider,
      model: picked.id,
      models: (probe.models ?? []).map((model) => model.id),
      registered,
      ...(reason.length > 0 ? { reason } : {}),
      summary: summarizeProvider(parsed.provider, profile),
      smoke,
    }
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
      apiKey: apiKeyFromEnv(),
      timeoutMs: Number.isInteger(input?.timeoutMs) ? input.timeoutMs : 30_000,
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

  const modelsPanel = async () => {
    const dirs = modelDirsForPanel()
    const list = scanLocalModels({ depth: 2, dirs })
    const reserveBytes = reserveBytesOf()
    const gpu = gpuInfo()
    return {
      ok: true,
      dirs,
      truncated: list.truncated === true,
      scannedEntries: list.scannedEntries ?? 0,
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
        fit: checkModelFit({
          sizeBytes: item.sizeBytes,
          totalMemBytes: totalmem(),
          freeMemBytes: freemem(),
          gpuBytes: gpu.bytes,
          reserveBytes,
          unified: gpu.unified === true,
        }),
      })),
    }
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

  /** 预检预留内存（MiB → 字节）。配置项 reserveMb 说了算，0 = 不预留。 */
  const reserveBytesOf = () => {
    const raw = Number(resolveConfig(config).reserveMb)
    const mib = Number.isFinite(raw) && raw >= 0 ? raw : 2048
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
   * 面板上的「一键配置」：选一个已下好的 gguf → 起服务 → 写 provider → 试跑。
   *
   * 这是把三件原本要手工串起来的事合成一条链：
   *   1. 用选中的 gguf 起 llama-server（端口默认 8090，别名取模型文件名）；
   *   2. 等服务真应答；
   *   3. 复用 importPanel 的注册逻辑写进 llm-pi-ai，然后 smoke 一次。
   * 任何一步失败都带着上一步的结果返回，不让用户猜卡在哪。
   */
  const adoptPanel = async (input = {}) => {
    const fetchImpl = runtimeFetch()
    if (fetchImpl === undefined) return { ok: false, error: '运行时不提供 fetch' }
    const modelPath = String(input?.modelPath ?? input?.path ?? '').trim()
    if (modelPath.length === 0) return { ok: false, error: '先选一个本机模型文件（.gguf）' }
    if (!/\.gguf$/i.test(modelPath)) return { ok: false, error: '只能选 .gguf 文件：' + modelPath }
    const port = Number(input?.port) || 8090
    const alias = String(input?.alias ?? input?.model ?? '').trim()
    const contextTokens = Number(input?.contextWindow) || 65536
    const baseURL = normalizeEndpoint('http://127.0.0.1:' + port)

    // 起服务之前先算一遍账：这个 gguf 有多大，显存和内存各能装多少。
    // 注意算的是「显存装不下的那部分」——gguf 走 mmap 时落在可回收的 page cache，
    // 拿全长去比内存会把 15.8GB/14.4GB 判成 risky（v0.4.0 就是这么错的）。
    const sizeBytes =
      Number(input?.sizeBytes) > 0 ? Number(input.sizeBytes) : sizeOfModel(modelPath)
    const loadMode = normalizeLoadMode(input?.loadMode)
    // sizeBytes / gpuBytes / totalMemBytes 三个都可以从入参覆盖，只给测试和诊断用：
    // CI 的 runner 上没有 nvidia-smi、内存也只有 15.6GB，不覆盖的话这条判定在 CI 上
    // 永远是 risky，等于测不到逻辑。生产调用一律走默认值。
    const gpuTotal = Number(input?.gpuBytes) > 0 ? Number(input.gpuBytes) : gpuBytes()
    const memTotal = Number(input?.totalMemBytes) > 0 ? Number(input.totalMemBytes) : totalmem()
    const fit = checkModelFit({
      sizeBytes,
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
      launch = await launchPanel({
        port,
        baseURL,
        modelPath,
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
          error: launch.error,
          tried: launch.tried ?? [],
          command: launch.command,
        }
      }
    }

    // 服务起来了，但报的别名可能和我们给的不一样（llama-server 单模型时对 model
    // 字段是宽松的），所以真实模型 id 以 /v1/models 为准。
    const liveModels = (launch.models ?? []).map((id) => ({ id }))
    const wanted =
      alias.length > 0 ? alias : modelPath.replace(/.*[\\/]/, '').replace(/\.gguf$/i, '')
    const picked = pickModel(liveModels, wanted) ?? liveModels[0]
    if (picked === undefined) {
      return {
        ok: false,
        stage: 'probe',
        modelPath,
        port,
        error: '端口 ' + port + ' 起来了但没报任何模型',
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

    const started = runDetached({ command: plan.command, args: plan.args, env: plan.env })
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
      reaped = await stopProcess({ pid: started.pid })
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

    const stopped = await stopProcess({ pid: row.pid })
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
            },
            { minGapMs: Number(resolveConfig(config).bridgeThrottleMs) },
          ).map((route) => sctx.webServer.register(route)),
        'dsh-local-trim: control panel bridge',
      )
      report(
        '控制面板 bridge 已挂载：' +
          BRIDGE_PREFIX +
          '/{describe,save,probe,log,status,check,import,test,launch,stop,models,adopt}',
      )
    })
  } catch (error) {
    report('控制面板 bridge 未挂载 —— ' + String(error?.message ?? error))
  }

  /**
   * 让宿主的 client-modules 重新扫一次本包。
   *
   * dsh-client-modules 的 resolveMeta() 把每个 loader 条目第一次解析的结果缓存在
   * pkgMeta（sourceKey -> 结果或 null）里，之后 flush() 只看缓存、从不失效。于是出现过
   * 这样一个顺序：先装本插件（那时 package.json 还没有 dsh.client），宿主缓存 null；之后
   * 补上 dsh.client 再热重载，resolveMeta() 仍返回缓存的 null，reconcilePackage() 直接把
   * 包从 client 表里删掉 —— 面板永远不进 __DSH_BOOT__ 的条目表，浏览器里也就永远看不到。
   * POST /dsh-unlag/reload 只重启插件，不动这个缓存，只有整个宿主进程重启才会自然清掉。
   *
   * 这里主动清掉本包的缓存项再触发一次 flush，等价于「只重启这一个包的 client 半边」。
   * 全部走可选链 + try/catch：宿主没有这个服务、或内部字段改名时安静跳过，绝不影响裁剪。
   */
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
      }
    }
    ctx.inject(['clientModules'], (sctx) => {
      try {
        reviveClientHalf(sctx.clientModules)
      } catch (error) {
        report('client 半边自愈跳过 —— ' + String(error?.message ?? error))
      }
    })
  } catch (error) {
    report('client 半边自愈跳过 —— ' + String(error?.message ?? error))
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

    const purgeInstalled =
      typeof globalThis.__dshPurgeHungPrompt === 'function' ||
      (promptOk && Boolean(Object.getOwnPropertyDescriptor(ctx.systemPrompt, 'assemble')?.get?.[ASSEMBLE_GUARD]))
    lines.push(
      `  ${mark(true)} dsh-purge           ${purgeInstalled ? '已装（本插件在其外层收尾，无需改它源码）' : '未装（用原生 accessor）'}`,
    )

    const tk = promptTrim() ? takeoverState : { ok: true, via: 'disabled', reason: '' }
    lines.push(
      `  ${mark(tk.ok)} assemble 接管       ${tk.ok ? tk.via : `失败：${tk.reason}`}`,
    )

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
          ? `自动识别（baseURL 指向回环/私有网段，或 provider 名带 local/ollama 等标记）`
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

    const fatal = []
    if (!toolsOk && promptOk === false) fatal.push('tools 与 systemPrompt 都不可用')
    if (promptTrim() && !tk.ok) fatal.push('assemble 接管失败，轻量注入不会生效')

    report(`启动自检`)
    for (const line of lines) report(line)
    if (fatal.length > 0) report(`⚠ 需要处理：${fatal.join('；')}`)
    else
      report(
        `就绪：仅对 ${autoDetect() ? '本地端点（自动识别）' : routes.values().join(', ')} 生效，其它 provider 原样放行`,
      )
  }
}
