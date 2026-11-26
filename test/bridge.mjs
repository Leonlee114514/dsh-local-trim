/**
 * test/bridge.mjs — HTTP bridge 的节流语义与错误语义。
 *
 * 这里不经过 apply()，直接拿 makeBridgeRoutes() 造出路由表再打 handler，
 * 因为要验的正是「同一条重活路由会不会真的串行」这种并发性质 —— 走宿主侧
 * 集成测试的话，每次 apply 都会重新建一份 gate，测不到同一把锁上的竞争。
 *
 * 覆盖四件事：
 *   1. 路由表齐不齐（15 条 exact，前缀统一）；
 *   2. [gate-fifo] 同一条重活路由的并发请求必须串行，而且各拿各的结果；
 *   3. 最小间隔（gap）该 429 的 429、该放行的放行，配错的值回落到默认 800ms；
 *   4. 错误语义：405 / 403 / 400 / 413 / 500，以及抛异常之后锁有没有还回去。
 *
 * 用法：node test/bridge.mjs
 */

import { makeBridgeRoutes, BRIDGE_PREFIX } from '../lib/bridge.js'

let fail = 0
const check = (label, ok, extra = '') => {
  if (!ok) fail += 1
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (extra ? '  ' + extra : ''))
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const makeRes = () => {
  const out = { status: undefined, headers: undefined, text: '' }
  out.res = {
    writeHead: (code, headers) => {
      out.status = code
      out.headers = headers
    },
    end: (chunk) => {
      out.text = String(chunk ?? '')
    },
  }
  out.body = () => (out.text.length > 0 ? JSON.parse(out.text) : undefined)
  return out
}

