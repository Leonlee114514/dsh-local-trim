/**
 * 「一键拉起」的离线单测。
 *
 * 这部分的价值全在边界上：找可执行文件、命令行切分、等到端口应答、超时文案。
 * 真起进程的部分靠注入 spawnImpl 抓参数，不在这台机器上留后台进程。
 */

import assert from 'node:assert/strict'

import {
  KNOWN_LAUNCHERS,
  LOAD_MODES,
  checkModelFit,
  detectGpuBytes,
  envPathValue,
  isProcessAlive,
  mergeEnv,
  normalizeLoadMode,
  planLaunch,
  portOfBaseURL,
  runDetached,
  splitCommand,
  stopProcess,
  waitForEndpoint,
  whichOnPath,
  workbuddyRoot,
  exeName,
  llamaCppAutoArgs,
  scanLocalModels,
  scanOllamaModels,
  ollamaModelFor,
  ollamaModelRoots,
  readGgufMeta,
  decorateWithGgufMeta,
  readGgufMagic,
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
  // Windows 下反斜杠是路径分隔符，不能当转义符；双引号仍然是引号
  if (process.platform === 'win32') {
    assert.deepEqual(splitCommand('C:\\AI\\ollama.exe serve'), ['C:\\AI\\ollama.exe', 'serve'])
    assert.deepEqual(splitCommand('"C:\\my tools\\a.exe" -m x'), ['C:\\my tools\\a.exe', '-m', 'x'])
  } else {
    // POSIX 上单引号与反斜杠转义都常见，不认的话带空格的路会被切碎
    assert.deepEqual(splitCommand("'/opt/my tools/llama-server' -m x"), ['/opt/my tools/llama-server', '-m', 'x'])
    assert.deepEqual(splitCommand('/opt/my\\ tools/llama-server -m x'), ['/opt/my tools/llama-server', '-m', 'x'])
  }
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
  const bin = root + '/bin/b11012/' + exeName('llama-server')
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
  const bin = root + '/bin/b11012/' + exeName('llama-server')
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
  const bin = root + '/bin/b11012/' + exeName('llama-server')
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
    modelPath: 'C:/models/local_model.gguf',
    ctx: 65536,
    // 断言的是端口/别名传递，不是这台机器装没装；可执行文件名要按平台生成，
    // 否则非 Windows 上 exeName() 不带 .exe，注入的假文件系统一个都匹配不上。
    existsSync: (target) => String(target).endsWith(exeName('llama-server')) || /^[A-Za-z]:\//.test(target),
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

await ok('显存 + 内存都装不下 → risky（唯一的硬拦）', async () => {
  // 30GB 模型、16GB 内存、8GB 显存：哪边都接不住
  const fit = checkModelFit({ sizeBytes: 30 * GIB, totalMemBytes: 16 * GIB, freeMemBytes: 8 * GIB, gpuBytes: 8 * GIB })
  assert.equal(fit.level, 'risky')
  assert.match(fit.label, /都装不下/)
})

await ok('显存挑大梁、内存只接零头 → ok（v0.4.0 在这里误判成 risky）', async () => {
  // 这台机器的真实数：16.9GB gguf、16.37GB 可见内存、14.5GB 显存
  // 显存外只剩 2.4GB，预算 14.37GB → ratio 0.17
  const fit = checkModelFit({
    sizeBytes: 16954484384,
    totalMemBytes: Math.round(16.37 * GIB),
    freeMemBytes: Math.round(1.2 * GIB),
    gpuBytes: Math.round(14.5 * GIB),
  })
  assert.equal(fit.level, 'ok', fit.label)
  assert.ok(fit.ratio < 0.5, 'ratio=' + fit.ratio)
  assert.ok(fit.hostBytes < 4 * GIB, 'hostBytes=' + fit.hostBytes)
})

await ok('显存外的部分超过内存预算 → warn（mmap 能跑，只是开头慢）', async () => {
  // 22GB 模型、8GB 显存 → 显存外 14GB，预算 14GB → ratio 1.0；总量 22 < 16+8=24 还能塞下
  const fit = checkModelFit({ sizeBytes: 22 * GIB, totalMemBytes: 16 * GIB, freeMemBytes: 8 * GIB, gpuBytes: 8 * GIB })
  assert.equal(fit.level, 'warn', fit.label)
  assert.match(fit.label, /mmap|慢/)
})

await ok('同样装不下，但用了 load-mode=none → risky（真吃 RAM）', async () => {
  // 17GB 模型、2GB 显存 → 显存外 15GB，预算 14GB → ratio 1.07；总量 17 < 16+2=18 能塞下
  const shared = { sizeBytes: 17 * GIB, totalMemBytes: 16 * GIB, freeMemBytes: 8 * GIB, gpuBytes: 2 * GIB }
  const mmap = checkModelFit({ ...shared, loadMode: 'mmap' })
  const anon = checkModelFit({ ...shared, loadMode: 'none' })
  assert.equal(mmap.level, 'warn', 'mmap 只是慢：' + mmap.label)
  assert.equal(anon.level, 'risky', '匿名内存会换页：' + anon.label)
  assert.match(anon.label, /none|mmap/)
})

await ok('小模型 → ok', async () => {
  const fit = checkModelFit({ sizeBytes: 2 * GIB, totalMemBytes: 32 * GIB, freeMemBytes: 20 * GIB, gpuBytes: 16 * GIB })
  assert.equal(fit.level, 'ok')
})

await ok('拿不到体积 → unknown，不假装通过也不假装危险', async () => {
  for (const value of [undefined, 0, -1, Number.NaN, 'x']) {
    const fit = checkModelFit({ sizeBytes: value, totalMemBytes: 16 * GIB })
    assert.equal(fit.level, 'unknown', String(value))
    assert.equal(fit.ratio, 0)
  }
})

await ok('--load-mode 只在显式指定时拼进参数（b11012 不认 --no-mmap）', async () => {
  const plain = llamaCppAutoArgs({ modelPath: 'D:/m/a.gguf', listDir: () => [], port: 8090 })
  assert.equal(plain.args.includes('--load-mode'), false, '默认交给引擎自己决定（auto）')
  assert.equal(plain.args.includes('--no-mmap'), false, 'b11012 会报 invalid argument，绝不能出现')
  const paged = llamaCppAutoArgs({ modelPath: 'D:/m/a.gguf', listDir: () => [], port: 8090, loadMode: 'none' })
  assert.equal(paged.args.includes('--no-mmap'), false, '--no-mmap 不是合法参数')
  assert.equal(paged.args[paged.args.indexOf('--load-mode') + 1], 'none')
  assert.equal(paged.loadMode, 'none')
})

await ok('normalizeLoadMode 只认白名单里的五个值', async () => {
  assert.equal(normalizeLoadMode('MMAP'), 'mmap')
  assert.equal(normalizeLoadMode('  Mmap+Mlock '), 'mmap+mlock')
  assert.equal(normalizeLoadMode('auto'), 'auto')
  assert.equal(normalizeLoadMode('nope'), '')
  assert.equal(normalizeLoadMode(undefined), '')
  assert.equal(normalizeLoadMode(null), '')
  for (const mode of LOAD_MODES) assert.equal(normalizeLoadMode(mode), mode, mode)
})

await ok('detectGpuBytes：从 nvidia-smi 读总量，拿不到就退化成 0', async () => {
  const calls = []
  const fakeExec = (command, args) => {
    calls.push([command, ...args].join(' '))
    return '14848\n'
  }
  assert.equal(detectGpuBytes(fakeExec), 14848 * 1024 * 1024)
  assert.match(calls[0] ?? '', /memory.total/)

  // 没装 nvidia-smi、或者驱动不报 —— 不能抛，只能返回 0 让预检退化成「不算显存」
  assert.equal(detectGpuBytes(() => { throw new Error('ENOENT') }), 0)
  assert.equal(detectGpuBytes(() => ''), 0)
  assert.equal(detectGpuBytes(() => '[N/A]\n'), 0)
  assert.equal(detectGpuBytes(() => '   \n'), 0)
})

await ok('planLaunch 把 loadMode 透传到参数里', async () => {
  const plan = planLaunch({
    port: 8095,
    modelPath: 'C:/m/big.gguf',
    loadMode: 'none',
    // 断言的是端口/别名传递，不是这台机器装没装；可执行文件名要按平台生成，
    // 否则非 Windows 上 exeName() 不带 .exe，注入的假文件系统一个都匹配不上。
    existsSync: (target) => String(target).endsWith(exeName('llama-server')) || /^[A-Za-z]:\//.test(target),
    listDir: (dir) => (/\/bin$/.test(dir) ? ['b11012'] : []),
  })
  assert.equal(plan.ok, true, plan.error)
  assert.equal(plan.args.includes('--no-mmap'), false, '任何情况下都不能拼 --no-mmap')
  assert.equal(plan.args[plan.args.indexOf('--load-mode') + 1], 'none')
})

await ok('noMmap 作为兼容入口，转成 --load-mode none', async () => {
  const plan = planLaunch({
    port: 8095,
    modelPath: 'C:/m/big.gguf',
    noMmap: true,
    // 断言的是端口/别名传递，不是这台机器装没装；可执行文件名要按平台生成，
    // 否则非 Windows 上 exeName() 不带 .exe，注入的假文件系统一个都匹配不上。
    existsSync: (target) => String(target).endsWith(exeName('llama-server')) || /^[A-Za-z]:\//.test(target),
    listDir: (dir) => (/\/bin$/.test(dir) ? ['b11012'] : []),
  })
  assert.equal(plan.ok, true, plan.error)
  assert.equal(plan.args.includes('--no-mmap'), false, 'v0.4.1：--no-mmap 是非法参数，转成 --load-mode none')
  assert.equal(plan.args[plan.args.indexOf('--load-mode') + 1], 'none')
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

// ── Ollama 存储 ───────────────────────────────────────────────────────

// ollama 的权重文件叫 sha256-<摘要>，没有扩展名；名字在 manifests 的**路径**里。
// 这两条用例全部走注入的假 fs，不依赖这台机器装没装 ollama。
const ollamaStub = (root = '/store') => {
  const blob = 'sha256-' + 'a'.repeat(64)
  const manifest = JSON.stringify({
    schemaVersion: 2,
    layers: [
      { mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:' + 'a'.repeat(64), size: 500 },
      { mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:' + 'b'.repeat(64), size: 1723 },
    ],
  })
  const meta = JSON.stringify({
    kv: {
      'general.architecture': 'qwen3',
      'general.name': 'Qwen3 8B',
      'general.file_type': 15,
      'qwen3.context_length': 40960,
    },
  })
  const tree = {
    [root]: ['manifests', 'blobs', 'metadata'],
    [root + '/manifests']: ['registry.ollama.ai'],
    [root + '/manifests/registry.ollama.ai']: ['library'],
    [root + '/manifests/registry.ollama.ai/library']: ['qwen3'],
    [root + '/manifests/registry.ollama.ai/library/qwen3']: ['8b'],
    [root + '/blobs']: [blob],
    [root + '/metadata']: [],
  }
  return {
    blob,
    roots: [root],
    exists: (p) => tree[p] !== undefined || p === `${root}/blobs/${blob}` || p === `${root}/manifests/registry.ollama.ai/library/qwen3/8b`,
    listDir: (dir) => tree[dir] ?? [],
    statSize: (p) => (p === `${root}/blobs/${blob}` ? 500 : 400),
    readText: (p) => {
      if (p.endsWith('/8b')) return manifest
      if (p.includes('/metadata/')) return meta
      return ''
    },
  }
}

await ok('ollama：从 manifests 路径还原出 tag，并指回 blobs 里的权重', async () => {
  const stub = ollamaStub()
  const list = scanOllamaModels(stub)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'qwen3:8b')
  assert.equal(list[0].path, '/store/blobs/' + stub.blob)
  assert.deepEqual(list[0].tags, ['qwen3:8b'])
  assert.equal(list[0].source, 'ollama')
  assert.equal(list[0].engine, 'ollama')
  assert.equal(list[0].port, 11434)
  assert.equal(list[0].mmproj, false)
})

await ok('ollama：metadata 的 GGUF kv 翻成可读名与量化（file_type 15 = Q4_K_M）', async () => {
  const stub = ollamaStub()
  const hit = scanOllamaModels(stub)[0]
  assert.equal(hit.modelName, 'Qwen3 8B')
  assert.equal(hit.architecture, 'qwen3')
  assert.equal(hit.quantization, 'Q4_K_M')
  assert.equal(hit.contextLength, 40960)
})

await ok('ollama：latest 这种 tag 不加冒号，其它 tag 拼成 name:tag', async () => {
  const stub = ollamaStub()
  const dir = '/store/manifests/registry.ollama.ai/library/qwen3'
  const base = stub.listDir
  const list = scanOllamaModels({
    ...stub,
    exists: (p) => p === dir + '/latest' || stub.exists(p),
    listDir: (d) => (d === dir ? ['8b', 'latest'] : base(d)),
    readText: (p) => (p === dir + '/latest' ? stub.readText(dir + '/8b') : stub.readText(p)),
  })
  assert.equal(list.length, 1, '同一个 blob 被两个 tag 引用时合并成一条')
  assert.deepEqual([...list[0].tags].sort(), ['qwen3', 'qwen3:8b'])
})

await ok('ollama：blob 不在磁盘上时不列（清单里不能出现起不来的模型）', async () => {
  const stub = ollamaStub()
  const list = scanOllamaModels({ ...stub, exists: () => false })
  assert.equal(list.length, 0)
})

await ok('ollama：只有 adapter/mmproj 层时不算主模型', async () => {
  const stub = ollamaStub()
  const manifest = JSON.stringify({
    layers: [{ mediaType: 'application/vnd.ollama.image.adapter', digest: 'sha256:' + 'a'.repeat(64), size: 10 }],
  })
  const list = scanOllamaModels({ ...stub, readText: (p) => (p.endsWith('/8b') ? manifest : '') })
  assert.equal(list.length, 0)
})

await ok('ollama：路径带尾斜杠时不当目录递归（Windows 的 exists 语义）', async () => {
  // 真机踩过：existsSync('文件/') 在 Windows 上也是 true，用尾斜杠判目录会
  // 把每个 manifest 当成目录继续下钻，结果一个模型都读不到。
  const stub = ollamaStub()
  const list = scanOllamaModels({ ...stub, exists: () => true })
  assert.equal(list.length, 1, '全部存在（模拟 Windows 的尾斜杠语义）时仍要读到 manifest')
})

await ok('主扫描：把 ollama 的模型并进同一张表，且不重复列', async () => {
  const stub = ollamaStub()
  const list = scanLocalModels({
    dirs: ['/models'],
    depth: 1,
    exists: (p) => p === '/models' || p === '/models/other.gguf' || stub.exists(p),
    listDir: (dir) => (dir === '/models' ? ['other.gguf'] : stub.listDir(dir)),
    statSize: (p) => (p === '/models/other.gguf' ? 900 : stub.statSize(p)),
    readText: stub.readText,
    ollamaRoots: stub.roots,
  })
  const names = list.map((item) => item.name)
  assert.deepEqual(names.sort(), ['other.gguf', 'qwen3:8b'])
  assert.equal(list.find((item) => item.name === 'qwen3:8b').source, 'ollama')
})

await ok('主扫描：假 fs 没给 ollamaRoots 时不去真实目录（不谎报 truncated）', async () => {
  // 单测普遍写 exists: () => true，若真去探标准位置会把假树当 ollama 存储钻到底。
  const list = scanLocalModels({
    dirs: ['/models'],
    exists: () => true,
    listDir: () => ['a.gguf'],
    statSize: () => 1024,
  })
  assert.equal(list.length, 1)
  assert.equal(list.truncated, false)
})

await ok('魔数判定：无扩展名的 GGUF 也收，带后缀的杂项不开文件', async () => {
  const list = scanLocalModels({
    dirs: ['/models'],
    depth: 1,
    exists: (p) => p === '/models' || p.startsWith('/models/'),
    listDir: () => ['blob-no-ext', 'notes.md', 'weights'],
    statSize: () => 10 * 1024 * 1024,
    readHead: (p) => (p.endsWith('blob-no-ext') || p.endsWith('weights') ? 'GGUF' : 'PK\x03\x04'),
  })
  const names = list.map((item) => item.name).sort()
  assert.deepEqual(names, ['blob-no-ext', 'weights'])
  assert.equal(list.truncated, false)
})

await ok('反查：adopt 拿一个 blob 路径能问出它的 tag（正反斜杠都认）', async () => {
  const stub = ollamaStub()
  const hit = ollamaModelFor('/store/blobs/' + stub.blob, stub)
  assert.deepEqual(hit?.tags, ['qwen3:8b'])
  assert.deepEqual(ollamaModelFor('\\store\\blobs\\' + stub.blob, stub)?.tags, ['qwen3:8b'])
  assert.equal(ollamaModelFor('/models/other.gguf', stub), undefined)
  assert.equal(ollamaModelFor('', stub), undefined)
  assert.equal(ollamaModelFor('/store/blobs/' + stub.blob, { ...stub, models: [] }), undefined, '给了现成清单就不该再扫盘')
})

await ok('roots：标准位置都探得到，但“像 ollama 存储”才算数', async () => {
  const all = ollamaModelRoots({ exists: () => true, listDir: () => ['manifests'], env: {} })
  assert.ok(all.length >= 2, 'Win/mac/Linux 至少各给了候选：' + JSON.stringify(all))
  assert.ok(all.every((p) => typeof p === 'string' && !p.includes('undefined'), JSON.stringify(all)))
  // 同一个位置存在但没有 manifests/blobs 子目录 → 只是个同名普通目录，不能当库
  const plain = ollamaModelRoots({ exists: (p) => p === all[0], listDir: () => [], env: {} })
  assert.deepEqual(plain, [])
})

await ok('roots：OLLAMA_MODELS 指哪就扫哪（自定义存储位置）', async () => {
  const marker = 'custom-' + 'store'
  const roots = ollamaModelRoots({
    exists: (p) => p.includes(marker) && (p === '/data/' + marker || p.endsWith('/manifests')),
    listDir: () => [],
    env: { OLLAMA_MODELS: '/data/' + marker },
  })
  assert.equal(roots.length, 1)
  assert.equal(roots[0], '/data/' + marker, 'env 给的位置必须排最前，且原样用（不拼到 home 底下）')
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


// ── GGUF 元数据（v0.4.6：普通 .gguf 也显示真名）──────────────────────

/** 造一个真的 GGUF 头部：magic + version + n_tensors + n_kv + KV*（键按写入顺序） */
const ggufBytes = (entries, { version = 3, nTensors = 1 } = {}) => {
  const u32 = (v) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v >>> 0)
    return b
  }
  const u64 = (v) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(v))
    return b
  }
  const str = (s) => {
    const raw = Buffer.from(s, 'utf8')
    return Buffer.concat([u64(raw.length), raw])
  }
  const parts = [Buffer.from('GGUF', 'latin1'), u32(version), u64(nTensors), u64(entries.length)]
  for (const [name, kind, value] of entries) {
    parts.push(str(name), u32(kind === 'str' ? 8 : kind === 'array' ? 9 : kind === 'u32' ? 4 : kind === 'u64' ? 10 : 2))
    if (kind === 'str') parts.push(str(value))
    else if (kind === 'array') parts.push(value)
    else parts.push(kind === 'u32' ? u32(value) : kind === 'u64' ? u64(value) : (() => {
      const b = Buffer.alloc(2)
      b.writeUInt16LE(value)
      return b
    })())
  }
  return Buffer.concat(parts)
}
/** 字符串数组的载荷：elemType=8 + count + 交错存储的 (u64 len + 载荷) */
const strArray = (items) => {
  const head = Buffer.alloc(12)
  head.writeUInt32LE(8, 0)
  head.writeBigUInt64LE(BigInt(items.length), 4)
  const body = items.map((s) => {
    const raw = Buffer.from(s, 'utf8')
    const lb = Buffer.alloc(8)
    lb.writeBigUInt64LE(BigInt(raw.length))
    return Buffer.concat([lb, raw])
  })
  return Buffer.concat([head, ...body])
}
/** 只给 readRange + fileSize 的假文件（走 readGgufMeta 的虚拟分支，不碰磁盘） */
const fakeFile = (bytes) => ({
  readRange: (p, pos, n) => (pos >= bytes.length ? Buffer.alloc(0) : bytes.subarray(pos, Math.min(bytes.length, pos + n))),
  fileSize: () => bytes.length,
})

await ok('GGUF 元数据：读出真名/架构/量化/上下文（35B 那台机的形状）', async () => {
  const bytes = ggufBytes([
    ['general.architecture', 'str', 'qwen35moe'],
    ['general.name', 'str', 'Qwen36_35B A3B REAP 0.25 V2 Fixed'],
    ['general.basename', 'str', 'Qwen36_35B'],
    ['general.size_label', 'str', 'A3B'],
    ['general.file_type', 'u32', 15],
    ['general.type', 'str', 'model'],
    ['qwen35moe.context_length', 'u32', 262144],
  ])
  const meta = readGgufMeta('/models/m.gguf', fakeFile(bytes))
  assert.equal(meta['general.name'], 'Qwen36_35B A3B REAP 0.25 V2 Fixed')
  assert.equal(meta['general.file_type'], 15)
  assert.equal(meta['qwen35moe.context_length'], 262144)
  assert.equal(meta['general.size_label'], 'A3B')
})

await ok('GGUF 元数据：整块读头部会漏键——长 chat_template 之后的值照样读得到', async () => {
  // 老探针的败因：tokenizer 表和 chat_template 把窗口撑满，general.file_type 被截断。
  const bytes = ggufBytes([
    ['tokenizer.ggml.tokens', 'array', strArray(['a', 'bb', 'ccc'])],
    ['tokenizer.chat_template', 'str', 'x'.repeat(300 * 1024)],
    ['general.file_type', 'u32', 15],
    ['general.architecture', 'str', 'qwen3'],
  ])
  const meta = readGgufMeta('/models/m.gguf', fakeFile(bytes))
  assert.equal(meta['general.file_type'], 15, '被大字符串挡住的最关键那个键必须还在')
  assert.equal(meta['general.architecture'], 'qwen3')
  assert.equal(meta['tokenizer.chat_template'], undefined, '超大字符串只走位，不占内存')
  assert.equal(meta['tokenizer.ggml.tokens'], undefined, '字符串数组同样只走位')
})

await ok('GGUF 元数据：字符串数组第一条就跨块时不把载荷当长度', async () => {
  // 交错存储：读成“长度表”会算出 2.7e22 这种天文数字，那是游标错位的信号。
  const bytes = ggufBytes([
    ['tokenizer.ggml.tokens', 'array', strArray(['z'.repeat(300 * 1024), 'tail'])],
    ['general.name', 'str', 'after-big-array'],
  ])
  const meta = readGgufMeta('/models/m.gguf', fakeFile(bytes))
  assert.equal(meta['general.name'], 'after-big-array')
})

await ok('GGUF 元数据：不是 GGUF / 版本太老 / n_kv 离谱 → 空对象，不抛', async () => {
  assert.deepEqual(readGgufMeta('/x', fakeFile(Buffer.from('PK\u0003\u0004not-a-gguf-at-all............'))), {})
  const old = ggufBytes([['general.name', 'str', 'x']], { version: 1 })
  assert.deepEqual(readGgufMeta('/x', fakeFile(old)), {})
  const many = Buffer.alloc(24)
  many.write('GGUF', 0, 'latin1')
  many.writeUInt32LE(3, 4)
  many.writeBigUInt64LE(999999n, 16)
  assert.deepEqual(readGgufMeta('/x', fakeFile(many)), {})
  // 半截文件（第二个键只剩几个字节）也只要返回已拿到的键，不能把半截当值
  const full = ggufBytes([['general.name', 'str', 'half'], ['general.file_type', 'u32', 15]])
  assert.equal(readGgufMeta('/x', fakeFile(full.subarray(0, 62)))['general.name'], 'half')
  assert.equal(readGgufMeta('/x', fakeFile(full.subarray(0, 62)))['general.file_type'], undefined)
})

await ok('GGUF 元数据：折进条目时给紧凑名，mmproj 按 general.type 认', async () => {
  const model = decorateWithGgufMeta({ name: 'local_model.gguf' }, {
    'general.architecture': 'qwen35moe',
    'general.name': 'Qwen36_35B A3B REAP 0.25 V2 Fixed',
    'general.basename': 'Qwen36_35B',
    'general.size_label': 'A3B',
    'general.file_type': 15,
    'general.type': 'model',
    'qwen35moe.context_length': 262144,
  })
  assert.equal(model.readableName, 'Qwen36_35B A3B')
  assert.equal(model.modelName, 'Qwen36_35B A3B REAP 0.25 V2 Fixed')
  assert.equal(model.quantization, 'Q4_K_M')
  assert.equal(model.contextLength, 262144)
  assert.equal(model.mmproj, undefined)
  // 投影被改名成 local_model.gguf 时，文件名里没有 .mmproj.，只能靠元数据认
  const proj = decorateWithGgufMeta({ name: 'local_model.gguf' }, {
    'general.architecture': 'clip',
    'general.type': 'mmproj',
    'general.file_type': 32,
  })
  assert.equal(proj.mmproj, true)
  assert.equal(proj.quantization, undefined, '量化表里没有的编号不显示')
  // 没有 general.name 的裸文件：不瞎编名字
  const bare = decorateWithGgufMeta({ name: 'a.gguf' }, { 'general.file_type': 15 })
  assert.equal(bare.readableName, undefined)
  assert.equal(bare.modelName, undefined)
  assert.equal(bare.quantization, 'Q4_K_M')
})

await ok('主扫描：普通 gguf 也读元数据补名字（可关 / 可限次 / mmproj 不读）', async () => {
  const base = {
    dirs: ['/models'],
    depth: 1,
    exists: (p) => p === '/models' || p.startsWith('/models/'),
    listDir: () => ['a.gguf', 'proj.mmproj.gguf'],
    statSize: () => 12 * 1024 * 1024,
    readHead: () => '',
    readMeta: (p) =>
      p.endsWith('a.gguf')
        ? { 'general.name': 'A Name', 'general.architecture': 'llama', 'general.file_type': 15, 'llama.context_length': 8192 }
        : {},
  }
  const list = scanLocalModels(base)
  const a = list.find((item) => item.name === 'a.gguf')
  assert.equal(a.modelName, 'A Name')
  assert.equal(a.quantization, 'Q4_K_M')
  assert.equal(a.contextLength, 8192)
  assert.equal(list.metaReads, 1, 'mmproj 不白开文件')
  const off = scanLocalModels({ ...base, ggufMeta: false })
  assert.equal(off.find((item) => item.name === 'a.gguf').modelName, undefined)
  assert.equal(off.metaReads, 0)
  const limited = scanLocalModels({ ...base, maxMetaReads: 0 })
  assert.equal(limited.metaReads, 1, '0 会被当成“没给”，回落默认上限')
  // 元数据读取抛异常不能把整趟扫描带崩
  const boom = scanLocalModels({ ...base, readMeta: () => { throw new Error('x') } })
  assert.equal(boom.length, 2)
  assert.equal(boom.find((item) => item.name === 'a.gguf').modelName, undefined)
})


console.log(`${passed} 项通过`)
