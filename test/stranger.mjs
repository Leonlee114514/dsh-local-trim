/**
 * 「这台机器上从来没见过 dsh-local-trim」的验收：把本机所有有利条件全部抹掉，
 * 看插件是**优雅退化**还是**崩**。
 *
 * 抹掉的东西：
 * - 没有 nvidia-smi / rocm-smi / sysctl（显存探测全失败）
 * - 家目录是空的（没有 ~/models、没有 WorkBuddy、没有任何 gguf）
 * - PATH 是空的（whichOnPath 找不到任何二进制）
 * - 三个平台各来一遍
 *
 * 判据：不许抛异常，不许出现 undefined / NaN / 空字符串路径，
 * 报错文案必须能让人知道下一步做什么。
 */

import assert from 'node:assert/strict'

const LF = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)

const platforms = ['win32', 'darwin', 'linux']
let failed = 0

for (const platform of platforms) {
  const lines = []
  const record = (ok, label, detail) => {
    lines.push((ok ? '  ✓ ' : '  ✗ ') + label + (detail === undefined ? '' : '  ' + detail))
    if (!ok) failed += 1
  }

  // 隔离进程：只保留能跑 node 的最小环境
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  // os.homedir() 的行为跟「真实 OS」绑定，不跟 process.platform 绑定：
  // 在本机（真 Windows）上它只认 USERPROFILE，HOME 完全不看，删掉 USERPROFILE
  // 还会退回真实的 C:/Users/<你>。所以两个变量都指到假目录，三平台才能一致。
  const fakeHome = platform === 'win32' ? 'C:' + BACKSLASH + 'nobody' : '/home/nobody'
  process.env.USERPROFILE = fakeHome
  process.env.HOME = fakeHome
  process.env.HOMEDRIVE = platform === "win32" ? "C:" : ""
  process.env.HOMEPATH = platform === "win32" ? BACKSLASH + "nobody" : ""
  delete process.env.LOCALAPPDATA
  delete process.env.APPDATA
  delete process.env.XDG_DATA_HOME
  delete process.env.DSH_LOCAL_MODELS_DIR
  delete process.env.OLLAMA_BIN
  delete process.env.LLAMA_SERVER_BIN
  delete process.env.VLLM_BIN
  delete process.env.LMSTUDIO_BIN
  process.env.PATH = ''

  // 显存探测：三条路全炸
  const deadExec = () => {
    throw new Error('command not found')
  }

  const m = await import('../lib/launcher.js?fresh=' + platform)

  console.log(LF + '=== 陌生机器（' + platform + '）：删掉本机所有有利条件 ===')

  const home = m.homeDir()
  record(
    home.length > 0 && !home.includes('Lyonl') && !home.includes('Users/')
      ? true
      : false,
    "家目录已经被换成假的（没有泄漏本机真实家目录）",
    home,
  )
  const paths = { homeDir: home, dataDir: m.dataDir() }
  for (const [name, value] of Object.entries(paths)) {
    const clean =
      typeof value === 'string' &&
      value.length > 0 &&
      !value.includes('undefined') &&
      !value.includes('NaN') &&
      !value.includes('//')
    record(clean, name + ' 仍然可用', value)
  }

  const roots = m.modelRoots()
  record(roots.length > 0 && roots.every((r) => typeof r === 'string' && !r.includes('undefined')), 'modelRoots 全部是有效字符串', roots.length + ' 条')

  const dirs = m.localModelDirs()
  record(dirs.every((d) => typeof d === 'string' && d.length > 0 && !d.includes('undefined')), 'localModelDirs 没有空串/undefined', dirs.length + ' 条')

  // 空文件系统：什么都没有
  const emptyIo = { exists: () => false, existsSync: () => false, listDir: () => [] }

  const auto = m.llamaCppAutoArgs({ ...emptyIo, dirs: ['/nowhere/at/all'] })
  record(auto.ok === false && auto.reason === 'no-model', '一个 gguf 都没有时明说 no-model', auto.reason)
  record(typeof auto.dirs?.length === 'number' && auto.dirs.length > 0, '同时报出找过哪些目录', (auto.dirs ?? []).length + ' 个')

  const scan = m.scanLocalModels({ ...emptyIo, dirs: ['/nowhere/at/all'] })
  record(Array.isArray(scan) && scan.length === 0, '扫模型返回空数组而不是抛错', scan.length)
  record(scan.truncated === false, '空目录不算被截断', scan.truncated)

  for (const launcher of m.KNOWN_LAUNCHERS) {
    const list = launcher.candidates({})
    record(Array.isArray(list) && list.length > 0, launcher.id + ' 候选表非空', list.length + ' 个')
    record(list.every((item) => typeof item === 'string' && item.length > 0), launcher.id + ' 候选里没有空串')
  }

  // PATH 是空的 + 哪都没有二进制 = 必须给出可执行的下一步
  const plan = m.planLaunch({ port: 8090, ...emptyIo })
  record(plan.ok === false, '什么都没有时 planLaunch 明确失败', plan.error?.slice(0, 40) ?? 'no error')
  record(typeof plan.error === 'string' && plan.error.length > 10, '失败文案不是空的')
  record(/搜过|找|找不到|没找到|装/.test(String(plan.error)), '失败文案说清去哪了', String(plan.error).slice(0, 36))

  const unknownPort = m.planLaunch({ port: 54321, ...emptyIo })
  record(unknownPort.ok === false && typeof unknownPort.error === 'string', '不认识的端口也有明确说法', String(unknownPort.error).slice(0, 30))

  // 显存：三条路都炸 → 0，不能是 NaN
  const gpu = m.detectGpuInfo(deadExec, platform)
  record(gpu.bytes === 0 && gpu.vendor === 'none', '显存探测失败时退化到 0', JSON.stringify(gpu))

  const fit = m.checkModelFit({
    sizeBytes: 4 * 1024 * 1024 * 1024,
    totalMemBytes: 16 * 1024 * 1024 * 1024,
    freeMemBytes: 8 * 1024 * 1024 * 1024,
    gpuBytes: gpu.bytes,
    unified: gpu.unified,
  })
  record(['ok', 'warn', 'risky', 'unknown'].includes(fit.level), '没有显存时预检仍给出结论', fit.level + ' / ' + fit.ratio)
  record(!String(fit.label).includes('NaN') && !String(fit.label).includes('undefined'), '预检文案没有 NaN/undefined', fit.label)

  // --help 探测：二进制都不存在 → null（不裁剪），不能抛
  const caps = m.probeHelpCaps('/nowhere/llama-server', deadExec)
  record(caps === null, '探测不到能力时返回 null（不裁剪任何参数）', String(caps))

  // 拿不到体积时的预检
  const unknownFit = m.checkModelFit({})
  record(unknownFit.level === 'unknown', '拿不到体积时标 unknown 而不是瞎判', unknownFit.label)

  console.log(lines.join(LF))
}

if (failed > 0) {
  console.log(LF + '=== 陌生机器验收：' + failed + ' 处不合格 ===')
  process.exitCode = 1
} else {
  console.log(LF + '=== 陌生机器验收全部通过（三平台 × 无 GPU × 无模型 × 空 PATH）===')
}
