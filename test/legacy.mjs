/**
 * test/legacy.mjs — 旧版本默认值的识别与迁移。
 *
 * 为什么需要这一套：
 *   配置字段（keep / dropSections / dropContexts）一旦写进 profile 的
 *   cordis.patch.yml 就永久留着。插件升级改了默认值，老用户读到的仍是
 *   上一版的默认值，而插件分不清那是「用户显式配的」还是「旧默认值被固化」。
 *   于是新默认值对老用户永远不生效，而且没有任何地方会说这件事。
 *
 * 判据必须同时满足两条互相拉扯的要求：
 *   ① 认得出「旧默认值被固化」——包括用户从里面删过几条的情况（本机就是
 *      0.5.1 的 19 条删掉 working_directory 存成 18 条）；
 *   ② 不能把真正自定义过的集合也当成旧默认值改掉 —— 那是在改用户的配置。
 *
 * 用法：node test/legacy.mjs
 */

import assert from 'node:assert/strict'

import {
  DEFAULT_DROP_CONTEXTS,
  DEFAULT_DROP_SECTIONS,
  DEFAULT_KEEP,
  LEGACY_DEFAULTS,
  migrateLegacyList,
} from '../lib/defaults.js'

import { buildPanelStatus, summarizeLegacy } from '../lib/status.js'

let passed = 0
const ok = async (name, fn) => {
  await fn()
  passed += 1
  console.log('  ✓ ' + name)
}

const v051 = LEGACY_DEFAULTS.find((entry) => entry.version === '0.5.1')
const v052 = LEGACY_DEFAULTS.find((entry) => entry.version === '0.5.2')

console.log('\n旧默认值表本身')

await ok('0.5.1 / 0.5.2 两版都在，且都带 keep 与 dropSections', async () => {
  assert.ok(v051, '缺 0.5.1')
  assert.ok(v052, '缺 0.5.2')
  for (const entry of [v051, v052]) {
    assert.ok(Array.isArray(entry.keep) && entry.keep.length > 0)
    assert.ok(Array.isArray(entry.dropSections) && entry.dropSections.length > 0)
  }
})

await ok('0.5.1 的 keep 是 19 条（含 5 个 scoped 名 + working_directory）', async () => {
  assert.equal(v051.keep.length, 19)
  for (const name of ['ops_bash', 'ops_glob', 'ops_grep', 'ops_read_files', 'ops_inspect_local_file', 'working_directory']) {
    assert.ok(v051.keep.includes(name), `0.5.1 的 keep 里应该有 ${name}`)
  }
})

await ok('0.5.2 的 keep 与当前默认值相同，dropSections 只多一条 dsh-purge:anchor', async () => {
  assert.deepEqual(v052.keep, DEFAULT_KEEP)
  assert.deepEqual(
    [...v052.dropSections].sort(),
    [...DEFAULT_DROP_SECTIONS, 'dsh-purge:anchor'].sort(),
  )
})

await ok('0.5.1 的 dropSections 是 0.5.2 的超集（含 tool:workflow）', async () => {
  assert.equal(v051.dropSections.length, 18)
  for (const name of v052.dropSections) assert.ok(v051.dropSections.includes(name), `0.5.1 应该包含 ${name}`)
  assert.ok(v051.dropSections.includes('tool:workflow'))
})

console.log('\n认得出旧默认值')

await ok('0.5.1 的 keep 原样 → 按当前默认值翻译，报出补的和丢的', async () => {
  const hit = migrateLegacyList(v051.keep, DEFAULT_KEEP, 'keep')
  assert.ok(hit, '应该命中 0.5.1')
  assert.equal(hit.version, '0.5.1')
  // 0.5.2 起不再收 scoped 名（宿主只认全局名），所以这 5 个要丢掉。
  for (const name of ['ops_bash', 'ops_glob', 'ops_grep', 'ops_read_files', 'ops_inspect_local_file']) {
    assert.ok(hit.dropped.includes(name), `应该丢掉 ${name}`)
  }
  // 0.5.2 新增的 apply_patch 要补上。
  assert.ok(hit.added.includes('apply_patch'), '应该补上 apply_patch')
  assert.deepEqual(hit.removed, [])
  assert.deepEqual([...hit.next].sort(), [...DEFAULT_KEEP].sort())
})

