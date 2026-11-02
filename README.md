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

## 控制面板（v0.3.0 起）

插件在 DSH Web 的**插件详情页**里挂了一块面板：左侧栏进「插件」，列表里点开
`dsh-local-trim`，详情页底部就是它。面板直接读写这份 profile 的
`cordis.patch.yml` 里 `local-tool-trim.config` 那一节，改完点保存即生效，不用重启。

面板能改的东西：

| 字段 | 作用 |
| --- | --- |
| 启用裁剪 / 按 baseURL 自动识别 | 总开关与 provider 识别方式 |
| 裁剪系统提示词 / 瘦身工具 schema | 第 3、4 层各自的总开关 |
| 工具描述上限 / 参数描述上限 | 第 4 层的两个阈值，0 表示不截断 |
| 生效路由 | 只裁这些 provider（空行=自动识别，写名字=只认名字） |
| 保留的工具 / 丢弃的提示词段 / 丢弃的 context | 三个白/黑名单，每行一项 |
| 启动时打印自检 / 包装器体积日志 | `selfCheck` / `debugWrap` |

面板底部还有两个按钮：**探测本地端点**（依次打 `8090` / `11434` / `8000` / `1234`，
列出可用端点与模型）和**看日志**（读 `~/.dsh/local-llm/local-trim.log` 的尾部，
不用去翻文件）。右上角显示当前 `revision`；如果这份配置在别处被改过，保存会提示冲突并
自动重新读取。

面板走的是插件自建的 HTTP bridge，前缀 `/api/dsh-local-trim`，四个端点
`describe` / `save` / `probe` / `log`，全部只接受 POST，且只放行本机来源
（`sec-fetch-site: cross-site` 直接 403，`Origin` 必须与 Host 同源）。

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
node test/provision.mjs         # 探测 → 写 settings 的一步到位
```

`lib/config.js` 顶层 `import z from '@deepseek-ai/schemastery'` —— 运行时由 DSH 宿主提供
（`peerDependencies`，optional，不会再给装插件的人拉第二份副本），跑测试前需要
`npm ci`（它同时也写在 `devDependencies` 里）。CI 就是这么做的。

`scripts/restore-bash.ps1` 修 pnpm 把 `@dsh-ops/bash-win32-x64` 当不匹配平台剪掉的问题
（arm64 Windows 上会遇到）：重新 pack 该可选依赖并放回 `node_modules/@dsh-ops/`。

## License

MIT
