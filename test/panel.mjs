/**
 * test/panel.mjs — 控制面板的纯逻辑自检（不起浏览器、不连网络）。
 *
 * 覆盖两块：
 *   lib/status.js        状态视图（接管文案、裁剪收益、provider 表、点灯计数）
 *   lib/import-model.js  导入流程（入参校验、provider id 生成、profile 拼装、试跑请求）
 *
 * 用法：node test/panel.mjs
 */

import assert from 'node:assert/strict'

import {
  buildPanelStatus,
  formatBytes,
  formatCount,
  isLocalProvider,
  summarizeClientHost,
  summarizeTakeover,
  summarizeTrim,
} from '../lib/status.js'

import {
  appendModelToProfile,
  backendFor,
  buildImportProfile,
  defaultProviderId,
  findReusableProvider,
  parseImportInput,
  pickModel,
  planAlign,
  planReconcile,
  sanitizeProviderId,
  smokeTest,
  summarizeProvider,
} from '../lib/import-model.js'

let passed = 0
const ok = async (name, fn) => {
  await fn()
  passed += 1
  console.log('  ✓ ' + name)
}

// ── status.js ────────────────────────────────────────────────────────────

console.log('status: 裁剪收益')

await ok('没裁剪过时给一句人话', () => {
  const result = summarizeTrim(null)
  assert.equal(result.seen, false)
  assert.equal(result.savedPct, 0)
  assert.match(result.label, /还没有裁剪记录/)
})

await ok('43,247 → 12,900 显示省 70.2%', () => {
  const result = summarizeTrim({ charsIn: 43247, charsOut: 12900, sectionsIn: 37, sectionsOut: 2, at: 1793587180418 })
  assert.equal(result.seen, true)
  assert.equal(result.savedPct, 70.2)
  assert.match(result.label, /43,247 → 12,900/)
  assert.match(result.label, /70\.2%/)
  assert.equal(result.sectionsIn, 37)
  assert.equal(result.sectionsOut, 2)
})

await ok('进=出 时说明未裁剪', () => {
  const result = summarizeTrim({ charsIn: 26428, charsOut: 26428 })
  assert.equal(result.savedPct, 0)
  assert.match(result.label, /未裁剪/)
})

await ok('charsIn = 0 不除零', () => {
  const result = summarizeTrim({ charsIn: 0, charsOut: 0 })
  assert.equal(result.savedPct, 0)
  assert.equal(Number.isFinite(result.savedPct), true)
})

console.log('status: 「一个字都没裁」的成因要分开说')

// 同样是「没裁」，处置完全不同：云端放行是设计如此，本地没命中才是要去查配置。
// 混成一句「未裁剪」，用户只能自己猜 —— 这几条断言就是钉住这个区分。

await ok('云端 provider 放行：说清是设计如此，还带上 provider 名', () => {
  const result = summarizeTrim({
    charsIn: 26428,
    charsOut: 26428,
    provider: 'deepseek-eo',
    local: false,
    reason: 'provider-not-local',
  })
  assert.equal(result.savedPct, 0)
  assert.equal(result.local, false)
  assert.equal(result.reason, 'provider-not-local')
  assert.match(result.label, /deepseek-eo/)
  assert.match(result.label, /不在裁剪路由里/)
})

await ok('本地 provider 但没命中：这条才是「该去查 dropSections」', () => {
  const result = summarizeTrim({
    charsIn: 26428,
    charsOut: 26428,
    provider: 'local-ollama',
    local: true,
    reason: 'nothing-matched',
  })
  assert.equal(result.local, true)
  assert.match(result.label, /local-ollama/)
  assert.match(result.label, /dropSections/)
  assert.doesNotMatch(result.label, /不在裁剪路由里/)
})

await ok('没拿到 provider 名：指出是装配侧的问题', () => {
  const result = summarizeTrim({ charsIn: 100, charsOut: 100, local: false, reason: 'no-provider' })
  assert.match(result.label, /没拿到 provider 名/)
})

// 地址明明是本地，配置却把自动识别关了 —— 这不是「设计如此」，是配置和预期打架，
// 必须指出来，否则用户只会看到「未裁剪」然后去翻 dropSections（方向完全错了）。
await ok('本地端点被配置排除：指出是 routes / autoDetectBaseURL 拦的', () => {
  const result = summarizeTrim({
    charsIn: 26428,
    charsOut: 26428,
    provider: 'local-ollama',
    local: false,
    reason: 'route-excluded',
  })
  assert.equal(result.reason, 'route-excluded')
  assert.match(result.label, /local-ollama/)
  assert.match(result.label, /自动识别关掉了/)
  assert.match(result.label, /routes 留空/)
  assert.doesNotMatch(result.label, /不在裁剪路由里（云端/)
})

await ok('promptTrim 被关掉：指出是配置关的，不是段名失效', () => {
  const result = summarizeTrim({ charsIn: 100, charsOut: 100, local: true, reason: 'trim-disabled' })
  assert.match(result.label, /promptTrim = false/)
})

await ok('没有 sections 可裁：不冒充段名失效', () => {
  const result = summarizeTrim({ charsIn: 100, charsOut: 100, local: true, reason: 'no-sections' })
  assert.match(result.label, /没有 sections/)
})

await ok('reason 缺失时退回老文案，不崩', () => {
  const result = summarizeTrim({ charsIn: 26428, charsOut: 26428 })
  assert.equal(result.reason, '')
  assert.match(result.label, /未裁剪/)
})

await ok('裁成功时 reason 一律为空（不把上轮的成因带过来）', () => {
  const result = summarizeTrim({
    charsIn: 43247,
    charsOut: 12900,
    provider: 'local-qwen',
    local: true,
    reason: '',
  })
  assert.equal(result.reason, '')
  assert.equal(result.local, true)
  assert.match(result.label, /省 70\.2%/)
})

console.log('status: 接管文案')

await ok('accessor+purge-slot 是好的，且说清是转发内层 slot', () => {
  const result = summarizeTakeover({ ok: true, via: 'accessor+purge-slot' }, { enabled: true })
  assert.equal(result.active, true)
  assert.equal(result.tone, 'good')
  assert.match(result.label, /slot/)
})

