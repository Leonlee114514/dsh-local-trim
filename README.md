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

### 一步到位（v0.2.0 起）

不想手写 `llm-pi-ai` 的 baseURL / 窗口 / 模型列表：插件启动时会自己探测本地端点，
探到能连上的就把 provider 写进你的 `cordis.patch.yml`（持久化，重启还在），
新 provider 立刻可选用，不需要重启 DSH。

```yaml
- insert:
    - id: local-tool-trim
      name: dsh-local-trim
      inject: [ tools, systemPrompt ]
      config:
        provision: true     # 或写成对象，见下
```

`provision` 三态：

| 写法 | 行为 |
| --- | --- |
| `false` | 完全不探测，插件只做裁剪 |
| `true`（或不写） | 按顺序探 `8090`(llama.cpp) → `11434`(Ollama) → `8000`(vLLM) → `1234`(LM Studio)，命中第一个可用的 |
| `{ endpoint: 'http://host:port/v1' }` | 只探这一个地址 |
| `{ endpoints: [...], provider: 'my-local', overwrite: true }` | 自定义列表 / 名字 / 是否覆盖同名配置 |

行为约定：

- **已有可用的本地 provider 就完全不写入** —— 你手写的 `local-qwen` 不会被覆盖。
- provider id 按端口推断：`8090 → local-llamacpp`、`11434 → local-ollama`、
  `8000 → local-vllm`、`1234 → local-lmstudio`；可用 `provider:` 指定。
- 窗口 / 输出长度从后端的 `/v1/models` 的 `meta.n_ctx`、`meta.n_predict` 读；
  读不到就退回保守值。
- 自动生成的 profile 带三样东西，少一样都可能拿不到回答：
  1. `compat.thinkingFormat: 'chat-template'` +
     `compat.chatTemplateKwargs.enable_thinking: false` —— 本地 chat template
     默认开思考模式，`max_tokens` 会全花在 `reasoning_content` 上、`content`
     返回空串。但 pi-ai 只在 `thinkingFormat` 是 `chat-template` 一类的分支里
     才把 `chatTemplateKwargs` 翻成请求体的 `chat_template_kwargs`；默认的
     `openai` 分支不翻，写了也发不出去。（`qwen` 分支发的是顶层
     `enable_thinking`，llama.cpp 不认。）
  2. 模型上的 `reasoningEfforts: { off: null, low: low }` —— 上面那个分支的前提
     是 `model.reasoning === true`，而它由这个字段推出来。
  3. `apiKeyEnv` —— 本地端点不校验 key，但 provider 没有 credential 声明时
     pi-ai 不带 `Authorization` 头，llama.cpp 会**静默返回空 completion**
     （不是 401，非常难查）。默认指向 `DSH_LOCAL_LLM_API_KEY`，值为空也行。

  不需要关思考就在 `provision` 里写 `chatTemplateKwargs: null`。
- 探测与写入失败都不会影响裁剪，把原因写进日志（默认
  `~/.dsh/local-llm/local-trim.log`，可用 `DSH_LOCAL_TRIM_LOG` 改位置）。

> 插件**热重载**期间写配置会被 HMR 事务拒绝（`HMR transactions cannot be nested`）。
> 这时插件会记下待办，等下一个真实请求（`agent/created`）再写 —— 不需要你做什么。
> 冷启动（装完插件重启 DSH）时第一次就成功。

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
| 不写 | 早期默认：只认 `local-qwen` 这一个名字（建议显式写 `[]` 或写具体名字） |
| `[]` | **自动识别**：provider 的 baseURL 指向回环/私有网段，或 provider 名带 local/ollama/vllm/lmstudio 等标记 |
| `[my-provider, ollama]` | 只认写出来的名字（精确匹配，`my-provider-turbo` 不会命中） |

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
      my-local:                       # provider id 自己定，带 local 标记会被自动识别
        displayName: 本地 llama.cpp
        apiKeyEnv: DSH_LOCAL_LLM_API_KEY  # 见上文第 3 点：缺了会静默返回空串
        api: openai-completions
        baseURL: http://127.0.0.1:8090/v1
        defaultContextWindow: 65536     # 必须和 -c 一致
        defaultMaxTokens: 8192          # 必须和 --n-predict 一致
        timeoutMs: 1800000
        streamIdleTimeoutMs: 600000
        compat:
          supportsUsageInStreaming: true
          maxTokensField: max_tokens
          thinkingFormat: chat-template   # 见上文第 1 点：不写这一行，下面白写
          chatTemplateKwargs:
            enable_thinking: false
        models:
          - id: my-local
            reasoningEfforts: { off: null, low: low }   # 见上文第 2 点
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
        provision: true      # 探测本地端点并自动写 provider；false 关闭

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

        # 白名单同时写规范名和 dsh-ops 的 ops_* 名：不同 profile 装的工具包不一样，
        # 有的注册 bash/read/glob/grep，有的注册 ops_bash/ops_read_files/…，
        # 两种名字都列上，这份配置就能同时用在两种 profile 上。
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

实测：同一个会话里交替切云端 provider 和本地 provider，云端返回正常、本地工具调用正常，
两边的工具面互不影响。

---

## 控制面板（v0.3.0 起，v0.4.0 改版）

插件在 DSH Web 的**插件详情页**里挂了一块面板：左侧栏进「插件」，列表里点开
`dsh-local-trim`，详情页底部就是它。面板直接读写这份 profile 的
`cordis.patch.yml` 里 `local-tool-trim.config` 那一节，改完点保存即生效，不用重启。

v0.4.0 起版面按「先看状态，再动手」重排，从上到下五块：

**① 状态带** —— 一行徽章，每枚带颜色灯：

| 徽章 | 含义 |
| --- | --- |
| 接管 prompt.assemble | 生效方式（叠在 dsh-purge 外层 / 叠在既有访问器外层 / 接管原生），失败时直接把原因写在这里 |
| 注入正文 | 一页纸注入有多少字符、来源是 `config` / `light-inject.md` / 内置 |
| 一步到位 | 自动注册 provider 的结果 |
| 提示词裁剪 / schema 瘦身 | 两层各自的开关状态 |
| 设置可写 | 宿主有没有把本插件登记成可写设置条目 |

