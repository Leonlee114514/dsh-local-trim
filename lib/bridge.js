/**
 * 控制面板的 HTTP bridge。
 *
 * 面板（client.js）跑在浏览器里，碰不到 cordis 服务，只能走 HTTP。
 * 注册 15 条 exact 路由，全部 POST，全部先过 guard：
 *
 *   POST /api/dsh-local-trim/describe  读当前值 + revision + 探测到的本地 provider
 *   POST /api/dsh-local-trim/save      写回一组字段（走 settings.update，带 revision 校验）
 *   POST /api/dsh-local-trim/probe     立刻探测一次本地端点，返回可用列表
 *   POST /api/dsh-local-trim/log       读启动自检 / 最近裁剪日志的尾部
 *   POST /api/dsh-local-trim/status    面板主视图：接管状态 + 裁剪收益 + provider 表
 *   POST /api/dsh-local-trim/check     给 provider 表点灯（GET /v1/models，带缓存）
 *   POST /api/dsh-local-trim/import    导入一个本地模型：探测 → 写 settings → 试跑
 *   POST /api/dsh-local-trim/test      对已注册的 provider 发一次最小真实请求
 *   POST /api/dsh-local-trim/launch    拉起本机后端（llama.cpp / ollama / vLLM / LM Studio）
 *   POST /api/dsh-local-trim/stop      停掉面板自己拉起的后端（只认自己起的 pid）
 *   POST /api/dsh-local-trim/models    列出本机已下好的权重（.gguf + Ollama 存储里的 blob）
 *   POST /api/dsh-local-trim/adopt     选一个模型 → 起服务 → 写 provider → 试跑（Ollama 走 11434 + tag）
 *   POST /api/dsh-local-trim/delete    删掉一条本地 provider 配置（不动磁盘上的权重文件）
 *   POST /api/dsh-local-trim/align     把一条 provider 的 models 对齐到后端此刻真的有的那份
 *   POST /api/dsh-local-trim/reconcile 对账：后端没有的模型从 provider 里摘掉，全没了就删 provider
 *
 * 安全：只接受同源、且来源地址是回环（或显式配置的受信主机）的请求。
 */

export const BRIDGE_PREFIX = '/api/dsh-local-trim'
const MAX_JSON_BODY_BYTES = 256 * 1024
const MAX_LOG_TAIL_BYTES = 64 * 1024

/**
 * 重活路由的节流表。
 *
 * probe / test / launch / adopt / models / stop 都会真的碰网络或真的起进程，
 * 同源页面连点几下就能把它们叠起来打 —— 之前 adopt 连点两次就是两次 spawn，
 * 17GB 权重被读两遍，机器直接卡死。这里按路由名做两件事：
 *   1. in-flight 去重：同一条路由同时只跑一个，后来的直接拿 429 + 正在跑的那条名字；
 *   2. 最小间隔：上一条刚跑完的 MIN_GAP_MS 内再打，同样 429。
 * 只挡重活；describe / status / log 这些纯读的照旧放行。
 */
const MIN_GAP_MS = 800
// [P2-13-2026-11-26] save 也进重活表：它写的是 settings（整条 providers 数组），
// 连点两下就是两次 CAS 写 + 两次 reload，后一次还常常撞 revision 冲突。
const HEAVY_ROUTES = new Set([
  'probe',
  'check',
  'import',
  'test',
  'launch',
  'stop',
  'models',
  'adopt',
  'delete',
  'align',
  'reconcile',
  'save',
])

function isLoopbackAddress(address) {
  const value = String(address ?? '').trim()
  if (value.length === 0) return false
  const bare = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value
  if (bare === '::1' || bare === '127.0.0.1') return true
  if (/^127\./.test(bare)) return true
  return false
}

function isLoopbackHostname(hostname) {
  const value = String(hostname ?? '').trim().toLowerCase()
  return value === 'localhost' || value === '127.0.0.1' || value === '[::1]' || value === '::1'
}

function hostUrlOf(request) {
  const raw = request.headers?.host
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    return new URL(`http://${raw}`)
  } catch {
    return undefined
  }
}

