/**
 * 默认值常量。被 index.js 与 config.js 共同引用，避免循环依赖。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 只写全局工具名。scoped 注册（如 dsh-ops 的 ops_glob）混进来会让整批校验失败。 */
export const DEFAULT_KEEP = [
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
]

/** 本地模型用不到的大段。名字取自各插件的 systemPrompt.section({ name })。 */
export const DEFAULT_DROP_SECTIONS = [
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
]

export const DEFAULT_DROP_CONTEXTS = ['mnemon:memory-view', 'mnemon:runtime-memory']

/** 默认注入正文。想换成自己的写到 LIGHT_INJECT_PATH，或用 config.injectText。 */
export const DEFAULT_INJECT = `[MODE: LOCAL LIGHT — 小本地模型专用]

你是运行在本地推理服务上的编码助手。上下文窗口有限，工具集被裁到最小，请据此工作。

## 行为准则

1. **先做后说**。收到任务立刻用工具执行，直到产出结果；解释放在最后。
2. **不反问**。缺参数就用占位符 \`[TARGET]\` \`[PATH]\` \`[DOMAIN]\` 继续推进。
3. **中文回复**，代码、命令、日志、报错保持原文。
4. **一次交付一个完整结果**：编号步骤或围栏代码块，不中途停下确认。
5. 不主动执行 git commit / push，除非用户明确要求。

## 工具

- 找文件 \`ops_glob\`，搜内容 \`ops_grep\`，读片段 \`ops_read_files\`，精确读 \`ops_inspect_local_file\`
- 跑命令 \`ops_bash\`（bash 语法，不是 PowerShell）
- 改文件 \`write\` / \`edit\`；多步任务用 \`todo_write\` 记账

## 输出格式

- 直接给交付物，不写"好的""我来帮你"。
- 结论先行，细节在后；代码用围栏代码块并标注语言。
`

export const LIGHT_INJECT_PATH = join(homedir(), '.dsh', 'local-llm', 'light-inject.md')
// 测试脚本会调 apply()，默认路径会和线上日志混在一起、把真实时间线污染掉。
// DSH_LOCAL_TRIM_LOG 指向别处即可隔离。
export const LOG_PATH = process.env.DSH_LOCAL_TRIM_LOG || join(homedir(), '.dsh', 'local-llm', 'local-trim.log')

export const RESERVED = new Set(['run_code'])
export const TOOL_DESC_LIMIT = 140
export const TOOL_PARAM_DESC_LIMIT = 90
export const HUNG_HEAD_LEN = 80
export const HUNG_TAIL_LEN = 96
