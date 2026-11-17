# 变更记录

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号走 SemVer。
每条都写「为什么」而不只是「改了什么」—— 这个插件的坑大多来自 DSH 宿主的隐式约定，
不记下来下次还会踩。

## [0.5.6] - 2026-11-17

一句话：**判「这是不是本地端点」以前是拿正则 match 整串 URL，两个方向都在错 —— 其中一个是误判。**

### 误判（危险的那一侧）

`LOCAL_HOST_PATTERN` 是 `^https?://(?:127\.0\.0\.1|localhost|…)`，对整串 URL 做前缀匹配。
于是下面这些**公网地址**全被当成本地：

```
http://localhost.attacker.com/v1      → 命中 localhost
http://localhost-evil.com/v1          → 命中 localhost
http://127.0.0.1.attacker.com/v1      → 命中 127.0.0.1
http://localhost@attacker.com/v1      → 真实 host 是 attacker.com
```

后果不是「少裁一点」，而是**云端请求被裁掉七成提示词**（42K→9K、169 个工具→12 个、
schema 13.5K→10.6K），面板还高高兴兴显示「已裁剪 78%」。用户只会看到云端模型突然
不会调工具了，完全不知道是自己某条 baseURL 的域名前缀撞上了 `localhost`。

### 漏判（另一个方向）

只写了 `127.0.0.1`（不是 127/8）、没有 IPv6 ULA、没有 mDNS、没有 CGNAT：

| 地址 | 以前 | 现在 |
| --- | --- | --- |
| `127.0.0.2` / `127.1.2.3` | ✗ | ✓ |
| `100.101.102.103`（Tailscale） | ✗ | ✓ |
| `169.254.1.5`（链路本地） | ✗ | ✓ |
| `[fd00::5]` / `[fe80::1]` | ✗ | ✓ |
| `macbook.local`（mDNS） | ✗ | ✓ |
| `gpu-box`（单标签主机名） | ✗ | ✓ |

### 改法

`lib/status.js` 里改成**先 `new URL()` 解析出 hostname 再判**（新增 `hostOf` /
`looksLocalHost` / `looksLocalUrl` / `looksLocalName` 导出）：

- 回环整段 `127/8`、私有 `10/8` `192.168/16` `172.16–31/12`、链路本地 `169.254/16`、
  CGNAT `100.64/10`、`0/8`；
- IPv6 `::1` / `::`、ULA `fc00::/7`、链路本地 `fe80::/10`、IPv4-mapped `::ffff:x`；
- `host.docker.internal` / `host.containers.internal` / `gateway.docker.internal`；
- `.local` / `.internal` / `.localhost` 后缀，以及单标签主机名（公网 DNS 里不存在）。

`new URL()` 顺手解决 userinfo 那条：`http://localhost@attacker.com/v1` 解析出的
hostname 是 `attacker.com`，不是 `localhost`。

### 判定顺序也改了：有地址就以地址为准

以前 `isLocalProvider(id, baseURL)` 是「地址命中 **或** 名字命中」。`openrouter-llama-3`
这种云端 provider 名字里带 `llama`，会被判成本地。现在有 baseURL 就只看地址，
名字只在没有地址时兜底。

### 两份正则收敛成一份

`lib/index.js` 里原本复制了一份 `LOCAL_HOST_PATTERN` / `LOCAL_NAME_PATTERN` 各自演化
（`lm-studio` 在其中一份里写了两遍）。现在只有 `lib/status.js` 一份真值源，
`lib/index.js` 直接 import —— 否则「面板说这是本地」和「要不要裁剪」会用两套判据。

### 名字白名单补上新后端

`mlx` / `llama-cpp` / `llamafile` / `localai` / `xinference` / `ktransformers` /
`oobabooga` / `textgen` / `aphrodite` / `exo`。封闭枚举注定追不上新后端，所以地址判定
才是主路，名字只是没有 baseURL 时的兜底。

### 新成因：`route-excluded`

地址明明是本地，但 `routes` 写了别的名字（或 `autoDetectBaseURL: false`）把自动识别
关掉了。以前面板只说「未裁剪」，用户会去翻 `dropSections`（方向完全错了）。现在
`lastSkipReason` 会区分这两种，面板文案直接告诉他「把 routes 留空就按地址自动认」。

### 测试

- `test/panel.mjs` +6 组（97 项）：误判四例、回环整段 / CGNAT / 链路本地、IPv6 与 mDNS、
  新后端名字、以地址为准、`route-excluded` 文案。
- `test/autodetect.mjs` +2 个云端 fixture（`cloud-lookalike` / `cloud-userinfo`）：
  名字和主机名都像本地，必须原样放行。
- 变异验证：把 `looksLocalUrl` 换回旧正则，`cloud-lookalike` / `cloud-userinfo`
  两条立刻变红 —— 断言确实盯着这个 bug，不是假绿。
- `npm run verify` **1253 ✓ / 0 ✗**。

## [0.5.5] - 2026-11-14

一句话：**模型删了，provider 也得跟着消失 —— 以前两边根本没人在对账。**

`ollama rm qwen3:14b` 之后，配置里那条 `- id: qwen3:14b` 会永远留着。0.5.4 让它不再骗人
（徽章变黄、表头说「N 个跟后端对不上」），但**擦掉它的动作还得你自己点**。而「点删除」这件事
要求你先意识到那条 provider 已经空了 —— 正是面板在帮你判断的那件事。

### 谁在纵容这个状态（三个原因叠在一起）

1. `ollama rm` 只删磁盘上的 manifest 与 blob，它不知道 DSH 存在；
2. 宿主 `listModels` 只要凭据不抛就返回 profile 里声明的模型，**不问后端**；
3. 插件的 `provision()` 开头是 `if (existing.length > 0) { …; return }` —— 有可达的本地
   provider 就整段跳过，只读不写，什么都不删。

所以「删除模型」这个动作在配置层完全不可见。0.5.5 补上的是这条链的最后一环。

### `planReconcile`：只做减法的纯函数

新函数 `lib/import-model.js` 的 `planReconcile({ declared, live })`，返回
`{ action: 'keep' | 'prune' | 'remove' }`：

- `removed.length === 0` → `keep`；
- `kept.length === 0` → `remove`（`models: []`，调用方据此删整条 provider）；
- 否则 → `prune`，`models` 只留活着的那些，**条目原样保留**（用户调过的 `contextWindow` /
  `maxTokens` / `reasoningEfforts` 不会被探测值覆盖）。

两条必须记住的判据：

- **`live` 必须是数组才动手。** `live === undefined` 与 `live === []` 是两件事：前者是「没问到」
  （探测失败），后者是「后端真的一个模型都没有」。混在一起就会在服务没起来的时候清空配置。
- **只减不增。** 同一个端点常常挂着多条 provider（`local-ollama`、`local-ollama-qwen3-14b`…），
  补模型会把后端全量模型塞进每一条，等于替用户改模型选择器。要「跟后端一模一样」请用「对齐」。

### `reconcilePanel`：三种情况一律不动

`POST /api/dsh-local-trim/reconcile`（第 15 条 bridge 路由），入参 `{ provider?, apply? }`，
`apply !== false` 即真写。跳过逻辑比动作逻辑更重要：

| 情况 | 行为 | 理由 |
| --- | --- | --- |
| 后端连不上 | skip | 探测失败 ≠ 模型没了 |
| 后端只报当前加载的模型（llama.cpp） | skip | 分不清「没装」和「没加载」 |
| provider 本来就没有 `models` | skip | 没什么可对账的 |
| 云端 provider | 不参与 | 没有「本机删了模型」这回事 |

第二条是这次最容易写错的地方。llama.cpp 的 `/v1/models` 只列当前**已加载**的那一个，
照它删模型会把「暂时没加载」当成「已经删了」。判据是 `probe.via === 'ollama'` 或
`backendFor(baseURL) ∈ {ollama, vllm, lmstudio}` —— 这几个后端会枚举全部已装模型。

全死时走 `unregisterProvider`（`settings.mutate` 的 `unset`），**不是** `update` 写一个空
`models` 数组：空 `models` 在 `llm-pi-ai` 里是配置错误，不是「停用」。

### 挂在哪：启动一次 + 一个按钮

- `provision()` 的 `existing.length > 0` 分支不再直接 return，先跑一次静默对账；
  配置里 `provision.reconcile: false` 可关。
- 面板表头加 **对账** 按钮（`counts.stale > 0` 时变黄），一次对全部本地 provider。
- 默认**不**在每次点灯时自动跑：点灯是 15 秒一次的只读探测，往里塞写操作会让「刷新面板」
  变成破坏性动作。

### 测试

- `test/panel.mjs` 加 7 条 `planReconcile` 纯函数断言（部分死 / 全死 / 后端多出来 / `live`
  为 `undefined` / `live: []` / `:latest` 归一 / `declared: []`）。
- `test/panel-host.mjs` 加第 22 组 17 条路由断言（含 llama.cpp 跳过、连不上不动、`apply:false`
  只算不改、全死走 `mutate unset`）。
- `npm run verify`：1169 → **1245 ✓ / 0 ✗**。
## [0.5.4] - 2026-11-14

一句话：**「在线」不再只表示端口能 ping 通，升级也不再被旧默认值卡住 —— 这两个毛病都是「看着没问题，其实在骗人」。**

起因是一张面板截图：一条 provider 写着「3 模型 · 2 个已不在后端」，右边却挂着绿色「在线 · 45ms」。
顺着查下去发现两个独立的语义错误，外加一个「配置升级不生效」的隐式 bug。

### 「在线」说的是能不能用，不是端口通不通

`lib/status.js` 里 provider 行的 `state` 原来在算 `missing` **之前**就定好了，只看
`check.ok === true`：

```js
const state = check === undefined ? { tone: 'muted', label: '未检测' }
  : check.ok === true ? { tone: 'good', label: `在线${ms}` }
  : { tone: 'bad', label: '连不上' }
```

后端答了 200 只证明「端口活着」。Ollama 对不存在的模型名也照样列自己的清单，所以
`ollama rm` 删掉权重之后，配置里那条 `- id: qwen3:14b` 没有任何东西会去清 —— 面板一直
显示「5 模型」，点进去每个模型都是 404，而徽章是绿的。`counts.online`（表头那个
「在线 N 个」）同样是 `online[row.id]?.ok === true`，同一个病。

现在把 `declared` / `live` / `missing` 的计算提到 `state` 之前，分三种话：

| 情况 | 徽章 | 文案 |
| --- | --- | --- |
| 声明全在 | `good` | `在线 · 45ms` |
| 部分不在 | `warn` | `在线 · 45ms · 2 个模型不在后端` |
| 全都不在 | `bad` | `端口通，但配置里的 5 个模型后端全没有 · 45ms` |

关键约束：**「探测没回模型清单」不能当成「后端没有模型」**。`check.models` 缺席时
（`Array.isArray(check.models)` 为假）仍返回 `good` —— 不知道 ≠ 没有。这条同时保住了
`test/panel.mjs` 里那批手工构造 `{ ok: true, ms: 12 }` 的用例。

表头 `counts.online` 改成跟行徽章同一套判据（`good` 或 `warn` 才算），否则会出现
「3 条 provider，表头说在线 3 个，其中一条红着」。

### 配置字段写进 profile 之后，新默认值对老用户永远不生效

这是最隐蔽的一条。`keep` / `dropSections` / `dropContexts` 三个字段一旦被面板保存过一次，
就会以「用户显式配置」的身份永久留在 `cordis.patch.yml` 里。插件读到的是一串名字，
**分不清那是用户真想要的、还是上一版默认值被固化下来的**。

于是 0.5.2 把 `DEFAULT_KEEP` 从 19 条改成 15 条（去掉 5 个 scoped 名、加上 `apply_patch`）、
0.5.3 从 `dropSections` 里删掉 `dsh-purge:anchor` —— 对升级上来的机器**一个字都没生效**，
而且没有任何地方会说这件事。

修法是 `lib/defaults.js` 里新增 `LEGACY_DEFAULTS`（0.5.1 与 0.5.2 两套真值），
`migrateLegacyList()` 在读到配置时判断「这串名字是不是某个旧默认值的变体」，
是就按当前默认值翻译，不是就原样不动。判据三条，缺一条就会误伤：

1. **出现旧默认值里没有的名字 → 用户自定义，不动。** 这是最重要的一条：加了东西的集合
   一定不是「旧默认值」，直接放过。
2. **删减超过两成 → 用户手工精简，不动。** 只删几条（比如本机那种从 19 条删掉
   `working_directory`，因为跟 `read_image` 同现会让某条免费通道 429）属于「顺手删的」，
   仍然认作旧默认值；删掉一半就是另一套东西了。
