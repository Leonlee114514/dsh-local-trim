/**
 * 一步到位：探测端点 → 注册 provider 的离线测试。
 *
 * 用假 fetch 模拟四种后端（llama.cpp / Ollama / vLLM / LM Studio）的 /v1/models，
 * 以及假 settings 服务，验证：
 *   1. 探测成功时 profile 字段正确、写进 llm-pi-ai.providers
 *   2. 已有可用本地 provider 时不写入任何配置（不覆盖用户现有设置）
 *   3. 端点全挂时给出可读的失败原因，不抛
 *   4. provision: false 时完全不动
 */

import {
  DEFAULT_ENDPOINTS,
  buildProfile,
  modelsFromOllamaPayload,
  modelsFromOpenAIPayload,
  normalizeEndpoint,
  probeEndpoint,
  probeFirstAvailable,
  registerProvider,
} from '../lib/provision.js'
// 测试会调 apply()，把日志写到临时文件，别污染 ~/.dsh/local-llm/local-trim.log。
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.DSH_LOCAL_TRIM_LOG = process.env.DSH_LOCAL_TRIM_LOG || join(tmpdir(), 'dsh-local-trim.test.log')
const { apply } = await import('../lib/index.js')

let fail = 0
const check = (label, ok, extra = '') => {
  if (!ok) fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
})