**② 裁剪收益条** —— 最近一次装配的进→出字符数、省了百分之几、段数变化、命中的 provider
和时间。走云端 provider 时这里会显示「未裁剪」，那是正常的：云端一个字节都不动。

**③ 模型 provider 表** —— 列出 settings 里所有 provider，本地的一个个点灯
（`GET /v1/models`，15 秒内复用结果，多路并发不串行），显示在线耗时或错误原文；每个本地
provider 后面有 **试跑** 按钮，发一条「只回一个字：好」的真实请求，回来显示毫秒数与回复内容。
**拉起** 按钮会在这台机器上找后端并起一个脱离宿主的进程；如果那个端口上确实有本插件
拉起的进程，还会多一个 **停止** 按钮（`SIGTERM` → 赖着不走再 `SIGKILL`）。
别人的 `ollama serve` 不会被这里点掉 —— 服务端只肯停自己 `spawn` 过、且登记在内存表里的 pid。

每个 provider 后面还有一个 **删除**（v0.4.4 起）——**删的是这条 provider 配置，不是磁盘上的
gguf**。想清掉的就是那种僵尸：指向一个从没起来过的端口、或者同一个端口注册了两遍、或者你
早就删了模型文件的那几条。

- 第一次点只进入「确认删除？」态，再点才真删；点别的行会撤回确认。
- 走 `settings.mutate(ns, [{ op: 'unset', path: ['providers', id] }], revision)` ——
  **不是** `update`。`update` 走的是 `mergeLayers`，往 `providers[id]` 里写 `null` 只会留下
  一个 `null` 的 provider 键，`llm-pi-ai` 的 loader 见到会当成配置错误而不是「没有这一条」。
  只有 `mutate` 的 `unset` 内部是 `Reflect.deleteProperty`，才是真删。
- **继承来的删不掉**：如果这条 provider 来自下层（profile 的 `cordis.patch.yml` 或 home
  patch），`mutate` 的 `unset` 会把下层的值原样 set 回来 —— 表现出来就是「调用成功了但配置
  还在」。所以删完会**回读一次**确认，还在就直说「这条来自下层配置，得改那个文件」，不谎报
  成功。
- 老版本 DSH 的 `settings` 服务没有 `mutate()` 时也会明说，而不是假装删掉了。
- 删成功会清掉在线缓存与 baseURL 缓存，然后重新拉一次状态；**磁盘上的模型文件一个字节都不
  动**，随时可以重新导入。

**④ 本机模型 · 一键配置**（v0.3.9 起，v0.4.0 加资源预检，v0.4.1 改判据，v0.4.5 认 Ollama，v0.4.6 读 GGUF 真名，v0.4.7 试跑超时可配且冷加载自动重试，v0.4.8 端口跟着文件走，v0.4.9 修面板被渲染期异常整块吞掉）—— 上一块要求你先有端点，可刚下完模型的
时候服务还不存在。这一块把顺序倒过来：**扫描本机 → 选一个模型 → 一键配置并试跑**。

点「扫描本机模型」后插件按 `modelRoots()` 的顺序找权重（每层最多下探两级，跳过
`.mmproj.` 视觉投影，按文件大小降序，大的排前面）。**认权重不只看后缀**：`.gguf` 直接算，
没有后缀的较大文件（默认 ≥8MB，最多读 600 个）再读前 4 个字节验 `GGUF` 魔数 —— Ollama
把权重存成 `blobs/sha256-<64 位哈希>`，只看后缀永远扫不到它：

```
$DSH_LOCAL_MODELS_DIR                ← 你自己指定的目录，排最前
~/models/files
~/llama.cpp/models
~/.cache/llama.cpp
~/.lmstudio/models
<dataDir>/LM-Studio/models           ← Win: %LOCALAPPDATA% / mac: ~/Library/Application Support
~/.workbuddy/local-models/files      ← WorkBuddy 下载目录（兼容保留）
~/AI/models
~/Downloads                          ← 只扫一层
```

**另外单独走一趟 Ollama 存储**（`scanOllamaModels`）：`OLLAMA_MODELS` 环境变量排最前，
然后是 Windows `~/AI/models/ollama`、`%LOCALAPPDATA%\ollama\models`、`~/.ollama/models`，
macOS `~/.ollama/models`、`/usr/share/ollama/.ollama/models`，Linux 再加
`/usr/lib/ollama/models`、`/opt/ollama/models`。不是去 `blobs` 里猜哪些文件是权重 ——
**读 `manifests/` 与 `manifests-v2/`，只取 `mediaType` 为 `application/vnd.ollama.image.model`
的那一层**，再拿它的 digest 指回 `blobs/sha256-…`。这样得到的名字是人话：
路径 `<host>/<ns>/<name>/<tag>` 还原成 `qwen3:14b`（`latest` 不加冒号），一个 blob 被多个
tag 引用时合并成一条、`tags` 列出全部；`<root>/metadata/sha256-….json` 的 kv 再补上
`general.name`、`general.file_type`（→ 量化标签，按 ggml 枚举原值，15 = `Q4_K_M`）和
`context_length`。同一份文件被硬链接/同一个 inode 命中两次时按 inode 去重，谁有名字留谁。

扫出来的不是一个下拉框，而是一张表：每个模型一行，点名字选中。

**名字来自文件本身，不是文件名**（v0.4.6）：有些工具（WorkBuddy、部分下载脚本）会把任何
权重都存成一个固定的通用名，同一台机器换个模型还是那个名字，光看文件分不出是哪个、也看不
出量化。所以扫描时还会**读一遍 GGUF 头部的 KV 区**（按体积降序取前 40 个文件，跳过视觉投
影），从中取出真名，面板上的显示名优先级是：Ollama 的 tag → `general.basename` +
`general.size_label` 拼出来的紧凑名 → `general.name` 整串 → 文件名；整串（发行方常常在里
面塞版本号、迭代号这类内部编号）放进悬停详情。同时带出量化标签（`general.file_type`，按
ggml 枚举原值算）和 `context_length`。

读这块 KV 区不能整块读头部：`tokenizer.ggml.tokens`（24.8 万条字符串）和
`tokenizer.chat_template` 会把窗口占满，把后面的 `general.file_type` 截掉。做法是
**读与跳分账** —— 键名与类型必读，超过 256KB 的字符串值、字符串数组只走位（不复制 token
文本），游标越界立刻停（越界说明游标已经错了），半途超预算就返回已经拿到的键。注意 GGUF 的
字符串数组是**交错存储**（每条 `u64 长度 + 载荷`），按「长度表」连续跳会把载荷首字节当成
下一条长度，算出天文数字 —— 那不是文件太大，是游标错了。