await ok('accessor-native 也认', () => {
  const result = summarizeTakeover({ ok: true, via: 'accessor-native' }, { enabled: true })
  assert.equal(result.tone, 'good')
  assert.match(result.label, /原生/)
})

await ok('没接管时把原因带出来', () => {
  const result = summarizeTakeover({ ok: false, via: 'none', reason: 'ctx.systemPrompt 为空' }, { enabled: true })
  assert.equal(result.active, false)
  assert.equal(result.tone, 'bad')
  assert.match(result.label, /ctx\.systemPrompt 为空/)
})

await ok('enabled=false 时不报警，只显示已关闭', () => {
  const result = summarizeTakeover({ ok: false, via: 'none', reason: '' }, { enabled: false })
  assert.equal(result.tone, 'muted')
  assert.match(result.label, /已关闭/)
})

console.log('status: provider 判定与计数')

await ok('回环/私有网段算本地', () => {
  assert.equal(isLocalProvider('x', 'http://127.0.0.1:11434/v1'), true)
  assert.equal(isLocalProvider('x', 'http://192.168.1.9:8090/v1'), true)
  assert.equal(isLocalProvider('x', 'http://host.docker.internal:8000/v1'), true)
})

await ok('名字带本地标记也算本地', () => {
  assert.equal(isLocalProvider('ollama-qwen', ''), true)
  assert.equal(isLocalProvider('my-lmstudio', ''), true)
  assert.equal(isLocalProvider('local-vllm-a', ''), true)
})

await ok('云端 provider 不算本地', () => {
  assert.equal(isLocalProvider('deepseek-eo', 'https://api.deepseek.com/v1'), false)
  assert.equal(isLocalProvider('anthropic', 'https://api.anthropic.com'), false)
})

// 名字里带 local/llama 的云端 provider 很多（openrouter-llama-3、together-llama…）。
// 有地址就必须以地址为准，否则会把公网请求当成本地裁掉 —— 那比漏裁危险得多。
await ok('有地址时以地址为准，名字不再翻案', () => {
  assert.equal(isLocalProvider('openrouter-llama-3', 'https://openrouter.ai/api/v1'), false)
  assert.equal(isLocalProvider('local-tunnel', 'https://my-tunnel.example.com/v1'), false)
  assert.equal(isLocalProvider('local-tunnel', ''), true)
})

// 以前拿正则 match 整串 URL，于是「域名前缀碰巧叫 localhost」的公网地址全被误判成本地。
await ok('域名前缀像 localhost 的公网地址不算本地', () => {
  assert.equal(isLocalProvider('x', 'http://localhost.attacker.com/v1'), false)
  assert.equal(isLocalProvider('x', 'http://localhost-evil.com/v1'), false)
  assert.equal(isLocalProvider('x', 'http://127.0.0.1.attacker.com/v1'), false)
  // userinfo 后面才是真 host：这条以前会被当成 127.0.0.1
  assert.equal(isLocalProvider('x', 'http://localhost@attacker.com/v1'), false)
})

await ok('回环整段 / CGNAT 算本地，APIPA 不算', () => {
  assert.equal(isLocalProvider('x', 'http://127.0.0.2:8090/v1'), true)
  assert.equal(isLocalProvider('x', 'http://127.1.2.3:8090/v1'), true)
  assert.equal(isLocalProvider('x', 'http://100.101.102.103:8000/v1'), true)
  // 169.254/16 是 APIPA（DHCP 没拿到地址时自己编的），上面没人跑推理服务。
  // 算本地只会让一条本来就通不了的配置照样被裁 —— 掩盖真正的问题。
  assert.equal(isLocalProvider('x', 'http://169.254.1.5:8000/v1'), false)
  // 172.16-31 是私有，两端外面不是
  assert.equal(isLocalProvider('x', 'http://172.16.0.1:8000/v1'), true)
  assert.equal(isLocalProvider('x', 'http://172.31.255.254:8000/v1'), true)
  assert.equal(isLocalProvider('x', 'http://172.15.0.1:8000/v1'), false)
  assert.equal(isLocalProvider('x', 'http://172.32.0.1:8000/v1'), false)
})

await ok('IPv6 与 mDNS / 单标签主机名也算本地', () => {
  assert.equal(isLocalProvider('x', 'http://[::1]:11434/v1'), true)
  assert.equal(isLocalProvider('x', 'http://[fd00::5]:8000/v1'), true)
  assert.equal(isLocalProvider('x', 'http://[fe80::1]:8000/v1'), true)
  assert.equal(isLocalProvider('x', 'http://macbook.local:8000/v1'), true)
  assert.equal(isLocalProvider('x', 'http://gpu-box:8000/v1'), true)
})

await ok('新后端名字也算本地', () => {
  assert.equal(isLocalProvider('mlx-lm', ''), true)
  assert.equal(isLocalProvider('local-llamacpp', ''), true)
  assert.equal(isLocalProvider('localai', ''), true)
  assert.equal(isLocalProvider('xinference', ''), true)
  assert.equal(isLocalProvider('ktransformers', ''), true)
  assert.equal(isLocalProvider('exo-cluster', ''), true)
  assert.equal(isLocalProvider('oobabooga', ''), true)
})

await ok('千分位格式化', () => {
  assert.equal(formatCount(43247), '43,247')
  assert.equal(formatCount(undefined), '—')
})

await ok('体积按量级换单位，不把 2MB 显示成 0.0GB', () => {
  assert.equal(formatBytes(16954484384), '15.8GB')
  assert.equal(formatBytes(2 * 1024 * 1024), '2MB')
  assert.equal(formatBytes(512 * 1024), '512KB')
  assert.equal(formatBytes(1073741824), '1.0GB')
  // 拿不到体积时是问号，不是 0GB —— 别让「不知道」看起来像「零字节」
  assert.equal(formatBytes(0), '?')
  assert.equal(formatBytes(undefined), '?')
  assert.equal(formatBytes(-1), '?')
})

