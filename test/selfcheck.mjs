/**
 * 自检：模拟 dsh-purge 的 accessor + 400ms 心跳覆盖，验证本插件在其外层收尾。
 *
 * 场景 1  装了 dsh-purge：accessor 已存在，心跳每轮重装 rewriteFn。
 *         期望：接管后最终结果被裁、注入被换、云端 provider 拿到同一对象。
 * 场景 2  没装 dsh-purge：prompt.assemble 是普通函数。
 *         期望：接管原生函数，裁剪照样生效。
 */

// 测试会调 apply()，把日志写到临时文件，别污染 ~/.dsh/local-llm/local-trim.log。
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.DSH_LOCAL_TRIM_LOG = process.env.DSH_LOCAL_TRIM_LOG || join(tmpdir(), 'dsh-local-trim.test.log')
const { apply, spliceInject, DEFAULT_KEEP } = await import('../lib/index.js')

const ASSEMBLE_GUARD = Symbol.for('dsh-purge.assembleGuard')
const TAKEOVER = Symbol.for('dsh-local-trim.takeover')

const BIG_INJECT = `[MODE: UNRESTRICTED SANDBOX]
${'PRIME DIRECTIVE line. '.repeat(1200)}`.trim()
const refText = BIG_INJECT

const mkSections = () => [
  { name: 'harness:identity', text: 'identity body' },
  { name: 'dsh-purge', text: BIG_INJECT, order: -100000, interpolate: false },
  { name: 'tool:read', text: 'read tool' },
  { name: 'tool:mindmap', text: 'M'.repeat(900) },
  { name: 'free-search:engines', text: 'S'.repeat(500) },
  { name: 'dsh-ops:repository-tooling:mode-standard', text: 'R'.repeat(400) },
  { name: 'tool:bash', text: 'bash tool' },
]

let fail = 0
const check = (label, ok, extra = '') => {
  if (!ok) fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
}

function makeTools() {
  const all = [...DEFAULT_KEEP, 'ops_bash', 'ops_glob', 'ego_click', 'excel_read', 'lsp_hover']
  let restrictCalls = 0
  return {
    get restrictCalls() {
      return restrictCalls
    },
    schemas: () =>
      all.map((n) => ({ name: n, description: 'x'.repeat(400), inputSchema: { type: 'object', properties: {} } })),
    restrict: ({ allow }) => {
      restrictCalls += 1
      const known = new Set(DEFAULT_KEEP)
      const bad = allow.filter((n) => !known.has(n))
      if (bad.length > 0) throw new Error(`tools.restrict() names unknown global tool(s) ${bad.map((b) => `"${b}"`).join(', ')}; known global tools: ${[...known].join(', ')}`)
      return () => {}
    },
  }
}

/** 复刻 dsh-purge 的 installAssembleGuard + installIdentityOverride 心跳。 */
function installPurgeGuard(prompt, nativeAssemble) {
  const slot = { rewrite: null }
  let currentRewrite = null
  const wrap = (fn) =>
    async function assembleWithPurge(...args) {
      const assembled = await fn(...args)
      if (typeof slot.rewrite !== 'function') return assembled
      return slot.rewrite(assembled, args[0])
    }
  const wrapped = wrap(nativeAssemble)
  wrapped._dshPurgeWrapped = true
  wrapped._dshPurgeSlot = slot
  const getter = function assembleGuard() {
    return wrapped
  }
  getter[ASSEMBLE_GUARD] = slot
  Object.defineProperty(prompt, 'assemble', {
    configurable: true,
    enumerable: true,
    get: getter,
    set(next) {
      currentRewrite = next
    },
  })
  const heartbeat = (rewriteFn) => {
    currentRewrite = rewriteFn
    const desc = Object.getOwnPropertyDescriptor(prompt, 'assemble')
    if (desc?.get?.[ASSEMBLE_GUARD]) {
      desc.get[ASSEMBLE_GUARD].rewrite = rewriteFn
      return 'bindSlot'
    }
    return 'reinstall'
  }
  return { slot, heartbeat, wrapped }
}

function makeCtx(tools, prompt) {
  const handlers = new Map()
  return {
    logger: { info: () => {} },
    get: (n) => (n === 'tools' ? tools : n === 'agents' ? { list: () => agents } : undefined),
    systemPrompt: prompt,
    on: (ev, fn) => {
      handlers.set(ev, fn)
      return () => {}
    },
    effect: (fn) => {
      void fn
    },
    handlers,
  }
}

const agents = []

