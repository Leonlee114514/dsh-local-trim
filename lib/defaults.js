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
  'dsh-purge:anchor',
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
