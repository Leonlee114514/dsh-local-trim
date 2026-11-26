# dsh-local-trim

给本地小模型用的 DSH 裁剪插件。命中本地 provider 时收窄上下文，其余一律原样放行。

DSH 的默认设定是按云端大模型配的：几十个工具、上万字系统提示词。本地模型的窗口通常只有 16K–64K，装不下就报 `CONTEXT_WINDOW_EXCEEDED`。而 DSH 没有「按模型裁工具」的开关 —— `dsh-tools` 的 Config 只有 `mode` / `maxParallel`，agent preset 只能声明插件，唯一的原语 `tools.restrict({ allow })` 也只影响当前 agent 及其子 agent。

这个插件补的就是这一层：

| 面 | 做什么 | 实现 |
|---|---|---|
| 工具面 | 只留白名单里的工具（默认 15 个核心工具） | `tools.restrict({ allow })`，allow = 实际可见名 ∩ 白名单 |
| 提示词面 | 丢掉本地用不上的段落（goal / ralph / mindmap / 图像生成 …） | `system-prompt/assemble` 按段名过滤 `sections` / `contexts` |
| 注入面 | 整份系统提示词换成一页纸 | 替换注入段正文，保留头 80 / 尾 96 字符 |
| schema 面 | 截短工具描述与参数说明 | 递归截 `description`，`type` / `properties` / `required` 不动 |

云端 provider 一个字节都不改：未命中路由时 `release(agent)` 撤销全部限制，`restrict` 调用次数为 0，装配阶段直接返回下游结果（同一对象引用）。本地与云端交替使用互不影响。

实测裁剪后本地模型的工具调用能力没有退化：`bash` → `glob` → `read` 两步串行依然正确。

```bash
dsh plugin add dsh-local-trim
```

装完就是开着的：端点自动识别，第一次探测到的本地后端会被写进 profile，不用重启。

---

## 支持的后端

llama.cpp / Ollama / vLLM / LM Studio，本机或局域网都行。端点探测、模型扫描、拉起与停止都按这四家做了适配。

## 安装

### 1. npm（推荐，v0.5.2 起不需要 git）

```bash
dsh plugin add dsh-local-trim
dsh plugin add dsh-local-trim@0.5.8   # 钉版本
```

### 2. 从 GitHub 装（需要机器上有 git）

```bash
dsh plugin add github:Leonlee114514/dsh-local-trim
```

宿主会先跑 `git -c credential.helper= ls-remote -- <repo> HEAD`。没装 git 时两侧报错都指错方向（命令行说 allowBuilds、市场说 pnpm 退出码 9009），DSH 桌面端不自带 git。绕法：固定 40 位 commit sha，走 codeload tarball，pnpm 不需要 git。

### 3. link: 本地调试

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:../../../path/to/dsh-local-trim
```

然后在 `cordis.patch.yml` 末尾 insert。手工拷进 `node_modules` 会被下一次 `pnpm install` 当成无主残留隔离删除。

## 快速开始

装好插件后，配置里两行就能开始裁剪：

```yaml
plugins:
  local-tool-trim:
    config:
      enabled: true
      routes: []      # [] = 自动识别本地端点
```

`routes` 三态：

| 写法 | 含义 |
|---|---|
| 不写 | 只认早期默认的 `local-qwen` |
| `[]` | 自动识别（推荐） |
| `[local-ollama, local-llamacpp]` | 只认列出的 provider 名 |

自动识别先解析 hostname：`127.0.0.0/8`、`localhost`、`0.0.0.0`、`[::1]`、`10.x` / `192.168.x` / `172.16–31.x`、`169.254.x`、`100.64–127.x`、IPv6 ULA `fc00::/7`、`fe80::/10`、`::ffff:127.0.0.1`、`host.docker.internal` 一类容器别名、`.local` / `.internal` / `.localhost` 后缀、单标签主机名。`http://localhost.attacker.com/v1` 不算本地；provider 有 `baseURL` 时以地址为准，名字不作数。

### 确认裁剪真的生效

让 llama-server 把 prompt 落盘：

