/**
 * 用本机真实 opencode 服务跑一遍适配器：目录、每个免费模型一轮最小生成、状态与清理。
 * 这是验收证据；mock 测试证明契约形状，这里证明通道真的能出字。
 *
 * 用法：node test/live.mjs [--quick]
 */

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const quick = process.argv.includes('--quick')
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-live-'))

const registered = []
let configurable = []
let discovery = undefined
const disposers = []
const logs = []
const ctx = {
  logger: { info: function (m) { logs.push('info  ' + String(m)) }, warn: function (m) { logs.push('warn  ' + String(m)) } },
  fiber: { entry: { options: { id: 'local-opencode' } } },
  effect: function (setup) { disposers.push(setup()) },
  inject: function () {},
  get: function () { return undefined },
  llm: {
    registerAdapter: function (providers, adapter) {
      registered.push({ providers: providers, adapter: adapter })
      const disposer = function () { registered.length = 0 }
      disposer.replace = function (next) { registered[0].providers = next }
      return disposer
    },
    registerConfigurableProviders: function (entries) { configurable = entries; return function () { configurable = [] } },
    registerModelDiscovery: function (ns, fn) { discovery = { ns: ns, fn: fn }; return function () { discovery = undefined } },
    emitAdaptersUpdated: function () {},
  },
}

const plugin = await import('../index.js')
const handle = plugin.apply(ctx, { requestTimeoutMs: 120000 })
if (registered.length === 0) { console.error('插件没有注册路由（检查 enabled）'); process.exit(1) }
const adapter = registered[0].adapter

let catalog
try { catalog = await handle.refreshCatalog({ force: true }) } catch (error) {
  console.error('目录刷新失败：' + String((error && error.message) || error))
  console.error('（本机 opencode 没在跑？跑一次 opencode 或 opencode serve 再试）')
  process.exit(2)
}
const models = await adapter.listModels('local-opencode')
console.log('本机 opencode 免费模型 ' + models.length + ' 个：')
for (const m of models) console.log('  - ' + m.id + '   ' + m.name)

const failures = []
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '   ' + detail))
  if (ok !== true) failures.push(label)
}
async function oneRound(modelId, effort) {
  const chunks = []
  const options = {
    provider: 'local-opencode', model: modelId,
    reasoningEffort: effort,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回复四个字：本地通道' }] }],
    tools: [{ name: 'run_code', description: 'x', parameters: { type: 'object', properties: {} } }],
    signal: undefined,
  }
  const started = Date.now()
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return { chunks: chunks, ms: Date.now() - started }
}

const targets = quick ? models.slice(0, 3) : models
for (const model of targets) {
  const entry = handle.statusView().catalog.find(function (c) { return c.id === model.id })
  const effort = entry && entry.variants.length > 0 ? entry.variants[Math.min(1, entry.variants.length - 1)] : undefined
  const run = await oneRound(model.id, effort)
  const last = run.chunks[run.chunks.length - 1]
  const text = (run.chunks.find(function (c) { return c.type === 'text-delta' }) || {}).text
  const ok = last.reason && last.reason.kind === 'stop' && typeof text === 'string' && text.trim() !== ''
  check(model.id + ' 出字（' + String(run.ms) + 'ms' + (effort ? ' / ' + effort : '') + '）', ok, ok ? JSON.stringify(String(text).slice(0, 40)) : JSON.stringify(last.reason))
  if (ok) check(model.id + ' chunk 序列', JSON.stringify(run.chunks.map(function (c) { return c.type })) === JSON.stringify(['block-start', 'text-delta', 'block-end', 'usage', 'finish']))
}

const discovered = await discovery.fn({})
check('模型发现（GUI 检测模型）返回 ' + discovered.length + ' 个候选', discovered.length === models.length)
const status = handle.statusView()
check('状态：connected', status.connection.status === 'connected', status.connection.message)
console.log('   ' + status.connection.message)

for (const disposer of disposers) { if (typeof disposer === 'function') { const r = disposer(); if (r && typeof r.catch === 'function') await r.catch(function () {}) } }
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true })
console.log(failures.length === 0 ? String.fromCharCode(10) + 'ALL PASS（真实 opencode）' : String.fromCharCode(10) + 'FAILURES: ' + JSON.stringify(failures))
process.exit(failures.length === 0 ? 0 : 1)
