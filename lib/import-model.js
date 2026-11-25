/**
 * 控制面板「导入本地模型」的纯逻辑。
 *
 * 这里不放任何 IO 之外的副作用：校验输入、拼 provider id、包装 profile、
 * 发一次最小真实请求。index.js 只负责把 settings / fetch 递进来，
 * test/panel.mjs 可以直接 import 这些函数跑断言。
 */

import { buildProfile, normalizeEndpoint } from './provision.js'
import { sameModel } from './status.js'

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/

/**
 * 端口 → 后端名，用来给 provider 取一个能看懂的前缀。
 *
 * 只覆盖「大家都这么用」的端口。剩下靠后端自报（/v1/models 的 id）和显式传参：
 * vLLM 常用 8081/8082/9000，LM Studio 允许改端口，llama.cpp 更是哪都能起 ——
 * 猜不准时退回 `local`，用户照样能改，别因为端口不在表里就把人挡住。
 */
const BACKEND_BY_PORT = {
  '8080': 'llamacpp',
  '8081': 'vllm',
  '8082': 'vllm',
  '8090': 'llamacpp',
  '8091': 'llamacpp',
  '9000': 'vllm',
  '11434': 'ollama',
  '8000': 'vllm',
  '8001': 'vllm',
  '1234': 'lmstudio',
  '1235': 'lmstudio',
  '5000': 'vllm',
  '5001': 'vllm',
  '3001': 'llamacpp',
}

/** 从提示串（provider 名 / model id / endpoint 路径）里认后端，端口认不出来时的第二道。 */
export function backendByName(hint) {
  const text = String(hint ?? '').toLowerCase()
  if (text.length === 0) return ''
  if (/ollama/.test(text)) return 'ollama'
  if (/llama[-_.]?cpp|llama[-_.]?server|gguf/.test(text)) return 'llamacpp'
  if (/vllm/.test(text)) return 'vllm'
  if (/lm[-_.]?studio|\blms\b/.test(text)) return 'lmstudio'
  return ''
}

function portOf(url) {
  try {
    return new URL(url).port
  } catch {
    return ''
  }
}

