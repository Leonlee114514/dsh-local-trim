// 验证 routes: [] 的自动识别：本地端点命中、云端 provider 全部放行。
// 不依赖 dsh 运行时，用最小假 ctx 复刻 apply 需要的那几个服务。
import { apply, spliceInject } from '../lib/index.js'

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

apply(makeCtx(), { routes: [], injectText: 'LIGHT', schemaTrim: false, selfCheck: false })

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

// 不写 routes 时退回 local-qwen
calls.length = 0
apply(makeCtx(), { injectText: 'LIGHT', schemaTrim: false, selfCheck: false })
const h2 = calls.find((c) => c.event === 'system-prompt/assemble')?.handler
const a1 = makeAssembly()
check('routes 缺省仍只认 local-qwen（local-qwen 命中）', (await h2(a1, { agent: makeAgent('local-qwen') }, async () => a1)) !== a1)
const a2 = makeAssembly()
check('routes 缺省时 ollama 不命中', (await h2(a2, { agent: makeAgent('ollama') }, async () => a2)) === a2)

// schemaTrim: false 时 tools 不动
calls.length = 0
apply(makeCtx(), { routes: [], injectText: 'LIGHT', schemaTrim: false, selfCheck: false })
const h3 = calls.find((c) => c.event === 'system-prompt/assemble')?.handler
const a3 = makeAssembly()
const out3 = await h3(a3, { agent: makeAgent('local-qwen') }, async () => a3)
check('schemaTrim=false 时 tools 原样', out3.tools === a3.tools)

console.log(results.join('\n'))
console.log(fail === 0 ? '\n=== 自动识别全部通过 ===' : `\n=== ${fail} 项失败 ===`)
process.exit(fail === 0 ? 0 : 1)
