/**
 * 默认值常量。被 index.js 与 config.js 共同引用，避免循环依赖。
 *
 * 一条纪律：这里的每一项都必须是「任何一台装了 DSH 的机器上都成立」的东西。
 * 具体来说 ——
 *   · 工具名只取官方 @deepseek-ai/dsh-tool-* 注册的全局名；
 *   · 段名只取官方包里 systemPrompt.section({ name }) 的字面量；
 *   · 不写任何本机特有的 provider id、插件名、目录、二进制路径。
 * 违反这条的后果不是「多探一个不存在的目录」那么轻：DEFAULT_INJECT 会被原样
 * 塞给本地小模型当系统提示，里面点名一个这台机器上根本不存在的工具，模型就会
 * 一直去调它、一直失败，而用户看到的是「模型很笨」。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 默认保留的工具。
 *
 * 只写**全局**工具名。scoped 注册（dsh-ops 的 ops_glob / ops_bash 之类）混进来
 * 会让 tools.restrict({ allow }) 整批校验失败 —— 宿主的原话是
 * 「Restrictions intersect; scoped registrations remain visible.」，也就是 scoped
 * 工具本来就不受限制，写进来既没用又会把整次 restrict 打回。
 *
 * 名字全部来自官方 dsh-base 的 dsh-tool-* 包（改之前请先核对真值表）。
 */
export const DEFAULT_KEEP = [
  'bash',
  'pwsh',
  'read',
  'write',
  'edit',
  'apply_patch',
  'glob',
  'grep',
  'working_directory',
  'job_output',
  'job_list',
  'job_kill',
  'todo_write',
  'present',
  'read_image',
]

/**
 * 本地模型用不到的大段。名字取自各插件的 systemPrompt.section({ name })。
 *
 * 分两类：
 *   ① official —— 官方包里的字面量，装了就有、没装就是空操作；
 *   ② third-party —— 第三方插件常见的大段，同样「没装就是空操作」。
 * 两类都只是「如果存在就丢掉」，不会因为没有这个插件而出错；但新增条目请
 * 确认它在**某个**公开插件里真实存在，别把本机独有、改过配置的段名写进来
 * （`tool:${toolName}` 这种模板段名尤其不能写死，配置里改过 toolName 就对不上）。
 */
export const DEFAULT_DROP_SECTIONS = [
  // ① official
  'ui:deliverable-file-references',
  'app:web-surface',
  'tool:goal',
  'tool:ralph',
  'tool:session-query',
  'tool:pty',
  'harness:source',
  // ② third-party（装了才有，没装是空操作）
  'tool:mindmap',
  'free-search:engines',
  'dshpg-capabilities',
  'mnemon:routing',
  'plugin:dsh-imagegen',
  'dsh-excel-chat:interaction',
  'dsh-ops:repository-tooling:mode-standard',
  'dsh-ops:repository-tooling:mode-ptc',
  'dsh-ops:repository-tooling:mode-cordis',
]

export const DEFAULT_DROP_CONTEXTS = ['mnemon:memory-view', 'mnemon:runtime-memory']

/**
 * 历史版本的默认值。
 *
 * 为什么需要这张表：`keep` / `dropSections` 是**配置字段**，一旦被面板或
 * cordis.patch.yml 写进 profile，就永久留在那里。于是「配置里有值」和「用户想要
 * 这个值」在代码里长得一模一样 —— 从 0.5.1 升上来的机器，配置里存的仍是 0.5.1 的
 * 19 条 keep（含 5 个 scoped 名），新默认值（15 条、去掉 scoped 名）永远不会生效。
 * 这不是某台机器的特例，是所有从旧版升级的机器都会中的坑。
 *
 * 只放**已经发过版**的默认值，不要预先塞未来的值。判据见 migrateLegacyList()。
 */