const makeReq = (body, headers = {}, raw) => {
  const payload = Buffer.from(raw !== undefined ? raw : JSON.stringify(body ?? {}), 'utf8')
  const req = {
    method: 'POST',
    headers: {
      host: '127.0.0.1:56670',
      origin: 'http://127.0.0.1:56670',
      'content-type': 'application/json',
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
    on: (event, cb) => {
      // 真空 body 在真 http 里一个 data 事件都不发 —— 这里也得一样，否则
      // 「空 body 当 {} 处理」那条会退化成「空字符串不是合法 JSON」。
      if (event === 'data' && payload.length > 0) cb(payload)
      if (event === 'end') cb()
      return req
    },
    destroy: () => {},
  }
  return req
}

const makeDeps = (overrides = {}) => ({
  ns: 'local-tool-trim',
  read: async () => ({ value: {} }),
  save: async () => ({}),
  probe: async () => ({}),
  log: async () => ({}),
  ...overrides,
})

const routeOf = (list, name) => {
  const hit = list.find((item) => item.path === BRIDGE_PREFIX + '/' + name)
  if (hit === undefined) throw new Error('route not registered: ' + name)
  return hit
}

const call = async (route, body, headers) => {
  const res = makeRes()
  await route.handler(makeReq(body, headers), res.res)
  return res
}

console.log('\n=== 1. 路由表 ===')
{
  const routes = makeBridgeRoutes(makeDeps(), { minGapMs: 0 })
  check('15 条 exact 路由', routes.length === 15, String(routes.length))
  check('全是 exact', routes.every((item) => item.kind === 'exact'))
  check('前缀统一', routes.every((item) => item.path.startsWith(BRIDGE_PREFIX + '/')))
  const names = ['describe', 'save', 'probe', 'log', 'status', 'check', 'import', 'test', 'launch', 'stop', 'models', 'adopt', 'delete', 'align', 'reconcile']
  check('名字一个不缺', names.every((name) => routes.some((item) => item.path === BRIDGE_PREFIX + '/' + name)), names.filter((name) => !routes.some((item) => item.path === BRIDGE_PREFIX + '/' + name)).join(','))
}

console.log('\n=== 2. 请求形态 ===')
{
  const routes = makeBridgeRoutes(makeDeps(), { minGapMs: 0 })
  const status = routeOf(routes, 'status')

  const getRes = makeRes()
  const getReq = makeReq({})
  getReq.method = 'GET'
  await status.handler(getReq, getRes.res)
  check('GET → 405', getRes.status === 405, String(getRes.status))

  const cross = await call(status, {}, { 'sec-fetch-site': 'cross-site' })
  check('sec-fetch-site: cross-site → 403', cross.status === 403, String(cross.status))

  const rebind = await call(status, {}, { host: 'evil.example:56670' })
  check('Host 不是回环名 → 403（DNS rebinding）', rebind.status === 403, String(rebind.status))

  const peer = makeRes()
  const peerReq = makeReq({})
  peerReq.socket = { remoteAddress: '192.168.1.20' }
  await status.handler(peerReq, peer.res)
  check('对端不是回环 → 403', peer.status === 403, String(peer.status))
}

console.log('\n=== 3. body 语义 ===')
{
  const routes = makeBridgeRoutes(makeDeps(), { minGapMs: 0 })
  const probe = routeOf(routes, 'probe')

  const badRes = makeRes()
  await probe.handler(makeReq(undefined, {}, '{not json'), badRes.res)
  check('坏 JSON → 400', badRes.status === 400, String(badRes.status))
  check('坏 JSON 带稳定 code', badRes.body()?.code === 'bad-json', JSON.stringify(badRes.body()))

  const bigRes = makeRes()
  await probe.handler(makeReq(undefined, {}, JSON.stringify({ pad: 'x'.repeat(300 * 1024) })), bigRes.res)
  check('超过 256KB → 413', bigRes.status === 413, String(bigRes.status))
  check('413 带稳定 code', bigRes.body()?.code === 'body-too-large', JSON.stringify(bigRes.body()))

  const emptyRes = makeRes()
  await probe.handler(makeReq(undefined, {}, ''), emptyRes.res)
  check('空 body 当 {} 处理', emptyRes.status === 200, String(emptyRes.status))
}

console.log('\n=== 4. 抛异常 ===')
{
  const routes = makeBridgeRoutes(makeDeps({
    probe: async () => {
      throw new Error('boom at C:/Users/you/secret/path')
    },
  }), { minGapMs: 0 })
  const probe = routeOf(routes, 'probe')

  const first = await call(probe, {})
  check('抛异常 → 500', first.status === 500, String(first.status))
  check('500 带稳定 code', first.body()?.code === 'internal', JSON.stringify(first.body()))
  check('不把异常原文回给客户端', !String(first.body()?.error ?? '').includes('secret'), String(first.body()?.error ?? ''))

  const second = await call(probe, {})
  check('异常之后锁还回去了（不是 429）', second.status === 500, String(second.status))
}

console.log('\n=== 5. 同一条重活路由必须串行（[gate-fifo]）===')
{
  let running = 0
  let peak = 0
  let served = 0
  const routes = makeBridgeRoutes(makeDeps({
    probe: async () => {
      running += 1
      peak = Math.max(peak, running)
      const mine = (served += 1)
      await sleep(120)
      running -= 1
      return { served: mine }
    },
  }), { minGapMs: 0 })
  const probe = routeOf(routes, 'probe')

  const started = Date.now()
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => call(probe, {})))
  const spent = Date.now() - started

  check('五个并发峰值 1', peak === 1, 'peak=' + peak)
  check('五个都拿到 200', results.every((item) => item.status === 200), results.map((item) => item.status).join(','))
  const ids = results.map((item) => item.body()?.served).sort((a, b) => a - b)
  check('各拿各的结果', JSON.stringify(ids) === JSON.stringify([1, 2, 3, 4, 5]), JSON.stringify(ids))
  check('真的串行了（≥ 5×120ms）', spent >= 600, spent + 'ms')
}

console.log('\n=== 6. 纯读路由不排队 ===')
{
  let running = 0
  let peak = 0
  const routes = makeBridgeRoutes(makeDeps({
    read: async () => {
      running += 1
      peak = Math.max(peak, running)
      await sleep(80)
      running -= 1
      return { value: {} }
    },
  }), { minGapMs: 0 })
  const describe = routeOf(routes, 'describe')
  const results = await Promise.all([1, 2, 3].map(() => call(describe, {})))
  check('describe 并发峰值 3', peak === 3, 'peak=' + peak)
  check('describe 三个都 200', results.every((item) => item.status === 200))
}

