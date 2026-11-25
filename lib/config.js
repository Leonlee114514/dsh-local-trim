/**
 * 插件配置 schema。
 *
 * 只有声明了 `.volatile()` 的字段才能被宿主在运行时改写 —— `dsh-settings`
 * 的 `volatileForm(schema)` 只认 volatile 子树，普通字段写不进去，控制面板
 * 也就改不动。所以这里每个字段都带 `.volatile()`。
 *
 * 代价：宿主传进 apply() 的 config 里，这些字段不是值而是活引用
 * `{ get(), [write](v) }`，必须用 resolveConfig() 读，不能直接比较。
 */

import z from '@deepseek-ai/schemastery'

import {
  DEFAULT_DROP_CONTEXTS,
  DEFAULT_DROP_SECTIONS,
  DEFAULT_KEEP,
  TOOL_DESC_LIMIT,
  TOOL_PARAM_DESC_LIMIT,
} from './defaults.js'

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  /** [] = 自动识别本地端点；非空 = 只认这些 provider id。 */
  routes: z.array(z.string()).default([]).volatile(),
  keep: z.array(z.string()).default([...DEFAULT_KEEP]).volatile(),
  dropSections: z.array(z.string()).default([...DEFAULT_DROP_SECTIONS]).volatile(),
  dropContexts: z.array(z.string()).default([...DEFAULT_DROP_CONTEXTS]).volatile(),
  promptTrim: z.boolean().default(true).volatile(),
  schemaTrim: z.boolean().default(true).volatile(),
  toolDescLimit: z.number().default(TOOL_DESC_LIMIT).volatile(),
  toolParamDescLimit: z.number().default(TOOL_PARAM_DESC_LIMIT).volatile(),
  /** 空串 = 用 ~/.dsh/local-llm/light-inject.md，再没有就用内置默认。 */
  injectText: z.string().default('').volatile(),
  /**
   * true / false / { endpoint, provider, displayName, ... } 三态。
   * schemastery 没有 passthrough()，对象形态用 any() 收下。
   */
  provision: z.any().default(true).volatile(),
  autoDetectBaseURL: z.boolean().default(true).volatile(),
  selfCheck: z.boolean().default(true).volatile(),
  debugWrap: z.boolean().default(false).volatile(),
  /** 空串 = 面板按端口自动找后端；非空 = 原样执行这条命令（例：ollama serve）。 */
  launchCommand: z.string().default('').volatile(),
  /** 拉起后等端口应答的上限（秒）。模型冷加载慢就调大。3–600 之外会被夹回。 */
  launchTimeout: z.number().default(20).volatile(),
  /**
   * 「试跑」一轮请求的超时（秒）。默认 60：端口通了不等于能出字，第一次请求常常
   * 还在把权重读进内存（17GB 的模型冷加载比之后每次都慢得多）。超时后会自动再试一轮。
   * 5–600 之外会被夹回。
   */
  smokeTimeout: z.number().default(60).volatile(),
  /**
   * 重活路由（probe/check/import/test/launch/stop/models/adopt）的最小间隔（毫秒）。
   * 0 = 关掉间隔限制（并发去重仍然生效）。测试和脚本化调用可以设 0。
   */
  bridgeThrottleMs: z.number().default(800).volatile(),
  /**
   * 允许驱动控制面板的额外主机名（默认空 = 只认 localhost / 127.0.0.1 / [::1]）。
   *
   * 只在「要从别的机器打开 DSH 的 web GUI」时才需要填。填了之后
   * 这些名字的页面可以 POST 到 bridge —— 等于把面板的写入能力开给那台机器，
   * 所以别随手加公网域名。
   */
  trustedPanelHosts: z.array(z.string()).default([]).volatile(),
  /**
   * [P2-04-2026-11-26] 允许驱动面板的**对端地址**（默认空 = 只认回环）。
   *
   * 原来 bridge 只接了一个恒空的 `trustedPeers: new Set()`：`isBridgeRequestAllowed`
   * 里「非回环对端也放行」那条分支永远走不到，是条死代码。而只配 `trustedPanelHosts`
   * 在局域网里也不够 —— 别的机器打开 GUI 时 Host 是那台机器的名字（放行了），
   * 但 TCP 对端是 192.168.x.x，第 ① 道闸照样拒，配置看起来生效了其实没有。
   * 填法：一行一个地址（`192.168.1.23`），支持 `::ffff:` 前缀的映射形式。
   */
  trustedPanelPeers: z.array(z.string()).default([]).volatile(),
  /**
   * 资源预检给系统留的内存（MiB）。2048 是保守默认值：
   * 桌面 Windows + 宿主 + 浏览器差不多要这么多；Linux 服务器可以调小（1024），
   * 内存小的机器调大。0 = 不预留（只跟 free 内存比）。
   */
  reserveMb: z.number().default(2048).volatile(),
  /**
   * 额外要扫的模型目录（一行一个，支持 ~）。插件已经内建了各平台的常规位置
   * （~/models、~/llama.cpp/models、~/.lmstudio/models、LM Studio 数据目录…），
   * 这里只用来补「我把 gguf 放在别处」的情况。
   */
  modelDirs: z.array(z.string()).default([]).volatile(),
})

/**
 * 把宿主传进来的 config 摊平成普通对象。
 *
 * volatile 字段是 `{ get() }` 活引用，每次读都拿到当前值 —— 面板保存后
 * 不用重载插件，下一段请求就生效。
 *
 * [deep-resolve] 必须**递归**解，不能只解一层。
 *
 * 原来只对顶层做了一次 `.get()`：`provision` 是 `z.any()`（里面是
 * `{ endpoint, provider, displayName, autoProvision }`），拿到手仍然是一堆活引用。
 * 后果有两层：
 *   · 业务侧读 `values.provision !== false` 恒真 —— 面板里关掉 provision，
 *     对任何「对象形态」的配置都无效；
 *   · JSON 序列化把 `{ get(){}, [write](){} }` 压成 `{}`，`describe` 返回给面板的
 *     就是空对象，用户看到自己刚填的 endpoint 消失。
 *
 * 数组要单独走路：`Object.entries([])` 会产出 `{'0':…}` 这种假键，摊平后就
 * 不是数组了，z.array 字段全部退化成对象。
 */
export function resolveConfig(config) {
  return deepResolve(config, 0)
}

const MAX_RESOLVE_DEPTH = 6

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function deepResolve(value, depth) {
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_RESOLVE_DEPTH) return value
  // schema 对象 / 函数 / Promise 之类：不是「活引用容器」，原样交出。
  if (typeof value.get === 'function' && typeof value.set === 'function') {
    let inner
    try {
      inner = value.get()
    } catch {
      return undefined
    }
    return deepResolve(inner, depth + 1)
  }
  if (typeof value.get === 'function') {
    let inner
    try {
      inner = value.get()
    } catch {
      return undefined
    }
    return deepResolve(inner, depth + 1)
  }
  if (Array.isArray(value)) return value.map((item) => deepResolve(item, depth + 1))
  if (value instanceof Set) return [...value].map((item) => deepResolve(item, depth + 1))
  if (value instanceof Map) {
    const out = {}
    for (const [key, item] of value.entries()) out[String(key)] = deepResolve(item, depth + 1)
    return out
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = deepResolve(item, depth + 1)
  return out
}