3. **翻译时保留用户的删减**：`next = 当前默认值.filter(name => !用户删过的)`。
   用户删掉的名字不会被新默认值「加回来」——那是在改用户的配置。

遍历顺序是**从新到旧**：0.5.2 的 `dropSections` 是 0.5.1 的真子集，正着找会先命中 0.5.1，
日志里就把版本号说错了（`test/legacy.mjs` 专门钉住这条）。

翻译只在读取时发生，配置文件本身不动。面板上会多一行橙色提示：

> 配置是 0.5.1 的默认值，已按当前默认值解释（点保存可以固化；改这两个框就按你写的算）

悬停能看到逐字段明细（补了哪些、丢了哪些、你删过的哪些保持不恢复）。

### 自检那两行是启动瞬间的快照，会说谎

`assemble 接管` 和 `dsh-purge（可选）` 两行在自检时同步算一次，而 `installTakeover()`
后面还有 `[800, 2500, 6000]` ms 三次重试（dsh-purge 可能比本插件晚就绪）。结果是日志里
写着「未装 / accessor-native」，而 bridge 实时返回 `accessor+purge-slot` —— 两处都对，
只是说的不是同一时刻。

现在启动那一行照实说「此刻未装（也可能比本插件晚就绪）」，并在 **6500ms 后复核一次**
（覆盖完三次重试）：结论变了才补一行 `复核：assemble 接管已生效（accessor+purge-slot，
启动时是 accessor-native）`，**没变就一个字都不说**。日志里多一行「还是老样子」只会让人
以为出了什么事。

### 顺带修掉：「连不上：连不上」

`checkPanel()` 把探测失败的原因写进 `online[id].error` 时读的是 `probe.attempts[0].error`，
而 `probeEndpoint()` 放进 `attempts` 的键叫 `reason`（`ECONNREFUSED` / `status 404` /
`no models listed`）。读一个不存在的键 → 永远是 `undefined` → 落到兜底字面量 `'连不上'`，
再被 `lib/status.js` 拼成 `连不上：连不上`。真机验证时面板上那条 llama.cpp 就是这么显示的，
这次一起修了：现在会说 `连不上：fetch failed` / `连不上：status 404` 这种真原因。
`alignPanel()` 里同一处读错键的地方也一并改了（它的文案是「后端连不上（…），配置没动」）。

### 升级注意

- 什么都不用做：旧默认值在读取时自动按新默认值解释，配置文件不动。
- 想把它固化下来（以后不再每次读都翻译一遍）：面板上点一次保存。
- 想保留原来那套：直接改面板里那两个文本框，改成什么就是什么。

## [0.5.3] - 2026-11-14

一句话：**dsh-purge 从「隐式前提」降级成「可选增强」，顺手堵掉一个「一处坏、全盘失效」的口子。**

0.5.2 把工具名和段名清单里的本机拟合清掉了，但漏了一条更深的耦合：整个注入面都写死在
`dsh-purge` 这个名字上。追问「dsh-purge 其实也是本机特殊环境」之后查下来，这条耦合里
**一半是真拟合、一半是必须保留的互操作契约**，得分开处理。

### 段名：装了沿用它的名字，没装用自己的

原来的代码两个方向都写死了 `'dsh-purge'`：

```js
if (sectionName === 'dsh-purge') { /* 换正文 */ }      // 按名读
keptSections.unshift({ name: 'dsh-purge', ... })        // 按名写
```

在一台从未装过 dsh-purge 的机器上，这等于**凭空造一个带第三方插件名字的段** ——
直接违反 `lib/defaults.js` 开头那条自定纪律（不写任何本机特有的插件名）。

但不能简单改名，因为装了的时候这个名字是**必要契约**，三条证据：

- `dsh-purge-community/lib/identity.js:333` `leadWithInject` 里
  `if (section.name === "dsh-purge" || section.name === CAPABILITY_SECTION) continue;`
  —— 只有这个名字的段被跳过，其余会被 inject 的 matcher 逐条剥离；
- 同文件 `:195` / `:660` / `:981` 都用精确名找段、定位插入点、决定是否原样保留；
- **宿主本身被 dsh-purge 打过补丁**：`@deepseek-ai/dsh-system-prompt/lib/index.js` 旁边
  留着 `index.js.dshpurge.bak`，`diff` 出来四处 `// [dsh-purge]` 改动，其中一处是
  complete preset 分支只保留 `name.startsWith("dsh-purge")` 的段 —— 换个名字，注入直接被砍掉。

所以改成**按机器决定**：`purgePresent()` 查 `globalThis.__dshPurgeHungPrompt` 和
`prompt.assemble` 上的 `ASSEMBLE_GUARD` slot，有就写 `dsh-purge`，没有就写
`local-trim:inject`。**读的时候两个名字都认**，热装/热卸 dsh-purge 时装配里残留的上一个
名字的段也能被接住。

### 段名改成前缀识别：它升级改个名，25K 正文就换不掉了

探针里有一个形态是「注入段叫 `dsh-purge:v2`」（dsh-purge 自己就用
`name.startsWith('dsh-purge')` 认段，它升级时完全可能这么改）。原来的精确匹配下，
这个形态只省了 3.4K（30042 → 26580）—— 段裁剪生效了，但那段 25K 原文一个字没换，
因为没认出来。

改成 `isInjectSection(name)` = `name === 'local-trim:inject' || name.startsWith('dsh-purge')`
之后，同一个形态 30042 → **1580**，和基线完全一致。

大小写不同（`DSH-Purge`）**不**被认成注入段，这是刻意的：宿主和 dsh-purge 都按精确大小写
匹配，放宽会把用户自己命名的段也吃掉。

### schema 面抛错会连累提示词面（一处坏、全盘失效）

`slimToolSchemas` 里量体积用的是裸 `JSON.stringify`：

```js
const before = list.reduce((sum, s) => sum + JSON.stringify(s ?? {}).length, 0)
```

循环引用抛 `TypeError: Converting circular structure to JSON`，深度几千层抛
`RangeError: Maximum call stack size exceeded`，BigInt 抛
`TypeError: Do not know how to serialize a BigInt`。异常穿出 `trimAssembly`，被外层的
`try { return trimAssembly(result, agent) } catch { return result }` 吞掉 ——
**提示词裁剪、注入替换、context 裁剪一起失效**，而面板只会说「未裁剪」。

实测（13 种极端装配形态）：改前循环引用 / 深度 3000 / BigInt 三种形态全部 27499 → 27499
原样返回；改后三种都正常裁剪，循环引用那条 27499 → **889**。

修法是三层：`schemaBytes()` 把 `JSON.stringify` 包进 try/catch（量不出来就返回 `null`，
统计整体跳过但照裁）、`slimSchema` 加 `WeakSet` 见集合防自引用（末尾 `delete` 掉，
同一个对象在兄弟位置重复出现不会被误判成环）、`slimToolSchemas` 把 `list.map(slimSchema)`
整体包一层 try/catch（爆栈时只放弃 schema 面）。

### 顺带清掉的死条目与文案

- `DEFAULT_DROP_SECTIONS` 里的 `'dsh-purge:anchor'` 删掉 —— 这个名字在
  dsh-purge-community 1.6.93 全树 0 命中，是 0.3.0 时按想象加的。`dshpg-capabilities`
  保留（`lib/capability-protocol.js:11` 真实存在）。
- 自检行从「`dsh-purge 已装（本插件在其外层收尾，无需改它源码）`」改成
  「`dsh-purge（可选） 已装 → 注入段沿用它的段名 / 未装 → 注入段用本插件自己的段名`」——
  原来的写法让陌生用户以为必须装。
- `lib/status.js` 的接管文案去掉 dsh-purge 字样，改成「内层访问器的 slot 已转发」。
- README 同步：注入面那一行不再点名 dsh-purge、自检样例跟着改、「已知边界」把
  「未安装时也能工作」改写成「可选增强，不是前提」并说明段名怎么选。

### 新增回归用例（`test/autodetect.mjs`，13 项）

- 段名带后缀 `dsh-purge:v2`：25K 原文真的被换掉 + 注入正文进了装配；
- 删掉 `globalThis.__dshPurgeHungPrompt` 后：用自己的段名、不凭空造 `dsh-purge` 段、
  注入正文照样写进去；
- 循环引用 / BigInt / 深度 3000 三种畸形 schema 各两条断言：**不拖累提示词裁剪**、
  **不拖累注入替换**。

`test/selfcheck.mjs` 的 `mkSections(withPurge)` 也修了：原来两种情况都放 `dsh-purge` 段，
导致「没装」场景根本测不到补段那条路。

**这 13 条都做了变异验证**（改回旧实现，确认断言真的会红）—— 第一版不是：

- 原本写的是「存在一个 `startsWith('dsh-purge')` 的段」，改回精确匹配后**仍然绿**。
  原因是认不出注入段时会额外 `unshift` 一个新的短段，`find` 照样找得到。
  改成断言「原文 `ZZZZZZZZZZ` 不在任何段里」之后才真的红（`段=["harness:identity","dsh-purge","tool:mindmap"]`）。
- schema 那 6 条也分别验证过：只回退 `schemaBytes` 的 try/catch → 循环引用与 BigInt 四条红
  （深度 3000 仍绿，因为它死在递归而不是序列化）；只回退 `list.map` 外面那层 → 深度 3000
  两条红。两层各挡一类，缺一层就有断言失去意义。
- `injectSectionName()` 改回恒返回 `PURGE_SECTION` → 无 dsh-purge 的三条全红。

验证：`npm run verify` → **1139 项 ✓ / 0 ✗**（0.5.2 是 1126）。

### 写进去的 provider 在模型选择器里一个都看不到

用户报「新会话里选不到本地模型，插件等于被悬空」。查下来是本插件自己挖的坑，而且是
**写配置时看着完全正常、只在选择器里空掉**的那类。

链路（宿主安装树里，一条链走到底）：

1. `dsh-api-session-controller/lib/types/catalog.js` 的 `buildModelCatalog()` 对每条 provider
   `await ctx.llm.listModels(id)`，末尾 **`.filter(group => group.models.length > 0)`** ——
   空模型组被**静默丢弃**，连 `failures` 都不进，所以界面上没有任何报错。
2. `dsh-llm-pi-ai/lib/index.js:2036` 的 `listModels()`：`resolveApiKey()` 抛
   `MISSING_CREDENTIAL` 时 `return []`。
3. `:3090` 的 `resolveApiKey()`：`const ref = profile.apiKeyEnv; if (ref === void 0) return void 0;`
   —— **不声明凭据引用才免鉴权**；声明了就必须解析到值，否则抛错。

而本插件 0.5.2 之前 `buildProfile()` 把 `apiKeyEnv: DSH_LOCAL_LLM_API_KEY` **无条件写进
profile**（理由写在注释里：pi-ai 在没有 credential 声明时不带 `Authorization` 头，
llama.cpp 会静默返回空 completion）。那个 ref 从来没有被赋过值，于是：
配置里三条 provider 全在 → `listModels` 全返回 `[]` → 目录过滤 → **选择器里一个本地模型都没有**。

修法（都不写死任何变量名 / 端口 / provider id）：

- `buildProfile()` 的 `apiKeyEnv` **去掉默认值**，只在调用方显式给了才写进 profile；
- 兜底改成 `headers: { Authorization: 'Bearer local' }`（`DEFAULT_AUTH_HEADER`）——
  pi-ai 的 `getClientApiKey()` 只要见到 `authorization` 头就返回 `"unused"` 放行，
  对不校验值的本地端点无害，正好补上原来那条「不带 Authorization 头」的理由；
- 声明了 `apiKeyEnv` 时**不再塞兜底头**（会和真 key 抢同一个头）；
- `apiKeyFromEnv()`（写死读 `DSH_LOCAL_LLM_API_KEY`）换成 `apiKeyForProfile(profile)`：
  按 profile 自己声明的 ref 走 `credentials` 服务、退回 `process.env`，没声明就不带 key；
- `provision.apiKeyEnv` 可配，显式给了才透传；
- **可见性**：`lib/status.js` 的 provider 行新增 `credential: {ref, configured, tone, label}`，
  凭据没值时给 warn「凭据 X 没有值 —— 模型选择器里会看不到这个 provider」，
  不再让人对着空列表猜。

新增用例 6 条：默认不带 `apiKeyEnv`、默认带兜底头、显式给了才写、声明凭据时不塞兜底头
（`test/provision.mjs` 4 条）+ 凭据三态（未配 / 已配 / 未声明，`test/panel.mjs` 3 条）。

