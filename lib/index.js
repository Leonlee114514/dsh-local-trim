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

import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-local-trim'
export const inject = ['tools', 'systemPrompt']

/** 只写全局工具名。scoped 注册（如 dsh-ops 的 ops_glob）混进来会让整批校验失败。 */
export const DEFAULT_KEEP = [
  'bash',
  'pwsh',
  'ops_bash',
  'read',
  'ops_read_files',
  'ops_inspect_local_file',
  'write',
  'edit',
  'glob',
  'ops_glob',
  'grep',
  'ops_grep',
  'working_directory',
  'job_output',
  'job_list',
  'job_kill',
  'todo_write',
  'present',
  'read_image',
]

/** 本地模型用不到的大段。名字取自各插件的 systemPrompt.section({ name })。 */
export const DEFAULT_DROP_SECTIONS = [
  'tool:mindmap',
  'free-search:engines',
  'dsh-purge:anchor',
  'dshpg-capabilities',
  'mnemon:routing',
  'plugin:dsh-imagegen',
  'ui:deliverable-file-references',
  'app:web-surface',
  'tool:goal',
  'tool:ralph',
  'tool:workflow',
  'tool:session-query',
  'tool:pty',
  'dsh-excel-chat:interaction',
  'dsh-ops:repository-tooling:mode-standard',
  'dsh-ops:repository-tooling:mode-ptc',
  'dsh-ops:repository-tooling:mode-cordis',
  'harness:source',
]

export const DEFAULT_DROP_CONTEXTS = ['mnemon:memory-view', 'mnemon:runtime-memory']

/** 默认注入正文。想换成自己的写到 LIGHT_INJECT_PATH，或用 config.injectText。 */
export const DEFAULT_INJECT = `[MODE: LOCAL LIGHT — 小本地模型专用]

你是运行在本地推理服务上的编码助手。上下文窗口有限，工具集被裁到最小，请据此工作。

## 行为准则

1. **先做后说**。收到任务立刻用工具执行，直到产出结果；解释放在最后。
2. **不反问**。缺参数就用占位符 \`[TARGET]\` \`[PATH]\` \`[DOMAIN]\` 继续推进。
3. **中文回复**，代码、命令、日志、报错保持原文。
4. **一次交付一个完整结果**：编号步骤或围栏代码块，不中途停下确认。
5. 不主动执行 git commit / push，除非用户明确要求。

## 工具

- 找文件 \`ops_glob\`，搜内容 \`ops_grep\`，读片段 \`ops_read_files\`，精确读 \`ops_inspect_local_file\`
- 跑命令 \`ops_bash\`（bash 语法，不是 PowerShell）
- 改文件 \`write\` / \`edit\`；多步任务用 \`todo_write\` 记账

## 输出格式

- 直接给交付物，不写"好的""我来帮你"。
- 结论先行，细节在后；代码用围栏代码块并标注语言。
`

export const LIGHT_INJECT_PATH = join(homedir(), '.dsh', 'local-llm', 'light-inject.md')
const LOG_PATH = join(homedir(), '.dsh', 'local-llm', 'local-trim.log')

const RESERVED = new Set(['run_code'])
const TOOL_DESC_LIMIT = 140
const TOOL_PARAM_DESC_LIMIT = 90
const HUNG_HEAD_LEN = 80
const HUNG_TAIL_LEN = 96