Ollama 的模型显示 tag 并带一个 `Ollama` 徽标和量化标签，后面是它的体积，超过可用预算的会标红「偏大」。
**这里没有删除键** —— 权重文件是磁盘上的既有文件，插件不
替你删（想清盘自己删，或用 `DSH_LOCAL_MODELS_DIR` 把它移出扫描范围）。

> 视觉投影 `mmproj` 也列出来，但点它不会选中、也不能当主模型起服务。

选中一个模型后填端口（默认 8090；**选中 Ollama 的模型时自动跟到 11434，选中普通 `.gguf`
时改回 8090** —— 端口跟着文件走，不跟着上一次点了什么走。v0.4.8 前只做了前半段，于是
「先点 Ollama 的模型、再点普通 `.gguf`」会把 11434 带过去，插件探到 Ollama 在应答就直接
借它的端口，注册出一个你从没点过的模型）和上下文（默认 65536），点**一键配置并试跑**，
一条链走完三件事：

1. **先做资源预检**：算的是 **显存装不下的那部分**（`sizeBytes − gpuBytes`）比内存预算
   （`max(totalmem − 2GB, freemem)`）。为什么不拿 gguf 全长去比内存 —— gguf 走 mmap 读，
   落在**可回收的 file-backed page cache** 里，不是常驻匿名内存。这台机器实测就说明了这点：
   16.9GB 的 gguf 跑着，进程 WorkingSet 才 285–691MB，显存 14289/14848MiB 打满，
   系统还剩 2.2GB 可用，任务管理器不爆、不换页。
   - **显存 + 内存都装不下** → `risky`，唯一的硬拦。那不是慢，是必然加载失败；
   - 显存外的部分超过内存预算但走 mmap → `warn`，照起。只是开头一段明显慢
     （专家按需从盘里换进来）；
   - 同样装不下但用了 `--load-mode none` / `mlock`（不走 mmap，要真驻留 RAM）→ `risky`，
     这时候才可能换页卡死；
   - 拿不到体积 → `unknown`，不假装通过也不假装危险。
2. **分两条路**：
   - 选中的是 **Ollama 的模型**（在 manifest 里认出了 tag）→ **不去起 `llama-server`**。
     那个 blob 虽然本身是合法 GGUF，但把它硬喂给 llama.cpp 等于绕过 Ollama 再吃一遍内存，
     而且丢掉 `ollama run` 的全部上下文。插件只做一件事：确认 `11434` 有 ollama 在应答
     （没有就按已知后端起 `ollama serve`），然后把 **tag 当模型 id** 交给下一步；
   - 选中的是普通 `.gguf` → 用这个文件起 `llama-server`（自动找 `~/.workbuddy/local-models/bin/`
     下最新的 build，参数带 `--n-gpu-layers auto --fit on --jinja --cache-type-k/v q8_0`）；
     端口上已经有服务在应答就跳过拉起，不重复起；
3. 等 `GET /v1/models` 真应答，**以它报的模型 id 为准**（不是文件名 —— 端口 11434 上报的是
   `qwen3:14b` 这种 tag，拿 blob 的 `sha256-…` 去匹配永远匹配不上）；
4. 复用「导入」的注册逻辑写进 `llm-pi-ai`（Ollama 那条会注册成 `local-ollama-<slug>`），
   然后发一条真实请求试跑。

选完模型后「保留思考模式」旁边还有一个 **加载方式** 下拉（`--load-mode`），默认留空：

| 值 | 含义 | 什么时候选 |
| --- | --- | --- |
| 留空 | 交给 llama.cpp 自己决定（auto） | 默认。它会挑最合适的方式 |
| `mmap` | 分页读盘，权重落在可回收的 page cache | 内存不宽裕时最稳 |
| `none` | 全量读进匿名内存 | 内存富余、不想让盘参与 |
| `mlock` | 锁页，不许换出 | 要求时序稳定、且内存确定够 |
| `mmap+mlock` | 分页读 + 锁页 | 少数场景，一般不用 |

注意 `--no-mmap` 这个参数 b11012 **不认**（`error: invalid argument`），所以插件从不拼它。

失败时面板会说卡在哪一步：`precheck`（资源预检拦住）/ `launch`（起不来，带查过的路径）/
`probe`（起来了但没报模型）/ `register`（写 settings 被拒）。拉起后端口超时不应答的话，
插件会**把刚起的进程回收掉**，不留孤儿。别自己猜。

> **别把 MoE 的冷启动当成卡死。** 27.2B MoE（8/192 专家激活）在这台机器上实测：
> 前 1000–2000 token 是预热期（20 → 28 → 36 tok/s），之后**恒定 76 tok/s**
> （prose 75.5 / 计数 76.2 / 代码 71.9），prefill 3215 token 跑到 674 tok/s，
> 预热完 IO Read 归零。所以「17GB 就该卡」是错的判断 —— 判断依据是显存装不装得下，
> 不是文件大小。
>
> v0.4.0 曾拿 gguf 全长比内存，把这台机器判成 `risky` 并自动加 `--no-mmap`；
> 而 b11012 根本不认这个参数（`error: invalid argument: --no-mmap`），
> 等于一点「一键配置」必然起不来。v0.4.1 全部改成 `--load-mode auto|none|mmap|mlock|mmap+mlock`。

**⑤ 导入本地模型** —— 填端点（例如 `http://127.0.0.1:8090`，`/v1` 可省）→ **探测** →
下拉里选一个模型 → **导入并试跑**。导入做四件事：

1. `GET /v1/models`（不通用时退 `/api/tags`）拿到模型列表；
2. 按端口猜后端名，生成 provider id（`local-llamacpp-qwen3-4b` 这种），也可以自己填；
3. 写进 `llm-pi-ai` 的 `providers`，模型选好后在「模型」选择器里立刻能选到；
4. 立刻发一条真实请求，把端到端耗时、回复内容、token 数（或后端原文错误）贴在面板上。

