/**
 * provision.js — 探测本地推理端点 + 注册成 DSH 的 llm-pi-ai provider。
 *
 * 目标：让「装个插件」= 「本地模型能用了」。
 * 不做任何猜测式写入：只写 settings 里 llm-pi-ai.providers（该字段是 volatile 的，
 * 写完 loader 会触发 ensureRegistrationFacts() 重新注册 adapter，无需重启）。
 */

/** 常见本地推理端点的探测顺序。命中第一个就停。 */
export const DEFAULT_ENDPOINTS = [
  'http://127.0.0.1:8090/v1', // llama.cpp (llama-server)
  'http://127.0.0.1:11434/v1', // Ollama
  'http://127.0.0.1:8000/v1', // vLLM
  'http://127.0.0.1:1234/v1', // LM Studio
]

/** 猜不到真实窗口时的兜底值。宁可保守：模型真窗口更大只是浪费，反过来会溢出。 */
export const FALLBACK_CONTEXT = 32768
export const FALLBACK_MAX_TOKENS = 4096

const trimSlash = (value) => String(value ?? '').trim().replace(/\/+$/, '')

/**
 * 规范化端点：允许用户只写 `http://127.0.0.1:8080`，自动补 `/v1`。
 * @param {string} raw
 * @returns {string}
 */
export function normalizeEndpoint(raw) {
  const base = trimSlash(raw)
  if (base.length === 0) return ''
  // [endpoint-path] 按 pathname 判断，别拿整串正则去啃 —— 原来 `/\/v\d+$/` 只看末尾，
  // 于是 `http://h:8090/v1/chat/completions` 被补成 `.../chat/completions/v1`、
  // `http://h:8090/?api=v1` 被补成 `?api=v1/v1`，两个都指向不存在的地址。
  let url
  try {
    url = new URL(base)
  } catch {
    return base
  }
  const path = url.pathname.replace(/\/+$/, '')
  const versioned = /\/v\d+(?:beta\d*)?$/i.test(path)
  // 已经写到了具体资源路径（/chat/completions、/models…）：原样返回，用户写的是完整地址。
  const deep = /\/(?:chat\/completions|completions|models|embeddings|tags)$/i.test(path)
  if (versioned || deep) return base
  url.pathname = `${path}/v1`
  return url.toString().replace(/\/+$/, '')
}

/**
 * 从 provider 名或端点推断一个人类可读的显示名。
 * @param {string} provider
 * @param {string} baseURL
 * @returns {string}
 */
export function guessDisplayName(provider, baseURL) {
  const port = (() => {
    try {
      return new URL(baseURL).port
    } catch {
      return ''
    }
  })()
  const byPort = {
    '8090': 'llama.cpp',
    '11434': 'Ollama',
    '8000': 'vLLM',
    '1234': 'LM Studio',
  }
  const backend = byPort[port]
  if (backend !== undefined) return `${backend} · ${provider}`
  return provider
}

/** 从 URL 里取端口，取不到返回 0。 */
const portOf = (baseURL) => {
  try {
    return Number(new URL(baseURL).port) || 0
  } catch {
    return 0
  }
}

/**
 * llama.cpp 的 /v1/models 会带 meta.n_ctx；Ollama 的 /api/tags 只有名字。
 * 统一收敛成 `{ id, contextWindow, maxTokens, guessedContext }`。
 * @param {any} payload
 * @returns {Array<{id: string, contextWindow: number, maxTokens: number, guessedContext: boolean}>}
 */
export function modelsFromOpenAIPayload(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  const out = []
  for (const entry of list) {
    const id = String(entry?.id ?? entry?.name ?? entry?.model ?? '').trim()
    if (id.length === 0) continue
    const meta = entry?.meta ?? entry?.details ?? {}
    const ctx = Number(meta?.n_ctx ?? meta?.context_length ?? entry?.context_length ?? 0)
    const maxOut = Number(meta?.n_predict ?? 0)
    out.push({
      id,
      contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : FALLBACK_CONTEXT,
      maxTokens: Number.isFinite(maxOut) && maxOut > 0 ? maxOut : FALLBACK_MAX_TOKENS,
      guessedContext: !(Number.isFinite(ctx) && ctx > 0),
    })
  }
  return out
}

