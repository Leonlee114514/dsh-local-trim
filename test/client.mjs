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
  globalThis.fetch = async (url) => {
    const name = String(url).replace(/^.*\/api\/dsh-local-trim\//, '')
    calls.push(name)
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

  return { commit, flushEffects, calls, buttons, texts }
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

console.log('\n' + passed + ' 项通过')