export const LEGACY_DEFAULTS = [
  {
    version: '0.5.1',
    // 19 条：含 5 个 scoped 名（ops_*），它们会让 tools.restrict 整批被拒。
    keep: [
      'bash',
      'pwsh',
      'ops_bash',
      'read',
      'ops_read_files',
      'ops_inspect_local_file',
      'write',
      'edit',
      'glob',
      'ops_glob',
      'grep',
      'ops_grep',
      'working_directory',
      'job_output',
      'job_list',
      'job_kill',
      'todo_write',
      'present',
      'read_image',
    ],
    // 18 条：含两条死条目（tool:workflow 是模板段名、dsh-purge:anchor 从不存在）。
    dropSections: [
      'tool:mindmap',
      'free-search:engines',
      'dsh-purge:anchor',
      'dshpg-capabilities',
      'mnemon:routing',
      'plugin:dsh-imagegen',
      'ui:deliverable-file-references',
      'app:web-surface',
      'tool:goal',
      'tool:ralph',
      'tool:workflow',
      'tool:session-query',
      'tool:pty',
      'dsh-excel-chat:interaction',
      'dsh-ops:repository-tooling:mode-standard',
      'dsh-ops:repository-tooling:mode-ptc',
      'dsh-ops:repository-tooling:mode-cordis',
      'harness:source',
    ],
  },
  {
    version: '0.5.2',
    // keep 与当前一致（15 条），列出来只是为了让 0.5.2 的 dropSections 能被认出来。
    keep: [
      'bash',
      'pwsh',
      'read',
      'write',
      'edit',
      'apply_patch',
      'glob',
      'grep',
      'working_directory',
      'job_output',
      'job_list',
      'job_kill',
      'todo_write',
      'present',
      'read_image',
    ],
    // 17 条：比当前多一条 dsh-purge:anchor（0.5.3 才删掉）。
    dropSections: [
      'ui:deliverable-file-references',
      'app:web-surface',
      'tool:goal',
      'tool:ralph',
      'tool:session-query',
      'tool:pty',
      'harness:source',
      'tool:mindmap',
      'free-search:engines',
      'dsh-purge:anchor',
      'dshpg-capabilities',
      'mnemon:routing',
      'plugin:dsh-imagegen',
      'dsh-excel-chat:interaction',
      'dsh-ops:repository-tooling:mode-standard',
      'dsh-ops:repository-tooling:mode-ptc',
      'dsh-ops:repository-tooling:mode-cordis',
    ],
  },
]

const toNameSet = (list) => new Set((Array.isArray(list) ? list : []).map(String))

/**
 * 这个列表是不是某一版历史默认值的拷贝？是就翻译成「按当前默认值解释」的列表。
 *
 * 三条判据，缺一不可：
 *   ① **不许有多余的名字** —— 只要出现一个那一版默认值里没有的名字，就是用户自己
 *      加的，原样尊重，一个字都不改；
 *   ② **删减不超过两成** —— 「默认值拷贝」和「用户手工精简到只剩 bash / read」
 *      必须分开，否则后者会被翻译成一个空列表（那就等于把所有工具都裁掉）；
 *   ③ 翻译结果必须真的与存的不同，否则返回 null（没什么可迁移的）。
 *
 * 用户的删减会**保留**：那一版有、这里没有、当前默认值里还在的名字，翻译后继续
 * 不保留。本机就靠这一条保住「不要把 working_directory 加回 keep」那个手工决定。
 *
 * @returns {{version: string, next: string[], removed: string[], added: string[], dropped: string[]} | null}
 */
export function migrateLegacyList(list, current, kind) {
  if (!Array.isArray(list) || list.length < 2) return null
  const stored = toNameSet(list)
  const now = toNameSet(current)
  // 从新到旧找：0.5.2 的 dropSections 是 0.5.1 的真子集，正着遍历会把 0.5.2 的配置
  // 误报成 0.5.1（结果虽然一样，日志里说的版本号是错的）。先认最近的那一版。
  for (const legacy of [...LEGACY_DEFAULTS].reverse()) {
    const old = toNameSet(legacy[kind])
    if (old.size === 0) continue
    if ([...stored].some((name) => !old.has(name))) continue
    const removed = new Set([...old].filter((name) => !stored.has(name)))
    if (removed.size > Math.floor(old.size * 0.2)) continue
    const next = [...now].filter((name) => !removed.has(name))
    const added = next.filter((name) => !stored.has(name))
    const dropped = [...stored].filter((name) => !now.has(name))
    if (added.length === 0 && dropped.length === 0) return null
    return { version: legacy.version, next, removed: [...removed], added, dropped }
  }
  return null
}