const LLAMACPP_BODY = {
  object: 'list',
  data: [
    {
      id: 'qwen35moe-local',
      meta: { n_ctx: 65536, n_predict: 8192, n_ctx_train: 262144 },
    },
  ],
}
const OLLAMA_BODY = { object: 'list', data: [{ id: 'llama3.2:3b' }] }
const OLLAMA_NATIVE = { models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b' }] }

console.log('\n=== 1. 端点规范化 ===')
check('补 /v1', normalizeEndpoint('http://127.0.0.1:8080') === 'http://127.0.0.1:8080/v1')
check('去尾斜杠', normalizeEndpoint('http://127.0.0.1:8080/v1/') === 'http://127.0.0.1:8080/v1')
check('保留已有版本段', normalizeEndpoint('http://h:9000/v1beta') === 'http://h:9000/v1beta')
check('空串保持空', normalizeEndpoint('  ') === '')

console.log('\n=== 2. 模型列表解析 ===')
const llama = modelsFromOpenAIPayload(LLAMACPP_BODY)
check('llama.cpp 取到 n_ctx', llama.length === 1 && llama[0].contextWindow === 65536, JSON.stringify(llama))
check('llama.cpp 不算猜', llama[0].guessedContext === false)
const ollama = modelsFromOpenAIPayload(OLLAMA_BODY)
check('无 n_ctx 时兜底并标记为猜', ollama[0].guessedContext === true)
const native = modelsFromOllamaPayload(OLLAMA_NATIVE)
check('Ollama 原生 /api/tags 解析', native.length === 1 && native[0].id === 'llama3.2:3b')

console.log('\n=== 3. 探测成功 / 失败 ===')
const hit = await probeEndpoint({
  baseURL: 'http://127.0.0.1:8090',
  fetchImpl: async (url) => (url === 'http://127.0.0.1:8090/v1/models' ? jsonResponse(LLAMACPP_BODY) : jsonResponse({}, 404)),
})
check('命中时 ok=true', hit.ok === true)
check('命中时 baseURL 带 /v1', hit.baseURL === 'http://127.0.0.1:8090/v1')
check('命中时带回模型', hit.models.length === 1 && hit.models[0].id === 'qwen35moe-local')

const miss = await probeEndpoint({
  baseURL: 'http://127.0.0.1:11434',
  fetchImpl: async () => {
    throw new Error('ECONNREFUSED')
  },
})
check('全挂时 ok=false', miss.ok === false)
check('全挂时给出原因', miss.attempts.some((a) => String(a.reason).includes('ECONNREFUSED')), JSON.stringify(miss.attempts))

const fallback = await probeEndpoint({
  baseURL: 'http://127.0.0.1:11434',
  fetchImpl: async (url) => {
    if (url.endsWith('/api/tags')) return jsonResponse(OLLAMA_NATIVE)
    return jsonResponse({}, 404)
  },
})
check('OpenAI 层 404 时退回 Ollama 原生', fallback.ok === true && fallback.via === 'ollama')

console.log('\n=== 4. 依次探测取第一个可用的 ===')
const order = []
const first = await probeFirstAvailable({
  endpoints: DEFAULT_ENDPOINTS,
  fetchImpl: async (url) => {
    order.push(url)
    if (url.startsWith('http://127.0.0.1:11434')) return jsonResponse(OLLAMA_BODY)
    return jsonResponse({}, 404)
  },
})
check('跳过 8090 命中 11434', first.ok === true && first.baseURL.includes('11434'), first.baseURL)
check('尝试顺序从 8090 开始', order[0].startsWith('http://127.0.0.1:8090'), order[0])

console.log('\n=== 5. profile 生成 ===')
const profile = buildProfile({ provider: 'local-llamacpp', baseURL: hit.baseURL, models: hit.models })
check('api 为 openai-completions', profile.api === 'openai-completions')
check('窗口取自 n_ctx', profile.defaultContextWindow === 65536)
check('maxTokens 取自 n_predict', profile.defaultMaxTokens === 8192)
check('模型带 input:text', JSON.stringify(profile.models[0].input) === '["text"]')
check('显示名带后端', profile.displayName.includes('llama.cpp'), profile.displayName)
check('默认关思考（避免 content 被 reasoning 吃光）', profile.compat?.chatTemplateKwargs?.enable_thinking === false)
check('thinkingFormat 一起写进 compat', profile.compat?.thinkingFormat === 'chat-template')
check('模型声明 reasoningEfforts（否则 enable_thinking 发不出去）', profile.models?.[0]?.reasoningEfforts?.low === 'low')
check('provider 带 apiKeyEnv（本地端点也会要求 Authorization 头）', typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0)

const noKwargs = buildProfile({
  provider: 'x',
  baseURL: 'http://127.0.0.1:8000/v1',
  models: hit.models,
  chatTemplateKwargs: null,
})
check('可显式关掉 compat', noKwargs.compat === undefined)

console.log('\n=== 6. 写 settings ===')
const writes = []
const makeSettings = (existing) => ({
  describe: () => [{ ns: 'llm-pi-ai', revision: 7, value: { providers: existing } }],
  update: async (ns, patch, revision) => {
    writes.push({ ns, patch, revision })
  },
})
const okSettings = makeSettings({})
const r1 = await registerProvider({ settings: okSettings, provider: 'local-llamacpp', profile })
check('写入成功', r1.registered === true && writes.length === 1)
check('写的是 llm-pi-ai', writes[0]?.ns === 'llm-pi-ai')
check('带 revision 防冲突', writes[0]?.revision === 7)
check('patch 形状正确', writes[0]?.patch?.providers?.['local-llamacpp']?.baseURL === hit.baseURL)

const skipSettings = makeSettings({ 'local-llamacpp': { baseURL: 'http://keep.me/v1' } })
writes.length = 0
const r2 = await registerProvider({ settings: skipSettings, provider: 'local-llamacpp', profile })
check('已存在时不覆盖', r2.registered === false && writes.length === 0, r2.reason)

const noSettings = await registerProvider({ settings: undefined, provider: 'x', profile })
check('settings 缺失时返回原因而不是抛', noSettings.registered === false && typeof noSettings.reason === 'string')

console.log('\n=== 7. apply 集成：已有可用 provider 时不写入 ===')
const handlers = new Map()
let updated = 0
const settingsStub = {
  describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }],
  update: async () => {
    updated += 1
  },
}
const ctxStub = {
  logger: { info: () => {} },
  get: (n) => {
    if (n === 'tools') return { schemas: () => [], restrict: () => () => {} }
    if (n === 'settings') return settingsStub
    if (n === 'llm')
      return {
        listConfigurableProviders: () => [{ provider: 'my-ollama', baseURL: 'http://127.0.0.1:11434/v1' }],
      }
    if (n === 'agents') return { list: () => [] }
    return undefined
  },
  systemPrompt: { assemble: async () => ({ sections: [], contexts: [], tools: [] }) },
  on: (ev, fn) => {
    handlers.set(ev, fn)
    return () => {}
  },
  effect: () => {},
  inject: () => {},
}
globalThis.fetch = async (url) => (String(url).includes('11434') ? jsonResponse({ object: 'list', data: [{ id: 'llama3.2:3b' }] }) : jsonResponse({}, 404))
apply(ctxStub, { enabled: true, routes: [], injectText: 'L', selfCheck: false, provision: true })
await new Promise((resolve) => setTimeout(resolve, 300))
check('已有可用本地 provider 时不写配置', updated === 0, `updated=${updated}`)

console.log(`\n${fail === 0 ? '=== 一步到位全部通过 ===' : `=== ${fail} 项失败 ===`}`)
process.exit(fail === 0 ? 0 : 1)