await ok('面板主视图把三件事拼齐', () => {
  const status = buildPanelStatus({
    takeover: { ok: true, via: 'accessor+purge-slot' },
    values: { enabled: true, promptTrim: true, schemaTrim: false, debugWrap: false },
    trim: { charsIn: 1000, charsOut: 250, sectionsIn: 9, sectionsOut: 2, at: 1 },
    lightBody: { chars: 190, source: 'builtin' },
    provision: { status: 'registered', provider: 'local-llamacpp-qwen', detail: '已注册' },
    providers: [
      { id: 'local-llamacpp-qwen', profile: { displayName: 'Qwen 本地', baseURL: 'http://127.0.0.1:8090/v1', models: [{ id: 'qwen3-4b', contextWindow: 32768, maxTokens: 4096 }] } },
      { id: 'deepseek-eo', profile: { displayName: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-chat' }] } },
    ],
    online: { 'local-llamacpp-qwen': { ok: true, ms: 12 }, 'deepseek-eo': { ok: true, ms: 90 } },
    revision: 7,
    writable: true,
    logPath: '/tmp/x.log',
  })
  assert.equal(status.takeover.tone, 'good')
  assert.equal(status.trim.savedPct, 75)
  assert.equal(status.inject.chars, 190)
  assert.equal(status.flags.schemaTrim, false)
  assert.equal(status.counts.total, 2)
  assert.equal(status.counts.local, 1)
  // online 数的是**整张表**里后端够得着的（和 stale / staleModels 同一口径），
  // 云端那条 deepseek-eo 也是 ok:true，所以是 2 —— 它跟「本地 N 个」不是同集合。
  assert.equal(status.counts.online, 2)
  assert.equal(status.providers[0].state.tone, 'good')
  assert.match(status.providers[0].state.label, /12ms/)
  assert.equal(status.revision, 7)
})

await ok('点灯缺失时标「未检测」而不是连不上', () => {
  const status = buildPanelStatus({
    providers: [{ id: 'local-x', profile: { baseURL: 'http://127.0.0.1:8000/v1', models: [] } }],
    online: {},
  })
  assert.equal(status.providers[0].state.tone, 'muted')
  assert.match(status.providers[0].state.label, /未检测/)
})

await ok('连不上时把错误带出来', () => {
  const status = buildPanelStatus({
    providers: [{ id: 'local-x', profile: { baseURL: 'http://127.0.0.1:8000/v1', models: [] } }],
    online: { 'local-x': { ok: false, error: 'ECONNREFUSED' } },
  })
  assert.equal(status.providers[0].state.tone, 'bad')
  assert.match(status.providers[0].state.label, /ECONNREFUSED/)
})

console.log('status: 声明的模型 vs 后端真的有的')

// 面板原来只数 `models` 数组长度，用户 `ollama rm` 之后声明还在，面板照旧写「5 模型」。
// 这一组钉住「声明」和「实况」分开报，以及三种处置的颜色区分。

const twoModels = {
  id: 'local-ollama',
  profile: {
    baseURL: 'http://127.0.0.1:11434/v1',
    models: [{ id: 'gemma4:12b' }, { id: 'qwen3.5:9b' }],
  },
}

await ok('全都对得上：不报警，只报实况数量', () => {
  const status = buildPanelStatus({
    providers: [twoModels],
    online: {
      'local-ollama': { ok: true, ms: 10, models: [{ id: 'gemma4:12b' }, { id: 'qwen3.5:9b' }] },
    },
  })
  const row = status.providers[0]
  assert.equal(row.models.tone, undefined)
  assert.match(row.models.label, /2 模型/)
  assert.deepEqual(row.missingModels, [])
  assert.deepEqual(row.extraModels, [])
})

await ok('部分不在：warn，并说清几个不在了', () => {
  const status = buildPanelStatus({
    providers: [twoModels],
    online: { 'local-ollama': { ok: true, ms: 10, models: [{ id: 'gemma4:12b' }] } },
  })
  const row = status.providers[0]
  assert.equal(row.models.tone, 'warn')
  assert.deepEqual(row.missingModels, ['qwen3.5:9b'])
  assert.equal(row.liveModelCount, 1)
  assert.match(row.models.label, /1 模型/)
  assert.match(row.models.label, /1 个已不在后端/)
})

await ok('全都不在：bad（这条 provider 该删了，不是该改配置）', () => {
  const status = buildPanelStatus({
    providers: [twoModels],
    online: { 'local-ollama': { ok: true, ms: 10, models: [{ id: 'something-else' }] } },
  })
  const row = status.providers[0]
  assert.equal(row.models.tone, 'bad')
  assert.equal(row.missingModels.length, 2)
  assert.match(row.models.label, /全不在了/)
})

// 「在线」说的是这条 provider 能不能用，不是端口能不能 ping 通。
// 端点活着但模型全没了，点进去每个模型都是 404 —— 这时候挂绿点就是在骗人。
await ok('部分模型不在后端：徽章从绿降到 warn，不再只说「在线」', () => {
  const status = buildPanelStatus({
    providers: [twoModels],
    online: { 'local-ollama': { ok: true, ms: 10, models: [{ id: 'gemma4:12b' }] } },
  })
  const row = status.providers[0]
  assert.equal(row.state.tone, 'warn')
  assert.match(row.state.label, /在线/)
  assert.match(row.state.label, /10ms/)
  assert.match(row.state.label, /1 个模型不在后端/)
})

await ok('配置里的模型后端全没有：徽章直接 bad，并说清端口是通的', () => {
  const status = buildPanelStatus({
    providers: [twoModels],
    online: { 'local-ollama': { ok: true, ms: 10, models: [{ id: 'something-else' }] } },
  })
  const row = status.providers[0]
  assert.equal(row.state.tone, 'bad')
  assert.match(row.state.label, /端口通/)
  assert.match(row.state.label, /全没有/)
  assert.doesNotMatch(row.state.label, /^连不上/)
})

await ok('探测没回模型清单（live 未知）时保持绿：不知道 ≠ 没有', () => {
  const status = buildPanelStatus({
    providers: [twoModels],
    online: { 'local-ollama': { ok: true, ms: 10 } },
  })
  const row = status.providers[0]
  assert.equal(row.state.tone, 'good')
  // 仍然是绿灯（端口确实通），但必须说清「没核对」—— 否则和「核对过、全都在」
  // 长得一模一样，用户会以为已经对过账了。
  assert.match(row.state.label, /^在线 · 10ms/)
  assert.match(row.state.label, /没核对/)
  assert.deepEqual(row.missingModels, [])
})

await ok('表头「在线 N 个」跟行徽章同一套判据：全死的不算在线', () => {
  const status = buildPanelStatus({
    providers: [
      { id: 'local-a', profile: { baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'x' }] } }, // 全死
      { id: 'local-b', profile: { baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'y' }] } }, // 活
      { id: 'local-c', profile: { baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'z' }, { id: 'w' }] } }, // 部分死
    ],
    online: {
      'local-a': { ok: true, ms: 10, models: [] },
      'local-b': { ok: true, ms: 10, models: [{ id: 'y' }] },
      'local-c': { ok: true, ms: 10, models: [{ id: 'z' }] },
    },
  })
  assert.equal(status.counts.local, 3)
  // a 全死 → 不算；b 一致 → 算；c 部分不在 → 还算（能用，只是配置该改）
  assert.equal(status.counts.online, 2)
})

