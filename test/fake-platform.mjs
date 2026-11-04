/**
 * 用 `--import` 在**任何测试文件加载之前**改掉 `process.platform`。
 *
 * 为什么需要它：`test/platform-sim.mjs` 只能验「候选表长什么样」，验不了
 * 「测试用例本身有没有写死 Windows 假设」——比如断言里写 `lms.exe`，
 * 在 macOS CI 上会直接红。这类问题只有把整套测试按目标平台跑一遍才暴露。
 *
 * 用法：`DSH_SIM_PLATFORM=darwin node --import ./test/fake-platform.mjs test/portable.mjs`
 *
 * 局限（必须知道）：
 * - `os.homedir()`、`process.env.PATH`、真实文件系统都还是本机的，改不掉。
 * - 所以别指望它替代真机 CI。它的定位是「本机提前预警」，真机 CI 才是判据。
 */

const target = String(process.env.DSH_SIM_PLATFORM ?? '').trim()
if (target === 'linux' || target === 'darwin' || target === 'win32') {
  Object.defineProperty(process, 'platform', { value: target, configurable: true })
}
