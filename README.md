# dsh-local-trim

给本地小模型一套**轻量 harness**：让 llama.cpp / Ollama / vLLM / LM Studio 这类本地端点也能在
[DeepSeek Harness](https://github.com/deepseek-ai) 里顺畅干活，而云端 provider 一个字节都不动。

**它做什么**：把工具面、系统提示词、工具 schema 三个面同时收窄，并把注入的整份系统提示词
换成一页纸。本地模型工具调用能力实测未退化（`ops_bash` / `ops_glob` / `ops_read_files`
两步串行都正确）。

> 这里不给具体的请求体数值。绝对值由你自己的 harness 决定 —— 装了多少插件、注册了多少工具、
> 系统提示词有哪几段，每个人的基线不同，裁剪空间也就不同。想知道自己省了多少，
> 用文末「验证裁剪真的生效了」那段，在装与不装之间各抓一次请求来对比。

---

## 为什么需要它

DSH 默认面向云端大模型：一个装满插件的 profile 打开就是几十上百项工具，加一整份长篇系统
提示词。本地模型常见窗口是 16K–64K，装得多一点就 `CONTEXT_WINDOW_EXCEEDED`；就算窗口够，
小模型被上百个工具描述和几万字规则围着，调用正确率也会掉。

具体多大取决于你装了什么 —— 这正是下面要做按 provider 裁剪的原因。

DSH 没有「按模型裁工具」的开关：

- `dsh-tools` 的 Config 只有 `mode` / `maxParallel`；
- agent-preset 只能声明插件，不列 ≠ 不注册；
- `dsh-purge` 也没有工具过滤字段。

唯一原语是 `tools.restrict({ allow })`，它把限制追加到调用者所在 scope 的层，**只影响该 agent
及其子 agent** —— 正好满足「只给本地模型精简」。本插件就是把这个原语和三个提示词层面的
裁剪组合起来。

---

## 四层裁剪

| 层 | 做什么 | 手段 |
| --- | --- | --- |
| 1. 工具面 | 只留本地真用得上的工具 | `tools.restrict({ allow })`，allow = 实际可见名 ∩ 白名单 |
| 2. 提示词面 | 丢掉本地用不到的大段 | `system-prompt/assemble` 里按段名过滤 `sections` / `contexts` |
| 3. 注入面 | 整份系统提示词换成一页纸 | 替换 `dsh-purge` 注入段正文，保留头 80 / 尾 96 字符 |
| 4. schema 面 | 截断工具描述 | 递归截 `description`，`type` / `properties` / `required` 一字不动 |

第 3 层有个关键细节：宿主 `dsh-agent-loop` 在渲染完 prompt 后会检查
`globalThis.__dshPurgeHungPrompt()` 返回的原文的**前 80 字符和后 96 字符**是否都还在渲染结果里；
只要缺一个，就把整份原文再前置一遍。所以替换注入时必须原样保留这两段取样，否则省下的
token 会被立刻加回去。

---

## 安装

### 方式一：`dsh plugin add`（推荐，v0.1.1 起）

包已声明 `dsh.bundle`，装完自动生效，默认开启自动识别（`routes: []`）：

```bash
dsh plugin add github:Leonlee114514/dsh-local-trim
```

不想要自动识别就改自己 profile 的 `cordis.patch.yml`，把 `local-tool-trim` 的 `routes` 写死：

```yaml
- id: local-tool-trim
  config:
    routes: [my-local-provider]   # 只裁这一个 provider
```

### 方式二：本地源码 + `link:`

适合改代码调试。

```bash
# 1) 进你的 DSH profile 目录
cd ~/.dsh/profiles/desktop          # Windows: %USERPROFILE%\.dsh\profiles\desktop

# 2) 作为本地依赖登记（用 link: 指向源码目录，改完即时生效）
#    路径必须是相对 profile 目录的正确层数，写错会得到一个指向空目录的 junction
pnpm add link:../../../path/to/dsh-local-trim

# 3) 在 cordis.patch.yml 末尾 insert 插件（见下方配置）
```

> **踩过的坑**：手工把插件拷进 `node_modules/` 而不写进 `package.json`，任何一次
> `pnpm install` 都会把它当无主残留隔离删除（日志在 `.dsh-market/log.ndjson`）。一定要用
> `pnpm add link:...` 或写进 `dependencies`。

### 最小配置

```yaml
- insert:
    - id: local-tool-trim
      name: dsh-local-trim
      inject: [ tools, systemPrompt ]
      config:
        enabled: true
        routes: []          # 空数组 = 自动识别本地端点
```

`routes` 三态：

| 写法 | 含义 |
| --- | --- |
| 不写 | 退回首版行为，只认 `local-qwen` |
| `[]` | **自动识别**：provider 的 baseURL 指向回环/私有网段，或 provider 名带 local/ollama/vllm/lmstudio 等标记 |
| `[local-qwen, ollama]` | 只认写出来的名字（精确匹配，`local-qwen-turbo` 不会命中） |

自动识别的 baseURL 特征：`127.0.0.1` / `localhost` / `0.0.0.0` / `[::1]` /
`host.docker.internal` / `10.x` / `192.168.x` / `172.16–31.x`。

---

## 四种本地后端的接入

先把模型挂进 DSH 的 `llm-pi-ai` provider，本插件负责裁剪。四种后端都走 OpenAI 兼容接口，
差别只在 baseURL 和要不要 API key。

### llama.cpp（`llama-server`）

```bash
llama-server -m model.gguf --mmproj mmproj.gguf \
  --host 127.0.0.1 --port 8090 --alias my-local \
  --jinja -c 65536 --n-predict 8192 \
  --cache-type-k q8_0 --cache-type-v q8_0
```

```yaml
# cordis.patch.yml
- id: llm-pi-ai
  config:
    providers:
      local-qwen:
        displayName: 本地 llama.cpp
        api: openai-completions
        baseURL: http://127.0.0.1:8090/v1
        defaultContextWindow: 65536     # 必须和 -c 一致
        defaultMaxTokens: 8192          # 必须和 --n-predict 一致
        timeoutMs: 1800000
        streamIdleTimeoutMs: 600000
        compat:
          supportsUsageInStreaming: true
          maxTokensField: max_tokens
          chatTemplateKwargs:
            enable_thinking: false
        models:
          - id: my-local
            contextWindow: 65536
            maxTokens: 8192
            input: [ text ]
            reasoningEfforts: false
```

`defaultContextWindow` 只在 provider 重新解析时生效 —— **改完必须重启 DSH 实例**，
HMR 不覆盖 llm-pi-ai。

### Ollama

```bash
ollama serve                      # 默认 127.0.0.1:11434
ollama pull qwen2.5-coder:7b
```

```yaml
providers:
  ollama:
    displayName: Ollama
    api: openai-completions
    baseURL: http://localhost:11434/v1
    apiKeyEnv: OLLAMA_API_KEY        # 随便填个值，Ollama 不校验
    defaultContextWindow: 32768
    defaultMaxTokens: 4096
```

Ollama 的 `num_ctx` 由模型 Modelfile 决定，得和这里的 `defaultContextWindow` 对齐；
`ollama show <model>` 能看到实际值。provider 名带 `ollama` 前缀，自动识别直接命中。

### vLLM

```bash
vllm serve Qwen/Qwen2.5-Coder-7B-Instruct \
  --host 0.0.0.0 --port 8000 \
  --max-model-len 32768
```

```yaml
providers:
  vllm:
    displayName: vLLM
    api: openai-completions
    baseURL: http://192.168.1.9:8000/v1   # 局域网机器也自动识别（192.168.x）
    apiKeyEnv: VLLM_API_KEY
    defaultContextWindow: 32768
    defaultMaxTokens: 4096
    compat:
      maxTokensField: max_tokens
```

### LM Studio

GUI 里打开 **Developer → Start Server**（默认 `127.0.0.1:1234`），Context Length 在
模型加载设置里改。

```yaml
providers:
  lmstudio:
    displayName: LM Studio
    api: openai-completions
    baseURL: http://127.0.0.1:1234/v1
    apiKeyEnv: LMSTUDIO_API_KEY
    defaultContextWindow: 16384
    defaultMaxTokens: 4096
```

---

## 完整配置

```yaml
- insert:
    - id: local-tool-trim
      name: dsh-local-trim
      inject: [ tools, systemPrompt ]
      config:
        enabled: true
        routes: []
        promptTrim: true

        # 本地模型用不到的段。名字取自各插件的 systemPrompt.section({ name })。
        # 这份清单对应的是「装了很多插件」的 profile：你装了哪几个插件，就删哪几个插件
        # 产出的段，别整套照抄。名字对不上的段会被静默忽略，不会报错。
        dropSections:
          - tool:mindmap
          - free-search:engines
          - dsh-purge:anchor
          - dshpg-capabilities
          - mnemon:routing
          - plugin:dsh-imagegen
          - ui:deliverable-file-references
          - app:web-surface
          - tool:goal
          - tool:ralph
          - tool:workflow
          - tool:session-query
          - tool:pty
          - dsh-excel-chat:interaction
          - dsh-ops:repository-tooling:mode-standard
          - dsh-ops:repository-tooling:mode-ptc
          - dsh-ops:repository-tooling:mode-cordis
          - harness:source

        dropContexts:
          - mnemon:memory-view
          - mnemon:runtime-memory

        # 白名单同时写规范名和 dsh-ops 的 ops_* 名：localqwen profile 注册的是
        # bash/read/glob/grep，desktop profile 注册的是 ops_bash/ops_read_files/…
        keep:
          - bash
          - pwsh
          - ops_bash
          - read
          - ops_read_files
          - ops_inspect_local_file
          - write
          - edit
          - glob
          - ops_glob
          - grep
          - ops_grep
          - working_directory
          - job_output
          - job_list
          - job_kill
          - todo_write
          - present
          - read_image

        # 描述截断长度。再往下会把 "Omit or leave empty when using" 这类半句留下，
        # 反而降低调用正确率 —— 半句话比长话更容易误导模型调用。
        # 设 0 表示该面不截断（保留原文）。
        toolDescLimit: 140
        toolParamDescLimit: 90
```

---

## 换成自己的轻量注入

三层优先级：`config.injectText` > `~/.dsh/local-llm/light-inject.md` > 内置默认。

写个文件就行：

```bash
mkdir -p ~/.dsh/local-llm
cat > ~/.dsh/local-llm/light-inject.md <<'EOF'
[SYSTEM]
你是本地运行的编码助手。工具集已裁剪，上下文有限。
- 直接执行，不要反问，缺参数用占位符
- 中文回复，代码原文
EOF
```

内置默认（`DEFAULT_INJECT`）是一页纸的版本：身份 + 5 条行为准则 + 工具速查 + 输出格式。
正文多长不影响正确性，只影响省下的量 —— 想更省就写更短，但别把工具用法删到模型认不出。

---

## 云端隔离

三重保证，`test/autodetect.mjs` 和 `test/selfcheck.mjs` 都覆盖了：

1. **工具面**：未命中路由时 `release(agent)` 撤销该 agent 的全部限制（`restrict 调用次数: 0`）。
2. **提示词面**：`trimAssembly` 未命中时直接 `return assembly` —— **同一个对象引用**，
   不新建、不原地改。
3. **注入面**：接管后的 `assembleWithLocalTrim` 里 provider 判定不命中就直接返回下游结果。
4. 唯一的全局副作用是重新定义了 `prompt.assemble` 的访问器，但它的行为对非本地 provider
   完全等价于原函数。

实测：`workbuddy`（云端）和 `local-qwen`（本地）交替调用，云端返回正常、本地工具调用正常。

---

## 启动自检

插件装载时往 `~/.dsh/local-llm/local-trim.log` 写 9 项检查。下面是形态示例，数字取自
某一份具体配置（你的会不一样，`<…>` 处随配置变化）：

```
✓ tools 服务          可 restrict
✓ systemPrompt 服务   可用
✓ dsh-purge           已装（本插件在其外层收尾，无需改它源码）
✓ assemble 接管       accessor+purge-slot
✓ 轻量注入正文        <字符数>，来源 ~/.dsh/local-llm/light-inject.md
✓ 工具白名单          <keep 项数> 项
✓ 裁剪段落            <dropSections 项数> 段 + <dropContexts 项数> 个 context
✓ 生效路由            自动识别（baseURL 指向回环/私有网段，或 provider 名带 local/ollama 等标记）
✓ schema 瘦身         description 140 / 参数 90
就绪：仅对 本地端点（自动识别） 生效，其它 provider 原样放行
```

想关掉：`config.selfCheck: false`。

---

## 验证裁剪真的生效了

llama.cpp 加 `--log-prompts-dir` 会把每次请求落盘：

```bash
llama-server ... --log-prompts-dir ~/.dsh/local-llm/prompts
```

```bash
cd ~/.dsh/local-llm/prompts
f=$(ls -t *.txt | head -1)
echo "SIZE=$(stat -c%s $f)"
for k in "LOCAL LIGHT" "PRIME DIRECTIVE" "Mindmap editing"; do
  printf "%-20s %s\n" "$k:" "$(grep -c "$k" $f)"
done
```

期望：`LOCAL LIGHT: 1`、`PRIME DIRECTIVE: 0`、`Mindmap editing: 0`。`SIZE` 跟你自己的
配置有关，不看绝对值，看的是「注入换成了轻量版、那些大段不再出现」。如果 `PRIME DIRECTIVE: 1`
说明注入被外层重写覆盖了 —— 检查 `local-trim.log` 里的 `assemble 接管` 那一行。

---

## 五个踩过的坑

1. **`tools.restrict({ allow })` 只认全局工具名。** scoped 注册名（如 `dsh-ops` 的 `ops_glob`）
   混进 allow 会让**整批**校验失败，一条限制都装不上。本插件从错误消息里把被拒的名字抠出来
   记住，下一轮跳过 —— 比依赖 `view()` 私有字段跨版本安全。

2. **cordis 的 waterfall `next()` 不收参数。** 下游拿到的是最初那份 `args`，所以裁剪必须在
   `await next()` 之后对返回值做。

3. **别和 dsh-purge 的 400ms 心跳抢 `slot.rewrite`。** 它每 400ms 用 `bindSlot` 覆盖一次，
   反向重挂永远输在时序上。正确做法是接管 `prompt.assemble` 访问器并在 getter 上**转发**
   `Symbol.for('dsh-purge.assembleGuard')`，让它只刷自己的 slot、不重装访问器覆盖你。

4. **注入段必须 `interpolate: false`，并且保留头 80 / 尾 96 字符。** 否则
   `renderPrompt` 会用变量改写正文，破坏宿主取样判定，整份原文立刻被重新前置。

5. **`llm-pi-ai` 改 `defaultContextWindow` 要重启实例。** HMR 不覆盖 provider 解析，
   改了不重启的话 bili / 代理层拿到的还是旧窗口。

---

## 已知边界

- 只做本进程内的裁剪，不碰模型权重，不改任何第三方插件源码。
- `dsh-purge` 未安装时也能工作（接管原生 `prompt.assemble`），只是没有头 80 / 尾 96 的
  保留逻辑（没有那层兜底就不需要）。
- 段名来自各插件的 `systemPrompt.section({ name })`，插件升级改段名后要在 `dropSections` 里同步。
- `--cache-type-k/v q8_0` 这类 llama.cpp 侧优化不在本插件范围内。

---

## 开发

```bash
node --check lib/index.js       # 语法
node test/selfcheck.mjs         # 两个场景：装了 / 没装 dsh-purge
node test/autodetect.mjs        # 四个本地后端 + 三个云端 provider 的路由判定
```

`scripts/restore-bash.ps1` 修 pnpm 把 `@dsh-ops/bash-win32-x64` 当不匹配平台剪掉的问题
（arm64 Windows 上会遇到）：重新 pack 该可选依赖并放回 `node_modules/@dsh-ops/`。

## License

MIT
