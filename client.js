/**
 * dsh-local-trim 控制面板（client 半边）。
 *
 * 挂在插件详情页的 `plugins.detail.section` 槽位上：在 DSH Web 的
 * 「插件」列表里点开 dsh-local-trim，详情页底部就是这块面板。
 *
 * 浏览器里拿不到 cordis 服务，所有读写都走宿主侧注册的 HTTP bridge（15 条，全部 POST）：
 *   status   接管状态 + 裁剪收益 + provider 表 + 本插件起过的后端（主视图）
 *   check    给 provider 点灯（GET /v1/models），顺带把后端此刻真的有的模型 id 带回来
 *   probe    批量探测默认端口
 *   import   导入本地模型：探测 → 写 settings → 试跑（同一后端会复用已有 provider）
 *   test     对已注册 provider 发一次最小真实请求
 *   align    把一条 provider 的 models 对齐到后端此刻真的有的那份
 *   reconcile 对账：后端已经没有的模型摘掉，全没了就删这条 provider（只做减法）
 *   save     写回高级配置
 *   describe 老宿主的兼容读取（没有 status 时降级用）
 *   log      读日志尾部
 *   models   扫本机模型：.gguf + Ollama 存储里的权重（带每个模型的资源预检）
 *   adopt    一键配置：起服务 → 等应答 → 注册 provider → 试跑
 *   launch   对已有 provider 拉起后端
 *   stop     只停本插件自己 spawn 的那个 pid
 *   delete   删 provider 配置（不删磁盘上的 gguf）
 *
 * 版面顺序按「一眼看状态 → 想动手时再动手」排：
 *   状态带 → 收益条 → provider 表（点灯/试跑/拉起/停止/对齐/删除）→ 本机模型一键配置
 *   → 端点导入 → 折叠的高级配置。
 *
 * provider 表那两列数字要分清：
 *   「N 模型」里的 N 是**面板读到的实况**（`/v1/models` 说有几个），不是配置里写了几条。
 *   配置里声明了、后端已经没有的，单独用「· N 个已不在后端」标出来并给一个「对齐」按钮 ——
 *   面板不会自己改配置，改配置必须由人点一下。
 *
 * 文案只有中文。这是有意选择：插件面向中文使用者，硬塞一套英文会多出一半
 * 需要同步的字符串，却没有第二个读者。要加语言时，把这里的字面量搬进
 * 一个 `const TEXT = { zh: {...} }` 就行，位置都在本文件内。
 */