**旧配置要用户自己动手**：已经写进 `cordis.patch.yml` 的 provider 插件不会去改，
那几行 `apiKeyEnv` 得删掉或给 ref 配上值 —— 面板会 warn 指出是哪一条。

验证：`npm run verify` → **1145 项 ✓ / 0 ✗**。

## [0.5.2] - 2026-11-14

一句话：**默认值不再拟合这台机器。** 起因是一个很自然的追问 ——「之前那些问题是不是因为
插件过分拟合本机环境了」。查下来 0.5.1 修的那三个 bug 都不是，但顺藤摸出五处确实只对
本机成立的默认值，其中一处会让新用户的小模型一直调不存在的工具。

### 内置注入正文点名了只有本机才有的工具（危害最大的一处）

`DEFAULT_INJECT` 的 `## 工具` 段原文写着：

```
- 找文件 `ops_glob`，搜内容 `ops_grep`，读片段 `ops_read_files`，精确读 `ops_inspect_local_file`
- 跑命令 `ops_bash`（bash 语法，不是 PowerShell）
```

这五个名字来自第三方插件 dsh-ops 的 scoped 注册，官方 `@deepseek-ai/dsh-tool-*` 里
**一个都没有**。这段正文会原样喂给本地小模型 —— 没装 dsh-ops 的机器上，模型会照着它调一个
永不存在的工具，一路失败到上下文塞满，用户看到的只是「这个模型真笨」。

现在改成按 `keep` 白名单**现渲染**：`defaultInject(keepNames)` 拿 `TOOL_GROUPS`（读取 /
修改 / 执行 / 流程四组，每组是 `[工具名, 中文短语]`）过滤出真的还在的工具，不在表里的白名单
名字追加成最后一行裸名单，一个都没留就输出「当前没有保留任何工具」。`DEFAULT_INJECT` 保留成
`defaultInject()` 的求值结果，老引用照样能用。

### `DEFAULT_KEEP` 里有 5 个写进去必然失败的 scoped 名

`ops_bash` / `ops_glob` / `ops_grep` / `ops_read_files` / `ops_inspect_local_file` 全都在
白名单里。但 `tools.restrict({ allow })` 只认**全局**工具名，宿主原话是
`Restrictions intersect; scoped registrations remain visible.` —— 也就是说 scoped 注册本来
就不受限制，写进 allow 既没用、又会让整批校验失败。实测本机的 `local-trim.log` 里靠
`applyRestrict` 从报错里抠名字剔除了 **81 次**，等于每轮都在交一次无意义的异常。

清掉这五个，补上官方有而白名单漏掉的 `apply_patch`（改文件的主力，比 `write` 整文件覆盖
省得多）。`DEFAULT_KEEP` 从 19 项变成 15 项，全部取自官方 `dsh-tool-*` 的注册名。

### `DEFAULT_DROP_SECTIONS` 里的 `tool:workflow` 是个永远不会命中的死条目

`dsh-tool-workflow` 的段名是模板字符串 `` `tool:${toolName}` ``（`toolName` 默认
`"workflow"`，可被配置改掉），整个安装树里 `grep -rlF "tool:workflow"` **0 命中**。留着它
只会让「我丢掉了这一段的 325 字符」这句话是假的。

顺手把 18 条按来源分成两组：官方 7 条（`ui:deliverable-file-references`、`app:web-surface`、
`tool:goal`、`tool:ralph`、`tool:session-query`、`tool:pty`、`harness:source`）和第三方 10 条
（装了什么才有）。以后有人问「这条为什么没用」，一眼能看出它属于哪一类。

### `routePlan()` 兜底成 `['local-qwen']`

`routes` 不是数组时（正常配置不会发生，默认是 `[]`），路由集合被塞进一个写死的 provider id。
那是某个 profile 里恰好存在的名字，换台机器就是一条永不命中的死路由，同时还顺手关掉了自动
识别。现在按「没给名单 = 空集合 + 走自动识别」处理。

### 后端候选表里「目录约定」压过了「官方安装位置」

`ollama` 的候选第一位曾是 `~/AI/ollama/ollama.exe`，`llama-server` 的第一位是
`workbuddyBinary()`（`~/.workbuddy/local-models/bin/<build>/`）。这两条都只是**某些人的目录
习惯**，不是任何安装器会写的位置：换台机器它们返回空，等于白排；两台都装了的机器上，被选中
的反而是那个非官方副本。

现在统一成「显式环境变量 → 平台标准位置 → 目录约定 → PATH 裸名字」，模型目录同理
（`~/AI/models`、`~/.workbuddy/local-models` 排到 `~/models`、`~/llama.cpp/models`、
LM Studio 数据目录之后）。**没有删除任何候选** —— 本机实测 `~/AI/ollama/ollama.exe` 是唯一
存在的那个（`%LOCALAPPDATA%\Programs\Ollama` 与 `Program Files` 都没有），删掉会让本机直接
扫不到后端。降权而不是删除，是这个改动的前提。

### 测试：让「scoped 名会被拒」这条路径真的被测到

`test/selfcheck.mjs` 原来用 `DEFAULT_KEEP` 冒充「宿主的合法全局工具集」：
`const known = new Set(DEFAULT_KEEP)`。于是 `ops_*` 在这套假宿主里永远是合法名字，
**「真宿主会整批拒绝」这条路径永远走不到** —— 这就是上面第二条能一路带到 0.5.1 的原因。

现在假宿主自带两份独立清单：`HOST_GLOBAL_TOOLS`（35 个官方全局名）与 `HOST_SCOPED_TOOLS`
（8 个 scoped 名），`restrict({ allow })` 只认前者、报错文案照抄宿主原文。另外新增「场景 3：
默认值普适性」8 条断言 —— 默认白名单不含 scoped 名、内置注入不点名白名单之外的工具、换
`keep` 后正文跟着收窄、`keep` 为空不炸、`DEFAULT_INJECT === defaultInject([...DEFAULT_KEEP])`。

`test/portable.mjs` 新增两条：目录约定必须排在通用位置之后（`~/.workbuddy` 在
`~/llama.cpp/models` 之后、`~/AI/models` 在 LM Studio 之后），以及每个后端的候选表最后一项
必须是裸命令名、显式环境变量必须排第一。

`test/autodetect.mjs` 的「routes 缺省」三条跟着语义改了：现在缺省走自动识别，
`local-qwen` 与 `ollama` 都该命中，云端仍放行。

### 发布到 npm：新用户不再需要 git

这一版同时发了 npm（`dsh-local-trim@0.5.2`），起因是排查「新用户从市场下载能不能装成功」时
发现了一条硬门槛：宿主对 `github:` 源会先跑 `git -c credential.helper= ls-remote -- <repo> HEAD`
探连通性，而 DSH 桌面端**不自带 git**。没有 git 的机器上这条路必失败，且两侧的报错都指错方向
（命令行说「add the exact key under `allowBuilds`」，市场说「找不到能用的 pnpm…退出码 9009」，
真实原因只是那句中文的「不是内部或外部命令」被归进了 `unknown`）。

改成 `dsh plugin add dsh-local-trim` 之后走 registry tarball，pnpm 不需要 git。实测干净 PATH
（无 git / 无 pnpm / 无 node，只用宿主自带的）→ exit 0、871 ms、`+ dsh-local-trim 0.5.2`，
boot 自检 11 行全绿。

> registry 里会多出一个 `0.0.0-stage`：npm 11 首次发布新包名时自动塞的 staged publishing 占位
> 存根（`"stub": true`，336 B）。`dist-tags.latest` 不指向它，装不到它，无害。用 Granular
> Access Token 删不掉（`E403 … may not perform this action`），要删只能去
> `https://www.npmjs.com/package/dsh-local-trim/v/0.0.0-stage` 点 Delete version。

市场条目不用改：`data/plugins/Leonlee114514__dsh-local-trim.yml` 里只写 url/name/category/description，
`npm` 与 `version` 由市场仓库的 `scripts/probe-npm.mjs` 从 registry 自动解析（它要求 npm 包里的
`repository` 指回同一个 GitHub 仓库，防抢名），每日 02:23 UTC 全量重探，所以最迟次日市场的安装
命令会自动变成 npm 那条。

验证：`npm run verify` → **1126 项 ✓ / 0 ✗**（0.5.1 是 1111）。

## [0.5.1] - 2026-11-14

一句话：**面板不再只念配置，它开始读后端。** 起因是一个真实场景 ——
`ollama rm` 掉两个模型之后，面板上半截照旧写着「5 模型 · 在线 46ms」，全是绿的。

### 「N 模型」原来数的是配置里的数组长度，和后端真实情况无关

`checkPanel` 点灯时其实已经把 `/v1/models` 的完整响应拿在手里了，但 `light()` 只留了
`{ok, ms, error}`，**`probe.models` 被直接丢掉**。于是面板能告诉你「这个端口通」，却答不出
「你配的那些模型还在不在」。而 Ollama 对不存在的模型名照样给 `/v1/models` 200，所以绿灯
从来不等于配置有效。

这版把探测结果留下来（15 秒缓存一起带上），和配置里声明的一条条对，算出三类差：

- **missing** —— 配置里声明了、后端此刻没有（`ollama rm` 留下的死声明）
- **extra** —— 后端有、配置里没注册（能直接导入的那种）
- **一致** —— 一声不响

判活用的是 `sameModel(a, b)`：归一化后相等。这条比看起来重要 —— Ollama 的 `/api/tags`
永远报带 tag 的全名（`nomic-embed-text:latest`），用户手写配置常省掉，不归一化会把每一条
都判成已删除，**全表飘红比不报还糟**。反过来 `models/qwen.gguf` 这种文件式 id 不补
`:latest`，否则 llama.cpp 那边全飘红。

颜色分两档是有意的：全死（`bad`）该删 provider，部分死（`warn`）该改配置。处置不同，
不该是同一个颜色。

顺带修掉一个**只在真机上才会炸的 bug**：`buildPanelStatus` 里写了
`declared.filter((value) => !hasModel(liveSet, value))`，而 `hasModel` **从来没被定义过**。
`node --check` 只查语法不查未定义标识符，所以这个 `ReferenceError` 要等面板真的拿到在线
模型才抛 —— 也就是用户的机器上，而不是测试里。现在 missing / extra 都走同一个
`sameModel`（并把它从私有改成导出，让面板与对齐共用一套判据，否则会出现「面板标红两条、
对齐只删一条」）。

### 「对齐」按钮：改成后端真的有的那份

`ollama rm` 删的是磁盘上的权重，`cordis.patch.yml` 里那条 `- id: qwen3:14b` 声明没有任何
东西会去清。原来只能逐条手动改，这版加了 `POST /api/dsh-local-trim/align`（第 14 条路由，
进 `HEAVY_ROUTES` 因为要打网络）。

`planAlign` 是纯函数，三条原则：

1. **活着的条目原样保留** —— 用户的 `contextWindow` / `maxTokens` / `reasoningEfforts` 是他
   自己的调参结果，对齐不是「重置成探测值」，只摘死记录、补新记录。
2. **判活跟面板同一套判据**（`sameModel`），见上。
3. **绝不产出空 `models` 数组** —— 一条 provider 0 个模型在 `llm-pi-ai` 里是配置错误，不是
   「不用它」。全都不在了就明确让人去删 provider。

`alignPanel` 里最关键的一条是：**探测失败直接返回、一个字节都不写**。探测失败和「后端一个
模型都没有」是两回事，混在一起会把整条 provider 的模型清空 —— 那是数据丢失。所以后端连不上
时返回的是「后端连不上（…），配置没动」。

写回走 `settings.update` 整条 profile 重写（`mergeLayers` 对数组是整体替换，所以新的
`models` 会原样覆盖旧的），写前带 `revision` 做乐观锁；成功后清在线缓存与 baseURL 缓存再
`planAll()` —— 不清缓存的话刷新面板还是旧红字。没有差值时返回 `changed: false`，一次
settings 都不写。

面板**不会自己改配置**。误把「后端没起来」当成「模型被删了」然后自动清空，比让用户多点
一次糟糕得多。

### 导入不再长出第二条 provider

`defaultProviderId` 每次都按「后端 + 模型名」造 id，于是同一个 Ollama 攒出
`local-ollama-qwen3-14b`、`local-ollama-qwen3-8b`、`local-ollama-gemma4-12b`……每条只挂一个
模型，删模型还得记着删对应那条。这就是面板上半截越拉越长的源头。

现在导入时先找这个端点是不是已经有一条**通用名**条目（`local-ollama` / `local-llamacpp`），
有就 `appendModelToProfile` 追进去，返回里带 `reused` 说清是复用。两条边界是有意的：