await ok('表头汇总：几条对不上、一共几条旧模型', () => {
  const status = buildPanelStatus({
    providers: [
      twoModels, // 一条死
      { id: 'local-ollama-gemma4-12b', profile: { baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'gemma4:12b' }] } }, // 活着
      { id: 'local-ollama-qwen3-14b', profile: { baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen3:14b' }] } }, // 一条死
    ],
    online: {
      'local-ollama': { ok: true, ms: 10, models: [{ id: 'gemma4:12b' }] },
      'local-ollama-gemma4-12b': { ok: true, ms: 10, models: [{ id: 'gemma4:12b' }] },
      'local-ollama-qwen3-14b': { ok: true, ms: 10, models: [] },
    },
  })
  assert.equal(status.counts.total, 3)
  assert.equal(status.counts.stale, 2)
  // twoModels 剩 1 条活、qwen3-14b 那条 1 条全死 → 一共 1 + 1 = 2 条旧模型
  assert.equal(status.counts.staleModels, 2)
})

await ok('后端有、配置没注册：提一句但不报警', () => {
  const status = buildPanelStatus({
    providers: [twoModels],
    online: {
      'local-ollama': { ok: true, ms: 10, models: [{ id: 'gemma4:12b' }, { id: 'qwen3.5:9b' }, { id: 'llama4:scout' }] },
    },
  })
  const row = status.providers[0]
  assert.equal(row.models.tone, undefined)
  assert.deepEqual(row.extraModels, ['llama4:scout'])
  assert.match(row.models.label, /后端还有 1 个没注册/)
})

// Ollama 的 /api/tags 永远给带 tag 的全名，用户手写配置常省掉 `:latest`。
// 不归一化就会把每一条都判成「已删除」—— 全表飘红比不报还糟。
await ok('省略 :latest 不算不一致', () => {
  const status = buildPanelStatus({
    providers: [{ id: 'local-ollama', profile: { baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'nomic-embed-text' }] } }],
    online: { 'local-ollama': { ok: true, ms: 10, models: [{ id: 'nomic-embed-text:latest' }] } },
  })
  const row = status.providers[0]
  assert.deepEqual(row.missingModels, [])
  assert.deepEqual(row.extraModels, [])
  assert.equal(row.models.tone, undefined)
})

await ok('文件式的 gguf id 不补 :latest（不然 llama.cpp 全飘红）', () => {
  const status = buildPanelStatus({
    providers: [{ id: 'local-llamacpp', profile: { baseURL: 'http://127.0.0.1:8090/v1', models: [{ id: 'models/qwen.gguf' }] } }],
    online: { 'local-llamacpp': { ok: true, ms: 10, models: [{ id: 'models/qwen.gguf' }] } },
  })
  assert.deepEqual(status.providers[0].missingModels, [])
  assert.equal(status.providers[0].models.tone, undefined)
})

await ok('没检测/连不上时不飘红，只报声明数', () => {
  const notChecked = buildPanelStatus({ providers: [twoModels], online: {} })
  assert.equal(notChecked.providers[0].models.tone, undefined)
  assert.match(notChecked.providers[0].models.label, /2 模型/)

  const down = buildPanelStatus({
    providers: [twoModels],
    online: { 'local-ollama': { ok: false, error: 'ECONNREFUSED' } },
  })
  // 连不上 ≠ 模型被删了。这时候标红会让用户以为要去删配置。
  assert.equal(down.providers[0].models.tone, undefined)
  assert.deepEqual(down.providers[0].missingModels, [])
})

