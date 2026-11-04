/**
 * 在不换机器的情况下验证「Linux / macOS 上的推演结果」。
 *
 * process.platform 是只读属性，但可以在 import 之前用 defineProperty 覆盖 ——
 * launcher.js 顶部的 `const WIN = process.platform === 'win32'` 就是在 import 时求值的，
 * 所以只要在 import 之前改掉，模块里所有分支都会按目标平台展开。
 *
 * 有一个例外：`os.homedir()` 查的是真实 OS，改 platform 骗不到它。所以本脚本对
 * homeDir / dataDir / modelRoots 只断言「不含 undefined、是绝对路径」，不断言前缀 ——
 * 前缀来自真实家目录，那是 `homeDir()` 的正确行为（优先 os.homedir()）。
 * 真正要验的是**候选表**：它在别的平台上必须吐出 POSIX 路径，不能是 C:/... 或反斜杠。
 */

const target = process.argv[2] ?? 'linux'
const LF = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)

Object.defineProperty(process, 'platform', { value: target, configurable: true })
if (target === 'win32') {
  process.env.USERPROFILE = 'C:' + BACKSLASH + 'Users' + BACKSLASH + 'demo'
} else {
  process.env.HOME = '/home/demo'
  delete process.env.USERPROFILE
  delete process.env.LOCALAPPDATA
  delete process.env.APPDATA
  delete process.env.XDG_DATA_HOME
}

const m = await import('../lib/launcher.js')

const bad = []
function show(label, value) {
  console.log(LF + '[' + label + '] ' + value)
}

// 路径类：只要求不含 undefined / 双斜杠、且不以 'undefined' 开头
function checkPath(label, value) {
  if (typeof value !== 'string') return
  if (value.includes('undefined')) bad.push(label + ' 含 undefined: ' + value)
  if (value.includes('//')) bad.push(label + ' 含双斜杠: ' + value)
  if (value.length > 1 && value.endsWith('/')) bad.push(label + ' 以斜杠结尾: ' + value)
}

show('platform', target)
const home = m.homeDir()
const data = m.dataDir()
show('homeDir', home)
show('dataDir', data)
checkPath('homeDir', home)
checkPath('dataDir', data)

const roots = m.modelRoots()
show('modelRoots', roots.join(' | '))
for (const root of roots) checkPath('modelRoots', root)

const dirs = m.localModelDirs()
show('localModelDirs', dirs.length + ' 条')
for (const dir of dirs) checkPath('localModelDirs', dir)

// 候选表：这是跨平台正确性的核心断言
for (const launcher of m.KNOWN_LAUNCHERS) {
  const list = launcher.candidates({})
  show(launcher.id + '.candidates', list.join(' | '))
  if (list.length === 0) bad.push(launcher.id + ' 候选表为空')
  if (list[list.length - 1].includes('/') || list[list.length - 1].includes(BACKSLASH)) {
    bad.push(launcher.id + ' 最后一个候选应该是裸名，实际: ' + list[list.length - 1])
  }
  const seen = new Set()
  for (const item of list) {
    if (item.includes('undefined')) bad.push(launcher.id + ' 候选含 undefined: ' + item)
    if (seen.has(item)) bad.push(launcher.id + ' 候选重复: ' + item)
    seen.add(item)
    // 最后一个候选是裸名（交给 whichOnPath / PATH 去找），不带扩展名是设计如此
    const isBare = !item.includes(BACKSLASH) && !item.includes('/')
    if (target === 'win32') {
      // 带目录的候选必须是 .exe；不带目录的（交给 PATH 解析）可以是
      // `vllm.exe` 也可以是不带扩展名的 `vllm`，两种都能被 spawn 找到。
      if (!isBare && !item.endsWith('.exe')) {
        bad.push(launcher.id + ' Windows 上绝对路径候选没有 .exe: ' + item)
      }
    } else if (item.startsWith('C:/') || item.includes(BACKSLASH)) {
      bad.push(launcher.id + ' 在 ' + target + ' 上吐出了 Windows 路径: ' + item)
    }
  }
}

console.log(LF + '---')
if (bad.length === 0) {
  console.log('PASS：' + target + ' 上路径推导正常，候选表无 Windows 残留、无 undefined、无重复')
} else {
  console.log('FAIL：' + bad.length + ' 处问题')
  for (const item of bad) console.log('  · ' + item)
  process.exitCode = 1
}
