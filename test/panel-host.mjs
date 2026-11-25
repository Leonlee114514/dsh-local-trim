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
// 8090 上「此刻加载着哪个模型」是可变的：真 llama-server 的 /v1/models 只报它自己
// 加载的那一个，而 adopt 现在会拿这个 id 跟文件名对账（对不上就报错，不再猜一个用）。
// 所以「8090 上跑着 local_model」这件事得能在用例里显式摆出来。
let modelsAt8090 = MODELS
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
      text: async () => JSON.stringify(port === '11434' ? OLLAMA_MODELS : modelsAt8090),
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
    // 照 dsh-settings 的 mergeLayers 写：plain object 递归合并，其它值（含数组）整体替换。
    // 用 `{...row.value, ...patch}` 平铺会把整个 providers 表换掉 —— 那样「对齐只动了一条
    // provider」这件事在测试里根本验不出来（别的 provider 全没了，存下来的引用也失效）。
    const merge = (under, over) => {
      const out = { ...under }
      for (const [key, value] of Object.entries(over ?? {})) {
        const plain = (node) => node !== null && typeof node === 'object' && !Array.isArray(node)
        out[key] = plain(value) && plain(under?.[key]) ? merge(under[key], value) : value
      }
      return out
    }
    settingsState[ns] = { revision: row.revision + 1, value: merge(row.value, patch) }
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
  // 节流与 FIFO 排队本身在 test/bridge.mjs 里单独验（那边直接造路由表，能控制并发）。
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