- **用户手填了 provider id 就不复用**（`parseImportInput` 新增 `explicitProvider`）—— 那是
  他主动指定的，不去猜。
- **自己起名的条目不当复用目标** —— `local-ollama-qwen3-14b` 这种分开配的往往调过 ctx /
  compat，塞新模型会让人意外。

端点比较用 `canonicalEndpoint`：补 `/v1`、`localhost`/`[::1]`/`0.0.0.0` 统一成 `127.0.0.1`、
去尾斜杠。不收敛回环名的话「复用」会失效 —— 用户填 `localhost:11434` 就照样长出第二条。

顺带修掉另一个潜伏 bug：`backendByName` 认不出来时返回的是**空串**而不是 `undefined`，所以
`BACKEND_BY_PORT[port] ?? backendByName(hint) ?? 'local'` 里那句 `?? 'local'` 兜不住空串，
生成的是 `local--qwen3-4b`（双连字符）。`PROVIDER_ID_RE` 恰好放行，所以一直没炸，只是 id
难看又难认。现在统一走 `genericProviderId()`，认不出后端时前缀就是 `local`。

### 测试

- `test/panel.mjs` 52 → **77 项**：新增 8 条差集断言（全一致 / 部分不在 / 全不在 / 后端多余
  不报警 / 省略 `:latest` / 文件式 gguf id / 未检测与连不上都不飘红 / 云端也照常算差集）、
  表头 `counts.stale` 汇总、11 条「复用同一后端」断言（含端口认不出时的双连字符回归）、
  5 条 `planAlign` 纯函数断言（摘死补新且活着的原样保留 / 无差值不写 / `:latest` 不误判 /
  全死拒绝 / 缺 ctx 退回兜底不写 0）。
- `test/panel-host.mjs` 新增第 8b 组 15 条：真跑 `apply()` 走 import 路由，验「复用
  `local-ollama` 而不是新建」「老模型没被改写」「displayName 没被覆盖」「重复导入标
  `alreadyThere`」「显式 provider 不被改写」；第 21 组 20 条验 align 的完整链路。
- 顺手修了 `test/panel-host.mjs` 的 `settingsStub.update`：原来 `{...row.value, ...patch}`
  平铺会把整个 `providers` 表换掉，和真实 `mergeLayers` 不符 —— 那样「对齐只动了一条
  provider」在测试里根本验不出来。现在照 `mergeLayers` 写：plain object 递归、数组整体替换。
- `npm run verify` → **1111 项 ✓ / 0 ✗**（0.5.0 基线 969）。

## [0.5.0] - 2026-11-14

这一版没有新功能，全部是「新用户能不能用起来」的适配性修补。起因是一个很朴素的问题：
别人从市场下载这个插件，面对不同的电脑和环境，能装上、能跑起来、能看懂出了什么事吗？
把三个环节各测了一遍，得到三处静默失败，逐个补掉。

### 机器上没装 git 就装不上（不是这个插件的问题，但会算在它头上）

市场装 `github:owner/repo` 这类源时，宿主在跑 pnpm 之前会先执行
`git -c credential.helper= ls-remote -- <repo> HEAD` 探连通性。**DSH 桌面端不自带 git**
（安装树里连一个 git 二进制都没有），所以全新机器上这一步直接失败。更糟的是两侧的报错
都指错方向：

- 命令行说的是「add the exact key under `allowBuilds`」—— 其实和 build 授权无关
- 市场说的是「找不到能用的 pnpm…退出码 9009」—— 其实是那句中文「不是内部或外部命令」
  命中了 `cmdNotFound` 的判定，把 git 缺失误诊成 pnpm 故障
- 宿主侧的分类器对三种真实输出（`spawn git ENOENT` / 中文「不是内部或外部命令」/
  `ERR_PNPM_GIT_RESOLVE_FAILED`）一律返回 `unknown`，而只有 `network` / `timeout` 才会
  中止安装 —— 于是安装继续往下跑，让 pnpm 再失败一次，用户看到的是两段互相矛盾的报错

这版改不了宿主的行为，能做的两件事都做了：

1. README 的「安装」开头加了一节「装之前先看这一条：机器上有没有 `git`」（0.5.2 之后这节
   挪到了「方式二：`github:` 源」底下，因为 npm 那条路不需要 git），写清楚怎么判断、
   各平台怎么装，以及**不想装 git 的绕法**——把源固定到 commit（`github:owner/repo#<sha>`）。
   这条实测能成：那种形式走 codeload tarball，pnpm 不需要 git；宿主那次 `git ls-remote`
   仍会失败但分类是 `unknown`、不中止安装。
2. 加 `publishConfig` 并为「发到 npm」补了发布就绪自检，发上去之后这条路彻底绕开 git。

### headless / sdk / acp profile 上面板不出现，而且一行日志都没有

控制面板挂在 `plugins.detail.section` 槽位上，这个槽位由
`@deepseek-ai/dsh-client-ui-plugin-manager` 声明，而它只被 `dsh-web-app` 依赖。
所以只有 `web` profile 有面板，`headless` / `sdk` / `sdk-minimal` / `acp` 都没有。

原来的问题是**完全静默**：`ctx.inject(['clientModules'], cb)` 在服务不存在时回调永不触发，
于是「自愈 + 写日志」整段不执行。用户装完插件，界面上什么都没有，日志里也查不到任何字，
只能认为插件坏了 —— 但裁剪其实完全正常。

改法分两层：

- `apply` 时立刻读 profile 自己的 `package.json` 里 `dsh.profile.bundles`，看有没有
  `dsh-web-app`。这是唯一不依赖服务注册时序的证据，进程活多久都算得出来。
  判定为没有宿主就当场写一行日志说明情况（原来要等 1.5 秒的定时器，而 headless profile
  常常在定时器触发前就因鉴权失败退出了 —— 实测踩到过）。
- 向上找带 `dsh.profile.bundles` 的 `package.json` 而不是写死相对路径：源码以 `link:`
  挂进 profile 时模块真实路径在源码目录里，层级和装到 `node_modules` 时不同，写死层数会
  指向不存在的文件而且静默失败。找不到就退回原来的服务探测。

自检那一行用 `·` 而不是 `✗` —— 「这个 profile 没有面板位」是 profile 的选择，不是故障，
用 ✗ 会让 headless 用户以为插件坏了。`status` 里也带上 `client: {state, tone, label, detail}`。

### 「未裁剪」原来只有一个模糊说法

`summarizeTrim` 在没裁到东西时只报「N 字符，未裁剪」，把五种完全不同的成因混在一起：
云端 provider 被放行（设计如此）、没拿到 provider 名、本地 provider 但段名一个没命中
（该去查配置了）、裁剪被关、这次没有 sections。前两种不用管，第三种要处理，但界面说的是同一句话。

现在 `trimAssembly` 每条早退路径都记下成因（`provider-not-local` / `no-provider` /
`nothing-matched` / `trim-disabled` / `no-sections`），`status.js` 按成因给不同文案。
面板上「该裁但没命中」用警告色并附一整行解释，其余保持中性。

### 新增测试

- `test/client-host.mjs`（12 项）——「有没有宿主都要说出来」。两种场景各跑一遍：没有
  `clientModules` 服务时必须明说面板不会出现、同时说明裁剪照常生效；有服务时要清 `pkgMeta`
  缓存、把本包标脏、报 ready。这条用例的价值在于它能在 CI 上跑 —— 原来这个静默点只能靠
  真机装一遍才发现。
- `test/publish.mjs`（31 项）—— 发布就绪自检：`publishConfig`、`files` 覆盖运行时真正加载的
  三样东西（`lib/`、`client.js`、`cordis.patch.yml`）、`dsh.bundle` / `dsh.client` 声明齐全、
  schemastery 保持 optional peer（写成硬依赖会让 profile 里多装一份副本，和宿主那份打架）。
- `test/panel.mjs` 加 11 条（累计 52 项）：五种成因文案 + `summarizeClientHost` 三态；
  `test/panel-host.mjs` 加 2 条（`status` 里带 `client` 字段，且 stub 下是「未知」不是「不可用」）。

`npm run verify`：909 → **969 项，0 失败**。

### 真机验证

全新 `DSH_HOME`，用真 CLI 装 tgz，再用真宿主 boot：

| profile | bundles 里有 dsh-web-app | 日志 |
| --- | --- | --- |
| `headless` | 否 | `· client 半边 没有宿主（面板不会出现，裁剪照常生效）`，当场判定，不等定时器 |
| `web` | 是 | `… 待探测` → 80ms 后 `client 半边有宿主 —— clientModules 服务可用` |

## [0.4.9] - 2026-11-06

面板在插件详情页里「突然消失了」：整块不渲染、页面上只剩空白，宿主一切正常，连崩溃日志
都没有。原因是 v0.4.8 引入的一个**作用域错误**：

```js
function AdoptBox(...) {          // 组件 A
  const portFor = (item) => ...   // 声明在这里
}
function Panel({ subject }) {     // 组件 B
  const scanModels = React.useCallback(async () => {
    ...
    setAdoptForm((prev) => ({ ...prev, port: portFor(first) }))   // ← 引用不到
  }, [])
}
```

语法合法，`node --check` 通过，**只有点过「扫描本机模型」之后才会在渲染期抛
`ReferenceError: portFor is not defined`**。而宿主给每个插槽条目包了一层错误边界：

```js
// @deepseek-ai/dsh-client-ui-renderer/lib/client.js:631
static getDerivedStateFromError(error) { ... return { failed: true } }
componentDidCatch(error) { console.error(...); this.props.onEntryError(error) }
if (this.state.failed) return <Anchor data-slot-error={this.props.slotKey} />
```

于是崩溃被**就地接管**：整块面板换成一个空的 `<div data-slot-error="plugins.detail.section">`，
宿主不崩、进程不退出、crash 日志不产生 —— 用户看到的就是「控制面板凭空消失了」。

改法：把 `isOllama` / `portFor` 这两个纯函数从 `AdoptBox` 内部提到 factory 作用域（两个组件
都要用），并在源码里写清为什么必须放在那里。

**新增 `test/client.mjs`（7 项）**，这是这个仓库第一次有 client 侧的测试。它自带一个最小
React 替身（`createElement` / `useState` / `useCallback` / `useEffect` / `useMemo` / `useRef` /
`class Component`），**真调函数组件、真在渲染期执行 `setState` 的 updater**、真递归渲染出 DOM
树、真去点「扫描本机模型」按钮，再用真机 `/status` 与 `/models` 的载荷回放。因为 `client.js`
是宿主进程外的模块（`window.__ModuleLoader__.load`），`node --check` 只能看语法，作用域和
渲染期异常只有这条回路能抓住。

写这条回路时踩到并修掉的三个坑（都写在测试注释里）：
- `useState` 的 setter 必须在**调用时**抓住当前组件（`const owner = current`），否则 `await`
  之后 `current` 已归零，更新写进别的袋子，首轮 3 个用例假失败；
- 组件 visit 去重按**函数对象**而不是函数名，否则同名组件被跳过；
- `flushEffects()` 除了 `await` effect 本身还要多转几圈微任务/宏任务 —— 组件里写的是
  `if (mine) load()`（不返回 promise），`await` 只等到「请求发出去了」。

`test:unit` 与 `check` 都接上了 `test/client.mjs`。顺带补上 `lib/status.js` 里早就该有的
`provider` 字段（面板的收益条一直在读 `trim.provider`，服务端从没发过，所以那半句永远是空的
—— 排障时看不出「这次装配被判成了哪个 provider」）。

`npm run verify`：909 个 ✓、0 个 ✗。

## [0.4.8] - 2026-11-05

点「拉起」一个 35B 的普通 `.gguf`，结果拉起的是 Ollama，注册出来的是
`local-ollama-nomic-embed-text-latest` —— 一个 embedding 模型。看着像「按钮接错了线」，
其实是三件事叠在一起，每一件都单独成立：

1. **端口被上一次点击粘住了。** v0.4.5 给「本机模型」列表加了「选中 Ollama 的模型时端口
   跟到 11434」（那个端口上跑的是 ollama，填 8090 会再起一份 llama-server）。但反过来
   没做：选中普通 `.gguf` 时端口不回到 8090。于是一次「先点 ollama、再点 gguf」之后，
   表单里那个 11434 就一直留着。
2. **服务端照单全收。** `adoptPanel` 只在「这个文件是 ollama 的 blob」时才走 ollama 那条
   路；普通 `.gguf` 落到 11434 上时它既不拦也不改口，直接去探那个端口。Ollama 在应答，
   于是整条流程借了它的端口，连 `ollama serve` 都不用起 —— 日志里那句「端口本来就在应答，
   跳过拉起」就是这么来的。
