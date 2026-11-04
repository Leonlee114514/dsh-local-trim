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
  if (/\/v\d+(?:beta\d*)?$/i.test(base)) return base
  return `${base}/v1`
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
  const tried = []
  for (const endpoint of endpoints) {
    const result = await probeEndpoint({ baseURL: endpoint, fetchImpl, timeoutMs })
    tried.push(result)
    if (result.ok) return { ...result, tried }
  }
  return { ok: false, baseURL: '', models: [], tried }
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
 */
export function buildProfile({
  provider,
  baseURL,
  models,
  displayName,
  defaultContextWindow,
  defaultMaxTokens,
  chatTemplateKwargs,
  apiKeyEnv = DEFAULT_API_KEY_ENV,
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
  const derivedContext = entries.length > 0 ? Math.min(...entries.map((entry) => entry.contextWindow)) : FALLBACK_CONTEXT
  const derivedMaxTokens = entries.length > 0 ? Math.min(...entries.map((entry) => entry.maxTokens)) : FALLBACK_MAX_TOKENS
  const profile = {
    displayName: displayName ?? guessDisplayName(provider, baseURL),
    // 本地端点不校验 key，但 provider 没有 credential 声明时 pi-ai 不会带
    // Authorization 头，llama.cpp 会静默返回空 completion（不是 401）。
    // 指向一个任意环境变量名即可；值为空也照常工作。
    apiKeyEnv,
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
    // 显式 null：不写 compat，避免后端对未知 kwarg 报错。
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

/** 自动生成的 provider 默认引用的凭据环境变量名。值为空也能工作。 */
export const DEFAULT_API_KEY_ENV = 'DSH_LOCAL_LLM_API_KEY'

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
  return { registered: true, revision: descriptor.revision }
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
  if (existing === undefined) {
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
  if (still !== undefined) {
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
