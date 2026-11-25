/**
 * 控制面板的视图模型（纯函数，无 IO）。
 *
 * 宿主侧把实时状态（接管情况、最近一次裁剪体积、settings 里的 provider 表、
 * 在线探测结果）压成这份结构，client.js 只负责把它画出来。
 *
 * 这样面板逻辑可以在 node 里直接断言（test/panel.mjs），不用起浏览器。
 */

/**
 * 主机名判定：先解析出 hostname，再判它是不是「本机 / 内网」。
 *
 * 以前是拿一条正则直接 match 整串 URL（`^https?://(?:127\.0\.0\.1|localhost|…)`），
 * 两个方向都会错，而且错法不一样：
 *
 *   漏 —— `127.0.0.2`（127/8 整段回环）、`100.64.0.1`（CGNAT / Tailscale）、
 *   `[fd00::5]`（IPv6 ULA）、`macbook.local`（mDNS）、`gpu-box`（单标签主机名）
 *   一个都认不出来。后果是本地模型白跑：一点没裁，用户以为插件坏了。
 *
 *   误 —— `http://localhost.attacker.com/v1`、`http://localhost-evil.com/v1`、
 *   `http://127.0.0.1.attacker.com/v1` 这种「域名前缀碰巧叫 localhost」的公网地址
 *   会被当成本地，于是**云端请求被裁掉 78% 的提示词**。用户只看到「省了 78%」，
 *   完全不知道模型为什么突然不会用工具了 —— 这比漏判危险得多。
 *
 * 解析出 hostname 再判，两个方向同时修好。`new URL()` 还顺手处理了
 * `http://localhost@attacker.com/v1`（userinfo 后面才是真 host）。
 */
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'host.docker.internal',
  'host.containers.internal',
  'gateway.docker.internal',
  '0.0.0.0',
  '::',
  '::1',
])

/**
 * 私有 / 回环 / CGNAT IPv4：127/8、10/8、192.168/16、172.16-31/12、100.64/10、0/8。
 *
 * 刻意**不含** 169.254/16（链路本地 / APIPA）：那个网段是「DHCP 没拿到地址时自己
 * 编一个」用的，上面不会有人在跑推理服务。把它算成本地只会让一条本来就通不了的
 * 配置被判成「本地 provider」，于是提示词照样被裁 —— 帮不上任何忙，还掩盖了
 * 「这个地址根本没人监听」这个真正的问题。
 */
function isPrivateIPv4(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return false
  }
  const a = Number(parts[0])
  const b = Number(parts[1])
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * 把 IPv6 字面量展开成 8 个 16 位整数；解析不了返回 null。
 *
 * 为什么不直接正则：同一个地址有很多种合法写法，
 *   `::1` / `0:0:0:0:0:0:0:1`（前导零可省、可用 `::` 压缩）
 *   `::ffff:127.0.0.1` / `::ffff:7f00:1`（IPv4-mapped 的两种写法）
 *   `fc00::1` / `fc00:0:0:0:0:0:0:1`
 * 原来按前缀正则匹配，压缩形式和十六进制映射形式一律漏判 —— 漏判的后果是
 * 「本地模型一点没裁」，用户以为插件坏了。展开再按位判，写法不再影响结论。
 */
function parseIPv6(raw) {
  let host = String(raw ?? '').trim().toLowerCase()
  if (host.startsWith('[')) host = host.slice(1)
  if (host.endsWith(']')) host = host.slice(0, -1)
  if (host.length === 0 || !host.includes(':')) return null
  // 末尾嵌一段 IPv4（`::ffff:127.0.0.1`）：先换成两个十六进制组再统一处理。
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (v4 !== null) {
    const parts = v4[1].split('.').map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const hi = ((parts[0] << 8) | parts[1]).toString(16)
    const lo = ((parts[2] << 8) | parts[3]).toString(16)
    host = host.slice(0, v4.index) + hi + ':' + lo
  }
  const halves = host.split('::')
  if (halves.length > 2) return null
  const head = halves[0].length > 0 ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1].length > 0 ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (halves.length === 2 && fill < 0) return null
  const groups = [...head, ...Array(fill).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const out = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    out.push(parseInt(group, 16))
  }
  return out
}