3. **对不上就抓第一个。** 想对上的名字是文件名去后缀（`local_model`），在 Ollama 的
   `/v1/models` 里当然对不上，而兜底是 `?? liveModels[0]`。embedding 模型常常排在第一位，
   于是它被当成了用户要的那个 35B。

三件事里第 3 件是真正把「端口错了」放大成「注册出一个完全不相关的 provider」的那一步 ——
只有它会让用户在一个列表里看到自己从没点过的模型。

改法：**端口跟着文件走，不跟着上一次点击走。**

1. **服务端按「引擎的端口」改口**（`lib/index.js` adoptPanel）。普通 `.gguf` 落在别的引擎
   的端口上（ollama 11434 / vLLM 8000 / LM Studio 1234）时改用 8090，并把这件事写进
   `portNote` 回给面板。只对**已知引擎的端口**改口：用户填个 9999 想喂自己的 llama-server，
   那是他的自由，照旧不抢。
2. **兜底不再瞎猜**（`lib/index.js`）。`pickModel` 对不上时，只有列表里**恰好一个**模型才
   取它（单模型后端报的 id 本来就可能和文件名不同）；多个模型对不上就**报错并列出它们**
   —— 「别猜一个用 —— 先确认这个文件喂给了正确的后端」。这比注册出一个错的 provider 好。
3. **前端端口不再粘**（`client.js`）。新增 `portFor(item)`：Ollama 的条目 → 它的端口，
   普通 `.gguf` → 8090。点名字选中和扫描后自动选中两处都改用它。
4. **把改口说给用户听**（`client.js`）。面板在「跳过拉起」那行之前多印一行 `· 端口 …是 …
   的，这个文件是普通 GGUF，改用 …（llama.cpp）`。

被排除的假设：不是 `launchPanel` 的端口解析错（它对 11434 的识别是对的，`planLaunch` 也
确实起了 `ollama serve`）；不是 provider id 生成规则错（`local-ollama-nomic-embed-text-latest`
正是「ollama 后端 + 模型名 slug」的正确形状，问题在喂进去的模型名）；也不是扫描把 35B 认成
了 ollama 的模型（它 `source: 'workbuddy'`，`grep -rn nomic dsh-local-trim` 零命中）。

测试：`test/panel-host.mjs` 新增第 17f 组 —— 普通 `.gguf` + 端口 11434，断言端口被改回
8090、注册成 llamacpp 后端、模型 id 不是 ollama 清单里的第一个、且把改端口说了出来。
先建红色回路（4 条断言全红，正是用户看到的现象）再动代码。



点「试跑」第一次必报 `This operation was aborted`，再按一次就成功。看着像假失败，
其实是**真的超时**，只是超时之后做了件更糟的事：把整段试跑共用的那个 `AbortController`
留在了 aborted 状态上，第二轮的「换个写法再试」于是立刻失败 —— 两轮请求挤在同一个
30 秒总预算里，第一轮把预算烧完，第二轮连发都发不出去。冷加载 17GB 权重时第一轮必定
烧完预算，于是「第一次必失败、第二次必成功」成了可复现的固定行为。

改法是把预算从「整段一次」拆成「每轮一次」，超时不再直接报错：

1. **每轮一个 `AbortController` + 一个 `setTimeout`**（`timers` 集合统一收尾清理）。
   第一轮 aborted 不再污染第二轮 —— 这是真正的根因，其它都是它的表现。
2. **超时自动再来一轮**（`retryOnTimeout`，默认开）。冷加载第一次超时几乎总是
   「权重还在读盘」，模型进程并没有死。点一次等于点两次，用户不必理解内存加载曲线。
   非超时错误（连不上、HTTP 报错）**不重试** —— 重试也是一样的结果，早点把原因给人看。
3. **超时文案单独说话**：`试跑超时（60 秒，已自动重试一次）—— 大模型第一次要把权重
   读进内存，比之后每次都慢；稍等片刻再点一次，或在配置面板把「试跑超时（秒）」调大`。
   原来的 `This operation was aborted` 是 undici 的 AbortError 原文，看不出该做什么。

- **新增**：`试跑超时（秒）`（`smokeTimeout`，默认 60，可设 5–600，超出夹回）。
  和 `拉起后等端口（秒）` 是两个不同的等待：**端口通了不等于能出字**，第一次请求常常
  还在把权重读进内存。慢机器 / 大模型调大它即可，不用再靠「点两次」绕。
- **变更**：`smokeTest` 默认超时 30 秒 → 60 秒；返回值新增 `timedOut` 与 `retries`
  字段（面板与日志不用再靠文案猜是不是超时）。
- **变更**：面板里「所以 `local_model.gguf` 这种也会显示成 `Qwen36_35B A3B`」这句举例
  去掉了 —— 别人的机器不一定下这个模型，拿它当例子只会让说明看起来像私人笔记。
  改说机制：文件名被改成别的也不要紧，名字读的是文件里的真名。
- **测试**：`test/panel.mjs` +4 组（第一次超时后自动重试一次；两次都超时时报超时文案
  且不冒充网络错误、不许出现 `This operation was aborted`；非超时错误不重试；
  `retryOnTimeout: false` 时只试一次且文案不带「已自动重试一次」）。41 项通过。

## [0.4.6] - 2026-11-04

扫描改看魔数之后，面板上出现了一行 `local_model.gguf | 15.8GB`。那就是 35B 的模型，
但**名字是错的**：WorkBuddy 把任何权重都存成 `local_model.gguf`，同一台机器上换个模型
还是这个名字，光看文件名分不出 A3B 还是别的，也看不出量化。真名一直躺在文件里 ——
GGUF 头部的 KV 区就写着 `general.name = "Qwen36_35B A3B REAP 0.25 …"`、`general.size_label = "A3B"`、
`general.file_type = 15`（Q4_K_M）、`qwen35moe.context_length = 262144`。v0.4.5 只把这条路
给 Ollama 走了（读 `metadata/*.json`），普通 `.gguf` 一个字节都没读。

探这道 KV 区踩了三个坑，都是同一种错：**把「读到的字节数」当成「必须读到的字节数」**。

1. **整块读头部**：先按 256KB / 1MB 把开头读进来再解析。GGUF 的 KV 区里躺着
   `tokenizer.ggml.tokens`（这个 35B 有 24.8 万条字符串）和 `tokenizer.chat_template`，
   它们把窗口占满，后面的 `general.file_type` 直接被截断 —— 窗口调多大都可能不够。
2. **按长度表跳字符串数组**：改成「读长度、按长度跳」之后算出 `2.7111490394611174e+22 B`
   这种天文数字。**那不是文件太大，是游标已经错了**：GGUF 的字符串数组是交错存储的
   （每条 `u64 长度 + 载荷`），不是「一张长度表 + 一块载荷」，按长度表连续读 8 字节会把
   载荷的首字节当成下一条的长度。
3. **把跳过的字节也算进预算**：跳只是移动文件指针，本身不花内存。把跳过的量计进预算，
   24MB 很快就被「跳过」烧完，于是又从半路放弃。

现在的做法是**读与跳分账**：键名和类型必读，超过 256KB 的字符串值和字符串数组只走位
（不复制 token 文本），非字符串数组超过 64 个元素也直接跳过，读的预算单独记。
游标越界（`pos + n > fileSize`）立刻停 —— 越界就是游标错了，继续读只会拿到垃圾。
半途超预算就返回已经拿到的键，不抛异常：多认出一个名字都是赚的。

- **新增**：`readGgufMeta(path, io)` —— 读 GGUF 头部 KV，返回原始键值对（可选注入
  `readMeta` 直通，或 `readRange` + `fileSize` 走内存假文件；默认走真实 fs）。
  预算：最多读 24MB、最多跳 2GB、最多 4096 个键。
- **新增**：`decorateWithGgufMeta(entry, meta)` —— 折进扫描条目：`modelName`
  （`general.name` 整串）、`readableName`（`general.basename` + `general.size_label`，
  即 `Qwen36_35B A3B`，比整串好认）、`architecture`、`sizeLabel`、`contextLength`、
  `quantization`（表里没有的编号不显示，比如 mmproj 的 32）。
- **新增**：扫描时按体积降序给前 40 个文件补元数据（`metaReads` 回报读了几次，
  `ggufMeta: false` 可关）。**Ollama 的条目已有 metadata 就跳过**，不为了同样的信息
  再开一遍 5GB 文件；即使读了也不让元数据顶掉 tag —— tag 是要发给 11434 的模型 id。
- **变更**：面板显示名优先级改为 `tags[0] → readableName → modelName → 文件名`，
  `general.name` 整串挪进悬停详情（它常常是 `…_REAP_0.25_V2_Agentic_…_Iter191_Fixed`
  这种内部编号，一行塞不下）。`models` 路由多回 `metaReads`。
- **修复**：投影文件（`local_model.mmproj.gguf`）现在也按 `general.type === 'mmproj'`
  认，不再只靠文件名里的 `.mmproj.` —— 名字被改掉时才算得准。
- **修复**：`readRange` 短读（文件被截断）不再把半截字节当值用，读到多少算多少。
- **测试**：`test/launcher.mjs` +6（真造 GGUF 字节流：真名/量化/上下文、长 chat_template
  之后的值照样读得到、字符串数组首条跨块时不把载荷当长度、非 GGUF / v1 / n_kv 离谱 → 空对象、
  紧凑名与 mmproj 判定、扫描接线可关可限次）；`test/panel-host.mjs` +1 组（面板透传
  `readableName`/`fullName`/`metaReads`）。真机验收：35B 报 `Qwen36_35B A3B` +
  Q4_K_M + `A3B` + ctx 262144，读 44 个键 / 16ms，整趟扫描 31ms。

## [0.4.5] - 2026-11-04

装了 Ollama 的机器上，「扫描本机模型」只列得出一个模型。不是扫描范围没覆盖到 ——
`~/AI/models` 本来就在 `modelRoots()` 里，Ollama 的权重就在它下面的 `ollama/blobs/` 里 ——
是**文件名根本不含后缀**：`sha256-a3de86cd1c13…`。而老代码判权重只认 `/\.gguf$/i`，
于是那 5.2GB 和 9.3GB 的模型在清单里彻底不存在，面板上还表现为「这台机器只有一个模型」。
更麻烦的是就算把它列出来也点不动：`adoptPanel` 硬挡 `只能选 .gguf 文件`。

### 新增

- **认权重加第二条判据：文件头魔数**。`readGgufMagic(path)` 读前 4 个字节，等于 `GGUF` 就算。
  不是「所有文件都开一下」—— 只有**没有点号的、且体积 ≥8MB** 的名字才去开（`minGgufBytes`，
  可用 io 覆盖），并且整趟扫描最多读 600 次（`maxMagic`）；明确不是权重的后缀
  （`.bin/.json/.md/.safetensors/…`）直接跳过，一次文件都不开。为什么不干脆全部读魔数：
  blobs 目录里那 7 个 manifest/vconfig 也是无后缀的 `sha256-*`，全读等于白烧 IO，
  而且靠大小猜「这个 120 字节的 sha256 是模型」会造出一堆打不开的假条目。
- **单独一趟 Ollama 清单解析**（`ollamaModelRoots` + `scanOllamaModels`）。不去 blobs 里猜，
  而是读 `manifests/` 与 `manifests-v2/`，只取 `mediaType === application/vnd.ollama.image.model`
  的层（明确排除 adapter/mmproj/projector 层），拿它的 digest 指回 `blobs/sha256-<digest>`。
  这样三件事同时解决了：**名字**（路径 `<host>/<ns>/<name>/<tag>` 还原成 `qwen3:14b`，
  `latest` 不加冒号）、**一个 blob 多 tag**（合并成一条，`tags` 列全）、**体积**
  （manifest 声明的 size 兜底，stat 拿不到也不至于 0）。根目录顺序：`OLLAMA_MODELS`
  环境变量排最前（很多人把 ollama 库指到大盘），然后 Windows
  `~/AI/models/ollama`・`%LOCALAPPDATA%\ollama\models`・`~/.ollama/models`，macOS
  `~/.ollama/models`・`/usr/share/ollama/.ollama/models`，Linux 再加
  `/usr/lib/ollama/models`・`/opt/ollama/models`。**判定「是不是 ollama 库」看有没有
  `manifests`/`manifests-v2`/`blobs`** —— 一个恰好叫 ollama 的普通目录不会被误认。
- **按 inode 去重**。同一份权重被硬链接到多处（ollama 与 workbuddy 共用盘时很常见）只列一次，
  赢家按「有没有名字」定：有 tag 的胜过 `sha256-…` 的；同名同 inode 时 ollama 的元数据会
  **合并进已有条目**（`mergeDuplicate`：补 tags、把 `sha256-*` 的名字换成可读名、补体积），
  而不是丢掉 ollama 那份信息。拿不到 `dev/ino`（假 fs、老内核）就退化成不去重，绝不瞎合并。