/**
 * Ollama 原生 /api/tags 的返回：`{ models: [{ name, model, details }] }`。
 * @param {any} payload
 */
export function modelsFromOllamaPayload(payload) {
  const list = Array.isArray(payload?.models) ? payload.models : []
  return list
    .map((entry) => String(entry?.model ?? entry?.name ?? '').trim())
    .filter((id) => id.length > 0)
    .map((id) => ({ id, contextWindow: FALLBACK_CONTEXT, maxTokens: FALLBACK_MAX_TOKENS, guessedContext: true }))
}

/** 带超时的 GET，失败返回 `{ ok: false }`，不抛。 */
async function getJson(fetchImpl, url, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer =
    controller !== undefined && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(controller !== undefined ? { signal: controller.signal } : {}),
    })
    if (!response?.ok) return { ok: false, status: response?.status, url }
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, status: response.status, url, reason: 'not-json' }
    }
    return { ok: true, status: response.status, url, body }
  } catch (error) {
    return { ok: false, url, reason: String(error?.message ?? error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 探测单个端点。顺序：/v1/models → /models → /api/tags。
 * 返回 `{ ok, baseURL, models, via }`；全失败时 `ok: false` 且带每次尝试的原因。
 * @param {object} options
 * @param {string} options.baseURL
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 */
export async function probeEndpoint({ baseURL, fetchImpl = fetch, timeoutMs = 2500 }) {
  const base = normalizeEndpoint(baseURL)
  if (base.length === 0) return { ok: false, baseURL, models: [], attempts: [{ url: baseURL, reason: 'empty' }] }
  const attempts = []

  for (const suffix of ['/models', '']) {
    const url = `${base}${suffix}`
    const result = await getJson(fetchImpl, url, timeoutMs)
    if (!result.ok) {
      attempts.push({ url, reason: result.reason ?? `status ${result.status}` })
      continue
    }
    const models = modelsFromOpenAIPayload(result.body)
    if (models.length === 0) {
      attempts.push({ url, reason: 'no models listed' })
      continue
    }
    return { ok: true, baseURL: base, models, via: suffix === '' ? 'root' : 'openai', attempts }
  }

  // Ollama 的 OpenAI 兼容层在 /v1/models 一定存在，但有些旧版只暴露原生 API。
  const origin = base.replace(/\/v\d+$/i, '')
  const ollama = await getJson(fetchImpl, `${origin}/api/tags`, timeoutMs)
  if (ollama.ok) {
    const models = modelsFromOllamaPayload(ollama.body)
    if (models.length > 0) {
      return { ok: true, baseURL: base, models, via: 'ollama', attempts }
    }
    attempts.push({ url: `${origin}/api/tags`, reason: 'no models listed' })
  } else {
    attempts.push({ url: `${origin}/api/tags`, reason: ollama.reason ?? `status ${ollama.status}` })
  }

  return { ok: false, baseURL: base, models: [], attempts }
}

/**
 * 按顺序探测多个端点，返回第一个可用的。
 * @param {object} options
 * @param {string[]} options.endpoints
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 */
export async function probeFirstAvailable({ endpoints, fetchImpl = fetch, timeoutMs = 2500 }) {
  // [probe-parallel] 原来串行 + 不去重：两个相同端点 = 六次请求，四个默认端点全挂
  // 实测 2512ms = 13×timeoutMs，配上启动时的 2500/3000ms 最坏能卡三十秒。
  // 现在去重后并行发，按原始顺序挑第一个成功的（顺序即优先级）。
  const list = []
  const seen = new Set()
  for (const endpoint of Array.isArray(endpoints) ? endpoints : []) {
    const key = normalizeEndpoint(endpoint)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    list.push({ raw: endpoint, key })
  }
  if (list.length === 0) return { ok: false, baseURL: '', models: [], tried: [] }
  const settled = await Promise.all(
    list.map((item) => probeEndpoint({ baseURL: item.key, fetchImpl, timeoutMs }).catch((error) => ({ ok: false, baseURL: item.key, models: [], attempts: [{ url: item.key, reason: String(error?.message ?? error) }] }))),
  )
  const hit = settled.find((result) => result.ok === true)
  if (hit !== undefined) {
    // 只把排在它前面的失败一起带出去，后面的没必要探（用户也不需要看）。
    const index = settled.indexOf(hit)
    return { ...hit, tried: settled.slice(0, index + 1) }
  }
  return { ok: false, baseURL: '', models: [], tried: settled }
}

/**
 * 把探测结果转成 llm-pi-ai 的 profile。
 * @param {object} options
 * @param {string} options.provider
 * @param {string} options.baseURL
 * @param {Array<{id: string, contextWindow: number, maxTokens: number}>} options.models
 * @param {string} [options.displayName]
 * @param {number} [options.defaultContextWindow]
 * @param {number} [options.defaultMaxTokens]
 * @param {Record<string, string>} [options.headers] 覆盖默认的兜底请求头
 * @param {string} [options.apiKeyEnv] 只在后端真的要校验 key 时才传
 */
export function buildProfile({
  provider,
  baseURL,
  models,
  displayName,
  defaultContextWindow,
  defaultMaxTokens,
  chatTemplateKwargs,
  headers,
  apiKeyEnv,
}) {
  const entries = models.map((model) => ({
    id: model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: ['text'],
    // pi-ai 只在 model.reasoning === true 时才走 thinking dispatch 分支
    // (@earendil-works/pi-ai/dist/api/openai-completions.js:646)，而 reasoning
    // 由 reasoningEfforts 决定（dsh-llm-pi-ai:resolveModelReasoning）。
    // 声明 off + 一档 low 只为把 reasoning 打开到 true，让下面的
    // chatTemplateKwargs 真的写进请求体；默认不选 reasoning 时走的仍是 off。
    reasoningEfforts: { off: null, low: 'low' },
  }))
  // defaultContextWindow 取所有模型的最小值：宁可保守，避免大模型上配错导致溢出。
  // [derived-nan] 必须先把「没给」的条目剔掉：`Math.min(undefined)` 是 NaN，
  // NaN 被 JSON.stringify 写成 null 落盘，llm-pi-ai 读到 null 就把这条 provider 当坏配置。
  const positives = (list) => list.map(Number).filter((n) => Number.isFinite(n) && n > 0)
  const ctxs = positives(entries.map((entry) => entry.contextWindow))
  const maxes = positives(entries.map((entry) => entry.maxTokens))
  const derivedContext = ctxs.length > 0 ? Math.min(...ctxs) : FALLBACK_CONTEXT
  const derivedMaxTokens = maxes.length > 0 ? Math.min(...maxes) : FALLBACK_MAX_TOKENS
  const namedCredential = typeof apiKeyEnv === 'string' && apiKeyEnv.length > 0
  // 没有真 key 时塞一个无害的 Authorization：pi-ai 的 getClientApiKey 在既无 apiKey
  // 又无 Authorization 头时会直接抛 "No API key for provider: ..."，而有些后端
  // （llama.cpp 的 /v1/chat/completions）要求头存在才正常回内容。声明了 apiKeyEnv 就
  // 不塞，否则这个头会和真 key 抢同一个 header 名。
  // [keep-auth] 用户自己带了 Authorization 就别塞占位符 —— 默认头在前虽然能被同名键覆盖，
  // 但 `{Authorization:'Bearer local', ...{Authorization:'Bearer sk-real'}}` 只在字面量里成立；
  // 一旦 headers 是从别处浅拷来的、键名大小写不同（authorization），真 key 就被顶成假 key。
  const hasAuth =
    headers !== undefined &&
    headers !== null &&
    Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
  const requestHeaders =
    namedCredential || hasAuth
      ? headers === undefined || headers === null
        ? undefined
        : { ...headers }
      : { ...DEFAULT_AUTH_HEADER, ...headers }
  const profile = {
    displayName: displayName ?? guessDisplayName(provider, baseURL),
    // 默认不声明凭据引用。宿主对「声明了但解析不到值」的 ref 会抛 MISSING_CREDENTIAL，
    // 而 llm-pi-ai 的 listModels 把它吞成空数组，模型目录再按
    // `.filter(group => group.models.length > 0)` 把整条 provider 丢掉 ——
    // 表现就是「配置里看得见这个 provider，模型选择器里却一个模型都没有」。
    // 所以只有后端真的要校验 key 时才写 apiKeyEnv。
    ...(namedCredential ? { apiKeyEnv } : {}),
    ...(requestHeaders === undefined ? {} : { headers: requestHeaders }),
    baseURL,
    api: 'openai-completions',
    defaultContextWindow: Number(defaultContextWindow) > 0 ? Number(defaultContextWindow) : derivedContext,
    defaultMaxTokens: Number(defaultMaxTokens) > 0 ? Number(defaultMaxTokens) : derivedMaxTokens,
    models: entries,
  }
  // 本地 llama.cpp / vLLM 的 chat template 默认开思考模式：模型把 max_tokens 全花在
  // reasoning_content 上，content 直接空字符串（finish_reason: length）。
  // 默认关掉，需要思考的模型自己加 "-think" 变体。
  if (chatTemplateKwargs === null) {
    // 显式 null：不写 compat，交给后端自己的模板。
    // 注意：只「不写」在**覆盖写入**时清不掉旧值（settings.update 走 mergeLayers，缺键=不动），
    // 那一步由 clearStaleCompat() 补 —— 调用方在 registerProvider 成功后调它。
  } else if (chatTemplateKwargs !== undefined) {
    profile.compat = { chatTemplateKwargs }
  } else if (DEFAULT_CHAT_TEMPLATE_KWARGS !== null) {
    // thinkingFormat 必须一起写：默认 'openai' 分支不会把 chatTemplateKwargs
    // 翻译成 chat_template_kwargs，配置写了也发不出去。
    profile.compat = { thinkingFormat: 'chat-template', chatTemplateKwargs: { ...DEFAULT_CHAT_TEMPLATE_KWARGS } }
  }
  return profile
}

/**
 * 自动生成的 profile 默认带的 chat template 参数。
 * `enable_thinking: false` 对 Qwen3 / 多数 llama.cpp 模板有效；对不认识的模板是无害的额外 kwarg。
 * 设成 null 就不写 compat（某些后端会对未知 kwarg 报错）。
 */
export const DEFAULT_CHAT_TEMPLATE_KWARGS = { enable_thinking: false }

/** 自动生成的 provider 默认引用的凭据环境变量名。只在用户显式要求时才写进 profile。 */
export const DEFAULT_API_KEY_ENV = 'DSH_LOCAL_LLM_API_KEY'

/**
 * 不声明凭据引用时用的兜底请求头。
 * pi-ai 的 OpenAI 兼容实现要求「有 key 或有 Authorization 头」二者之一，否则发请求前就抛
 * `No API key for provider: …`；本地端点大多不校验值，给个占位符即可。
 */
export const DEFAULT_AUTH_HEADER = { Authorization: 'Bearer local' }

/** llm-pi-ai 的 settings 条目 id：patch 里 `- id:` 写什么就是什么。 */
export const LLM_SETTINGS_NS = 'llm-pi-ai'

/**
 * 把 profile 写进 settings。provider 已存在则默认跳过（除非 overwrite）。
 * @param {object} options
 * @param {any} options.settings  ctx.get('settings') 拿到的 SettingsForms
 * @param {string} options.provider
 * @param {any} options.profile
 * @param {string} [options.ns]
 * @param {boolean} [options.overwrite]
 * @returns {Promise<{ registered: boolean, reason?: string, revision: number }>}
 */
export async function registerProvider({ settings, provider, profile, ns = LLM_SETTINGS_NS, overwrite = false }) {
  if (settings === undefined || settings === null || typeof settings.update !== 'function') {
    return { registered: false, reason: 'settings 服务不可用', revision: -1 }
  }
  const descriptor = settings.describe?.().find((row) => row?.ns === ns)
  if (descriptor === undefined) {
    return { registered: false, reason: `找不到 settings 条目 "${ns}"（llm-pi-ai 没装？）`, revision: -1 }
  }
  const existing = descriptor.value?.providers?.[provider]
  if (existing !== undefined && existing !== null && overwrite !== true) {
    return { registered: false, reason: `provider "${provider}" 已存在，未覆盖`, revision: descriptor.revision }
  }
  await settings.update(ns, { providers: { [provider]: profile } }, descriptor.revision)
  // [revision-after] 原来返回写入**前**的 revision（实测返 7、实际 8），
  // 调用方拿它做下一次 CAS 会立刻冲突。回读一次，拿不到就退化成 +1。
  const after = settings.describe?.().find((row) => row?.ns === ns)
  const nextRevision = Number.isInteger(after?.revision) ? after.revision : descriptor.revision + 1
  return { registered: true, revision: nextRevision }
}

/**
 * 清掉一条 provider 上残留的 `compat`（不动别的字段）。
 *
 * [P2-05-2026-11-26] 为什么必须有这一步：`buildProfile({ chatTemplateKwargs: null })`
 * 的语义是「交回后端自己的模板」，实现上是「profile 里不带 compat」。但写入走
 * `settings.update` → `mergeLayers`，缺键 = 不动 ⇒ 上次写的 `compat.chatTemplateKwargs`
 * 会一直留着，「交回后端模板」这个选项静默无效。注释里原来把责任推给一个并不存在的
 * `clearStaleCompat()`，等于承诺了一个没人做的事。
 *
 * 删键只能走 `mutate` 的 unset（理由与 unregisterProvider 相同）；unset 对「从下层
 * 继承来的键」是恢复而不是删除，所以删完必须回读确认。
 *
 * @param {{settings: any, provider: string, ns?: string}} options
 * @returns {Promise<{cleared: boolean, already?: boolean, inherited?: boolean, reason?: string}>}
 */
export async function clearStaleCompat({ settings, provider, ns = LLM_SETTINGS_NS }) {
  const id = String(provider ?? '').trim()
  if (settings === undefined || settings === null) return { cleared: false, reason: 'settings 服务不可用' }
  if (id.length === 0) return { cleared: false, reason: '没说要清哪个 provider' }
  const describe = () => settings.describe?.().find((row) => row?.ns === ns)
  const descriptor = describe()
  if (descriptor === undefined) return { cleared: false, reason: `找不到 settings 条目 "${ns}"` }
  const existing = descriptor.value?.providers?.[id]
  if (existing === undefined || existing === null) return { cleared: false, reason: `provider "${id}" 不在` }
  if (existing.compat === undefined || existing.compat === null) return { cleared: false, already: true }
  if (typeof settings.mutate !== 'function') {
    return { cleared: false, reason: '这个 DSH 版本的 settings 服务没有 mutate()，清不掉 compat（只能手改 settings）' }
  }
  try {
    await settings.mutate(ns, [{ op: 'unset', path: ['providers', id, 'compat'] }], descriptor.revision)
  } catch (error) {
    return { cleared: false, reason: String(error?.message ?? error) }
  }
  const still = describe()?.value?.providers?.[id]?.compat
  if (still !== undefined && still !== null) {
    return {
      cleared: false,
      inherited: true,
      reason: `"${id}" 的 compat 来自下层配置（profile 的 cordis.patch.yml 或 home patch），这里删不掉`,
    }
  }
  return { cleared: true }
}

/**
 * 从 settings 里删掉一个 provider 配置（不动磁盘上的任何文件）。
 *
 * 为什么不直接用 `settings.update(ns, { providers: { id: null } })`：update 走的是
 * `mergeLayers`，把 null 合进去只会把值写成 null，键还在；llm-pi-ai 的 loader 见到
 * 一个 `null` 的 provider 会当成配置错误而不是「没有这一条」。真正的删除只能走
 * `mutate` 的 `unset` —— 它内部是 `Reflect.deleteProperty`。
 *
 * 但 `unset` 有个很坑的语义（dsh-settings 的 applyPathOp + mutate 非 legacy 分支）：
 * 只有当这个键**在用户层自己定义过**时才真删；如果它来自下层（profile 的
 * cordis.patch.yml / home patch），mutate 会把下层的值原样 set 回来。表现出来就是
 * 「调用成功了，但配置还在」。所以这里删完必须回读一次确认，不能凭 promise 成功就报成功。
 *
 * @param {object} options
 * @param {any} options.settings ctx.get('settings') 拿到的 SettingsForms
 * @param {string} options.provider 要删的 provider id
 * @param {string} [options.ns]
 * @returns {Promise<{ removed: boolean, reason?: string, inherited: boolean, revision: number }>}
 */
export async function unregisterProvider({ settings, provider, ns = LLM_SETTINGS_NS }) {
  const id = String(provider ?? '').trim()
  if (settings === undefined || settings === null) {
    return { removed: false, reason: 'settings 服务不可用', inherited: false, revision: -1 }
  }
  if (id.length === 0) {
    return { removed: false, reason: '没说要删哪个 provider', inherited: false, revision: -1 }
  }
  const describe = () => settings.describe?.().find((row) => row?.ns === ns)
  const descriptor = describe()
  if (descriptor === undefined) {
    return { removed: false, reason: `找不到 settings 条目 "${ns}"（llm-pi-ai 没装？）`, inherited: false, revision: -1 }
  }
  const existing = descriptor.value?.providers?.[id]
  // [null-provider] registerProvider 眼里 null 就是「没这条」（`existing !== null` 才拦），
  // 这里只判 undefined 就会把一条 null 当成「存在的、并且是从下层继承来的」。
  if (existing === undefined || existing === null) {
    return { removed: true, already: true, reason: `provider "${id}" 本来就不在`, inherited: false, revision: descriptor.revision }
  }

  // 只有 mutate 能真删键；老版本 settings 没有 mutate 就明说，不假装成功。
  if (typeof settings.mutate !== 'function') {
    return {
      removed: false,
      reason: '这个 DSH 版本的 settings 服务没有 mutate()，删不掉 provider 键（只能整段覆盖）',
      inherited: false,
      revision: descriptor.revision,
    }
  }

  try {
    await settings.mutate(ns, [{ op: 'unset', path: ['providers', id] }], descriptor.revision)
  } catch (error) {
    return { removed: false, reason: String(error?.message ?? error), inherited: false, revision: descriptor.revision }
  }

  // 回读：unset 对「从下层继承来的键」是恢复而不是删除。
  const after = describe()
  const still = after?.value?.providers?.[id]
  if (still !== undefined && still !== null) {
    return {
      removed: false,
      inherited: true,
      reason:
        `"${id}" 这条来自下层配置（profile 的 cordis.patch.yml 或 home patch），` +
        '在这里删不掉 —— 得改那个文件，或者先把 patch 里这段删掉让面板接管',
      revision: after?.revision ?? descriptor.revision,
    }
  }
  return { removed: true, inherited: false, revision: after?.revision ?? descriptor.revision }
}
