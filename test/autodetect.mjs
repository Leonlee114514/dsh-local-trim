// 验证 routes: [] 的自动识别：本地端点命中、云端 provider 全部放行。
// 不依赖 dsh 运行时，用最小假 ctx 复刻 apply 需要的那几个服务。
// 测试会调 apply()，把日志写到临时文件，别污染 ~/.dsh/local-llm/local-trim.log。
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.DSH_LOCAL_TRIM_LOG = process.env.DSH_LOCAL_TRIM_LOG || join(tmpdir(), 'dsh-local-trim.test.log')
const { apply, spliceInject } = await import('../lib/index.js')

globalThis.__dshPurgeHungPrompt = () => 'X'.repeat(200)

const makeSection = (name, text) => ({ name, text, order: 0, interpolate: false })

const makeAssembly = () => ({
  sections: [
    makeSection('harness:identity', 'identity'),
    makeSection('dsh-purge', 'Y'.repeat(400)),
    makeSection('tool:mindmap', 'M'.repeat(900)),
    makeSection('tool:read', 'read tool'),
    makeSection('free-search:engines', 'F'.repeat(500)),
  ],
  contexts: [],
  tools: [{ name: 'read', description: 'Read a file. '.repeat(20) }],
})

const makeAgent = (provider) => ({
  id: `agent-${provider}`,
  options: { provider },
  ctx: {
    tools: {
      restrict: () => () => {},
      schemas: () => [{ name: 'read' }, { name: 'write' }],
    },
  },
})

const calls = []
const makeCtx = () => ({
  logger: { info: () => {} },
  get(name) {
    if (name === 'llm') {
      return {
        listConfigurableProviders: () => [
          { provider: 'local-qwen', baseURL: 'http://127.0.0.1:8090/v1' },
          { provider: 'ollama', defaultBaseURL: 'http://localhost:11434/v1' },
          { provider: 'vllm-box', baseURL: 'http://192.168.1.9:8000/v1' },
          { provider: 'lmstudio', baseURL: 'http://0.0.0.0:1234/v1' },
          { provider: 'deepseek-official', baseURL: 'https://api.deepseek.com' },
          { provider: 'anthropic', baseURL: 'https://api.anthropic.com' },
          { provider: 'my-openai', baseURL: 'https://api.openai.com/v1' },
        ],
      }
    }
    return undefined
  },
  effect: () => () => {},
  on: (event, handler) => {
    calls.push({ event, handler })
    return () => {}
  },
})