console.log('\n=== 1. 十五条路由都注册上了 ===')
for (const name of ['describe', 'save', 'probe', 'log', 'status', 'check', 'import', 'test', 'launch', 'stop', 'models', 'adopt', 'delete', 'align', 'reconcile']) {
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
  // 这份 ctxStub 没有 clientModules 服务，也没让 inject 回调跑 —— 正好是最坏情况。
  // 面板宿存只能报「未知」，不能崩、也不能假报「有宿主」。
  check('client 宿存一起带回来（stub 下是未知，不是缺字段）', typeof view.client?.state === 'string', `state=${view.client?.state}`)
  check('client 宿存未知时不说「不可用」', !/不可用/.test(view.client?.label ?? ''), view.client?.label)
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

console.log('\n=== 8b. import：同一后端复用已有 provider，不再长出第二条 ==="')
{
  // 同一个 Ollama 每导入一个模型就新建一条 `local-ollama-<模型名>`，是面板上半截
  // 越拉越长的根因。这里造一条通用条目 `local-ollama`，导入第二个模型时必须追加进去。
  const cur = () => settingsState['llm-pi-ai'].value.providers
  cur()['local-ollama'] = {
    displayName: 'Ollama',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: [{ id: 'gemma4:12b', contextWindow: 32768, maxTokens: 4096 }],
  }

  const before = updates.length
  const { body } = await callRoute('import', { endpoint: 'http://127.0.0.1:11434', model: 'qwen3:4b' })
  check('导入成功', body.ok === true, JSON.stringify(body.error ?? ''))
  check('复用了 local-ollama', body.provider === 'local-ollama', `provider=${body.provider}`)
  check('回报说清了是复用', body.reused === 'local-ollama', JSON.stringify(body.reused))
  check('追加的是这个模型', body.appended === 'qwen3:4b', JSON.stringify(body.appended))
  check('只写了一次 settings', updates.length === before + 1, `${before} → ${updates.length}`)

  const row = cur()['local-ollama']
  check('老模型还在', row.models.some((m) => m.id === 'gemma4:12b'), JSON.stringify(row.models.map((m) => m.id)))
  check('新模型接在后面', row.models.some((m) => m.id === 'qwen3:4b'), JSON.stringify(row.models.map((m) => m.id)))
  check('老模型条目没被改写', JSON.stringify(row.models.find((m) => m.id === 'gemma4:12b')) === JSON.stringify({ id: 'gemma4:12b', contextWindow: 32768, maxTokens: 4096 }), JSON.stringify(row.models.find((m) => m.id === 'gemma4:12b')))
  check('displayName 没被覆盖', row.displayName === 'Ollama', String(row.displayName))
  check('没有多长出一条 local-ollama-qwen3-4b', cur()['local-ollama-qwen3-4b'] === undefined, JSON.stringify(Object.keys(cur())))

  // 再导入同一个模型：不重复加，也不当成失败 —— 用户想要的结果已经在了。
  const dedupe = await callRoute('import', { endpoint: 'http://127.0.0.1:11434', model: 'qwen3:4b' })
  check('重复导入不报错', dedupe.body.ok === true, JSON.stringify(dedupe.body.error ?? ''))
  check('重复导入不重复加', cur()['local-ollama'].models.filter((m) => m.id === 'qwen3:4b').length === 1, JSON.stringify(cur()['local-ollama'].models.map((m) => m.id)))
  check('重复导入标 alreadyThere', dedupe.body.alreadyThere === true, JSON.stringify(dedupe.body.alreadyThere))

  // 用户显式点了 provider id 就是他有意指定，不许被「复用」改写。
  const explicit = await callRoute('import', { endpoint: 'http://127.0.0.1:11434', model: 'qwen3:4b', provider: 'my-own-ollama' })
  check('显式 provider 不被复用改写', explicit.body.provider === 'my-own-ollama', `provider=${explicit.body.provider}`)
  check('显式 provider 建出独立条目', cur()['my-own-ollama'] !== undefined, JSON.stringify(Object.keys(cur())))

  delete cur()['local-ollama']
  delete cur()['my-own-ollama']
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
  // 8090 上摆出「已经加载着 local_model」：adopt 现在会拿 /v1/models 报的 id 跟文件名
  // 对账，对不上就报错（不再兜底猜一个）。这里要测的是预检，所以先让它对得上。
  modelsAt8090 = { object: 'list', data: [{ id: 'local_model', meta: { n_ctx: 32768 } }] }
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

console.log('\n=== 17e. models：普通 .gguf 也带出 GGUF 里的真名（v0.4.6）===')
{
  // workbuddy 把任何权重都改名成 local_model.gguf，真名只在 GGUF 的 KV 里。
  // 面板只管透传：真名从哪来（普通 gguf 读 KV / ollama 读 metadata）是 launcher 单测的事。
  const { body } = await callRoute('models', {})
  const list = body.models ?? []
  check('readableName 一律是非空字符串（前端直接当显示名用）',
    list.every((item) => typeof item.readableName === 'string' && item.readableName.length > 0),
    JSON.stringify(list.map((item) => item.readableName)))
  check('fullName/sizeLabel 有类型才带（没有就不塞 undefined）',
    list.every((item) => item.fullName === undefined || typeof item.fullName === 'string') &&
      list.every((item) => item.sizeLabel === undefined || typeof item.sizeLabel === 'string'))
  check('ollama 那条的 readableName 是 tag（tag 优先于元数据名）',
    (list.find((item) => item.name === OLLAMA_TAG) ?? {}).readableName === OLLAMA_TAG,
    String((list.find((item) => item.name === OLLAMA_TAG) ?? {}).readableName))
  check('带回 metaReads（读了几个文件的元数据）', Number.isFinite(body.metaReads), String(body.metaReads))
}

console.log('\n=== 17f. adopt：普通 .gguf 撞上 11434 时，不能借 Ollama 的端口把自己注册成别的模型 ===')
{
  // 现场：面板选过 ollama 的模型后端口被粘在 11434，接着选一个普通 .gguf（workbuddy 的
  // local_model.gguf），点「一键配置并试跑」。旧行为：端口沿用 11434 → 探到 Ollama 在应答 →
  // wanted 'local_model' 在 /v1/models 里对不上 → 兜底抓列表第一个（embedding 模型常排第一）
  // → 装出一个指向别的模型的 ollama provider。模型的归属由文件决定，不由上一次点的东西决定。
  const { status, body } = await callRoute('adopt', {
    modelPath: 'C:/models/local_model.gguf',
    port: 11434,
    contextWindow: 65536,
    overwrite: true,
    confirmHeavy: true,
    sizeBytes: 16954484384,
  })
  check('200 + ok', status === 200 && body.ok === true, JSON.stringify(body.error ?? '') + ' stage=' + (body.stage ?? ''))
  check('端口改回 llama.cpp 那条，不借 Ollama 的 11434', body.port === 8090, String(body.port))
  check('注册成 llama.cpp 后端，不是 ollama', /llamacpp/.test(String(body.provider)), String(body.provider))
  check('模型 id 不是 Ollama 清单里的第一个', body.model !== OLLAMA_TAG, String(body.model))
  check('把改端口这件事说出来', body.portRedirected === true || /11434/.test(String(body.portNote ?? '')), JSON.stringify({ portRedirected: body.portRedirected, portNote: body.portNote }))
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
console.log('\n=== 21. align：把 models 对齐到后端真的有的那份 ===')
{
  // mergeLayers 每一层都造新对象，所以这里不能存一次引用就用到底 —— 每次现取。
  const cur = () => settingsState['llm-pi-ai'].value.providers
  // 一条「声明 3 个、后端只有 1 个」的靶子（第 1 个活着，后 2 个是 ollama rm 留下的死声明）。
  // contextWindow 故意写成 12345，用来验证「活着的条目原样保留，不拿探测值覆盖用户调参」。
  // 注意这条靶子指向 11434（Ollama）而不是 8090（llama.cpp）：
  // 只有「一次报全部模型」的后端才允许按后端清单摘除，见下面第 21b 组。
  const zombie = 'local-align-target'
  cur()[zombie] = {
    displayName: '本地对齐靶子',
    baseURL: 'http://127.0.0.1:11434/v1',
    defaultMaxTokens: 2048,
    compat: { thinkingFormat: 'chat-template' },
    models: [
      { id: OLLAMA_TAG, contextWindow: 12345, maxTokens: 777, reasoningEfforts: { off: null, low: 'low' } },
      { id: 'deleted-a', contextWindow: 32768 },
      { id: 'deleted-b', contextWindow: 32768 },
    ],
  }

  const noName = await callRoute('align', {})
  check('不说对齐哪个就直说', noName.body.ok === false && /对齐哪个 provider/.test(noName.body.error ?? ''), noName.body.error ?? '')

  const ghost = await callRoute('align', { provider: '__nope__' })
  check('不存在的 provider 明确报错', ghost.body.ok === false && /没有 provider/.test(ghost.body.error ?? ''), ghost.body.error ?? '')

  // 连不上的端口 → 不许动配置。探测失败跟「后端一个模型都没有」是两回事，
  // 混在一起会把整条 provider 的模型清空（数据丢失），这是必须钉住的一条。
  const dead = 'local-align-dead'
  cur()[dead] = {
    baseURL: 'http://127.0.0.1:9999/v1',
    models: [{ id: 'whatever', contextWindow: 4096 }],
  }
  const deadResult = await callRoute('align', { provider: dead })
  check('后端连不上就不动配置', deadResult.body.ok === false && /连不上/.test(deadResult.body.error ?? ''), deadResult.body.error ?? '')
  check('连不上时 models 一条没少', cur()[dead].models.length === 1, String(cur()[dead].models.length))
  check('连不上时文案说配置没动', /配置没动/.test(deadResult.body.error ?? ''), deadResult.body.error ?? '')

  const aligned = await callRoute('align', { provider: zombie })
  check('对齐成功', aligned.body.ok === true, JSON.stringify(aligned.body))
  check('报告摘掉了 2 条', Array.isArray(aligned.body.removed) && aligned.body.removed.length === 2, JSON.stringify(aligned.body.removed ?? []))
  check('摘掉的是那两条死声明', JSON.stringify(aligned.body.removed ?? []) === JSON.stringify(['deleted-a', 'deleted-b']), JSON.stringify(aligned.body.removed ?? []))
  check('活着的条目留在 kept 里', JSON.stringify(aligned.body.kept ?? []) === JSON.stringify([OLLAMA_TAG]), JSON.stringify(aligned.body.kept ?? []))
  check('配置里只剩活的那条', cur()[zombie].models.length === 1, String(cur()[zombie].models.length))
  check('留下来的还是那条活模型', cur()[zombie].models[0].id === OLLAMA_TAG, String(cur()[zombie].models[0]?.id))
  // 对齐只改 models：用户的调参（contextWindow/maxTokens/reasoningEfforts）和 compat 都不许被重置。
  check('用户调参没被探测值覆盖', cur()[zombie].models[0].contextWindow === 12345 && cur()[zombie].models[0].maxTokens === 777, JSON.stringify(cur()[zombie].models[0]))
  check('reasoningEfforts 没丢', cur()[zombie].models[0].reasoningEfforts?.low === 'low', JSON.stringify(cur()[zombie].models[0].reasoningEfforts))
  check('compat 没被动', cur()[zombie].compat?.thinkingFormat === 'chat-template', JSON.stringify(cur()[zombie].compat))
  check('baseURL 没被动', cur()[zombie].baseURL === 'http://127.0.0.1:11434/v1', String(cur()[zombie].baseURL))
  check('文案说清摘掉几条', /摘掉 2 条/.test(aligned.body.message ?? ''), aligned.body.message ?? '')

  // 再点一次：已经没有差值，必须报 changed:false 而不是又写一遍 settings。
  const updatesBefore = updates.length
  const again = await callRoute('align', { provider: zombie })
  check('第二次对齐不再改动', again.body.ok === true && again.body.changed === false, JSON.stringify(again.body))
  check('没有差值时一次 settings 都不写', updates.length === updatesBefore, `${updatesBefore} → ${updates.length}`)

  // 后端有、配置没注册的模型要补进来：换一条只有死声明的空壳，指向 11434（那边报 qwen3:4b）。
  const fresh = 'local-align-fresh'
  cur()[fresh] = {
    baseURL: 'http://127.0.0.1:11434/v1',
    models: [{ id: 'gone-long-ago', contextWindow: 32768 }],
  }
  const filled = await callRoute('align', { provider: fresh })
  check('补上了后端有但没注册的', JSON.stringify(filled.body.added ?? []) === JSON.stringify(['qwen3:4b']), JSON.stringify(filled.body.added ?? []))
  check('补进来的用的是后端报的 id', cur()[fresh].models.some((model) => model.id === 'qwen3:4b'), JSON.stringify(cur()[fresh].models.map((m) => m.id)))
  check('死声明一起摘掉', !cur()[fresh].models.some((model) => model.id === 'gone-long-ago'), JSON.stringify(cur()[fresh].models.map((m) => m.id)))

  // 全部都不在 → 不许对齐成 0 个模型（llm-pi-ai 里空 models 是配置错误，不是「停用」）。
  const allDead = 'local-align-alldead'
  cur()[allDead] = {
    baseURL: 'http://127.0.0.1:9999/v1',
    models: [{ id: 'x' }, { id: 'y' }],
  }
  // 用一个「在线但一个模型都没有」的端口不好造，这里就近验证 planAlign 的拒绝分支：
  // 直接 import 纯函数断言（路由层对空后端也会走同一条）。
  const { planAlign } = await import('../lib/import-model.js')
  const empty = planAlign({ declared: [{ id: 'x' }], live: [] })
  check('全不在时 planAlign 拒绝', empty.ok === false && /应该直接删掉/.test(empty.error ?? ''), empty.error ?? '')
  check('拒绝时不给空 models', empty.models === undefined, JSON.stringify(empty.models))

  // 清场：别让后面（如果有）的断言看到这些靶子。
  delete cur()[zombie]
  delete cur()[dead]
  delete cur()[fresh]
  delete cur()[allDead]
}
console.log('\n=== 22. reconcile：后端没了的模型摘掉，全没了就删 provider ===')
{
  const cur = () => settingsState['llm-pi-ai'].value.providers

  // 不说哪条 → 对全部本地 provider 对账（这里只验不炸、返回 ok）。
  const all = await callRoute('reconcile', { apply: true })
  check('不带 provider 也能跑', all.body.ok === true, JSON.stringify(all.body.error ?? all.body.message))
  check('带回 actions 数组', Array.isArray(all.body.actions), typeof all.body.actions)

  const ghost = await callRoute('reconcile', { provider: '__nope__' })
  check('不存在的 provider 明确报错', ghost.body.ok === false && /没有本地 provider/.test(ghost.body.error ?? ''), ghost.body.error ?? '')

  // 云端 provider 不归这里管：它没有「本机删了模型」这回事。
  const cloud = await callRoute('reconcile', { provider: 'deepseek-eo' })
  check('云端 provider 直接报不在本地', cloud.body.ok === false && /没有本地 provider/.test(cloud.body.error ?? ''), cloud.body.error ?? '')

  // llama.cpp 只报当前加载的那一个模型：它说「只有 A」可能只是没加载 B，
  // 这时候摘模型是错的 —— 必须跳过，而且理由要说清是「分不清」而不是「连不上」。
  const lcpp = 'local-reconcile-llamacpp'
  cur()[lcpp] = {
    baseURL: 'http://127.0.0.1:8090/v1',
    models: [{ id: 'qwen3-4b' }, { id: 'not-loaded-right-now' }],
  }
  const skipped = await callRoute('reconcile', { provider: lcpp, apply: true })
  check('llama.cpp 跳过不摘模型', skipped.body.ok === true && skipped.body.changed === false, JSON.stringify(skipped.body))
  check('跳过理由说清是分不清没装和没加载', /分不清/.test(JSON.stringify(skipped.body.actions ?? [])), JSON.stringify(skipped.body.actions ?? []))
  check('跳过时配置一条没少', cur()[lcpp].models.length === 2, String(cur()[lcpp].models.length))

  // 连不上：跟「后端真的空了」是两回事，必须一条都不动。
  const dead = 'local-reconcile-dead'
  cur()[dead] = {
    baseURL: 'http://127.0.0.1:9999/v1',
    models: [{ id: 'whatever' }],
  }
  const deadResult = await callRoute('reconcile', { provider: dead, apply: true })
  check('连不上就不动配置', deadResult.body.ok === true && deadResult.body.changed === false, JSON.stringify(deadResult.body))
  check('连不上时 models 一条没少', cur()[dead].models.length === 1, String(cur()[dead].models.length))

  // 部分死：只摘死的那几条，活着的一个字节都不动（用户调参不许被冲掉）。
  const zombie = 'local-reconcile-target'
  cur()[zombie] = {
    displayName: '本地对账靶子',
    baseURL: 'http://127.0.0.1:11434/v1',
    defaultMaxTokens: 2048,
    compat: { thinkingFormat: 'chat-template' },
    models: [
      { id: OLLAMA_TAG, contextWindow: 12345, maxTokens: 777, reasoningEfforts: { off: null, low: 'low' } },
      { id: 'qwen3:14b', contextWindow: 40960 },
      { id: 'qwen3:8b', contextWindow: 40960 },
    ],
  }
  const pruned = await callRoute('reconcile', { provider: zombie, apply: true })
  check('部分死：对账成功', pruned.body.ok === true && pruned.body.changed === true, JSON.stringify(pruned.body))
  check('摘掉的是那两条僵尸', JSON.stringify(pruned.body.actions?.[0]?.removed ?? []) === JSON.stringify(['qwen3:14b', 'qwen3:8b']), JSON.stringify(pruned.body.actions?.[0]?.removed ?? []))
  check('配置里只剩活的那条', cur()[zombie].models.length === 1, String(cur()[zombie].models.length))
  check('活着的条目原样保留（含用户调参）', JSON.stringify(cur()[zombie].models[0]) === JSON.stringify({ id: OLLAMA_TAG, contextWindow: 12345, maxTokens: 777, reasoningEfforts: { off: null, low: 'low' } }), JSON.stringify(cur()[zombie].models[0]))
  check('对账不碰 displayName / compat', cur()[zombie].displayName === '本地对账靶子' && cur()[zombie].compat?.thinkingFormat === 'chat-template', JSON.stringify(cur()[zombie]))
  check('文案说清摘掉几个', /摘掉 2 个/.test(pruned.body.message ?? ''), pruned.body.message ?? '')

  // 全死：这条 provider 一个模型都不在后端了 → 整条删掉（不是留个空 models）。
  const allDead = 'local-reconcile-alldead'
  cur()[allDead] = {
    baseURL: 'http://127.0.0.1:11434/v1',
    models: [{ id: 'qwen3:14b' }, { id: 'qwen3:8b' }],
  }
  const removed = await callRoute('reconcile', { provider: allDead, apply: true })
  check('全死：对账成功', removed.body.ok === true && removed.body.changed === true, JSON.stringify(removed.body))
  check('全死：整条 provider 删掉了', cur()[allDead] === undefined, JSON.stringify(cur()[allDead]))
  check('全死：走的是 mutate unset 而不是 update 写空数组', mutations.some((item) => JSON.stringify(item.ops ?? []) === JSON.stringify([{ op: 'unset', path: ['providers', allDead] }])), JSON.stringify(mutations.at(-1)?.ops ?? []))
  check('全死：文案说清是删掉', /删掉/.test(removed.body.message ?? ''), removed.body.message ?? '')

  // 只算不改：apply:false 时要把结论报出来，但配置一个字节都不动。
  const dry = 'local-reconcile-dry'
  cur()[dry] = {
    baseURL: 'http://127.0.0.1:11434/v1',
    models: [{ id: 'qwen3:14b' }, { id: OLLAMA_TAG }],
  }
  const planned = await callRoute('reconcile', { provider: dry, apply: false })
  check('apply:false 也能报结论', planned.body.ok === true && planned.body.changed === false, JSON.stringify(planned.body))
  check('apply:false 时 applied 是 false', planned.body.actions?.[0]?.applied === false, JSON.stringify(planned.body.actions ?? []))
  check('apply:false 时配置没动', cur()[dry].models.length === 2, String(cur()[dry].models.length))

  delete cur()[lcpp]
  delete cur()[dead]
  delete cur()[zombie]
  delete cur()[dry]
}
console.log(`\n${fail === 0 ? '=== 面板宿主侧集成全部通过 ===' : `=== ${fail} 项失败 ===`}`)
process.exit(fail === 0 ? 0 : 1)
