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
const { apply, spliceInject, DEFAULT_KEEP, DEFAULT_DROP_SECTIONS, DEFAULT_INJECT, defaultInject } = await import(
  '../lib/index.js'
)

const ASSEMBLE_GUARD = Symbol.for('dsh-purge.assembleGuard')
const TAKEOVER = Symbol.for('dsh-local-trim.takeover')

const BIG_INJECT = `[MODE: UNRESTRICTED SANDBOX]
${'PRIME DIRECTIVE line. '.repeat(1200)}`.trim()
const refText = BIG_INJECT

// 假宿主自己的「全局工具名」真值表 —— 取自官方 dsh-base 的 dsh-tool-* 注册名。
//
// 刻意**不从 DEFAULT_KEEP 派生**：原来这里 `const known = new Set(DEFAULT_KEEP)`，
// 等于把被测对象当成了判据 —— DEFAULT_KEEP 里写进一个这个插件根本不认识的
// scoped 名字（ops_bash 之类），假宿主照样认，于是「真宿主的 tools.restrict()
// 会整批拒绝」这条路径永远测不出来。v0.5.2 之前就是这么漏掉的。
const HOST_GLOBAL_TOOLS = [
  'ask_user_question',
  'apply_patch',
  'bash',
  'create_goal',
  'edit',
  'get_goal',
  'glob',
  'grep',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'list_subagent_models',
  'office_convert',
  'office_recalculate',
  'office_render',
  'present',
  'pwsh',
  'ralph',
  'read',
  'read_image',
  'send_message',
  'skill',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'todo_write',
  'update_goal',
  'wait_agent',
  'web_fetch',
  'web_search',
  'workflow',
  'working_directory',
  'write',
]
// 第三方插件用 scoped 注册的工具：宿主的 restrict 守卫看不见它们，
// 写进 allow 会让整批校验失败（宿主原话：Restrictions intersect; scoped
// registrations remain visible.）。
const HOST_SCOPED_TOOLS = [
  'ego_click',
  'excel_read',
  'lsp_hover',
  'ops_bash',
  'ops_glob',
  'ops_grep',
  'ops_inspect_local_file',
  'ops_read_files',
]