```bash
llama-server -m model.gguf --port 8090 --jinja -c 65536 \
  --log-prompts-dir ~/.dsh/local-llm/prompts
```

跑一轮对话后取最新文件：

```bash
f=$(ls -t ~/.dsh/local-llm/prompts/*.txt | head -1)
grep -c 'LOCAL LIGHT' "$f"       # 期望 1
grep -c 'PRIME DIRECTIVE' "$f"   # 期望 0
grep -c 'Mindmap editing' "$f"   # 期望 0
```

如果 `PRIME DIRECTIVE` 还是 1，按两步排查：

1. 看自检日志里的 `assemble 接管` 一行。理想值是 `accessor+purge-slot`；显示 `already` 说明外层套着别的实例的包装器。
2. 临时开 `debugWrap: true`，日志里会出现成对的「包装器进入: N 段 / X 字符」与「包装器返回: M 段 / Y 字符」。

## 一步到位

`provision` 让插件自己找端点并写好 provider，不用手写 yaml。

| 值 | 行为 |
|---|---|
| `false` | 不探测 |
| `true`（默认） | 依次探 8090 llama.cpp → 11434 Ollama → 8000 vLLM → 1234 LM Studio |
| `{ endpoint: ... }` | 只探指定端点 |
| `{ endpoints: [...], provider, overwrite }` | 全量控制 |

- 已有可用的本地 provider 时完全不写入。
- provider id 按端口推断：`local-llamacpp` / `local-ollama` / `local-vllm` / `local-lmstudio`。
- 窗口从 `/v1/models` 的 `meta.n_ctx`、`meta.n_predict` 读，读不到用保守值。

自动写入的 profile 里有三样东西是必须的，手写时别漏：

1. `compat.thinkingFormat: chat-template` + `chatTemplateKwargs.enable_thinking: false` —— 否则 `max_tokens` 全花在 `reasoning_content` 上，`content` 是空串。
2. `models[].reasoningEfforts: { off: null, low: low }` —— `model.reasoning === true` 的前提。
3. `headers.Authorization: Bearer local` —— pi-ai 要求有 key 或头，否则抛 `No API key for provider`；llama.cpp 更安静，直接返回空 completion。

不要为了「随便填个值」写 `apiKeyEnv`：环境变量缺失会 `MISSING_CREDENTIAL` → `listModels` 空 → 模型选择器里一个模型都看不到。`chatTemplateKwargs: null` 在 v0.5.7 起会真的清掉旧值。

## 接入四种后端

### llama.cpp

```bash
llama-server -m model.gguf --mmproj mmproj.gguf \
  --host 127.0.0.1 --port 8090 --alias my-local --jinja \
  -c 65536 --n-predict 8192 \
  --cache-type-k q8_0 --cache-type-v q8_0
```

```yaml
providers:
  local-llamacpp:
    displayName: llama.cpp (local)
    api: openai-completions
    baseURL: http://127.0.0.1:8090/v1
    headers:
      Authorization: Bearer local
    defaultContextWindow: 65536      # 必须和 -c 一致
    defaultMaxTokens: 8192           # 必须和 --n-predict 一致
    timeoutMs: 1800000
    streamIdleTimeoutMs: 600000
    compat:
      supportsUsageInStreaming: true
      maxTokensField: max_tokens
      thinkingFormat: chat-template
      chatTemplateKwargs:
        enable_thinking: false
    models:
      - id: my-local
        name: My Local
        contextWindow: 65536
        maxTokens: 8192
        input: [text]
        reasoningEfforts: { off: null, low: low }
```

`defaultContextWindow` 只在 provider 重新解析时生效 —— 改完必须重启 DSH。

### Ollama

```bash
ollama serve            # 默认 127.0.0.1:11434
ollama pull qwen2.5-coder:7b
```

```yaml
providers:
  local-ollama:
    displayName: Ollama
    api: openai-completions
    baseURL: http://localhost:11434/v1
    headers:
      Authorization: Bearer local
    defaultContextWindow: 32768
    defaultMaxTokens: 4096
```

Ollama 的 `num_ctx` 由模型 Modelfile 决定，得和这里的 `defaultContextWindow` 对齐；`ollama show <model>` 能看到实际值。provider 名带 `ollama` 前缀，自动识别直接命中。