- **读 `<root>/metadata/sha256-<digest>.json` 的 kv**，带出 `general.name`、
  `general.architecture`、`<arch>.context_length`、量化标签。前端一行现在长这样：
  `qwen3:14b  [Ollama]  Q4_K_M  8.64G`。
- `models` 路由的每条结果新增 `source / origin / tags / readableName / engine / port /
  quantization / architecture / modelName / contextLength`（后五个没读到就不带，不给前端
  造一堆空字段）。

### 变更

- **`adoptPanel` 不再要求 `.gguf` 后缀**，改成三条判据：扩展名 → Ollama 清单里的名字 →
  文件头魔数，任一命中就放行；都不中才拒，且错误文案把三条都列出来（老文案只提 `.gguf`，
  用户看着自己硬盘上明明白白的模型却说「不是 gguf」，等于把 bug 报给用户）。
- **选中 Ollama 的模型时走 ollama，不再另起一份 llama-server**。这是这一版真正的取舍：
  blob 本身是合法 GGUF，硬喂 llama.cpp 也能起 —— 但那意味着同一个模型在显存里存在两份，
  还绕过 ollama 的加载与调度。所以插件只做「确认 11434 有 ollama 在应答（没有就按已知
  后端起 `ollama serve`）→ 用 **tag** 当模型 id → 注册成 `local-ollama-<slug>` → 试跑」。
  **用户显式填了别的端口就不抢**：那是要拿这份文件再起一个服务，照旧传路径走 llama.cpp。
  前端选行时端口自动跟到 `item.port`，别名提示也从「别名取文件名」变成分叉的
  「模型名取 tag：qwen3:14b（走 Ollama 的 11434，不再起一份 llama-server）」。

### 修复

- **`FILE_TYPE_LABELS` 量化表整体错位**：照搬了旧的 llama FILE_TYPE 序号，15 标成 `Q5_K_S`。
  真机 `ollama show qwen3:8b` 报 **Q4_K_M**，metadata 里 `general.file_type` 是 **15** ——
  那个数字就是 **ggml_type 枚举的原值**。按真实序号整表重写（`4/5` 是已移除的 Q4_2/Q4_3、
  `19` 空号，都不给标签；不认识的编号也不显示，宁可少说一个标签，别说错）。
- **Windows 上目录判定不可信**：原来用 `exists(dir + '/')` 区分文件与目录，实测
  `existsSync('<一个文件>/')` 在 Windows 返回 **true** —— 结果每个 manifest 都被当成目录递归，
  `scanOllamaModels` 一个模型都读不出来（`len 0`，还不报错）。改成**按内容分岔**：
  先 `readManifest` 试读（体积 >2MB 直接跳过），JSON 里有非空 `layers` 数组就是 manifest，
  否则才递归。顺带也不再依赖任何平台的尾斜杠语义。
- **假 fs 不再被拉去扫真实 Ollama 目录**：单测里 `exists: () => true` 会让三个标准位置全部
  「存在」，然后沿假树钻到 maxEntries 上限，**谎报 `truncated: true`**（打挂「没超限时不
  谎报截断」那条断言）。现在要求显式 `ollamaRoots` 或 `ollama: true` 才跑这一趟 ——
  传了自定义 fs 又没给 roots，就不去碰真实盘。

### 测试

- `test/launcher.mjs` 45 → **57 项**：tag 还原并指回 blob、量化 `Q4_K_M`、`latest` 不加冒号、
  同 blob 多 tag 合并、blob 不在盘上就不列、只有 adapter 层不算主模型、`exists:()=>true`
  （模拟 Windows 尾斜杠）仍能读到、主扫描与 ollama 合并后不重复、不给 roots 时不碰真实目录、
  魔数只收无后缀大文件且 `notes.md` 一次文件都不开、`ollamaModelFor` 正反斜杠都命中 /
  miss 与空串回 undefined / 给了 `io.models` 就不再扫盘、`ollamaModelRoots` 候选全是有效
  字符串 + 普通同名目录不算库 + `OLLAMA_MODELS` 排最前且原样用。
- `test/panel-host.mjs` 新增 **17b/17c/17d** 三组（adopt 一个真 blob → 端口跟到 11434、
  `already` 复用、`model` 是 tag、provider 是 ollama 后端；三种判据都不中才挡并带回路径；
  `models` 清单带出 tag/量化/引擎/端口/source），并在 `tmpdir` 里**现造一份真的 Ollama 存储**
  再把 `OLLAMA_MODELS` 指过去 —— 之前这类用例的结果取决于跑测试的机器装没装 ollama，
  现在跨机器一致。假 fetch 也按端口分叉（8090 报 `qwen3-4b`、11434 报 `qwen3:4b`），
  否则 `pickModel` 会靠「取第一个」兜底命中，测不到 tag 精确匹配这条真实路径。
- 真机验收（这台机器）：`scanLocalModels({depth:2, dirs:localModelDirs()})` 从 1 条变
  **4 条 / 4ms / truncated=false** —— `local_model.gguf 15.79G(workbuddy)`、
  `qwen3:14b 8.64G Q4_K_M(ollama)`、`qwen3:8b 4.87G Q4_K_M(ollama)`、
  `local_model.mmproj.gguf 0.84G(视觉投影)`；`ollamaModelRoots()` 命中
  `C:/Users/Lyonl/AI/models/ollama`（`OLLAMA_MODELS` 那条路）。


删除键改了对象。0.4.3 把它做成了「删磁盘上的 gguf」，这是理解错了 —— 需要的从来不是删
15.8GB 的权重文件，而是清掉 `llm-pi-ai` 里那几条僵尸 provider：指向一个从没起来过的端口、
同一个端口注册了两遍、或者模型文件早就没了还留着的那几条。删 gguf 是危险且不可撤销的，
删配置随时可以重新导入 —— 两个操作的风险差了一个量级，放在同一个按钮上是设计错误。

### 变更

- **删除键搬到 provider 表上**，`deleteLocalModel` 整个删掉（`lib/launcher.js` 里不再有
  `unlink` 的调用，`fsUnlinkSync` 的 import 也去掉了）。本机模型列表回到纯展示 + 选中，
  不再有删除入口 —— 权重文件是磁盘上的既有文件，插件不动它。
- **新增 `unregisterProvider({ settings, provider, ns })`**（`lib/provision.js`）。三条硬约束：
  1. 只能用 `settings.mutate(ns, [{ op: 'unset', path: ['providers', id] }], revision)`。
     `update` 走 `mergeLayers`，往 `providers[id]` 写 `null` 只会留下一个 null 的 provider 键，
     `llm-pi-ai` 的 loader 见到会当成配置错误而不是「没有这一条」。只有 `mutate` 的 `unset`
     内部是 `Reflect.deleteProperty`。
  2. **删完必须回读**。`unset` 对「来自下层（profile 的 `cordis.patch.yml` 或 home patch）的
     键」不是删除而是**恢复** —— 把下层的值原样 set 回来。表现出来就是「调用成功了但配置还在」。
     所以回读一次，键还在就回 `{ removed: false, inherited: true }` 并把原因指到那个文件，
     绝不谎报成功。
  3. 老版本 DSH 的 `settings` 没有 `mutate()` 时明说做不到，而不是假装删掉了。
- `deletePanel` 重写：入参从 `{ path }` 变成 `{ provider }`，删前先记下这条长什么样
  （`summarizeProvider`），删成功才清 `onlineCache` / `baseUrlCache` 并 `planAll()`
  （provider 表变了，工具面得重算），返回里带 `already` 标记与「磁盘上的 gguf 没动」。
- 面板：删除按钮挪到 provider 行，点两次确认（第一次变「确认删除？」），删中显示
  「删除中…」，点别的行撤回。`title` 上写明白「不删磁盘上的 gguf」，免得有人以为点了会丢模型。
- 测试：`test/launcher.mjs` 45 项（删掉三段 `deleteLocalModel` 用例）、`test/provision.mjs`
  新增 6b 段 8 条、`test/panel-host.mjs` 第 20 组重写成 13 条（含「没走 update 写 null」
  「`unset` 的 path 恰好是 `[providers, <id>]`」「别的 provider 一个没动」）。合计 **763 条断言**。

### 为什么记这一版

因为我先把「删除」的对象搞错了，而且错得很自然 —— 面板上列着 gguf，删除键就顺手接到了 gguf
上。真正该问的是「用户看着这一行，想让它消失的是什么」：是那条把 8090 指向一个不存在的
服务的配置，不是那个 15.8GB 的文件。顺带发现 `settings` 的两个隐式约定（删键只能 mutate、
继承来的键删不掉会静默恢复），这两条不写下来，下次还会用 `update` 写 `null` 然后困惑为什么
provider 表里多了一条 `null`。

## [0.4.3] - 2026-11-04

本机模型列表加删除键。上一版能扫出一堆 gguf、能一键配置，但删不掉 —— 想清磁盘只能
自己去资源管理器里找，而模型动辄 15–20GB，找错文件区的代价不小。

### 新增

- **`deleteLocalModel(io)`**（`lib/launcher.js`）和对应的第 13 条 bridge 路由
  `POST /api/dsh-local-trim/delete`。四个硬约束：
  1. 只认 `.gguf`（含 `.mmproj.gguf`）—— 目录本身永远不会被递归删除（`unlink` 而不是 `rm -rf`）；
  2. 必须落在扫描目录里（`modelDirsForPanel()` 的同一份清单）—— `../`、系统路径、
     以及前缀相像的兄弟目录（`/models-other` 之于 `/models`）一律拒；
  3. 文件已经不在了就如实回「已经不在了」，不谎报成功；
  4. `unlink` 抛错（`EBUSY` / `EPERM` / 只读盘）时把系统错误原样带回，不吞成一句「失败」。
- **面板把下拉换成列表**：每个 gguf 一行（体积、`偏大`、`视觉投影` 都标出来），点名字选中，
  右侧删除。删除要点两次 —— 第一次只把按钮变成「确认删除？」，因为删文件不进回收站、没有撤销。
  视觉投影 `mmproj` 也列出来（否则删不掉），但点它不会选中、也不能当主模型起服务。
- **删前告诉你谁在用**：`providersUsingModel()` 拿模型文件名去掉 `.gguf` 后的主干去比
  provider 里的 `models[].id`，命中就在结果里回「还有 N 个 provider 指着它（配置没动）」。
  这只是**提示**：别名和文件名一致是常见约定而非规范，所以既不用它阻止删除，也不自动改配置。
- 删成功后清在线缓存并**重扫一遍**，让列表反映磁盘真实状态，而不是本地先抹掉一行。
- **体积按量级换单位**：`formatBytes()` 挪进 `lib/status.js` 并导出（GB / MB / KB）。
  一开始所有体积都除以 1GiB，于是删掉一个 300MB 的小模型会说「已删除（0.3GB）」，
  删掉 2MB 的探针文件说「0.0GB」—— 数字没错但读起来像坏了。拿不到体积时回 `?`，
  不假装成零字节。
- **「删除中…」此前根本显示不出来**：`onDelete()` 在点击时先清了 `pendingDelete`，
  三元判断于是永远落到「删除」。改成按「这一行是否正在被删」判断（从 `busy` 里读路径）。
- 点别的行会撤回那次「确认删除？」，避免手快连点两个模型时删错。

### 为什么记这一版

这是插件里第一个真的会动用户磁盘、且**不可撤销**的操作。所以判据写得很窄：删什么（只 gguf）、
删哪（只扫描目录内）、失败说什么（原话），三条都在 `deleteLocalModel` 里而不是散在面板上 ——
面板能绕过，函数不能。成功路径的测试只用假 `unlink`（`test/launcher.mjs`），CI 上不会真的删文件；
宿主侧用例（`test/panel-host.mjs` 第 20 组）只验拒绝的那几条分支，外加一条「扫描目录内但不存在」
的路径 —— 它证明范围校验放行、存在性校验拦住，两个条件同时成立。

### 测试

- `test/launcher.mjs` 45 → **48** 项（`deleteLocalModel` 三条：正常删 + 路径归一化、四类拒绝、`unlink` 抛错）。
- `test/panel-host.mjs` 新增第 20 组 8 条断言；路由表从 12 条改成 13 条（此前漏了 `stop`，一并补上）。
- `test/panel.mjs` 36 → **37** 项（`formatBytes` 五档 + 三个「不知道」的兜底）。
- `npm run verify` 全绿，**749** 条断言。

