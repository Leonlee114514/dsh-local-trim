/**
 * 「一键拉起」的离线单测。
 *
 * 这部分的价值全在边界上：找可执行文件、命令行切分、等到端口应答、超时文案。
 * 真起进程的部分靠注入 spawnImpl 抓参数，不在这台机器上留后台进程。
 */

import assert from 'node:assert/strict'

import {
  KNOWN_LAUNCHERS,
  checkModelFit,
  envPathValue,
  isProcessAlive,
  mergeEnv,
  planLaunch,
  portOfBaseURL,
  runDetached,
  splitCommand,
  stopProcess,
  waitForEndpoint,
  whichOnPath,
  workbuddyRoot,
  llamaCppAutoArgs,
  scanLocalModels,
} from '../lib/launcher.js'

// PATH 在不同 shell 下键名不同（bash: PATH / PowerShell: Path），断言不能写死。
const isPathKey = (name) => /^path$/i.test(String(name))
const pathKeyOf = (env) => {
  const hit = Object.keys(env ?? {}).find(isPathKey)
  return hit === undefined ? undefined : env[hit]
}
const countPathKeys = (env) => Object.keys(env ?? {}).filter(isPathKey).length
const expectedPathValue = (env) => pathKeyOf(env)
const variantsOf = (env) => {
  const seen = new Map()
  let dup = 0
  for (const name of Object.keys(env ?? {})) {
    const slot = String(name).toUpperCase()
    if (seen.has(slot)) dup += 1
    seen.set(slot, name)
  }
  return dup
}
const expectedVariants = (env) => variantsOf(env)

let passed = 0
async function ok(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✓ ' + name)
  } catch (error) {
    console.error('  ✗ ' + name)
    throw error
  }
}

await ok('端口能从 baseURL 里读出来，含默认端口', async () => {
  assert.equal(portOfBaseURL('http://127.0.0.1:11434/v1'), 11434)
  assert.equal(portOfBaseURL('http://localhost:8090'), 8090)
  assert.equal(portOfBaseURL('http://localhost/v1'), 80)
  assert.equal(portOfBaseURL('https://example.com/v1'), 443)
  assert.equal(portOfBaseURL(''), 0)
  assert.equal(portOfBaseURL('nonsense'), 0)
})

await ok('命令行切分认双引号', async () => {
  assert.deepEqual(splitCommand('ollama serve'), ['ollama', 'serve'])
  assert.deepEqual(splitCommand('  ollama   serve  '), ['ollama', 'serve'])
  assert.deepEqual(splitCommand('"C:\\Program Files\\x\\a.exe" serve'), ['C:\\Program Files\\x\\a.exe', 'serve'])
  assert.deepEqual(splitCommand(''), [])
})

await ok('whichOnPath 按扩展名补全', async () => {
  // Windows 上补 .exe/.cmd/.bat，其它平台只试裸名 —— 所以这里按平台放宽，
  // 否则这条断言在 Linux 的 CI 上必红（而逻辑本身是对的）。
  const seen = []
  const exists = (path) => {
    seen.push(path)
    return /ollama(\.exe)?$/.test(String(path))
  }
  const resolved = whichOnPath('ollama', exists)
  assert.match(String(resolved), /ollama(\.exe)?$/)
  assert.ok(seen.length >= 1)
  assert.equal(
    whichOnPath('nope', () => false),
    null,
  )
})

await ok('11434 找到 ollama 就给 serve 参数', async () => {
  // 只认名字，不管落在哪个目录：planLaunch 的候选里既有真实路径也有裸名，
  // 用「等于某个具体路径」的断言会把候选表变化当成失败。
  const plan = planLaunch({
    port: 11434,
    existsSync: (path) => /ollama(\.exe)?$/.test(String(path)),
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.id, 'ollama')
  assert.deepEqual(plan.args, ['serve'])
  assert.equal(plan.env.OLLAMA_HOST, '127.0.0.1:11434')
})

await ok('找不到可执行文件时说清找过哪些路径', async () => {
  const plan = planLaunch({ port: 11434, existsSync: () => false })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /没找到 Ollama/)
  assert.ok(plan.tried.length >= 2)
})

await ok('装了 llama.cpp 但没给模型：报「要模型文件」并给出可抄的命令', async () => {
  // listDir 置空：这组只验证「装了但要模型」的文案，别去读真实的模型目录
  const plan = planLaunch({ port: 8090, existsSync: () => true, listDir: () => [] })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /需要模型文件/)
  // 找到的可执行文件要出现在提示里，用户才能直接抄
  assert.match(plan.error, /llama-server/)
  assert.match(plan.error, /-m /)
})

