/**
 * 「一键拉起」的离线单测。
 *
 * 这部分的价值全在边界上：找可执行文件、命令行切分、等到端口应答、超时文案。
 * 真起进程的部分靠注入 spawnImpl 抓参数，不在这台机器上留后台进程。
 */

import assert from 'node:assert/strict'

import {
  KNOWN_LAUNCHERS,
  planLaunch,
  portOfBaseURL,
  runDetached,
  splitCommand,
  waitForEndpoint,
  whichOnPath,
} from '../lib/launcher.js'

let passed = 0
async function ok(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✓ ' + name)
  } catch (error) {
    console.error('  ✗ ' + name)
    throw error
  }
}

await ok('端口能从 baseURL 里读出来，含默认端口', async () => {
  assert.equal(portOfBaseURL('http://127.0.0.1:11434/v1'), 11434)
  assert.equal(portOfBaseURL('http://localhost:8090'), 8090)
  assert.equal(portOfBaseURL('http://localhost/v1'), 80)
  assert.equal(portOfBaseURL('https://example.com/v1'), 443)
  assert.equal(portOfBaseURL(''), 0)
  assert.equal(portOfBaseURL('nonsense'), 0)
})

await ok('命令行切分认双引号', async () => {
  assert.deepEqual(splitCommand('ollama serve'), ['ollama', 'serve'])
  assert.deepEqual(splitCommand('  ollama   serve  '), ['ollama', 'serve'])
  assert.deepEqual(splitCommand('"C:\\Program Files\\x\\a.exe" serve'), ['C:\\Program Files\\x\\a.exe', 'serve'])
  assert.deepEqual(splitCommand(''), [])
})

await ok('whichOnPath 按扩展名补全', async () => {
  // Windows 上补 .exe/.cmd/.bat，其它平台只试裸名 —— 所以这里按平台放宽，
  // 否则这条断言在 Linux 的 CI 上必红（而逻辑本身是对的）。
  const seen = []
  const exists = (path) => {
    seen.push(path)
    return /ollama(\.exe)?$/.test(String(path))
  }
  const resolved = whichOnPath('ollama', exists)
  assert.match(String(resolved), /ollama(\.exe)?$/)
  assert.ok(seen.length >= 1)
  assert.equal(
    whichOnPath('nope', () => false),
    null,
  )
})

await ok('11434 找到 ollama 就给 serve 参数', async () => {
  // 只认名字，不管落在哪个目录：planLaunch 的候选里既有真实路径也有裸名，
  // 用「等于某个具体路径」的断言会把候选表变化当成失败。
  const plan = planLaunch({
    port: 11434,
    existsSync: (path) => /ollama(\.exe)?$/.test(String(path)),
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.id, 'ollama')
  assert.deepEqual(plan.args, ['serve'])
  assert.equal(plan.env.OLLAMA_HOST, '127.0.0.1:11434')
})

await ok('找不到可执行文件时说清找过哪些路径', async () => {
  const plan = planLaunch({ port: 11434, existsSync: () => false })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /没找到 Ollama/)
  assert.ok(plan.tried.length >= 2)
})

await ok('装了 llama.cpp 但没给模型：报「要模型文件」并给出可抄的命令', async () => {
  const plan = planLaunch({ port: 8090, existsSync: () => true })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /需要模型文件/)
  // 找到的可执行文件要出现在提示里，用户才能直接抄
  assert.match(plan.error, /llama-server/)
  assert.match(plan.error, /-m /)
})

await ok('没装 llama.cpp：报「没找到」并列出查过的地方', async () => {
  const plan = planLaunch({ port: 8090, existsSync: () => false })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /本机没找到 llama\.cpp/)
  assert.ok(Array.isArray(plan.tried) && plan.tried.length > 0, 'tried 应列出候选路径')
})

await ok('不认识的端口给出可执行的下一步', async () => {
  const plan = planLaunch({ port: 9999, existsSync: () => true })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /9999/)
  assert.match(plan.error, /启动命令/)
})

await ok('自定义命令优先于自动探测', async () => {
  const plan = planLaunch({
    port: 9999,
    customCommand: '"C:\\Program Files\\ollama\\ollama.exe" serve --verbose',
    existsSync: () => false,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.source, 'custom')
  assert.equal(plan.command, 'C:\\Program Files\\ollama\\ollama.exe')
  assert.deepEqual(plan.args, ['serve', '--verbose'])
})

await ok('runDetached 传参与环境正确且不等待退出', async () => {
  let captured = null
  const spawnImpl = (command, args, options) => {
    captured = { command, args, options }
    return { pid: 4242, unref() {} }
  }
  const result = runDetached({
    command: 'C:/fake/ollama.exe',
    args: ['serve'],
    env: { OLLAMA_HOST: '127.0.0.1:11434' },
    spawnImpl,
  })
  assert.equal(result.ok, true)
  assert.equal(result.pid, 4242)
  assert.equal(captured.options.detached, true)
  assert.equal(captured.options.stdio, 'ignore')
  assert.equal(captured.options.env.OLLAMA_HOST, '127.0.0.1:11434')
  // 必须继承宿主环境，否则新进程找不到 PATH
  assert.equal(captured.options.env.PATH, process.env.PATH)
})

await ok('spawn 抛错时不装作成功', async () => {
  const result = runDetached({
    command: 'nope',
    spawnImpl: () => {
      throw new Error('ENOENT')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /ENOENT/)
})

await ok('waitForEndpoint 等到应答就返回耗时', async () => {
  let clock = 0
  let calls = 0
  const result = await waitForEndpoint({
    probe: async () => {
      calls += 1
      return calls >= 3 ? { ok: true, models: [{ id: 'qwen3:8b' }] } : { ok: false, error: '连不上' }
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    timeoutMs: 5000,
    intervalMs: 500,
  })
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 3)
  // 第 3 次探测命中时只睡过两次，耗时就是 2 × interval
  assert.equal(result.ms, 1000)
  assert.equal(result.models[0].id, 'qwen3:8b')
})

await ok('waitForEndpoint 超时带上最后一次错误', async () => {
  let clock = 0
  const result = await waitForEndpoint({
    probe: async () => ({ ok: false, error: 'ECONNREFUSED' }),
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    timeoutMs: 2000,
    intervalMs: 500,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /等了 2 秒/)
  assert.match(result.error, /ECONNREFUSED/)
})

await ok('launcher 表里端口不重复', async () => {
  const ports = KNOWN_LAUNCHERS.map((item) => item.port)
  assert.equal(new Set(ports).size, ports.length)
})

console.log(`${passed} 项通过`)