### vLLM

```bash
vllm serve Qwen/Qwen2.5-Coder-7B-Instruct \
  --host 0.0.0.0 --port 8000 --max-model-len 32768
```

```yaml
providers:
  vllm:
    displayName: vLLM
    api: openai-completions
    baseURL: http://192.168.1.9:8000/v1   # 局域网机器也自动识别
    apiKeyEnv: VLLM_API_KEY               # 只有开了 --api-key 才需要，值要真配上
    defaultContextWindow: 32768
    defaultMaxTokens: 4096
    compat:
      maxTokensField: max_tokens
```

### LM Studio

GUI 里打开 **Developer → Start Server**（默认 `127.0.0.1:1234`），Context Length 在模型加载设置里改。

```yaml
providers:
  lmstudio:
    displayName: LM Studio
    api: openai-completions
    baseURL: http://127.0.0.1:1234/v1
    headers:
      Authorization: Bearer local      # LM Studio 不校验
    defaultContextWindow: 16384
    defaultMaxTokens: 4096
```

## 配置参考

```yaml
plugins:
  local-tool-trim:
    config:
      enabled: true
      routes: []                  # [] = 自动识别
      promptTrim: true            # 提示词面 + 注入面
      schemaTrim: true            # schema 面
      provision: true             # 一步到位：探端点并写 provider
      autoDetectBaseURL: true
      selfCheck: true
      debugWrap: false
      toolDescLimit: 140          # 0 = 不截断
      toolParamDescLimit: 90      # 0 = 不截断
      launchCommand: ''           # 面板「拉起」用的命令
      launchTimeout: 20           # 拉起后等端口，3–600 秒
      smokeTimeout: 60            # 试跑超时，5–600 秒
      bridgeThrottleMs: 800       # 面板请求最小间隔，0 = 关掉间隔限制
      injectText: ''              # 留空则读 light-inject.md，再退到内置一页纸
      modelDirs: []               # 额外的模型目录，支持 ~
      trustedPanelHosts: []       # 额外放行的 Host 头
      trustedPanelPeers: []       # 额外放行的 TCP 对端地址
      keep: [bash, pwsh, read, write, edit, apply_patch, glob, grep,
             working_directory, job_output, job_list, job_kill,
             todo_write, present, read_image]
      dropSections: [ui:deliverable-file-references, app:web-surface,
                     tool:goal, tool:ralph, tool:session-query, tool:pty,
                     harness:source, tool:mindmap, free-search:engines,
                     dshpg-capabilities, mnemon:routing, plugin:dsh-imagegen,
                     dsh-excel-chat:interaction,
                     dsh-ops:repository-tooling:mode-standard,
                     dsh-ops:repository-tooling:mode-ptc,
                     dsh-ops:repository-tooling:mode-cordis]
      dropContexts: [mnemon:memory-view, mnemon:runtime-memory]
```

两个注意点：

- `keep` 只写**全局工具名**。带上插件命名空间的 scoped 名会让 `tools.restrict` 整批失败。
- `toolDescLimit` / `toolParamDescLimit` 再往下截会留下半句话，反而降低调用正确率；140 / 90 是实测的平衡点，`0` 表示不截断。

### 换成自己的轻量注入

三层优先级，前面的赢：

1. 配置项 `injectText`
2. `~/.dsh/local-llm/light-inject.md`
3. 内置 `DEFAULT_INJECT`（一页纸：身份 + 5 条准则 + 工具速查 + 输出格式）

段名：装了 dsh-purge 就沿用它的段名 `dsh-purge`，没装则写 `local-trim:inject`。读取时两个名字都认，前缀也照旧识别。

## 控制面板

面板在**插件详情页**，读写 `cordis.patch.yml` 里的 `local-tool-trim.config`，保存即生效。

