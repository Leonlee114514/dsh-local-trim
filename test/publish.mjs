/**
 * test/publish.mjs — 发布就绪自检（不联网、不真的发布）。
 *
 * 背景：这个插件目前只能从 `github:` 源装，而宿主从 git 源装之前会先跑
 * `git ls-remote` —— 机器上没有 git 就直接失败，报错还指错方向
 * （说 allowBuilds / 说 pnpm 坏了）。发布到 npm 之后这条路才绕开 git。
 *
 * 所以这里钉住「发上去能装」的几件事：
 *   1. publishConfig 声明公开可发
 *   2. files 覆盖运行时真正会加载的东西（漏一个就是装上去少文件）
 *   3. dsh.bundle / dsh.client 声明在包里（否则装完不生效或没面板）
 *   4. schemastery 保持 optional peer（不能变成硬依赖，那会把宿主那份覆盖掉）
 *   5. 入口文件真的在磁盘上
 *
 * 用法：node test/publish.mjs
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

let fail = 0
const check = (label, ok, extra = '') => {
  if (!ok) fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

console.log('\n=== 1. 能公开发布 ===')
check('publishConfig.access = public', pkg.publishConfig?.access === 'public', String(pkg.publishConfig?.access))
check('指向官方 registry', pkg.publishConfig?.registry === 'https://registry.npmjs.org/', String(pkg.publishConfig?.registry))
check('license 有值', typeof pkg.license === 'string' && pkg.license.length > 0, String(pkg.license))
check('version 是正式版号（不是 0.0.0）', /^\d+\.\d+\.\d+/.test(pkg.version), pkg.version)
check('不是 private', pkg.private !== true)
// scope 包才需要 access=public 的语义，但无 scope 包也允许写；这里只确认没写成 restricted。
check('没写成 restricted', pkg.publishConfig?.access !== 'restricted')

console.log('\n=== 2. files 覆盖运行时会加载的东西 ===')

// 这三个是装完必须存在的：lib 半边入口、client 半边 bundle、bundle patch。
const required = ['lib', 'client.js', 'cordis.patch.yml']
const files = Array.isArray(pkg.files) ? pkg.files : []
for (const entry of required) {
  const covered = files.some((pattern) => {
    const clean = String(pattern).replace(/^\.\//, '').replace(/\/$/, '')
    return clean === entry
  })
  check(`files 里有 ${entry}`, covered, files.join(', '))
}

// README / LICENSE 即使不写进 files npm 也会自动带上，写不写都行 —— 这里不判。
check('files 不含 test/（测试不进包）', !files.some((pattern) => /^test\b/.test(String(pattern).replace(/^\.\//, ''))))

console.log('\n=== 3. 入口与 bundle 声明 ===')

const mainPath = join(ROOT, String(pkg.main ?? 'index.js'))
check('main 指向的文件真实存在', existsSync(mainPath), pkg.main)
check('main 文件非空', existsSync(mainPath) && statSync(mainPath).size > 0)

const exportRoot = pkg.exports?.['.']
check('exports["."] 指向 lib/index.js', exportRoot === './lib/index.js', String(exportRoot))
check('exports["./client"] 指向 client.js', pkg.exports?.['./client'] === './client.js', String(pkg.exports?.['./client']))
check('exports 暴露 package.json（宿主读 dsh 字段要用）', pkg.exports?.['./package.json'] === './package.json')

const patch = pkg.dsh?.bundle?.patch
check('dsh.bundle.patch 声明了', typeof patch === 'string' && patch.length > 0, String(patch))
check(
  'patch 文件真实存在',
  typeof patch === 'string' && existsSync(join(ROOT, patch.replace(/^\.\//, ''))),
  String(patch),
)
if (typeof patch === 'string') {
  const text = readFileSync(join(ROOT, patch.replace(/^\.\//, '')), 'utf8')
  check('patch 里引用了本插件', text.includes('dsh-local-trim'))
}

check('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
const clientInject = pkg.dsh?.client?.inject
check(
  'dsh.client.inject 声明了 client-ui-plugin-manager',
  Array.isArray(clientInject) && clientInject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'),
  JSON.stringify(clientInject),
)
check('engines.dsh 声明了最低版本', typeof pkg.dsh?.engines?.dsh === 'string', String(pkg.dsh?.engines?.dsh))
check('engines.node 声明了', typeof pkg.engines?.node === 'string', String(pkg.engines?.node))

console.log('\n=== 4. schemastery 不能变成硬依赖 ===')

// 宿主进程里有自己的 schemastery（app 侧 3.19.0）。如果这里把它写成 dependencies，
// profile 里会多装一份副本，插件和宿主就可能拿着两个不同实例的 schema ——
// 而且「optional peer」的语义一旦丢掉，pnpm 会去网络上拉，慢且更容易失败。
check('没有 dependencies（或为空）', pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies))
check(
  'schemastery 在 peerDependencies 里',
  typeof pkg.peerDependencies?.['@deepseek-ai/schemastery'] === 'string',
  String(pkg.peerDependencies?.['@deepseek-ai/schemastery']),
)
check(
  'schemastery 标记为 optional',
  pkg.peerDependenciesMeta?.['@deepseek-ai/schemastery']?.optional === true,
  JSON.stringify(pkg.peerDependenciesMeta?.['@deepseek-ai/schemastery']),
)
check(
  'schemastery 仍在 devDependencies（本地跑测试要用）',
  typeof pkg.devDependencies?.['@deepseek-ai/schemastery'] === 'string',
  String(pkg.devDependencies?.['@deepseek-ai/schemastery']),
)

console.log('\n=== 5. files 里列的每一项都真实存在 ===')
// 写了但不存在不是致命错（npm 会忽略），但通常意味着改名后忘了更新 ——
// 那种情况下真正该进包的东西就悄悄没了。
for (const pattern of files) {
  const clean = String(pattern).replace(/^\.\//, '')
  const target = join(ROOT, clean.replace(/\/$/, ''))
  check(`  ${clean} 存在`, existsSync(target))
}

console.log(`\n${fail === 0 ? '=== 发布就绪自检全部通过 ===' : `=== ${fail} 项失败 ===`}`)
process.exit(fail === 0 ? 0 : 1)