await ok('本机那种「0.5.1 减掉 working_directory」也认得出，且不把 working_directory 加回来', async () => {
  // 用户注释：working_directory 与 read_image 同时出现会让某条免费通道 429，
  // 所以他手动删掉了。迁移必须尊重这个删减。
  const stored = v051.keep.filter((name) => name !== 'working_directory')
  assert.equal(stored.length, 18)
  const hit = migrateLegacyList(stored, DEFAULT_KEEP, 'keep')
  assert.ok(hit, '删过一条也应该认得出')
  assert.equal(hit.version, '0.5.1')
  assert.deepEqual(hit.removed, ['working_directory'])
  assert.ok(!hit.next.includes('working_directory'), '用户删掉的不该被加回来')
  assert.ok(hit.next.includes('apply_patch'), '新默认值里的 apply_patch 仍要补上')
  assert.equal(hit.next.length, DEFAULT_KEEP.length - 1)
})

await ok('0.5.2 的 dropSections 报 0.5.2（不是 0.5.1）', async () => {
  // 0.5.2 的 dropSections 是 0.5.1 的真子集，正序遍历会先命中 0.5.1，
  // 日志里就会说错版本号。这条断言就是钉住「从新往旧找」。
  const hit = migrateLegacyList(v052.dropSections, DEFAULT_DROP_SECTIONS, 'dropSections')
  assert.ok(hit)
  assert.equal(hit.version, '0.5.2')
  assert.deepEqual(hit.dropped, ['dsh-purge:anchor'])
  assert.deepEqual([...hit.next].sort(), [...DEFAULT_DROP_SECTIONS].sort())
})

await ok('0.5.1 的 dropSections 报 0.5.1，丢掉两条死条目', async () => {
  const hit = migrateLegacyList(v051.dropSections, DEFAULT_DROP_SECTIONS, 'dropSections')
  assert.ok(hit)
  assert.equal(hit.version, '0.5.1')
  assert.deepEqual([...hit.dropped].sort(), ['dsh-purge:anchor', 'tool:workflow'])
  assert.deepEqual([...hit.next].sort(), [...DEFAULT_DROP_SECTIONS].sort())
})

console.log('\n不误伤用户自己的配置')

await ok('多了一个自己加的名字 → 不是旧默认值，原样不动', async () => {
  const stored = [...v051.keep, 'my_private_tool']
  assert.equal(migrateLegacyList(stored, DEFAULT_KEEP, 'keep'), null)
})

await ok('少到只剩两条 → 用户手工精简过，原样不动', async () => {
  const stored = ['bash', 'read']
  assert.equal(migrateLegacyList(stored, DEFAULT_KEEP, 'keep'), null)
})

await ok('删减超过两成就算手工精简，不动', async () => {
  // 19 条里删 4 条 = 21% > 20% 阈值。
  const stored = v051.keep.filter((name) => !['ops_bash', 'ops_glob', 'ops_grep', 'working_directory'].includes(name))
  assert.equal(migrateLegacyList(stored, DEFAULT_KEEP, 'keep'), null)
})

await ok('删减正好两成（含）仍然认得出', async () => {
  // 19 条删 3 条 = 15.8% ≤ 20%，属于「顺手删了几条」，应该迁移。
  const stored = v051.keep.filter((name) => !['ops_bash', 'ops_glob', 'ops_grep'].includes(name))
  const hit = migrateLegacyList(stored, DEFAULT_KEEP, 'keep')
  assert.ok(hit)
  assert.equal(hit.removed.length, 3)
})