## [0.4.2] - 2026-11-04

这一版把「只在本机跑得通」的地基换掉。v0.4.1 及以前的代码里到处是
`C:/Users/<USER>/...`、`llama-server.exe`、`nvidia-smi` 这种本机专属假设 ——
在别人的 Linux / macOS 机器上会表现为「扫不到模型 / 找不到二进制 / 一拉起就报参数错」。
不是因为逻辑错，而是因为规则根本不该写死。

### 修复

- **路径全靠 `process.env.USERPROFILE ?? 'C:/Users/' + USERNAME` 拼**。
  Linux/macOS 上这两个变量都不存在，会拼出 `C:/Users/.workbuddy/local-models`
  这种谁都不认识的路。新增 `homeDir()`（优先 `os.homedir()`）、`dataDir()`
  （Windows `LOCALAPPDATA` / macOS `~/Library/Application Support` / 其它 `XDG_DATA_HOME`）、
  `joinPath()`、`toSlash()`、`exeName()`，全部按 `process.platform` 推导。

- **`joinPath` 第一版把绝对路径的开头斜杠吃掉了**：`joinPath('/home/u','models')`
  得到 `home/u/models`，从绝对路径变成相对路径，落到 cwd 下。改成保留首段前导斜杠。

- **`KNOWN_LAUNCHERS` 的候选全是 Windows 路径**（`C:/Users/<U>/AI/ollama/ollama.exe`、
  `%LOCALAPPDATA%/LM-Studio/lms.exe`…），换机器只能靠 PATH 上的裸名字兜底。现在按平台给出
  官方安装位置，并且四个后端各认一个覆盖环境变量：`OLLAMA_BIN` / `LLAMA_SERVER_BIN` /
  `VLLM_BIN` / `LMSTUDIO_BIN`（指定后直接排最前）。

- **模型目录把 WorkBuddy 的布局当唯一来源**。新增 `modelRoots()`：`DSH_LOCAL_MODELS_DIR`
  优先，然后 `~/models`、`~/llama.cpp/models`、`~/.cache/llama.cpp`、`~/.lmstudio/models`、
  `<dataDir>/LM-Studio/models`，`~/.workbuddy/local-models` 降级成候选之一。
  `localModelDirs()` 全部改走它；新增配置项 `modelDirs`（数组，支持 `~`）让人补自己的目录。

- **`llamaCppAutoArgs` 只在 WorkBuddy 的 `files/` 下找 gguf**，别的机器上就算装了
  llama.cpp 也报「没有模型」。改成按 `modelRoots()` 顺序找第一个含 `.gguf`（排除 `.mmproj.`）的目录。

- **`planLaunch` 只认 `input.existsSync` 这一个注入名**，调用方传 `exists` 会被静默忽略
  （测试里就踩了：明明注入了假文件系统，还是报「没找到 llama-server」）。现在两个名都认，
  `scanLocalModels` 同理。

- **`detectGpuBytes` 只认 NVIDIA**。换 AMD 卡或 Apple Silicon 就永远拿 0，预检退化成
  「模型全额压内存」→ 好机器也被判 `warn`/`risky`。新增 `detectGpuInfo()`：
  NVIDIA `nvidia-smi` → AMD `rocm-smi --showmeminfo vram`（认字节数和 `GiB` 两种写法，
  带单位的那条必须先匹配，否则 `24.0 GiB` 会被纯数字规则读成 24 字节）→
  Apple Silicon `sysctl -n hw.memsize` 取四分之一并标 `unified: true` → 都没有返回 0。

- **参数能力按「本机实测」写死**。`--load-mode` / `--fit` 是新版 llama.cpp 才有的，
  老版本没有；反过来 `--no-mmap` 在新版本里已经非法。现在拼命令行前先跑
  `llama-server --help`，把出现的 `--flag` 全抠出来（`parseHelpFlags` / `probeHelpCaps`，
  按路径缓存），只拼它真认的那些；**探不出来就不裁剪**（宁可让引擎自己报错，也别因为
  探测失败丢掉好参数）。被裁掉的参数会出现在 `planLaunch` 返回的 `dropped` 里。

- **预检预留内存写死 2048 MiB**。改成配置项 `reserveMb`（0 = 不预留，Linux 服务器可调小）。

- **LM Studio 被归进「必须带模型参数」那一档**。它其实自带 `lms server start --port N`，
  模型是运行时按请求加载的，不需要启动参数。原来点拉起会直接回「需要模型文件才能起，
  插件不替你猜」—— 对 LM Studio 是纯误报。`KNOWN_LAUNCHERS` 的 `args` 因此允许写成
  `(port) => string[]`，交给 `resolveCommand` 之后求值（端口要传进去）。

- **失败提示里的示例命令一套逻辑套所有后端**。原来回给用户的是
  `-m 模型.gguf --host ... --port ...`，那是 llama.cpp 的写法；vLLM 认的是
  `--model <目录或仓库 id>` 且不做 gguf，照抄必报错。改成每个后端带自己的
  `exampleArgs` 与 `modelNoun`：vLLM 说「模型（目录或仓库 id）」，llama.cpp 说「模型文件」。

- **`joinPath(process.env.LOCALAPPDATA, ...)` 在非 Windows 上会拼出 `undefined/...`**。
  Ollama 与 LM Studio 的 Windows 候选都这么写过；虽然分支只在 WIN 下走，
  但变量缺失（精简镜像、被清空的环境）时依然会拼出相对路径。统一改走 `dataDir()`。

- **`--n-gpu-layers auto` 与 KV 量化被硬塞给老引擎**。`auto` 这个取值和 `--fit`
  是同一代加进来的；没有 `--fit` 的 llama.cpp 只认 `--n-gpu-layers` 的数字，
  KV 量化的类型表也窄（`q8_0` 未必在 allowed values 里）。能力探测只按 flag 名过滤，
  拦不住「flag 在、取值不在」。现在按 `--fit` 的有无分两套组合：老引擎给 `99` 层、
  不下发 `--cache-type-k/v`；新引擎保持 `auto` + `q8_0`。`llamaCppAutoArgs` 的返回值
  多了 `modernEngine`，日志里能看出走的是哪一套。

- **`parseHelpFlags` 只认长参数**。`-c` 是 `--ctx-size` 的短写，只抠 `--flag` 的话
  `-c 65536` 会被判成「引擎不支持上下文长度」整条裁掉 —— 真机 b11012 上就这么丢过，
  上下文悄悄退回引擎默认值。现在短参数（`-c` / `-m` / `-t`）也收，正则带捕获组
  （不带括号时 `match[1]` 是 undefined，直接崩）。

- **统一内存（Apple Silicon / 核显）被重复扣除显存**。`hostBytes = sizeBytes − gpuBytes`
  对独显成立，对统一内存就错：显存和内存是同一个池子，减一遍等于凭空多出余量。
  24GB 的 Mac 装 16GB 模型会被算成「只占 10GB」→ 判得比实际宽松。新增 `unified` 入参，
  为真时按 `sizeBytes` 全额比内存，上限也只算 `totalMemBytes` 一次。

- **`splitCommand` 不认 POSIX 的单引号与转义**。`'/opt/my tools/llama-server' -m x`
  这类命令在 Linux/macOS 上会被切碎成三段。现在非 Windows 平台认单引号与 `\\` 转义；
  Windows 保持原样（反斜杠是路径分隔符，不能当转义符）。

- **`reserveBytes: 0` 被当成「没填」**。配置项 `reserveMb: 0` 本意是不预留，
  但判据写的是 `> 0`，会被悄悄改回 2048 MiB。改成 `>= 0` 才算显式。

### 新增

- `test/portable.mjs`（35 项）：路径拼装、`modelRoots` / `DSH_LOCAL_MODELS_DIR`、
  候选表不含 `undefined`、`detectGpuInfo` 的三个厂商分支、`--help` 能力探测与裁剪、
  `reserveBytes` 可配、统一内存不重复扣显存、`LM Studio` 与 `ollama` 各自的固定参数。
  全部用假 platform / 假 exec，不依赖跑测试的机器是哪台。
- `test/platform-sim.mjs`：`Object.defineProperty(process, "platform", …)` 在 import 之前
  覆盖平台，让 `launcher.js` 顶部的 `const WIN/MAC` 按目标平台求值，然后逐个断言候选表
  ——别的平台不许吐出 `C:/` 或反斜杠、候选不能重复、最后一项必须是交给 PATH 的裸名。
  三个平台各跑一遍（`npm run test:portable`）。这是「不在 Windows 上也能验证非 Windows 分支」
  的唯一办法：`os.homedir()` 骗不到，所以家目录只断言格式不断言前缀。
- CI 增加 `Cross-platform paths, GPU detection, --help capability probing` 与
  `Platform simulation (linux / darwin / win32 candidate tables)` 两步；
- `test/fake-platform.mjs` + `test/run-sim.mjs`：用 `--import` 预加载改掉
  `process.platform`，把**整套测试**（不只候选表）按 linux / darwin 再跑一遍。
  `os.homedir()` 也是可以骗的，但必须改对变量：真实的 Windows 上它只认
  `USERPROFILE`（删掉反而退回真实家目录，`HOME` 完全不看），Linux/macOS 认 `HOME`。
  一开始只改 `HOME`，模拟 darwin 时家目录仍是 `C:/Users/<你>`，候选表里混进一堆
  `C:/...` —— 而这正是要抓的东西，等于这套测试白跑。现在两个都指到 `/sim/nobody`。
  这一层是被真机 CI 逼出来的：`test/portable.mjs` 里断言写 `endsWith("lms.exe")`，
  在 macOS runner 上 `exeName()` 不加后缀，直接红 —— 而本机是 Windows，永远发现不了。
  入口用 `node test/run-sim.mjs`，不是 `DSH_SIM_PLATFORM=… node …`：后者的前缀语法
  只在 POSIX shell 成立，Windows 的 npm script 会报「不是内部或外部命令」。
- `test/stranger.mjs`：把本机的所有有利条件全抹掉再跑一遍 —— 没有
  `nvidia-smi`/`rocm-smi`/`sysctl`、家目录里没有模型、`PATH` 是空的、三个平台各来一次。
  判据是「优雅退化」而不是「能跑」：显存探测失败要退化成 0 而不是 NaN，`--help` 探不到要
  返回 null（不裁剪任何参数）而不是全部丢掉，一个 gguf 都没有时要回 `no-model` 并列出
  找过的目录，`planLaunch` 失败要说清搜过哪些路径。别人的机器上第一眼看到的就是这些分支，
  而本机因为什么都有，永远走不到。
  另起一个 `cross-platform` job 在 **真的** `windows-latest` 与 `macos-latest` 上跑
  （Node 22，不参与 3×3 矩阵）：平台推演再像，也不等于真机 —— `homeDir()`、PATH 分隔符、
  可执行文件后缀这些只有真跑才知道。
- README 新增「跨平台」整节：支持矩阵、两个模型目录入口、四个二进制变量、
  `--help` 探测语义、三条显存探测路径、`reserveMb`。
- `.gitattributes`（`* text=auto eol=lf`）：此前仓库里 CRLF / LF 混合，每次 commit 都是整文件 diff。

### 为什么记这一版

「在本机能跑」和「在哪都能跑」之间隔着一整层平台假设。这一版之前，插件对下面这些东西
全都是默认的：家目录在哪、数据目录在哪、后端装在哪、模型放在哪、显存怎么问、参数支持哪些。
任何一个假设不成立，表现都是同一句话：「找不到 / 起不来」，而用户看不出是哪一环。
现在每一环都有明确的推导规则和覆盖开关，报错也能指到具体哪一环。

## [0.4.1] - 2026-11-04

v0.4.0 的资源预检建立在一个错误前提上，这一版把它连根改掉。

### 修复

- **`--no-mmap` 是非法参数，插件一点「一键配置」就必然起不来**（P0）。
  实测 b11012：`llama-server.exe --no-mmap` → `error: invalid argument: --no-mmap`。
  正确写法是 `--load-mode auto|none|mmap|mlock|mmap+mlock`（四个值用 `--version` 逐一验证均可解析）。
  新增 `LOAD_MODES` / `normalizeLoadMode()`，`--no-mmap` 只作为旧入口被转成 `--load-mode none`，
  再也不出现在拼出来的参数里。