试跑失败不会回收配置 —— 配置已经落地，把后端拉起或改好端点后点「试跑」即可，不用重新导入。
默认会关掉 chat template 的思考模式（`enable_thinking: false`）：本地小模型开了思考会把
`max_tokens` 全花在 reasoning 上、`content` 直接空字符串。需要思考的模型勾上「保留思考模式」。

原来那些字段（开关、阈值、三个名单、注入正文、一步到位）都在最下面折叠的
**高级配置** 里，位置变了，能力没变。

**⑥ 一键拉起（v0.3.4 起，v0.3.7 会自己捡模型，v0.4.0 能停，v0.4.1 认 --load-mode）** —— provider 表里每个**本地 provider**
后面都多一个 **拉起** 按钮。点它就按这个 provider 的端口去找后端并起起来，然后轮询等它应答：

| 端口 | 后端 | 怎么起 |
| --- | --- | --- |
| 11434 | Ollama | 找到 `ollama(.exe)` 后 `serve`，并带上 `OLLAMA_HOST=127.0.0.1:11434` |
| 8090 | llama.cpp | 先找 `llama-server`，再按 `modelRoots()` 的顺序捡现成的 gguf，**参数自己拼** |
| 8000 | vLLM | 要 `--model`（HF 目录或仓库 id），插件不猜 —— 高级配置里填完整命令 |
| 1234 | LM Studio | `lms server start --port 1234`（不需要先指定模型，模型是运行时按请求加载的） |

llama.cpp 这一条是 v0.3.7 的重点：模型已经下好了就别让人再下一次 20GB。插件按这个顺序找

1. `llama-server`（Windows 补 `.exe`）：`LLAMA_SERVER_BIN` → `~/.workbuddy/local-models/bin/<build>/`
   （WorkBuddy 的布局，取最新 build）→ `~/AI/llama.cpp/`（Windows）/ Homebrew 与 `/usr/local/bin`（macOS、Linux）
   → PATH；
2. 权重：按 `modelRoots()` 的顺序找（`DSH_LOCAL_MODELS_DIR` → `~/models` → `~/llama.cpp/models`
   → `~/.cache/llama.cpp` → `~/.lmstudio/models` → `<dataDir>/LM-Studio/models` →
   `~/.workbuddy/local-models/files` → `~/Downloads`），第一个含权重的目录胜出；
   认权重同样看后缀**或**文件头魔数（Ollama 的 `sha256-…` blob 就是靠魔数认的）；
   同一目录里优先 `local_model.gguf`，跳过 `.mmproj.`（那是视觉投影）；
   这里**只按文件名挑**，不读 GGUF 里的真名（面板那条④才会读，见上文）；
   要指定自己的目录用 `DSH_LOCAL_MODELS_DIR` 或配置项 `modelDirs`；
   **注意这条只给「llama.cpp 自己捡模型」用。Ollama 的权重不走这里** —— 端口 11434 上
   该跑的是 `ollama serve`，模型名由 ollama 自己按 tag 提供（见④那条链的第 2 步）。
3. 拼参数（**新版 llama.cpp**）：`-m <gguf> --host 127.0.0.1 --port 8090 --alias <provider 的模型 id>
   --n-gpu-layers auto --fit on --parallel 1 --jinja --cache-type-k q8_0 --cache-type-v q8_0
   -c 65536 --n-predict 8192`。老版本（没有 `--fit`）会自动换一套：`--n-gpu-layers 99`，
   不下发 KV 量化，见「参数能力靠 `--help` 探测」一节。

这套参数是按 32GB 统一内存实测出来的：权重 17GB 上卡，q8_0 KV 单 slot 才压得住 64K 上下文。
**两个组件都找到才自动拼**；缺模型文件才回「需要模型文件才能起」，缺可执行文件才回「本机没找到」，
错误里带着查过的路径。

顺序是：**先探测**，端口本来就在应答就直接告诉你「没有重复拉起」；没应答才找可执行文件
（`OLLAMA_BIN` 环境变量 → 平台默认安装位置：Windows `~/AI/ollama/ollama.exe`、
`%LOCALAPPDATA%\Programs\Ollama\ollama.exe`、`C:\Program Files\Ollama\ollama.exe`；
macOS `/Applications/Ollama.app/...`、Homebrew `/opt/homebrew/bin`；Linux `/usr/local/bin`、
`/usr/bin`、`/snap/bin` → PATH），拉起后按 `拉起后等端口（秒）` 轮询
`/v1/models`，成功后顺手把点灯缓存清掉。

高级配置里的 **一键拉起命令** 留空就走上面的自动逻辑；填了（例如
`C:\Users\you\AI\ollama\ollama.exe serve --verbose`）就原样执行，优先于自动探测。
起进程用 `detached + stdio:ignore`，不挂在宿主进程的管道上，所以**关掉 DSH 不会把它带走**，
要开机自启得自己挂（Windows 计划任务或启动项）。

**停止**（v0.4.0 起）：进程起来了就得能关。provider 那一行如果在「本插件起过的端口」表里，
就会多一个红色 **停止** 按钮，点它走 `POST /api/dsh-local-trim/stop` → `SIGTERM`，
1.5 秒内不退再补 `SIGKILL`，还活着就如实报失败（不谎报成功）。
这张表只存在宿主内存里：**重启 DSH 之后表就空了**，此时那些进程要自己关
（`taskkill /PID <pid> /F`，pid 在面板「已拉起」提示和启动日志里都有）。

拉起后等端口的上限是 `拉起后等端口（秒）`，默认 20 秒，可设范围 3–600 秒 —— 超出会被夹回去。
17GB 权重冷加载实测 11.6 秒，接近默认上限；更慢的机器记得调大。
**超时不会留孤儿**：插件会把刚 spawn 的那个 pid 回收掉再报错。

端口通了不等于能出字：**第一次请求常常还在把权重读进内存**，比之后每次都慢得多。
「试跑」一轮请求的超时是 `试跑超时（秒）`，默认 60 秒，可设范围 5–600 秒（超出夹回）。
**超时不是直接报错**：会先用同一份请求自动再来一轮（冷加载第一次超时几乎总是这个原因），
两轮都超时才报错 —— 此时文案会说清「已自动重试一次」并指向这个配置项。
连不上、HTTP 报错这类非超时错误不重试，早点把原因给人看。

```yaml
smokeTimeout: 120
```

