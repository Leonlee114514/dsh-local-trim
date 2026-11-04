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
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

process.env.DSH_LOCAL_TRIM_LOG = join(tmpdir(), 'dsh-local-trim.panel-host.log')

// ── Ollama 存储 fixture ────────────────────────────────────────────────
// 第 17b/17d 组要验证「adopt 一个 blob 路径 → 认出 tag → 走 11434」，而 lib/index.js
// 调 ollamaModelFor 时不带 io（读真实 fs）。所以这里在临时目录里现造一份真的
// ollama 存储（manifests 树 + blobs 里的 GGUF 头 + metadata kv），再把
// OLLAMA_MODELS 指过去 —— 结果只取决于这份 fixture，不取决于跑测试的机器
// 装没装 ollama，跨 CI 稳定。目录名带 ollama：walk 的下钻词才认它。
const OLLAMA_FIXTURE_ROOT = join(tmpdir(), 'ollama-fixture')
const OLLAMA_BLOB_HEX = 'f'.repeat(64)
const OLLAMA_BLOB_PATH = join(OLLAMA_FIXTURE_ROOT, 'blobs', 'sha256-' + OLLAMA_BLOB_HEX)
// manifests 的路径语义是 `<host>/<ns>/<name>/<tag>`：文件叫 4b，插件才还原成 qwen3:4b。
const OLLAMA_TAG_FILE = '4b'
const OLLAMA_TAG = 'qwen3:4b'
{
  const manifestDir = join(OLLAMA_FIXTURE_ROOT, 'manifests', 'registry.ollama.ai', 'library', 'qwen3')
  mkdirSync(manifestDir, { recursive: true })
  mkdirSync(join(OLLAMA_FIXTURE_ROOT, 'blobs'), { recursive: true })
  mkdirSync(join(OLLAMA_FIXTURE_ROOT, 'metadata'), { recursive: true })
  const digest = 'sha256:' + OLLAMA_BLOB_HEX
  writeFileSync(
    join(manifestDir, OLLAMA_TAG_FILE),
    JSON.stringify({
      schemaVersion: 2,
      layers: [
        { mediaType: 'application/vnd.ollama.image.model', digest, size: 4096 },
        { mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:' + 'b'.repeat(64), size: 1723 },
      ],
    }),
  )
  // blob 真文件：前 4 字节给魔数兜底用，后面全是零（这条路径不该被喂给 llama-server）。
  writeFileSync(OLLAMA_BLOB_PATH, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(4092)]))
  writeFileSync(
    join(OLLAMA_FIXTURE_ROOT, 'metadata', 'sha256-' + OLLAMA_BLOB_HEX + '.json'),
    JSON.stringify({
      kv: {
        'general.architecture': 'qwen3',
        'general.name': 'Qwen3 4B',
        'general.file_type': 15,
        'qwen3.context_length': 40960,
      },
    }),
  )
  process.env.OLLAMA_MODELS = OLLAMA_FIXTURE_ROOT.replaceAll('\\', '/')
}

const { apply } = await import('../lib/index.js')

let fail = 0
const check = (label, ok, extra = '') => {
  if (!ok) fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

// ── 假后端 ──────────────────────────────────────────────────────────────

const MODELS = { object: 'list', data: [{ id: 'qwen3-4b', meta: { n_ctx: 32768, n_predict: 4096 } }] }
// 11434 上的是 Ollama：它按 tag 报模型 id（带冒号），和 8090 上 llama-server 报的
// 文件名不一样。两个端口给不同的 id，`pickModel` 才真的是「精确命中 tag」，
// 而不是靠兜底取第一个混过去。
const OLLAMA_MODELS = { object: 'list', data: [{ id: OLLAMA_TAG, meta: { name: OLLAMA_TAG } }] }
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
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(port === '11434' ? OLLAMA_MODELS : MODELS),
    }
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
const mutations = []

