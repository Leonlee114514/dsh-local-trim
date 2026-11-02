/**
 * test/panel.mjs — 控制面板的纯逻辑自检（不起浏览器、不连网络）。
 *
 * 覆盖两块：
 *   lib/status.js        状态视图（接管文案、裁剪收益、provider 表、点灯计数）
 *   lib/import-model.js  导入流程（入参校验、provider id 生成、profile 拼装、试跑请求）
 *
 * 用法：node test/panel.mjs
 */

import assert from 'node:assert/strict'

import {
  buildPanelStatus,
  formatCount,
  isLocalProvider,
  summarizeTakeover,
  summarizeTrim,
} from '../lib/status.js'

import {
  buildImportProfile,
  defaultProviderId,
  parseImportInput,
  pickModel,
  sanitizeProviderId,
  smokeTest,
  summarizeProvider,
} from '../lib/import-model.js'

let passed = 0
const ok = async (name, fn) => {
  await fn()
  passed += 1
  console.log('  ✓ ' + name)
}

// ── status.js ────────────────────────────────────────────────────────────

console.log('status: 裁剪收益')

await ok('没裁剪过时给一句人话', () => {
  const result = summarizeTrim(null)
  assert.equal(result.seen, false)
  assert.equal(result.savedPct, 0)
  assert.match(result.label, /还没有裁剪记录/)
})

await ok('43,247 → 12,900 显示省 70.2%', () => {
  const result = summarizeTrim({ charsIn: 43247, charsOut: 12900, sectionsIn: 37, sectionsOut: 2, at: 1793587180418 })
  assert.equal(result.seen, true)
  assert.equal(result.savedPct, 70.2)
  assert.match(result.label, /43,247 → 12,900/)
  assert.match(result.label, /70\.2%/)
  assert.equal(result.sectionsIn, 37)
  assert.equal(result.sectionsOut, 2)
})

await ok('进=出 时说明未裁剪', () => {
  const result = summarizeTrim({ charsIn: 26428, charsOut: 26428 })
  assert.equal(result.savedPct, 0)
  assert.match(result.label, /未裁剪/)
})

await ok('charsIn = 0 不除零', () => {
  const result = summarizeTrim({ charsIn: 0, charsOut: 0 })
  assert.equal(result.savedPct, 0)
  assert.equal(Number.isFinite(result.savedPct), true)
})

console.log('status: 接管文案')

await ok('accessor+purge-slot 是好的，且点名 dsh-purge', () => {
  const result = summarizeTakeover({ ok: true, via: 'accessor+purge-slot' }, { enabled: true })
  assert.equal(result.active, true)
  assert.equal(result.tone, 'good')
  assert.match(result.label, /dsh-purge/)
})

await ok('accessor-native 也认', () => {
  const result = summarizeTakeover({ ok: true, via: 'accessor-native' }, { enabled: true })
  assert.equal(result.tone, 'good')
  assert.match(result.label, /原生/)
})

await ok('没接管时把原因带出来', () => {
  const result = summarizeTakeover({ ok: false, via: 'none', reason: 'ctx.systemPrompt 为空' }, { enabled: true })
  assert.equal(result.active, false)
  assert.equal(result.tone, 'bad')
  assert.match(result.label, /ctx\.systemPrompt 为空/)
})

await ok('enabled=false 时不报警，只显示已关闭', () => {
  const result = summarizeTakeover({ ok: false, via: 'none', reason: '' }, { enabled: false })
  assert.equal(result.tone, 'muted')
  assert.match(result.label, /已关闭/)
})

console.log('status: provider 判定与计数')

await ok('回环/私有网段算本地', () => {
  assert.equal(isLocalProvider('x', 'http://127.0.0.1:11434/v1'), true)
  assert.equal(isLocalProvider('x', 'http://192.168.1.9:8090/v1'), true)
  assert.equal(isLocalProvider('x', 'http://host.docker.internal:8000/v1'), true)
})

await ok('名字带本地标记也算本地', () => {
  assert.equal(isLocalProvider('ollama-qwen', ''), true)
  assert.equal(isLocalProvider('my-lmstudio', ''), true)
  assert.equal(isLocalProvider('local-vllm-a', ''), true)
})

await ok('云端 provider 不算本地', () => {
  assert.equal(isLocalProvider('deepseek-eo', 'https://api.deepseek.com/v1'), false)
  assert.equal(isLocalProvider('anthropic', 'https://api.anthropic.com'), false)
})