/**
 * 这个请求能不能驱动 bridge。
 *
 * [bridge-origin] 判定基准是「TCP 对端地址」和「Host 头是不是回环名字」，
 * **不是**「Host 与 Origin 是否相等」—— 后者是自证清白：攻击页可以让两者都为
 * `evil.com`，服务端拿请求自报的 Host 当基准，比对必然相等，然后一路放行。
 *
 * 具体两类攻击都靠这条挡住：
 *   · DNS rebinding：攻击者域名解析到 127.0.0.1，浏览器于是把 `Host: evil.com`、
 *     `Origin: http://evil.com` 发到本机 —— 对端是回环所以 TCP 层看起来没问题，
 *     但 Host 不是回环名字 ⇒ 拒。
 *   · 同网段设备直连：对端不是回环（`192.168.x.x`）且没配 trustedPeers ⇒ 拒。
 *
 * 真的要局域网访问 GUI 时，由调用方显式给出 `trustedHosts` / `trustedPeers`，
 * 默认空集合 = 只认本机。
 */
function isBridgeRequestAllowed(request, options = {}) {
  const trustedHosts = options.trustedHosts instanceof Set ? options.trustedHosts : new Set()
  const trustedPeers = options.trustedPeers instanceof Set ? options.trustedPeers : new Set()

  // ① 对端地址：非回环就必须在显式信任名单里。
  const peer = String(request.socket?.remoteAddress ?? '').trim()
  if (!isLoopbackAddress(peer) && !trustedPeers.has(peer)) return false

  // ② 浏览器自己声明的跨站标记，最省事的一条。
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false

  // ③ Host 头：DNS rebinding 的唯一破口。浏览器没法伪造它，所以它可信
  //    —— 前提是我们只用它做「是不是本机名字」的判断，不拿它当基准去比对。
  const hostUrl = hostUrlOf(request)
  if (hostUrl !== undefined) {
    const hostname = hostUrl.hostname.toLowerCase()
    if (!isLoopbackHostname(hostname) && !trustedHosts.has(hostname)) return false
  }

  // ④ Origin：有就必须是回环/受信来源；没有也放行（非浏览器客户端、同源 fetch
  //    在部分场景不带 Origin）。真正的边界是 ① 和 ③，这条只是再上一道锁。
  const origin = request.headers?.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      return false
    }
    const hostname = originUrl.hostname.toLowerCase()
    if (hostname !== 'null' && !isLoopbackHostname(hostname) && !trustedHosts.has(hostname)) return false
  }

  return true
}

/**
 * 把内部异常原文写到进程日志（不是 HTTP 响应）。
 *
 * 错误原文里有绝对路径、`overridden by a home patch` 这类内部文案 —— 对调试有用，
 * 对面板用户是噪音且是信息泄露面。这里只在有 logger 时输出，失败静默。
 */
function reportBridgeError(logger, name, error) {
  const text = `[bridge] ${name} 抛异常: ${error?.stack ?? String(error?.message ?? error)}`
  try {
    logger?.(text)
  } catch {
    /* 日志本身失败就算了 */
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * 读请求体。返回 `{ state, value }`：
 *   state = 'ok'      → value 是解析好的对象（空 body 给 {}）
 *   state = 'bad'     → 不是合法 JSON
 *   state = 'toobig'  → 超过 MAX_JSON_BODY_BYTES
 *
 * [body-413] 超限时**不要** `req.destroy()`。原来的写法先把连接掐了再 writeJson(400)，
 * 客户端看到的是 `ERR_CONNECTION_RESET` 而不是任何一条我们能解释的话。现在把超出的
 * 数据读完丢掉，然后正常回 413 —— 代价是这几百 KB 流量（本地回环，无所谓）。
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    let tooBig = false
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BODY_BYTES) {
        tooBig = true
        chunks.length = 0
        return
      }
      if (!tooBig) chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooBig) return resolve({ state: 'toobig' })
      if (chunks.length === 0) return resolve({ state: 'ok', value: {} })
      try {
        resolve({ state: 'ok', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        resolve({ state: 'bad' })
      }
    })
    req.on('error', () => resolve({ state: 'bad' }))
  })
}

/**
 * @param {{
 *   ns: string,
 *   read: () => Promise<object>,
 *   save: (patch: object, revision: number | undefined) => Promise<object>,
 *   probe: (input: object) => Promise<object>,
 *   log: (bytes: number) => Promise<object>,
 *   status?: (input: object) => Promise<object>,
 *   check?: (input: object) => Promise<object>,
 *   importModel?: (input: object) => Promise<object>,
 *   testModel?: (input: object) => Promise<object>,
 *   launch?: (input: object) => Promise<object>,
 *   stop?: (input: object) => Promise<object>,
 *   models?: (input: object) => Promise<object>,
 *   adopt?: (input: object) => Promise<object>,
 *   delete?: (input: object) => Promise<object>,
 *   align?: (input: object) => Promise<object>,
 *   reconcile?: (input: object) => Promise<object>,
 * }} deps
 * @param {{minGapMs?: number}} [options] 测试可以把最小间隔调 0，生产走默认。
 */
