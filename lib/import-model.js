/**
 * 控制面板「导入本地模型」的纯逻辑。
 *
 * 这里不放任何 IO 之外的副作用：校验输入、拼 provider id、包装 profile、
 * 发一次最小真实请求。index.js 只负责把 settings / fetch 递进来，
 * test/panel.mjs 可以直接 import 这些函数跑断言。
 */

import { buildProfile, normalizeEndpoint } from './provision.js'

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

/** 默认 provider id：`local-<backend>-<model slug>`，同一端点换模型不会互相覆盖。 */
export function defaultProviderId(endpoint, modelId, hint) {
  const backend = BACKEND_BY_PORT[portOf(endpoint)] ?? backendByName(hint) ?? 'local'
  const slug = slugifyModel(modelId)
  return slug.length > 0 ? `local-${backend}-${slug}` : `local-${backend}`
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
  const exact = list.find((entry) => String(entry?.id ?? '') === target)
  if (exact !== undefined) return exact
  const lower = target.toLowerCase()
  return list.find((entry) => String(entry?.id ?? '').toLowerCase() === lower)
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

  const timeoutMs = Number.isInteger(options?.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = controller !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  const startedAt = Date.now()

  /**
   * 一轮真实请求。两种「关掉思考」的写法分两次试：
   *   1. `chat_template_kwargs` —— vLLM / llama.cpp 的 OpenAI 兼容层认这个；
   *   2. `reasoning_effort: 'none'` —— Ollama 的 OpenAI 兼容层认这个。
   * 不能一次全塞进去：有的后端对未知字段直接 400，分开试才能既兼容又干净。
   */
  const attempt = async (extraBody) => {
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

  try {
    const first = await attempt(
      options?.chatTemplateKwargs ? { chat_template_kwargs: options.chatTemplateKwargs } : {},
    )
    // HTTP 层就失败了，直接返回，不用再试第二种写法
    if (first.ok !== true) return first
    if (first.text.trim().length > 0) return { ...first, attempt: 'chat_template_kwargs' }

    // 正文是空的：混合思考模型把预算全花在 reasoning 上。换 Ollama 认的写法再试一次。
    const second = await attempt({ reasoning_effort: 'none' })
    if (second.ok === true && second.text.trim().length > 0) {
      return { ...second, attempt: 'reasoning_effort' }
    }

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
    return { ok: false, ms: Date.now() - startedAt, error: String(error?.message ?? error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