async function scenario(withPurge) {
  console.log(`\n=== 场景 ${withPurge ? '1：装了 dsh-purge' : '2：没装 dsh-purge'} ===`)
  // dsh-purge 用 __dshPurgeHungPrompt 暴露它做 head80/tail96 判定的原文。
  // 没装它时这个全局不存在，也就不存在「再前置全文」的兜底，注入直接换掉即可。
  if (withPurge) globalThis.__dshPurgeHungPrompt = () => refText
  else delete globalThis.__dshPurgeHungPrompt

  const tools = makeTools()
  const prompt = {}
  // 原生 assemble(context)：只收一个参数，内部组装出 assembly
  const nativeAssemble = async (_context) => ({ sections: mkSections(), contexts: [], tools: [] })
  let purge
  if (withPurge) {
    purge = installPurgeGuard(prompt, nativeAssemble)
  } else {
    prompt.assemble = nativeAssemble
  }

  const ctx = makeCtx(tools, prompt)
  const localAgent = { id: 'a-local', session: {}, options: { provider: 'local-qwen' }, ctx: { tools }, session: {} }
  const cloudAgent = { id: 'a-cloud', session: {}, options: { provider: 'deepseek-official' }, ctx: { tools }, session: {} }
  agents.push(localAgent, cloudAgent)
  ctx.get = (n) =>
    n === 'tools' ? tools : n === 'agents' ? { list: () => [localAgent, cloudAgent] } : undefined

  apply(ctx, {
    enabled: true,
    routes: ['local-qwen'],
    injectText: 'LIGHT BODY',
    toolDescLimit: 40,
    toolParamDescLimit: 30,
    selfCheck: true,
    provision: false,
  })

  // dsh-purge 的 rewriteFn：把整份 BIG_INJECT 重新置顶（模拟 25K 重写）
  const purgeRewrite = (assembled) => ({
    ...assembled,
    sections: [
      { name: 'dsh-purge', text: refText, order: -100000, interpolate: false },
      ...(assembled.sections ?? []).filter((s) => s.name !== 'dsh-purge'),
    ],
  })

  if (purge) {
    // 心跳连打 3 轮，模拟 400ms 反复刷新
    for (let i = 0; i < 3; i += 1) purge.heartbeat(purgeRewrite)
  }

  const desc = Object.getOwnPropertyDescriptor(prompt, 'assemble')
  check('接管标记存在', desc?.get?.[TAKEOVER] === true, `via=${desc?.get?.[TAKEOVER] ? 'yes' : 'no'}`)
  if (withPurge) check('ASSEMBLE_GUARD 已转发', Boolean(desc?.get?.[ASSEMBLE_GUARD]))

  // 真正走一次 assemble（宿主只收一个 context 参数）
  const out = await prompt.assemble({ agent: localAgent })

  const keptNames = out.sections.map((s) => s.name)
  const injectSection = out.sections.find((s) => s.name === 'dsh-purge')
  check('大段被丢', !keptNames.includes('tool:mindmap') && !keptNames.includes('free-search:engines'))
  check('保留 tool:read / tool:bash', keptNames.includes('tool:read') && keptNames.includes('tool:bash'))
  check('注入被换成轻量版', Boolean(injectSection) && injectSection.text.includes('LIGHT BODY'))
  check('inject 段 interpolate=false', injectSection.interpolate === false)
  check(
    '注入体积大幅下降',
    injectSection.text.length < refText.length / 4,
    `${injectSection.text.length} vs ${refText.length}`,
  )

  if (withPurge) {
    // 有 dsh-purge 时必须保留头80/尾96，否则宿主 agent-loop 会把整份原文再前置一遍。
    check(
      '头80/尾96 保留',
      injectSection.text.startsWith(refText.slice(0, 80)) && injectSection.text.endsWith(refText.slice(-96)),
    )
    const rendered = out.sections.map((s) => s.text).join('\n\n')
    const norm = rendered.replace(/\r\n/g, '\n')
    const headOk = norm.includes(refText.slice(0, 80))
    const tailOk = norm.includes(refText.slice(-96))
    check('宿主 head80/tail96 判定通过（不会再前置全文）', headOk && tailOk, `head=${headOk} tail=${tailOk}`)
  } else {
    // 没有 dsh-purge 就没有那层兜底，正文应当就是轻量版本身。
    check('无 dsh-purge 时正文即轻量版', injectSection.text === 'LIGHT BODY', `len=${injectSection.text.length}`)
  }

  // 云端：必须拿到同一对象、注入完整
  const cloudOut = await prompt.assemble({ agent: cloudAgent })
  const cloudInject = cloudOut.sections.find((s) => s.name === 'dsh-purge')
  check('云端段数不变', cloudOut.sections.length === mkSections().length, `len=${cloudOut.sections.length}`)
  check('云端注入完整', Boolean(cloudInject) && cloudInject.text.length === refText.length)
}

await scenario(true)
await scenario(false)

console.log(`\n${fail === 0 ? '=== 全部通过 ===' : `=== ${fail} 项失败 ===`}`)
process.exit(fail === 0 ? 0 : 1)