await ok('千分位格式化', () => {
  assert.equal(formatCount(43247), '43,247')
  assert.equal(formatCount(undefined), '—')
})

await ok('面板主视图把三件事拼齐', () => {
  const status = buildPanelStatus({
    takeover: { ok: true, via: 'accessor+purge-slot' },
    values: { enabled: true, promptTrim: true, schemaTrim: false, debugWrap: false },
    trim: { charsIn: 1000, charsOut: 250, sectionsIn: 9, sectionsOut: 2, at: 1 },
    lightBody: { chars: 190, source: 'builtin' },
    provision: { status: 'registered', provider: 'local-llamacpp-qwen', detail: '已注册' },
    providers: [
      { id: 'local-llamacpp-qwen', profile: { displayName: 'Qwen 本地', baseURL: 'http://127.0.0.1:8090/v1', models: [{ id: 'qwen3-4b', contextWindow: 32768, maxTokens: 4096 }] } },
      { id: 'deepseek-eo', profile: { displayName: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-chat' }] } },
    ],
    online: { 'local-llamacpp-qwen': { ok: true, ms: 12 }, 'deepseek-eo': { ok: true, ms: 90 } },
    revision: 7,
    writable: true,
    logPath: '/tmp/x.log',
  })
  assert.equal(status.takeover.tone, 'good')
  assert.equal(status.trim.savedPct, 75)
  assert.equal(status.inject.chars, 190)
  assert.equal(status.flags.schemaTrim, false)
  assert.equal(status.counts.total, 2)
  assert.equal(status.counts.local, 1)
  assert.equal(status.counts.online, 1)
  assert.equal(status.providers[0].state.tone, 'good')
  assert.match(status.providers[0].state.label, /12ms/)
  assert.equal(status.revision, 7)
})

await ok('点灯缺失时标「未检测」而不是连不上', () => {
  const status = buildPanelStatus({
    providers: [{ id: 'local-x', profile: { baseURL: 'http://127.0.0.1:8000/v1', models: [] } }],
    online: {},
  })
  assert.equal(status.providers[0].state.tone, 'muted')
  assert.match(status.providers[0].state.label, /未检测/)
})

await ok('连不上时把错误带出来', () => {
  const status = buildPanelStatus({
    providers: [{ id: 'local-x', profile: { baseURL: 'http://127.0.0.1:8000/v1', models: [] } }],
    online: { 'local-x': { ok: false, error: 'ECONNREFUSED' } },
  })
  assert.equal(status.providers[0].state.tone, 'bad')
  assert.match(status.providers[0].state.label, /ECONNREFUSED/)
})

// ── import-model.js ──────────────────────────────────────────────────────

console.log('import: 入参校验')

await ok('空端点直接拒绝', () => {
  const result = parseImportInput({ model: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /端点不能为空/)
})

await ok('非 URL 拒绝', () => {
  const result = parseImportInput({ endpoint: 'not a url', model: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /不是合法 URL/)
})

await ok('非 http(s) 拒绝', () => {
  const result = parseImportInput({ endpoint: 'ftp://127.0.0.1:8090', model: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /必须是 http/)
})

await ok('没选模型拒绝', () => {
  const result = parseImportInput({ endpoint: 'http://127.0.0.1:8090' })
  assert.equal(result.ok, false)
  assert.match(result.error, /先探测端点/)
})

await ok('省略 /v1 会自动补上', () => {
  const result = parseImportInput({ endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b' })
  assert.equal(result.ok, true)
  assert.equal(result.endpoint, 'http://127.0.0.1:8090/v1')
})

await ok('provider id 非法时给出明确原因', () => {
  const result = parseImportInput({ endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b', provider: 'Bad ID' })
  assert.equal(result.ok, false)
  assert.match(result.error, /a-z 0-9/)
})

await ok('显式 provider id 被接受', () => {
  const result = parseImportInput({ endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b', provider: 'my-local.qwen' })
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'my-local.qwen')
})

await ok('按端口猜后端名', () => {
  assert.equal(defaultProviderId('http://127.0.0.1:8090/v1', 'Qwen3 4B'), 'local-llamacpp-qwen3-4b')
  assert.equal(defaultProviderId('http://127.0.0.1:11434/v1', 'qwen2.5:7b'), 'local-ollama-qwen2-5-7b')
  assert.equal(defaultProviderId('http://127.0.0.1:8000/v1', 'meta-llama/Llama-3-8B'), 'local-vllm-meta-llama-llama-3-8b')
  assert.equal(defaultProviderId('http://127.0.0.1:1234/v1', 'gemma-3-4b'), 'local-lmstudio-gemma-3-4b')
})

await ok('sanitizeProviderId 只收规整后合法的 id', () => {
  assert.equal(sanitizeProviderId('  My-Local  '), 'my-local')
  assert.equal(sanitizeProviderId('my-local.qwen'), 'my-local.qwen')
  assert.equal(sanitizeProviderId('Bad ID'), undefined)
  assert.equal(sanitizeProviderId('!!!'), undefined)
  assert.equal(sanitizeProviderId('a'.repeat(80)), undefined)
  assert.equal(sanitizeProviderId('a'.repeat(63)), 'a'.repeat(63))
})

console.log('import: 挑模型与拼 profile')

await ok('挑模型：精确优先，其次大小写不敏感', () => {
  const models = [{ id: 'Qwen3-4B' }, { id: 'qwen3-4b-instruct' }]
  assert.equal(pickModel(models, 'Qwen3-4B').id, 'Qwen3-4B')
  assert.equal(pickModel(models, 'qwen3-4b').id, 'Qwen3-4B')
  assert.equal(pickModel(models, 'nope'), undefined)
  assert.equal(pickModel([], 'x'), undefined)
})

await ok('默认关掉思考模式（本地小模型最常踩的坑）', () => {
  const parsed = parseImportInput({ endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b' })
  const profile = buildImportProfile(parsed, { contextWindow: 32768, maxTokens: 4096 })
  assert.equal(profile.baseURL, 'http://127.0.0.1:8090/v1')
  assert.equal(profile.models[0].id, 'qwen3-4b')
  assert.equal(profile.models[0].contextWindow, 32768)
  assert.equal(profile.models[0].maxTokens, 4096)
  assert.deepEqual(profile.compat.chatTemplateKwargs, { enable_thinking: false })
  // thinkingFormat 必须一起写，否则宿主的 openai 分支不会把 kwarg 发出去
  assert.equal(profile.compat.thinkingFormat, 'chat-template')
  // reasoningEfforts 把 reasoning 顶到 true，chatTemplateKwargs 才进请求体
  assert.equal(profile.models[0].reasoningEfforts.off, null)
})

await ok('thinking=true 时不写 compat', () => {
  const parsed = parseImportInput({ endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b', thinking: true })
  const profile = buildImportProfile(parsed, {})
  const text = JSON.stringify(profile)
  assert.equal(text.includes('chatTemplateKwargs'), false)
})

await ok('summarizeProvider 给面板一行摘要', () => {
  const summary = summarizeProvider('local-x', {
    displayName: '本地',
    baseURL: 'http://127.0.0.1:8090/v1',
    models: [{ id: 'a', contextWindow: 32768, maxTokens: 4096 }],
  })
  assert.equal(summary.id, 'local-x')
  assert.equal(summary.modelCount, 1)
  assert.equal(summary.contextWindow, 32768)
})

console.log('import: 试跑请求')

await ok('成功时回报耗时与 token 数', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '好' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 1 },
        }),
    }
  }
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'qwen3-4b' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '好')
  assert.equal(result.completionTokens, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:8090/v1/chat/completions')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.stream, false)
  assert.equal(body.model, 'qwen3-4b')
  assert.equal(calls[0].init.headers.authorization, undefined)
})

await ok('有 key 时带上 Bearer', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = init.headers
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }
  }
  await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'm', apiKey: 'secret' })
  assert.equal(seen.authorization, 'Bearer secret')
})

await ok('HTTP 错误把后端原文带出来', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'model not found' })
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'nope' })
  assert.equal(result.ok, false)
  assert.equal(result.status, 404)
  assert.match(result.error, /HTTP 404: model not found/)
})

await ok('不是 JSON 时说明白', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html>502</html>' })
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'm' })
  assert.equal(result.ok, false)
  assert.match(result.error, /不是 JSON/)
})

await ok('连不上时给异常文本', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED')
  }
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'm' })
  assert.equal(result.ok, false)
  assert.match(result.error, /ECONNREFUSED/)
})

await ok('缺 baseURL / 模型时提前返回', async () => {
  assert.equal((await smokeTest({ fetchImpl: async () => {}, baseURL: '', model: 'm' })).ok, false)
  assert.equal((await smokeTest({ fetchImpl: async () => {}, baseURL: 'http://127.0.0.1:8090', model: '' })).ok, false)
})

console.log('\n' + passed + ' 项通过')
