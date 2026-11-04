/**
 * 把「假装自己是 Linux / macOS」跑整套测试这件事做成跨平台入口。
 *
 * 为什么不用 `DSH_SIM_PLATFORM=linux node ...`：那套前缀语法只在 POSIX shell 里成立，
 * Windows 的 cmd / npm script 直接报「不是内部或外部命令」。这里用 child_process
 * 显式传 env，三种平台都能跑。
 *
 * `--import ./test/fake-platform.mjs` 必须在目标脚本之前生效：`process.platform`
 * 在模块求值时就已定下（launcher.js 顶部的 `const WIN = process.platform === 'win32'`
 * 是 import 时算的），所以只能靠预加载改，不能等测试文件跑起来再改。
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const preload = join(here, 'fake-platform.mjs')

const platforms = ['linux', 'darwin']
const suites = ['portable.mjs', 'launcher.mjs', 'panel-host.mjs']

let failed = 0
for (const platform of platforms) {
  for (const suite of suites) {
    const script = join(here, suite)
    process.stdout.write('--- ' + platform + ' / ' + suite + '\n')
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script], {
      stdio: 'inherit',
      env: { ...process.env, DSH_SIM_PLATFORM: platform },
    })
    if (result.status !== 0) {
      failed += 1
      process.stdout.write('!!! ' + platform + ' / ' + suite + ' 失败\n')
    }
  }
}

if (failed > 0) {
  console.log('\n=== 有 ' + failed + ' 套在模拟平台上失败 ===')
  process.exitCode = 1
} else {
  console.log('\n=== 模拟平台（linux / darwin）全部通过 ===')
}