// 装了 dsh-purge 的机器上，装配里有一个 dsh-purge 注入段；
// 没装的机器上根本没有这个段 —— 这一点必须如实模拟，否则测不到「补段」那条路。
const mkSections = (withPurge = true) => [
  { name: 'harness:identity', text: 'identity body' },
  ...(withPurge ? [{ name: 'dsh-purge', text: BIG_INJECT, order: -100000, interpolate: false }] : []),
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
  const all = [...HOST_GLOBAL_TOOLS, ...HOST_SCOPED_TOOLS]
  let restrictCalls = 0
  let lastAllow = []
  return {
    get restrictCalls() {
      return restrictCalls
    },
    get lastAllow() {
      return lastAllow
    },
    schemas: () =>
      all.map((n) => ({ name: n, description: 'x'.repeat(400), inputSchema: { type: 'object', properties: {} } })),
    restrict: ({ allow }) => {
      restrictCalls += 1
      lastAllow = [...allow]
      const known = new Set(HOST_GLOBAL_TOOLS)
      const bad = allow.filter((n) => !known.has(n))
      if (bad.length > 0)
        throw new Error(
          `tools.restrict() names unknown global tool${bad.length > 1 ? 's' : ''} ${bad.map((b) => `"${b}"`).join(', ')}; known global tools: ${[...known].sort().join(', ')}`,
        )
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
  const nativeAssemble = async (_context) => ({ sections: mkSections(withPurge), contexts: [], tools: [] })
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
  // 段名跟着「有没有 dsh-purge」走：装了沿用 dsh-purge，没装用本插件自己的名字。
  const expectedInjectName = withPurge ? 'dsh-purge' : 'local-trim:inject'
  const injectSection = out.sections.find((s) => s.name === expectedInjectName)
  check('大段被丢', !keptNames.includes('tool:mindmap') && !keptNames.includes('free-search:engines'))
  check('保留 tool:read / tool:bash', keptNames.includes('tool:read') && keptNames.includes('tool:bash'))
  check(
    `注入段用了 ${expectedInjectName}`,
    Boolean(injectSection),
    `段名=${JSON.stringify(keptNames)}`,
  )
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

  // 云端：必须原样放行，一个字都不动
  const cloudOut = await prompt.assemble({ agent: cloudAgent })
  check('云端段数不变', cloudOut.sections.length === mkSections(withPurge).length, `len=${cloudOut.sections.length}`)
  if (withPurge) {
    const cloudInject = cloudOut.sections.find((s) => s.name === 'dsh-purge')
    check('云端注入完整', Boolean(cloudInject) && cloudInject.text.length === refText.length)
  } else {
    // 没装 dsh-purge 时装配里本来就没有注入段；云端更不该凭空多出一段。
    check(
      '云端没有凭空多出注入段',
      !cloudOut.sections.some((s) => s.name === 'local-trim:inject'),
      `段名=${JSON.stringify(cloudOut.sections.map((s) => s.name))}`,
    )
  }
}

await scenario(true)
await scenario(false)

// ── 默认值不许拟合任何一台具体的机器 ────────────────────────────────
console.log('\n=== 场景 3：默认值普适性 ===')
{
  const hostGlobal = new Set(HOST_GLOBAL_TOOLS)
  const scoped = DEFAULT_KEEP.filter((n) => !hostGlobal.has(n))
  check(
    'DEFAULT_KEEP 里没有 scoped 名（会让真宿主整批拒绝）',
    scoped.length === 0,
    scoped.length > 0 ? `混进了 ${scoped.join(', ')}` : `${DEFAULT_KEEP.length} 项全是全局名`,
  )
  check('DEFAULT_KEEP 非空', DEFAULT_KEEP.length > 0)

  // 内置注入正文里出现的 `反引号工具名` 必须都在当前 keep 里
  const rendered = defaultInject([...DEFAULT_KEEP])
  const named = [...rendered.matchAll(/`([a-z_][a-z0-9_]*)`/g)].map((m) => m[1])
  const ghosts = [...new Set(named)].filter((n) => !DEFAULT_KEEP.includes(n))
  check('内置注入不点名 keep 之外的工具', ghosts.length === 0, ghosts.length > 0 ? `幽灵名 ${ghosts.join(', ')}` : `点名 ${named.length} 处`)

  // 换一个 keep，正文必须跟着变 —— 否则「按 keep 渲染」是假的
  const narrow = defaultInject(['read', 'bash'])
  check('换 keep 后正文跟着收窄', narrow.includes('`read`') && narrow.includes('`bash`') && !narrow.includes('`todo_write`'))
  check('keep 为空也不炸', defaultInject([]).includes('没有保留任何工具'))
  check('DEFAULT_INJECT 就是默认 keep 渲染出来的那份', DEFAULT_INJECT === defaultInject([...DEFAULT_KEEP]))

  // ops_* 这类本机专属名字一个都不该留在默认值里
  const all = [...DEFAULT_KEEP, ...DEFAULT_DROP_SECTIONS, ...rendered.matchAll(/`([^`]+)`/g)].map((m) =>
    typeof m === 'string' ? m : m[1],
  )
  const localOnly = all.filter((n) => /^ops_/.test(n))
  check('默认值里没有 dsh-ops 专属工具名', localOnly.length === 0, localOnly.join(', '))
  check('DEFAULT_DROP_SECTIONS 里没有模板段名（tool:workflow 这类查不到实体）', !DEFAULT_DROP_SECTIONS.includes('tool:workflow'))
}

console.log(`\n${fail === 0 ? '=== 全部通过 ===' : `=== ${fail} 项失败 ===`}`)
process.exit(fail === 0 ? 0 : 1)