const settingsStub = {
  describe: () => Object.entries(settingsState).map(([ns, row]) => ({ ns, ...row })),
  update: async (ns, patch, revision) => {
    updates.push({ ns, patch, revision })
    const row = settingsState[ns] ?? { revision: 0, value: {} }
    settingsState[ns] = { revision: row.revision + 1, value: { ...row.value, ...patch } }
  },
  // 真删键只能走 mutate 的 unset —— update 走 mergeLayers，写 null 只会留下一个 null。
  // 这里照 dsh-settings 的语义实现：只在「用户层自己定义过」时真删，否则键留着。
  mutate: async (ns, ops, revision) => {
    mutations.push({ ns, ops, revision })
    const row = settingsState[ns] ?? { revision: 0, value: {} }
    let providers = { ...(row.value?.providers ?? {}) }
    for (const op of ops) {
      if (op.op !== 'unset') continue
      const [head, id] = op.path ?? []
      if (head === 'providers' && providers[id] !== undefined) {
        const next = { ...providers }
        delete next[id]
        providers = next
      }
    }
    settingsState[ns] = { revision: row.revision + 1, value: { ...row.value, providers } }
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

apply(ctxStub, {
  enabled: true,
  routes: [],
  injectText: 'L',
  selfCheck: false,
  provision: false,
  // 用例是在几毫秒内连着打同一批重活路由的，默认 800ms 间隔会把它们全挡掉。
  // 节流本身另有用例（最后那组）单独验。
  bridgeThrottleMs: 0,
})
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

console.log('\n=== 1. 十三条路由都注册上了 ===')
for (const name of ['describe', 'save', 'probe', 'log', 'status', 'check', 'import', 'test', 'launch', 'stop', 'models', 'adopt', 'delete']) {
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

console.log('\n=== 11. launch：端口已经在应答就不重复拉起 ===')
{
  // 8090 在假 fetch 的白名单里，所以这里只验证「先探测再决定」这条早退分支，
  // 不会在这台机器上真的 spawn 一个后端。
  const { status, body } = await callRoute('launch', { baseURL: 'http://127.0.0.1:8090/v1' })
  check('200 + ok', status === 200 && body.ok === true, JSON.stringify(body.error ?? ''))
  check('already=true', body.already === true, String(body.already))
  check('端口从 baseURL 解析出来', body.port === 8090, String(body.port))
  check('带上现有模型列表', Array.isArray(body.models) && body.models.length > 0)
  check('说明没有重复拉起', /本来就在应答/.test(body.message ?? ''), body.message ?? '')
}

console.log('\n=== 12. launch：不认识的后端给可执行的下一步 ===')
{
  const { body } = await callRoute('launch', { baseURL: 'http://127.0.0.1:9999/v1' })
  check('ok=false', body.ok === false)
  check('点名端口', /9999/.test(body.error ?? ''), body.error ?? '')
  check('指向高级配置里的启动命令', /启动命令/.test(body.error ?? ''), body.error ?? '')
}

console.log('\n=== 13. models：列出本机已下好的 gguf ===')
{
  const { status, body } = await callRoute('models', {})
  check('200 + ok', status === 200 && body.ok === true, JSON.stringify(body.error ?? ''))
  check('带 models 数组', Array.isArray(body.models))
  check('带搜过的目录清单', Array.isArray(body.dirs) && body.dirs.length > 0, String((body.dirs ?? []).length))
  check(
    '每条都有 path / name / sizeBytes',
    (body.models ?? []).every((item) => typeof item.path === 'string' && typeof item.name === 'string'),
  )
  check('mmproj 被标出来（供前端过滤）', (body.models ?? []).every((item) => typeof item.mmproj === 'boolean'))
}

console.log('\n=== 14. adopt：没选模型文件时直接说清楚 ===')
{
  const { status, body } = await callRoute('adopt', {})
  check('200（业务失败不抛）', status === 200, String(status))
  check('ok=false', body.ok === false)
  check('要求先选 .gguf', /先选一个本机模型文件/.test(body.error ?? ''), body.error ?? '')
}

console.log('\n=== 15. adopt：既不是 .gguf 也不是 GGUF 文件头的，挡下 ===')
{
  // v0.4.5：校验不再看扩展名，改看文件头，所以一个真的 .bin 权重是能用的；
  // 这里用的是一个不存在的文件，两边都不中，必须被拒。
  const { body } = await callRoute('adopt', { modelPath: 'C:/tmp/model.bin' })
  check('ok=false', body.ok === false)
  check('说清两种判定都没过', /不是 GGUF/.test(body.error ?? ''), body.error ?? '')
  check('把路径带回报错', /model\.bin/.test(body.error ?? ''), body.error ?? '')
}

console.log('\n=== 16. adopt：mmap 装得下的 15.8GB 模型不再被误判 risky ===')
{
  // v0.4.1 纠正：gguf 走 mmap 落在可回收的 page cache，显存外的部分才是宿主接的量。
  // 体积显式传入，不依赖这台机器上真的有没有那个文件 —— 判定逻辑要跨平台可复现。
  const { status, body } = await callRoute('adopt', {
    modelPath: 'C:/models/local_model.gguf',
    port: 8090,
    sizeBytes: 16954484384,
    // CI 的 runner 上没有 nvidia-smi、内存也只有 15.6GB，显存和内存也显式给，
    // 否则 gpuBytes=0 → 16.9GB 全压到 15.6GB 内存上，又变回 risky。
    gpuBytes: 14848 * 1024 * 1024,
    totalMemBytes: 16762 * 1024 * 1024,
  })
  check('200（业务失败不抛）', status === 200, String(status))
  check('带上体积', body.sizeBytes === 16954484384, String(body.sizeBytes))
  check('带回显存外的字节数', typeof body.fit?.hostBytes === 'number', String(body.fit?.hostBytes))
  check('没被误判成 risky', body.fit?.level !== 'risky', String(body.fit?.level))
  check('不再塞 noMmap 字段', body.noMmap === undefined, String(body.noMmap))
}

console.log('\n=== 16a. adopt：文件不存在时退化 unknown，不抛异常 ===')
{
  const { status, body } = await callRoute('adopt', {
    modelPath: 'C:/models/not-there.gguf',
    port: 8090,
  })
  check('200（业务失败不抛）', status === 200, String(status))
  check('体积读到 0', body.sizeBytes === 0, String(body.sizeBytes))
  check('fit 是 unknown', body.fit?.level === 'unknown', String(body.fit?.level))
}

console.log('\n=== 16b. adopt：真装不下时才拦，要求确认，且不改 --load-mode ===')
{
  // 塞一个 40GB 的体积（这台机器 16.37GB 内存 + 14.5GB 显存也接不住）
  const { status, body } = await callRoute('adopt', {
    modelPath: 'C:/models/local_model.gguf',
    port: 8090,
    sizeBytes: 40 * 1024 * 1024 * 1024,
  })
  check('200（业务失败不抛）', status === 200, String(status))
  check('ok=false', body.ok === false)
  check('阶段是 precheck', body.stage === 'precheck', String(body.stage))
  check('要求显式确认', body.needsConfirm === true)
  check('fit 是 risky', body.fit?.level === 'risky', String(body.fit?.level))
  check('错误里说清装不下', /装不下|拖死|换页/.test(body.error ?? ''), body.error ?? '')
  check('不再自动加 --no-mmap', body.noMmap === undefined, String(body.noMmap))
  check('loadMode 保持空（交给引擎 auto）', body.loadMode === '', JSON.stringify(body.loadMode))
}

console.log('\n=== 17. adopt：确认后继续，端口已经在跑就跳过拉起 ===')
{
  // 8090 在假 fetch 白名单里 → launchPanel 走「本来就在应答」早退，
  // 于是这条用例覆盖的是 adopt 的后半段：探到真实模型 id → 写 provider → 试跑。
  const { status, body } = await callRoute('adopt', {
    modelPath: 'C:/models/local_model.gguf',
    port: 8090,
    contextWindow: 65536,
    overwrite: true,
    confirmHeavy: true,
    sizeBytes: 16954484384,
  })
  check('200 + ok', status === 200 && body.ok === true, JSON.stringify(body.error ?? '') + ' stage=' + (body.stage ?? ''))
  check('阶段是 ready', body.stage === 'ready', String(body.stage))
  check('复用已有服务，没重复拉起', body.launch?.already === true, String(body.launch?.already))
  check('模型 id 取自 /v1/models', typeof body.model === 'string' && body.model.length > 0, String(body.model))
  check('provider 注册上了', body.registered === true, String(body.registered))
  check('试跑成功', body.smoke?.ok === true, JSON.stringify(body.smoke?.error ?? ''))
  check('带回预检结论给前端展示', typeof body.fit?.label === 'string', String(body.fit?.level))
}

console.log('\n=== 17b. adopt：Ollama 的 blob 走 11434，不再起一份 llama-server ===')
{
  // 这条覆盖 v0.4.5 的主线：blob 没有 .gguf 后缀，但它在 ollama manifest 里有名字。
  const { status, body } = await callRoute('adopt', {
    modelPath: OLLAMA_BLOB_PATH,
    port: 11434,
    contextWindow: 32768,
    overwrite: true,
  })
  check('200 + ok', status === 200 && body.ok === true, JSON.stringify(body.error ?? '') + ' stage=' + (body.stage ?? ''))
  check('端口跟着 Ollama 走', body.port === 11434, String(body.port))
  check('复用了已在应答的 11434，没另起进程', body.launch?.already === true, String(body.launch?.already))
  check('模型 id 用的是 tag，不是 sha256 文件名', body.model === OLLAMA_TAG, String(body.model))
  check('注册成 ollama 后端', /ollama/.test(String(body.provider)), String(body.provider))
  check('试跑了', body.smoke?.ok === true, JSON.stringify(body.smoke ?? {}))
}

console.log('\n=== 17c. adopt：三种判据都不中时才挡，并把路径带回 ===')
{
  const { body } = await callRoute('adopt', { modelPath: join(tmpdir(), 'definitely-not-a-model.bin') })
  check('ok=false', body.ok === false)
  check('说清扩展名/清单/文件头都不中', /不是 GGUF/.test(body.error ?? '') && /Ollama/.test(body.error ?? ''), body.error ?? '')
  check('把路径带回报错', /definitely-not-a-model\.bin/.test(body.error ?? ''), body.error ?? '')
}

console.log('\n=== 17d. models：清单里带出 Ollama 的可读名、量化与来源 ===')
{
  const { body } = await callRoute('models', {})
  const list = body.models ?? []
  const hit = list.find((item) => item.name === OLLAMA_TAG)
  check('扫到了 Ollama 的模型', hit !== undefined, list.map((item) => item.name).join(','))
  check('名字是 tag 而不是 sha256', hit !== undefined && !/^sha256-/.test(hit.name), String(hit?.name))
  check('带 tags 数组', Array.isArray(hit?.tags) && hit.tags.includes(OLLAMA_TAG), JSON.stringify(hit?.tags ?? []))
  check('带量化标签（file_type 15 → Q4_K_M）', hit?.quantization === 'Q4_K_M', String(hit?.quantization))
  check('带引擎与端口', hit?.engine === 'ollama' && hit?.port === 11434, String(hit?.engine) + ':' + String(hit?.port))
  check('带可读名', typeof hit?.readableName === 'string' && hit.readableName.length > 0, String(hit?.readableName))
  check('每条都有 source（前端靠它分辨来源）', list.every((item) => typeof item.source === 'string'))
  check('每条都带 fit', list.every((item) => typeof item.fit?.level === 'string'))
}

console.log('\n=== 18. stop：只停自己起过的，别人的一概不动 ===')
{
  // 面板从没在这台机器上 spawn 过东西（用例全是假 fetch），所以表是空的。
  const { status, body } = await callRoute('stop', { port: 11434 })
  check('200（业务失败不抛）', status === 200, String(status))
  check('ok=false', body.ok === false)
  check('说明这个端口不是自己起的', /没有本插件拉起的进程/.test(body.error ?? ''), body.error ?? '')
  check('带回自己起过哪些端口', Array.isArray(body.launched), JSON.stringify(body.launched))

  const missing = await callRoute('stop', {})
  check('没说端口就直说', missing.body.ok === false && /停哪个端口/.test(missing.body.error ?? ''), missing.body.error ?? '')
}

console.log('\n=== 19. models：扫描结果带每个模型的预检结论 ===')
{
  const { body } = await callRoute('models', {})
  const list = body.models ?? []
  check('每条都带 fit', list.every((item) => typeof item.fit?.level === 'string'), 'n=' + list.length)
  check(
    'fit 结论在四个合法值里',
    list.every((item) => ['ok', 'warn', 'risky', 'unknown'].includes(item.fit.level)),
    JSON.stringify(list.map((item) => item.fit?.level).slice(0, 5)),
  )
  check('带回 truncated 标记', typeof body.truncated === 'boolean', String(body.truncated))
  check('带回扫过的条目数', Number.isFinite(body.scannedEntries), String(body.scannedEntries))
}

console.log('\n=== 20. delete：删的是 provider 配置，不是磁盘上的 gguf ===')
{
  // 删前记下来，好确认「磁盘上的东西一个没少」—— 这里直接比 settings 之外的副作用：
  // delete 路由不该碰文件系统，所以只要它没调 unlink 就够了（launcher 侧已无该实现）。
  const before = Object.keys(settingsState['llm-pi-ai'].value.providers)

  // 越权/不存在 → 直说
  const missing = await callRoute('delete', {})
  check('200（业务失败不抛）', missing.status === 200, String(missing.status))
  check('不说删哪个就直说', missing.body.ok === false && /删哪个 provider/.test(missing.body.error ?? ''), missing.body.error ?? '')

  const ghost = await callRoute('delete', { provider: '__nope__' })
  check('本来就不在也回 ok（幂等）', ghost.body.ok === true, JSON.stringify(ghost.body))
  check('并说明本来就不在', ghost.body.already === true, String(ghost.body.already))

  // 前面的组已经把 provider 表改过几轮（import 会往里写），所以这里自己塞一条干净的靶子，
  // 不依赖前面留下的状态 —— 否则这个用例会随别的组顺序变化而红。
  const doomed = 'local-zombie-8091'
  settingsState['llm-pi-ai'].value.providers[doomed] = {
    displayName: '僵尸本地 provider',
    baseURL: 'http://127.0.0.1:8091/v1',
    models: [{ id: 'never-loaded' }],
  }
  check('删除前它还在', settingsState['llm-pi-ai'].value.providers[doomed] !== undefined)
  const gone = await callRoute('delete', { provider: doomed })
  check('删除成功', gone.body.ok === true, JSON.stringify(gone.body))
  check('回来的是被删的那条', gone.body.provider === doomed, String(gone.body.provider))
  check('配置里真的没了', settingsState['llm-pi-ai'].value.providers[doomed] === undefined)
  check('别的 provider 一个没动', Object.keys(settingsState['llm-pi-ai'].value.providers).every((id) => before.includes(id)))
  check('文案说清磁盘文件没动', /磁盘上的 gguf 没动/.test(gone.body.message ?? ''), gone.body.message ?? '')

  // 走的是 mutate 的 unset，不是 update。update 走 mergeLayers，写个 null 只会留下一个
  // null 的 provider 键 —— loader 见到会当成配置错误，所以这条路必须没被走过。
  check('删除没走 update 写 null', updates.every((u) => u.patch?.providers?.[doomed] !== null), String(updates.length))
  check('确实调了 mutate', mutations.length > 0, String(mutations.length))
  check('unset 的 path 是 providers.<id>'
    , JSON.stringify(mutations.at(-1)?.ops ?? []) === JSON.stringify([{ op: 'unset', path: ['providers', doomed] }]),
    JSON.stringify(mutations.at(-1)?.ops ?? []))
}
console.log(`\n${fail === 0 ? '=== 面板宿主侧集成全部通过 ===' : `=== ${fail} 项失败 ===`}`)
process.exit(fail === 0 ? 0 : 1)
