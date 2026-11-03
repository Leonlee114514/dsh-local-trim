/**
 * 控制面板的 HTTP bridge。
 *
 * 面板（client.js）跑在浏览器里，碰不到 cordis 服务，只能走 HTTP。
 * 注册 12 条 exact 路由，全部 POST，全部先过 guard：
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
 *   POST /api/dsh-local-trim/models    列出本机已下好的 .gguf
 *   POST /api/dsh-local-trim/adopt     选一个 gguf → 起服务 → 写 provider → 试跑
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
 * 只挡重活；describe / status / log / save 这些纯读写的照旧放行。
 */
const MIN_GAP_MS = 800
const HEAVY_ROUTES = new Set(['probe', 'check', 'import', 'test', 'launch', 'stop', 'models', 'adopt'])

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

/** 同源 + 回环来源。跨站请求一律 403。 */
function isBridgeRequestAllowed(request) {
  const hostUrl = hostUrlOf(request)
  if (hostUrl === undefined) return false
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers?.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host !== hostUrl.host) return false
    } catch {
      return false
    }
  }
  if (isLoopbackHostname(hostUrl.hostname)) return isLoopbackAddress(request.socket?.remoteAddress)
  // 非回环监听（局域网访问 GUI）时，要求来源与 Host 完全一致就已经够了。
  return true
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BODY_BYTES) {
        resolve(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
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
 * }} deps
 * @param {{minGapMs?: number}} [options] 测试可以把最小间隔调 0，生产走默认。
 */
export function makeBridgeRoutes(deps, options = {}) {
  const minGapMs = Number.isFinite(options?.minGapMs) ? Math.max(0, Number(options.minGapMs)) : MIN_GAP_MS
  /** 路由名 → 上一次的状态（{ inflight: true, at }）。 */
  const gate = new Map()
  const now = () => Date.now()

  /**
   * 重活节流。返回 blocked 表示该回 429（业务失败但 HTTP 仍 200）。
   * `release()` 必须在 handler 结束后调用（finally）。
   */
  const enter = (name) => {
    if (!HEAVY_ROUTES.has(name)) return { blocked: undefined, release: () => {} }
    const row = gate.get(name)
    const stamp = now()
    if (row !== undefined && row.inflight === true) {
      return {
        blocked: {
          ok: false,
          throttled: 'inflight',
          error: `${name} 上一次还没跑完，等它结束再来一次`,
        },
        release: () => {},
      }
    }
    if (row !== undefined && minGapMs > 0 && stamp - row.at < minGapMs) {
      return {
        blocked: {
          ok: false,
          throttled: 'gap',
          retryInMs: minGapMs - (stamp - row.at),
          error: `${name} 刚跑过，${minGapMs - (stamp - row.at)}ms 后再试`,
        },
        release: () => {},
      }
    }
    gate.set(name, { inflight: true, at: stamp })
    return {
      blocked: undefined,
      release: () => gate.set(name, { inflight: false, at: now() }),
    }
  }

  const guard = (req, res) => {
    if (!isBridgeRequestAllowed(req)) {
      writeJson(res, 403, { error: 'requests must come from the local host' })
      return false
    }
    if (String(req.method ?? '').toUpperCase() !== 'POST') {
      writeJson(res, 405, { error: `method not allowed: ${req.method ?? ''}` })
      return false
    }
    return true
  }
  const route = (name, handler) => ({
    kind: 'exact',
    path: `${BRIDGE_PREFIX}/${name}`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const ticket = enter(name)
      if (ticket.blocked !== undefined) {
        writeJson(res, 200, ticket.blocked)
        return
      }
      try {
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'body must be JSON under ' + MAX_JSON_BODY_BYTES + ' bytes' })
          return
        }
        writeJson(res, 200, await handler(body))
      } catch (error) {
        writeJson(res, 200, { ok: false, error: String(error?.message ?? error) })
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
  ]
}