await ok('当前默认值本身 → 没有变化，返回 null（不重复报）', async () => {
  assert.equal(migrateLegacyList([...DEFAULT_KEEP], DEFAULT_KEEP, 'keep'), null)
  assert.equal(migrateLegacyList([...DEFAULT_DROP_SECTIONS], DEFAULT_DROP_SECTIONS, 'dropSections'), null)
  assert.equal(migrateLegacyList([...DEFAULT_DROP_CONTEXTS], DEFAULT_DROP_CONTEXTS, 'dropContexts'), null)
})

await ok('空数组 / 单个名字 / 非数组 → 一律不管', async () => {
  assert.equal(migrateLegacyList([], DEFAULT_KEEP, 'keep'), null)
  assert.equal(migrateLegacyList(['bash'], DEFAULT_KEEP, 'keep'), null)
  assert.equal(migrateLegacyList(undefined, DEFAULT_KEEP, 'keep'), null)
  assert.equal(migrateLegacyList('bash read', DEFAULT_KEEP, 'keep'), null)
})

console.log('\n面板文案')

await ok('没命中时 summarizeLegacy 返回 null，面板一个字都不多说', async () => {
  assert.equal(summarizeLegacy(undefined), null)
  assert.equal(summarizeLegacy({}), null)
  assert.equal(summarizeLegacy({ keep: null, dropSections: null, dropContexts: null }), null)
})

await ok('命中时给出 warn 标签、版本号与逐字段明细', async () => {
  const hit = migrateLegacyList(v051.keep, DEFAULT_KEEP, 'keep')
  const view = summarizeLegacy({ keep: hit, dropSections: null, dropContexts: null })
  assert.ok(view)
  assert.equal(view.tone, 'warn')
  assert.equal(view.version, '0.5.1')
  assert.deepEqual(view.fields, ['keep'])
  assert.match(view.label, /0\.5\.1/)
  assert.match(view.label, /默认值/)
  assert.match(view.detail, /apply_patch/)
  assert.match(view.detail, /ops_glob/)
})

await ok('多个字段同时命中：版本号去重、字段都列出来', async () => {
  const keepHit = migrateLegacyList(v051.keep, DEFAULT_KEEP, 'keep')
  const dropHit = migrateLegacyList(v051.dropSections, DEFAULT_DROP_SECTIONS, 'dropSections')
  const view = summarizeLegacy({ keep: keepHit, dropSections: dropHit, dropContexts: null })
  assert.ok(view)
  assert.equal(view.version, '0.5.1')
  assert.deepEqual([...view.fields].sort(), ['dropSections', 'keep'])
  assert.match(view.label, /配置是 0\.5\.1 的默认值/)
})

await ok('只有 removed、没有 added/dropped 的命中不提示（那等于没变）', async () => {
  const view = summarizeLegacy({ keep: { version: '0.5.1', added: [], dropped: [], removed: ['x'] } })
  assert.equal(view, null)
})

await ok('buildPanelStatus 把 legacy 透传出来（面板拿得到）', async () => {
  const hit = migrateLegacyList(v051.keep, DEFAULT_KEEP, 'keep')
  const view = buildPanelStatus({
    takeover: { ok: true, via: 'accessor' },
    values: { promptTrim: true, schemaTrim: true },
    providers: [],
    online: {},
    legacy: { keep: hit, dropSections: null, dropContexts: null },
  })
  assert.ok(view.legacy)
  assert.equal(view.legacy.tone, 'warn')
  assert.equal(view.legacy.version, '0.5.1')
})

await ok('没传 legacy 时面板视图里是 null，不是 undefined', async () => {
  const view = buildPanelStatus({ takeover: { ok: true, via: 'accessor' }, values: {}, providers: [], online: {} })
  assert.equal(view.legacy, null)
})

console.log('\n' + passed + ' 项通过')