/** 把模型 id 压成可读的 slug：`Qwen2.5-7B-Instruct.Q4_K_M` → `qwen2-5-7b-instruct-q4-k-m`。 */
export function slugifyModel(modelId) {
  return String(modelId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

/**
 * 端点/提示串对应的后端名（`ollama` / `llamacpp` / `vllm` / `lmstudio` / `local`）。
 *
 * 注意 `backendByName` 认不出来时返回的是**空串**，不是 undefined ——
 * 原来写 `?? 'local'` 兜不住空串，会拼出 `local--qwen3-4b` 这种双连字符 id
 * （`PROVIDER_ID_RE` 恰好放行，所以一直没炸，只是难看又难认）。
 */
export function backendFor(endpoint, hint) {
  const byPort = BACKEND_BY_PORT[portOf(endpoint)]
  if (byPort !== undefined) return byPort
  const byName = backendByName(hint)
  return byName.length > 0 ? byName : 'local'
}

/**
 * 「这个后端整体」那条 provider 的 id（`local-ollama` / `local-llamacpp` …）。
 * 认不出后端时就是 `local`，不是 `local-local`。
 */
export function genericProviderId(backend) {
  const name = String(backend ?? '').trim()
  return name.length === 0 || name === 'local' ? 'local' : `local-${name}`
}

/** 默认 provider id：`local-<backend>-<model slug>`，同一端点换模型不会互相覆盖。 */
export function defaultProviderId(endpoint, modelId, hint) {
  const prefix = genericProviderId(backendFor(endpoint, hint))
  const slug = slugifyModel(modelId)
  return slug.length > 0 ? `${prefix}-${slug}` : prefix
}

/** provider id 只允许小写字母数字和 . _ -，别让用户写出奇怪的键。 */
export function sanitizeProviderId(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value.length === 0) return undefined
  if (!PROVIDER_ID_RE.test(value)) return undefined
  return value
}

/**
 * 校验面板递上来的导入表单。
 * @param {any} body
 * @returns {{ok: true, endpoint: string, model: string, provider: string, displayName: string,
 *   overwrite: boolean, contextWindow?: number, maxTokens?: number, thinking: boolean | null}
 *   | {ok: false, error: string}}
 */
export function parseImportInput(body) {
  const endpointRaw = String(body?.endpoint ?? '').trim()
  if (endpointRaw.length === 0) return { ok: false, error: '端点不能为空，例如 http://127.0.0.1:8090' }
  // [url-scheme] 三种最常见的粘贴错误要分别说清楚，不能都报「不是合法 URL」。
  //
  // `new URL()` 把任何 `x:` 前缀当协议，于是这三种输入都被解析成功又落不到 http(s)：
  //   127.0.0.1:8090        → protocol '127.0.0.1:'（少写 scheme）
  //   C:\Users\me\models   → protocol 'c:'（粘成了 Windows 路径）
  //   localhost              → 直接抛（粘了裸主机名）
  // 用户看到同一句「不是合法 URL」根本不知道自己少打了 `http://`。
  // 连空格都有，那连「像不像端点」都不算，先按「不是合法 URL」拒掉 —— 不能把它
  // 说成「少了 http://」，用户会去补个 http:// 然后仍然失败。
  if (/\s/.test(endpointRaw)) return { ok: false, error: `端点不是合法 URL：${endpointRaw}` }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(endpointRaw)) {
    const winPath = /^[a-z]:[\\/]/i.test(endpointRaw)
    return {
      ok: false,
      error: winPath
        ? `这是个文件路径，不是端点：${endpointRaw}。端点要写成 http://主机:端口`
        : `端点少了 http:// 或 https://：${endpointRaw}`,
    }
  }
  const endpoint = normalizeEndpoint(endpointRaw)
  let url
  try {
    url = new URL(endpoint)
  } catch {
    return { ok: false, error: `端点不是合法 URL：${endpointRaw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `端点必须是 http(s)：${endpointRaw}` }
  }

  const model = String(body?.model ?? '').trim()
  if (model.length === 0) return { ok: false, error: '先探测端点，再选一个模型 id' }

  const explicit = String(body?.provider ?? '').trim()
  const provider = explicit.length > 0 ? sanitizeProviderId(explicit) : defaultProviderId(endpoint, model)
  if (provider === undefined) {
    return { ok: false, error: `provider id 只能用 a-z 0-9 . _ -，且以字母或数字开头：${explicit}` }
  }

  const contextWindow = Number(body?.contextWindow)
  const maxTokens = Number(body?.maxTokens)
  const thinking = typeof body?.thinking === 'boolean' ? body.thinking : null

  return {
    ok: true,
    endpoint,
    model,
    provider,
    // 用户手填了 provider id 就是他有意指定，不许被「复用同后端」改写；
    // 留空时 id 是我们按端口 + 模型名猜的，那就有资格改成复用已有条目。
    explicitProvider: explicit.length > 0,
    displayName: String(body?.displayName ?? '').trim(),
    overwrite: body?.overwrite === true,
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.floor(contextWindow) } : {}),
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens: Math.floor(maxTokens) } : {}),
    thinking,
  }
}

/** 在探测结果里挑模型：先精确匹配，再大小写不敏感匹配。 */
export function pickModel(models, want) {
  const list = Array.isArray(models) ? models : []
  const target = String(want ?? '').trim()
  if (target.length === 0) return undefined
  // [pick-trim] 后端回的 id 常带尾随空格（Ollama 某些版本就有），原来拿原始字符串比，
  // 于是「模型明明在列表里却报找不到」。planReconcile 早就 trim 了，这里补齐。
  const exact = list.find((entry) => String(entry?.id ?? '').trim() === target)
  if (exact !== undefined) return exact
  const lower = target.toLowerCase()
  return list.find((entry) => String(entry?.id ?? '').trim().toLowerCase() === lower)
}

/**
 * 「对齐到实际」：把一条 provider 的 models 数组改成后端此刻真的有的那份清单。
 *
 * 为什么需要它：`ollama rm` 删的是磁盘上的权重，`cordis.patch.yml` 里那条
 * `- id: qwen3:14b` 声明没有任何东西会去清，于是配置里攒下一堆指向已删模型的条目
 * （面板上表现为「5 模型」但只有 3 个能真的跑起来）。这个函数算出「改完之后应该长什么样」，
 * 纯函数，不碰 settings。
 *
 * 三条原则：
 *   1. **活着的条目原样保留** —— 用户的 contextWindow / maxTokens / reasoningEfforts
 *      是他自己的调参结果，对齐不是「重置成探测值」，只摘死记录、补新记录。
 *   2. **判活跟面板用同一套判据**（`sameModel`），否则会出现「面板标红两条、对齐只删一条」。
 *   3. **不产生空 models 数组** —— 一条 provider 0 个模型在 llm-pi-ai 里是配置错误，
 *      不是「不用它」。全部不在了就明确让人去删 provider。
 *
 * @param {{declared?: Array<object>, live?: Array<{id?: string, contextWindow?: number}>, fallbackMaxTokens?: number}} input
 * @returns {{ok: true, changed: boolean, models: Array<object>, removed: string[], added: string[], kept: string[]}
 *   | {ok: false, error: string}}
 */
export function planAlign(input = {}) {
  const declared = Array.isArray(input.declared) ? input.declared : []
  const live = Array.isArray(input.live) ? input.live : []
  const fallbackMaxTokens = Number(input.fallbackMaxTokens) > 0 ? Number(input.fallbackMaxTokens) : 4096
  // [align-removal] 默认允许摘除，但调用方可以关掉 —— llama.cpp 一次只报当前加载的
  // 那一个模型，「没在清单里」不等于「没装」，对它做减法会把用户配好的模型删掉。
  const allowRemoval = input.allowRemoval !== false

  // [align-empty] 「本来就没有模型」的守卫必须在最前面。
  // 原来它在 models.length === 0 分支里，有 live 就直接绕过去，于是
  // planAlign({declared: [], live: [{id:'m1'}]}) 会「对齐」出一条凭空造出来的 provider。
  if (declared.length === 0) {
    return { ok: false, error: '这条 provider 本来就没有模型，没必要对齐' }
  }

  const liveIds = live
    .map((entry) => ({ id: String(entry?.id ?? '').trim(), contextWindow: Number(entry?.contextWindow) || 0 }))
    .filter((entry) => entry.id.length > 0)

  const kept = []
  const removed = []
  for (const model of declared) {
    const id = String(model?.id ?? '').trim()
    if (id.length === 0) continue
    if (liveIds.some((entry) => sameModel(entry.id, id))) kept.push(model)
    else if (allowRemoval) removed.push(id)
    // 不允许摘除时，后端没报的条目原样留着 —— 它可能只是这轮没加载。
    else kept.push(model)
  }

  const added = []
  const models = [...kept]
  for (const entry of liveIds) {
    if (declared.some((model) => sameModel(String(model?.id ?? ''), entry.id))) continue
    // 后端报回来的 id 就是它认的名字，原样写进去。
    // contextWindow 只在探测到真值时才写：拿 maxTokens（输出预算）兜底是量纲不同的
    // 两件事，会把上下文长度写成一个莫名的小数字（如 2048）。
    const entryModel = { id: entry.id, maxTokens: fallbackMaxTokens, input: ['text'], reasoningEfforts: { off: null, low: 'low' } }
    if (entry.contextWindow > 0) entryModel.contextWindow = entry.contextWindow
    models.push(entryModel)
    added.push(entry.id)
  }

  if (models.length === 0) {
    return {
      ok: false,
      error: `后端一个模型都没有（声明的 ${declared.length} 个全不在了）。这种 provider 应该直接删掉，而不是对齐成 0 个模型`,
    }
  }
  return {
    ok: true,
    changed: removed.length > 0 || added.length > 0,
    models,
    removed,
    added,
    kept: kept.map((model) => String(model?.id ?? '')),
  }
}

/**
 * 「对账」：只摘掉后端已经不存在的模型，绝不往后补。
 *
 * 跟 `planAlign` 的分工：对齐是用户点一下「我要这份清单跟后端一样」，
 * 所以死的摘掉、活的补上；对账是后台自己做的维护动作，用户没点过任何东西，
 * 所以只能做减法 —— 悄悄往 provider 里塞模型会改变模型选择器的内容，
 * 那不是「维护」，那是替用户做决定。
 *
 * 三种结论：
 *   - `keep`：声明的都还在，什么都不用做。
 *   - `prune`：有一部分不在了，把这几个摘掉，活着的条目原样保留（含用户的调参）。
 *   - `remove`：一个都不剩了 —— 这条 provider 已经没有存在理由，该整条删掉。
 *
 * 「删 provider」为什么不在这里做：这是纯函数，只算结论。真删要走 settings，
 * 而且删错了没法撤销，所以留给调用方显式执行。
 *
 * @param {{declared?: Array<object>, live?: Array<{id?: string}>}} input
 * @returns {{ok: true, action: 'keep'|'prune'|'remove', models: Array<object>, removed: string[]}
 *   | {ok: false, error: string}}
 */
export function planReconcile(input = {}) {
  const declared = Array.isArray(input.declared) ? input.declared : []
  const live = input.live

  // 不知道后端有什么的时候一律不动。空数组是「后端真的一个模型都没有」，
  // undefined 是「没问到」—— 两者后果天差地别，绝不能混为一谈。
  if (!Array.isArray(live)) {
    return { ok: false, error: '没拿到后端此刻的模型清单，不能对账（探测失败不等于模型没了）' }
  }
  if (declared.length === 0) {
    return { ok: false, error: '这条 provider 本来就没有模型，没什么可对账的' }
  }

  const liveIds = live
    .map((entry) => String(entry?.id ?? '').trim())
    .filter((id) => id.length > 0)

  const kept = []
  const removed = []
  for (const model of declared) {
    const id = String(model?.id ?? '').trim()
    if (id.length === 0) continue
    if (liveIds.some((liveId) => sameModel(liveId, id))) kept.push(model)
    else removed.push(id)
  }

  if (removed.length === 0) {
    return { ok: true, action: 'keep', models: kept, removed: [] }
  }
  if (kept.length === 0) {
    return { ok: true, action: 'remove', models: [], removed }
  }
  return { ok: true, action: 'prune', models: kept, removed }
}

/**
 * 把端点收敛成一个可比较的字符串：补 `/v1`、回环主机名统一成 `127.0.0.1`、去尾斜杠。
 *
 * 为什么要统一回环名：用户填 `localhost:11434` 和 `127.0.0.1:11434` 是同一个 Ollama，
 * 但字符串不相等。不收敛的话「复用已有 provider」会失效 —— 同一个后端照样长出第二条。
 * 只动回环地址，其余主机名原样保留（`host.docker.internal` 之类不能乱改）。
 *
 * @param {string} raw
 * @returns {string}
 */
function canonicalEndpoint(raw) {
  const normalized = normalizeEndpoint(String(raw ?? ''))
  if (normalized.length === 0) return ''
  try {
    const url = new URL(normalized)
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host === '[::1]' || host === '::1' || host === '0.0.0.0') {
      url.hostname = '127.0.0.1'
    }
    // URL 会把默认端口吃掉（:80/:443），这里不补回来 —— 两边都走同一套规则就不会误判。
    return url.toString().replace(/\/+$/, '')
  } catch {
    return normalized
  }
}

/**
 * 找一条「同一个后端」的现成 provider，用来把新模型追加进去而不是再建一条。
 *
 * 为什么要这个：`defaultProviderId` 每次都按「后端 + 模型名」造 id，于是同一个
 * Ollama 会攒出 `local-ollama-qwen3-14b`、`local-ollama-qwen3-8b`、`local-ollama-gemma4-12b`…
 * 每个只挂一个模型，面板上半截越拉越长，删掉一个模型还得记着删对应那条 provider。
 * 同一个 baseURL 本来就该共用一条 provider。
 *
 * 只复用「通用名」那一条（`local-ollama` / `local-llamacpp` 这种），因为那是
 * 「这个后端整体」的代表；用户自己起的名字（`local-ollama-qwen3-14b`）是他有意
 * 分开配置的（可能调过 contextWindow / compat），往里面塞新模型会让人意外。
 *
 * @param {Array<{id?: string, profile?: object}>} providers
 * @param {string} endpoint
 * @param {string} backend `ollama` / `llamacpp` / `vllm` / `lmstudio` / `local`
 * @returns {{id: string, profile: object} | undefined}
 */
export function findReusableProvider(providers, endpoint, backend) {
  const list = Array.isArray(providers) ? providers : []
  const want = canonicalEndpoint(endpoint)
  if (want.length === 0) return undefined
  const generic = genericProviderId(backend)
  const sameBackend = list.filter((entry) => {
    const base = canonicalEndpoint(String(entry?.profile?.baseURL ?? ''))
    return base.length > 0 && base === want
  })
  if (sameBackend.length === 0) return undefined
  // [reuse-by-endpoint] 原来只认 id === generic，而按端口 + 模型名猜出来的 id 是
  // `local-llamacpp-qwen3-4b` 这种带 slug 的，永远不等于 `local-llamacpp` ——
  // 于是每导入一次就新长一条 provider（实测 probe-twice.mjs），面板上半截越拉越长。
  // 判据改成「同一个 baseURL」：只有一条就直接复用；有多条时优先通用名那条，
  // 因为用户自己起的名字（可能调过 contextWindow / compat）不该被随便塞模型。
  const genericHit = sameBackend.find((entry) => String(entry?.id ?? '') === generic)
  return genericHit ?? sameBackend[0]
}

/**
 * 把一个新模型追加到已有 profile 的 models 里（纯函数，不碰 settings）。
 *
 * `mergeLayers` 对数组是**整体替换**，所以写回时必须给完整的 models 数组，
 * 只传新增那一条会把原来的一起冲掉。
 *
 * @param {{profile?: object, modelId?: string, contextWindow?: number, maxTokens?: number}} input
 * @returns {{ok: true, changed: boolean, profile: object} | {ok: false, error: string}}
 */
export function appendModelToProfile(input = {}) {
  const profile = input?.profile !== null && typeof input?.profile === 'object' ? input.profile : {}
  const modelId = String(input?.modelId ?? '').trim()
  if (modelId.length === 0) return { ok: false, error: '没有模型 id' }
  const models = Array.isArray(profile.models) ? profile.models : []
  // 已经有同名模型：不重复加，也不报错 —— 用户点「导入」想要的结果已经在了。
  if (models.some((model) => sameModel(String(model?.id ?? ''), modelId))) {
    return { ok: true, changed: false, profile }
  }
  const contextWindow = Number(input?.contextWindow) > 0 ? Math.floor(Number(input.contextWindow)) : 0
  const maxTokens = Number(input?.maxTokens) > 0 ? Math.floor(Number(input.maxTokens)) : 4096
  const entry = {
    id: modelId,
    ...(contextWindow > 0 ? { contextWindow } : {}),
    maxTokens,
    input: ['text'],
    reasoningEfforts: { off: null, low: 'low' },
  }
  // [default-recalc] buildProfile 把 defaultContextWindow 定成「所有模型里最小的那个」，
  // 追加一个窗口更小的模型后必须跟着降，否则两者打架：选择器按 65536 报、实际模型只认 4096。
  const nextModels = [...models, entry]
  const windows = nextModels
    .map((model) => Number(model?.contextWindow))
    .filter((value) => Number.isFinite(value) && value > 0)
  const nextDefault = windows.length > 0 ? Math.min(...windows) : Number(profile.defaultContextWindow) || 0
  const currentDefault = Number(profile.defaultContextWindow) || 0
  const patched =
    nextDefault > 0 && (currentDefault === 0 || nextDefault < currentDefault)
      ? { defaultContextWindow: nextDefault }
      : {}
  return { ok: true, changed: true, profile: { ...profile, ...patched, models: nextModels } }
}

/**
 * 用导入参数拼出 llm-pi-ai 的 profile。
 * thinking=false 时显式关掉 chat template 的思考模式（默认值，本地小模型最常踩的坑）；
 * thinking=true 时不写任何 compat，交给后端的默认模板。
 */
export function buildImportProfile(parsed, probed) {
  return buildProfile({
    provider: parsed.provider,
    baseURL: parsed.endpoint,
    models: [
      {
        id: parsed.model,
        contextWindow: parsed.contextWindow ?? probed?.contextWindow,
        maxTokens: parsed.maxTokens ?? probed?.maxTokens,
      },
    ],
    displayName: parsed.displayName.length > 0 ? parsed.displayName : undefined,
    // thinking=true → null（不写 compat）；其余传 undefined，让 buildProfile 走
    // DEFAULT_CHAT_TEMPLATE_KWARGS + thinkingFormat 那条分支——只写 chatTemplateKwargs
    // 而不写 thinkingFormat，宿主的 openai 分支根本不会把它发出去。
    chatTemplateKwargs: parsed.thinking === true ? null : undefined,
  })
}

/** 一条 provider 在面板上的展示名 + 模型摘要。 */
export function summarizeProvider(id, profile) {
  const models = Array.isArray(profile?.models) ? profile.models : []
  const first = models[0] ?? {}
  return {
    id,
    displayName: String(profile?.displayName ?? id),
    baseURL: String(profile?.baseURL ?? ''),
    modelCount: models.length,
    models: models.map((entry) => ({
      id: String(entry?.id ?? ''),
      contextWindow: Number(entry?.contextWindow) || 0,
      maxTokens: Number(entry?.maxTokens) || 0,
    })),
    contextWindow: Number(first.contextWindow) || 0,
    maxTokens: Number(first.maxTokens) || 0,
  }
}

/**
 * 发一次最小真实请求，确认「模型真的能出字」。
 * 不做流式：只量端到端耗时，够判断活着还是死了。
 * @param {{fetchImpl?: typeof fetch, baseURL: string, model: string, apiKey?: string,
 *   timeoutMs?: number, prompt?: string, maxTokens?: number, chatTemplateKwargs?: object}} options
 */
export async function smokeTest(options) {
  const fetchImpl = options?.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  const baseURL = normalizeEndpoint(options?.baseURL)
  const model = String(options?.model ?? '').trim()
  if (fetchImpl === undefined) return { ok: false, ms: 0, error: '运行时不提供 fetch' }
  if (baseURL.length === 0) return { ok: false, ms: 0, error: 'provider 没有 baseURL' }
  if (model.length === 0) return { ok: false, ms: 0, error: 'provider 没有模型 id' }

  const timeoutMs = Number.isInteger(options?.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 60000
  // 冷加载自动重试（v0.4.7）：第一次超时几乎总是「权重还在读盘」，模型进程并没有死，
  // 立刻再来一轮多半就出字了 —— 面板上点一次就等于点两次。
  const retryOnTimeout = options?.retryOnTimeout !== false
  const startedAt = Date.now()
  // 每轮请求各有一个 controller；这里只记 timer，收尾统一清掉 —— 免得留一个悬着的
  // 定时器把事件循环（以及测试进程）拖住。
  const timers = new Set()
  // 总预算：默认给「第一轮 + 一次重试」各 timeoutMs，超了就不再来回试。
  const deadline = startedAt + timeoutMs * (retryOnTimeout ? 2 : 1)
  const isTimeout = (error) => {
    const name = String(error?.name ?? '')
    const message = String(error?.message ?? '')
    return name === 'AbortError' || name === 'TimeoutError' || /abort/i.test(message)
  }
  const timeoutResult = (ms, retries) => ({
    ok: false,
    ms,
    retries,
    timedOut: true,
    error:
      // [timeout-text] 不到 1 秒的配置不能被显示成「0 秒」（面板把 smokeTimeout 设成
      // 0.1 秒时用户看到「超时（0 秒）」，像是插件自己算错了）。低于 1 秒就按毫秒说。
      `试跑超时（${timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) + ' 秒' : timeoutMs + ' 毫秒'}${retries > 0 ? '，已自动重试一次' : ''}）—— ` +
      '大模型第一次要把权重读进内存，比之后每次都慢；稍等片刻再点一次，' +
      '或在配置面板把「试跑超时（秒）」调大',
  })

  /**
   * 一轮真实请求。两种「关掉思考」的写法分两次试：
   *   1. `chat_template_kwargs` —— vLLM / llama.cpp 的 OpenAI 兼容层认这个；
   *   2. `reasoning_effort: 'none'` —— Ollama 的 OpenAI 兼容层认这个。
   * 不能一次全塞进去：有的后端对未知字段直接 400，分开试才能既兼容又干净。
   */
  const attempt = async (extraBody) => {
    // 每轮请求各自一个 controller + 计时器。整段共用一个（v0.4.6 的写法）会有一个坑：
    // 第一轮把预算耗尽并 abort 之后，同一个 signal 已经是 aborted 状态，第二轮
    // 「换个写法再试」会立刻失败 —— 看起来就像「面板第一次总是失败」。
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = controller !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined
    if (timer !== undefined) timers.add(timer)
    try {
      return await request(extraBody, controller)
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(timer)
      }
    }
  }
  const request = async (extraBody, controller) => {
    const response = await fetchImpl(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // 本地端点不校验 key，但部分后端（vLLM 的 --api-key）要求头存在。
        // 没有真 key 时不要硬塞一个假 Bearer —— 那会让开了 --api-key 的后端直接 401。
        ...(options?.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: options?.prompt ?? '只回一个字：好' }],
        max_tokens: options?.maxTokens ?? 24,
        temperature: 0,
        stream: false,
        ...extraBody,
      }),
      ...(controller !== undefined ? { signal: controller.signal } : {}),
    })
    const ms = Date.now() - startedAt
    const text = await response.text()
    if (!response.ok) {
      return { ok: false, ms, status: response.status, error: `HTTP ${response.status}: ${text.slice(0, 300)}` }
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, ms, error: '后端返回的不是 JSON：' + text.slice(0, 200) }
    }
    const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined
    const usage = body?.usage ?? {}
    return {
      ok: true,
      ms,
      text: String(choice?.message?.content ?? ''),
      reasoning: String(choice?.message?.reasoning ?? choice?.message?.reasoning_content ?? ''),
      finishReason: choice?.finish_reason ?? undefined,
      promptTokens: Number(usage.prompt_tokens) || 0,
      completionTokens: Number(usage.completion_tokens) || 0,
    }
  }

  // 放在 try 之外：catch 里报超时文案要用它（在 try 内声明就出了作用域）
  let retried = 0

  try {
    let first
    try {
      first = await attempt(
        options?.chatTemplateKwargs ? { chat_template_kwargs: options.chatTemplateKwargs } : {},
      )
    } catch (error) {
      // 只有超时才自动重试：连不上、HTTP 报错这些重试也是一样的结果，早点把原因给人看。
      if (!retryOnTimeout || !isTimeout(error) || Date.now() >= deadline) throw error
      retried = 1
      first = await attempt(
        options?.chatTemplateKwargs ? { chat_template_kwargs: options.chatTemplateKwargs } : {},
      )
    }
    first.retries = 0
    // HTTP 层就失败了，直接返回，不用再试第二种写法
    if (first.ok !== true) return first
    if (first.text.trim().length > 0) return { ...first, attempt: 'chat_template_kwargs' }

    // 正文是空的：混合思考模型把预算全花在 reasoning 上。换 Ollama 认的写法再试一次。
    const second = await attempt({ reasoning_effort: 'none' })
    second.retries = 0
    if (second.ok === true && second.text.trim().length > 0) {
      return { ...second, attempt: 'reasoning_effort' }
    }
    if (second.ok !== true) return second

    const spent = (first.completionTokens || 0) + (second.completionTokens || 0)
    return {
      ok: false,
      ms: Date.now() - startedAt,
      status: 200,
      text: '',
      finishReason: first.finishReason ?? second.finishReason,
      promptTokens: first.promptTokens || 0,
      completionTokens: spent,
      error:
        spent > 0
          ? `后端回了空正文（两次共用了 ${spent} 个 token）—— 模型把预算全花在思考上了；` +
            '关掉思考模式（勾掉「保留思考模式」）或换一个非思考模型'
          : '后端回了空正文',
    }
  } catch (error) {
    // 超时单独说话（并给可操作的建议），别的错误原样透出
    if (isTimeout(error)) return timeoutResult(Date.now() - startedAt, retried)
    return { ok: false, ms: Date.now() - startedAt, error: String(error?.message ?? error) }
  } finally {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }
}
