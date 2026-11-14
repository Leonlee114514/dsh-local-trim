/**
 * test/client-host.mjs — 「这个 profile 到底有没有 client 宿主」的自检。
 *
 * 面板挂在 `plugins.detail.section` 槽位上，那个槽位由
 * `@deepseek-ai/dsh-client-ui-plugin-manager` 声明，而它只随 `dsh-web-app` 一起装。
 * 于是：
 *
 *   web profile       有 clientModules 服务 → ctx.inject 回调会触发 → 面板能出现
 *   headless/sdk/acp  没有这个服务        → 回调**永不触发** → 面板不会出现
 *
 * 第二种情况下，装插件的人看到的只是「装完了，什么也没发生」，日志里一行都没有。
 * 这里钉住的就是：不管有没有宿主，插件的 lib 半边都要**说出来**，而且不能把
 * 「没面板」冒充成「裁剪坏了」。
 *
 * 用法：node test/client-host.mjs
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

const LOG = join(tmpdir(), 'dsh-local-trim.client-host.log')
process.env.DSH_LOCAL_TRIM_LOG = LOG

const { apply } = await import('../lib/index.js')

let fail = 0
const check = (label, ok, extra = '') => {
  if (!ok) fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

const readLog = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')

/**
 * 造一个最小 ctx。
 * `clientModules` 为 undefined 时**不要**让 inject(['clientModules']) 的回调跑 ——
 * 这正是 headless profile 的真实行为：服务不存在，回调压根不被调用。
 */
function makeCtx({ clientModules } = {}) {
  const routes = new Map()
  const webServer = {
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  // settings 是可选的：这里给一个空实现。不给的话 describePanel 会走
  // 「inject(['settings']) + 4 秒兜底超时」那条路，而那个 timer 是 unref 的 ——
  // 进程会先退出，测试就挂在 unsettled top-level await 上。
  const settings = { describe: () => [], update: async () => {} }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer,
    get: (name) => {
      if (name === 'tools') return { schemas: () => [], restrict: () => () => {} }
      if (name === 'settings') return settings
      if (name === 'webServer') return webServer
      if (name === 'clientModules') return clientModules
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    systemPrompt: { assemble: async () => ({ sections: [], contexts: [], tools: [] }) },
    on: () => () => {},
    effect: (fn) => fn(),
    inject: (deps, fn) => {
      if (deps.includes('webServer')) {
        fn(ctx)
        return
      }
      if (deps.includes('settings')) {
        fn({ ...ctx, settings })
        return
      }
      // 服务在才跑回调 —— cordis 的语义就是这样，桩必须照抄，否则测出来的就不算数。
      if (deps.includes('clientModules') && clientModules !== undefined) fn({ ...ctx, clientModules })
    },
  }
  return { ctx, routes }
}

const statusOf = async (routes) => {
  const route = routes.get('/api/dsh-local-trim/status')
  if (route === undefined) throw new Error('status 路由没注册上')
  // online:false —— 这个用例只关心 client 宿存，不要顺手去打真端口（没有后端时会挂很久）。
  const payload = Buffer.from(JSON.stringify({ online: false }), 'utf8')
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
  let text = ''
  const res = { writeHead: () => {}, end: (chunk) => { text = String(chunk ?? '') } }
  await route.handler(req, res)
  return JSON.parse(text)
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 场景 1：没有 client 宿主（headless / sdk / acp profile）────────────────

console.log('\n=== 1. 没有 client 宿主：说出「面板不会出现」，但别吓人 ===')
{
  const { ctx, routes } = makeCtx({})
  apply(ctx, { enabled: true, routes: [], injectText: 'L', selfCheck: false, provision: false, bridgeThrottleMs: 0 })

  // apply 当场不能就断言「没有宿主」—— 服务是晚于插件注册的，
  // 所以这一刻必须报「未知」，不能抢答。
  const immediate = await statusOf(routes)
  check('apply 当场是「未知」，不抢答', immediate.status.client.state === 'unknown', immediate.status.client.state)
  check('未知时不说「不可用」', !/不可用/.test(immediate.status.client.label), immediate.status.client.label)

  // 兜底探测在 1.5s 后跑（unref，不会拖住进程）。
  await settle(1700)
  const later = await statusOf(routes)
  check('探测后判定为没有宿主', later.status.client.state === 'missing', later.status.client.state)
  check('明说面板不会出现', /面板不可用/.test(later.status.client.label), later.status.client.label)
  check('同时说明裁剪照常生效', /裁剪照常生效/.test(later.status.client.label), later.status.client.label)
  check(
    '说明是谁提供的、为什么没有',
    /client-modules/.test(later.status.client.detail) && /dsh-web-app/.test(later.status.client.detail),
    later.status.client.detail.slice(0, 60),
  )

  const log = readLog()
  check('日志里留了一行，不再是「装了没反应」', /client 半边没有宿主/.test(log))
}

// ── 场景 2：有 client 宿主（web profile）──────────────────────────────────

console.log('\n=== 2. 有 client 宿主：报 ready，且不误报 ===')
{
  const pkgMeta = new Map()
  const dirty = new Set()
  const clientModules = {
    pkgMeta,
    dirty,
    composed: { entries: [] },
    flush: (cb) => {
      // 真宿主会在这里重扫；桩里直接把自己编进条目表。
      clientModules.composed.entries.push({ id: 'dsh-local-trim' })
      if (typeof cb === 'function') cb()
    },
  }
  const { ctx, routes } = makeCtx({ clientModules })
  apply(ctx, { enabled: true, routes: [], injectText: 'L', selfCheck: false, provision: false, bridgeThrottleMs: 0 })

  const view = await statusOf(routes)
  check('判定为有宿主', view.status.client.state === 'ready', view.status.client.state)
  check('绿灯 + 说面板可用', view.status.client.tone === 'good' && /面板可用/.test(view.status.client.label), view.status.client.label)
  check('缓存被清过（自愈真的跑了）', pkgMeta.size === 0)
  check('本包被标脏，宿主会重扫', dirty.has('dsh-local-trim'))
  check('日志说进了条目表', /client 半边有宿主/.test(readLog()))
}

console.log(`\n${fail === 0 ? '=== client 宿主自检全部通过 ===' : `=== ${fail} 项失败 ===`}`)
process.exit(fail === 0 ? 0 : 1)