const PANEL_MODULE = {
  id: 'dsh-local-trim',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BRIDGE = '/api/dsh-local-trim'
    const PACKAGE_NAME = 'dsh-local-trim'

    // [P1-25-2026-11-25] fetch 没有默认超时。宿主侧路由挂住时（llama-server 起来了
    // 但永不 accept、端口被防火墙吞掉、后端进程卡死），这个 Promise 永远不 settle，
    // busy 栈里那一项也就永远不 pop —— 面板从此整块变灰，只能重启 DSH 才好。
    // 重活给 10 分钟（拉模型、等端口应答本来就慢），其余 30 秒。
    // 名单与 lib/bridge.js 的 HEAVY_ROUTES 保持一致，那边改这里也要改。
    const HEAVY_CALLS = new Set([
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
    const HEAVY_TIMEOUT_MS = 10 * 60 * 1000
    const LIGHT_TIMEOUT_MS = 30 * 1000

    async function call(name, body) {
      const limitMs = HEAVY_CALLS.has(name) ? HEAVY_TIMEOUT_MS : LIGHT_TIMEOUT_MS
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), limitMs)
      try {
        const response = await fetch(BRIDGE + '/' + name, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
          ...(controller === null ? {} : { signal: controller.signal }),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) {
          // [throttle-tag] 429 不是失败，是「上一次还在跑 / 刚跑过」。
          // 只把 message 抛出去的话，调用方 catch 里一律渲染成「拉起失败：…」，
          // 用户以为后端起不来，其实什么都没坏，等一会儿再点就行。
          // 把状态码与节流原因挂在 Error 上，渲染处据此换说法。
          const error = new Error(payload?.error ?? 'HTTP ' + response.status)
          error.status = response.status
          error.throttled = typeof payload?.throttled === 'string' ? payload.throttled : undefined
          error.retryInMs = Number(payload?.retryInMs) || undefined
          throw error
        }
        return payload
      } catch (error) {
        // abort 之后 fetch 抛的是 AbortError（名字就叫 AbortError），跟「服务端拒绝」
        // 长得不一样。转成一句人话并打上 timeout 标记，调用方不必自己分辨。
        if (error?.name === 'AbortError' || controller?.signal?.aborted === true) {
          const timeout = new Error(
            `${name} 这条请求 ${Math.round(limitMs / 1000)} 秒没有回应，已放弃等待` +
              '（后端可能起了但没应答；重活可再点一次，别连点）',
          )
          timeout.timeout = true
          throw timeout
        }
        throw error
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    /** 节流拒绝的人话。不是失败，所以不能拼「失败：」前缀。 */
    function throttleNote(error) {
      if (error?.status !== 429) return ''
      const wait = Number(error?.retryInMs) > 0 ? Math.ceil(Number(error.retryInMs) / 100) / 10 + ' 秒后' : '稍等一会儿'
      return error?.throttled === 'inflight'
        ? `上一次还在跑，这次没发出去（${wait}再点一次）`
        : `刚跑过一次，${wait}再点一次`
    }

    /**
     * 一条动作结果的文案。
     *
     * [P1-22-2026-11-25] 拉起和停止共用一个结果状态（launchResult），原来渲染处只按
     * `ok` 分两支：停止成功后走的是「已拉起 X（pid N），Nms 后端口 N 应答」——
     * 用户点了「停止」，屏幕回一句「已拉起」，会以为自己点反了、再点一次拉起。
     * 结果对象现在带 action（launch / stop），文案按 action 分。
     */
    function actionResultText(result) {
      if (result === null || result === undefined) return ''
      const stop = result.action === 'stop'
      if (result.ok !== true) {
        // 节流拒绝既不是成功也不是失败：调用方已经把它翻成人话塞进 error 了。
        if (result.throttled === true) return String(result.error ?? '')
        return (stop ? '停止失败：' : '拉起失败：') + String(result.error ?? '不知道原因') +
          (Array.isArray(result.tried) && result.tried.length > 0
            ? '（找过：' + result.tried.join(' / ') + '）'
            : '')
      }
      if (stop) {
        if (result.already === true) {
          return `端口 ${result.port} 上那个进程早就不在了，没什么可停`
        }
        // stopPanel 成功时一定带 message（「已停掉 X（pid N）」）。
        return String(result.message ?? `已停掉端口 ${result.port} 上的后端`)
      }
      if (result.already === true) return String(result.message ?? `端口 ${result.port} 本来就在跑，跳过拉起`)
      return (
        `已拉起 ${result.label}（pid ${result.pid}），${result.ms}ms 后端口 ${result.port} 应答` +
        (Array.isArray(result.models) && result.models.length > 0 ? '：' + result.models.join(', ') : '') +
        // 参数被裁或走了老引擎那套，要在这里说清楚 —— 否则用户以为插件漏拼了
        (Array.isArray(result.dropped) && result.dropped.length > 0
          ? '（你的 llama.cpp 不认 ' + result.dropped.join(' / ') + '，已跳过）'
          : '') +
        (result.modernEngine === false ? '（老版本引擎：分层数用 99，不下发 KV 量化）' : '')
      )
    }

    // ── 样式：全部内联，不依赖宿主的 CSS 变量（读不到时用兜底值） ──────────
    const BORDER = '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.16))'
    const MUTED = 'var(--dsw-alias-label-secondary, #666)'
    const RED = '#c0392b'
    const TONE = {
      good: '#1e8449',
      warn: '#b9770e',
      bad: '#c0392b',
      muted: '#8a8a8a',
    }
    const S = {
      card: {
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))',
        borderRadius: 10,
        padding: '14px 16px',
        marginTop: 12,
        fontSize: 13,
        lineHeight: 1.6,
      },
      title: { fontSize: 14, fontWeight: 600, margin: '14px 0 6px' },
      row: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' },
      label: { flex: '0 0 140px', color: MUTED },
      // 小徽标：标出这一行来自哪个引擎（Ollama / llama.cpp），一眼能分辨。
      tag: {
        flexShrink: 0,
        fontSize: 11,
        lineHeight: 1.4,
        padding: '0 6px',
        borderRadius: 999,
        border: BORDER,
        color: MUTED,
      },
      grow: { flex: 1, minWidth: 0 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 8px',
        fontSize: 13,
        fontFamily: 'inherit',
        border: BORDER,
        borderRadius: 6,
        background: 'transparent',
        color: 'inherit',
      },
      select: {
        padding: '5px 8px',
        fontSize: 13,
        fontFamily: 'inherit',
        border: BORDER,
        borderRadius: 6,
        background: 'transparent',
        color: 'inherit',
        maxWidth: 420,
      },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        border: BORDER,
        borderRadius: 6,
        background: 'transparent',
        color: 'inherit',
        resize: 'vertical',
      },
      button: {
        padding: '5px 14px',
        fontSize: 13,
        fontFamily: 'inherit',
        borderRadius: 6,
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      small: {
        padding: '2px 9px',
        fontSize: 12,
        fontFamily: 'inherit',
        borderRadius: 6,
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      primary: { background: '#247bbf', borderColor: '#247bbf', color: '#fff' },
      hint: { color: MUTED, fontSize: 12 },
      bad: { color: '#c0392b', fontSize: 12, whiteSpace: 'pre-wrap' },
      good: { color: '#1e8449', fontSize: 12, whiteSpace: 'pre-wrap' },
      band: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 14,
        alignItems: 'center',
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.07))',
        margin: '8px 0',
      },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 },
      dot: { width: 8, height: 8, borderRadius: 4, display: 'inline-block' },
      trim: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        flexWrap: 'wrap',
        padding: '10px 12px',
        borderRadius: 8,
        border: BORDER,
        margin: '10px 0',
      },
      big: { fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      arrow: { color: MUTED },
      provider: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 10px',
        borderRadius: 8,
        border: BORDER,
        margin: '6px 0',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      pre: {
        margin: '10px 0 0',
        maxHeight: 320,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
      },
    }

    // 第三项是「宿主没给这个字段时」的取值，必须跟 lib/config.js 的 zod 默认值一致。
    // 原来一律用 `values[key] !== false` 派生，等于「字段缺失就算开启」：
    // 老宿主降级路径（status.flags 是空的 {}）下三个开关全显示勾上，用户随手一保存
    // 就把它们**真的**写成 true 了 —— 明明从没同意过。
    const BOOL_ROWS = [
      ['enabled', '启用裁剪', true],
      ['autoDetectBaseURL', '按 baseURL 自动识别', true],
      ['promptTrim', '裁剪系统提示词', true],
      ['schemaTrim', '瘦身工具 schema', true],
      ['selfCheck', '启动时打印自检', false],
      ['debugWrap', '包装器体积日志', false],
    ]
    // 第三项是「留空时用什么」，第四项是「0 在这套语义里意味着什么」——
    // 因为 0 不是「没填」，而是「关掉这个功能」（描述上限 0 = 不裁、预留 0 = 不预留）。
    // 用户清空输入框原本会被 Number('') 静默变成 0，等于悄悄改配置，必须拦住。
    const NUM_ROWS = [
      ['toolDescLimit', '工具描述上限', 140, '不裁工具描述'],
      ['toolParamDescLimit', '参数描述上限', 90, '不裁参数描述'],
      ['launchTimeout', '拉起后等端口（秒）', 20, '不等端口就报失败'],
      // 端口通了不等于能出字：第一次请求常常还在把权重读进内存，这里给个够宽的时间。
      ['smokeTimeout', '试跑超时（秒）', 60, '试跑立刻超时'],
      // 预检给系统留多少：桌面默认 2048 合理，Linux 服务器该能调小，这里得让用户改得到。
      ['reserveMb', '预检预留内存（MiB，0 = 不预留）', 2048, '不预留内存'],
    ]
    const LIST_ROWS = [
      ['routes', '生效路由', '留空 = 自动识别本地端点；写名字（每行一个）就只认这些 provider。'],
      // [P2-09-2026-11-26] 清空**不是**「一个都不保留」——服务端会回落 DEFAULT_KEEP。
      ['keep', '保留的工具', '每行一个全局工具名。留空 = 用内置默认白名单（不是不保留）；scoped 注册的工具（如 ops_glob）不受这里影响。'],
      ['dropSections', '丢弃的提示词段', '每行一个 section 名，名字对不上会被静默忽略。'],
      ['dropContexts', '丢弃的 context', '每行一个 context 名。'],
      // 内建的模型目录覆盖各平台常规位置；这里只补「我把 gguf 放在别处」。
      ['modelDirs', '额外模型目录', '每行一个目录，支持 ~。内建目录（~/models、~/llama.cpp/models…）已经包含，不用重复。'],
    ]

    function toLines(value) {
      return Array.isArray(value) ? value.join('\n') : ''
    }

    function fromLines(text) {
      return String(text ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    }

    // [P1-26-2026-11-25] 把一份配置值折成草稿的形状。抽出来是为了两件事共用同一套规则：
    // ① 面板载入时铺草稿；② 判断「草稿有没有没保存的改动」—— 两边各写一遍迟早不一致。
    function normalizeDraft(values) {
      const source = values ?? {}
      return {
        // 布尔一律「字段缺失 → 用配置里的默认值」，不是「缺失 → 当成 true」。
        booleans: Object.fromEntries(
          BOOL_ROWS.map(([key, , fallback]) => [key, source[key] === undefined ? fallback === true : source[key] !== false]),
        ),
        numbers: Object.fromEntries(NUM_ROWS.map(([key]) => [key, source[key]])),
        lists: Object.fromEntries(LIST_ROWS.map(([key]) => [key, toLines(source[key])])),
        injectText: String(source.injectText ?? ''),
        launchCommand: String(source.launchCommand ?? ''),
        // [P0-B-2026-11-25] provision 是三态：true / false / { endpoint, provider, ... }。
        // 勾选框只能表达布尔，所以原始值单独存一份 —— 否则对象形态被折成 true，
        // 下一次保存（哪怕只改了别的字段）就把用户手写的端点配置整个覆盖掉。
        provision: source.provision === undefined ? true : source.provision !== false,
        provisionRaw: source.provision,
      }
    }

    // 草稿的「内容指纹」：只比用户真能改的东西，忽略数字框里 20 与 '20' 这种表示差异。
    function draftSignature(draft) {
      if (draft === null || draft === undefined) return ''
      const parts = []
      for (const [key] of BOOL_ROWS) parts.push(key + '=' + (draft.booleans?.[key] === true ? '1' : '0'))
      for (const [key] of NUM_ROWS) parts.push(key + '=' + String(draft.numbers?.[key] ?? '').trim())
      for (const [key] of LIST_ROWS) parts.push(key + '=' + fromLines(draft.lists?.[key]).join('\u0001'))
      parts.push('injectText=' + String(draft.injectText ?? ''))
      parts.push('launchCommand=' + String(draft.launchCommand ?? '').trim())
      parts.push(
        'provision=' +
          (draft.provision === true
            ? draft.provisionRaw !== null && typeof draft.provisionRaw === 'object'
              ? JSON.stringify(draft.provisionRaw)
              : '1'
            : '0'),
      )
      return parts.join('\n')
    }

    function fmt(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return '—'
      return Math.round(n).toLocaleString('en-US')
    }

    function clock(at) {
      const n = Number(at)
      if (!Number.isFinite(n) || n <= 0) return ''
      try {
        return new Date(n).toLocaleTimeString()
      } catch {
        return ''
      }
    }

    function dot(tone) {
      return h('span', { style: { ...S.dot, background: TONE[tone] ?? TONE.muted } })
    }

    function badge(tone, text, title) {
      return h('span', { style: S.badge, title }, dot(tone), h('span', null, text))
    }

    // ── 模型的来源与端口 ──────────────────────────────────────────────────
    // 这两个必须放模块作用域：AdoptBox 和 Panel 都要用。v0.4.8 把 portFor 写在 AdoptBox
    // 里面，Panel 的 scanModels 却引用了它 —— 语法合法，点一次「扫描本机模型」才在渲染期
    // 抛 ReferenceError，被宿主的 SlotErrorBoundary 接住，整块面板在页面上凭空消失，
    // 宿主一切正常、连崩溃日志都不留。作用域问题 `node --check` 看不见，靠 test/client.mjs 守。
    const isOllama = (item) => item?.source === 'ollama'
    // 端口跟着「选中的这个文件」走，不跟着上一次选的走。选中 Ollama 的模型时跟到 11434
    // （那个端口上跑的是 ollama，填 8090 会再去起一份 llama-server 白吃内存）；选中普通
    // .gguf 时改回 8090 —— 否则端口会被上一次的 11434 粘住，插件跑去借 Ollama 的端口，
    // 把一个 GGUF 注册成 Ollama 清单里的某个模型（v0.4.8）。
    const portFor = (item) => (isOllama(item) && item.port ? String(item.port) : '8090')

    /**
     * 从 baseURL 里取端口，取不到回 0。
     *
     * [P1-16-2026-11-25] 原来面板里两处都写 `String(baseURL).replace(/^.*:(\d+).*$/, '$1')`：
     * 它是「贪婪匹配到最后一个冒号后的数字」，对 IPv6 字面量直接给出垃圾 ——
     * `http://[::1]/v1` → 1、`http://[::ffff:127.0.0.1]/v1` → 127。
     * 拿这个数去和 launched 表比对，会把别人的后端当成自己起的；拿它去 stop，
     * 停的是另一个端口。服务端 lib/launcher.js 的 portOfBaseURL 已经改用 WHATWG URL，
     * 这里保持同一套语义（浏览器环境本来就有 URL）。
     */
    function portOfBaseURL(baseURL) {
      const text = String(baseURL ?? '').trim()
      if (text === '') return 0
      let parsed
      try {
        parsed = new URL(text)
      } catch {
        // 同服务端：只有长得像 host[:port][/path] 的才补协议，随便一个词回 0。
        if (!/[:/]/.test(text) || !/^[^\s/?#@]+(\/|$)/.test(text)) return 0
        try {
          parsed = new URL('http://' + text)
        } catch {
          return 0
        }
      }
      if (parsed.port !== '') {
        const port = Number(parsed.port)
        return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
      }
      // IPv6 字面量没写端口时回 0（本地后端都在 8090/11434/8000/1234，不会是 80）。
      if (parsed.hostname.startsWith('[')) return 0
      if (parsed.protocol === 'https:') return 443
      if (parsed.protocol === 'http:') return 80
      return 0
    }

    // ── 收益条 ────────────────────────────────────────────────────────────
    function TrimBar({ status }) {
      const trim = status?.trim ?? {}
      if (trim.seen !== true) {
        return h('div', { style: S.trim }, h('span', { style: S.hint }, '还没有裁剪记录。走一次本地模型请求后这里会显示进→出的字符数。'))
      }
      const savedPct = Number(trim.savedPct) || 0
      const width = Math.max(0, Math.min(100, savedPct))
      // 没裁剪时分两种：本该裁却没命中（要去查配置），和本来就不该裁（云端放行）。
      // 都写成「未裁剪」等于让用户自己去猜是哪一种。
      const expected = trim.local === true
      // savedPct < 0 是「裁了反而更长」，不是「没裁」。进度条按 0 宽画（没有正收益），
      // 但文字必须说出来 —— 否则一次真实的回归（注入段把 head/tail 又拼回来了）
      // 在面板上完全不显示。
      const zeroLabel =
        savedPct > 0 ? '省 ' + savedPct + '%' : savedPct < 0 ? '反而多了 ' + -savedPct + '%' : expected ? '该裁但没命中' : '未裁剪'
      return h(
        'div',
        { style: { ...S.trim, flexWrap: 'wrap' } },
        h('span', null, '最近一次装配'),
        h('span', { style: S.big }, fmt(trim.charsIn)),
        h('span', { style: S.arrow }, '→'),
        h('span', { style: S.big, color: savedPct > 0 ? TONE.good : undefined }, fmt(trim.charsOut)),
        h('span', { style: S.hint }, '字符'),
        h(
          'span',
          { style: { flex: '1 1 160px', minWidth: 120, height: 8, borderRadius: 4, background: 'rgba(127,127,127,.18)', overflow: 'hidden' } },
          h('span', { style: { display: 'block', width: width + '%', height: '100%', background: TONE.good } }),
        ),
        h('span', { style: { ...S.hint, fontWeight: 600, color: savedPct > 0 ? TONE.good : savedPct < 0 ? TONE.bad : expected ? TONE.warn : undefined } }, zeroLabel),
        h(
          'span',
          { style: S.hint },
          [(trim.sectionsIn ?? 0) + '→' + (trim.sectionsOut ?? 0) + ' 段', trim.provider ? 'provider ' + trim.provider : '', clock(trim.at)]
            .filter(Boolean)
            .join(' · '),
        ),
        // 成因单独占一行：面板宽度有限，塞进上面那行会被挤掉。
        trim.seen === true && savedPct <= 0 && trim.label
          ? h('div', { style: { ...S.hint, flex: '1 1 100%', marginTop: 4 }, title: trim.reason ?? '' }, trim.label)
          : null,
      )
    }

    // ── provider 表 ───────────────────────────────────────────────────────
    function ProviderList({ rows, counts, busy, onTest, onCheck, onLaunch, onStop, onDelete, onAlign, onReconcile, launchedPorts, reconcileConfirm }) {
      const list = Array.isArray(rows) ? rows : []
      const mine = new Set(Array.isArray(launchedPorts) ? launchedPorts.map((item) => Number(item?.port ?? item)) : [])
      // 删配置不可撤销（虽然能重新导入），点一次只进入确认态，第二次才真删。
      const [pending, setPending] = React.useState('')
      // [P2-08-2026-11-26] 确认态必须自己过期。原来只有「真删」时才 setPending('')，
      // 于是点过一次「删除」之后，隔几分钟回来再点同一行 —— 哪怕本意是删别的行 ——
      // 那一下直接就是第二次点击，配置没了。四秒够看清按钮变成「确认删除？」并决定，
      // 又不至于让一次误点长期挂在那里等着被第二次误点确认。
      React.useEffect(() => {
        if (pending === '') return undefined
        const timer = setTimeout(() => setPending(''), 4000)
        return () => clearTimeout(timer)
      }, [pending])
      const deletingId = busy.startsWith('delete:') ? busy.slice('delete:'.length) : ''
      const portOf = (row) => portOfBaseURL(row?.baseURL)
      return h(
        'div',
        null,
        h(
          'div',
          { style: { ...S.row, margin: '10px 0 4px' } },
          h('span', { style: { fontWeight: 600 } }, '模型 provider'),
          // 「本地」是表里本地那几行，「后端可达」是整张表里探得通的那几行 —— 两个
          // 集合不同，数字大小没有可比性，所以不并排叫「在线」，免得看起来像矛盾。
          h('span', { style: S.hint }, `共 ${counts?.total ?? 0} 个 · 本地 ${counts?.local ?? 0} 个 · 后端可达 ${counts?.online ?? 0} 个`),
          // 汇总先说一句「有几条跟后端对不上」，用户不用逐行读就知道该不该往下看。
          // 只在真的算出了差集时出现 —— 没检测的时候说这句话就是瞎猜。
          counts?.stale > 0
            ? h(
                'span',
                {
                  style: { ...S.hint, color: TONE.warn },
                  title: `配置里一共声明了 ${counts.staleModels ?? 0} 条后端已经没有的模型。点右边的「对账」一次摘干净（只做减法）。`,
                },
                `· ${counts.stale} 个跟后端对不上`,
              )
            : null,
          h('span', { style: S.grow }),
          // 「对账」= 只做减法的维护动作：后端没有的模型从各条本地 provider 里摘掉，
          // 一条 provider 的模型全没了就连这条 provider 一起删。
          // 跟行内「对齐」的分工：对齐是「我要跟后端一样」（会补模型），对账是「把死掉的清掉」。
          // [P1-27-2026-11-25] 两段式：第一下只预览，第二下才写。按钮文字跟着变，
          // 否则用户不知道「我这一下是预览还是真删」。
          h(
            'button',
            {
              style: {
                ...S.small,
                ...(counts?.stale > 0 || reconcileConfirm === true ? { color: TONE.warn } : {}),
                ...(reconcileConfirm === true ? { fontWeight: 600 } : {}),
              },
              disabled: busy !== '',
              title:
                reconcileConfirm === true
                  ? '上一步只列了要改的东西，没有写配置。点这一下才真的删/摘。'
                  : '把所有本地 provider 跟后端对一次账：后端已经没有的模型摘掉，' +
                    '一条 provider 声明的模型全没了就删掉这条。只做减法，绝不补模型。' +
                    '第一下只列清单，确认后再点一次才写。',
              onClick: onReconcile,
            },
            busy === 'reconcile' ? '对账中…' : reconcileConfirm === true ? '确认对账' : '对账',
          ),
          h('button', { style: S.small, onClick: onCheck, disabled: busy !== '' }, busy === 'check' ? '检测中…' : '重新检测'),
        ),
        list.length === 0
          ? h('div', { style: S.hint }, 'settings 里还没有 provider。下面填端点导入一个试试。')
          : list.map((row, index) =>
              h(
                'div',
                // [react-key] key 只用来让 React 复用同一行，但用后端字段直取有个坑：
                // provider id 重复（settings 里两条同名、或 id 为空）时 React 会拿到
                // 两个相同 key，接着复用到错的 DOM 节点上 —— 表现为「点了 A 的按钮，
                // B 那行闪了一下」。拼上序号，重复时也唯一，代价只是列表重排时
                // 整行重建（这些行都是只读展示，重建不丢状态）。
                { style: S.provider, key: 'p:' + String(row.id ?? '?') + ':' + index },
                badge(row.state?.tone ?? 'muted', '', row.state?.label ?? ''),
                h('span', { style: { fontWeight: 600 } }, row.displayName || row.id),
                h('span', { style: { ...S.mono, color: MUTED } }, row.baseURL),
                h(
                  'span',
                  {
                    style: {
                      ...S.hint,
                      ...(row.models?.tone ? { color: TONE[row.models.tone] } : {}),
                    },
                    title:
                      row.missingModels?.length > 0
                        ? '配置里声明了 ' +
                          row.modelCount +
                          ' 个模型，后端此刻只有 ' +
                          (row.liveModelCount ?? 0) +
                          ' 个。不在后端的：' +
                          row.missingModels.join(', ')
                        : '',
                  },
                  (row.models?.label ?? row.modelCount + ' 模型') +
                    (row.contextWindow ? ' · ctx ' + fmt(row.contextWindow) : ''),
                ),
                row.local ? h('span', { style: S.hint }, '· 本地') : null,
                // 凭据声明了却解析不到值 —— 宿主会把这条 provider 的模型列表吞成空，
                // 于是配置里看得见、模型选择器里一个都没有。只有这种情况才提示；
                // 已配置或没声明凭据都不占地方。
                row.credential?.configured === false
                  ? h(
                      'span',
                      {
                        style: { ...S.hint, color: TONE.warn },
                        title:
                          '这条 provider 声明了凭据引用 ' +
                          row.credential.ref +
                          '，但那个 ref 没有值。宿主的 listModels 会因此返回空列表，' +
                          '模型选择器里就看不到它。删掉 apiKeyEnv 那行、或给它配个值。',
                      },
                      '· 凭据未配置',
                    )
                  : null,
                h('span', { style: S.grow }),
                h('span', { style: S.hint }, row.state?.label ?? ''),
                // 本地 provider 一律给「拉起」：灯是灰的（未检测）时也需要这个按钮，
                // 真点下去也不会重复起进程 —— 服务端会先探测，已经在应答就直接回一句。
                row.local === true
                  ? h(
                      'button',
                      {
                        style: S.small,
                        disabled: busy !== '',
                        title: '在这台机器上找到后端并起一个脱离宿主的进程，等到端口应答（已经在跑就不会重复起）',
                        onClick: () => onLaunch(row),
                      },
                      busy === 'launch:' + row.id ? '拉起中…' : '拉起',
                    )
                  : null,
                // 只有「这个端口上确实是本插件起的」才给停止按钮：别人的 ollama serve
                // 不该被这里点掉，服务端也会拒绝。
                mine.has(portOf(row))
                  ? h(
                      'button',
                      {
                        style: { ...S.small, color: RED },
                        disabled: busy !== '',
                        title: '停掉本插件在这个端口上拉起的进程（SIGTERM，赖着不走再 SIGKILL）',
                        onClick: () => onStop(row),
                      },
                      busy === 'stop:' + row.id ? '停止中…' : '停止',
                    )
                  : null,
                h(
                  'button',
                  {
                    style: S.small,
                    disabled: busy !== '' || row.local !== true,
                    title: row.local ? '发一次最小真实请求' : '只对本地 provider 试跑',
                    onClick: () => onTest(row),
                  },
                  busy === 'test:' + row.id ? '试跑中…' : '试跑',
                ),
                // 只有「配置声明跟后端实况不一致」时才给对齐键：全一致时这个按钮
                // 没有任何用，摆在那里只会让人以为点了会改配置。
                row.models?.tone !== undefined
                  ? h(
                      'button',
                      {
                        style: { ...S.small, ...(row.models.tone === 'bad' ? { color: TONE.bad } : {}) },
                        disabled: busy !== '',
                        title:
                          '按后端此刻真的有的模型改写这条 provider 的 models —— ' +
                          '摘掉已删除的、补上后端有但没注册的；baseURL / 显示名 / compat 都不动',
                        onClick: () => onAlign(row),
                      },
                      busy === 'align:' + row.id ? '对齐中…' : '对齐',
                    )
                  : null,
                // 删的是这条 provider 配置，不是磁盘上的 gguf —— title 上写明白，
                // 免得有人以为点了会丢模型。
                h(
                  'button',
                  {
                    style: {
                      ...S.small,
                      ...(pending === row.id ? { color: RED, borderColor: RED } : {}),
                    },
                    title:
                      pending === row.id
                        ? "再点一次就从配置里删掉这条（磁盘上的模型文件不受影响）"
                        : "把这条 provider 配置删掉（不删磁盘上的 gguf）",
                    disabled: busy !== '',
                    onClick: () => {
                      if (pending !== row.id) {
                        setPending(row.id)
                        return
                      }
                      setPending('')
                      onDelete(row)
                    },
                  },
                  deletingId === row.id
                    ? '删除中…'
                    : pending === row.id
                      ? '确认删除？'
                      : '删除',
                ),
              ),
            ),
      )
    }

    // ── 导入区 ────────────────────────────────────────────────────────────
    /**
     * 本机模型 → 一键配置。
     *
     * 上一版的「导入」要求用户先把服务跑起来（因为要填端点）；可现实是「我刚下好一个
     * gguf」—— 服务还不存在。这里把顺序倒过来：先列出磁盘上的模型文件，选一个，
     * 插件负责起服务 + 写 provider + 试跑，一步到位。
     */
    function AdoptBox({ scan, setScan, busy, onScan, onAdopt, form, setForm, result }) {
      // allModels 是磁盘上全部 gguf（含 mmproj，用来删）；models 只留能当主模型的那些。
      const allModels = Array.isArray(scan?.models) ? scan.models : []
      const models = Array.isArray(scan?.models) ? scan.models.filter((item) => item.mmproj !== true) : []
      const chosen = models.find((item) => item.path === form.modelPath)
      // 显示名优先级（v0.4.6）：ollama 的 tag（那是要发给 11434 的模型 id，也是用户认知里的
      // 名字）→ GGUF 元数据里的紧凑名（basename + size_label 拼出来的那个）→ general.name
      // 整串 → 文件名。
      // 紧凑名排在整串前面：整串常常是「…_REAP_0.25_V2_Agentic_…_Iter191_Fixed」这种内部
      // 编号，一行塞不下也不影响认模型；整串放进 title 里给人悬停看。
      const labelOf = (item) =>
        (Array.isArray(item.tags) && item.tags.length > 0 ? item.tags[0] : null) ??
        item.readableName ??
        item.modelName ??
        item.name
      const titleOf = (item) => (item.fullName ? item.fullName + '\n' : '') + item.path
      const gib = (bytes) => {
        const value = Number(bytes)
        if (!Number.isFinite(value) || value <= 0) return '?'
        if (value >= 1073741824) return (value / 1073741824).toFixed(1) + 'GB'
        if (value >= 1048576) return Math.round(value / 1048576) + 'MB'
        return Math.round(value / 1024) + 'KB'
      }
      const fit = chosen?.fit
      const heavy = fit?.level === 'risky'
      // 这里不再提供删除：要删的是 provider 配置（见上面的 provider 表），不是磁盘上的 gguf。
      return h(
        'div',
        { style: { marginTop: 14 } },
        h('div', { style: { fontWeight: 600, margin: '4px 0' } }, '本机模型 · 一键配置'),
        h(
          'div',
          { style: S.hint },
          '列出这台机器上已经下好的模型（.gguf 文件，以及 Ollama 存储里那些叫 sha256-… 的权重）。名字读的是文件里的真名，文件名被改成别的也不要紧。选一个，插件替你起服务、写进 provider、再试跑一次。不用先有端点。',
        ),
        h(
          'div',
          { style: S.row },
          h(
            'button',
            { style: S.button, onClick: onScan, disabled: busy !== '' },
            busy === 'scan' ? '扫描中…' : scan === null ? '扫描本机模型' : '重新扫描',
          ),
          scan === null
            ? null
            : h(
                'span',
                { style: S.hint },
                models.length === 0
                  ? '没找到模型文件。找过：' + (scan.dirs ?? []).join(' / ') +
                    // 「一个都没找到」有两种原因：目录里真没有模型，或者目录根本没读成。
                    // 后者不说出来，用户会去翻错的地方（明明是权限/盘符问题）。
                    (Array.isArray(scan.dirErrors) && scan.dirErrors.length > 0
                      ? '；这几个目录没读成：' +
                        scan.dirErrors.map((item) => (item?.dir ?? '?') + '（' + (item?.error ?? '?') + '）').join(' / ')
                      : '')
                  : `找到 ${allModels.length} 个` +
                    (allModels.length > models.length
                      ? `（其中 ${allModels.length - models.length} 个是视觉投影 mmproj，不能单独当主模型）`
                      : '') +
                    (models.filter(isOllama).length > 0
                      ? `（含 ${models.filter(isOllama).length} 个来自 Ollama）`
                      : '') +
                    (scan.truncated === true ? '，清单被截断' : ''),
              ),
        ),
        models.length === 0
          ? null
          : h(
              'div',
              { style: S.row },
              h('span', { style: S.label }, '模型文件'),
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    maxHeight: 260,
                    overflowY: 'auto',
                    flex: 1,
                    minWidth: 0,
                  },
                },
                ...allModels.map((item, index) => {
                  const picked = item.path === form.modelPath
                  return h(
                    'div',
                    {
                      // 同一个 gguf 可能被两条来源扫到（见 scanLocalModels 的去重），
                      // path 理论上唯一，但去重退化路径下也可能重；补序号兜底。
                      key: 'm:' + String(item.path ?? '?') + ':' + index,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '3px 6px',
                        borderRadius: 4,
                        border: '1px solid ' + (picked ? '#3b82f6' : '#e5e7eb'),
                        background: picked ? '#eff6ff' : 'transparent',
                      },
                    },
                    // 点名字选中（比下拉好：能看见体积和预检结论，也能删）
                    h(
                      'button',
                      {
                        style: {
                          flex: 1,
                          minWidth: 0,
                          textAlign: 'left',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 0,
                          fontSize: '12px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: picked ? '#1d4ed8' : 'inherit',
                          fontWeight: picked ? 600 : 400,
                        },
                        title: item.mmproj === true
                          ? '视觉投影（mmproj）不能单独当主模型用'
                          : titleOf(item),
                        disabled: busy !== '' || item.mmproj === true,
                        onClick: () => {
                          if (item.mmproj === true) return
                          // 端口跟着点中的这一条走：Ollama 的模型 → 11434，普通 .gguf → 8090。
                          // 原来只在 ollama 条目上跟随，普通 .gguf 沿用 form.port，于是上一次选
                          // ollama 留下的 11434 会一直粘着（v0.4.8 修的就是这个）。
                          setForm((prev) => ({ ...prev, modelPath: item.path, port: portFor(item) }))
                        },
                      },
                      (item.mmproj === true ? '· ' : picked ? '● ' : '○ ') + labelOf(item),
                    ),
                    isOllama(item)
                      ? h('span', { style: { ...S.tag, flexShrink: 0 } }, 'Ollama')
                      : null,
                    item.quantization
                      ? h('span', { style: { ...S.hint, flexShrink: 0 } }, item.quantization)
                      : null,
                    h('span', { style: { ...S.hint, flexShrink: 0 } }, gib(item.sizeBytes)),
                    item.fit?.level === 'risky' ? h('span', { style: { ...S.hint, color: RED, flexShrink: 0 } }, '偏大') : null,
                    item.mmproj === true
                      ? h('span', { style: { ...S.hint, flexShrink: 0 } }, '视觉投影')
                      : null,
                  )
                }),
              ),
            ),
        // [P2-01-2026-11-26] unknown 也要说一句。服务端只对 risky 拦一次确认，
        // unknown（内存/显存探测全失败，比如没有 nvidia-smi、/proc/meminfo 读不到）
        // 是直接放行的 —— 这时候面板一声不吭，用户会以为「预检通过」。
        // 保留放行（探不到不等于装不下），但把「这次没做预检」写在原处。
        fit !== undefined && fit.level === 'unknown'
          ? h(
              'div',
              { style: { ...S.hint, margin: '2px 0 6px' } },
              '没能探测内存/显存，这次不做预检（放行，但装不装得下要你自己看一眼体积）',
            )
          : null,
        // 预检结论：只在有话说的时候显示（ok 就不打扰）
        fit === undefined || fit.level === 'ok' || fit.level === 'unknown'
          ? null
          : h(
              'div',
              { style: { ...(heavy ? S.bad : S.hint), margin: '2px 0 6px' } },
              fit.label + (heavy ? '（真要起就得确认一次；走 mmap 的话只是开头慢，内存可回收）' : ''),
            ),
        models.length === 0
          ? null
          : h(
              'div',
              { style: S.row },
              h('span', { style: S.label }, '端口 / 上下文'),
              h('input', {
                style: { ...S.input, maxWidth: 90 },
                value: String(form.port),
                spellCheck: false,
                onChange: (event) => setForm((prev) => ({ ...prev, port: event.target.value })),
              }),
              h('input', {
                style: { ...S.input, maxWidth: 110 },
                value: String(form.contextWindow),
                spellCheck: false,
                onChange: (event) => setForm((prev) => ({ ...prev, contextWindow: event.target.value })),
              }),
              h(
                'label',
                { style: { ...S.hint, display: 'inline-flex', gap: 6, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: form.thinking === true,
                  onChange: (event) => setForm((prev) => ({ ...prev, thinking: event.target.checked })),
                }),
                '保留思考模式',
              ),
              // 加载方式：空 = 交给 llama.cpp 自己决定（auto）。别默认关 mmap——
              // gguf 走 mmap 落在可回收的 page cache，关掉才是真吃满内存。
              h(
                'select',
                {
                  style: { ...S.select, maxWidth: 190 },
                  value: String(form.loadMode ?? ''),
                  title: '--load-mode：auto=引擎自己决定，mmap=分页读盘（默认最稳），none=全量进内存',
                  onChange: (event) => setForm((prev) => ({ ...prev, loadMode: event.target.value })),
                },
                h('option', { value: '' }, '加载方式：自动'),
                h('option', { value: 'mmap' }, 'mmap（推荐）'),
                h('option', { value: 'none' }, 'none（全量进内存）'),
                h('option', { value: 'mlock' }, 'mlock（锁页）'),
                h('option', { value: 'mmap+mlock' }, 'mmap+mlock'),
              ),
            ),
        models.length === 0
          ? null
          : h(
              'div',
              { style: S.row },
              // 大模型才需要勾这个：勾了服务端才肯真起，否则只回一句「会很卡」
              heavy
                ? h(
                    'label',
                    { style: { ...S.hint, display: 'inline-flex', gap: 6, alignItems: 'center' } },
                    h('input', {
                      type: 'checkbox',
                      checked: form.confirmHeavy === true,
                      onChange: (event) => setForm((prev) => ({ ...prev, confirmHeavy: event.target.checked })),
                    }),
                    '我知道会很慢，还是要起',
                  )
                : null,
              h(
                'button',
                {
                  style: { ...S.button, ...S.primary },
                  onClick: onAdopt,
                  disabled: busy !== '' || form.modelPath === '' || (heavy && form.confirmHeavy !== true),
                },
                busy === 'adopt'
                  ? '起服务 + 注册 + 试跑中…（首次加载权重十几秒）'
                  : heavy && form.confirmHeavy !== true
                    ? '装不下，先勾上面那行'
                    : '一键配置并试跑',
              ),
              chosen === undefined
                ? null
                : h(
                    'span',
                    { style: S.hint },
                    isOllama(chosen)
                      ? '模型名取 tag：' + labelOf(chosen) + '（走 Ollama 的 11434，不再起一份 llama-server）'
                      : chosen.readableName !== undefined && chosen.readableName !== chosen.name
                        ? '别名：' + labelOf(chosen) + '（文件里的真名；端口上报的模型 id 以实际应答为准）'
                        : '别名取文件名：' + chosen.name.replace(/\.gguf$/i, ''),
                  ),
            ),
        result === null
          ? null
          : h(
              'pre',
              { style: { ...(result.ok === true ? S.good : S.bad), ...S.pre } },
              result.text,
            ),
      )
    }

    function ImportBox({ form, setForm, busy, onProbe, onImport, result }) {
      const models = Array.isArray(form.models) ? form.models : []
      return h(
        'div',
        { style: { marginTop: 14 } },
        h('div', { style: { fontWeight: 600, margin: '4px 0' } }, '导入本地模型'),
        h(
          'div',
          { style: S.hint },
          '填端点 → 探测出模型 → 选一个 → 导入并试跑。导入会写进 llm-pi-ai 的 providers，之后在「模型」选择器里就能选到。',
        ),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.label }, '端点'),
          h('input', {
            style: { ...S.input, maxWidth: 380 },
            value: form.endpoint,
            placeholder: 'http://127.0.0.1:8090',
            spellCheck: false,
            onChange: (event) => setForm((prev) => ({ ...prev, endpoint: event.target.value, models: [], model: '' })),
          }),
          h('button', { style: S.button, onClick: onProbe, disabled: busy !== '' }, busy === 'probe' ? '探测中…' : '探测'),
        ),
        models.length > 0
          ? h(
              'div',
              { style: S.row },
              h('span', { style: S.label }, '模型'),
              h(
                'select',
                {
                  style: S.select,
                  value: form.model,
                  onChange: (event) => setForm((prev) => ({ ...prev, model: event.target.value })),
                },
                h('option', { value: '' }, '选一个（' + models.length + ' 个可用）'),
                ...models.map((id, index) => h('option', { key: 'o:' + String(id) + ':' + index, value: id }, id)),
              ),
            )
          : null,
        h(
          'div',
          { style: S.row },
          h('span', { style: S.label }, 'provider id'),
          h('input', {
            style: { ...S.input, maxWidth: 240 },
            value: form.provider,
            placeholder: '留空自动生成（local-llamacpp-…）',
            spellCheck: false,
            onChange: (event) => setForm((prev) => ({ ...prev, provider: event.target.value })),
          }),
          h(
            'label',
            { style: { ...S.hint, display: 'inline-flex', gap: 6, alignItems: 'center' } },
            h('input', {
              type: 'checkbox',
              checked: form.thinking === true,
              onChange: (event) => setForm((prev) => ({ ...prev, thinking: event.target.checked })),
            }),
            '保留思考模式',
          ),
          h(
            'label',
            { style: { ...S.hint, display: 'inline-flex', gap: 6, alignItems: 'center' } },
            h('input', {
              type: 'checkbox',
              checked: form.overwrite === true,
              onChange: (event) => setForm((prev) => ({ ...prev, overwrite: event.target.checked })),
            }),
            '覆盖同名 provider',
          ),
        ),
        h(
          'div',
          { style: S.row },
          h(
            'button',
            {
              style: { ...S.button, ...S.primary },
              onClick: onImport,
              disabled: busy !== '' || form.model === '',
            },
            busy === 'import' ? '导入并试跑中…' : '导入并试跑',
          ),
          h('span', { style: S.hint }, '试跑是发一条「只回一个字：好」的真实请求，量端到端耗时'),
        ),
        result === null
          ? null
          : h(
              'pre',
              { style: { ...(result.ok === true ? S.good : S.bad), ...S.pre } },
              result.text,
            ),
      )
    }

    function Panel({ subject }) {
      const [state, setState] = React.useState({ loading: true })
      const [draft, setDraft] = React.useState(null)
      // [busy-stack] 原来是一个字符串：12 处 `finally { setBusy('') }` 等价于
      // 「最后一个完成的解锁」，可面板上一件事没干完就能点第二件 ——
      // 加载中的旧响应还会盖掉刚拿到的状态。改成计数栈：只有全空了才解锁，
      // 显示的标签取最后发起的那件。
      const [busyStack, setBusyStack] = React.useState([])
      const busy = busyStack.length === 0 ? '' : busyStack[busyStack.length - 1]
      const setBusy = React.useCallback((label) => {
        setBusyStack((prev) => (label === '' ? prev.slice(0, -1) : [...prev, label]))
      }, [])
      // [seq] 每次 load/refreshStatus 领一个号，回来时号不是最新的就丢掉 ——
      // 否则先发的慢请求后到，会把新的 draft / status 覆盖成旧值。
      const loadSeq = React.useRef(0)
      const statusSeq = React.useRef(0)
      const [message, setMessage] = React.useState(null)
      const [form, setForm] = React.useState({
        endpoint: 'http://127.0.0.1:8090',
        models: [],
        model: '',
        provider: '',
        thinking: false,
        overwrite: false,
      })
      const [importResult, setImportResult] = React.useState(null)
      const [scan, setScan] = React.useState(null)
      const [adoptForm, setAdoptForm] = React.useState({
        // 空 = 交给引擎自己决定（llama.cpp 默认 auto）；填值才会拼 --load-mode
        loadMode: '',
        modelPath: '',
        port: 8090,
        contextWindow: 65536,
        thinking: false,
        confirmHeavy: false,
      })
      const [adoptResult, setAdoptResult] = React.useState(null)
      const [launchResult, setLaunchResult] = React.useState(null)
      // [P1-28-2026-11-25] provider 表上的按钮（试跑 / 对齐 / 对账）结果单独一个状态。
      // 原来它们都写 importResult，而 ImportBox 在页面更下面 —— 点了表里的按钮，
      // 回复出现在屏幕另一头，用户以为没反应就再点一次。
      const [providerResult, setProviderResult] = React.useState(null)
      // [P1-27-2026-11-25] 对账改成两段式：第一下只拿预览（服务端 apply 缺省就只报告），
      // 有东西要删才把动作摆出来，第二下才真写。原来一下点下去就 apply:true，
      // 而这条路径会整条删掉 provider —— 点错一次就是配置没了。
      const [reconcilePending, setReconcilePending] = React.useState(null)

      const mine = subject?.kind === 'bundle' && subject?.pkg?.name === PACKAGE_NAME

      const applyValues = React.useCallback((values, extra) => {
        setDraft(normalizeDraft(values))
        setState({ loading: false, ...extra })
      }, [])

      // [P1-23-2026-11-25] load 会把 message 清空（成功加载完就没有旧提示了）。
      // 但保存流程是「写配置 → setMessage('已保存') → load() 刷新」—— 刷新那一下把刚
      // 弹出来的「已保存」抹掉了，用户看到的是面板一闪、什么都没变，于是再点一次保存。
      // 传 keepMessage:true 就保留调用方刚设的提示（只清别人留下的）。
      const load = React.useCallback(async (options) => {
        const keepMessage = options !== null && typeof options === 'object' && options.keepMessage === true
        const seq = ++loadSeq.current
        setBusy('load')
        try {
          let payload
          try {
            payload = await call('status', {})
          } catch (statusError) {
            // 老宿主（v0.3.1 及以前）只有 describe 路由。别让整块面板塌掉：
            // 退回旧视图，并在状态带上说清楚「重启 DSH 才有新视图」。
            const described = await call('describe', {})
            payload = {
              ok: true,
              values: described.values,
              revision: described.revision,
              writable: described.writable,
              status: {
                takeover: { tone: 'warn', label: '宿主未提供状态接口', via: '重启 DSH 后可用' },
                trim: { seen: false },
                inject: described.lightBody ?? { chars: 0, source: 'unknown' },
                provision: described.provision ?? {},
                flags: {},
                providers: [],
                counts: { total: 0, local: 0, online: 0 },
                launched: [],
                revision: described.revision,
                writable: described.writable,
              },
              _degraded: String(statusError?.message ?? statusError),
            }
          }
          if (loadSeq.current !== seq) return
          const values = payload.values ?? payload.status?.values ?? {}
          applyValues(values, {
            status: payload.status ?? null,
            values,
            revision: payload.revision,
            writable: payload.writable,
            degraded: payload._degraded,
          })
          if (!keepMessage) setMessage(null)
        } catch (error) {
          if (loadSeq.current === seq) setState({ loading: false, error: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [applyValues, setBusy])

      React.useEffect(() => {
        if (mine) load()
      }, [mine, load])

      // [P0-C-2026-11-25] 下面四个 hook 必须留在 early return **之前**。
      //
      // 原来 refreshStatus / scanModels / runDelete / runAdopt 写在 `if (!mine) return null`
      // 之后：面板不是本插件时这一轮渲染提前返回，hook 一个都没调用；而 React 要求
      // 「每次渲染的 hook 调用序列一致」。DSH 的 bundle 详情页在切换 subject 时会复用
      // 同一个组件实例，于是同一实例上的 hook 数量在 N 和 N-4 之间跳变，React 抛
      // "Rendered fewer hooks than expected"，表现是切到别的插件页白屏 / 整块报错。
      // 它们的依赖数组都不含 mine，搬上来不改变语义。
      const refreshStatus = React.useCallback(async () => {
        const seq = ++statusSeq.current
        try {
          const payload = await call('status', {})
          if (statusSeq.current !== seq) return
          setState((prev) => ({ ...prev, status: payload.status ?? prev.status, revision: payload.revision ?? prev.revision }))
        } catch {
          /* 状态刷新失败不影响已显示的内容 */
        }
      }, [])

      const scanModels = React.useCallback(async () => {
        setBusy('scan')
        setMessage(null)
        try {
          // [P1-21-2026-11-25] 把当前选的加载方式一起送过去：列表原来按 mmap 算，
          // 而采用时按 none/mlock 算，同一台机器上两个口径会给出不同的预检结论。
          const result = await call('models', { loadMode: adoptForm.loadMode })
          setScan(result)
          const list = Array.isArray(result.models) ? result.models : []
          const usable = list.filter((item) => item.mmproj !== true)
          // [P2-10-2026-11-26] 重扫之后要核一遍「上次选的那个文件还在不在」。
          // 原来只在 modelPath 为空时自动选第一条，选中的文件被删/挪走后 modelPath 原样留着：
          // AdoptBox 里 chosen 变成 undefined，预检和体积全不显示，按钮却只看
          // modelPath === '' 仍然可点 —— 一点就是拿一个不存在的路径去起服务，
          // 后端回的是「这个文件不是 GGUF，也不是 Ollama 的模型」，完全指不到真原因。
          const current = adoptForm.modelPath
          if (current !== '') {
            if (list.some((item) => item.path === current)) return
            const first = usable[0]
            setAdoptForm((prev) => ({
              ...prev,
              modelPath: first === undefined ? '' : first.path,
              port: first === undefined ? prev.port : portFor(first),
            }))
            setMessage({
              tone: 'plain',
              text:
                '上次选的模型这次没扫到（文件可能被删或挪走了），已' +
                (first === undefined ? '清空选择' : '改选 ' + first.path),
            })
            return
          }
          const first = usable[0]
          if (first === undefined) return
          // 自动选中时端口跟着走：Ollama 的模型默认落到 11434，普通 .gguf 落 8090。
          setAdoptForm((prev) => (prev.modelPath === '' ? { ...prev, modelPath: first.path, port: portFor(first) } : prev))
        } catch (error) {
          setMessage({ tone: 'bad', text: '扫描失败：' + String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [adoptForm.loadMode, adoptForm.modelPath, setBusy])

      /**
       * 删一条 provider 配置。
       *
       * 删的是 settings 里的那一条 llm-pi-ai.providers[<id>]，**不是磁盘上的 gguf**。
       * 权重文件是你的，插件不动；僵尸的是配置（指向从没起过的端口、同端口注册两遍那种）。
       * 只有连点两次才会到这里（第一次在表里变成「确认删除？」）。
       */
      const runDelete = React.useCallback(
        async (row) => {
          const provider = String(row?.id ?? '')
          if (provider.length === 0) return
          setBusy('delete:' + provider)
          setMessage(null)
          try {
            const result = await call('delete', { provider })
            if (result.ok !== true) {
              setMessage({ tone: 'bad', text: '没删成：' + String(result.error ?? '不知道原因') })
              // 继承自下层 patch 的那种删不掉，缓存和列表都没变，别重扫。
              return
            }
            setMessage({ tone: 'good', text: String(result.message ?? '已删除 provider ' + provider) })
            await refreshStatus()
          } catch (error) {
            setMessage({ tone: 'bad', text: '删除失败：' + String(error?.message ?? error) })
          } finally {
            setBusy('')
          }
        },
        [refreshStatus, setBusy],
      )

      const runAdopt = React.useCallback(async () => {
        if (adoptForm.modelPath === '') return
        setBusy('adopt')
        setMessage(null)
        setAdoptResult(null)
        try {
          const result = await call('adopt', {
            modelPath: adoptForm.modelPath,
            port: Number(adoptForm.port) || 8090,
            contextWindow: Number(adoptForm.contextWindow) || 65536,
            thinking: adoptForm.thinking === true,
            confirmHeavy: adoptForm.confirmHeavy === true,
            ...(String(adoptForm.loadMode ?? '') === '' ? {} : { loadMode: adoptForm.loadMode }),
          })
          const lines = []
          if (result.stage === 'precheck') {
            // 预检拦住：把体积、可用内存、建议动作一次说清
            lines.push('预检没通过：' + (result.error ?? ''))
            if (result.fit?.label) lines.push('· ' + result.fit.label)
            if (typeof result.loadMode === 'string' && result.loadMode !== '')
              lines.push('· 会用 --load-mode ' + result.loadMode + ' 起')
            setAdoptResult({ ok: false, text: lines.join('\n') })
            return
          }
          // [P2-14-2026-11-26] 挑模型的来由要说出来，否则「跑起来的不是我以为的那个」
          // 只能靠猜。服务端没给（老后端/自定义命令）就不显示这一行。
          if (result.picked && typeof result.picked.reason === 'string' && result.picked.reason !== '') {
            lines.push('· 模型：' + String(result.picked.path ?? result.model ?? '?') + '（' + result.picked.reason + '）')
          }
          if (result.portNote) lines.push('· ' + result.portNote)
          if (result.launch?.already === true) lines.push('端口 ' + result.port + ' 本来就在跑，跳过拉起')
          else if (result.launch?.ok === true) {
            lines.push('已拉起 llama-server（pid ' + result.launch.pid + '），' + result.launch.ms + 'ms 后应答')
          }
          if (result.reaped === true) lines.push('（没起来，已经把刚拉起的进程回收了）')
          if (result.provider !== undefined) lines.push('provider：' + result.provider + ' → ' + result.model)
          if (result.registered === true) lines.push('已写入 llm-pi-ai（重启后在选择器里可见）')
          else if (result.reason) lines.push('未写入：' + result.reason)
          if (result.smoke?.ok === true) {
            lines.push('试跑 ' + result.smoke.ms + 'ms：「' + (result.smoke.text || '(空)') + '」')
          } else if (result.smoke) {
            lines.push('试跑失败：' + (result.smoke.error ?? '没拿到回复'))
          }
          if (result.ok !== true) lines.push('卡在 ' + (result.stage ?? '?') + '：' + (result.error ?? ''))
          setAdoptResult({ ok: result.ok === true, text: lines.join('\n') })
          if (result.ok === true) await load()
        } catch (error) {
          setAdoptResult({ ok: false, text: '一键配置失败：' + String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [adoptForm, load, setBusy])

      if (!mine) return null


      const check = async () => {
        setBusy('check')
        try {
          await call('check', { force: true })
          await refreshStatus()
        } catch (error) {
          setMessage({ tone: 'bad', text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      // 一键拉起后端：插件在本机找可执行文件、起脱离宿主的进程、等端口应答
      const launch = async (row) => {
        setBusy('launch:' + row.id)
        setLaunchResult(null)
        try {
          const result = await call('launch', { baseURL: row.baseURL, model: row.modelIds?.[0] })
          // [P1-22-2026-11-25] 标上 action：拉起和停止共用 launchResult，文案要分开。
          setLaunchResult({ ...result, action: 'launch' })
          await refreshStatus()
        } catch (error) {
          const note = throttleNote(error)
          setLaunchResult(
            note.length > 0
              ? { ok: false, action: 'launch', throttled: true, error: note }
              : { ok: false, action: 'launch', error: String(error?.message ?? error) },
          )
        } finally {
          setBusy('')
        }
      }

      // 停止：只停本插件自己 spawn 的那个 pid（服务端有白名单，别人的后端不动）
      const stop = async (row) => {
        setBusy('stop:' + row.id)
        setLaunchResult(null)
        try {
          const port = portOfBaseURL(row.baseURL)
          const result = await call('stop', { port })
          // [P1-22-2026-11-25] 停止的结果以前不带 action，渲染处只认 ok/already，
          // 于是「已停掉 X」被写成「已拉起 X（pid N）」。
          setLaunchResult({ ...result, action: 'stop' })
          await refreshStatus()
        } catch (error) {
          const note = throttleNote(error)
          setLaunchResult(
            note.length > 0
              ? { ok: false, action: 'stop', throttled: true, error: note }
              : { ok: false, action: 'stop', error: String(error?.message ?? error) },
          )
        } finally {
          setBusy('')
        }
      }

      // 对齐：把这条 provider 的 models 改成后端此刻真的有的那份。
      // 只改 models 数组，baseURL / 显示名 / compat 都不动 —— 那些是用户自己的设置。
      const align = async (row) => {
        setBusy('align:' + row.id)
        // [P1-28-2026-11-25] 表里的按钮结果写 providerResult（表下方就地显示）。
        setProviderResult(null)
        try {
          const result = await call('align', { provider: row.id })
          setProviderResult({ ok: result.ok === true, text: (result.ok === true ? '✓ ' : '✗ ') + (result.message ?? result.error ?? '') })
          await refreshStatus()
        } catch (error) {
          setProviderResult({ ok: false, text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      // 对账：后端已经没有的模型从各条本地 provider 里摘掉，全没了就删 provider。
      // 与 align 的区别只在「补不补」：align 会补上后端有但没注册的，对账只做减法。
      //
      // apply:true 必须显式传。服务端那条路由的默认是「只报告不写」—— 它直接暴露在
      // HTTP 上，缺省即删 provider 等于一个空 body 的请求就能毁掉配置。
      //
      // [P1-27-2026-11-25] 两段式：第一下 apply:false 只拿预览，把要删/要摘的逐条列出来；
      // 用户再点一次（按钮这时写着「确认对账」）才 apply:true。
      const describeReconcile = (item) => {
        const removed = Array.isArray(item.removed) ? item.removed : []
        if (item.action === 'remove') {
          return '· 删掉 ' + item.provider + '（' + removed.length + ' 个模型全没了）'
        }
        return '· ' + item.provider + ' 摘掉 ' + removed.length + ' 个' +
          (removed.length > 0 ? '（' + removed.join(', ') + '）' : '')
      }

      const reconcile = async () => {
        const confirm = reconcilePending !== null
        setBusy('reconcile')
        setProviderResult(null)
        try {
          const result = await call('reconcile', confirm ? { apply: true } : { apply: false })
          const actions = Array.isArray(result.actions) ? result.actions : []
          const changes = actions.filter((item) => item.action === 'remove' || item.action === 'prune')
          if (confirm) {
            setReconcilePending(null)
            setProviderResult({
              ok: result.ok === true,
              text: (result.ok === true ? '✓ ' : '✗ ') + (result.message ?? result.error ?? ''),
            })
            await refreshStatus()
          } else if (result.ok === true && result.changed === true && changes.length > 0) {
            setReconcilePending({ actions: changes })
            setProviderResult({
              ok: true,
              text:
                '对账会改这些（还没写）：\n' +
                changes.map(describeReconcile).join('\n') +
                '\n确认没问题，再点一次「确认对账」。',
            })
          } else {
            // 没东西可动：直接把服务端那句「对得上，没动」摆出来，不进入确认态。
            setReconcilePending(null)
            setProviderResult({
              ok: result.ok === true,
              text: (result.ok === true ? '✓ ' : '✗ ') + (result.message ?? result.error ?? ''),
            })
          }
        } catch (error) {
          setReconcilePending(null)
          setProviderResult({ ok: false, text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const test = async (row) => {
        setBusy('test:' + row.id)
        // [P1-28-2026-11-25] 同上：试跑是表里的动作，结果就地显示。
        // [P2-07-2026-11-26] 占位不能用 ok:true —— 那会先画成绿色成功色，等真结果
        // 回来再翻成红字，来回闪一下像「成功了又失败」。三态：true 绿 / false 红 /
        // undefined 灰（进行中）。
        setProviderResult({
          ok: undefined,
          text: '正在对 ' + row.id + ' 发一条真实请求…',
        })
        try {
          const result = await call('test', { provider: row.id })
          const smoke = result.smoke ?? {}
          setProviderResult({
            ok: result.ok === true,
            text:
              result.ok === true
                ? `✓ ${row.id} · ${smoke.ms ?? '?'}ms · 回复「${smoke.text ?? ''}」` +
                  (smoke.completionTokens ? ` · ${smoke.completionTokens} tokens` : '')
                : `✗ ${row.id} · ${smoke.error ?? result.error ?? '失败'}`,
          })
          await refreshStatus()
        } catch (error) {
          setProviderResult({ ok: false, text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const probeEndpoint = async () => {
        setBusy('probe')
        setImportResult(null)
        try {
          const result = await call('probe', { endpoint: form.endpoint, timeoutMs: 4000 })
          const first = (result.results ?? [])[0] ?? {}
          const models = (first.models ?? []).map((model) => model.id)
          setForm((prev) => ({ ...prev, models, model: models[0] ?? '' }))
          setImportResult({
            ok: result.ok === true,
            text:
              result.ok === true
                ? `✓ ${first.baseURL} · ${models.length} 个模型\n` + models.join('\n')
                : `✗ 连不上 ${first.baseURL || form.endpoint}` +
                  ((first.attempts ?? []).length > 0
                    ? '\n' + (first.attempts ?? []).map((item) => `${item.url ?? ''} ${item.reason ?? item.error ?? ''}`).join('\n')
                    : ''),
          })
        } catch (error) {
          setImportResult({ ok: false, text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }


      const runImport = async () => {
        setBusy('import')
        setImportResult({ ok: true, text: '探测端点 → 写入 settings → 发一条真实请求…' })
        try {
          const result = await call('import', {
            endpoint: form.endpoint,
            model: form.model,
            provider: form.provider.trim(),
            thinking: form.thinking === true,
            overwrite: form.overwrite === true,
          })
          const smoke = result.smoke ?? {}
          const head =
            result.registered === true
              ? `✓ 已写入 provider ${result.provider}（模型 ${result.model}）`
              : `• provider ${result.provider} 没有改动：${result.reason ?? '已存在'}`
          const tail =
            smoke.ok === true
              ? `✓ 试跑通过 · ${smoke.ms ?? '?'}ms · 回复「${smoke.text ?? ''}」` +
                (smoke.completionTokens ? ` · ${smoke.completionTokens} tokens` : '')
              : `✗ 试跑失败 · ${smoke.error ?? '无响应'}（配置已保存，改好后点「试跑」）`
          setImportResult({ ok: true, text: head + '\n' + tail })
          // [P1-26-2026-11-25] 导入写的是 settings，重载会把面板上所有草稿字段换成服务端值。
          // 用户如果正改到一半（描述上限、路由、注入文本…），这一下等于白改。
          // 所以先比指纹：草稿跟「最后一次载入的服务端值」不一致就不重载，只刷状态。
          const dirty =
            draft !== null && draftSignature(draft) !== draftSignature(normalizeDraft(state.values))
          if (dirty) {
            await refreshStatus()
            setImportResult({
              ok: true,
              text: head + '\n' + tail + '\n（面板上有没保存的改动，没敢覆盖你的草稿；要按新配置重画就点「刷新」）',
            })
          } else {
            await load()
          }
        } catch (error) {
          setImportResult({ ok: false, text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      // 数字框里可能是空串（用户正在改）或负数（粘贴进来的）。这两种都不写进 patch ——
      // 原来是 `Number(...)` 后非法就当 0，而 0 在这套语义里是「关掉这个功能」：
      // 清一下描述上限的输入框，描述裁剪就整块没了；清一下 reserveMb，内存预留就没了。
      // 用户没打算关的东西不能被一次误敲关掉，所以这里选择「不提交这一个键」，
      // 并把被跳过的项报出来，让人知道那次保存并没有把它算进去。
      // [P2-11-2026-11-26] 端点/名字以前只能在 cordis.patch.yml 里手写：面板上「一步到位」
      // 只有一个勾选框，对象形态的 provision 只能显示成一行灰字。这里补三个可选输入，
      // 写回的是同一个对象（其余键原样保留），留空 = 删掉这个键、交回自动探测。
      // 只覆盖 endpoint / provider / displayName 三个；reconcile、overwrite、
      // endpoints[]、chatTemplateKwargs 这些不常用的照旧走配置文件。
      const setProvisionField = (key, value) => {
        const text = String(value ?? '').trim()
        setDraft((prev) => {
          const base = prev.provisionRaw !== null && typeof prev.provisionRaw === 'object' ? prev.provisionRaw : {}
          const next = { ...base }
          if (text === '') delete next[key]
          else next[key] = text
          // 三个键都空了就退回 true（= 探测内置端口表），别留一个空对象在配置里。
          const empty = Object.keys(next).length === 0
          return { ...prev, provisionRaw: empty ? true : next }
        })
      }
      const provisionField = (key) => {
        const raw = draft.provisionRaw
        return raw !== null && typeof raw === 'object' && typeof raw[key] === 'string' ? raw[key] : ''
      }

      const buildPatch = () => {
        if (draft === null) return { patch: {}, skipped: [] }
        const patch = {}
        const skipped = []
        for (const [key] of BOOL_ROWS) patch[key] = draft.booleans[key] === true
        for (const [key, label] of NUM_ROWS) {
          const raw = draft.numbers[key]
          if (raw === undefined || raw === null || String(raw).trim() === '') {
            skipped.push(label)
            continue
          }
          const value = Number(raw)
          if (!Number.isFinite(value) || value < 0) {
            skipped.push(label)
            continue
          }
          patch[key] = Math.floor(value)
        }
        for (const [key] of LIST_ROWS) patch[key] = fromLines(draft.lists[key])
        patch.injectText = draft.injectText.trim()
        patch.launchCommand = draft.launchCommand.trim()
        // [P0-B-2026-11-25] 勾着就写回原值：原本是对象就写对象，原本是 true/缺失才写 true。
        // 原来无条件 `draft.provision === true`，一次保存就把 { endpoint, provider, displayName }
        // 压成 true，服务端退回「探测内置端口表」，用户指定的端点静默失效。
        patch.provision =
          draft.provision === true
            ? draft.provisionRaw !== null && typeof draft.provisionRaw === 'object'
              ? draft.provisionRaw
              : true
            : false
        return { patch, skipped }
      }

      const save = async () => {
        setBusy('save')
        const { patch, skipped } = buildPatch()
        const skipNote = skipped.length > 0 ? `（这几项没填有效值，这次没提交：${skipped.join('、')}）` : ''
        try {
          const result = await call('save', { patch, revision: state.revision })
          if (result.saved === true) {
            setMessage({ tone: 'good', text: '已保存。下一次请求就按新配置走，不用重启。' + skipNote })
            // 只有真写进去了才重新拉一遍 —— 成功时服务端的值就等于刚提交的值，
            // 重载不会丢东西，还能顺带刷新 revision。
            // [P1-23-2026-11-25] 必须带 keepMessage：load() 成功末尾会 setMessage(null)，
            // 于是「已保存」刚弹出来就被刷新那一下抹掉，用户看到面板一闪以为没生效。
            await load({ keepMessage: true })
          } else {
            // 没写进去：一个字都别重载。原来的 `await load()` 会把用户刚调好的
            // 二十几个字段用**服务端的旧值**覆盖回去，等于「保存失败 + 顺手清空编辑」。
            setMessage({ tone: 'bad', text: String(result.error ?? '保存未生效') + skipNote })
          }
        } catch (error) {
          const text = String(error?.message ?? error)
          const conflict = /revision|conflict|冲突/i.test(text)
          setMessage({
            tone: 'bad',
            text: conflict
              ? text + '（配置已被别处改过。你的改动还在编辑器里，先看一眼再存一次）'
              : text + skipNote,
          })
          // 冲突时只刷状态（拿到新 revision），绝不重载 draft。
          if (conflict) await refreshStatus()
        } finally {
          setBusy('')
        }
      }

      const showLog = async () => {
        setBusy('log')
        try {
          const result = await call('log', { bytes: 6000 })
          // 读日志本身可能失败（文件不存在、权限、宿主不给路径），那时 result 里只有 error
          // 没有 path/text —— 直接拼字符串会让面板显示「— undefined」。分开走。
          if (result?.error !== undefined || typeof result?.text !== 'string') {
            setMessage({ tone: 'bad', text: '没读成日志：' + String(result?.error ?? '返回里没有内容') })
          } else {
            const where = typeof result.path === 'string' && result.path.length > 0 ? result.path : '（宿主没给路径）'
            const cut = result.truncated === true ? '（只显示最后 ' + result.bytes + ' 字节）' : ''
            setMessage({ tone: 'plain', text: '— ' + where + cut + '\n\n' + result.text })
          }
        } catch (error) {
          setMessage({ tone: 'bad', text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const head = h(
        'div',
        { style: S.row },
        h('p', { style: { ...S.title, margin: 0 } }, '轻量 harness'),
        h('span', { style: S.grow }),
        h('button', { style: S.button, onClick: load, disabled: busy !== '' }, busy === 'load' ? '读取中…' : '刷新'),
      )

      if (state.loading) return h('div', { style: S.card }, head, h('div', { style: S.hint }, '读取中…'))

      if (state.error !== undefined) {
        return h(
          'div',
          { style: S.card },
          head,
          h('div', { style: S.bad }, '读不到配置：' + state.error),
          h(
            'div',
            { style: S.hint },
            '插件装好后需要重启一次 DSH（或热重载），宿主才会把本插件的配置条目注册进设置系统。',
          ),
        )
      }

      if (draft === null) return h('div', { style: S.card }, head, h('div', { style: S.hint }, '准备中…'))

      const status = state.status ?? {}
      const takeover = status.takeover ?? {}
      const inject = status.inject ?? {}
      const provision = status.provision ?? {}
      const flags = status.flags ?? {}
      const legacy = status.legacy ?? null

      return h(
        'div',
        { style: S.card },
        head,

        // ① 状态带
        // 注意：这里刻意不放「client 宿存」徽章 —— 面板能画出来，本身就证明宿主在。
        // 真正需要「面板可能不出现」的场景（headless/sdk/acp profile）里没有面板可画，
        // 所以那条信息走启动自检那一行和日志，不走 UI。
        h(
          'div',
          { style: S.band },
          badge(takeover.tone ?? 'muted', takeover.label ?? '接管状态未知', takeover.via),
          badge(inject.chars > 0 ? 'good' : 'muted', '注入正文 ' + fmt(inject.chars) + ' 字符 · ' + (inject.source ?? 'unknown')),
          badge(provision.tone ?? 'muted', '一步到位 ' + (provision.status ?? '未知') + (provision.provider ? ' · ' + provision.provider : '')),
          badge(flags.promptTrim ? 'good' : 'muted', flags.promptTrim ? '提示词裁剪开' : '提示词裁剪关'),
          badge(flags.schemaTrim ? 'good' : 'muted', flags.schemaTrim ? 'schema 瘦身开' : 'schema 瘦身关'),
          badge(state.writable === false ? 'bad' : 'good', state.writable === false ? '设置只读' : '设置可写'),
        ),

        // ② 收益条
        h(TrimBar, { status }),

        // ②.5 旧默认值提示
        // 配置字段一旦写进 profile 就永久留着，插件分不清那是用户要的还是上一版默认值。
        // 不说这一句，用户会以为「升级了但白名单怎么还是老样子」。
        legacy !== null
          ? h(
              'div',
              { style: { ...S.hint, color: TONE.warn }, title: legacy.detail ?? '' },
              legacy.label + '（点保存可以固化；改这两个框就按你写的算）',
            )
          : null,

        state.writable === false
          ? h('div', { style: S.bad }, '宿主没有把本插件登记成可写设置条目，面板只能看不能改。重载一次插件通常能修好。')
          : null,

        state.degraded !== undefined
          ? h(
              'div',
              { style: S.hint },
              '状态视图降级：这台宿主还没加载新的 status 接口（' + state.degraded + '）。重启一次 DSH 就能看到点灯、收益条和模型导入。',
            )
          : null,

        // ③ provider 表
        h(ProviderList, {
          rows: status.providers,
          counts: status.counts,
          busy,
          onTest: test,
          onCheck: check,
          onLaunch: launch,
          onStop: stop,
          onDelete: runDelete,
          onAlign: align,
          onReconcile: reconcile,
          // [P1-27-2026-11-25] 有预览待确认时按钮变「确认对账」。
          reconcileConfirm: reconcilePending !== null,
          launchedPorts: status.launched ?? [],
        }),

        // [P1-22-2026-11-25] 文案交给 actionResultText：拉起和停止共用这一个状态，
        // 渲染处原来只按 ok 分支，停止成功也会被写成「已拉起 …」。
        launchResult !== null
          ? h(
              'div',
              // 节流拒绝既不是成功也不是失败：用提示色，别用红字。
              { style: launchResult.ok ? S.good : launchResult.throttled === true ? S.hint : S.bad },
              actionResultText(launchResult),
            )
          : null,

        // [P1-28-2026-11-25] provider 表上那些按钮（试跑 / 对齐 / 对账）的结果原来都塞进
        // importResult，而 ImportBox 画在页面更下面 —— 点完表里的按钮，回复出现在屏幕另一头，
        // 用户以为没反应又点一次。表里的动作归表里报。
        providerResult !== null
          ? h(
              'div',
              {
                style:
                  providerResult.ok === true ? S.good : providerResult.ok === undefined ? S.hint : S.bad,
                whiteSpace: 'pre-wrap',
              },
              providerResult.text,
            )
          : null,

        // ③ 本机模型一键配置（下好就能用）
        h(AdoptBox, {
          scan,
          setScan,
          busy,
          onScan: scanModels,
          onAdopt: runAdopt,
          form: adoptForm,
          setForm: setAdoptForm,
          result: adoptResult,
        }),

        // ④ 导入
        h(ImportBox, { form, setForm, busy, onProbe: probeEndpoint, onImport: runImport, result: importResult }),

        // ⑤ 高级配置（折叠）
        h(
          'details',
          { style: { marginTop: 16 } },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '高级配置'),
          h('div', { style: S.hint }, '改动即时生效，不需要重启。这里的东西平时不用动。'),

          h('p', { style: S.title }, '开关'),
          ...BOOL_ROWS.map(([key, label]) =>
            h(
              'div',
              { style: S.row, key },
              h('span', { style: S.label }, label),
              h('input', {
                type: 'checkbox',
                checked: draft.booleans[key] === true,
                onChange: (event) =>
                  setDraft((prev) => ({ ...prev, booleans: { ...prev.booleans, [key]: event.target.checked } })),
              }),
            ),
          ),
          ...NUM_ROWS.map(([key, label]) =>
            h(
              'div',
              { style: S.row, key },
              h('span', { style: S.label }, label),
              h('input', {
                type: 'number',
                min: 0,
                style: { ...S.input, maxWidth: 120 },
                value: draft.numbers[key] ?? '',
                onChange: (event) =>
                  setDraft((prev) => ({ ...prev, numbers: { ...prev.numbers, [key]: event.target.value } })),
              }),
            ),
          ),

          h(
            'div',
            { style: { margin: '10px 0' } },
            h('div', { style: { color: MUTED } }, '一键拉起命令'),
            h(
              'div',
              { style: S.hint },
              '留空 = 按端口自动找（11434 Ollama / 8090 llama.cpp / 8000 vLLM / 1234 LM Studio）。' +
                '填了就原样执行，例：ollama serve / /opt/homebrew/bin/llama-server -m a.gguf',
            ),
            h('input', {
              style: { ...S.input, width: '100%' },
              value: draft.launchCommand,
              placeholder: '留空 = 自动找',
              spellCheck: false,
              onChange: (event) => setDraft((prev) => ({ ...prev, launchCommand: event.target.value })),
            }),
          ),

          h('p', { style: S.title }, '列表'),
          ...LIST_ROWS.map(([key, label, hint]) =>
            h(
              'div',
              { key, style: { margin: '10px 0' } },
              h('div', { style: { color: MUTED } }, label),
              h('div', { style: S.hint }, hint),
              h('textarea', {
                rows: key === 'keep' || key === 'dropSections' ? 8 : 3,
                style: S.code,
                value: draft.lists[key],
                onChange: (event) =>
                  setDraft((prev) => ({ ...prev, lists: { ...prev.lists, [key]: event.target.value } })),
                spellCheck: false,
              }),
            ),
          ),

          h(
            'div',
            { style: { margin: '10px 0' } },
            h('div', { style: { color: MUTED } }, '轻量注入正文'),
            h('div', { style: S.hint }, '留空则用 ~/.dsh/local-llm/light-inject.md，再没有就用内置默认。'),
            h('textarea', {
              rows: 6,
              style: S.code,
              value: draft.injectText,
              onChange: (event) => setDraft((prev) => ({ ...prev, injectText: event.target.value })),
              spellCheck: false,
            }),
          ),

          h(
            'div',
            { style: S.row },
            h('span', { style: S.label }, '一步到位'),
            h('input', {
              type: 'checkbox',
              checked: draft.provision === true,
              onChange: (event) =>
                setDraft((prev) => ({
                  ...prev,
                  provision: event.target.checked,
                  // 取消勾选 = 明确关掉；再勾回来是「重新打开自动探测」，不该偷偷
                  // 复活那份已经被他关掉的端点配置。
                  provisionRaw: event.target.checked ? prev.provisionRaw : null,
                })),
            }),
            h(
              'span',
              { style: S.hint },
              draft.provisionRaw !== null && typeof draft.provisionRaw === 'object'
                ? '当前是自定义端点配置（' +
                    String(draft.provisionRaw.endpoint ?? draft.provisionRaw.provider ?? '见 settings') +
                    '），保存时原样保留'
                : '探测本地端点并自动注册 provider（已有可用本地 provider 时不覆盖）',
            ),
          ),
          // [P2-11-2026-11-26] 三个可选输入：以前对象形态只能手改 cordis.patch.yml。
          // 留空 = 不写这个键（交回自动探测）；三个都空就整体退回 true。
          draft.provision !== true
            ? null
            : h(
                'div',
                { style: { ...S.row, marginTop: 4, flexWrap: 'wrap' } },
                h('span', { style: S.label }, '端点（可选）'),
                h('input', {
                  style: { ...S.input, minWidth: 220 },
                  value: provisionField('endpoint'),
                  placeholder: 'http://127.0.0.1:8081/v1（留空 = 探测内置端口表）',
                  spellCheck: false,
                  onChange: (event) => setProvisionField('endpoint', event.target.value),
                }),
                h('span', { style: S.label }, 'provider id'),
                h('input', {
                  style: { ...S.input, maxWidth: 150 },
                  value: provisionField('provider'),
                  placeholder: '留空 = 自动',
                  spellCheck: false,
                  onChange: (event) => setProvisionField('provider', event.target.value),
                }),
                h('span', { style: S.label }, '显示名'),
                h('input', {
                  style: { ...S.input, maxWidth: 150 },
                  value: provisionField('displayName'),
                  placeholder: '留空 = 自动',
                  spellCheck: false,
                  onChange: (event) => setProvisionField('displayName', event.target.value),
                }),
              ),

          h(
            'div',
            { style: { ...S.row, marginTop: 14 } },
            h(
              'button',
              { style: { ...S.button, ...S.primary }, onClick: save, disabled: busy !== '' },
              busy === 'save' ? '保存中…' : '保存',
            ),
            h('button', { style: S.button, onClick: showLog, disabled: busy !== '' }, '看日志'),
            h('span', { style: S.grow }),
            h('span', { style: S.hint }, 'revision ' + (state.revision ?? '—')),
          ),
        ),

        message === null
          ? null
          : h(
              'pre',
              {
                style:
                  message.tone === 'bad'
                    ? { ...S.bad, ...S.pre }
                    : message.tone === 'good'
                      ? { ...S.good, ...S.pre }
                      : { ...S.pre },
              },
              message.text,
            ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register(
            {
              name: 'plugins.detail.section',
              id: 'dsh-local-trim-panel',
              order: 200,
              label: '轻量 harness',
            },
            Panel,
          ),
        )
      },
    }
  },
}

// [loader-guard] 原来这里是裸的 `window.__ModuleLoader__.load({...})` 顶层调用。
// 宿主的模块加载器由 dsh-client-runtime 注入到 window；注入顺序或版本一变、
// 或者这段脚本被别处当普通脚本再执行一次（热重载、面板重复挂载），
// 这一行就抛 TypeError —— 抛在顶层，整个模块求值失败，产物是
// 「面板凭空消失、控制台只有一行红字」。先判存在，缺了只报一句可读的原因。
const panelLoader = typeof window !== 'undefined' ? window.__ModuleLoader__ : undefined
if (panelLoader !== undefined && panelLoader !== null && typeof panelLoader.load === 'function') {
  panelLoader.load(PANEL_MODULE)
} else if (typeof console !== 'undefined' && typeof console.warn === 'function') {
  console.warn('[dsh-local-trim] 上层的 window.__ModuleLoader__.load 不存在，控制面板这块没有挂上（插件其余功能不受影响）')
}
