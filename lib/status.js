/**
 * 控制面板的视图模型（纯函数，无 IO）。
 *
 * 宿主侧把实时状态（接管情况、最近一次裁剪体积、settings 里的 provider 表、
 * 在线探测结果）压成这份结构，client.js 只负责把它画出来。
 *
 * 这样面板逻辑可以在 node 里直接断言（test/panel.mjs），不用起浏览器。
 */

const LOCAL_HOST_PATTERN =
  /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|host\.docker\.internal|10\.\d|192\.168\.\d|172\.(?:1[6-9]|2\d|3[01])\.)/i

const LOCAL_NAME_PATTERN =
  /(?:^|[-_])(?:local|ollama|llama|vllm|lmstudio|lm-studio|tgw|kobold|sglang|tabby|jan)(?:$|[-_])/i

/** 这个 provider 是不是本地端点（回环/私有网段，或名字带本地标记）。 */
export function isLocalProvider(id, baseURL) {
  if (typeof baseURL === 'string' && baseURL.trim().length > 0 && LOCAL_HOST_PATTERN.test(baseURL.trim())) return true
  const name = String(id ?? '')
  return name.length > 0 && (LOCAL_NAME_PATTERN.test(name) || /^ollama/i.test(name))
}

/** 千分位，面板上可读性全靠它。 */
export function formatCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString('en-US')
}

/**
 * 裁剪收益。`trim = { charsIn, charsOut, sectionsIn, sectionsOut, at }`
 * 一次都没裁剪过时传 null。
 */
export function summarizeTrim(trim) {
  if (trim === null || trim === undefined) {
    return { seen: false, label: '还没有裁剪记录', savedPct: 0, charsIn: 0, charsOut: 0 }
  }
  const charsIn = Number(trim.charsIn) || 0
  const charsOut = Number(trim.charsOut) || 0
  if (charsIn <= 0) {
    return { seen: true, label: '上次请求没有系统提示词可裁', savedPct: 0, charsIn, charsOut }
  }
  const saved = charsIn - charsOut
  const savedPct = Math.round((saved / charsIn) * 1000) / 10
  const label =
    saved > 0
      ? `${formatCount(charsIn)} → ${formatCount(charsOut)} 字符（省 ${savedPct}%）`
      : `${formatCount(charsIn)} 字符，未裁剪（这条 provider 不在路由里，或云端放行）`
  return {
    seen: true,
    label,
    savedPct,
    charsIn,
    charsOut,
    savedChars: saved,
    sectionsIn: Number(trim.sectionsIn) || 0,
    sectionsOut: Number(trim.sectionsOut) || 0,
    at: Number(trim.at) || 0,
  }
}

/** 接管状态：ok/via 决定灯的颜色。 */
export function summarizeTakeover(takeover, values) {
  const ok = takeover?.ok === true
  const via = String(takeover?.via ?? 'none')
  const enabled = values?.enabled !== false
  if (!enabled) {
    return { active: false, tone: 'muted', via, label: '裁剪已关闭（配置里 enabled = false）' }
  }
  if (!ok) {
    return {
      active: false,
      tone: 'bad',
      via,
      label: '没有接管 prompt.assemble' + (takeover?.reason ? `：${takeover.reason}` : ''),
    }
  }
  const viaLabel =
    via === 'accessor+purge-slot'
      ? '接管 prompt.assemble（dsh-purge 的 slot 一起转发）'
      : via === 'accessor'
        ? '接管 prompt.assemble（叠在既有访问器外层）'
        : via === 'already'
          ? '接管已生效'
          : '接管原生 prompt.assemble'
  return { active: true, tone: 'good', via, label: viaLabel }
}

/**
 * 面板主视图。
 * @param {{
 *   takeover?: {ok?: boolean, via?: string, reason?: string},
 *   values?: object,
 *   trim?: object | null,
 *   lightBody?: {chars?: number, source?: string},
 *   provision?: {status?: string, provider?: string, detail?: string},
 *   providers?: Array<{id: string, profile: object}>,
 *   online?: Record<string, {ok?: boolean, ms?: number, error?: string}>,
 *   revision?: number,
 *   writable?: boolean,
 *   logPath?: string,
 * }} input
 */
export function buildPanelStatus(input = {}) {
  const values = input.values ?? {}
  const takeover = summarizeTakeover(input.takeover, values)
  const trim = summarizeTrim(input.trim ?? null)
  const provision = input.provision ?? {}
  const online = input.online ?? {}

  const rows = (Array.isArray(input.providers) ? input.providers : []).map((entry) => {
    const id = String(entry?.id ?? '')
    const profile = entry?.profile ?? {}
    const models = Array.isArray(profile.models) ? profile.models : []
    const local = isLocalProvider(id, profile.baseURL)
    const check = online[id]
    const state =
      check === undefined
        ? { tone: 'muted', label: '未检测' }
        : check.ok === true
          ? { tone: 'good', label: `在线${Number.isFinite(check.ms) ? ` · ${Math.round(check.ms)}ms` : ''}` }
          : { tone: 'bad', label: '连不上' + (check.error ? `：${check.error}` : '') }
    return {
      id,
      local,
      displayName: String(profile.displayName ?? id),
      baseURL: String(profile.baseURL ?? ''),
      modelCount: models.length,
      modelIds: models.map((model) => String(model?.id ?? '')).filter((value) => value.length > 0),
      contextWindow: Number(models[0]?.contextWindow) || 0,
      maxTokens: Number(models[0]?.maxTokens) || 0,
      state,
    }
  })

  const localRows = rows.filter((row) => row.local)
  return {
    takeover,
    trim,
    inject: {
      chars: Number(input.lightBody?.chars) || 0,
      source: String(input.lightBody?.source ?? 'unknown'),
      label: `${formatCount(input.lightBody?.chars ?? 0)} 字符 · ${String(input.lightBody?.source ?? 'unknown')}`,
    },
    provision: {
      status: String(provision.status ?? 'unknown'),
      provider: String(provision.provider ?? ''),
      detail: String(provision.detail ?? ''),
      tone: provision.status === 'failed' ? 'bad' : provision.status === 'disabled' ? 'muted' : 'good',
    },
    flags: {
      promptTrim: values.promptTrim !== false,
      schemaTrim: values.schemaTrim !== false,
      debugWrap: values.debugWrap === true,
    },
    providers: rows,
    counts: {
      total: rows.length,
      local: localRows.length,
      online: localRows.filter((row) => online[row.id]?.ok === true).length,
    },
    revision: Number.isInteger(input.revision) ? input.revision : undefined,
    writable: input.writable !== false,
    logPath: String(input.logPath ?? ''),
  }
}