**端口落在别的引擎上会改口**（v0.4.8）：普通 `.gguf` 却被填成 Ollama 的 11434 / vLLM 的
8000 / LM Studio 的 1234 时，插件改用 8090（llama.cpp）并在结果里说明一句。只对**已知引擎
的端口**这么办 —— 你自己填个 9999 想喂另一台 llama-server，那是你的自由，照旧不抢。

**模型 id 对不上不瞎猜**：起了服务之后要拿一个模型 id 去注册 provider。名字对不上时，
只有列表里**恰好一个**模型才取它（单模型后端报的 id 本来就可能和文件名不同）；多个模型
对不上就直接报错并列出实际报的 id —— 「别猜一个用 —— 先确认这个文件喂给了正确的后端」。
v0.4.8 前这里会静默抓列表第一个，于是借错端口时会注册出一个你从没点过的模型。

**其他按钮**：**探测本地端点**（依次打 `8090` / `11434` / `8000` / `1234`）、**看日志**
（读 `~/.dsh/local-llm/local-trim.log` 尾部）、**重新检测**（强制刷新点灯结果）。
右上角显示当前 `revision`；这份配置在别处被改过时，保存会提示冲突并自动重新读取。

宿主里跑的还是旧代码时（只有 describe / save / probe / log 四条路由，没有 `status`），
面板不会整块报错：它自动退回 `describe` 视图，并在顶部提示「重启一次 DSH 就能看到点灯、
收益条和模型导入」。插件是 JS 模块，装在宿主进程里，改完源码要让宿主重新 apply 一次。

**面板整块不见、页面上只剩空白，宿主却一切正常**（v0.4.9 修的就是这个）：这说明面板在渲染
期抛了异常，被宿主的插槽错误边界就地接管了。宿主给每个 `plugins.detail.section` 条目包了
`SlotErrorBoundary`（`@deepseek-ai/dsh-client-ui-renderer`），`getDerivedStateFromError` 一旦
捕获就把整块换成一个空的 `<div data-slot-error="plugins.detail.section">` —— 不崩进程、不写
crash 日志，只往浏览器控制台打一行 `slot entry crashed in 'plugins.detail.section'`。
v0.4.8 就是这样：`portFor` 声明在 `AdoptBox` 里面，`Panel` 的 `scanModels` 却引用了它，点一次
「扫描本机模型」就在渲染期报 `ReferenceError`，整块面板当场消失。
**排查办法**：打开浏览器开发者工具的控制台，看有没有 `slot entry crashed in ...`；本地跑
`node test/client.mjs` 也能复现这类作用域错误（它自带最小 React 替身，真跑渲染、真执行
`setState` 的 updater）；`node --check` 对此完全无感，只有语法错才报。

面板走的是插件自建的 HTTP bridge，前缀 `/api/dsh-local-trim`，十三个端点
`describe` / `save` / `probe` / `log` / `status` / `check` / `import` / `test` / `launch` /
`stop` / `models` / `adopt` / `delete`，全部只接受 POST，且只放行本机来源
（`sec-fetch-site: cross-site` 直接 403，`Origin` 必须与 Host 同源）。

重活路由（除 `describe` / `save` / `log` 之外）带两层节流：同一个路由上一次还没跑完时
直接回「等它结束再来一次」，跑完之后 800ms 内再来也被挡（`bridgeThrottleMs` 可调，设 0 关掉
间隔限制、只留并发去重）。前端连点不会在宿主机上堆叠起一堆 `llama-server`。

### 保存报「被 home patch 覆盖」怎么办

如果这个插件的配置整段写在 profile 的 `cordis.patch.yml` 里（很多人是手写进去的），
`settings.update` 会要求「合成后的 config 与要写的完全一致」，而那段 patch 里还有
`routes` / `dropSections` 这些面板不负责的键 —— 于是整段写入被拒，面板会提示
`这份配置整段来自 profile 的 cordis.patch.yml（home patch 层），面板不能整段覆盖`。

两条路：① 直接改那个文件里 `local-tool-trim.config` 的对应键；② 把 patch 里这个插件的
`config:` 段删掉（只留 `id` / `name` / `inject`），重启后配置归 settings 管，面板就能改。
面板的**只读视图**（状态带、收益条、点灯、试跑、拉起）在两种情况下都能用。


### 面板不出现怎么办

先看日志末行是「控制面板 UI 已进入 client 条目表」还是「需要完整重启一次 DSH」。
宿主的 `dsh-client-modules` 会把每个包第一次扫描的结果缓存起来（`pkgMeta`），
插件热重载不会清这个缓存 —— 所以如果**先装插件、后补 `dsh.client` 声明**，只重载插件
不够，必须完整重启一次 DSH。插件自己会在装载时清掉本包那一项并触发重扫，正常情况下
一次重载就够；日志里说还需要重启时，重启即可。

---

## 启动自检
插件装载时往 `~/.dsh/local-llm/local-trim.log` 写 10 项检查。下面是形态示例，数字取自
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
✓ 一步到位            <探测结果，如「已有配置好的 local-llamacpp」>
控制面板 bridge 已挂载：/api/dsh-local-trim/{describe,save,probe,log}
控制面板 UI 已进入 client 条目表（刷新页面即可在插件详情页看到）
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
配置有关，不看绝对值，看的是「注入换成了轻量版、那些大段不再出现」。

如果 `PRIME DIRECTIVE: 1`，说明结果被某一层重写覆盖了。两步排查：

1. 看 `local-trim.log` 里最新的 `assemble 接管` 行。理想值是 `accessor+purge-slot`；
   出现 `already` 意味着外层是别的实例留下的包装器（见坑位 6）。
2. 在配置里临时打开 `debugWrap: true`，重载后再发一次请求，日志会多出成对的
   `包装器进入: N 段 / X 字符` 与 `包装器返回: M 段 / Y 字符`。如果「返回」的体积没有变小，
   是 `trimAssembly` 判定这条请求不属于本地 provider（看 `routes` / baseURL 是否被识别）；
   如果「进入」的体积本身就很小而请求很大，说明别的层在我们之后又灌了内容进来。

---

## 七个踩过的坑

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

