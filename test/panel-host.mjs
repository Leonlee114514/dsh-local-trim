/**
 * test/panel-host.mjs — 面板路由的宿主侧集成测试。
 *
 * 不是纯函数测试：这里真的跑 `apply(ctx)`，让插件自己把 8 条 bridge 路由注册到
 * 一个假的 webServer 上，然后拿假 req/res 直接打 status / check / import / test。
 * 外部依赖全部假掉：
 *   - settings：内存里的一张 provider 表
 *   - llm：给自动识别用的 provider 目录
 *   - fetch：一个假 llama.cpp（/v1/models + /v1/chat/completions）
 *
 * 用法：node test/panel-host.mjs
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_LOCAL_TRIM_LOG = join(tmpdir(), 'dsh-local-trim.panel-host.log')

const { apply } = await import('../lib/index.js')

let fail = 0
const check = (label, ok, extra = '') => {
  if (!ok) fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

// ── 假后端 ──────────────────────────────────────────────────────────────

const MODELS = { object: 'list', data: [{ id: 'qwen3-4b', meta: { n_ctx: 32768, n_predict: 4096 } }] }
const CHAT = {
  choices: [{ message: { content: '好' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1 },
}
const fetchLog = []
const LIVE_PORTS = new Set(['8090', '11434'])
const fakeFetch = async (url, init) => {
  const target = String(url)
  fetchLog.push({ url: target, method: init?.method ?? 'GET' })
  // 只让「真起了服务」的两个端口应答，其余端口模拟 ECONNREFUSED，
  // 这样「连不上」那条分支才有东西可测。
  let port = ''
  try {
    port = new URL(target).port
  } catch {
    port = ''
  }
  if (!LIVE_PORTS.has(port)) {
    const error = new TypeError('fetch failed')
    error.cause = Object.assign(new Error('connect ECONNREFUSED ' + target), { code: 'ECONNREFUSED' })
    throw error
  }
  if (target.endsWith('/v1/models')) {
    return { ok: true, status: 200, text: async () => JSON.stringify(MODELS) }
  }
  if (target.endsWith('/v1/chat/completions')) {
    return { ok: true, status: 200, text: async () => JSON.stringify(CHAT) }
  }
  return { ok: false, status: 404, text: async () => 'not found' }
}
globalThis.fetch = fakeFetch

// ── 假 settings / webServer / ctx ───────────────────────────────────────

const settingsState = {
  // cordis.patch.yml 里插件条目 id 是 local-tool-trim（settingsNamespace 取 ctx.fiber.entry.options.id）
  'local-tool-trim': { revision: 3, value: { enabled: true, promptTrim: true, schemaTrim: true } },
  'llm-pi-ai': {
    revision: 5,
    value: {
      providers: {
        'local-ollama-qwen3': {
          displayName: 'Qwen3 4B 本地',
          baseURL: 'http://127.0.0.1:11434/v1',
          models: [{ id: 'qwen3:4b', contextWindow: 32768, maxTokens: 4096 }],
        },
        'deepseek-eo': {
          displayName: 'DeepSeek',
          baseURL: 'https://api.deepseek.com/v1',
          models: [{ id: 'deepseek-chat' }],
        },
      },
    },
  },
}
let updates = []

const settingsStub = {
  describe: () => Object.entries(settingsState).map(([ns, row]) => ({ ns, ...row })),
  update: async (ns, patch, revision) => {
    updates.push({ ns, patch, revision })
    const row = settingsState[ns] ?? { revision: 0, value: {} }
    settingsState[ns] = { revision: row.revision + 1, value: { ...row.value, ...patch } }
  },
}

const routes = new Map()
const webServerStub = {
  register: (route) => {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}

const ctxStub = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  // index.js 的 bridge 挂载走 ctx.inject(['webServer'], sctx => ... sctx.webServer.register)，
  // 所以这里既要有 get('webServer')，也要有直接的 webServer 属性。
  webServer: webServerStub,
  get: (name) => {
    if (name === 'tools') return { schemas: () => [], restrict: () => () => {} }
    if (name === 'settings') return settingsStub
    if (name === 'webServer') return webServerStub
    if (name === 'llm') {
      return {
        listConfigurableProviders: () => [
          { provider: 'local-ollama-qwen3', baseURL: 'http://127.0.0.1:11434/v1' },
          { provider: 'deepseek-eo', baseURL: 'https://api.deepseek.com/v1' },
        ],
      }
    }
    if (name === 'agents') return { list: () => [] }
    return undefined
  },
  systemPrompt: { assemble: async () => ({ sections: [], contexts: [], tools: [] }) },
  on: () => () => {},
  effect: (fn) => fn(),
  inject: (deps, fn) => {
    // index.js 只在 webServer 可用时挂 bridge；这里直接同步执行。
    if (deps.includes('webServer')) fn(ctxStub)
  },
}

apply(ctxStub, { enabled: true, routes: [], injectText: 'L', selfCheck: false, provision: false })
await new Promise((resolve) => setTimeout(resolve, 200))

// ── 假 req/res：直接调 handler ──────────────────────────────────────────

const callRoute = async (name, body) => {
  const route = routes.get('/api/dsh-local-trim/' + name)
  if (route === undefined) throw new Error('route not registered: ' + name)
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8')
  const req = {
    method: 'POST',
    headers: { host: '127.0.0.1:56670', origin: 'http://127.0.0.1:56670', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on: (event, cb) => {
      if (event === 'data') cb(payload)
      if (event === 'end') cb()
      return req
    },
    destroy: () => {},
  }
  let status
  let text = ''
  const res = {
    writeHead: (code) => {
      status = code
    },
    end: (chunk) => {
      text = String(chunk ?? '')
    },
  }
  await route.handler(req, res)
  return { status, body: text.length > 0 ? JSON.parse(text) : undefined }
}

console.log('\n=== 1. 八条路由都注册上了 ===')
for (const name of ['describe', 'save', 'probe', 'log', 'status', 'check', 'import', 'test']) {
  check(name, routes.has('/api/dsh-local-trim/' + name))
}

console.log('\n=== 2. 跨站请求被拒 ===')
{
  const route = routes.get('/api/dsh-local-trim/status')
  let status
  await route.handler(
    {
      method: 'POST',
      headers: { host: '127.0.0.1:56670', 'sec-fetch-site': 'cross-site' },
      socket: { remoteAddress: '127.0.0.1' },
      on: () => {},
      destroy: () => {},
    },
    { writeHead: (code) => (status = code), end: () => {} },
  )
  check('sec-fetch-site: cross-site → 403', status === 403, `status=${status}`)
}

console.log('\n=== 3. status：接管状态 + 收益 + provider 表 ===')
{
  const { status, body } = await callRoute('status', {})
  check('200 + ok', status === 200 && body.ok === true)
  const view = body.status
  check('接管状态有文案', typeof view.takeover?.label === 'string' && view.takeover.label.length > 0, view.takeover?.label)
  check('收益条能算出形状', view.trim?.seen === false || typeof view.trim?.label === 'string')
  check('provider 总数 2', view.counts.total === 2, `total=${view.counts.total}`)
  check('本地 provider 识别出 1 个', view.counts.local === 1, `local=${view.counts.local}`)
  check('本地 provider 点灯成功', view.providers.find((r) => r.local)?.state.tone === 'good', JSON.stringify(view.providers.find((r) => r.local)?.state))
  check('云端 provider 不打灯', view.providers.find((r) => !r.local)?.state.tone === 'muted')
  check('values 一起带回来给表单用', typeof body.values === 'object' && body.values !== null)
  check('revision 带回来', body.revision === 3, `revision=${body.revision}`)
}

console.log('\n=== 4. check：强制刷新点灯 ===')
{
  const before = fetchLog.length
  const { body } = await callRoute('check', { force: true })
  check('返回 online 表', typeof body.online === 'object', JSON.stringify(body.online))
  check('确实打了 /v1/models', fetchLog.length > before && fetchLog.at(-1).url.endsWith('/v1/models'))
}

console.log('\n=== 5. import：探测 → 写 settings → 试跑 ===')
{
  const before = updates.length
  const { body } = await callRoute('import', { endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b' })
  check('整体 ok', body.ok === true, JSON.stringify(body.error ?? ''))
  check('自动生成 provider id', body.provider === 'local-llamacpp-qwen3-4b', `provider=${body.provider}`)
  check('模型被选中', body.model === 'qwen3-4b')
  check('写进了 llm-pi-ai', updates.length === before + 1 && updates.at(-1).ns === 'llm-pi-ai', JSON.stringify(updates.at(-1)?.ns))
  const written = updates.at(-1).patch.providers['local-llamacpp-qwen3-4b']
  check('profile 带 baseURL', written.baseURL === 'http://127.0.0.1:8090/v1', written.baseURL)
  check('profile 默认关思考模式', written.compat?.chatTemplateKwargs?.enable_thinking === false)
  check('profile 带 thinkingFormat', written.compat?.thinkingFormat === 'chat-template')
  check('试跑通过并带回耗时', body.smoke?.ok === true && Number.isFinite(body.smoke.ms), `ms=${body.smoke?.ms}`)
  check('试跑回复内容带回来', body.smoke?.text === '好')
}

console.log('\n=== 6. import：同名 provider 不覆盖 ===')
{
  const before = updates.length
  const { body } = await callRoute('import', { endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b' })
  check('registered=false', body.registered === false, String(body.registered))
  check('给出不覆盖原因', /已存在/.test(body.reason ?? ''), body.reason ?? '')
  check('没有写 settings', updates.length === before)
  check('仍然试跑（配置能跑才重要）', body.smoke?.ok === true)
}

console.log('\n=== 7. import：端点连不上时给可读错误 ===')
{
  const { body } = await callRoute('import', { endpoint: 'http://127.0.0.1:9999', model: 'x' })
  check('ok=false', body.ok === false)
  check('错误里点名端点', /连不上/.test(body.error ?? ''), body.error ?? '')
  check('带回每次尝试', Array.isArray(body.attempts) && body.attempts.length > 0, `attempts=${body.attempts?.length}`)
}

console.log('\n=== 8. import：模型不在列表里 ===')
{
  const { body } = await callRoute('import', { endpoint: 'http://127.0.0.1:8090', model: 'not-there' })
  check('ok=false', body.ok === false)
  check('列出可用模型供选择', Array.isArray(body.models) && body.models.includes('qwen3-4b'), JSON.stringify(body.models))
}

console.log('\n=== 9. test：对已注册 provider 试跑 ===')
{
  const { body } = await callRoute('test', { provider: 'local-llamacpp-qwen3-4b' })
  check('ok=true', body.ok === true, JSON.stringify(body.error ?? ''))
  check('回带 provider / model', body.provider === 'local-llamacpp-qwen3-4b' && body.model === 'qwen3-4b')
  check('回带 smoke 明细', body.smoke?.ok === true && body.smoke?.text === '好')
}

console.log('\n=== 10. test：provider 不存在时说明白 ===')
{
  const { body } = await callRoute('test', { provider: 'nope' })
  check('ok=false', body.ok === false)
  check('错误里点名 provider', /没有 provider/.test(body.error ?? ''), body.error ?? '')
}

console.log(`\n${fail === 0 ? '=== 面板宿主侧集成全部通过 ===' : `=== ${fail} 项失败 ===`}`)
process.exit(fail === 0 ? 0 : 1)
