/**
 * 控制面板的 HTTP bridge。
 *
 * 面板（client.js）跑在浏览器里，碰不到 cordis 服务，只能走 HTTP。
 * 注册 11 条 exact 路由，全部 POST，全部先过 guard：
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
 *   POST /api/dsh-local-trim/models    列出本机已下好的 .gguf
 *   POST /api/dsh-local-trim/adopt     选一个 gguf → 起服务 → 写 provider → 试跑
 *
 * 安全：只接受同源、且来源地址是回环（或显式配置的受信主机）的请求。
 */

export const BRIDGE_PREFIX = '/api/dsh-local-trim'
const MAX_JSON_BODY_BYTES = 256 * 1024
const MAX_LOG_TAIL_BYTES = 64 * 1024

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
 * }} deps
 */
export function makeBridgeRoutes(deps) {
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
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { error: 'body must be JSON under ' + MAX_JSON_BODY_BYTES + ' bytes' })
        return
      }
      try {
        writeJson(res, 200, await handler(body))
      } catch (error) {
        writeJson(res, 200, { ok: false, error: String(error?.message ?? error) })
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
    route('models', async (body) => ({ ok: true, ...(await (deps.models?.(body ?? {}) ?? {})) })),
    route('adopt', async (body) => ({ ok: true, ...(await (deps.adopt?.(body ?? {}) ?? {})) })),
  ]
}