6. **热重载会留下上一实例的包装器，不能看到标记就跳过。** 重载后旧实例的
   `prompt.assemble` 包装器还在最外层，但它的 `ctx` 已失效 —— provider 判断失效 → 它自己
   原样放行，而它内层仍会调 `dsh-purge` 把整份原文灌回去。所以接管时不能用全局布尔标记
   判断「已经装过」，要带一个 **每次 `apply` 都不同的实例 token**；发现外层是别人的包装器时
   **叠加**一层自己的，而不是放弃。进程重启后旧包装器自然消失，叠加的层数也就回到一。

7. **`.volatile()` 的配置字段不是值，是活引用。** 加上 `volatile()` 之后宿主传进
   `apply(ctx, config)` 的每个字段都是 `{ get(): T }`，`config.enabled !== false` 会永远为真
   （对象 !== false），裁剪开关直接失效。必须统一走一个 `resolveConfig(config)` 逐键 `.get()`，
   而且不能一次性解构成常量 —— 面板改了要能立刻生效，每次用时现读。

---

## 跨平台（v0.4.2 起）

v0.4.1 及以前这个插件只在本机（Windows ARM64 + 一张 N 卡 + WorkBuddy 的 llama.cpp 布局）
上验证过，代码里到处是 `C:/Users/<USER>/...` 这种硬编码。换台机器大概率表现为
「扫不到模型 / 找不到二进制 / 一拉起就报参数错」。v0.4.2 把这些都换成了可推导的规则。

### 支持矩阵

CI 在 `ubuntu-latest`（Node 20/22/24）、`windows-latest`、`macos-latest` 上各跑一遍，
所以这张表不是声明，是每次提交都在验的东西。

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 用户目录 / 数据目录 | `%USERPROFILE%` / `%LOCALAPPDATA%` | `~` / `~/Library/Application Support` | `~` / `$XDG_DATA_HOME` |
| 找 ollama | 用户目录安装 + `Program Files` + PATH | `.app` 包内 + Homebrew + PATH | `/usr/local/bin`、`/usr/bin`、`/snap/bin` + PATH |
| 找 llama-server | WorkBuddy build + 用户目录 + PATH（补 `.exe`） | Homebrew + `/usr/local/bin` + PATH | 同 macOS |
| 找 vLLM / LM Studio | `LM-Studio/lms.exe`、`Program Files` + PATH | `.app` 包内 + PATH | `/usr/local/bin` + PATH |
| 扫权重 | `~/models`、`~/AI/models`、`~/Downloads`… + Ollama 存储（含 `%LOCALAPPDATA%\ollama\models`） | `~/models`、`~/llama.cpp/models`、`~/.cache/llama.cpp`… + `~/.ollama/models`、`/usr/share/ollama/.ollama/models` | 同 macOS，另加 LM Studio 数据目录、`/usr/lib/ollama/models`、`/opt/ollama/models` |
| 显存探测 | `nvidia-smi`（在 system32，靠 PATH） | `nvidia-smi` / `rocm-smi` / `sysctl hw.memsize` | `nvidia-smi` / `rocm-smi` |
| 拉起 / 停止进程 | 支持（`spawn` + signal 0 探测） | 支持 | 支持 |

### 认自己的模型目录

内建目录覆盖三平台的常规位置（完整清单用面板上的「扫描本机模型」看，接口返回的 `dirs`
就是实际扫过的路径）。模型不在常规位置时，两条路：

1. 环境变量（优先级最高，排在最前）：

   ```bash
   # bash / zsh
   export DSH_LOCAL_MODELS_DIR=/mnt/weights/gguf
   ```

   ```powershell
   # PowerShell（用户级，永久）
   [Environment]::SetEnvironmentVariable('DSH_LOCAL_MODELS_DIR', 'D:\models', 'User')
   ```

2. 配置项 `modelDirs`（数组，支持 `~`），和上面那个环境变量同时存在时都会扫：

   ```yaml
   modelDirs:
     - ~/gguf
     - /data/weights
   ```

3. Ollama 的存储单独一条环境变量：`OLLAMA_MODELS`。装了 ollama 的人经常把它指到大盘
   （`D:\ollama-models` 这类），插件读它并**排到 Ollama 候选最前**，指哪儿扫哪儿；没设就
   按上表那些标准位置挨个试。判定标准是「这个目录长得像 ollama 库吗」—— 底下必须有
   `manifests` / `manifests-v2` / `blobs`，只是一个普通同名目录不会被当成库。

### 认自己的后端二进制

四个后端各有一个覆盖变量，指定后直接排到候选表最前，不再猜：

| 变量 | 作用 |
| --- | --- |
| `OLLAMA_BIN` | `ollama` 可执行文件的完整路径 |
| `LLAMA_SERVER_BIN` | `llama-server` 的完整路径（自编译 / 非标准位置） |
| `VLLM_BIN` | `vllm` 的完整路径（conda / venv 里的那个） |
| `LMSTUDIO_BIN` | `lms` CLI 的完整路径 |

### 参数能力靠 `--help` 探测，不靠版本号猜

llama.cpp 的参数是逐版演进的：`--load-mode` 和 `--fit` 是近几版才有的，老版本没有；
反过来 `--no-mmap` 在新版本里已经被 `--load-mode` 取代（传进去直接
`error: invalid argument`）。所以插件在拼命令行之前会先跑一次
`llama-server --help`，把输出里出现的 `--flag` 全抠出来，只拼它真认的那几个：

- 探到了 → 只留白名单里的；被裁掉的参数名会出现在 `planLaunch` 返回的 `dropped` 数组里，
  面板会告诉你「你的 llama.cpp 不认 `--fit`，已跳过」。
  短参数（`-c` / `-m` / `-t`）也一并收 —— `-c` 是 `--ctx-size` 的短写，只认长参数的话
  `-c 65536` 会被判成不支持而整条裁掉，上下文悄悄退回引擎默认值（本机就这么丢过一次）。
- 探不出来（命令不存在、超时、输出为空）→ **不裁剪**，按旧行为全给。宁可让引擎自己报错，
  也不要因为探测失败把好参数丢掉。
- 结果按二进制路径缓存，同一个 `llama-server` 只跑一次 `--help`。

**flag 在、取值不一定在。** `--n-gpu-layers auto` 的 `auto` 是和 `--fit` 同一代加的；
老引擎只认数字。所以拼参数时按 `--fit` 有无分两套：

| 能力 | 有 `--fit`（新引擎） | 无 `--fit`（老引擎） |
| --- | --- | --- |
| `--n-gpu-layers` | `auto` | `99` |
| `--cache-type-k/v` | `q8_0` | 不下发（老版本类型表窄） |
| `--fit on` | 下发 | 不下发 |