/** 本地 IPv6：::1、ULA fc00::/7、链路本地 fe80::/10、IPv4-mapped 的私网地址。 */
function isLocalIPv6(host) {
  const groups = parseIPv6(host)
  if (groups === null) return false
  // 回环：全零只留最后一位 1；未指定地址全零。
  if (groups.every((n) => n === 0)) return true
  if (groups.slice(0, 7).every((n) => n === 0) && groups[7] === 1) return true
  // IPv4-mapped：::ffff:a.b.c.d，按内嵌的 IPv4 判。
  if (groups.slice(0, 5).every((n) => n === 0) && groups[5] === 0xffff) {
    const a = groups[6] >> 8
    const b = groups[6] & 0xff
    const c = groups[7] >> 8
    const d = groups[7] & 0xff
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`)
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((groups[0] & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
  return false
}

/**
 * 从 baseURL 里取 hostname：小写、去掉 IPv6 的方括号。
 * 解析不出来（空串、`127.0.0.1:11434` 这种没写 scheme 的、纯垃圾）返回空串 ——
 * 空串的语义是「不知道」，调用方该退回看 provider 名字，而不是猜一个。
 */
export function hostOf(baseURL) {
  const raw = String(baseURL ?? '').trim()
  if (raw.length === 0) return ''
  try {
    return String(new URL(raw).hostname ?? '')
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .toLowerCase()
  } catch {
    return ''
  }
}

/** 这个 hostname 是不是「本机或内网」。 */
export function looksLocalHost(host) {
  // [P2-02-2026-11-26] 末尾的点是「绝对域名」写法（`localhost.` 与 `localhost` 同一个名字），
  // 但 `URL` 只对 IPv4 做了归一（`127.0.0.1.` → `127.0.0.1`），主机名原样留着。
  // 不剥掉就会出现「同一类写法两种结论」：`127.0.0.1.:11434` 判本地、`localhost.:11434` 判公网，
  // 后者直接导致本地模型一点没裁。
  const value = String(host ?? '').trim().toLowerCase().replace(/\.+$/, '')
  if (value.length === 0) return false
  if (value.includes(':')) return isLocalIPv6(value)
  if (LOCAL_HOSTNAMES.has(value)) return true
  // RFC 6762 的 .local（mDNS）、ICANN 保留的 .internal、RFC 6761 的 .localhost
  if (value.endsWith('.local') || value.endsWith('.internal') || value.endsWith('.localhost')) return true
  if (isPrivateIPv4(value)) return true
  // 单标签主机名（一个点都没有）只能靠本地解析器 / 搜索域找到，公网 DNS 里不存在
  return !value.includes('.')
}

/** 这个 baseURL 是不是「本机或内网」。 */
export function looksLocalUrl(value) {
  return looksLocalHost(hostOf(value))
}

/**
 * provider 名里的本地标记（配置里没写 baseURL 时的兜底判断）。
 * 只放「任何一个装了本地推理栈的人都可能取的名字」，不放本机独有的名字。
 */
const LOCAL_NAME_PATTERN =
  /(?:^|[-_.])(?:local|ollama|llama|llama-?cpp|llamafile|vllm|mlx|lmstudio|lm-studio|localai|xinference|ktransformers|oobabooga|textgen|tabby|kobold|sglang|aphrodite|jan|exo)(?:$|[-_.])/i

/**
 * 这几个名字长得够长、彼此也不像，出现在 id 的任何位置都算本地标记 ——
 * `myvllm`、`house-ollama-server`、`servellamacpp` 都得认出来。
 * 短名字（`local` / `mlx` / `jan` / `exo` / `tabby`）留在上面的分隔符规则里：
 * `mylocal`、`external`、`janky` 那种词里藏着短标记的一律不算，误判在这边代价更大。
 */
const LOCAL_NAME_CONTAINS = [
  'ollama',
  'llamacpp',
  'llama.cpp',
  'llamafile',
  'vllm',
  'lmstudio',
  'localai',
  'xinference',
  'ktransformers',
  'oobabooga',
  'textgen',
  'sglang',
  'aphrodite',
]

/** 名字里带本地标记。 */
export function looksLocalName(provider) {
  const id = String(provider ?? '').trim()
  if (id.length === 0) return false
  if (LOCAL_NAME_PATTERN.test(id)) return true
  const compact = id.toLowerCase().replace(/[\s_-]+/g, '')
  return LOCAL_NAME_CONTAINS.some((marker) => compact.includes(marker.replace(/[.]/g, '')))
}

/**
 * 这个 provider 是不是本地端点。
 *
 * 有地址就以地址为准 —— 名字只用来兜底。原因是名字匹配会误伤：
 * 云端 provider 叫 `openrouter-llama-3`、`together-llama` 的不少，
 * 按名字算本地就会把公网请求裁掉。地址能解析出来的时候，它比名字可信。
 */
export function isLocalProvider(id, baseURL) {
  const host = hostOf(baseURL)
  if (host.length > 0) return looksLocalHost(host)
  return looksLocalName(id)
}

/**
 * 自适应单位。模型动辄十几 GB，但也真有 300MB 的小模型 ——
 * 一律按 GB 保留一位小数会显示成「0.3GB」甚至「0.0GB」，看着像出错。
 */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '?'
  // 每一档都先取整再判档：1048576 - 1 字节除以 1024 四舍五入就是 1024，
  // 直接拼单位会显示成「1024KB」—— 用户一眼以为单位算错了。
  const kb = Math.round(value / 1024)
  // 1 字节到 512 字节四舍五入成 0KB，看起来像「没有体积」。小到整数 KB 会归零时
  // 说成「<1KB」，比一个假的 0 诚实。
  if (kb === 0) return '<1KB'
  if (kb < 1024) return kb + 'KB'
  const mb = Math.round(value / 1048576)
  if (mb < 1024) return mb + 'MB'
  const gb = Math.round(value / 1073741824)
  // 上来就 toFixed(1) 会在 1023.97GB 这种边界上显示成「1024.0GB」；
  // 先取整判档，超过 1024 就换 TB，和上面两档同一个写法。
  if (gb < 1024) return (value / 1073741824).toFixed(1) + 'GB'
  return (value / 1099511627776).toFixed(2) + 'TB'
}
/** 千分位，面板上可读性全靠它。 */
export function formatCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString('en-US')
}

/**
 * 「这一轮一个字都没裁」到底为什么。
 *
 * 三种原因指向三种完全不同的处置，混成一句「未裁剪」等于没给线索：
 *   provider-not-local  这次装配走的 provider 不在路由名单里 —— 云端或没认出来的
 *                       provider 原样放行，这是**设计如此**，不用修
 *   route-excluded      地址/名字看着就是本地，但配置把自动识别关掉了（routes 写了
 *                       别的名字，或 autoDetectBaseURL: false）—— 去把 routes 留空
 *   no-provider         这次装配根本没拿到 provider 名（在选择器之外被调用）——
 *                       调 providerOf 那条路查
 *   nothing-matched     确实是本地 provider，但没有任何一段 / 一个 context 命中
 *                       名单 —— 段名随插件升级会变，该去看 dropSections
 *   trim-disabled       配置里 promptTrim 被关掉了
 *   no-sections         这次装配没有 sections 数组（宿主还没走到装配这一步）
 */
function noTrimLabel(reason, provider, charsIn, local) {
  const who = provider.length > 0 ? `provider "${provider}"` : '这次请求'
  if (reason === 'provider-not-local') {
    return `${who} 不在裁剪路由里（云端或未识别的 provider 原样放行）`
  }
  if (reason === 'route-excluded') {
    return `${who} 看着是本地端点，但配置把自动识别关掉了（routes 写了别的名字，或 autoDetectBaseURL = false）—— 把 routes 留空就按地址自动认`
  }
  if (reason === 'no-provider') {
    return '这次装配没拿到 provider 名，已按原样放行'
  }
  if (reason === 'nothing-matched') {
    return `${who} 是本地 provider，但没有段落命中 dropSections（段名可能已随插件升级失效）`
  }
  if (reason === 'trim-disabled') {
    return '提示词裁剪是关的（配置里 promptTrim = false），这次装配原样放行'
  }
  if (reason === 'no-sections') {
    return '这次装配没有 sections 可裁，原样放行'
  }
  // [label-source] 兜底那句不能只说「未裁剪」—— 它得解释「为什么该裁却没裁」。
  // reason 为空但长度没变，只有两种可能：这条 provider 压根不该裁（云端），
  // 或者裁了但装配本来就是最小形态。原来两种都显示成同一句「N 字符，未裁剪」，
  // 与同一个函数里 `local` 字段的判断完全不同源，用户读不出该不该管。
  return local
    ? `${who} 是本地 provider，这次装配裁过一遍但长度没变（段落本身已经是最小形态）`
    : `${who} 未裁剪：${formatCount(charsIn)} 字符原样放行（这次没记下原因）`
}

/**
 * 裁剪收益。
 * `trim = { charsIn, charsOut, sectionsIn, sectionsOut, at, provider, local, reason }`
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
  // [saved-negative] 装配变长是可能的（注入段被补上 head/tail、或 dropSections 把两段
  // 合成一段却多出分隔符）。原来直接算 (saved/charsIn)*100 会得负数，
  // 面板的进度条把它钳成 0，于是「省了 -12%」既不显示也没有任何提示 ——
  // 一次真正的回归（裁剪反而变长）在面板上等于隐身。负数保留下来由 label 说清楚。
  const savedPct = Math.round((saved / charsIn) * 1000) / 10
  // 排障用：记录这次装配被判定成哪个 provider。面板的 label 只说「不在路由里」，
  // 但不说是谁，等于没有线索；带上名字就能直接看出是 provider 取错还是路由没配。
  const provider = typeof trim.provider === 'string' ? trim.provider : ''
  const reason = typeof trim.reason === 'string' ? trim.reason : ''
  // local 先算出来，label 与返回值的 local 用同一个来源 —— 不然会出现
  // 「文案说这是云端、local 字段却是 true」这种自相矛盾的一对。
  const local = trim.local === true
  const label =
    saved > 0
      ? `${formatCount(charsIn)} → ${formatCount(charsOut)} 字符（省 ${savedPct}%）`
      : saved < 0
        ? `${formatCount(charsIn)} → ${formatCount(charsOut)} 字符（比原来多 ${formatCount(-saved)}，裁剪没收益 —— 值得查一下 dropSections 是不是把两段合成了一段）`
        : noTrimLabel(reason, provider, charsIn, local)
  return {
    seen: true,
    label,
    savedPct,
    charsIn,
    charsOut,
    savedChars: saved,
    provider,
    // 面板据此决定要不要在「未裁剪」旁边补一句「这是正常的」
    local,
    reason,
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
      ? '接管 prompt.assemble（内层访问器的 slot 已转发）'
      : via === 'accessor'
        ? '接管 prompt.assemble（叠在既有访问器外层）'
        : via === 'already'
          ? '接管已生效'
          : '接管原生 prompt.assemble'
  return { active: true, tone: 'good', via, label: viaLabel }
}

/**
 * client 半边的宿存在性。
 *
 * 面板挂在 `plugins.detail.section` 槽位上，那个槽位由
 * `@deepseek-ai/dsh-client-ui-plugin-manager` 声明，而它只随
 * `@deepseek-ai/dsh-web-app` 一起装。所以：
 *
 *   web profile     → 有宿主，面板能出现
 *   headless/sdk/acp → 没有宿主，面板不会出现（裁剪照常生效）
 *
 * 这是**环境差异**，不是故障。分清楚才能让用户知道「该去换 profile」还是
 * 「该去修插件」。
 */
export function summarizeClientHost(clientHost) {
  const state = String(clientHost?.state ?? 'unknown')
  const detail = String(clientHost?.detail ?? '')
  if (state === 'ready') {
    return { state, tone: 'good', label: '面板可用（client 半边有宿主）', detail }
  }
  if (state === 'missing') {
    return {
      state,
      tone: 'muted',
      label: '面板不可用（这个 profile 没有 client 宿主，裁剪照常生效）',
      detail,
    }
  }
  return {
    state: 'unknown',
    tone: 'muted',
    label: '面板宿存情况未知（还没探测到）',
    detail,
  }
}

/**
 * 后端报回来的模型条目 → id 字符串。
 * 探测层给的是 `{id, contextWindow}`，手工传的可能是裸字符串，两种都认。
 */
function normalizeLiveModel(model) {
  if (typeof model === 'string') return model.trim()
  return String(model?.id ?? '').trim()
}

/**
 * `nomic-embed-text` 和 `nomic-embed-text:latest` 是同一条。
 *
 * Ollama 的 `/api/tags` 永远给带 tag 的全名，而用户写配置时经常省掉 `:latest`；
 * 不归一化的话每一条都会被判成「已不在后端」，全表飘红 —— 比不报还糟。
 */
function withLatest(id) {
  const value = String(id ?? '').trim().toLowerCase()
  if (value.length === 0) return value
  // 带路径或已经带 tag 的原样返回：`models/qwen.gguf` 是 llama.cpp 的文件式 id，
  // 给它补 `:latest` 只会误伤。
  if (value.includes('/') || value.includes('\\') || value.includes(':')) return value
  return value + ':latest'
}

/**
 * 两个模型 id 是不是同一条。
 *
 * 导出是因为「对齐」要跟面板用同一套判据：面板说「这两个不在了」，
 * 对齐动作就必须摘掉同样这两条，不能一边告警一边不动。
 */
export function sameModel(a, b) {
  const left = String(a ?? '').trim()
  const right = String(b ?? '').trim()
  if (left === right) return true
  if (left.length === 0 || right.length === 0) return false
  return withLatest(left) === withLatest(right)
}

/**
 * 「声明 N 个 / 实际 M 个」怎么讲给用户听。
 *
 * 三种处置完全不同，所以分三种话：
 *   全不在   → 这条 provider 该删了（bad）
 *   部分不在 → 这条配置该改（warn）
 *   全都在   → 什么都不说（tone undefined）
 * 顺带提「后端还有几个没注册」，那是下一步可以导入的候选，不是错误。
 */
function summarizeModels({ declared, live, liveCount, missing, extra }) {
  if (liveCount === undefined) {
    return {
      declared: declared.length,
      live: undefined,
      missing: [],
      extra: [],
      tone: undefined,
      // 「不知道」不能长得像「都对上了」：面板上原本就只是「N 模型」，用户分不清
      // 这是核对过的结果还是压根没核对。补一句，且不上色（这不是错误）。
      label: `${declared.length} 模型` + (declared.length > 0 ? ' · 没核对（后端没回清单）' : ''),
    }
  }
  if (missing.length === 0) {
    // 声明全都还在，但后端多出了几个没注册的 —— 这不是错，是「可以再导入一个」的提示，
    // 所以不上色，只在文案里提一句。不提的话用户永远不知道后端还躺着一个能用的模型。
    return {
      declared: declared.length,
      live: liveCount,
      missing: [],
      extra,
      tone: undefined,
      label: `${liveCount} 模型` + (extra.length > 0 ? ` · 后端还有 ${extra.length} 个没注册` : ''),
    }
  }
  const allDead = missing.length === declared.length
  return {
    declared: declared.length,
    live: liveCount,
    missing,
    extra,
    tone: allDead ? 'bad' : 'warn',
    label:
      `${liveCount} 模型` +
      (extra.length > 0 ? ` · 后端还有 ${extra.length} 个没注册` : '') +
      (allDead ? ` · 配置里的 ${declared.length} 个全不在了` : ` · ${missing.length} 个已不在后端`),
  }
}

/**
 * 「这套配置还是旧版本的默认值」怎么讲给用户听。
 *
 * 为什么需要这一条：插件升级会改默认白名单，但配置字段一旦写进 profile 的
 * cordis.patch.yml 就永久留着 —— 插件读到的是「用户显式配的 N 个工具」，
 * 分不清那是用户真想要的、还是上一版默认值被固化下来的。于是新默认值对
 * 老用户永远不生效，而且没有任何地方会说这件事。
 *
 * 三种字段各自可能命中，也可能都没命中（用户自己改过、或本来就干净）。
 * 都不命中时返回 null，面板不多说一个字。
 */
export function summarizeLegacy(legacy) {
  const fields = ['keep', 'dropSections', 'dropContexts']
  const hits = []
  for (const field of fields) {
    const hit = legacy?.[field]
    if (hit === null || typeof hit !== 'object') continue
    const added = Array.isArray(hit.added) ? hit.added : []
    const dropped = Array.isArray(hit.dropped) ? hit.dropped : []
    const removed = Array.isArray(hit.removed) ? hit.removed : []
    if (added.length === 0 && dropped.length === 0) continue
    hits.push({ field, version: String(hit.version ?? ''), added, dropped, removed })
  }
  if (hits.length === 0) return null
  const versions = [...new Set(hits.map((hit) => hit.version).filter((value) => value.length > 0))]
  const detail = hits
    .map((hit) => {
      const parts = []
      if (hit.added.length > 0) parts.push(`补上 ${hit.added.join(', ')}`)
      if (hit.dropped.length > 0) parts.push(`丢掉 ${hit.dropped.join(', ')}`)
      if (hit.removed.length > 0) parts.push(`你删过的 ${hit.removed.join(', ')} 保持不恢复`)
      return `${hit.field}：${parts.join('；')}`
    })
    .join('\n')
  return {
    tone: 'warn',
    version: versions.join(' / '),
    fields: hits.map((hit) => hit.field),
    // 短标签给状态带用，长 detail 给 title 用 —— 状态带宽度有限，塞不下整串工具名。
    label: `配置是${versions.length > 0 ? ' ' + versions.join(' / ') + ' ' : '旧版本'}的默认值，已按当前默认值解释`,
    detail:
      detail +
      '\n\n这只是「读的时候按新默认值算」，配置文件本身没动。' +
      '\n想固化下来：点保存。想保留原来的：直接编辑上面那两个框。',
  }
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
 *   credentials?: Record<string, {ref?: string, configured?: boolean}>,
 *   revision?: number,
 *   writable?: boolean,
 *   logPath?: string,
 *   clientHost?: {state?: string, detail?: string},
 *   legacy?: {keep?: object | null, dropSections?: object | null, dropContexts?: object | null},
 * }} input
 */
export function buildPanelStatus(input = {}) {
  const values = input.values ?? {}
  const takeover = summarizeTakeover(input.takeover, values)
  const trim = summarizeTrim(input.trim ?? null)
  const provision = input.provision ?? {}
  const online = input.online ?? {}
  const credentials = input.credentials ?? {}

  const rows = (Array.isArray(input.providers) ? input.providers : []).map((entry) => {
    const id = String(entry?.id ?? '')
    const profile = entry?.profile ?? {}
    const models = Array.isArray(profile.models) ? profile.models : []
    const local = isLocalProvider(id, profile.baseURL)
    const check = online[id]
    // 配置里声明了哪些模型 ≠ 后端此刻真的有这些模型。
    // 后端答了 200 只证明「端口活着」，Ollama 对不存在的模型名也照样列自己的清单；
    // 用户 `ollama rm` 删掉权重之后，cordis.patch.yml 里那条 `- id: qwen3:14b`
    // 没有任何东西会去清，于是面板一直显示「5 模型」—— 一屏僵尸。
    // 探测时顺手拿回来的 id 清单放在这里求差，把「声明」和「实况」分开报。
    const declared = models.map((model) => String(model?.id ?? '')).filter((value) => value.length > 0)
    const live =
      check?.ok === true && Array.isArray(check.models)
        ? check.models.map(normalizeLiveModel).filter((id) => id.length > 0)
        : undefined
    // 两边都用 sameModel 比：`nomic-embed-text` 与 `nomic-embed-text:latest` 是同一条。
    // 用 Set.has 精确匹配会让「配置省了 :latest」的每一条都误判成已删除。
    const missing = live === undefined ? [] : declared.filter((value) => !live.some((id) => sameModel(id, value)))
    const extra = live === undefined ? [] : live.filter((value) => !declared.some((id) => sameModel(id, value)))
    // 计数按去重后的实况算，别把后端重复报回来的同一条算两次。
    const liveCount = live === undefined ? undefined : new Set(live.map(withLatest)).size
    // 「在线」说的是这个 provider 能不能用，不是端口能不能 ping 通。
    // 端口活着但配置里的模型后端一个都没有 —— 点进去每个模型都是 404，
    // 这时候还挂个绿点就是在骗人。live 未知（探测没回清单）时不降级：
    // 「不知道」不等于「没有」，那种情况保持原来的「在线」。
    const state =
      check === undefined
        ? { tone: 'muted', label: '未检测' }
        : check.ok !== true
          ? { tone: 'bad', label: '连不上' + (check.error && check.error !== '连不上' ? `：${check.error}` : '') }
          : (() => {
              const ms = Number.isFinite(check.ms) ? ` · ${Math.round(check.ms)}ms` : ''
              // [live-unknown] 200 只证明端口活着；后端没回模型清单（LM Studio 关掉了
              // /v1/models、或返回体不是预期形状）时无法核对「配置里的模型还在不在」。
              // 原来直接显示「在线」—— 与「核对过、全都在」长得一模一样，用户以为对过账了。
              // 仍然算在线（端口确实通），但把「没核对」这件事说出来。
              if (live === undefined) {
                return { tone: 'good', label: `在线${ms}` + (declared.length > 0 ? ' · 后端没回模型清单，没核对' : '') }
              }
              if (missing.length === 0) return { tone: 'good', label: `在线${ms}` }
              if (declared.length > 0 && missing.length === declared.length) {
                return { tone: 'bad', label: `端口通，但配置里的 ${declared.length} 个模型后端全没有${ms}` }
              }
              return { tone: 'warn', label: `在线${ms} · ${missing.length} 个模型不在后端` }
            })()
    const modelsView = summarizeModels({ declared, live, liveCount, missing, extra })
    // 凭据只是「声明了却解析不到」时才值得说：那种情况下宿主的 listModels 会返回空数组，
    // 模型目录按空组过滤，用户在模型选择器里看到的就是「这个 provider 不存在」。
    // 没声明 apiKeyEnv 的 provider（绝大多数本地端点）不显示这一行。
    const credentialInfo = credentials[id]
    const credential =
      credentialInfo === undefined
        ? undefined
        : credentialInfo.configured === true
          ? { ref: credentialInfo.ref, configured: true, tone: 'muted', label: `凭据 ${credentialInfo.ref} 已配置` }
          : {
              ref: credentialInfo.ref,
              configured: credentialInfo.configured === false ? false : undefined,
              tone: 'warn',
              label: `凭据 ${credentialInfo.ref} 没有值 —— 模型选择器里会看不到这个 provider`,
            }
    return {
      id,
      local,
      displayName: String(profile.displayName ?? id),
      baseURL: String(profile.baseURL ?? ''),
      modelCount: models.length,
      modelIds: declared,
      liveModelCount: liveCount,
      missingModels: missing,
      extraModels: extra,
      models: modelsView,
      credential,
      // 优先 profile 上声明的那两个默认值：一条 provider 的 N 个模型各有各的窗口，
      // 拿 models[0] 代表整条 provider 只在「只有一条模型」时才成立。profile 没写
      // defaultContextWindow 时才退回第一条模型（老配置就长这样）。
      contextWindow: Number(profile.defaultContextWindow) > 0 ? Number(profile.defaultContextWindow) : Number(models[0]?.contextWindow) || 0,
      maxTokens: Number(profile.defaultMaxTokens) > 0 ? Number(profile.defaultMaxTokens) : Number(models[0]?.maxTokens) || 0,
      state,
    }
  })

  const localRows = rows.filter((row) => row.local)
  return {
    takeover,
    trim,
    // 面板有没有宿主，跟裁剪有没有生效是两件事，分开报。
    client: summarizeClientHost(input.clientHost),
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
      // 表头这个「在线」跟行里的徽章同一套判据：端口活着但配置里的模型后端一个
      // 都没有的不算在线（那种 provider 点进去每个模型都 404）。
      // 统计范围也跟 stale / staleModels 对齐，都对**整张表**数 —— 原来 online 只数
      // 本地那几行、stale 数全表，两个数字摆在同一行里，看起来像在互相矛盾。
      online: rows.filter((row) => row.state.tone === 'good' || row.state.tone === 'warn').length,
      // 「有 3 条 provider 的配置跟后端对不上」—— 表头的汇总数字，
      // 用户不用逐行读就知道这个面板值不值得往下看。
      stale: rows.filter((row) => row.missingModels.length > 0).length,
      // 配置里声明了、后端已经没有的模型条目总数（这就是「旧模型」的总量）。
      staleModels: rows.reduce((sum, row) => sum + row.missingModels.length, 0),
    },
    // 配置里那三个集合如果还是旧版本默认值，说一句 —— 否则用户永远不知道
    // 新版本的默认值对自己不生效（字段写进 profile 就被当成「用户显式配置」）。
    legacy: summarizeLegacy(input.legacy),
    revision: Number.isInteger(input.revision) ? input.revision : undefined,
    writable: input.writable !== false,
    logPath: String(input.logPath ?? ''),
  }
}
