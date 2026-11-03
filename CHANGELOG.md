# 变更记录

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号走 SemVer。
每条都写「为什么」而不只是「改了什么」—— 这个插件的坑大多来自 DSH 宿主的隐式约定，
不记下来下次还会踩。

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
  `checkModelFit` 四档 + 拿不到体积、`--no-mmap` 只在显式要求时拼、`planLaunch` 透传、
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