console.log('\n=== 7. 最小间隔 ===')
{
  const routes = makeBridgeRoutes(makeDeps(), { minGapMs: 100 })
  const probe = routeOf(routes, 'probe')

  const first = await call(probe, {})
  const second = await call(probe, {})
  check('第一次 200', first.status === 200, String(first.status))
  check('紧接着第二次 429', second.status === 429, String(second.status))
  check('429 说的是 gap', second.body()?.throttled === 'gap', JSON.stringify(second.body()))
  check('429 带 retryInMs', Number(second.body()?.retryInMs) > 0, String(second.body()?.retryInMs))

  await sleep(120)
  const third = await call(probe, {})
  check('等过了就放行', third.status === 200, String(third.status))
}

console.log('\n=== 8. 配错的间隔回落到默认 800ms ===')
{
  for (const bad of [-5, Number.NaN, '800', null]) {
    const routes = makeBridgeRoutes(makeDeps(), { minGapMs: bad })
    const probe = routeOf(routes, 'probe')
    const first = await call(probe, {})
    const second = await call(probe, {})
    const label = 'minGapMs=' + String(bad) + ' 仍按 800ms 挡'
    check(label, first.status === 200 && second.status === 429, first.status + '/' + second.status)
  }

  const zero = makeBridgeRoutes(makeDeps(), { minGapMs: 0 })
  const zeroProbe = routeOf(zero, 'probe')
  await call(zeroProbe, {})
  const afterZero = await call(zeroProbe, {})
  check('minGapMs=0 只关间隔、不关排队', afterZero.status === 200, String(afterZero.status))
}

console.log('\n=== 9. 半开连接不能把锁占死（[L4]）===')
{
  // 真 http 里客户端发完 header 就断开时：没有 'end'，'error' 也不一定来，
  // 连接是正常关闭的。旧代码在这种请求上永远 pending，而它已经先抢到了锁 ——
  // 之后同路由的请求全在 waitFor 里排队，面板「起不来也停不掉」，只能重启 DSH。
  const halfOpen = (body, headers = {}) => {
    const events = new Map()
    const req = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:56670',
        origin: 'http://127.0.0.1:56670',
        'content-type': 'application/json',
        ...headers,
      },
      socket: { remoteAddress: '127.0.0.1' },
      on: (event, cb) => {
        const list = events.get(event) ?? []
        list.push(cb)
        events.set(event, list)
        return req
      },
      emit: (event, value) => {
        for (const cb of events.get(event) ?? []) cb(value)
      },
      destroy: () => {},
    }
    if (body !== undefined) setImmediate(() => req.emit('data', Buffer.from(body, 'utf8')))
    return req
  }

  let served = 0
  const routes = makeBridgeRoutes(makeDeps({
    probe: async () => { served += 1; return { served } },
  }), { minGapMs: 0, bodyReadTimeoutMs: 120 })
  const probe = routeOf(routes, 'probe')

  // 半开：一个字节都不发，也不 end。
  const stuckReq = halfOpen(undefined)
  const stuckRes = makeRes()
  const stuck = probe.handler(stuckReq, stuckRes.res)
  await sleep(200)
  check('半开请求自己超时落定（不再永远 pending）', stuckRes.status === 408, String(stuckRes.status))
  check('408 带稳定 code', stuckRes.body()?.code === 'timeout', JSON.stringify(stuckRes.body()))
  await stuck

  const afterStuck = await call(probe, {})
  check('半开请求没把锁占死：下一条照常 200', afterStuck.status === 200, String(afterStuck.status))

  // 断开：发了一半就 close，没有 end。
  const abortedReq = halfOpen('{"partial":')
  const abortedRes = makeRes()
  const aborted = probe.handler(abortedReq, abortedRes.res)
  await sleep(20)
  abortedReq.emit('close')
  await aborted
  check('读到一半断开 → 408', abortedRes.status === 408, String(abortedRes.status))
  check('断开带 code=aborted', abortedRes.body()?.code === 'aborted', JSON.stringify(abortedRes.body()))

  // 正常读完之后的 close 不该被当成断开。
  const normalRes = await call(probe, {})
  check('正常请求不受影响', normalRes.status === 200, String(normalRes.status))
}