await ok('云端 provider 也照常算差集（不因为它不裁剪就跳过）', () => {
  const status = buildPanelStatus({
    providers: [{ id: 'deepseek-eo', profile: { displayName: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-chat' }] } }],
    online: { 'deepseek-eo': { ok: true, ms: 90, models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] } },
  })
  const row = status.providers[0]
  assert.equal(row.local, false)
  assert.deepEqual(row.extraModels, ['deepseek-reasoner'])
})

console.log('status: 凭据没配好时，选择器里看不到这个 provider')

// 宿主对「profile 声明了 apiKeyEnv 但解析不到值」的处理是抛 MISSING_CREDENTIAL，
// llm-pi-ai 的 listModels 把它吞成空数组，模型目录再按「空组丢弃」过滤掉，
// 于是用户在模型选择器里只会发现这个 provider 不见了，看不到任何原因。
// 面板必须替它说出来，否则用户会以为是插件没把 provider 写进去。

await ok('凭据没值：warn，并说清选择器里看不到它', () => {
  const status = buildPanelStatus({
    providers: [{ id: 'local-ollama', profile: { baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'MY_LOCAL_KEY', models: [{ id: 'qwen3:8b' }] } }],
    credentials: { 'local-ollama': { ref: 'MY_LOCAL_KEY', configured: false } },
  })
  const row = status.providers[0]
  assert.equal(row.credential.tone, 'warn')
  assert.equal(row.credential.configured, false)
  assert.match(row.credential.label, /MY_LOCAL_KEY/)
  assert.match(row.credential.label, /选择器里会看不到/)
})

await ok('凭据有值：不吵，只说已配置', () => {
  const status = buildPanelStatus({
    providers: [{ id: 'local-ollama', profile: { baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'MY_LOCAL_KEY', models: [{ id: 'qwen3:8b' }] } }],
    credentials: { 'local-ollama': { ref: 'MY_LOCAL_KEY', configured: true } },
  })
  assert.equal(status.providers[0].credential.tone, 'muted')
  assert.match(status.providers[0].credential.label, /已配置/)
})

await ok('没声明 apiKeyEnv 的 provider 不出现凭据行（本地端点绝大多数如此）', () => {
  const status = buildPanelStatus({
    providers: [{ id: 'local-ollama', profile: { baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen3:8b' }] } }],
    credentials: {},
  })
  assert.equal(status.providers[0].credential, undefined)
})

console.log('status: client 半边有没有宿主')

// 面板在 headless/sdk/acp profile 里根本画不出来（那里没有 client-modules 服务）。
// 这件事必须能和「裁剪坏了」区分开，否则用户会以为是插件不行。

await ok('有宿主：绿灯，说面板可用', () => {
  const result = summarizeClientHost({ state: 'ready', detail: '面板已编进条目表' })
  assert.equal(result.state, 'ready')
  assert.equal(result.tone, 'good')
  assert.match(result.label, /面板可用/)
  assert.match(result.detail, /条目表/)
})

await ok('没宿主：灰灯，明说面板不会出现但裁剪照常', () => {
  const result = summarizeClientHost({ state: 'missing', detail: '这个 profile 没有 client-modules 服务' })
  assert.equal(result.state, 'missing')
  assert.equal(result.tone, 'muted')
  assert.match(result.label, /面板不可用/)
  assert.match(result.label, /裁剪照常生效/)
  assert.match(result.detail, /client-modules/)
})

await ok('还没探测到：不许假装成「没有宿主」吓人', () => {
  const result = summarizeClientHost(undefined)
  assert.equal(result.state, 'unknown')
  assert.equal(result.tone, 'muted')
  assert.match(result.label, /未知/)
  assert.doesNotMatch(result.label, /不可用/)
})

await ok('面板主视图带上 client 字段，缺省也不炸', () => {
  const status = buildPanelStatus({})
  assert.equal(status.client.state, 'unknown')
  assert.equal(typeof status.client.label, 'string')
})

// ── import-model.js ──────────────────────────────────────────────────────

console.log('import: 入参校验')

await ok('空端点直接拒绝', () => {
  const result = parseImportInput({ model: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /端点不能为空/)
})

await ok('非 URL 拒绝', () => {
  const result = parseImportInput({ endpoint: 'not a url', model: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /不是合法 URL/)
})

await ok('非 http(s) 拒绝', () => {
  const result = parseImportInput({ endpoint: 'ftp://127.0.0.1:8090', model: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /必须是 http/)
})

await ok('没选模型拒绝', () => {
  const result = parseImportInput({ endpoint: 'http://127.0.0.1:8090' })
  assert.equal(result.ok, false)
  assert.match(result.error, /先探测端点/)
})

await ok('省略 /v1 会自动补上', () => {
  const result = parseImportInput({ endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b' })
  assert.equal(result.ok, true)
  assert.equal(result.endpoint, 'http://127.0.0.1:8090/v1')
})

await ok('provider id 非法时给出明确原因', () => {
  const result = parseImportInput({ endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b', provider: 'Bad ID' })
  assert.equal(result.ok, false)
  assert.match(result.error, /a-z 0-9/)
})

await ok('显式 provider id 被接受', () => {
  const result = parseImportInput({ endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b', provider: 'my-local.qwen' })
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'my-local.qwen')
})

await ok('按端口猜后端名', () => {
  assert.equal(defaultProviderId('http://127.0.0.1:8090/v1', 'Qwen3 4B'), 'local-llamacpp-qwen3-4b')
  assert.equal(defaultProviderId('http://127.0.0.1:11434/v1', 'qwen2.5:7b'), 'local-ollama-qwen2-5-7b')
  assert.equal(defaultProviderId('http://127.0.0.1:8000/v1', 'meta-llama/Llama-3-8B'), 'local-vllm-meta-llama-llama-3-8b')
  assert.equal(defaultProviderId('http://127.0.0.1:1234/v1', 'gemma-3-4b'), 'local-lmstudio-gemma-3-4b')
})

await ok('端口认不出时不留双连字符（旧版会拼出 local--model）', () => {
  // backendByName 认不出来时返回的是空串而不是 undefined，原来那句
  // `?? 'local'` 兜不住空串，于是生成 `local--qwen3-4b`。
  // PROVIDER_ID_RE 恰好放行双连字符，所以这个 bug 一直没炸，只是 id 难看又难认。
  assert.equal(defaultProviderId('http://127.0.0.1:9999/v1', 'qwen3-4b'), 'local-qwen3-4b')
  assert.equal(backendFor('http://127.0.0.1:9999', 'qwen3-4b'), 'local')
  assert.equal(backendFor('http://127.0.0.1:9999', ''), 'local')
})

await ok('sanitizeProviderId 只收规整后合法的 id', () => {
  assert.equal(sanitizeProviderId('  My-Local  '), 'my-local')
  assert.equal(sanitizeProviderId('my-local.qwen'), 'my-local.qwen')
  assert.equal(sanitizeProviderId('Bad ID'), undefined)
  assert.equal(sanitizeProviderId('!!!'), undefined)
  assert.equal(sanitizeProviderId('a'.repeat(80)), undefined)
  assert.equal(sanitizeProviderId('a'.repeat(63)), 'a'.repeat(63))
})

console.log('import: 挑模型与拼 profile')

await ok('挑模型：精确优先，其次大小写不敏感', () => {
  const models = [{ id: 'Qwen3-4B' }, { id: 'qwen3-4b-instruct' }]
  assert.equal(pickModel(models, 'Qwen3-4B').id, 'Qwen3-4B')
  assert.equal(pickModel(models, 'qwen3-4b').id, 'Qwen3-4B')
  assert.equal(pickModel(models, 'nope'), undefined)
  assert.equal(pickModel([], 'x'), undefined)
})

await ok('默认关掉思考模式（本地小模型最常踩的坑）', () => {
  const parsed = parseImportInput({ endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b' })
  const profile = buildImportProfile(parsed, { contextWindow: 32768, maxTokens: 4096 })
  assert.equal(profile.baseURL, 'http://127.0.0.1:8090/v1')
  assert.equal(profile.models[0].id, 'qwen3-4b')
  assert.equal(profile.models[0].contextWindow, 32768)
  assert.equal(profile.models[0].maxTokens, 4096)
  assert.deepEqual(profile.compat.chatTemplateKwargs, { enable_thinking: false })
  // thinkingFormat 必须一起写，否则宿主的 openai 分支不会把 kwarg 发出去
  assert.equal(profile.compat.thinkingFormat, 'chat-template')
  // reasoningEfforts 把 reasoning 顶到 true，chatTemplateKwargs 才进请求体
  assert.equal(profile.models[0].reasoningEfforts.off, null)
})

await ok('thinking=true 时不写 compat', () => {
  const parsed = parseImportInput({ endpoint: 'http://127.0.0.1:8090', model: 'qwen3-4b', thinking: true })
  const profile = buildImportProfile(parsed, {})
  const text = JSON.stringify(profile)
  assert.equal(text.includes('chatTemplateKwargs'), false)
})

await ok('summarizeProvider 给面板一行摘要', () => {
  const summary = summarizeProvider('local-x', {
    displayName: '本地',
    baseURL: 'http://127.0.0.1:8090/v1',
    models: [{ id: 'a', contextWindow: 32768, maxTokens: 4096 }],
  })
  assert.equal(summary.id, 'local-x')
  assert.equal(summary.modelCount, 1)
  assert.equal(summary.contextWindow, 32768)
})

console.log('import: 复用同一后端的 provider（别再长出第二条）')

// 原来每导入一个模型就新建一条 `local-<后端>-<模型名>`，同一个 Ollama 攒出五六条单模型
// provider，面板上半截越拉越长、删模型还得逐条删。这一组钉住「同一后端只有一条」。

const existing = [
  { id: 'local-ollama', profile: { baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'gemma4:12b' }] } },
  { id: 'local-ollama-qwen3-14b', profile: { baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen3:14b' }] } },
]

await ok('认出同端点的通用 provider', () => {
  const found = findReusableProvider(existing, 'http://127.0.0.1:11434', 'ollama')
  assert.equal(found?.id, 'local-ollama')
})

await ok('同端点有多条时优先通用名那条', () => {
  // `local-ollama-qwen3-14b` 是用户有意分开配的（可能调过 ctx / compat），
  // 通用名那条存在时不该往它里面塞。
  const found = findReusableProvider(existing, 'http://127.0.0.1:11434', 'ollama')
  assert.notEqual(found?.id, 'local-ollama-qwen3-14b')
})

await ok('同端点只有一条（哪怕是自定义名）就复用它', () => {
  // 这条规则是「导入两次长出两条 provider」的解药：判据从「id 等于 genericProviderId」
  // 改成「baseURL 相同」。同一个端点再新建一条永远比往里追加模型更糟 ——
  // 面板上会多出一整条 provider、模型选择器里同一个后端出现两遍。
  // 追加只动 models 数组，不碰用户调过的 contextWindow / compat。
  const onlyNamed = findReusableProvider([existing[1]], 'http://127.0.0.1:11434', 'ollama')
  assert.equal(onlyNamed?.id, 'local-ollama-qwen3-14b')
})

await ok('不同端点就是不重用', () => {
  assert.equal(findReusableProvider(existing, 'http://127.0.0.1:8090', 'llamacpp'), undefined)
  // backend 只是「按端口猜后端名」的提示，用来挑通用名那条；判据本身是 baseURL。
  // 同一个 URL 只可能是同一个服务 —— 端口对得上名字对不上，也是同一条，
  // 这时候宁可复用（否则又长出一条同地址的 provider），不要凭空新建。
  const sameUrl = findReusableProvider(existing, 'http://127.0.0.1:11434', 'vllm')
  assert.equal(sameUrl?.id, 'local-ollama')
})

await ok('localhost 与 127.0.0.1 算同一个后端', () => {
  const found = findReusableProvider(existing, 'http://localhost:11434', 'ollama')
  assert.equal(found?.id, 'local-ollama')
})

await ok('backendFor 按端口认后端', () => {
  assert.equal(backendFor('http://127.0.0.1:11434', 'gemma4:12b'), 'ollama')
  assert.equal(backendFor('http://127.0.0.1:8090', 'x.gguf'), 'llamacpp')
  assert.equal(backendFor('http://127.0.0.1:1234', 'x'), 'lmstudio')
  assert.equal(backendFor('http://127.0.0.1:9999', 'llama.cpp'), 'llamacpp') // 端口认不出时靠提示串
  assert.equal(backendFor('http://127.0.0.1:9999', 'x'), 'local')
})

await ok('追加模型：老模型留着，新模型接在后面', () => {
  const result = appendModelToProfile({
    profile: existing[0].profile,
    modelId: 'qwen3.5:9b',
    contextWindow: 32768,
    maxTokens: 4096,
  })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.profile.baseURL, 'http://127.0.0.1:11434/v1')
  assert.deepEqual(result.profile.models.map((m) => m.id), ['gemma4:12b', 'qwen3.5:9b'])
  assert.equal(result.profile.models[1].contextWindow, 32768)
  // 不能把用户原来的模型条目改掉
  assert.deepEqual(result.profile.models[0], { id: 'gemma4:12b' })
})

await ok('模型已经在里面：不重复加，也不报错', () => {
  // 用户点「导入」想要的结果已经在了，这时候报错纯属添乱。
  const result = appendModelToProfile({ profile: existing[0].profile, modelId: 'gemma4:12b' })
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(result.profile.models.length, 1)
})

await ok('省 :latest 的写法也认作同一个模型', () => {
  const result = appendModelToProfile({
    profile: { baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'nomic-embed-text' }] },
    modelId: 'nomic-embed-text:latest',
  })
  assert.equal(result.changed, false)
})

await ok('没上下文长度时退回 maxTokens，不写 0', () => {
  // contextWindow: 0 在 llm-pi-ai 里等于「窗口是 0」，请求全会被截断。
  const result = appendModelToProfile({ profile: { models: [] }, modelId: 'x', maxTokens: 8192 })
  assert.equal(result.profile.models[0].contextWindow, undefined)
  assert.equal(result.profile.models[0].maxTokens, 8192)
  assert.equal(result.profile.models[0].reasoningEfforts.off, null)
})

await ok('显式指定 provider 时不走复用（用户说了算）', () => {
  const explicit = parseImportInput({ endpoint: 'http://127.0.0.1:11434', model: 'x', provider: 'my-own' })
  assert.equal(explicit.explicitProvider, true)
  const implicit = parseImportInput({ endpoint: 'http://127.0.0.1:11434', model: 'x' })
  assert.equal(implicit.explicitProvider, false)
})

console.log('import: 对齐到后端实况（planAlign）')

await ok('摘掉死声明、补齐后端多出来的，活着的原样保留', () => {
  // 用户把 qwen3-4b 的 contextWindow 调成 12345 —— 对齐不许把他的调参冲掉。
  const plan = planAlign({
    declared: [
      { id: 'qwen3-4b', contextWindow: 12345, maxTokens: 777 },
      { id: 'deleted-a', contextWindow: 32768 },
    ],
    live: [{ id: 'qwen3-4b', contextWindow: 4096 }, { id: 'qwen3:8b', contextWindow: 32768 }],
    fallbackMaxTokens: 4096,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.kept, ['qwen3-4b'])
  assert.deepEqual(plan.removed, ['deleted-a'])
  assert.deepEqual(plan.added, ['qwen3:8b'])
  // 活着的条目一个字节都没动
  assert.deepEqual(plan.models[0], { id: 'qwen3-4b', contextWindow: 12345, maxTokens: 777 })
  // 补进来的用探测到的 contextWindow
  assert.equal(plan.models[1].contextWindow, 32768)
  assert.equal(plan.models[1].maxTokens, 4096)
})

await ok('全都还在：changed=false，一条都不改', () => {
  const plan = planAlign({ declared: [{ id: 'a' }], live: [{ id: 'a' }] })
  assert.equal(plan.ok, true)
  assert.equal(plan.changed, false)
  assert.deepEqual(plan.removed, [])
  assert.deepEqual(plan.added, [])
})

await ok('省 :latest 的那条不算死声明', () => {
  // Ollama 永远报全名，用户配置常省掉 —— 不归一化会把每一条都判成已删除。
  const plan = planAlign({
    declared: [{ id: 'nomic-embed-text' }],
    live: [{ id: 'nomic-embed-text:latest' }],
  })
  assert.equal(plan.changed, false)
  assert.deepEqual(plan.removed, [])
})

await ok('后端一个模型都没有：拒绝，不给空 models', () => {
  // 空 models 在 llm-pi-ai 里是配置错误，不是「停用」。这种 provider 该删，不该对齐成 0。
  const plan = planAlign({ declared: [{ id: 'a' }, { id: 'b' }], live: [] })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /应该直接删掉/)
  assert.equal(plan.models, undefined)
})

await ok('探测回来没有上下文长度：不写 contextWindow，也不拿 maxTokens 顶', () => {
  // contextWindow: 0 在 llm-pi-ai 里等于「窗口是 0」，请求全会被截断 —— 宁可缺字段也不能写 0。
  // 而且 fallbackMaxTokens 是**输出预算**，跟上下文窗口是两个量纲：
  // 拿 8192 当 contextWindow 会把一个 40K 窗口的模型写小五倍。
  const plan = planAlign({ declared: [{ id: 'x' }], live: [{ id: 'x' }], fallbackMaxTokens: 8192 })
  assert.equal(plan.ok, true)
  // 活着的条目原样保留：用户自己配的 maxTokens 不会被探测值改写，缺的也不补。
  assert.deepEqual(plan.models, [{ id: 'x' }])
  assert.equal('contextWindow' in plan.models[0], false)
})

await ok('新补进来的模型没有上下文信息时只写 maxTokens', () => {
  const plan = planAlign({ declared: [{ id: 'a' }], live: [{ id: 'a' }, { id: 'b' }], fallbackMaxTokens: 4096 })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.added, ['b'])
  const added = plan.models.find((model) => model.id === 'b')
  assert.equal(added.maxTokens, 4096)
  assert.equal('contextWindow' in added, false)
  // 探测真给了就照写
  const withCtx = planAlign({ declared: [{ id: 'a' }], live: [{ id: 'a' }, { id: 'c', contextWindow: 32768 }] })
  assert.equal(withCtx.models.find((model) => model.id === 'c').contextWindow, 32768)
})

console.log('import: 对账（planReconcile，只做减法）')

await ok('后端少了一个：只摘那一个，活着的原样保留', () => {
  // 对账是后台维护动作，不能碰用户调过的参数 —— 活着的那条一个字节都不许动。
  const plan = planReconcile({
    declared: [
      { id: 'qwen3.5:9b', contextWindow: 40960, maxTokens: 8192 },
      { id: 'qwen3:14b', contextWindow: 40960 },
    ],
    live: [{ id: 'qwen3.5:9b' }, { id: 'gemma4:12b' }],
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.action, 'prune')
  assert.deepEqual(plan.removed, ['qwen3:14b'])
  assert.deepEqual(plan.models, [{ id: 'qwen3.5:9b', contextWindow: 40960, maxTokens: 8192 }])
})

await ok('对账绝不补模型：后端多出来的不理', () => {
  // 跟 planAlign 的分工就在这里：同一个端点常挂着好几条 provider，
  // 对账要是也补，每条都会被塞进全量模型，等于替用户改模型选择器。
  const plan = planReconcile({
    declared: [{ id: 'a' }],
    live: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.action, 'keep')
  assert.deepEqual(plan.removed, [])
  assert.deepEqual(plan.models.map((m) => m.id), ['a'])
})

await ok('全都不在后端了：action=remove，但不在这里真删', () => {
  // 删 provider 不可撤销，纯函数只给结论，动手留给调用方。
  const plan = planReconcile({
    declared: [{ id: 'qwen3:14b' }, { id: 'qwen3:8b' }],
    live: [{ id: 'gemma4:12b' }],
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.action, 'remove')
  assert.deepEqual(plan.removed, ['qwen3:14b', 'qwen3:8b'])
  assert.deepEqual(plan.models, [])
})

await ok('探测失败（live 是 undefined）不算「后端没模型」', () => {
  // 这是整套对账最关键的一条：连不上时 live 是 undefined，后端真没模型时是 []。
  // 混了就会在 Ollama 没起来的时候把用户的 provider 全删光。
  const plan = planReconcile({ declared: [{ id: 'a' }] })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /探测失败不等于模型没了/)
  assert.equal(plan.models, undefined)
})

await ok('后端真的 0 个模型：照样判 remove', () => {
  // 与上一条成对：live === [] 是有信息的（后端在应答，只是空了），必须区别对待。
  const plan = planReconcile({ declared: [{ id: 'a' }], live: [] })
  assert.equal(plan.ok, true)
  assert.equal(plan.action, 'remove')
})

await ok('省 :latest 的那条不算死声明', () => {
  const plan = planReconcile({
    declared: [{ id: 'nomic-embed-text' }],
    live: [{ id: 'nomic-embed-text:latest' }],
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.action, 'keep')
})

await ok('本来就没有模型：拒绝，别拿空 provider 去删', () => {
  const plan = planReconcile({ declared: [], live: [{ id: 'a' }] })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /本来就没有模型/)
})
console.log('import: 试跑请求')

await ok('成功时回报耗时与 token 数', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '好' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 1 },
        }),
    }
  }
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'qwen3-4b' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '好')
  assert.equal(result.completionTokens, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:8090/v1/chat/completions')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.stream, false)
  assert.equal(body.model, 'qwen3-4b')
  assert.equal(calls[0].init.headers.authorization, undefined)
})

await ok('有 key 时带上 Bearer', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = init.headers
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }
  }
  await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'm', apiKey: 'secret' })
  assert.equal(seen.authorization, 'Bearer secret')
})

await ok('HTTP 错误把后端原文带出来', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'model not found' })
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'nope' })
  assert.equal(result.ok, false)
  assert.equal(result.status, 404)
  assert.match(result.error, /HTTP 404: model not found/)
})