/**
 * 工具速查表的真值来源。key 必须是官方全局工具名，value 是一句中文短语。
 * defaultInject() 只会渲染「当前 keep 集合里真的有的」那些 —— 这是
 * 「注入正文不点名不存在的工具」的实现方式。
 */
const TOOL_GROUPS = [
  ['读取', [
    ['glob', '找文件'],
    ['grep', '搜内容'],
    ['read', '读文件'],
    ['read_image', '看图'],
  ]],
  ['修改', [
    ['edit', '改文件'],
    ['write', '写文件'],
    ['apply_patch', '打补丁'],
  ]],
  ['执行', [
    ['bash', '跑命令'],
    ['pwsh', '跑 PowerShell'],
    ['working_directory', '切工作目录'],
    ['job_output', '取后台输出'],
    ['job_list', '列后台任务'],
    ['job_kill', '停后台任务'],
  ]],
  ['流程', [
    ['todo_write', '记任务清单'],
    ['present', '交付文件'],
    ['skill', '加载技能'],
    ['ask_user_question', '问用户'],
  ]],
]

const KNOWN_TOOL_NAMES = new Set(TOOL_GROUPS.flatMap(([, items]) => items.map(([name]) => name)))

/** 把当前 keep 集合渲染成「工具」小节。没列进去的工具名一个都不会出现。 */
function renderToolSection(keepNames) {
  const present = new Set(keepNames.map(String))
  const lines = []
  for (const [, items] of TOOL_GROUPS) {
    const hits = items.filter(([name]) => present.has(name)).map(([name, hint]) => `\`${name}\` ${hint}`)
    if (hits.length > 0) lines.push(`- ${hits.join('；')}`)
  }
  const others = keepNames.map(String).filter((name) => name.length > 0 && !KNOWN_TOOL_NAMES.has(name))
  if (others.length > 0) lines.push(`- ${others.map((name) => `\`${name}\``).join(' / ')}`)
  if (lines.length === 0) lines.push('- （当前没有保留任何工具）')
  return lines.join('\n')
}

/**
 * 内置注入正文。keep 传什么就只点名什么 —— 换 keep 不会留下「说了但没给」的
 * 幽灵工具名。想换成自己的写到 LIGHT_INJECT_PATH，或用 config.injectText。
 */
export function defaultInject(keepNames = DEFAULT_KEEP) {
  return `[MODE: LOCAL LIGHT — 小本地模型专用]

你是运行在本地推理服务上的编码助手。上下文窗口有限，工具集被裁到最小，请据此工作。

## 行为准则

1. **先做后说**。收到任务立刻用工具执行，直到产出结果；解释放在最后。
2. **不反问**。缺参数就用占位符 \`[TARGET]\` \`[PATH]\` \`[DOMAIN]\` 继续推进。
3. **中文回复**，代码、命令、日志、报错保持原文。
4. **一次交付一个完整结果**：编号步骤或围栏代码块，不中途停下确认。
5. 不主动执行 git commit / push，除非用户明确要求。

## 工具

${renderToolSection(keepNames)}

## 输出格式

- 直接给交付物，不写"好的""我来帮你"。
- 结论先行，细节在后；代码用围栏代码块并标注语言。
`
}

/** 用默认 keep 渲染出来的那一份。保留这个名字是为了兼容旧引用。 */
export const DEFAULT_INJECT = defaultInject()

export const LIGHT_INJECT_PATH = join(homedir(), '.dsh', 'local-llm', 'light-inject.md')
// 测试脚本会调 apply()，默认路径会和线上日志混在一起、把真实时间线污染掉。
// DSH_LOCAL_TRIM_LOG 指向别处即可隔离。
export const LOG_PATH = process.env.DSH_LOCAL_TRIM_LOG || join(homedir(), '.dsh', 'local-llm', 'local-trim.log')

export const RESERVED = new Set(['run_code'])
export const TOOL_DESC_LIMIT = 140
export const TOOL_PARAM_DESC_LIMIT = 90
export const HUNG_HEAD_LEN = 80
export const HUNG_TAIL_LEN = 96
