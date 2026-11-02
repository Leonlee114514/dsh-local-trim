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

import {
  DEFAULT_ENDPOINTS,
  buildProfile,
  normalizeEndpoint,
  probeEndpoint,
  probeFirstAvailable,
  registerProvider,
} from './provision.js'

export { buildProfile, normalizeEndpoint, probeEndpoint, probeFirstAvailable, registerProvider } from './provision.js'

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
// 测试脚本会调 apply()，默认路径会和线上日志混在一起、把真实时间线污染掉。
// DSH_LOCAL_TRIM_LOG 指向别处即可隔离。
const LOG_PATH = process.env.DSH_LOCAL_TRIM_LOG || join(homedir(), '.dsh', 'local-llm', 'local-trim.log')

const RESERVED = new Set(['run_code'])
const TOOL_DESC_LIMIT = 140
const TOOL_PARAM_DESC_LIMIT = 90
const HUNG_HEAD_LEN = 80
const HUNG_TAIL_LEN = 96

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
  /** 排障开关：打开后每次 assemble 都记「包装器进入/返回」的体积。 */
  const debugWrap = config.debugWrap === true
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
  /** 本实例的身份标记，用来识别自己装的 assemble 包装器（见 installTakeover）。 */
  const instanceToken = Symbol('dsh-local-trim instance')
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
        if (!debugWrap) {
          try {
            return trimAssembly(assembled, agent)
          } catch {
            return assembled
          }
        }
        // 诊断（config.debugWrap: true）：确认包装器真的在这一层被调用，以及进出体积。
        const bytesOf = (a) => (a?.sections ?? []).reduce((n, s) => n + String(s?.text ?? "").length, 0)
        report(`包装器进入：${(assembled?.sections ?? []).length} 段 / ${bytesOf(assembled)} 字符`)
        try {
          const out = trimAssembly(assembled, agent)
          report(`包装器返回：${(out?.sections ?? []).length} 段 / ${bytesOf(out)} 字符`)
          return out
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

  if (promptTrim) {
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
    const raw = config.provision
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