| 区域 | 内容 |
|---|---|
| 状态带 | 接管方式（`accessor+purge-slot` / `accessor-native`）、注入正文字符数与来源、一步到位、提示词裁剪 / schema 瘦身、设置是否可写 |
| 裁剪收益 | 最近一次装配的 进→出 字符、省下的百分比、段数、provider、时间；云端显示「未裁剪」 |
| 模型表 | 端点指示灯、试跑、拉起、停止、删除、后端实况、对齐、对账 |
| 本机模型 | 扫 `modelRoots`、认 GGUF 魔数 / Ollama blob、VRAM 预检、端口跟文件走、试跑冷加载重试 |
| 高级配置 | 开关、阈值、三个名单、注入正文、拉起命令、各种超时 |

模型表里的几个动作值得说明：

- **点灯**：`GET /v1/models`，15 秒缓存，并发不串行。
- **试跑**：发一条「只回一个字：好」的真实请求，回毫秒数与回复。
- **停止**：`SIGTERM` → 1.5 秒不退 `SIGKILL`；Windows 走 `taskkill /PID /T /F` 杀整棵树。只停自己 spawn 且登记在内存表里的 pid，重启后表是空的。
- **删除**：走 `settings.mutate` unset，不是 update。继承来的 provider 删不掉，会回读确认并说明原因。
- **「N 模型」**：读后端实况，四态 —— 一致 / 后端还有没注册的 / 配置里有已消失的 / 全都不在了。
- **对齐**：把 `models:` 改成后端真有的那份，活着条目原样保留，连不上就不写，不会对齐成 0 个。
- **对账**：唯一会自动写配置的动作，只做减法，绝不补模型；启动时跑一次，`provision.reconcile: false` 可关。

### 面板的三个常见问题

**升级后默认值不生效。** `keep` / `dropSections` / `dropContexts` 只要被保存过，就以用户配置的身份固化了。v0.5.4 起会自动识别「这是不是某个旧默认值的变体」，按当前默认值解释：橙色提示 + 一行日志，配置文件一个字节不动。判据三条 —— 出现旧默认值没有的名字就不动、删减超过两成就不动、保留你自己的删减。

**保存报「被 home patch 覆盖」。** 整段写在 profile 的 `cordis.patch.yml` 里时，`settings.update` 要求合成结果与写入值完全一致。改文件，或删掉 `config:` 段。

**面板不出现。** 槽位 `plugins.detail.section` 由 `@deepseek-ai/dsh-client-ui-plugin-manager` 声明，只被 `dsh-web-app` 依赖。headless / sdk / acp profile 画不出面板，但裁剪照常生效。

## 启动自检

启动时自检 11 项，写 `~/.dsh/local-llm/local-trim.log`：tools / systemPrompt / dsh-purge（可选）/ assemble 接管 / 轻量注入正文 / 工具白名单 / 裁剪段落 / 生效路由 / schema 瘦身 / 一步到位 / client 半边。

- 结论只写变化：`[800, 2500, 6000]` ms 三次重试 + 6500 ms 复核，结论变了才补一行，没变一个字都不说。
- client 半边三态：`✓` 有宿主 / `·` 没有宿主（用 `·` 不用 `✗`，headless profile 属正常）/ `…` 待探测。
- 关掉：`selfCheck: false`。
- bridge 路由挂在 `/api/dsh-local-trim/{describe,save,probe,log,status,check,import,test,launch,stop,models,adopt,delete,align,reconcile}`。

## 七个踩过的坑

1. `tools.restrict` 只认全局工具名。传 scoped 名会让整批失败，得从错误消息里抠出被拒的名字、下一轮跳过。
2. waterfall 的 `next()` 不收参数。裁剪要在 `await next()` 之后对返回值做。
3. 别跟 dsh-purge 的 400 ms 心跳抢 `slot.rewrite`。要转发 `Symbol.for('dsh-purge.assembleGuard')`。
4. 注入段必须 `interpolate: false`，且保留头 80 / 尾 96 字符。宿主 `dsh-agent-loop` 会检查 `globalThis.__dshPurgeHungPrompt()` 的头尾是否还在，缺一个就把整份原文再前置一遍。
5. `llm-pi-ai` 改 `defaultContextWindow` 要重启实例才生效。
6. 热重载会留下上一实例的包装器，必须叠加而不是跳过 —— 用每次 `apply` 不同的实例 token，不能靠全局布尔。
7. `.volatile()` 字段是活引用，必须每次现读（`resolveConfig(config)` 逐键 `.get()`）。

