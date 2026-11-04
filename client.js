/**
 * dsh-local-trim 控制面板（client 半边）。
 *
 * 挂在插件详情页的 `plugins.detail.section` 槽位上：在 DSH Web 的
 * 「插件」列表里点开 dsh-local-trim，详情页底部就是这块面板。
 *
 * 浏览器里拿不到 cordis 服务，所有读写都走宿主侧注册的 HTTP bridge（12 条，全部 POST）：
 *   status   接管状态 + 裁剪收益 + provider 表 + 本插件起过的后端（主视图）
 *   check    给 provider 点灯（GET /v1/models）
 *   probe    批量探测默认端口
 *   import   导入本地模型：探测 → 写 settings → 试跑
 *   test     对已注册 provider 发一次最小真实请求
 *   save     写回高级配置
 *   describe 老宿主的兼容读取（没有 status 时降级用）
 *   log      读日志尾部
 *   models   扫本机 .gguf（带每个模型的资源预检）
 *   adopt    一键配置：起服务 → 等应答 → 注册 provider → 试跑
 *   launch   对已有 provider 拉起后端
 *   stop     只停本插件自己 spawn 的那个 pid
 *
 * 版面顺序按「一眼看状态 → 想动手时再动手」排：
 *   状态带 → 收益条 → provider 表（点灯/试跑/拉起/停止）→ 本机模型一键配置
 *   → 端点导入 → 折叠的高级配置。
 *
 * 文案只有中文。这是有意选择：插件面向中文使用者，硬塞一套英文会多出一半
 * 需要同步的字符串，却没有第二个读者。要加语言时，把这里的字面量搬进
 * 一个 `const TEXT = { zh: {...} }` 就行，位置都在本文件内。
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
      ['launchTimeout', '拉起后等端口（秒）'],
      // 预检给系统留多少：桌面默认 2048 合理，Linux 服务器该能调小，这里得让用户改得到。
      ['reserveMb', '预检预留内存（MiB，0 = 不预留）'],
    ]
    const LIST_ROWS = [
      ['routes', '生效路由', '留空 = 自动识别本地端点；写名字（每行一个）就只认这些 provider。'],
      ['keep', '保留的工具', '每行一个全局工具名。scoped 注册的工具（如 ops_glob）不受这里影响。'],
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

    // ── 收益条 ────────────────────────────────────────────────────────────
    function TrimBar({ status }) {
      const trim = status?.trim ?? {}
      if (trim.seen !== true) {
        return h('div', { style: S.trim }, h('span', { style: S.hint }, '还没有裁剪记录。走一次本地模型请求后这里会显示进→出的字符数。'))
      }
      const savedPct = Number(trim.savedPct) || 0
      const width = Math.max(0, Math.min(100, savedPct))
      return h(
        'div',
        { style: S.trim },
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
        h('span', { style: { ...S.hint, fontWeight: 600 } }, savedPct > 0 ? '省 ' + savedPct + '%' : '未裁剪'),
        h(
          'span',
          { style: S.hint },
          [(trim.sectionsIn ?? 0) + '→' + (trim.sectionsOut ?? 0) + ' 段', trim.provider ? 'provider ' + trim.provider : '', clock(trim.at)]
            .filter(Boolean)
            .join(' · '),
        ),
      )
    }

    // ── provider 表 ───────────────────────────────────────────────────────
    function ProviderList({ rows, counts, busy, onTest, onCheck, onLaunch, onStop, launchedPorts }) {
      const list = Array.isArray(rows) ? rows : []
      const mine = new Set(Array.isArray(launchedPorts) ? launchedPorts.map((item) => Number(item?.port ?? item)) : [])
      const portOf = (row) => Number(String(row?.baseURL ?? '').replace(/^.*:(\d+).*$/, '$1')) || 0
      return h(
        'div',
        null,
        h(
          'div',
          { style: { ...S.row, margin: '10px 0 4px' } },
          h('span', { style: { fontWeight: 600 } }, '模型 provider'),
          h('span', { style: S.hint }, `共 ${counts?.total ?? 0} 个 · 本地 ${counts?.local ?? 0} 个 · 在线 ${counts?.online ?? 0} 个`),
          h('span', { style: S.grow }),
          h('button', { style: S.small, onClick: onCheck, disabled: busy !== '' }, busy === 'check' ? '检测中…' : '重新检测'),
        ),
        list.length === 0
          ? h('div', { style: S.hint }, 'settings 里还没有 provider。下面填端点导入一个试试。')
          : list.map((row) =>
              h(
                'div',
                { style: S.provider, key: row.id },
                badge(row.state?.tone ?? 'muted', '', row.state?.label ?? ''),
                h('span', { style: { fontWeight: 600 } }, row.displayName || row.id),
                h('span', { style: { ...S.mono, color: MUTED } }, row.baseURL),
                h('span', { style: S.hint }, row.modelCount + ' 模型' + (row.contextWindow ? ' · ctx ' + fmt(row.contextWindow) : '')),
                row.local ? h('span', { style: S.hint }, '· 本地') : null,
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
    function AdoptBox({ scan, setScan, busy, onScan, onAdopt, onDelete, form, setForm, result }) {
      // allModels 是磁盘上全部 gguf（含 mmproj，用来删）；models 只留能当主模型的那些。
      const allModels = Array.isArray(scan?.models) ? scan.models : []
      const models = Array.isArray(scan?.models) ? scan.models.filter((item) => item.mmproj !== true) : []
      const chosen = models.find((item) => item.path === form.modelPath)
      const gib = (bytes) => {
        const value = Number(bytes)
        if (!Number.isFinite(value) || value <= 0) return '?'
        if (value >= 1073741824) return (value / 1073741824).toFixed(1) + 'GB'
        if (value >= 1048576) return Math.round(value / 1048576) + 'MB'
        return Math.round(value / 1024) + 'KB'
      }
      const fit = chosen?.fit
      const heavy = fit?.level === 'risky'
      // 删文件不可撤销，点一次只进入「确认」态，第二次才真删。
      const [pendingDelete, setPendingDelete] = React.useState('')
      // busy 的形态是 delete:<绝对路径>，所以能判断具体哪一行在删。
      const deletingPath = busy.startsWith('delete:') ? busy.slice('delete:'.length) : ''
      return h(
        'div',
        { style: { marginTop: 14 } },
        h('div', { style: { fontWeight: 600, margin: '4px 0' } }, '本机模型 · 一键配置'),
        h(
          'div',
          { style: S.hint },
          '列出这台机器上已经下好的 .gguf，选一个，插件替你起 llama-server、写进 provider、再试跑一次。不用先有端点。',
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
                  ? '没找到 .gguf。找过：' + (scan.dirs ?? []).join(' / ')
                  : `找到 ${allModels.length} 个` +
                    (allModels.length > models.length
                      ? `（其中 ${allModels.length - models.length} 个是视觉投影 mmproj，只能删不能选）`
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
                ...allModels.map((item) => {
                  const picked = item.path === form.modelPath
                  const askDelete = pendingDelete === item.path
                  return h(
                    'div',
                    {
                      key: item.path,
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
                          ? '视觉投影（mmproj）不能单独当主模型用，只能删'
                          : item.path,
                        disabled: busy !== '' || item.mmproj === true,
                        onClick: () => {
                          if (item.mmproj === true) return
                          // 点别的行 = 放弃那次「确认删除？」
                          if (pendingDelete !== '' && pendingDelete !== item.path) setPendingDelete('')
                          setForm({ ...form, modelPath: item.path })
                        },
                      },
                      (item.mmproj === true ? '· ' : picked ? '● ' : '○ ') + item.name,
                    ),
                    h('span', { style: { ...S.hint, flexShrink: 0 } }, gib(item.sizeBytes)),
                    item.fit?.level === 'risky' ? h('span', { style: { ...S.hint, color: RED, flexShrink: 0 } }, '偏大') : null,
                    item.mmproj === true
                      ? h('span', { style: { ...S.hint, flexShrink: 0 } }, '视觉投影')
                      : null,
                    // 删除：先问一次，再动手
                    h(
                      'button',
                      {
                        style: {
                          ...S.small,
                          flexShrink: 0,
                          ...(askDelete ? { color: RED, borderColor: RED } : {}),
                        },
                        title: askDelete
                          ? '再点一次就真删了（不进回收站）'
                          : '把这个 .gguf 从磁盘删掉',
                        disabled: busy !== '',
                        onClick: () => {
                          if (!askDelete) {
                            setPendingDelete(item.path)
                            return
                          }
                          setPendingDelete('')
                          onDelete(item)
                        },
                      },
                      deletingPath === item.path
                        ? '删除中…'
                        : askDelete
                          ? '确认删除？'
                          : '删除',
                    ),
                  )
                }),
              ),
            ),
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
                onChange: (event) => setForm({ ...form, port: event.target.value }),
              }),
              h('input', {
                style: { ...S.input, maxWidth: 110 },
                value: String(form.contextWindow),
                spellCheck: false,
                onChange: (event) => setForm({ ...form, contextWindow: event.target.value }),
              }),
              h(
                'label',
                { style: { ...S.hint, display: 'inline-flex', gap: 6, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: form.thinking === true,
                  onChange: (event) => setForm({ ...form, thinking: event.target.checked }),
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
                  onChange: (event) => setForm({ ...form, loadMode: event.target.value }),
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
                      onChange: (event) => setForm({ ...form, confirmHeavy: event.target.checked }),
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
                : h('span', { style: S.hint }, '别名取文件名：' + chosen.name.replace(/\.gguf$/i, '')),
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
            onChange: (event) => setForm({ ...form, endpoint: event.target.value, models: [], model: '' }),
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
                  onChange: (event) => setForm({ ...form, model: event.target.value }),
                },
                h('option', { value: '' }, '选一个（' + models.length + ' 个可用）'),
                ...models.map((id) => h('option', { key: id, value: id }, id)),
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
            onChange: (event) => setForm({ ...form, provider: event.target.value }),
          }),
          h(
            'label',
            { style: { ...S.hint, display: 'inline-flex', gap: 6, alignItems: 'center' } },
            h('input', {
              type: 'checkbox',
              checked: form.thinking === true,
              onChange: (event) => setForm({ ...form, thinking: event.target.checked }),
            }),
            '保留思考模式',
          ),
          h(
            'label',
            { style: { ...S.hint, display: 'inline-flex', gap: 6, alignItems: 'center' } },
            h('input', {
              type: 'checkbox',
              checked: form.overwrite === true,
              onChange: (event) => setForm({ ...form, overwrite: event.target.checked }),
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
      const [busy, setBusy] = React.useState('')
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

      const mine = subject?.kind === 'bundle' && subject?.pkg?.name === PACKAGE_NAME

      const applyValues = React.useCallback((values, extra) => {
        setDraft({
          booleans: Object.fromEntries(BOOL_ROWS.map(([key]) => [key, values[key] !== false])),
          numbers: Object.fromEntries(NUM_ROWS.map(([key]) => [key, values[key]])),
          lists: Object.fromEntries(LIST_ROWS.map(([key]) => [key, toLines(values[key])])),
          injectText: String(values.injectText ?? ''),
          launchCommand: String(values.launchCommand ?? ''),
          provision: values.provision !== false,
        })
        setState({ loading: false, ...extra })
      }, [])

      const load = React.useCallback(async () => {
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
          const values = payload.values ?? payload.status?.values ?? {}
          applyValues(values, {
            status: payload.status ?? null,
            values,
            revision: payload.revision,
            writable: payload.writable,
            degraded: payload._degraded,
          })
          setMessage(null)
        } catch (error) {
          setState({ loading: false, error: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [applyValues])

      React.useEffect(() => {
        if (mine) load()
      }, [mine, load])

      if (!mine) return null

      // 刷新状态一律带上点灯：服务端有 15 秒缓存，多问一次不疼；
      // 只拿 online:false 会把所有灯刷成「未检测」，顺便把「拉起」一起弄没。
      const refreshStatus = async () => {
        try {
          const payload = await call('status', {})
          setState((prev) => ({ ...prev, status: payload.status ?? prev.status, revision: payload.revision ?? prev.revision }))
        } catch {
          /* 状态刷新失败不影响已显示的内容 */
        }
      }

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
          setLaunchResult(result)
          await refreshStatus()
        } catch (error) {
          setLaunchResult({ ok: false, error: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      // 停止：只停本插件自己 spawn 的那个 pid（服务端有白名单，别人的后端不动）
      const stop = async (row) => {
        setBusy('stop:' + row.id)
        setLaunchResult(null)
        try {
          const port = Number(String(row.baseURL ?? '').replace(/^.*:(\d+).*$/, '$1')) || 0
          const result = await call('stop', { port })
          setLaunchResult(result.ok === true ? { ...result, message: result.message } : result)
          await refreshStatus()
        } catch (error) {
          setLaunchResult({ ok: false, error: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const test = async (row) => {        setBusy('test:' + row.id)
        setImportResult({
          ok: true,
          text: '正在对 ' + row.id + ' 发一条真实请求…',
        })
        try {
          const result = await call('test', { provider: row.id })
          const smoke = result.smoke ?? {}
          setImportResult({
            ok: result.ok === true,
            text:
              result.ok === true
                ? `✓ ${row.id} · ${smoke.ms ?? '?'}ms · 回复「${smoke.text ?? ''}」` +
                  (smoke.completionTokens ? ` · ${smoke.completionTokens} tokens` : '')
                : `✗ ${row.id} · ${smoke.error ?? result.error ?? '失败'}`,
          })
          await refreshStatus()
        } catch (error) {
          setImportResult({ ok: false, text: String(error?.message ?? error) })
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
                    ? '\n' + (first.attempts ?? []).map((item) => `${item.url ?? ''} ${item.error ?? ''}`).join('\n')
                    : ''),
          })
        } catch (error) {
          setImportResult({ ok: false, text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const scanModels = React.useCallback(async () => {
        setBusy('scan')
        setMessage(null)
        try {
          const result = await call('models', {})
          setScan(result)
          setAdoptForm((prev) => {
            if (prev.modelPath !== '') return prev
            const first = (result.models ?? []).find((item) => item.mmproj !== true)
            return first === undefined ? prev : { ...prev, modelPath: first.path }
          })
        } catch (error) {
          setMessage({ tone: 'bad', text: '扫描失败：' + String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }, [])

      /**
       * 删一个模型文件。
       *
       * 只有连点两次才会到这里（第一次在 AdoptBox 里变成「确认删除？」）。
       * 删成功就重扫一次：让列表反映磁盘真实状态，而不是本地先抹掉一行。
       */
      const runDelete = React.useCallback(
        async (item) => {
          const target = String(item?.path ?? '')
          if (target.length === 0) return
          setBusy('delete:' + target)
          setMessage(null)
          try {
            const result = await call('delete', { path: target })
            if (result.ok !== true) {
              setMessage({ tone: 'bad', text: '没删成：' + String(result.error ?? '不知道原因') })
              return
            }
            const bytes = Number(result.freedBytes)
            const freed =
              !Number.isFinite(bytes) || bytes <= 0
                ? ''
                : bytes >= 1073741824
                  ? (bytes / 1073741824).toFixed(1) + 'GB'
                  : bytes >= 1048576
                    ? Math.round(bytes / 1048576) + 'MB'
                    : Math.round(bytes / 1024) + 'KB'
            const extra =
              Array.isArray(result.users) && result.users.length > 0
                ? '；还有 provider 指着它：' + result.users.join('、') + '（配置没动）'
                : ''
            setMessage({
              tone: 'good',
              text: (freed.length > 0 ? '已删除，腾出 ' + freed : '已删除') + extra,
            })
            if (form.modelPath === target) setAdoptForm((prev) => ({ ...prev, modelPath: '' }))
            setAdoptResult(null)
            await scanModels()
          } catch (error) {
            setMessage({ tone: 'bad', text: '删除失败：' + String(error?.message ?? error) })
          } finally {
            setBusy('')
          }
        },
        [form.modelPath, scanModels],
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
      }, [adoptForm, load])

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
          await load()
        } catch (error) {
          setImportResult({ ok: false, text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

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
        out.launchCommand = draft.launchCommand.trim()
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

      return h(
        'div',
        { style: S.card },
        head,

        // ① 状态带
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
          launchedPorts: status.launched ?? [],
        }),

        launchResult !== null
          ? h(
              'div',
              { style: launchResult.ok ? S.good : S.bad },
              launchResult.ok
                ? launchResult.already
                  ? launchResult.message
                  : `已拉起 ${launchResult.label}（pid ${launchResult.pid}），${launchResult.ms}ms 后端口 ${launchResult.port} 应答` +
                    (Array.isArray(launchResult.models) && launchResult.models.length > 0
                      ? '：' + launchResult.models.join(', ')
                      : '') +
                    // 参数被裁或走了老引擎那套，要在这里说清楚 —— 否则用户以为插件漏拼了
                    (Array.isArray(launchResult.dropped) && launchResult.dropped.length > 0
                      ? '（你的 llama.cpp 不认 ' + launchResult.dropped.join(' / ') + '，已跳过）'
                      : '') +
                    (launchResult.modernEngine === false ? '（老版本引擎：分层数用 99，不下发 KV 量化）' : '')
                : `拉起失败：${launchResult.error}` +
                  (Array.isArray(launchResult.tried) && launchResult.tried.length > 0
                    ? '（找过：' + launchResult.tried.join(' / ') + '）'
                    : ''),
            )
          : null,

        // ③ 本机模型一键配置（下好就能用）
        h(AdoptBox, {
          scan,
          setScan,
          busy,
          onScan: scanModels,
          onAdopt: runAdopt,
          onDelete: runDelete,
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
})
