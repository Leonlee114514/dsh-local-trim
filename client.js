/**
 * dsh-local-trim 控制面板（client 半边）。
 *
 * 挂在插件详情页的 `plugins.detail.section` 槽位上：在 DSH Web 的
 * 「插件」列表里点开 dsh-local-trim，详情页底部就是这块面板。
 *
 * 浏览器里拿不到 cordis 服务，所有读写都走宿主侧注册的 HTTP bridge：
 *   POST /api/dsh-local-trim/describe
 *   POST /api/dsh-local-trim/save
 *   POST /api/dsh-local-trim/probe
 *   POST /api/dsh-local-trim/log
 */

window.__ModuleLoader__.load({
  id: 'dsh-local-trim',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BRIDGE = '/api/dsh-local-trim'
    const PACKAGE_NAME = 'dsh-local-trim'

    async function call(name, body) {
      const response = await fetch(BRIDGE + '/' + name, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error ?? 'HTTP ' + response.status)
      return payload
    }

    // ── 样式：全部内联，不依赖宿主的 CSS 变量（读不到时用兜底值） ──────────
    const BORDER = '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.16))'
    const MUTED = 'var(--dsw-alias-label-secondary, #666)'
    const S = {
      card: {
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))',
        borderRadius: 10,
        padding: '14px 16px',
        marginTop: 12,
        fontSize: 13,
        lineHeight: 1.6,
      },
      title: { fontSize: 14, fontWeight: 600, margin: '10px 0 6px' },
      row: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' },
      label: { flex: '0 0 140px', color: MUTED },
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
      primary: { background: '#247bbf', borderColor: '#247bbf', color: '#fff' },
      hint: { color: MUTED, fontSize: 12, margin: '2px 0 8px' },
      bad: { color: '#c0392b', fontSize: 12, whiteSpace: 'pre-wrap' },
      good: { color: '#1e8449', fontSize: 12 },
      pulse: { color: MUTED, fontSize: 12 },
    }

    const BOOL_ROWS = [
      ['enabled', '启用裁剪'],
      ['autoDetectBaseURL', '按 baseURL 自动识别'],
      ['promptTrim', '裁剪系统提示词'],
      ['schemaTrim', '瘦身工具 schema'],
      ['selfCheck', '启动时打印自检'],
      ['debugWrap', '包装器体积日志'],
    ]
    const NUM_ROWS = [
      ['toolDescLimit', '工具描述上限'],
      ['toolParamDescLimit', '参数描述上限'],
    ]
    const LIST_ROWS = [
      ['routes', '生效路由', '留空 = 自动识别本地端点；写名字（每行一个）就只认这些 provider。'],
      ['keep', '保留的工具', '每行一个全局工具名。scoped 注册的工具（如 ops_glob）不受这里影响。'],
      ['dropSections', '丢弃的提示词段', '每行一个 section 名，名字对不上会被静默忽略。'],
      ['dropContexts', '丢弃的 context', '每行一个 context 名。'],
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

    function Panel({ subject }) {
      const [state, setState] = React.useState({ loading: true })
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)

      const mine = subject?.kind === 'bundle' && subject?.pkg?.name === PACKAGE_NAME

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const payload = await call('describe')
          const values = payload.values ?? {}
          setState({ loading: false, ...payload })
          setDraft({
            booleans: Object.fromEntries(BOOL_ROWS.map(([key]) => [key, values[key] !== false])),
            numbers: Object.fromEntries(NUM_ROWS.map(([key]) => [key, values[key]])),
            lists: Object.fromEntries(LIST_ROWS.map(([key]) => [key, toLines(values[key])])),
            injectText: String(values.injectText ?? ''),
            provision: values.provision !== false,
          })
          setMessage(null)
        } catch (error) {
          setState({ loading: false, error: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [])

      React.useEffect(() => {
        if (mine) load()
      }, [mine, load])

      if (!mine) return null

      const buildPatch = () => {
        if (draft === null) return {}
        const out = {}
        for (const [key] of BOOL_ROWS) out[key] = draft.booleans[key] === true
        for (const [key] of NUM_ROWS) {
          const value = Number(draft.numbers[key])
          out[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
        }
        for (const [key] of LIST_ROWS) out[key] = fromLines(draft.lists[key])
        out.injectText = draft.injectText.trim()
        out.provision = draft.provision === true
        return out
      }

      const save = async () => {
        setBusy('save')
        try {
          const result = await call('save', { patch: buildPatch(), revision: state.revision })
          setMessage({
            tone: result.saved ? 'good' : 'bad',
            text: result.saved ? '已保存。下一次请求就按新配置走，不用重启。' : String(result.error ?? '保存未生效'),
          })
          await load()
        } catch (error) {
          const text = String(error?.message ?? error)
          setMessage({
            tone: 'bad',
            text: /revision|conflict/i.test(text) ? text + '（配置已被别处改过，已重新读取，请再保存一次）' : text,
          })
          await load()
        } finally {
          setBusy('')
        }
      }

      const probe = async () => {
        setBusy('probe')
        try {
          const result = await call('probe', {})
          const lines = (result.results ?? []).map((item) => {
            const models = (item.models ?? []).map((m) => m.id + '@' + m.contextWindow).join(', ')
            return (item.ok ? '✓ ' : '✗ ') + item.baseURL + (item.ok ? ' (' + models + ')' : '')
          })
          setMessage({ tone: result.ok ? 'good' : 'bad', text: lines.join('\n') })
        } catch (error) {
          setMessage({ tone: 'bad', text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const showLog = async () => {
        setBusy('log')
        try {
          const result = await call('log', { bytes: 6000 })
          setMessage({ tone: 'plain', text: '— ' + result.path + '\n\n' + result.text })
        } catch (error) {
          setMessage({ tone: 'bad', text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const head = h(
        'div',
        { style: S.row },
        h('p', { style: { ...S.title, margin: 0 } }, '轻量 harness 控制面板'),
        h('span', { style: S.grow }),
        h('button', { style: S.button, onClick: load, disabled: busy !== '' }, busy === 'load' ? '读取中…' : '重新读取'),
      )

      if (state.loading) return h('div', { style: S.card }, head, h('div', { style: S.pulse }, '读取中…'))

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

      if (draft === null) return h('div', { style: S.card }, head, h('div', { style: S.pulse }, '准备中…'))

      const status = h(
        'div',
        { style: S.hint },
        [
          '生效路由：' +
            (state.autoDetect
              ? '自动识别（baseURL 指向回环/私有网段，或名字带 local 等标记）'
              : (state.routes ?? []).join(', ') || '（空）'),
          '注入正文：' + (state.lightBody?.chars ?? 0) + ' 字符 · 来源 ' + (state.lightBody?.source ?? 'unknown'),
          '一步到位：' + (state.provision?.detail || state.provision?.status || '未知'),
          state.logPath ? '日志：' + state.logPath : '',
        ]
          .filter(Boolean)
          .join('　·　'),
      )

      return h(
        'div',
        { style: S.card },
        head,
        status,
        state.writable === false
          ? h(
              'div',
              { style: S.bad },
              '宿主没有把本插件登记成可写设置条目，面板只能看不能改。重载一次插件通常能修好。',
            )
          : null,

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
            onChange: (event) => setDraft((prev) => ({ ...prev, provision: event.target.checked })),
          }),
          h('span', { style: S.hint }, '探测本地端点并自动注册 provider（已有可用本地 provider 时不覆盖）'),
        ),

        h(
          'div',
          { style: { ...S.row, marginTop: 14 } },
          h(
            'button',
            { style: { ...S.button, ...S.primary }, onClick: save, disabled: busy !== '' },
            busy === 'save' ? '保存中…' : '保存',
          ),
          h('button', { style: S.button, onClick: probe, disabled: busy !== '' }, busy === 'probe' ? '探测中…' : '探测本地端点'),
          h('button', { style: S.button, onClick: showLog, disabled: busy !== '' }, '看日志'),
          h('span', { style: S.grow }),
          h('span', { style: S.hint }, 'revision ' + (state.revision ?? '—')),
        ),

        message === null
          ? null
          : h(
              'pre',
              {
                style:
                  message.tone === 'bad'
                    ? { ...S.bad, marginTop: 10 }
                    : message.tone === 'good'
                      ? { ...S.good, marginTop: 10, whiteSpace: 'pre-wrap' }
                      : { ...S.code, marginTop: 10, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' },
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
})