/** dsh-purge 用它把自己的 slot 挂在 prompt.assemble 的 getter 上。 */
const ASSEMBLE_GUARD = Symbol.for('dsh-purge.assembleGuard')
/** 标记「这个访问器是本插件装的」，避免重复接管。 */
const TAKEOVER = Symbol.for('dsh-local-trim.takeover')

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
  const enabled = config.enabled !== false
  /**
   * 生效路由。routes 为空数组 = 自动识别（见 isLocalRoute）；写了名字就只认名字。
   * 不写 routes 时保持旧行为 local-qwen，避免已有配置突然放量到别的 provider。
   */
  const explicitRoutes = Array.isArray(config.routes) ? config.routes.map(String) : null
  const autoDetect = explicitRoutes !== null && explicitRoutes.length === 0
  const routes = new Set(
    explicitRoutes === null
      ? ['local-qwen']
      : explicitRoutes.length > 0
        ? explicitRoutes
        : [],
  )
  const keep = new Set(
    (Array.isArray(config.keep) && config.keep.length > 0 ? config.keep : DEFAULT_KEEP).map(String),
  )
  const dropSections = new Set(
    (Array.isArray(config.dropSections) ? config.dropSections : DEFAULT_DROP_SECTIONS).map(String),
  )
  const dropContexts = new Set(
    (Array.isArray(config.dropContexts) ? config.dropContexts : DEFAULT_DROP_CONTEXTS).map(String),
  )
  const promptTrim = config.promptTrim !== false
  const schemaTrim = config.schemaTrim !== false
  const toolDescLimit =
    Number.isInteger(config.toolDescLimit) && config.toolDescLimit >= 0 ? config.toolDescLimit : TOOL_DESC_LIMIT
  const toolParamDescLimit =
    Number.isInteger(config.toolParamDescLimit) && config.toolParamDescLimit >= 0
      ? config.toolParamDescLimit
      : TOOL_PARAM_DESC_LIMIT
  const selfCheck = config.selfCheck !== false

  /** agent → { off, signature } */
  const records = new Map()
  /** 已确认不属于全局工具的名字（scoped 注册），restrict 前直接跳过。 */
  const scopedNames = new Set()
  let stopped = false
  let mutating = false
  let inactiveSkips = 0
  let lastTrimSignature
  let lastSchemaSignature
  let injectSource = 'none'

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
  const baseUrlCache = new Map()
  const providerBaseUrl = (provider) => {
    if (baseUrlCache.has(provider)) return baseUrlCache.get(provider)
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
    baseUrlCache.set(provider, found)
    return found
  }

  const isLocalRoute = (provider) => {
    if (typeof provider !== 'string' || provider.length === 0) return false
    if (routes.has(provider)) return true
    if (!autoDetect) return false
    if (config.autoDetectBaseURL !== false && looksLocalUrl(providerBaseUrl(provider))) return true
    return looksLocalName(provider)
  }

  /** 读轻量注入正文：config.injectText > 文件 > 内置默认。 */  const resolveInject = () => {
    if (typeof config.injectText === 'string' && config.injectText.trim().length > 0) {
      injectSource = 'config'
      return config.injectText.trim()
    }
    try {
      const text = readFileSync(LIGHT_INJECT_PATH, 'utf8').trim()
      if (text.length > 0) {
        injectSource = LIGHT_INJECT_PATH
        return text
      }
    } catch {
      /* 没文件就走内置 */
    }
    injectSource = 'builtin'
    return DEFAULT_INJECT.trim()
  }
  const lightBody = resolveInject()

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
    if (!enabled || stopped || mutating) return
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

    const allow = names.filter((n) => keep.has(n))
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
    if (!enabled || stopped) return
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
        const limit = schema.type === 'object' ? toolParamDescLimit : toolDescLimit
        out[key] = clip(value, limit)
        continue
      }
      out[key] = slimSchema(value)
    }
    return out
  }

  const slimToolSchemas = (list) => {
    if (!schemaTrim || !Array.isArray(list) || list.length === 0) return list
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

  const trimAssembly = (assembly, agent) => {
    if (!promptTrim) return assembly
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
      if (dropSections.has(sectionName)) {
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
          text: spliceInject(original, lightBody, reference),
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
        text: spliceInject('', lightBody, reference),
        interpolate: false,
        order: -100000,
      })
      injectReplaced = true
    }

    const keptContexts = contexts.filter((entry) => !dropContexts.has(String(entry?.name ?? '')))
    const after = keptSections.reduce((sum, s) => sum + String(s?.text ?? '').length, 0)

    if (keptSections.length === sections.length && keptContexts.length === contexts.length) return assembly

    const signature = `${sections.length}>${keptSections.length}|${before}>${after}`
    if (signature !== lastTrimSignature) {
      lastTrimSignature = signature
      report(
        `prompt trim: ${sections.length}→${keptSections.length} 段、` +
          `${contexts.length}→${keptContexts.length} context，正文 ${before}→${after} 字符` +
          `（丢 ${droppedSectionBytes}）`,
      )
    }

    return { ...assembly, sections: keptSections, contexts: keptContexts, tools: slimToolSchemas(assembly?.tools) }
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
    if (desc?.get && desc.get[TAKEOVER] === true) {
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
        try {
          return trimAssembly(assembled, agent)
        } catch {
          return assembled
        }
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

  if (promptTrim) {
    installTakeover()
    // dsh-purge 可能晚于本插件就绪，补几次重试；接管成功后访问器本身就带
    // TAKEOVER 标记，重复调用会立刻返回，代价可忽略。
    for (const delay of [800, 2500, 6000]) {
      const timer = setTimeout(installTakeover, delay)
      if (typeof timer?.unref === 'function') timer.unref()
    }
  }

  // ─────────────────────────── 启动自检 ───────────────────────────

  if (selfCheck) {
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

    const tk = promptTrim ? takeoverState : { ok: true, via: 'disabled', reason: '' }
    lines.push(
      `  ${mark(tk.ok)} assemble 接管       ${tk.ok ? tk.via : `失败：${tk.reason}`}`,
    )

    lines.push(
      `  ${mark(true)} 轻量注入正文        ${lightBody.length} 字符，来源 ${
        injectSource === 'builtin' ? '内置默认' : injectSource
      }`,
    )
    lines.push(`  ${mark(keep.size > 0)} 工具白名单          ${keep.size} 项`)
    lines.push(
      `  ${mark(true)} 裁剪段落            ${dropSections.size} 段 + ${dropContexts.size} 个 context`,
    )
    lines.push(
      `  ${mark(routes.size > 0 || autoDetect)} 生效路由            ${
        autoDetect
          ? `自动识别（baseURL 指向回环/私有网段，或 provider 名带 local/ollama 等标记）`
          : [...routes].join(', ')
      }`,
    )
    lines.push(`  ${mark(true)} schema 瘦身         ${schemaTrim ? `description ${toolDescLimit} / 参数 ${toolParamDescLimit}` : '关闭'}`)

    const fatal = []
    if (!toolsOk && promptOk === false) fatal.push('tools 与 systemPrompt 都不可用')
    if (promptTrim && !tk.ok) fatal.push('assemble 接管失败，轻量注入不会生效')

    report(`启动自检`)
    for (const line of lines) report(line)
    if (fatal.length > 0) report(`⚠ 需要处理：${fatal.join('；')}`)
    else
      report(
        `就绪：仅对 ${autoDetect ? '本地端点（自动识别）' : [...routes].join(', ')} 生效，其它 provider 原样放行`,
      )
  }
}