export function makeBridgeRoutes(deps, options = {}) {
  // [gap-guard] 只有「显式给了非负有限数」才信它 —— 0 表示关掉间隔，这是文档里的语义，
  // 保留给测试和脚本化调用。负数、NaN、字符串、undefined 一律回落到 MIN_GAP_MS：
  // 原来负数走 Math.max(0, …) 也变成 0，等于把节流整段关掉，一个填错的配置
  // 就能让面板被连点刷穿。
  const rawGap = options?.minGapMs
  const minGapMs = Number.isFinite(rawGap) && Number(rawGap) >= 0 ? Number(rawGap) : MIN_GAP_MS
  /** 路由名 → { inflight, at, waiters[] }。waiters 是 FIFO 队列，见 [gate-fifo]。 */
  const gate = new Map()
  const now = () => Date.now()

  /**
   * 重活节流。
   *
   * [gate-share] 同一条路由正在跑的时候，后来的请求**等它**，而不是直接拒。
   *
   * 原来回 `{throttled:'inflight'}`，用户看到的是「上一次还没跑完，等它结束再来一次」
   * —— 但面板根本不知道什么时候结束，用户只能盲点。而这两次请求问的是同一个问题
   * （同一个 baseURL 的 /v1/models），结果一模一样，拒掉纯属浪费。
   * 现在把它挂到在跑的那个 Promise 上，跑完一起拿结果。
   *
   * 仍然保留最小间隔（gap）：那是防连点刷屏，语义不同 —— 有结果的重复请求才该合并，
   * 已经跑完的重复请求该被劝退。
   */
  //
  // [gate-fifo] 等待者必须是队列，不能是「一个 Promise 叫醒所有人」。
  //
  // 原来 release 里 `settle(undefined)` 唤醒的是**所有**挂在这个 Promise 上的请求，
  // 它们醒来后各自 `enter(name, {skipGap:true})`，此时 gate 里已经是 inflight:false
  // 的旧行，于是**全部**判定成功并各自置 inflight:true —— 同一条路由上同时跑 N 个
  // llama-server、同时写 settings。实测（5 个并发 adopt，minGapMs:0）peak=4：
  // +202ms 第一个结束，+203ms 其余四个一起开跑。承诺的「同一条路由串行」从来没成立。
  //
  // 现在：等待者进 waiters 队列；release 只把锁**直接交接**给队首 —— 队首拿到的是一张
  // 已经生效的 ticket，不需要重新抢锁（重新抢锁会看到 inflight:true 又排回队尾，死锁）。
  // 队列空了才真正把 inflight 置回 false。
  const makeTicket = (name, entry) => ({
    blocked: undefined,
    waitFor: undefined,
    release: () => releaseLock(name, entry),
  })

  const releaseLock = (name, entry) => {
    // 已经不是自己持有的那把锁（重复 release / 被后来的请求顶掉）就不动它。
    if (gate.get(name) !== entry) return
    const next = entry.waiters.shift()
    if (next !== undefined) {
      // 锁原地交接：inflight 始终为 true，中间没有任何窗口能被别人插进来。
      entry.at = now()
      next(makeTicket(name, entry))
      return
    }
    gate.set(name, { inflight: false, at: now(), waiters: [] })
  }

  const enter = (name, { skipGap = false } = {}) => {
    if (!HEAVY_ROUTES.has(name)) return { blocked: undefined, waitFor: undefined, release: () => {} }
    const row = gate.get(name)
    const stamp = now()
    if (row !== undefined && row.inflight === true) {
      let settle
      const waitFor = new Promise((done) => {
        settle = done
      })
      row.waiters.push(settle)
      return { blocked: undefined, waitFor, release: () => {} }
    }
    if (!skipGap && row !== undefined && minGapMs > 0 && stamp - row.at < minGapMs) {
      const retryInMs = minGapMs - (stamp - row.at)
      return {
        blocked: {
          ok: false,
          throttled: 'gap',
          retryInMs,
          error: `${name} 刚跑过，${retryInMs}ms 后再试`,
        },
        waitFor: undefined,
        release: () => {},
      }
    }
    const entry = { inflight: true, at: stamp, waiters: row !== undefined ? row.waiters : [] }
    gate.set(name, entry)
    return makeTicket(name, entry)
  }

  const guard = (req, res) => {
    if (!isBridgeRequestAllowed(req, { trustedHosts: options?.trustedHosts, trustedPeers: options?.trustedPeers })) {
      writeJson(res, 403, { ok: false, error: 'requests must come from the local host' })
      return false
    }
    if (String(req.method ?? '').toUpperCase() !== 'POST') {
      writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method ?? ''}` })
      return false
    }
    return true
  }
  const route = (name, handler) => ({
    kind: 'exact',
    path: `${BRIDGE_PREFIX}/${name}`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      let ticket = enter(name)
      if (ticket.waitFor !== undefined) {
        // 前一次同路由还在跑：排队等它结束。release 会把锁**直接交接**过来
        // （连同新的 ticket），所以这里不用再 enter 一次 —— 再 enter 会看到
        // inflight:true 又排回队尾，永远轮不到。
        const handed = await ticket.waitFor
        ticket = handed !== undefined ? handed : enter(name, { skipGap: true })
      }
      if (ticket.blocked !== undefined) {
        // 节流：真的是「刚跑完，别连着来」。这个语义用 429 表达。
        writeJson(res, 429, ticket.blocked)
        return
      }
      try {
        const read = await readJsonBody(req)
        if (read.state === 'toobig') {
          writeJson(res, 413, { ok: false, error: `body 超过 ${MAX_JSON_BODY_BYTES} 字节（本地控制面板用不到这么大）`, code: 'body-too-large' })
          return
        }
        if (read.state === 'bad') {
          writeJson(res, 400, { ok: false, error: 'body 不是合法 JSON', code: 'bad-json' })
          return
        }
        writeJson(res, 200, await handler(read.value ?? {}))
      } catch (error) {
        // [err-500] 内部异常必须是真的错误状态码。
        //
        // 原来这里写 `writeJson(res, 200, {ok:false, error})`：`response.ok` 恒为 true，
        // client.js 的 `if (!response.ok) throw` 永不触发，于是面板把「服务端炸了」
        // 当成「业务说不行」，还顺手把 error.message 原文（含绝对路径、内部文案）
        // 直接渲染给用户。现在：状态码说实话，原文只进日志，客户端拿稳定 code。
        reportBridgeError(options?.logger, name, error)
        writeJson(res, 500, { ok: false, error: `内部错误：${name} 这条路由抛异常了，细节见 DSH 日志`, code: 'internal' })
      } finally {
        ticket.release()
      }
    },
  })

  return [
    route('describe', async () => ({ ok: true, ns: deps.ns, ...(await deps.read()) })),
    route('save', async (body) => {
      const patch = body?.patch
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, error: 'patch must be an object' }
      }
      const revision = Number.isInteger(body?.revision) ? body.revision : undefined
      return { ok: true, ...(await deps.save(patch, revision)) }
    }),
    route('probe', async (body) => ({ ok: true, ...(await deps.probe(body ?? {})) })),
    route('log', async (body) => {
      const bytes = Number.isInteger(body?.bytes) ? Math.min(Math.max(body.bytes, 0), MAX_LOG_TAIL_BYTES) : 8192
      return { ok: true, ...(await deps.log(bytes)) }
    }),
    route('status', async (body) => ({ ok: true, ...(await (deps.status?.(body ?? {}) ?? {})) })),
    route('check', async (body) => ({ ok: true, ...(await (deps.check?.(body ?? {}) ?? {})) })),
    route('import', async (body) => ({ ok: true, ...(await (deps.importModel?.(body ?? {}) ?? {})) })),
    route('test', async (body) => ({ ok: true, ...(await (deps.testModel?.(body ?? {}) ?? {})) })),
    route('launch', async (body) => ({ ok: true, ...(await (deps.launch?.(body ?? {}) ?? {})) })),
    route('stop', async (body) => ({ ok: true, ...(await (deps.stop?.(body ?? {}) ?? {})) })),
    route('models', async (body) => ({ ok: true, ...(await (deps.models?.(body ?? {}) ?? {})) })),
    route('adopt', async (body) => ({ ok: true, ...(await (deps.adopt?.(body ?? {}) ?? {})) })),
    route('delete', async (body) => ({ ok: true, ...(await (deps.delete?.(body ?? {}) ?? {})) })),
    route('align', async (body) => ({ ok: true, ...(await (deps.align?.(body ?? {}) ?? {})) })),
    route('reconcile', async (body) => ({ ok: true, ...(await (deps.reconcile?.(body ?? {}) ?? {})) })),
  ]
}