console.log('\n=== 10. 排队等太久就说明白（[L4]）===')
{
  // 前一条卡在一个不返回的 handler 上：后来的请求不能无声无息挂在队列里。
  let release = null
  const routes = makeBridgeRoutes(makeDeps({
    probe: async () => {
      await new Promise((done) => { release = done })
      return { ok: true }
    },
  }), { minGapMs: 0, gateWaitTimeoutMs: 100 })
  const probe = routeOf(routes, 'probe')

  const first = call(probe, {})
  await sleep(20)
  // 排队超时用的计时器是 unref 的（不能让插件因为等它而活着），测试里得自己撑住
  // 事件循环，否则进程在计时器触发前就退了，await 永远不落定。
  const keepAlive = setTimeout(() => {}, 2_000)
  const second = await call(probe, {})
  check('排队超时 → 503', second.status === 503, String(second.status))
  check('503 带 code=gate-timeout', second.body()?.code === 'gate-timeout', JSON.stringify(second.body()))
  check('503 说清楚是哪条路由', String(second.body()?.error ?? '').includes('probe'), String(second.body()?.error ?? ''))

  clearTimeout(keepAlive)
  release?.()
  first.catch(() => {})
}

console.log('\n=== 11. 配置改成函数后，改完下一条请求就生效（[D5]）===')
{
  // 原来 minGapMs / trustedHosts / trustedPeers 在 makeBridgeRoutes 那一刻就被求值
  // 进闭包：面板里改完 savePanel 回 {saved:true}，界面一切正常，实际要重启 DSH 才生效。
  // 现在允许传 thunk，每次请求现取 —— 这组用例钉的就是「现取」这件事。
  let gap = 0
  let hosts = []
  let peers = []
  const routes = makeBridgeRoutes(makeDeps(), {
    minGapMs: () => gap,
    trustedHosts: () => hosts,
    trustedPeers: () => peers,
  })
  const probe = routeOf(routes, 'probe')

  const a1 = await call(probe, {})
  const a2 = await call(probe, {})
  check('间隔配 0 时连点两次都放行', a1.status === 200 && a2.status === 200, a1.status + '/' + a2.status)

  // 面板里把 bridgeThrottleMs 从 0 改成 100 —— 不重建路由，下一条就该被挡
  gap = 100
  const a3 = await call(probe, {})
  check('改成 100 之后不重启就生效', a3.status === 429, String(a3.status))
  check('429 仍是 gap 语义', a3.body()?.throttled === 'gap', JSON.stringify(a3.body()))

  // 再改回去，同样立即生效
  gap = 0
  const a4 = await call(probe, {})
  check('改回 0 也立即生效', a4.status === 200, String(a4.status))

  // Host 白名单：不在名单里 403，加进名单后立刻放行
  const evilHost = { host: 'evil.example:56670' }
  const h1 = await call(probe, {}, evilHost)
  check('Host 不在白名单 → 403', h1.status === 403, String(h1.status))
  hosts = ['evil.example']
  const h2 = await call(probe, {}, evilHost)
  check('把 Host 加进 trustedHosts 后立即放行', h2.status === 200, String(h2.status))

  // 对端白名单：非回环对端默认 403，加进 trustedPeers 后立刻放行
  const peerReq = () => {
    const req = makeReq({})
    req.socket.remoteAddress = '192.168.1.9'
    return req
  }
  const p1 = makeRes()
  await probe.handler(peerReq(), p1.res)
  check('非回环对端默认 → 403', p1.status === 403, String(p1.status))
  peers = ['192.168.1.9']
  const p2 = makeRes()
  await probe.handler(peerReq(), p2.res)
  check('把对端加进 trustedPeers 后立即放行', p2.status === 200, String(p2.status))

  // thunk 抛错不能把整条路由打死：退回「没配这个选项」的默认行为。
  const broken = makeBridgeRoutes(makeDeps(), {
    minGapMs: () => { throw new Error('配置读坏了') },
    trustedHosts: () => { throw new Error('配置读坏了') },
  })
  const brokenProbe = routeOf(broken, 'probe')
  const b1 = await call(brokenProbe, {})
  check('thunk 抛错时退回默认间隔（800ms），不抛 500', b1.status === 200, String(b1.status))
  const b2 = await call(brokenProbe, {})
  check('默认间隔确实生效（第二条 429）', b2.status === 429, String(b2.status))
}

console.log('\n' + (fail === 0 ? '=== bridge 节流与错误语义全部通过 ===' : '=== ' + fail + ' 项失败 ==='))
process.exit(fail === 0 ? 0 : 1)