await ok('不是 JSON 时说明白', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html>502</html>' })
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'm' })
  assert.equal(result.ok, false)
  assert.match(result.error, /不是 JSON/)
})

await ok('连不上时给异常文本', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED')
  }
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'm' })
  assert.equal(result.ok, false)
  assert.match(result.error, /ECONNREFUSED/)
})

// Ollama 的 OpenAI 兼容层不认 chat_template_kwargs，只认 reasoning_effort: 'none'。
// 第一次回空正文时，smokeTest 必须自己换写法再试一次，而不是报「试跑通过 + 空回复」。
await ok('思考模式吃掉正文时自动换 reasoning_effort 再试', async () => {
  const bodies = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    const thinking = body.reasoning_effort === undefined
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: thinking ? { content: '', reasoning: '让我想想…' } : { content: '好' },
              finish_reason: thinking ? 'length' : 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: thinking ? 24 : 2 },
        }),
    }
  }
  const result = await smokeTest({
    fetchImpl,
    baseURL: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    chatTemplateKwargs: { enable_thinking: false },
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, '好')
  assert.equal(result.attempt, 'reasoning_effort')
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: false })
  assert.equal(bodies[1].reasoning_effort, 'none')
})

await ok('两种写法都空正文时给可执行错误，不算通过', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { content: '', reasoning: '一直想' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 12, completion_tokens: 24 },
      }),
  })
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'qwen3:4b' })
  assert.equal(result.ok, false)
  assert.match(result.error, /空正文/)
  assert.match(result.error, /思考/)
})