`llamaCppAutoArgs` 的返回值里带 `modernEngine`，面板日志能看出走的是哪一套。

### 显存探测的三条路

`detectGpuInfo()` 依次尝试，谁先答上算谁：

1. **NVIDIA** — `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`，
   三个平台通用（Windows 上它在 `system32`，PATH 里有）。
2. **AMD** — `rocm-smi --showmeminfo vram`，认 `VRAM Total Memory (B): 17163091968`
   和 `VRAM Total Memory (B): 24.0 GiB` 两种写法。
3. **Apple Silicon** — 没有独立 VRAM，统一内存。取 `sysctl -n hw.memsize` 的**四分之一**
   作为「GPU 侧可用」的粗估，并标 `unified: true`（面板上会显示这是统一内存，不是真显存）。
4. 都没有（Intel 核显 / 无独显 / 容器里）→ 返回 0，预检退化成「不算显存」，不报错。

**统一内存要特殊处理。** Apple Silicon 的「显存」和内存是同一个池子，
`hostBytes = 模型 − 显存` 会凭空多出余量（24GB 的 Mac 装 16GB 模型会被算成只占 10GB）。
所以 `detectGpuInfo()` 对 Apple Silicon 返回 `unified: true`，预检见到它就按
`sizeBytes` 全额比 `totalMemBytes`，上限也只算一次。AMD 核显走的是独立 VRAM 路径，
不受这条影响。

### 预留内存可配

预检给系统留多少内存是 `reserveMb`（默认 2048 MiB）。桌面 Windows + 宿主 + 浏览器差不多
要这么多；Linux 服务器可以调到 1024，内存紧张的机器调大，`0` 表示不预留（只跟 free 比）。

```yaml
reserveMb: 1024
```

---

## 已知边界

- 只做本进程内的裁剪，不碰模型权重，不改任何第三方插件源码。
- `dsh-purge` 未安装时也能工作（接管原生 `prompt.assemble`），只是没有头 80 / 尾 96 的
  保留逻辑（没有那层兜底就不需要）。
- 段名来自各插件的 `systemPrompt.section({ name })`，插件升级改段名后要在 `dropSections` 里同步。
- llama.cpp 侧的调参只到「一键拉起时给一组能跑的默认值」（`--n-gpu-layers auto --fit on --cache-type-k/v q8_0`）；要换量化、换 KV cache 精度、限并发，改高级配置里的启动命令，插件不替你优化推理性能。
- **资源预检是估算，不是保证。** `checkModelFit` 用 `os.freemem()` / `os.totalmem()`、
  模型文件体积、以及探测到的显存总量做减法：`hostBytes = sizeBytes − gpuBytes`。
  显存探测按厂商分三条路（见「跨平台」一节）。这几个数都不精确（本机实测：32GB 机器
  Windows 只报 16.37GB 可见，其中 GPU 拿走 14.5GB；`freemem` 还把 page cache 算成已占用）。
  所以它只会**拦住明显起不来的**，不会替你算出真实占用。拿不到显存时退化成「不算显存」，
  不报错。判 `ok` 也不代表不会慢。
- **面板只能停自己起的进程。** `stop` 路由走一张内存表（`launched`），表里只有本插件
  `spawn` 过的 pid。宿重重启后这张表就空了，此时手动起的后端要自己关。

---

## 开发

```bash
npm run verify                  # = check + test，13 个文件语法 + 9 套测试
npm run check                   # 只跑 node --check（lib/*.js + client.js + test/ 里带平台/渲染逻辑的那几个）
npm test                        # 只跑测试（unit + portable + host）
npm run test:portable           # 只跑跨平台候选表推演（linux / darwin / win32 各一遍）
npm run test:sim                # 假装自己是 linux / darwin，把整套测试再跑一遍

node test/selfcheck.mjs         # 两个场景：装了 / 没装 dsh-purge
node test/autodetect.mjs        # 四个本地后端 + 三个云端 provider 的路由判定
node test/provision.mjs         # 探测 → 写 settings 的一步到位
node test/panel.mjs             # 面板视图模型 + 导入流程（离线，不起浏览器）
node test/client.mjs            # 真渲染 client.js（自带最小 React 替身），点「扫描本机模型」验面板不塌
node test/panel-host.mjs        # 真跑 apply()，假 settings / 假后端把 13 条 bridge 路由全打一遍（含一份现造的 Ollama 存储 fixture）
node test/launcher.mjs          # 一键拉起 + 扫本机权重（含 Ollama manifest 解析与 GGUF KV 真名）+ 资源预检 + 停进程（不真起进程）
node test/portable.mjs          # 路径推导 / 显存探测 / --help 能力探测（假 platform + 假 exec）
node test/platform-sim.mjs linux    # 假装自己是 Linux，验候选表不会吐 Windows 路径
node test/platform-sim.mjs darwin   # 同上，macOS
node test/platform-sim.mjs win32    # 同上，Windows（本机就是，但断言的是「全 .exe」）
node test/run-sim.mjs           # 上面那三套 + launcher / panel-host，按 linux + darwin 各一遍
node test/stranger.mjs          # 抹掉本机所有有利条件（无 GPU / 无模型 / 空 PATH）
```

`test/stranger.mjs` 是「别人第一次装」的等价物：清空 `PATH`、抹掉显卡、家目录里不放模型，
然后要求每一步都优雅退化 —— 显存读不到就是 0（不是 NaN），`--help` 探不到就不裁剪（不是全丢），
没有 gguf 就回 `no-model` 并列目录。本机什么都有，这些分支永远走不到。

`test/run-sim.mjs` 把同一招用到**整套**测试上：它用 `child_process` 起子进程并显式传
`DSH_SIM_PLATFORM`，而不是写 `DSH_SIM_PLATFORM=linux node …` —— 那种前缀语法只在
POSIX shell 成立，Windows 的 npm script 会直接报「不是内部或外部命令」。这一步存在的理由
很具体：`test/portable.mjs` 里曾断言 `endsWith("lms.exe")`，macOS runner 上
`exeName()` 不加后缀就红，而本机是 Windows，永远踩不到。