const results = []
let pass = 0
let fail = 0
const check = (label, ok, extra = '') => {
  if (ok) pass += 1
  else fail += 1
  results.push(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`)
}

apply(makeCtx(), { routes: [], injectText: 'LIGHT', schemaTrim: false, selfCheck: false, provision: false })

// 从注册的 handler 里取出 assemble 的那个
const assembleHandler = calls.find((c) => c.event === 'system-prompt/assemble')?.handler
if (typeof assembleHandler !== 'function') {
  console.log('✗ 没注册 system-prompt/assemble')
  process.exit(1)
}

const LOCAL = ['local-qwen', 'ollama', 'vllm-box', 'lmstudio']
const CLOUD = ['deepseek-official', 'anthropic', 'my-openai']

for (const provider of LOCAL) {
  const assembly = makeAssembly()
  const out = assembleHandler(assembly, { agent: makeAgent(provider) }, async () => assembly)
  const resolved = await out
  const names = resolved.sections.map((s) => s.name)
  check(`${provider} 命中裁剪`, !names.includes('tool:mindmap') && !names.includes('free-search:engines'), `段=${names.length}`)
  check(`${provider} 注入变轻`, resolved.sections.find((s) => s.name === 'dsh-purge').text.length < 400)
}

for (const provider of CLOUD) {
  const assembly = makeAssembly()
  const out = await assembleHandler(assembly, { agent: makeAgent(provider) }, async () => assembly)
  check(`${provider} 原样放行`, out === assembly, `段=${out.sections.length}`)
}

// 不写 routes（undefined / 非数组）时按「没给名单」处理 = 自动识别，不猜任何 provider 名
calls.length = 0
apply(makeCtx(), { injectText: 'LIGHT', schemaTrim: false, selfCheck: false, provision: false })
const h2 = calls.find((c) => c.event === 'system-prompt/assemble')?.handler
const a1 = makeAssembly()
check('routes 缺省仍走自动识别（local-qwen 命中）', (await h2(a1, { agent: makeAgent('local-qwen') }, async () => a1)) !== a1)
const a2 = makeAssembly()
check('routes 缺省时 ollama 也按地址自动命中', (await h2(a2, { agent: makeAgent('ollama') }, async () => a2)) !== a2)
const a4 = makeAssembly()
check('routes 缺省时云端仍放行', (await h2(a4, { agent: makeAgent('deepseek-official') }, async () => a4)) === a4)

// schemaTrim: false 时 tools 不动
calls.length = 0
apply(makeCtx(), { routes: [], injectText: 'LIGHT', schemaTrim: false, selfCheck: false, provision: false })
const h3 = calls.find((c) => c.event === 'system-prompt/assemble')?.handler
const a3 = makeAssembly()
const out3 = await h3(a3, { agent: makeAgent('local-qwen') }, async () => a3)
check('schemaTrim=false 时 tools 原样', out3.tools === a3.tools)

// ── 段名：前缀识别 + 没有 dsh-purge 时用自己的名字 ──────────────────────────
// dsh-purge 升级时可能把段名改成 `dsh-purge:v2`。精确匹配会让那段 25K 正文换不掉，
// 只剩段裁剪在起作用（省 3.4K 而不是 28K）。所以按前缀认。
calls.length = 0
apply(makeCtx(), { routes: [], injectText: 'LIGHT', schemaTrim: false, selfCheck: false, provision: false })
const h4 = calls.find((c) => c.event === 'system-prompt/assemble')?.handler

const variantAssembly = () => ({
  sections: [
    makeSection('harness:identity', 'identity'),
    makeSection('dsh-purge:v2', 'Z'.repeat(400)),
    makeSection('tool:mindmap', 'M'.repeat(900)),
  ],
  contexts: [],
  tools: [],
})
const v1 = variantAssembly()
const vOut = await h4(v1, { agent: makeAgent('local-qwen') }, async () => v1)
// 注意：不能只断言「存在一个 startsWith('dsh-purge') 的段」—— 认不出来时补段逻辑
// 会额外 unshift 一个新的短段，find 一样能找到，断言会假绿。必须断言原文真的没了。
const vTexts = vOut.sections.map((s) => String(s?.text ?? ''))
check('段名带后缀（dsh-purge:v2）时 25K 原文真的被换掉', !vTexts.some((t) => t.includes('ZZZZZZZZZZ')))
check('段名带后缀时注入正文进了装配', vTexts.some((t) => t.includes('LIGHT')))

// 没有 dsh-purge 的机器：不许冒用别人的段名凭空造段。
delete globalThis.__dshPurgeHungPrompt
calls.length = 0
apply(makeCtx(), { routes: [], injectText: 'LIGHT', schemaTrim: false, selfCheck: false, provision: false })
const h5 = calls.find((c) => c.event === 'system-prompt/assemble')?.handler
const bareAssembly = () => ({ sections: [makeSection('harness:identity', 'identity')], contexts: [], tools: [] })
const b1 = bareAssembly()
const bOut = await h5(b1, { agent: makeAgent('local-qwen') }, async () => b1)
const bNames = bOut.sections.map((s) => s.name)
check('没装 dsh-purge 时用自己的段名', bNames.includes('local-trim:inject'), `段=${JSON.stringify(bNames)}`)
check('没装 dsh-purge 时不凭空造 dsh-purge 段', !bNames.includes('dsh-purge'))
check('没装 dsh-purge 时注入正文照样写进去', bOut.sections.find((s) => s.name === 'local-trim:inject')?.text.includes('LIGHT'))
globalThis.__dshPurgeHungPrompt = () => 'X'.repeat(200)

// ── schema 面不能拖累提示词面 ────────────────────────────────────────────
// 一条畸形 schema 让 JSON.stringify 抛错，异常会穿出 trimAssembly 被外层 catch 吞掉，
// 结果是整份裁剪（含提示词裁剪、注入替换）一起失效，面板只显示「未裁剪」。
calls.length = 0
apply(makeCtx(), { routes: [], injectText: 'LIGHT', schemaTrim: true, selfCheck: false, provision: false })
const h6 = calls.find((c) => c.event === 'system-prompt/assemble')?.handler

const badSchemaCases = []
const circular = { name: 'circular', description: 'C'.repeat(300) }
circular.inputSchema = { type: 'object', properties: { self: circular } }
badSchemaCases.push(['循环引用', circular])
badSchemaCases.push(['BigInt', { name: 'big', description: 'B'.repeat(300), inputSchema: { type: 'object', properties: { n: 10n } } }])
let deep = { type: 'object', properties: {} }
let cursor = deep
for (let i = 0; i < 3000; i += 1) {
  cursor.properties.next = { type: 'object', properties: {} }
  cursor = cursor.properties.next
}
badSchemaCases.push(['深度 3000', { name: 'deep', description: 'D'.repeat(300), inputSchema: deep }])

for (const [label, badTool] of badSchemaCases) {
  const asm = () => ({
    sections: [makeSection('harness:identity', 'identity'), makeSection('dsh-purge', 'Q'.repeat(400)), makeSection('tool:mindmap', 'M'.repeat(900))],
    contexts: [],
    tools: [badTool],
  })
  const a = asm()
  const out = await h6(a, { agent: makeAgent('local-qwen') }, async () => a)
  const names = out.sections.map((s) => s.name)
  check(`${label} 的 schema 不拖累提示词裁剪`, !names.includes('tool:mindmap'), `段=${JSON.stringify(names)}`)
  const inj = out.sections.find((s) => s.name === 'dsh-purge')
  check(`${label} 的 schema 不拖累注入替换`, Boolean(inj) && inj.text.includes('LIGHT'), `${inj?.text?.length ?? 0} 字符`)
}


console.log(results.join('\n'))
console.log(fail === 0 ? '\n=== 自动识别全部通过 ===' : `\n=== ${fail} 项失败 ===`)
process.exit(fail === 0 ? 0 : 1)