await ok('没装 llama.cpp：报「没找到」并列出查过的地方', async () => {
  const plan = planLaunch({ port: 8090, existsSync: () => false, listDir: () => [] })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /本机没找到 llama\.cpp/)
  assert.ok(Array.isArray(plan.tried) && plan.tried.length > 0, 'tried 应列出候选路径')
})

await ok('不认识的端口给出可执行的下一步', async () => {
  const plan = planLaunch({ port: 9999, existsSync: () => true })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /9999/)
  assert.match(plan.error, /启动命令/)
})

await ok('自定义命令优先于自动探测', async () => {
  const plan = planLaunch({
    port: 9999,
    customCommand: '"C:\\Program Files\\ollama\\ollama.exe" serve --verbose',
    existsSync: () => false,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.source, 'custom')
  assert.equal(plan.command, 'C:\\Program Files\\ollama\\ollama.exe')
  assert.deepEqual(plan.args, ['serve', '--verbose'])
})

await ok('runDetached 传参与环境正确且不等待退出', async () => {
  let captured = null
  const spawnImpl = (command, args, options) => {
    captured = { command, args, options }
    return { pid: 4242, unref() {} }
  }
  const result = runDetached({
    command: 'C:/fake/ollama.exe',
    args: ['serve'],
    env: { OLLAMA_HOST: '127.0.0.1:11434' },
    spawnImpl,
  })
  assert.equal(result.ok, true)
  assert.equal(result.pid, 4242)
  assert.equal(captured.options.detached, true)
  assert.equal(captured.options.stdio, 'ignore')
  assert.equal(captured.options.env.OLLAMA_HOST, '127.0.0.1:11434')
  // 必须继承宿主环境，否则新进程找不到 PATH。
  // 键名大小写不敏感：bash 给的是 PATH，PowerShell 给的是 Path。
  assert.equal(pathKeyOf(captured.options.env), expectedPathValue(process.env), '宿主 PATH 没传下去')
  // 而且只能有一个 PATH 键 —— 双键会让 Node 在 Windows 上认错那个，子进程直接 ENOENT。
  assert.equal(countPathKeys(captured.options.env), 1, 'PATH 出现大小写变体双键')
  assert.equal(variantsOf(captured.options.env), expectedVariants(process.env))
})

await ok('mergeEnv：大小写变体只留后写的那个', async () => {
  const merged = mergeEnv({ Path: 'a', HOME: '/h', PAGER: 'cat' }, { PATH: 'b', pager: 'less' })
  assert.equal(countPathKeys(merged), 1)
  assert.equal(pathKeyOf(merged), 'b', '后写的 PATH 应该覆盖先写的 Path')
  assert.equal(merged.HOME, '/h')
  // 大小写不敏感覆盖：先写的 PAGER 被后写的 pager 顶掉
  assert.equal(merged.pager, 'less')
  assert.equal(merged.PAGER, undefined)
  assert.equal(variantsOf(merged), 0, '不该出现任何大小写变体双键')
})

await ok('mergeEnv：extra 里的 undefined 不覆盖已有值', async () => {
  const merged = mergeEnv({ PATH: 'keep' }, { PATH: undefined })
  assert.equal(pathKeyOf(merged), 'keep')
})

await ok('spawn 抛错时不装作成功', async () => {
  const result = runDetached({
    command: 'nope',
    spawnImpl: () => {
      throw new Error('ENOENT')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /ENOENT/)
})

await ok('waitForEndpoint 等到应答就返回耗时', async () => {
  let clock = 0
  let calls = 0
  const result = await waitForEndpoint({
    probe: async () => {
      calls += 1
      return calls >= 3 ? { ok: true, models: [{ id: 'qwen3:8b' }] } : { ok: false, error: '连不上' }
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    timeoutMs: 5000,
    intervalMs: 500,
  })
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 3)
  // 第 3 次探测命中时只睡过两次，耗时就是 2 × interval
  assert.equal(result.ms, 1000)
  assert.equal(result.models[0].id, 'qwen3:8b')
})

await ok('waitForEndpoint 超时带上最后一次错误', async () => {
  let clock = 0
  const result = await waitForEndpoint({
    probe: async () => ({ ok: false, error: 'ECONNREFUSED' }),
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    timeoutMs: 2000,
    intervalMs: 500,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /等了 2 秒/)
  assert.match(result.error, /ECONNREFUSED/)
})

await ok('认得出 WorkBuddy 里那套 llama.cpp + gguf', async () => {
  const root = workbuddyRoot()
  const bin = root + '/bin/b11012/llama-server.exe'
  const auto = llamaCppAutoArgs({
    listDir: (dir) => {
      if (dir === root + '/bin') return ['b11012']
      if (dir === root + '/files') return ['local_model.gguf', 'local_model.mmproj.gguf']
      return []
    },
    exists: (p) => p === bin,
    port: 8090,
    ctx: 65536,
  })
  assert.equal(auto.ok, true)
  assert.match(auto.model, /local_model.gguf$/)
  // 视觉投影不能当主模型
  assert.equal(auto.args.includes('local_model.mmproj.gguf'), false)
  assert.ok(auto.args.includes('-m') && auto.args.includes('--jinja'))
  assert.equal(auto.args[auto.args.indexOf('-c') + 1], '65536')
})

await ok('发现组件齐全时直接拼出可跑的命令，不要用户手抄', async () => {
  const root = workbuddyRoot()
  const bin = root + '/bin/b11012/llama-server.exe'
  const plan = planLaunch({
    port: 8090,
    alias: 'qwen35moe-local',
    listDir: (dir) => {
      if (dir === root + '/bin') return ['b11012']
      if (dir === root + '/files') return ['local_model.gguf']
      return []
    },
    existsSync: (p) => p === bin,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.source, 'discovered')
  assert.equal(plan.command, bin)
  assert.equal(plan.args[plan.args.indexOf('--alias') + 1], 'qwen35moe-local')
})

await ok('确实没有模型文件时才回「不替你猜」', async () => {
  const root = workbuddyRoot()
  const bin = root + '/bin/b11012/llama-server.exe'
  const plan = planLaunch({
    port: 8090,
    listDir: (dir) => (dir === root + '/bin' ? ['b11012'] : []),
    existsSync: (p) => p === bin,
  })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /需要模型文件/)
})

await ok('扫本机 gguf：跳过 mmproj、按大小降序', async () => {
  const tree = {
    '/m': ['big.gguf', 'small.gguf', 'vision.mmproj.gguf'],
  }
  const list = scanLocalModels({
    dirs: ['/m'],
    depth: 1,
    exists: (p) => p === '/m' || tree[p] !== undefined || p.endsWith('.gguf'),
    listDir: (dir) => tree[dir] ?? [],
    statSize: (p) => (p.includes('big') ? 900 : p.includes('small') ? 100 : 50),
  })
  assert.equal(list.length, 3)
  assert.equal(list[0].name, 'big.gguf')
  assert.equal(list[1].name, 'small.gguf')
  assert.equal(list.find((item) => item.name === 'vision.mmproj.gguf').mmproj, true)
})

await ok('扫本机 gguf：指定 modelPath 就用它，不再去目录里猜', async () => {
  const auto = llamaCppAutoArgs({
    modelPath: 'D:/models/other-qwen.gguf',
    listDir: () => ['local_model.gguf'],
    port: 8091,
    ctx: 8192,
  })
  assert.equal(auto.ok, true)
  assert.equal(auto.model, 'D:/models/other-qwen.gguf')
  assert.equal(auto.args[auto.args.indexOf('--port') + 1], '8091')
  assert.equal(auto.args[auto.args.indexOf('--alias') + 1], 'other-qwen')
})

await ok('扫本机 gguf：目录里只有 mmproj 时算没有模型', async () => {
  const auto = llamaCppAutoArgs({
    listDir: () => ['local_model.mmproj.gguf'],
  })
  assert.equal(auto.ok, false)
  assert.equal(auto.reason, 'no-model')
})

await ok('自选端口 + 指定 gguf：端口按用户填的走，报回来的也是它', async () => {
  // CI 上没有 WorkBuddy 的 llama.cpp，所以把「磁盘上有什么」整段注入进来。
  // 这条用例要验的是端口与别名的传递，不是这台机器装没装。
  const plan = planLaunch({
    port: 8095,
    modelPath: 'C:/Users/Lyonl/.workbuddy/local-models/files/local_model.gguf',
    ctx: 65536,
    existsSync: (target) => /llama-server\.exe$/.test(target) || /^[A-Za-z]:\//.test(target),
    listDir: (dir) => (/\/bin$/.test(dir) ? ['b11012'] : []),
  })
  assert.equal(plan.ok, true, plan.error)
  assert.equal(plan.port, 8095)
  assert.equal(plan.args[plan.args.indexOf('--port') + 1], '8095')
  assert.equal(plan.args[plan.args.indexOf('--alias') + 1], 'local_model')
})

await ok('launcher 表里端口不重复', async () => {
  const ports = KNOWN_LAUNCHERS.map((item) => item.port)
  assert.equal(new Set(ports).size, ports.length)
})

// ── 资源预检（17GB 事故的补丁） ──────────────────────────────────────────

const GIB = 1024 * 1024 * 1024

await ok('模型比整机内存还大 → risky，且说人话', async () => {
  const fit = checkModelFit({ sizeBytes: 17 * GIB, totalMemBytes: 16 * GIB, freeMemBytes: 8 * GIB })
  assert.equal(fit.level, 'risky')
  assert.match(fit.label, /比整机内存/)
  assert.match(fit.label, /17GB|16GB/)
})

await ok('模型吃掉可用预算八成 → risky', async () => {
  // 16GB 整机、系统留 2GB → 预算 14GB；模型 12GB 占 86%
  const fit = checkModelFit({ sizeBytes: 12 * GIB, totalMemBytes: 16 * GIB, freeMemBytes: 8 * GIB })
  assert.equal(fit.level, 'risky')
  assert.equal(fit.ratio, 0.86)
})

await ok('模型占一半到八成 → warn，不拦', async () => {
  // 预算 14GB，模型 9GB 占 64%
  const fit = checkModelFit({ sizeBytes: 9 * GIB, totalMemBytes: 16 * GIB, freeMemBytes: 8 * GIB })
  assert.equal(fit.level, 'warn')
  assert.match(fit.label, /加载时会卡一下/)
})

await ok('小模型 → ok', async () => {
  const fit = checkModelFit({ sizeBytes: 2 * GIB, totalMemBytes: 32 * GIB, freeMemBytes: 20 * GIB })
  assert.equal(fit.level, 'ok')
})

await ok('拿不到体积 → unknown，不假装通过也不假装危险', async () => {
  for (const value of [undefined, 0, -1, Number.NaN, 'x']) {
    const fit = checkModelFit({ sizeBytes: value, totalMemBytes: 16 * GIB })
    assert.equal(fit.level, 'unknown', String(value))
    assert.equal(fit.ratio, 0)
  }
})

await ok('--no-mmap 只在显式要求时拼进参数', async () => {
  const plain = llamaCppAutoArgs({ modelPath: 'D:/m/a.gguf', listDir: () => [], port: 8090 })
  assert.equal(plain.args.includes('--no-mmap'), false)
  const paged = llamaCppAutoArgs({ modelPath: 'D:/m/a.gguf', listDir: () => [], port: 8090, noMmap: true })
  assert.equal(paged.args.includes('--no-mmap'), true)
  assert.equal(paged.noMmap, true)
})

await ok('planLaunch 把 noMmap 透传到参数里', async () => {
  const plan = planLaunch({
    port: 8095,
    modelPath: 'C:/m/big.gguf',
    noMmap: true,
    existsSync: (target) => /llama-server\.exe$/.test(target) || /^[A-Za-z]:\//.test(target),
    listDir: (dir) => (/\/bin$/.test(dir) ? ['b11012'] : []),
  })
  assert.equal(plan.ok, true, plan.error)
  assert.equal(plan.args.includes('--no-mmap'), true)
})

// ── 停进程（只能起不能停的补丁） ────────────────────────────────────────

const fakeProc = (options = {}) => {
  let alive = options.alive !== false
  const signals = []
  const kill = (pid, signal) => {
    if (!alive) {
      const error = new Error('no such process')
      error.code = 'ESRCH'
      throw error
    }
    signals.push(signal)
    // 默认 SIGTERM 就干净退出；diesOn 可以指定只有 SIGKILL 才死
    if (signal === 'SIGTERM' && options.diesOn === 'SIGKILL') return
    alive = false
  }
  return {
    kill,
    signals,
    isAlive: () => alive,
    setAlive: (value) => {
      alive = value
    },
  }
}
const noSleep = async () => {}

await ok('stopProcess：SIGTERM 能收尾就只发一次', async () => {
  const proc = fakeProc()
  const result = await stopProcess({
    pid: 100,
    kill: proc.kill,
    alive: proc.isAlive,
    sleep: noSleep,
  })
  assert.equal(result.ok, true)
  assert.equal(result.signal, 'SIGTERM')
  assert.deepEqual(proc.signals, ['SIGTERM'])
})

await ok('stopProcess：赖着不走就补 SIGKILL', async () => {
  const proc = fakeProc({ diesOn: 'SIGKILL' })
  const result = await stopProcess({
    pid: 101,
    kill: proc.kill,
    alive: proc.isAlive,
    sleep: noSleep,
    waitMs: 300,
  })
  assert.equal(result.ok, true)
  assert.equal(result.signal, 'SIGKILL')
  assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL'])
})

await ok('stopProcess：本来就没了算成功（幂等）', async () => {
  const proc = fakeProc({ alive: false })
  const result = await stopProcess({ pid: 102, kill: proc.kill, alive: proc.isAlive, sleep: noSleep })
  assert.equal(result.ok, true)
  assert.equal(result.already, true)
  assert.deepEqual(proc.signals, [])
})

await ok('stopProcess：没有 pid 就直说', async () => {
  for (const value of [0, -1, undefined, 'x']) {
    const result = await stopProcess({ pid: value })
    assert.equal(result.ok, false)
    assert.match(result.error, /没有可停的 pid/)
  }
})

await ok('stopProcess：杀完还活着就报失败，不谎报成功', async () => {
  const proc = fakeProc()
  const result = await stopProcess({
    pid: 103,
    kill: proc.kill,
    alive: () => true,
    sleep: noSleep,
    waitMs: 150,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /还在/)
})

await ok('isProcessAlive：EPERM 也算活着', async () => {
  const throws = (code) => () => {
    const error = new Error(code)
    error.code = code
    throw error
  }
  // 自己的 pid 一定活着（跨平台都成立），用它当「真活着」的样本
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(process.pid, throws('EPERM')), true)
  assert.equal(isProcessAlive(process.pid, throws('ESRCH')), false)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(undefined), false)
})

// ── 扫模型的边界 ────────────────────────────────────────────────────────

await ok('扫本机 gguf：命中上限就停，并标 truncated', async () => {
  // 一个目录里有 50 个 gguf，上限 5 → 只收 5 个
  const names = Array.from({ length: 50 }, (_, index) => `m${index}.gguf`)
  const list = scanLocalModels({
    dirs: ['/models'],
    exists: () => true,
    listDir: () => names,
    statSize: () => 1024,
    maxModels: 5,
  })
  assert.equal(list.length, 5)
  assert.equal(list.truncated, true)
})

await ok('扫本机 gguf：访问节点上限就停', async () => {
  const names = Array.from({ length: 1000 }, (_, index) => `f${index}.txt`)
  let calls = 0
  const list = scanLocalModels({
    dirs: ['/models'],
    // 根目录存在、子目录一律不存在：这样只有最外层会 listDir 一次
    exists: (target) => target === '/models',
    listDir: () => {
      calls += 1
      return names
    },
    statSize: () => 0,
    maxEntries: 100,
  })
  assert.equal(list.length, 0)
  assert.equal(list.truncated, true)
  assert.equal(calls, 1, '一旦超限就不该再往下走')
})

await ok('扫本机 gguf：Downloads 只扫一层', async () => {
  const tree = {
    '/home/u/Downloads': ['a.gguf', 'somedir'],
    // 这个子目录里有 gguf，但 Downloads 被限成 depth 1，所以不该被看见
    '/home/u/Downloads/somedir': ['deep.gguf'],
    '/home/u/models': ['b.gguf'],
  }
  const list = scanLocalModels({
    dirs: ['/home/u/Downloads', '/home/u/models'],
    depth: 2,
    exists: () => true,
    listDir: (dir) => tree[dir] ?? [],
    statSize: () => 1024,
  })
  const names = list.map((item) => item.name)
  assert.deepEqual(names, ['a.gguf', 'b.gguf'])
})

await ok('扫本机 gguf：没超限时不谎报 truncated', async () => {
  const list = scanLocalModels({
    dirs: ['/models'],
    exists: () => true,
    listDir: () => ['a.gguf', 'b.gguf'],
    statSize: () => 1024,
  })
  assert.equal(list.length, 2)
  assert.equal(list.truncated, false)
  assert.equal(list.scannedEntries, 2)
})

// ── PATH 读取（大小写）────────────────────────────────────────────────

await ok('envPathValue：PATH / Path 两种键都能读到', async () => {
  assert.equal(envPathValue({ PATH: 'a;b' }), 'a;b')
  assert.equal(envPathValue({ Path: 'c;d' }), 'c;d')
  assert.equal(envPathValue({ path: 'e;f' }), 'e;f')
  assert.equal(envPathValue({}), '')
  assert.equal(envPathValue(null), '')
  // 不给参数时读宿主自己的 PATH（默认参数），并且读得到非空值
  assert.equal(envPathValue(), envPathValue(process.env))
  assert.notEqual(envPathValue(), '')
})

console.log(`${passed} 项通过`)