// 冷加载：第一次请求超时几乎总是「权重还在读盘」，模型进程并没有死。
// 面板上点一次就该等于点两次，用户不该为了这个去理解 llama-server 的内存加载曲线。
await ok('第一次超时后自动重试一次，第二次出字就算通过', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) {
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      throw error
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '好' }, finish_reason: 'stop' }] }),
    }
  }
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'qwen3:8b' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '好')
  assert.equal(calls, 2)
  assert.equal(result.retries, 0)
})

await ok('两次都超时：报超时并说清下一步，不冒充网络错误', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    const error = new Error('This operation was aborted')
    error.name = 'AbortError'
    throw error
  }
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'qwen3:8b', timeoutMs: 60000 })
  assert.equal(result.ok, false)
  assert.equal(calls, 2)
  assert.equal(result.timedOut, true)
  assert.match(result.error, /试跑超时/)
  assert.match(result.error, /已自动重试一次/)
  assert.match(result.error, /试跑超时（秒）/)
  // 不能再把 undici 的原始文案丢给用户 —— 「This operation was aborted」看不出该做什么
  assert.doesNotMatch(result.error, /This operation was aborted/)
})

await ok('非超时错误不重试：连不上就是连不上', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    throw new Error('ECONNREFUSED')
  }
  const result = await smokeTest({ fetchImpl, baseURL: 'http://127.0.0.1:8090', model: 'm' })
  assert.equal(result.ok, false)
  assert.equal(calls, 1)
  assert.match(result.error, /ECONNREFUSED/)
})

await ok('retryOnTimeout=false 时只试一次', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    const error = new Error('aborted')
    error.name = 'TimeoutError'
    throw error
  }
  const result = await smokeTest({
    fetchImpl,
    baseURL: 'http://127.0.0.1:8090',
    model: 'm',
    retryOnTimeout: false,
    timeoutMs: 60000,
  })
  assert.equal(result.ok, false)
  assert.equal(calls, 1)
  assert.match(result.error, /试跑超时/)
  assert.doesNotMatch(result.error, /已自动重试一次/)
})

await ok('缺 baseURL / 模型时提前返回', async () => {  assert.equal((await smokeTest({ fetchImpl: async () => {}, baseURL: '', model: 'm' })).ok, false)
  assert.equal((await smokeTest({ fetchImpl: async () => {}, baseURL: 'http://127.0.0.1:8090', model: '' })).ok, false)
})

console.log('\n' + passed + ' 项通过')