## 跨平台

CI 跑 ubuntu-latest（Node 20 / 22 / 24）+ windows-latest + macos-latest（Node 22）。

| | Windows | macOS | Linux |
|---|---|---|---|
| 用户目录 / 数据目录 | `%USERPROFILE%` / `%LOCALAPPDATA%` | `~` / `~/Library/Application Support` | `~` / `$XDG_DATA_HOME` |
| 找 ollama | `%LOCALAPPDATA%\Programs\Ollama`、`Program Files`、`~/AI/ollama`、PATH | `.app` 包内、Homebrew、PATH | `/usr/local/bin`、`/usr/bin`、`/snap/bin`、PATH |
| 找 llama-server | `%LOCALAPPDATA%\llama.cpp`、`~/AI/llama.cpp`、WorkBuddy build、PATH | Homebrew、`/usr/local/bin`、PATH | 同 macOS |
| 找 vLLM / LM Studio | `LM-Studio\lms.exe`、`Program Files`、PATH | `.app` 包内、PATH | `/usr/local/bin`、PATH |
| 扫权重 | `~/models`、`~/llama.cpp/models`、`~/AI/models`、`~/Downloads`、`%LOCALAPPDATA%\ollama\models` | `~/models`、`~/llama.cpp/models`、`~/.cache/llama.cpp`、`~/.ollama/models`、LM Studio 数据目录 | `~/models`、`~/.ollama/models`、`/usr/share/ollama/.ollama/models`、`/usr/lib/ollama/models`、`/opt/ollama/models` |
| 显存探测 | `nvidia-smi`（system32，靠 PATH） | `nvidia-smi` / `rocm-smi` / `sysctl hw.memsize` | `nvidia-smi` / `rocm-smi` |
| 拉起 / 停止 | spawn + `taskkill /T /F` | spawn + 信号 | spawn + 信号 |

只有真机才验得了的三样：`stopProcess` 的 Windows 分支走真 `taskkill`、`runDetached` 的 `.cmd` 分支走真 `cmd.exe`、`client.js` 走真 `window` 替身。所以 `bridge.mjs` 与 `client.mjs` 在 win / macos 上另跑一遍；`launcher.mjs` 的 Windows 分支靠 `input.platform` / `input.execFile` 注入，在 Linux 上也能覆盖。

### 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_LOCAL_MODELS_DIR` | 自己的模型目录，优先级最高。网络盘也认：`DSH_LOCAL_MODELS_DIR=\\NAS\share\models` |
| `OLLAMA_MODELS` | 排到 Ollama 候选最前（目录须含 `manifests` / `manifests-v2` / `blobs`） |
| `OLLAMA_BIN` | 自己的 ollama 二进制 |
| `LLAMA_SERVER_BIN` | 自己的 llama-server 二进制 |

配置项 `modelDirs` 可以再补几个目录，支持 `~`。参数能力靠 `--help` 探测：老版 llama-server 没有 `--fit` 就自动换 `--n-gpu-layers 99`，且不下发 KV 量化。

## 已知边界

- 只做进程内裁剪，不碰权重、不改第三方源码。
- dsh-purge 是可选增强，不是前提。
- 不改你已经写好的 provider 配置。0.5.3 之前的 `apiKeyEnv` 需要自己删掉或配值。
- llama.cpp 调参只到「一组能跑的默认值」：`--n-gpu-layers auto --fit on --cache-type-k/v q8_0 -c 65536 --n-predict 8192`。
- 资源预检是估算不是保证：`hostBytes = sizeBytes − gpuBytes`，`reserveMb` 默认 2048 MiB（夹 0–262144）。
- 面板只能停自己拉起的进程（内存表，重启即空）。

## 开发

```bash
npm run verify         # check + test：25 个文件语法 + 12 套单元 + 跨平台推演
npm run check          # 逐文件 node --check
npm run test           # 全部套件
npm run test:portable  # 三平台路径推演
npm run test:sim       # 模拟宿主
node test/selfcheck.mjs   # 单套：三个场景
```

## License

MIT
