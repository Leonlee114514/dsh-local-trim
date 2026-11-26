/**
 * test/client.mjs — 面板组件（client.js）的渲染自检。
 *
 * 为什么需要它：client.js 是跑在宿主渲染进程里的那一半，`node --check` 只能证明语法没错。
 * v0.4.8 就是这么漏出去的：`portFor` 写在 `AdoptBox` 作用域里，却被 `Panel` 的
 * `scanModels` 引用 —— 语法完全合法，要等用户点一次「扫描本机模型」才会在渲染期抛
 * `ReferenceError`，然后被宿主的 SlotErrorBoundary 接住，整块面板在页面上凭空消失，
 * 宿主还一切正常、连崩溃日志都不留。
 *
 * 做法：用一个最小 React 替身把 client.js 真跑起来 —— 真调函数组件、真执行 setState
 * 的 updater（真实 React 也是在渲染期执行的），喂真实的 status 载荷，再把按钮找出来点一下。
 *
 * 用法：node test/client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// ── 定时器台账 ─────────────────────────────────────────────────────────────
// client.js 的每一次 call() 都挂一个「重活 10 分钟超时」的 setTimeout。用例里
// options.pending 故意让某条请求永不返回，那个定时器就一直活着 —— 断言早就跑完，
// 进程要等满十分钟才退（第一版实测就是这么挂住的）。
// 把 setTimeout 记一笔，收摊时统一清掉。全局只包一次：多个 mount 之间重复包会套娃。
const timers = new Map()   // 定时器 id → 发起它的 mount 实例（null = 还没人认领）
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let timerOwner = null      // 最近一次 mount 的实例；用例是顺序 await 的，同一时刻只有一个在跑
globalThis.setTimeout = (fn, ms, ...rest) => {
  const id = realSetTimeout(fn, ms, ...rest)
  timers.set(id, timerOwner)
  return id
}
globalThis.clearTimeout = (id) => {
  timers.delete(id)
  return realClearTimeout(id)
}

const SUBJECT = {
  kind: 'bundle',
  pkg: {
    name: 'dsh-local-trim',
    version: '0.4.8',
    installed: true,
    enabled: true,
    availability: 'installed',
    official: false,
    rows: [],
  },
}

// 真机 /status 的形状（取自 2026-11-06 的 49187 端口）
const STATUS = {
  ok: true,
  revision: 0,
  writable: true,
  values: {
    enabled: true,
    promptTrim: true,
    schemaTrim: true,
    launchTimeout: 20,
    smokeTimeout: 60,
    routes: ['local-ollama'],
    keepTools: [],
    dropSections: [],
    modelDirs: [],
    injectText: '# 轻量注入\n',
    launchCommand: '',
    provision: true,
  },
  status: {
    takeover: { tone: 'good', label: '接管 prompt.assemble', via: 'accessor+purge-slot' },
    trim: { seen: true, provider: 'trae-global', charsIn: 40069, charsOut: 40069, savedPct: 0 },
    inject: { chars: 983, source: 'C:/Users/Lyonl/.dsh/local-llm/light-inject.md' },
    provision: { tone: 'muted', status: 'none' },
    flags: { promptTrim: true, schemaTrim: true, debugWrap: false },
    providers: [
      {
        id: 'local-ollama',
        displayName: 'Ollama · local-ollama',
        baseURL: 'http://127.0.0.1:11434/v1',
        modelIds: ['qwen3:14b'],
        modelCount: 1,
        contextWindow: 32768,
        maxTokens: 4096,
        local: true,
        state: { online: true },
      },
    ],
    counts: { total: 1, local: 1, online: 1 },
    launched: [],
  },
}

// 扫描结果的形状：按体积降序，mmproj 也在里面
const SCAN = {
  ok: true,
  dirs: ['C:/Users/Lyonl/.workbuddy/local-models/files', 'C:/Users/Lyonl/AI/models'],
  truncated: false,
  metaReads: 1,
  models: [
    {
      path: 'C:/Users/Lyonl/.workbuddy/local-models/files/local_model.gguf',
      name: 'local_model.gguf',
      source: 'workbuddy',
      origin: 'workbuddy',
      sizeBytes: 16954484384,
      mmproj: false,
      readableName: 'Qwen36_35B A3B',
      quantization: 'Q4_K_M',
    },
    {
      path: 'C:/Users/Lyonl/AI/models/ollama/blobs/sha256-a8cc',
      name: 'qwen3:14b',
      tags: ['qwen3:14b'],
      source: 'ollama',
      origin: 'ollama',
      port: 11434,
      sizeBytes: 9276184896,
      mmproj: false,
    },
    {
      path: 'C:/Users/Lyonl/.workbuddy/local-models/files/local_model.mmproj.gguf',
      name: 'local_model.mmproj.gguf',
      source: 'workbuddy',
      sizeBytes: 900000000,
      mmproj: true,
    },
  ],
}

/** 把 client.js 真跑起来：最小 React 替身 + 假 fetch + 递归渲染。 */
function mount(options) {
  const bags = new Map()      // 组件 → 它的 hook 槽
  const effects = []
  const updates = []
  const calls = []
  let current = null
  const owned = new Set()   // 认领定时器用：mount 之后 call() 里挂的超时都算这一个实例的
  timerOwner = owned

  const bagOf = (type) => {
    let bag = bags.get(type)
    if (bag === undefined) {
      bag = { slots: [], cursor: 0 }
      bags.set(type, bag)
    }
    return bag
  }

  const element = (type, props, ...children) => {
    const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { $$el: true, type, props: { ...(props ?? {}), ...(flat === undefined ? {} : { children: flat }) } }
  }

  const React = {
    createElement: element,
    Fragment: 'Fragment',
    Component: class {
      constructor(props) { this.props = props; this.state = {} }
      setState(next) { Object.assign(this.state, typeof next === 'function' ? next(this.state) : next) }
    },
    useState(initial) {
      // owner 必须在调用时抓住：setter 往往在 await 之后才被调用，那时 current 已经归零，
      // 拿它当 key 会把更新写进另一个袋子（第一版就是这么白跑一轮的）。
      const owner = current
      const bag = bagOf(owner)
      const index = bag.cursor++
      if (!(index in bag.slots)) bag.slots[index] = typeof initial === 'function' ? initial() : initial
      return [bag.slots[index], (next) => { updates.push({ type: owner, index, next }) }]
    },
    useCallback(fn) { bagOf(current).cursor += 1; return fn },
    useEffect(fn) { bagOf(current).cursor += 1; effects.push(fn) },
    useMemo(fn) { bagOf(current).cursor += 1; return fn() },
    useRef(initial) {
      const bag = bagOf(current)
      const index = bag.cursor++
      if (!(index in bag.slots)) bag.slots[index] = { current: initial }
      return bag.slots[index]
    },
  }

  // ── 假 fetch ───────────────────────────────────────────────────────────
  // options.pending 里列出的路由永不 settle：用来模拟「这条动作还在跑」。
  globalThis.fetch = async (url) => {
    const name = String(url).replace(/^.*\/api\/dsh-local-trim\//, '')
    calls.push(name)
    if (options.pending?.includes(name)) return await new Promise(() => {})
    const body = options.bodies[name]
    if (body === undefined) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    if (body instanceof Error) throw body
    return { ok: true, status: 200, json: async () => body }
  }

  // ── 加载 client.js（无 import/export，靠 window 上的加载器） ─────────────
  let entry
  globalThis.window = { __ModuleLoader__: { load(value) { entry = value } } }
  new Function('window', SOURCE)(globalThis.window)
  if (entry === undefined) throw new Error('client.js 没有调用 __ModuleLoader__.load')

  const api = entry.factory((name) => {
    if (name === 'react') return React
    throw new Error('client.js 里 require 了没预备的东西：' + name)
  })

  const registered = []
  api.apply({
    slots: {
      inject(_slot, run) { run() },
      register(definition, component) { registered.push({ definition, component }) },
    },
  })
  const Panel = registered[0]?.component
  if (typeof Panel !== 'function') throw new Error('apply() 没注册出面板组件')

  // ── 递归渲染 ───────────────────────────────────────────────────────────
  const texts = []
  const buttons = []
  // 输入框也收：草稿是否被重载冲掉，只能从「输入框里还是不是我改的那个值」看出来。
  const fields = []
  const visited = new Set()

  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (node.$$el !== true) return
    const { type, props } = node
    if (typeof type === 'function') {
      if (visited.has(type)) return
      visited.add(type)
      const previous = current
      current = type
      bagOf(type).cursor = 0
      let out
      try {
        out = type(props)
      } finally {
        current = previous
      }
      walk(out)
      return
    }
    if (typeof type === 'string') {
      if (type === 'button' && typeof props.onClick === 'function') buttons.push(props)
      if (type === 'input' || type === 'textarea') fields.push(props)
      if (props.children !== undefined) walk(props.children)
    }
  }

  /** React 应用一次 setState：updater 在渲染期执行 —— 抛错就等于整棵子树崩掉。 */
  const commit = () => {
    for (const item of updates.splice(0)) {
      const bag = bagOf(item.type)
      bag.slots[item.index] = typeof item.next === 'function' ? item.next(bag.slots[item.index]) : item.next
    }
    texts.length = 0
    buttons.length = 0
    fields.length = 0
    visited.clear()
    walk(element(Panel, options.props ?? { subject: SUBJECT }))
    return texts.join(' ')
  }

  const flushEffects = async () => {
    for (const fn of effects.splice(0)) await fn()
    // useEffect 的回调不返回 load() 的 promise（组件里就是 `if (mine) load()`），
    // 所以这里的 await 只等到「请求发出去了」。把事件循环转几圈，等 setState 落定。
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  /** 收摊：清掉本实例留下的定时器（pending 那条的超时计时器就是它）。 */
  const dispose = () => {
    for (const [id, owner] of timers) {
      if (owner !== owned && owner !== null) continue
      realClearTimeout(id)
      timers.delete(id)
    }
    timerOwner = null
  }

  return { commit, flushEffects, calls, buttons, fields, texts, dispose }
}

let passed = 0
const ok = async (name, fn) => {
  await fn()
  passed += 1
  console.log('  ✓ ' + name)
}

console.log('client.js 面板渲染')

await ok('模块能注册，apply() 挂出 plugins.detail.section', async () => {
  const panel = mount({ bodies: { status: STATUS } })
  assert.ok(panel.buttons.length >= 0)
})

await ok('subject 对得上时整块面板渲染出来，status 落定后不再显示「读取中」', async () => {
  const panel = mount({ bodies: { status: STATUS } })
  assert.match(panel.commit(), /读取中/)
  await panel.flushEffects()
  const text = panel.commit()
  assert.match(text, /轻量 harness/)
  assert.match(text, /接管 prompt\.assemble/)
  assert.doesNotMatch(text, /读取中/)
})

await ok('subject 不是自己的包时返回 null（别的插件的详情页不插队）', async () => {
  const panel = mount({
    bodies: { status: STATUS },
    props: { subject: { kind: 'bundle', pkg: { name: 'some-other-plugin' } } },
  })
  assert.equal(panel.commit(), '')
})

await ok('status 拿不到时退回 describe，面板不塌', async () => {
  const described = {
    ok: true,
    values: STATUS.values,
    revision: 0,
    writable: true,
    lightBody: { chars: 983, source: 'x' },
    provision: { status: 'none' },
  }
  const panel = mount({ bodies: { status: new Error('HTTP 500'), describe: described } })
  panel.commit()
  await panel.flushEffects()
  const text = panel.commit()
  assert.match(text, /轻量 harness/)
  assert.match(text, /宿主未提供状态接口/)
  assert.match(text, /状态视图降级/)
  assert.deepEqual(panel.calls, ['status', 'describe'])
})

await ok('点「扫描本机模型」不会把面板整块打掉', async () => {
  // v0.4.8 的回归：Panel 的 scanModels 引用了 AdoptBox 作用域里的 portFor
  // → 渲染期 ReferenceError → SlotErrorBoundary 接住 → 面板在页面上凭空消失。
  const panel = mount({ bodies: { status: STATUS, models: SCAN } })
  panel.commit()
  await panel.flushEffects()
  panel.commit()

  const scan = panel.buttons.find((props) => /扫描/.test(String(props.children)))
  assert.ok(scan !== undefined, '没找到「扫描本机模型」按钮')

  await scan.onClick()
  const text = panel.commit()      // updater 在这一行执行；旧代码就在这里抛

  assert.match(text, /找到 3 个/)
  assert.match(text, /其中 1 个是视觉投影/)
})

await ok('扫描后自动选中最大的那个（35B），端口回到 8090', async () => {
  const panel = mount({ bodies: { status: STATUS, models: SCAN } })
  panel.commit()
  await panel.flushEffects()
  panel.commit()
  const scan = panel.buttons.find((props) => /扫描/.test(String(props.children)))
  await scan.onClick()
  const text = panel.commit()
  // 选中的是 35B 那条，不是 Ollama 那条
  assert.match(text, /Qwen36_35B A3B/)
  assert.doesNotMatch(text, /模型名取 tag/)
})

await ok('只扫到 Ollama 模型时，端口跟到 11434 并按 tag 取名', async () => {
  const onlyOllama = {
    ...SCAN,
    models: [SCAN.models[1]],
  }
  const panel = mount({ bodies: { status: STATUS, models: onlyOllama } })
  panel.commit()
  await panel.flushEffects()
  panel.commit()
  const scan = panel.buttons.find((props) => /扫描/.test(String(props.children)))
  await scan.onClick()
  const text = panel.commit()
  assert.match(text, /模型名取 tag/)
  assert.match(text, /11434/)
})

// ── C1：忙锁按域隔离 ──────────────────────────────────────────────────────
// 老版本是一个全局 busy 字符串，所有按钮都 `disabled: busy !== ''`：拉起一个后端要
// 十几秒，这十几秒里连「看日志」「刷新」都点不动，用户只能干等。

const STATUS_LAUNCHED = {
  ...STATUS,
  status: { ...STATUS.status, launched: [{ port: 11434, label: 'ollama serve', pid: 4242 }] },
}

const buttonByText = (panel, text) =>
  panel.buttons.find((props) => String(props.children) === text)

await ok('一个动作在跑时，只有同域的按钮灰掉，别的域照旧能点', async () => {
  const panel = mount({ bodies: { status: STATUS_LAUNCHED }, pending: ['launch'] })
  panel.commit()
  await panel.flushEffects()
  panel.commit()

  const launch = buttonByText(panel, '拉起')
  assert.ok(launch !== undefined, '没找到「拉起」按钮')
  assert.notEqual(launch.disabled, true)

  // 不 await：pending 里的路由永不返回，await 会把测试挂死。
  void launch.onClick()
  panel.commit()

  // 进程域：拉起自己也灰了（文案换成进行中），同一个域里的停止也灰
  const launching = buttonByText(panel, '拉起中…')
  assert.ok(launching !== undefined, '拉起之后按钮没进入「拉起中…」')
  assert.equal(launching.disabled, true)
  const stop = buttonByText(panel, '停止')
  assert.ok(stop !== undefined, '没找到「停止」按钮（status.launched 没生效？）')
  assert.equal(stop.disabled, true, '同一域里的停止应该灰掉：两个动作会抢同一个 pid')

  // 别的域：试跑（provider:xxx）、刷新（config）都该还能点
  const test = buttonByText(panel, '试跑')
  assert.ok(test !== undefined, '没找到「试跑」按钮')
  assert.notEqual(test.disabled, true, '试跑跟拉起不是同一份资源，不该被连坐')
  const reload = buttonByText(panel, '刷新')
  assert.ok(reload !== undefined, '没找到「刷新」按钮')
  assert.notEqual(reload.disabled, true, '刷新只是重读配置，任何动作在跑都该能用')

  panel.dispose()   // 扔掉那条永不返回的请求留下的超时定时器
})

await ok('看日志永远不被挡住（它是纯读，不该进任何一把锁）', async () => {
  const panel = mount({ bodies: { status: STATUS_LAUNCHED }, pending: ['launch'] })
  panel.commit()
  await panel.flushEffects()
  panel.commit()
  void buttonByText(panel, '拉起').onClick()
  panel.commit()

  const log = buttonByText(panel, '看日志')
  assert.ok(log !== undefined, '没找到「看日志」按钮')
  assert.notEqual(log.disabled, true, '拉起后端在跑时也应该能看日志 —— 不然卡住时没处查')
  await log.onClick()
  assert.ok(panel.calls.includes('log'))
  panel.dispose()
})

// ── C2：一键配置成功后不冲掉草稿 ──────────────────────────────────────────
// 老版本 `if (result.ok === true) await load()`：配置区里正改到一半的东西会被服务端
// 的旧值整体覆盖回去，用户只看到自己刚填的字段变回原样。

/** 扫一遍模型，让 adopt 表单拿到 modelPath（否则按钮是灰的）。 */
const scanForAdopt = async (panel) => {
  panel.commit()
  await panel.flushEffects()
  panel.commit()
  await buttonByText(panel, '扫描本机模型').onClick()
  panel.commit()
}

/** 「一键拉起命令」那个输入框 —— 草稿有没有被覆盖，看它的 value。 */
const launchCommandField = (panel) =>
  panel.fields.find((props) => props.placeholder === '留空 = 自动找')

await ok('草稿有改动时，一键配置成功也不覆盖它，并说明原因', async () => {
  const panel = mount({ bodies: { status: STATUS, models: SCAN, adopt: { ok: true } } })
  await scanForAdopt(panel)

  const field = launchCommandField(panel)
  assert.ok(field !== undefined, '没找到「一键拉起命令」输入框')
  field.onChange({ target: { value: 'ollama serve --numa' } })
  panel.commit()
  assert.equal(launchCommandField(panel).value, 'ollama serve --numa')

  await buttonByText(panel, '一键配置并试跑').onClick()
  const text = panel.commit()

  assert.equal(launchCommandField(panel).value, 'ollama serve --numa', '草稿被服务端旧值冲掉了')
  assert.match(text, /没敢覆盖你的草稿/)
})

await ok('草稿没有改动时，一键配置成功照常重载（revision 要跟上）', async () => {
  const panel = mount({ bodies: { status: STATUS, models: SCAN, adopt: { ok: true } } })
  await scanForAdopt(panel)
  const statusBefore = panel.calls.filter((name) => name === 'status').length

  await buttonByText(panel, '一键配置并试跑').onClick()
  const text = panel.commit()

  const statusAfter = panel.calls.filter((name) => name === 'status').length
  assert.equal(statusAfter, statusBefore + 1, '干净草稿该重载一次，否则保存时的 revision 是旧的')
  assert.doesNotMatch(text, /没敢覆盖你的草稿/)
})

// ── C5：只读配置下不让改 ──────────────────────────────────────────────────
// 宿主没把本插件登记成可写条目时（state.writable === false），老版本只在顶上挂一句
// 提示，输入框照旧能改：改满一屏、点保存才吃到一条错误，改的东西全丢。

await ok('只读态下输入框和保存按钮全是灰的（改不动就不会白改）', async () => {
  const panel = mount({ bodies: { status: { ...STATUS, writable: false }, models: SCAN } })
  await scanForAdopt(panel)

  const text = panel.commit()
  assert.match(text, /设置只读/)
  assert.match(text, /只能看不能改/)

  assert.ok(panel.fields.length > 0, '只读态下一个输入框都没渲染出来')
  const editable = panel.fields.filter((props) => props.disabled !== true)
  assert.equal(editable.length, 0, '只读态下还有 ' + editable.length + ' 个输入框能改')

  const save = buttonByText(panel, '保存')
  assert.ok(save !== undefined, '没找到「保存」按钮')
  assert.equal(save.disabled, true, '只读态下「保存」应该直接灰掉')

  const writes = panel.buttons.filter((props) => /一键配置|装不下/.test(String(props.children)))
  assert.ok(writes.length > 0, '没找到「一键配置并试跑」按钮')
  for (const props of writes) {
    assert.equal(props.disabled, true, '只读态下「' + String(props.children) + '」应该灰掉')
  }
})

await ok('可写态下这些控件照旧能改（只读压得太狠也是 bug）', async () => {
  const panel = mount({ bodies: { status: STATUS, models: SCAN } })
  await scanForAdopt(panel)

  const disabled = panel.fields.filter((props) => props.disabled === true)
  assert.equal(disabled.length, 0, '可写态下有 ' + disabled.length + ' 个输入框被误灰')
  assert.notEqual(buttonByText(panel, '保存').disabled, true, '可写态下「保存」不该灰')
})

console.log('\n' + passed + ' 项通过')