`test/platform-sim.mjs` 靠 `Object.defineProperty(process, "platform", …)` 在 import
之前改平台 —— `lib/launcher.js` 顶部的 `const WIN = process.platform === 'win32'` 是
import 时求值的，改掉之后整个模块都会按目标平台展开。

`os.homedir()` 也能骗，但有坑：真实 Windows 上它只读 `USERPROFILE`（删掉反而退回
真实家目录，`HOME` 根本不看），Linux/macOS 才读 `HOME`。一开始只改 `HOME`，模拟 darwin
时家目录仍是 `C:/Users/<你>`，候选表里混进一堆 `C:/...` —— 而那正是要抓的东西，等于
这套测试白跑。现在 `test/fake-platform.mjs` 把两个变量都指到 `/sim/nobody`，并且有三条
用例专门断言「家目录里没有本机真实路径」。剩下骗不到的只有 `process.env.PATH`、真实文件
系统和 `nvidia-smi`；把这三样也删掉的是 `test/stranger.mjs`。

`test/panel.mjs` 只测纯逻辑：`lib/status.js`（接管文案、收益计算、provider 判定与点灯计数）
和 `lib/import-model.js`（入参校验、provider id 生成、profile 拼装、试跑请求与四类失败分支，
全部用假 `fetch`）。

`test/panel-host.mjs` 是宿主侧集成：用一份内存 settings、一个假 `webServer`、一个假
llama.cpp（`/v1/models` + `/v1/chat/completions`）跑真的 `apply(ctx)`，让插件自己注册路由，
然后逐条断言 status / check / import / test / launch / stop / models / adopt / delete 的返回 ——
包括同源守卫 403、同名不覆盖、端点连不上、模型不在列表里、provider 不存在、
资源预检拦截、以及「只肯停自己起的进程」这几种路径。它不需要真起 DSH。

> 这份用例显式传 `bridgeThrottleMs: 0`：它是在几毫秒内连着打同一批重活路由的，
> 默认 800ms 间隔会把它们全挡掉。节流本身由最后几组用例单独验。

`test/client.mjs` 是唯一碰 `client.js` 的用例，也是唯一能抓住「渲染期炸掉」的用例。它用
一个最小 React 替身（`createElement` / `useState` / `useCallback` / `useEffect` / `useMemo` /
`useRef` / `class Component`）载入真的 `client.js`（走 `window.__ModuleLoader__.load`），
**真调函数组件、真在渲染期执行 `setState` 的 updater、真递归渲染出 DOM 树**，然后像用户那样
点「扫描本机模型」，断言面板还活着、自动选中的是最大的那个模型、端口回到了 8090。
数据用真机 `/status` 与 `/models` 的载荷回放（35B + 两个 Ollama tag + 一个 mmproj）。
v0.4.9 之前 `portFor` 声明在 `AdoptBox` 里却从 `Panel` 引用，`node --check` 报不出任何问题
（语法合法），只有这条回路会在那一行打出 `ReferenceError: portFor is not defined`。

`test/launcher.mjs` 覆盖一键拉起的纯逻辑：端口解析、命令行切分（认双引号）、
`whichOnPath` 补扩展名、四种后端的计划生成、找不到可执行文件与「需要模型参数」两条错误路径、
自定义命令优先、`runDetached` 的 `detached/stdio/env` 传参，以及 `waitForEndpoint` 的
命中与超时。`spawnImpl` 与 `probe` 全部注入，CI 上不会留下后台进程。

v0.3.9 起还覆盖 `scanLocalModels`（跳过 mmproj、按大小降序、目录下探）与「自选端口 +
指定 gguf」的拼装（端口和 alias 都得按用户填的走）。v0.4.0 补上了
`mergeEnv`（Windows 上 PATH / Path 大小写去重）、`envPathValue`、`checkModelFit`
（五档结论 + 显存外的 hostBytes + 拿不到体积时的 unknown）、`--load-mode` 白名单（`normalizeLoadMode` / `LOAD_MODES`）、`detectGpuBytes`、`stopProcess`
（SIGTERM → SIGKILL → 报失败，幂等）、`isProcessAlive`（EPERM 算活着），
以及扫描的三道上限（`maxModels` / `maxEntries` / Downloads 只扫一层）与 `truncated` 标记。

v0.4.4 补上 `unregisterProvider`（`lib/provision.js`）：删 provider 配置只能用 `mutate` 的
`unset`，所以用例分成三条 —— ① 真删（假 mutate 里 `Reflect.deleteProperty` 那套语义）、
② 幂等（删第二次回 `already: true`）、③ **继承来的删不掉**（假 `mutate` 什么都不做，回读
发现键还在 → 必须回 `removed: false, inherited: true`，并把原因指到下层 patch）。
还有「没有 `mutate()` 的老版本 DSH 要明说」「空 id 直接拒」「settings 缺失不抛」三条。
宿主侧（`test/panel-host.mjs` 第 20 组）额外断言**没走 `update` 写 null**、`unset` 的
`path` 恰好是 `['providers', <id>]`、以及别的 provider 一个没动。

`adopt` 的 `sizeBytes` / `gpuBytes` / `totalMemBytes` 可以从入参覆盖（非正数或省略就回落真实探测）。
CI 的 runner 上没有 `nvidia-smi`、内存也只有 15.6GB，不覆盖的话「能跑的机器不该被判 risky」
这条断言在 CI 上永远测不到 —— 它会一路走 `risky` 分支。生产路径不吃这三个参数。

本地不要为了验证去真起 17GB 的模型 —— `planLaunch` 已经把命令和参数摆出来了，看一眼就够；
真要端到端跑，挑个空闲时段。**别把冷启动当成卡死**：27.2B MoE 在这里实测预热
1000–2000 token 后稳定 76 tok/s（见上文「一键配置」下的说明）。

`lib/config.js` 顶层 `import z from '@deepseek-ai/schemastery'` —— 运行时由 DSH 宿主提供
（`peerDependencies`，optional，不会再给装插件的人拉第二份副本），跑测试前需要
`npm ci`（它同时也写在 `devDependencies` 里）。CI 就是这么做的。

`scripts/restore-bash.ps1` 修 pnpm 把 `@dsh-ops/bash-win32-x64` 当不匹配平台剪掉的问题
（arm64 Windows 上会遇到）：重新 pack 该可选依赖并放回 `node_modules/@dsh-ops/`。

## License

MIT
