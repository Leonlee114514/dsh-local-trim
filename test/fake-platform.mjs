/**
 * 用 `--import` 在**任何测试文件加载之前**改掉 `process.platform`，并且把
 * `os.homedir()` 也指到一个不存在的地方。
 *
 * 为什么需要它：`test/platform-sim.mjs` 只能验「候选表长什么样」，验不了
 * 「测试用例本身有没有写死 Windows 假设」——比如断言里写 `lms.exe`，
 * 在 macOS CI 上会直接红。这类问题只有把整套测试按目标平台跑一遍才暴露。
 *
 * 为什么连家目录也要改：真实的 Windows 上 `os.homedir()` 只认 `USERPROFILE`
 * （实测：删掉它反而退回真实家目录，`HOME` 根本不看）；Linux/macOS 认 `HOME`。
 * 不回的话，模拟 darwin 时 `homeDir()` 仍返回 `C:/Users/<你>`，候选表里就混进
 * 一堆 `C:/...` —— 那正是要抓的东西。
 *
 * 用法：`DSH_SIM_PLATFORM=darwin node --import ./test/fake-platform.mjs test/portable.mjs`
 *
 * 局限（必须知道）：
 * - `process.env.PATH`、真实文件系统、`nvidia-smi` 都还是本机的。
 * - 所以别指望它替代真机 CI。它的定位是「本机提前预警」，真机 CI 才是判据。
 *   `test/stranger.mjs` 才是那个把一切有利条件都删掉的用例。
 */

const BACKSLASH = String.fromCharCode(92)
const target = String(process.env.DSH_SIM_PLATFORM ?? '').trim()

if (target === 'linux' || target === 'darwin' || target === 'win32') {
  Object.defineProperty(process, 'platform', { value: target, configurable: true })

  // 家目录指到一个肯定不存在的地方。单斜杠绝对路径在三个平台上语义一致，
  // 也不会意外命中本机任何真实目录。
  const fakeHome = '/sim/nobody'
  process.env.USERPROFILE = fakeHome
  process.env.HOME = fakeHome
  if (target === 'win32') {
    process.env.HOMEDRIVE = 'C:'
    process.env.HOMEPATH = BACKSLASH + 'sim' + BACKSLASH + 'nobody'
  } else {
    delete process.env.HOMEDRIVE
    delete process.env.HOMEPATH
  }
  delete process.env.LOCALAPPDATA
  delete process.env.XDG_DATA_HOME
}