- **`checkModelFit` 拿 gguf 全长比内存，把能跑的机器判成 `risky`**。
  实测这台机器：16.9GB gguf 正在跑 27.2B MoE，进程 WorkingSet 只有 285–691MB、
  Private 19GB 全是 file-backed 可回收页，系统 Available 还有 2.2GB，不爆不换页 ——
  因为热权重在显存里（VRAM 14289/14848MiB，util 87–93%，SM 时钟 2444/3003MHz）。
  新的口径是**显存装不下的那部分**：`hostBytes = sizeBytes − gpuBytes`，
  比 `max(totalmem − 2GB, freemem)`。硬拦只剩「显存 + 内存都装不下」；
  mmap 模式下装不下判 `warn`（照跑，只是开头慢）；`none` / `mlock` 判 `risky`（真吃 RAM）。

- **`detectGpuBytes()`**：`nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`，
  失败返回 0 让预检退化成「不算显存」而不是报错。宿主侧 60 秒缓存（面板每条模型都要问）。
  注意 `--query-compute-apps=used_memory` 在这台机器全报 `[N/A]`，只能问总量。

- **`adopt` 的 `sizeBytes` / `gpuBytes` / `totalMemBytes` 可从入参覆盖**。
  本来只给测试用，现在也是诊断手段：CI 的 runner 没有 nvidia-smi、内存只有 15.6GB，
  不覆盖的话「能跑的机器不该被判 risky」这条断言在 CI 上永远测不到。
  传入非正数或省略就回落真实探测，生产路径行为不变。

- **面板不再谎称「会改用 --no-mmap」**。`AdoptBox` 多一个「加载方式」下拉
  （空=引擎自己决定 / mmap / none / mlock / mmap+mlock），默认留空走 llama.cpp 的 auto ——
  默认关 mmap 才是真吃满内存。确认勾选框文案改「我知道会很慢」。

### 为什么要记这一版

v0.4.0 的 `risky` 判据和 `--no-mmap` 是同一个误解的两面：把「MoE 冷启动慢」当成
「权重太大装不下」。实测吞吐说明白了 —— 前 1000–2000 token 是预热（20 → 28 → 36 tok/s），
之后恒定 76 tok/s（prose 75.5 / 计数 76.2 / 代码 71.9），prefill 3215 token 674 tok/s，
预热完 IO Read 归零。判断依据是显存装不装得下，不是文件大小。

### 测试

- `test/launcher.mjs` 41 → 45 项：`--load-mode` 白名单与透传、`normalizeLoadMode` 六个边界、
  `noMmap` 兼容入口、`checkModelFit` 五档全部重写（含「这台机器真实数字 → ok」那条回归）。
- `test/panel-host.mjs` 19 → 20 组：第 16 组从「15.8GB 必然 risky」改成
  「15.8GB + 14.5GB 显存不再被误判」+ 新增 16b「塞 40GB 体积才拦，且不改 load-mode」。

## [0.4.0] - 2026-11-04

一次全量复盘之后的集中修复。触发点是一次真实的静态审计：13 项问题里有 3 个是**静默失效**
（不报错、日志照写、只是没干活），这类最值得先修。

### 修复

- **`trimAssembly` 的早退条件只比段数，不比内容**（严重）。
  原来判 `keptSections.length === sections.length && keptContexts.length === contexts.length`
  就 `return assembly` —— 段数没变时直接返回原对象，于是 `spliceInject` 换进去的一页纸注入
  和 `slimToolSchemas` 的瘦身结果**一起被丢掉**，日志里还写着「已裁剪」。
  现在同时比内容（逐项 `===`）和 tools 引用；只要任一不同就继续走完。
  复现：`dropSections: []` 时 `inject len: 4000`（原文没被替换）、`tool desc len 400`（期望 140）。

- **注入正文在 `apply` 时只算一次**（严重）。
  `const lightBody = resolveInject()` 写死在装载那一刻，之后改 `~/.dsh/local-llm/light-inject.md`
  必须重载插件；而面板改 `injectText` 却能实时生效 —— 同一个配置项两条路径两种行为。
  现在 `currentInject()` 每次调用都 `statSync` 一次（`mtime + size` 做 stamp，命中才复用），
  三处调用点全部改成现读。开销是一次 stat，换来「改完即生效」这条 README 第 387 行的承诺。

- **`runDetached` 的 env 在 Windows 上会拼出大小写双键**（地雷）。
  `{ ...process.env, ...(input.env ?? {}) }` 在 PowerShell 下展开出的键名是 `Path`，
  调用方再塞一个 `PATH` 就是两个键。Node 在 Windows 上按字面匹配，子进程实测直接
  `spawn -> null err: ENOENT` —— 连 `node` 都找不到。
  新增 `mergeEnv(base, extra)`：按大写归一化去重、后写覆盖先写、保留后写的键名、
  `undefined` 不覆盖。`whichOnPath` 也改走新增的 `envPathValue()`（`PATH` / `Path` / 任意
  `/^path$/i` 都认）。

### 新增

- **`stop` 路由（第 12 条）**。之前只能起不能停 —— 17GB 模型把机器拖死那次，面板毫无办法。
  只肯停**本插件自己 spawn 过**的 pid（内存表 `launched`），别人的 `ollama serve` 一概不动，
  回一句「端口 N 上没有本插件拉起的进程；手动起的后端请自己停」。
  先 `SIGTERM`，1.5 秒不退补 `SIGKILL`，还活着就如实报失败。
  面板上 provider 行多一个红色「停止」按钮，只在端口确实在表里时出现。

- **资源预检 `checkModelFit`**。`adopt` 起服务前拿模型体积比可用内存：
  比整机内存还大、或占 `max(freemem, totalmem − 2GB)` 的 80% 以上 → `risky`，
  **不替你起**，要勾「我知道会很卡」才继续；50%–80% → `warn`；拿不到体积 → `unknown`。
  `risky` 时自动加 `--no-mmap`（分页读盘，慢但不吃满内存）。`models` 路由每条模型也带这个结论。
  > 这一版的口径和 `--no-mmap` 都在 0.4.1 被推翻，见上。

- **`bridgeThrottleMs` 配置项**（默认 800）。重活路由两层节流：同一路由上一次没跑完直接拒，
  跑完 800ms 内再来也拒。前端连点不会在宿主机上堆叠起一堆 `llama-server`。设 0 关掉间隔限制。

- **`scanLocalModels` 三道上限**：`maxModels`（默认 300）、`maxEntries`（默认 20000）、
  `~/Downloads` 只扫一层。命中上限就停并在返回值上标 `truncated`，面板说「清单被截断」
  而不是假装扫全了。多了 `npm run check` / `npm test` / `npm run verify` 三个脚本，
  CI 的语法检查从手写 7 个文件改成 `lib/*.js client.js test/*.mjs` 全扫
  —— v0.3.0 加 `lib/config.js`、v0.3.2 加 `lib/defaults.js` 都漏过这份名单。

### 变更

- **`baseUrlCache` 加 30 秒 TTL**。原来只在 `savePanel` / `importPanel` / `launchPanel` 三处清，
  用户在「设置 → 模型」里自己改了 provider 地址之后，路由判定会一直拿旧地址，
  表现是「明明改成本机了，还是不裁剪」。
- **`checkPanel` 改 6 路并发**。原来 `for … await` 串行点灯，4 个本地 provider 全连不上时要
  干等 4 × 1.5 秒，面板转圈六秒。现在每批 6 个 `Promise.all`，单个异常不影响别人，
  外加 `probeEndpoint` 的 try/catch 兜底。
- **`launchTimeout` 夹到 3–600 秒**。原来只有 `Math.max(3, …)`，没上限。
  `waitForEndpoint` 超时且已经 spawn 了进程时，**把它回收掉**再报错（返回里带 `reaped: true`）。
- `statusPanel` 的 `status` 对象里新增 `launched` 数组，面板据此决定给不给「停止」按钮。
- `adoptPanel` 里 `const ctx = Number(...)` 与 `apply(ctx)` 的参数同名遮蔽，改名 `contextTokens`。
- `modelsPanel` 每条模型带 `fit`，顶层带 `truncated` / `scannedEntries`。

### 文档

- README「已知边界」补两条硬话：**资源预检是估算不是保证**（`os.freemem()` 不含 GPU 侧显存，
  本机 32GB 机器 Windows 只报 16.37GB 可见、其中 14.5GB 被 GPU 拿走）；**面板只能停自己起的进程**。
- 「开发」段补 `npm run verify`、6 套测试各自的覆盖面、`bridgeThrottleMs: 0` 为什么必须显式传。
- 控制面板章节的「五块」改成实际编号 ①–⑥（原来有两个 ⑤）。
- bridge 端点清单从 9 条更到 12 条，并写明节流语义。

### 测试

- `test/launcher.mjs` 21 → 41 项：`mergeEnv` 大小写覆盖 / `undefined` 不覆盖、
  `checkModelFit` 四档 + 拿不到体积、`--no-mmap` 只在显式要求时拼（0.4.1 起改 `--load-mode`）、`planLaunch` 透传、
  `stopProcess` 五种路径（SIGTERM 干净收尾 / 补 SIGKILL / 幂等 / 没 pid / 杀不死）、
  `isProcessAlive`（EPERM 算活着）、扫描三道上限、`envPathValue`。
- `test/panel-host.mjs` 16 → 19 组：`adopt` 预检拦截（真实读到这台机器上的 15.8GB 文件，
  `fit.ratio` 1.1 → `risky`）、`confirmHeavy` 之后继续、`stop` 拒绝别人的端口、
  `models` 带 `fit` / `truncated` / `scannedEntries`。

## [0.3.9] - 2026-11-02

- 新增「扫本机 gguf + 一键配置」：`scanLocalModels` 扫 6 个目录（WorkBuddy / AI / models /
  LM Studio ×2 / Downloads），跳过 `.mmproj.`，按体积降序；`adoptPanel` 起服务 → 等
  `/v1/models` → 按后端自报 id 注册 → 试跑，失败带 `stage`。
- `llamaCppAutoArgs` 支持显式 `modelPath`（选了就不再猜）；`planLaunch` 在「端口不在表里
  但给了 modelPath」时按 llamacpp 处理，并回**用户填的**端口而不是表里的。
- 修 `adopt` 在用户没填 provider id 时被塞进空值（原来按 `alias.length > 0` 判断，alias 恒有值）。
- 新增 `test/panel-host.mjs` 的 models / adopt 用例，`test/launcher.mjs` 21 项。
- 已知事故写进 README：真机 spawn 17GB 模型把机器拖死过一次。

## [0.3.7] - 2026-11-02

- `KNOWN_LAUNCHERS` 的 llamacpp 项改成函数式 `candidates(io)`，新增 `workbuddyBinary(io)`
  取 `~/.workbuddy/local-models/bin/` 下最新 build；新增 `llamaCppAutoArgs(io)` 自动捡模型。
- `resolveCommand(known, io)` 内部取 `io.exists`；`planLaunch` 在 `args === null` 时先找
  可执行文件再决定报「没装」还是「要模型」。
- 修 `candidate.includes('\\\\')` 双反斜杠的真 bug（判裸命令永远不成立）。
- `savePanel` 把 `overridden by a home patch` 映射成可执行提示。

## [0.3.2] - 2026-09-XX

- 控制面板全量重写：状态带六徽章、收益条、provider 点灯 + 试跑、导入区、折叠高级配置。
- 新增 `lib/status.js`（面板状态视图模型）与 `lib/import-model.js`（入参校验 → provider id →
  profile 拼装 → 试跑，含「思考模式吃掉正文」时换 `reasoning_effort` 再试一次）。
- `recordTrim` 只在进/出体积真变化时写日志（治掉 193KB 刷屏）。
- 新增 `test/panel.mjs`（36 项）与 `test/panel-host.mjs`（真跑 `apply`）。

## [0.3.1] - 2026-09-XX

- 修 CI：workflow 从不装依赖，而 v0.3.0 的 `lib/config.js` 顶层 import 了
  `@deepseek-ai/schemastery`（仅 devDependencies）→ `ERR_MODULE_NOT_FOUND`。
  加 `npm ci`，并补 `peerDependencies` + `peerDependenciesMeta.optional`
  （运行时由宿主提供，不给装插件的人拉第二份）。
- `package-lock.json` 首次入库。

## [0.3.0] - 2026-09-XX

- 控制面板雏形（`plugins.detail.section` 槽位 + 自建 HTTP bridge）。
- `lib/config.js` 全部字段 `.volatile()`（`dsh-settings` 的 `volatileForm` 只认 volatile 子树）。

## [0.2.x] - 2026-08-XX

- 四层裁剪成型：工具面 `tools.restrict` / 系统提示词段 / context / 工具 schema。
- 接管 `prompt.assemble`（有 `dsh-purge` 时装在它的 slot 外层，头 80 / 尾 96 兜底）。

## [0.1.0] - 2026-08-XX

- 首版：按 provider 判定本地端点，只对本地端点裁剪。
