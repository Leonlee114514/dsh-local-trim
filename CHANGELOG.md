# 变更记录

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号走 SemVer。
每条都写「为什么」而不只是「改了什么」—— 这个插件的坑大多来自 DSH 宿主的隐式约定，
不记下来下次还会踩。

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
