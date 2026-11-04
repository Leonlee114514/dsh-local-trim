/**
 * 跨平台适配的单测。
 *
 * 这个文件存在的理由：v0.4.1 之前 launcher.js 里到处是
 * `process.env.USERPROFILE ?? 'C:/Users/' + process.env.USERNAME`，
 * 在 Linux / macOS 上会拼出 `C:/Users/.workbuddy/local-models` 这种谁都不认识的路，
 * 而本机跑测试永远是绿的 —— 因为本机恰好就是 Windows。
 *
 * 所以这里全部用假 platform + 假 env 来测，不依赖跑测试的机器是哪台。
 */

import assert from 'node:assert/strict'

import {
  LOAD_MODES,
  KNOWN_LAUNCHERS,
  checkModelFit,
  dataDir,
  detectGpuInfo,
  exeName,
  homeDir,
  joinPath,
  llamaCppAutoArgs,
  localModelDirs,
  modelRoots,
  normalizeLoadMode,
  parseHelpFlags,
  planLaunch,
  probeHelpCaps,
  toSlash,
} from '../lib/launcher.js'

let passed = 0

async function ok(name, run) {
  try {
    await run()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    throw error
  }
}

/** 临时改环境变量，跑完还原（测试之间不串味）。 */
function withEnv(patch, run) {
  const saved = new Map()
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

console.log('=== 跨平台：路径拼装 ===')

await ok('toSlash：反斜杠转正斜杠，其它不动', async () => {
  const bs = String.fromCharCode(92)
  assert.equal(toSlash(`C:${bs}Users${bs}a`), 'C:/Users/a')
  assert.equal(toSlash('/usr/local/bin'), '/usr/local/bin')
  assert.equal(toSlash(null), '')
  assert.equal(toSlash(undefined), '')
})

await ok('joinPath：丢空段、去首尾斜杠、不给 undefined', async () => {
  assert.equal(joinPath('/home/u', 'models'), '/home/u/models')
  assert.equal(joinPath('/home/u/', '/models/'), '/home/u/models')
  assert.equal(joinPath(undefined, 'models'), 'models')
  assert.equal(joinPath('', '', 'x'), 'x')
  assert.equal(joinPath('a', null, 'b'), 'a/b')
  // 关键：绝不能拼出 undefined/... 这种
  assert.equal(joinPath(process.env.__NOPE_NOT_SET__, 'models'), 'models')
})

await ok('exeName：Windows 补 .exe，其它平台不补', async () => {
  const name = exeName('llama-server')
  if (process.platform === 'win32') assert.equal(name, 'llama-server.exe')
  else assert.equal(name, 'llama-server')
})

await ok('homeDir：拿得到绝对路径，且不带反斜杠', async () => {
  const home = homeDir()
  assert.ok(home.length > 0)
  assert.equal(home.includes(String.fromCharCode(92)), false)
  assert.equal(home.startsWith('/') || /^[A-Za-z]:/.test(home), true)
})

await ok('dataDir：三个平台各有一套，且不是 undefined 开头', async () => {
  const dir = dataDir()
  assert.ok(dir.length > 0)
  assert.equal(dir.startsWith('undefined'), false)
  assert.equal(dir.includes('undefined'), false)
})

console.log('=== 跨平台：模型目录 ===')

await ok('modelRoots：内建目录不含 undefined，且都去重', async () => {
  const roots = modelRoots()
  assert.ok(roots.length >= 4)
  for (const dir of roots) {
    assert.equal(typeof dir, 'string')
    assert.ok(dir.length > 0)
    assert.equal(dir.includes('undefined'), false)
  }
  assert.equal(new Set(roots).size, roots.length)
})

await ok('modelRoots：DSH_LOCAL_MODELS_DIR 排在最前', async () => {
  await withEnv({ DSH_LOCAL_MODELS_DIR: '/data/gguf' }, async () => {
    assert.equal(modelRoots()[0], '/data/gguf')
  })
  await withEnv({ DSH_LOCAL_MODELS_DIR: undefined }, async () => {
    assert.equal(modelRoots().includes('/data/gguf'), false)
  })
})

await ok('localModelDirs：跨平台都不含 Windows 专属硬编码', async () => {
  const dirs = localModelDirs()
  assert.ok(dirs.length > 0)
  for (const dir of dirs) {
    assert.equal(dir.includes('undefined'), false)
    assert.equal(dir.startsWith('C:/Users//'), false)
  }
  // 三平台都有的 Downloads 必须在
  assert.equal(
    dirs.some((dir) => /\/Downloads$/.test(dir)),
    true,
  )
})

await ok('localModelDirs：尊重 DSH_LOCAL_MODELS_DIR', async () => {
  await withEnv({ DSH_LOCAL_MODELS_DIR: '/mnt/weights' }, async () => {
    const dirs = localModelDirs()
    assert.equal(
      dirs.some((dir) => dir.startsWith('/mnt/weights')),
      true,
    )
  })
})

console.log('=== 跨平台：可执行文件候选 ===')

await ok('KNOWN_LAUNCHERS：每个后端的 candidates 都是非空字符串数组', async () => {
  const io = { exists: () => false, listDir: () => [] }
  for (const known of KNOWN_LAUNCHERS) {
    const list = known.candidates(io)
    assert.ok(Array.isArray(list) && list.length > 0, `${known.id} 没有候选`)
    for (const item of list) {
      assert.equal(typeof item, 'string')
      assert.ok(item.trim().length > 0)
      assert.equal(item.includes('undefined'), false, `${known.id} 拼出 undefined：${item}`)
    }
  }
})

await ok('KNOWN_LAUNCHERS：裸名字排在带路径的后面（PATH 兜底）', async () => {
  const io = { exists: () => false, listDir: () => [] }
  const ollama = KNOWN_LAUNCHERS.find((item) => item.id === 'ollama')
  const list = ollama.candidates(io)
  assert.equal(list[list.length - 1], 'ollama')
  const llamacpp = KNOWN_LAUNCHERS.find((item) => item.id === 'llamacpp')
  const llama = llamacpp.candidates(io)
  assert.equal(llama[llama.length - 1], exeName('llama-server'))
})

await ok('KNOWN_LAUNCHERS：环境变量能覆盖候选位置并排最前', async () => {
  await withEnv({ OLLAMA_BIN: '/opt/custom/ollama' }, async () => {
    const io = { exists: () => false, listDir: () => [] }
    const ollama = KNOWN_LAUNCHERS.find((item) => item.id === 'ollama')
    assert.equal(ollama.candidates(io)[0], '/opt/custom/ollama')
  })
})

console.log('=== 跨平台：显存探测 ===')

await ok('detectGpuInfo：NVIDIA 走 memory.total', async () => {
  const info = detectGpuInfo((command) => {
    if (command === 'nvidia-smi') return '14848\n'
    throw new Error('ENOENT')
  }, 'linux')
  assert.equal(info.vendor, 'nvidia')
  assert.equal(info.bytes, 14848 * 1024 * 1024)
  assert.equal(info.unified, false)
})

await ok('detectGpuInfo：AMD 走 rocm-smi 的字节数', async () => {
  const info = detectGpuInfo((command) => {
    if (command === 'rocm-smi') return 'GPU[0]\t\tVRAM Total Memory (B): 17163091968\n'
    throw new Error('ENOENT')
  }, 'linux')
  assert.equal(info.vendor, 'amd')
  assert.equal(info.bytes, 17163091968)
})

await ok('detectGpuInfo：AMD 的 GiB 写法也认', async () => {
  const info = detectGpuInfo((command) => {
    if (command === 'rocm-smi') return 'VRAM Total Memory (B): 24.0 GiB\n'
    throw new Error('ENOENT')
  }, 'linux')
  assert.equal(info.vendor, 'amd')
  assert.equal(info.bytes, 24 * 1024 ** 3)
})

await ok('detectGpuInfo：Apple Silicon 是统一内存，取四分之一并标 unified', async () => {
  const info = detectGpuInfo((command) => {
    if (command === 'sysctl') return '68719476736\n'
    throw new Error('ENOENT')
  }, 'darwin')
  assert.equal(info.vendor, 'apple')
  assert.equal(info.unified, true)
  assert.equal(info.bytes, 68719476736 / 4)
})

await ok('detectGpuInfo：什么都没有就是 none / 0，不抛', async () => {
  const none = detectGpuInfo(
    () => {
      throw new Error('ENOENT')
    },
    'win32',
  )
  assert.deepEqual(none, { bytes: 0, vendor: 'none', unified: false })
  const nutty = detectGpuInfo(() => '[N/A]\n', 'linux')
  assert.equal(nutty.bytes, 0)
})

await ok('detectGpuInfo：NVIDIA 优先于后续探测', async () => {
  const info = detectGpuInfo((command) => {
    if (command === 'nvidia-smi') return '8192\n'
    if (command === 'rocm-smi') return 'VRAM Total Memory (B): 17163091968\n'
    return ''
  }, 'linux')
  assert.equal(info.vendor, 'nvidia')
  assert.equal(info.bytes, 8192 * 1024 * 1024)
})

console.log('=== 跨平台：--help 能力探测 ===')

await ok('parseHelpFlags：抠出所有 --flag，大小写归一', async () => {
  const flags = parseHelpFlags(`
    -m, --model PATH      model path
    --n-gpu-layers N      layers
    --Load-Mode MODE      load mode
    -c, --ctx-size N      context
  `)
  assert.ok(flags instanceof Set)
  assert.equal(flags.has('--model'), true)
  assert.equal(flags.has('--n-gpu-layers'), true)
  assert.equal(flags.has('--load-mode'), true)
  assert.equal(flags.has('--ctx-size'), true)
  assert.equal(flags.has('--no-mmap'), false)
})

await ok('parseHelpFlags：短参数（-c / -m）也要认，否则会误丢 -c 65536', async () => {
  const flags = parseHelpFlags(`
    -m, --model PATH
    -c, --ctx-size N
    -t, --threads N
    --n-predict N
  `)
  assert.equal(flags.has('-c'), true)
  assert.equal(flags.has('-m'), true)
  assert.equal(flags.has('-t'), true)
  assert.equal(flags.has('--ctx-size'), true)
  // 命令行示例里的分隔横线 / 负号不能当参数
  const sample = parseHelpFlags('usage: llama-server -m x --port 8080 - x\n')
  assert.equal(sample.has('-'), false)
})

await ok('parseHelpFlags：空输出返回 null（探不出来 ≠ 全都不支持）', async () => {
  assert.equal(parseHelpFlags(''), null)
  assert.equal(parseHelpFlags(undefined), null)
  assert.equal(parseHelpFlags('no flags here'), null)
})

await ok('probeHelpCaps：解析一次后缓存，不再重复跑 --help', async () => {
  let calls = 0
  const exec = () => {
    calls += 1
    return '--model PATH\n--fit on\n'
  }
  const first = probeHelpCaps('/fake/bin/llama-server', exec)
  const second = probeHelpCaps('/fake/bin/llama-server', exec)
  assert.equal(calls, 1)
  assert.equal(first, second)
  assert.equal(first.has('--fit'), true)
})

await ok('probeHelpCaps：--help 打到 stderr 且非零退出时也能抠出来', async () => {
  const exec = () => {
    const error = new Error('exit 1')
    error.stderr = 'usage: llama-server ...\n  --load-mode MODE\n  --jinja\n'
    throw error
  }
  const caps = probeHelpCaps('/fake/bin/llama-server-stderr', exec)
  assert.equal(caps.has('--load-mode'), true)
  assert.equal(caps.has('--jinja'), true)
})

await ok('probeHelpCaps：命令不存在返回 null', async () => {
  const caps = probeHelpCaps(
    '/fake/bin/nope',
    () => {
      throw new Error('ENOENT')
    },
  )
  assert.equal(caps, null)
  assert.equal(probeHelpCaps('', () => ''), null)
})

console.log('=== 跨平台：后端各自需要什么参数 ===')

await ok('LM Studio 用 lms server start，不需要先给模型', async () => {
  // 原来 lmstudio 和 vLLM 一起归进「args === null，必须有模型文件」，
  // 面板会回「需要模型文件才能起，插件不替你猜」—— 对 LM Studio 是错的，
  // 它自带 `lms server start`，模型是运行时按请求加载的。
  const plan = planLaunch({
    port: 1234,
    // macOS 上 exeName('lms') 不带后缀，写死 .exe 只会在 Windows 上过。
    existsSync: (p) => String(p).endsWith(exeName('lms')),
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.id, 'lmstudio')
  assert.deepEqual(plan.args, ['server', 'start', '--port', '1234'])
})

await ok('ollama 的固定参数不受 args 函数化影响', async () => {
  const plan = planLaunch({
    port: 11434,
    existsSync: (p) => String(p).endsWith(exeName('ollama')),
  })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.args, ['serve'])
})

console.log('=== 跨平台：老版本 llama.cpp 的参数裁剪 ===')

// 假文件系统：任何以 llama-server 结尾的路径都算存在（各平台的文件名不同，
// 这里要测的是「参数裁剪」，不是「去哪找二进制」），gguf 目录固定给一个。
const treeIo = {
  exists: (path) => {
    const text = String(path)
    return text.endsWith(exeName('llama-server')) || text === '/fake/files'
  },
  listDir: (dir) => (String(dir) === '/fake/files' ? ['local_model.gguf'] : []),
}

await ok('老版本 llama.cpp（没有 --load-mode / --fit）只给它能认的参数', async () => {
  const plan = planLaunch({
    port: 8090,
    modelPath: '/fake/files/local_model.gguf',
    ...treeIo,
    caps: new Set(['--model', '--host', '--port', '--ctx-size', '-c', '--n-predict']),
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.args.includes('--load-mode'), false)
  assert.equal(plan.args.includes('--fit'), false)
  assert.equal(plan.args.includes('--jinja'), false)
  assert.equal(plan.loadMode, '')
  assert.ok(plan.dropped.includes('--fit'))
})

await ok('没有 --fit 的老引擎：分层数退回数字，KV 量化不下发', async () => {
  // 老版 llama.cpp 的 --n-gpu-layers 只认数字（不认 auto），KV 量化的类型表也窄。
  // 判据必须有正向断言：不然「裁掉了」和「压根没拼」看起来一样。
  const args = llamaCppAutoArgs({
    modelPath: '/fake/files/local_model.gguf',
    caps: new Set(['--model', '--host', '--port', '--alias', '--n-gpu-layers', '--parallel', '-c']),
  })
  assert.equal(args.ok, true)
  assert.equal(args.modernEngine, false)
  assert.equal(args.args[args.args.indexOf('--n-gpu-layers') + 1], '99')
  assert.equal(args.args.includes('--cache-type-k'), false)
  assert.equal(args.args.includes('--cache-type-v'), false)
  assert.equal(args.args.includes('--fit'), false)
})

await ok('新引擎（有 --fit）：分层数给 auto，KV 量化为 q8_0', async () => {
  const args = llamaCppAutoArgs({
    modelPath: '/fake/files/local_model.gguf',
    caps: new Set([
      '--model', '--host', '--port', '--alias', '--n-gpu-layers',
      '--fit', '--parallel', '--jinja', '--cache-type-k', '--cache-type-v', '-c', '--n-predict',
    ]),
  })
  assert.equal(args.modernEngine, true)
  assert.equal(args.args[args.args.indexOf('--n-gpu-layers') + 1], 'auto')
  assert.equal(args.args[args.args.indexOf('--cache-type-k') + 1], 'q8_0')
  assert.deepEqual(args.dropped, [])
})

await ok('新版 llama.cpp（有 --load-mode）照常带上', async () => {
  const plan = planLaunch({
    port: 8090,
    modelPath: '/fake/files/local_model.gguf',
    loadMode: 'mmap',
    ...treeIo,
    caps: new Set([
      '--model',
      '--host',
      '--port',
      '--alias',
      '--n-gpu-layers',
      '--fit',
      '--parallel',
      '--jinja',
      '--cache-type-k',
      '--cache-type-v',
      '--load-mode',
      '-c',
      '--n-predict',
    ]),
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.args.includes('--load-mode'), true)
  assert.equal(plan.args[plan.args.indexOf('--load-mode') + 1], 'mmap')
  assert.deepEqual(plan.dropped, [])
})

await ok('探不出能力（caps = null）时不裁剪，保持旧行为', async () => {
  const plan = planLaunch({
    port: 8090,
    modelPath: '/fake/files/local_model.gguf',
    ...treeIo,
    caps: null,
    exec: () => {
      throw new Error('ENOENT')
    },
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.args.includes('--fit'), true)
  assert.equal(plan.args.includes('--jinja'), true)
})

console.log('=== 跨平台：资源预检不写死本机数字 ===')

await ok('checkModelFit：预留量可配，调大预留会让同一台机器从 ok 变 warn', async () => {
  const base = {
    sizeBytes: 3.5 * 1024 ** 3,
    totalMemBytes: 8 * 1024 ** 3,
    freeMemBytes: 3 * 1024 ** 3,
    gpuBytes: 0,
  }
  // 预算 = max(total - reserve, free) = max(6,3) = 6GB，3.5GB 放得下
  assert.equal(checkModelFit({ ...base, reserveBytes: 2 * 1024 ** 3 }).level, 'ok')
  // 预留拉到 6GB：预算 = max(2,3) = 3GB，3.5GB 超了 → 不再是 ok
  assert.notEqual(checkModelFit({ ...base, reserveBytes: 6 * 1024 ** 3 }).level, 'ok')
  // 预留 0：预算 = max(8,3) = 8GB，最宽松
  assert.equal(checkModelFit({ ...base, reserveBytes: 0 }).level, 'ok')
})

await ok('checkModelFit：统一内存不重复扣显存（Apple Silicon / 核显）', async () => {
  // 24GB 的 M 系列 Mac 装 16GB 模型：显存和内存是同一个池子，
  // 若还按 sizeBytes - gpuBytes 算，会把 16GB 算成 10GB → ratio 虚低 → 假宽松。
  const unified = checkModelFit({
    sizeBytes: 16 * 1024 ** 3,
    totalMemBytes: 24 * 1024 ** 3,
    freeMemBytes: 8 * 1024 ** 3,
    gpuBytes: 6 * 1024 ** 3,
    unified: true,
  })
  assert.equal(unified.hostBytes, 16 * 1024 ** 3)
  assert.equal(unified.unified, true)
  // 上限也是同一个池子，不是 memory + vram
  const tooBig = checkModelFit({
    sizeBytes: 20 * 1024 ** 3,
    totalMemBytes: 16 * 1024 ** 3,
    freeMemBytes: 4 * 1024 ** 3,
    gpuBytes: 6 * 1024 ** 3,
    unified: true,
  })
  assert.equal(tooBig.level, 'risky')
  // 非统一内存的老路径不受影响
  const discrete = checkModelFit({
    sizeBytes: 16 * 1024 ** 3,
    totalMemBytes: 24 * 1024 ** 3,
    freeMemBytes: 8 * 1024 ** 3,
    gpuBytes: 6 * 1024 ** 3,
  })
  assert.equal(discrete.hostBytes, 10 * 1024 ** 3)
})

await ok('checkModelFit：没有 GPU 时全额压内存，不假装有显存', async () => {
  const fit = checkModelFit({
    sizeBytes: 4 * 1024 ** 3,
    totalMemBytes: 16 * 1024 ** 3,
    freeMemBytes: 8 * 1024 ** 3,
    gpuBytes: 0,
    reserveBytes: 2 * 1024 ** 3,
  })
  assert.equal(fit.gpuBytes, 0)
  assert.equal(fit.hostBytes, 4 * 1024 ** 3)
  assert.equal(fit.level, 'ok')
})

console.log('=== 跨平台：加载模式白名单 ===')

await ok('normalizeLoadMode：只认五个值，其它当没填', async () => {
  for (const value of LOAD_MODES) assert.equal(normalizeLoadMode(value), value)
  assert.equal(normalizeLoadMode(' MMAP '), 'mmap')
  assert.equal(normalizeLoadMode('mmap+mlock'), 'mmap+mlock')
  assert.equal(normalizeLoadMode('no-mmap'), '')
  assert.equal(normalizeLoadMode(undefined), '')
})

console.log(`\n${passed} 项通过`)
