/**
 * 用最小 cordis 形状跑一遍插件，把 dsh llm 契约的每一条硬校验都验一次：
 * - registerAdapter 会逐个路由调 providerInfo / providerRetryPolicy（字段必须在顶层）；
 * - listModels / resolveModel 的返回受 normalizeModelInfo 严格校验（id 必须等于传入
 *   model、name 非空、contextWindow 正整数、efforts 非空且 id 唯一）；
 * - StreamChunk 序列：block-start -> text-delta -> block-end -> usage -> finish。
 *
 * @module test/mock-runtime.mjs
 */

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { startMockServer } from './mock-server.mjs'

const mock = await startMockServer()
process.env.OPENCODE_SERVER_URL = mock.url
process.env.OPENCODE_SERVER_PASSWORD = 'mockpw'
// 设置落盘指向一次性目录，测试不污染 ~/.dsh/local-opencode。
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-test-'))

const apiRoutes = []
const fakeWebServer = { register: function (route) { apiRoutes.push(route); return function () { apiRoutes.length = 0 } } }
const registered = []
let configurable = []
let discovery = undefined
const disposers = []

const ctx = {
  logger: { info: function (m) { console.log('[info] ' + String(m)) }, warn: function (m) { console.log('[warn] ' + String(m)) } },
  fiber: { entry: { options: { id: 'local-opencode' } } },
  effect: function (setup) { disposers.push(setup()) },
  inject: function (deps, cb) {
    // 真实 cordis：依赖的服务不存在时 fiber 一直 PENDING，不回调。
    if (deps.indexOf('webServer') < 0) return
    cb({ effect: function (setup) { disposers.push(setup()) }, webServer: fakeWebServer })
  },
  get: function () { return undefined },
  llm: {
    registerAdapter: function (providers, adapter) {
      for (const provider of providers) {
        const info = adapter.providerInfo(provider)
        if (info.id !== provider || typeof info.name !== 'string' || info.name.length === 0) throw new Error('INVALID_ADAPTER ' + provider)
        const policy = adapter.providerRetryPolicy(provider)
        for (const key of ['initialDelayMs', 'maxDelayMs', 'maxRetries']) {
          if (!Number.isFinite(policy[key])) throw new Error('policy.' + key + ' must be a top-level finite number')
        }
        if (!Array.isArray(policy.retryableCodes)) throw new Error('retryableCodes must be an array')
      }
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
const handle = plugin.apply(ctx, {})
const adapter = registered.length > 0 ? registered[0].adapter : undefined

const failures = []
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '   ' + detail))
  if (ok !== true) failures.push(label)
}
async function collect(options) {
  const out = []
  for await (const chunk of adapter.stream(options)) out.push(chunk)
  return out
}

await handle.refreshCatalog({ force: true })

const main = await adapter.listModels('local-opencode')
check('主组只收免费且启用的模型', main.length === 1 && main[0].id === 'opencode/fake-free', JSON.stringify(main.map(function (m) { return m.id })))
const paid = await adapter.listModels('local-opencode-paid')
check('计费组默认空（GUI 丢空组 = 选择器只见免费）', paid.length === 0, JSON.stringify(paid))
check('listModels 字段合法', main[0].provider === 'local-opencode' && main[0].name.length > 0 && Array.isArray(main[0].inputModalities), JSON.stringify(main[0]))

// 内核的真实入口是 prepareCall：它 await prepareCall 本身，然后**同步**校验返回的 .model。
// 少一个 await 就会把 Promise 交给校验，报 INVALID_MODEL_INFO（真机踩过）。
const preparedMessages = [{ role: 'user', content: [{ type: 'text', text: '你好，回一句话' }] }]
const prepared = await adapter.prepareCall('local-opencode', 'opencode/fake-free')
check('prepareCall().model 是已解析对象而不是 Promise', prepared.model && typeof prepared.model === 'object' && prepared.model.then === undefined, Object.prototype.toString.call(prepared.model))
check('prepareCall 的 model 通过内核同步校验的字段形状', prepared.model.provider === 'local-opencode' && prepared.model.id === 'opencode/fake-free' && typeof prepared.model.name === 'string' && prepared.model.name.length > 0, JSON.stringify(prepared.model && { p: prepared.model.provider, i: prepared.model.id }))
const viaPrepared = []
for await (const chunk of prepared.stream({ provider: 'local-opencode', model: 'opencode/fake-free', messages: preparedMessages })) viaPrepared.push(chunk)
check('prepared.stream 走的是一代快照并能出字', viaPrepared[viaPrepared.length - 1].reason.kind === 'stop', JSON.stringify(viaPrepared.map(function (c) { return c.type })))

const resolved = await adapter.resolveModel('local-opencode', 'opencode/fake-free')
check('resolveModel.id 必须等于传入 model', resolved.id === 'opencode/fake-free', resolved.id)
check('contextWindow 是正整数', Number.isInteger(resolved.context.contextWindow) && resolved.context.contextWindow > 0, JSON.stringify(resolved.context))
check('reasoning.efforts 非空且 id 唯一', resolved.reasoning && resolved.reasoning.efforts.length > 0 && new Set(resolved.reasoning.efforts.map(function (e) { return e.id })).size === resolved.reasoning.efforts.length, JSON.stringify(resolved.reasoning))

const messages = [{ role: 'user', content: [{ type: 'text', text: '你好，回一句话' }] }]
const good = await collect({ provider: 'local-opencode', model: 'opencode/fake-free', reasoningEffort: 'high', messages: messages, tools: [{ name: 'run_code', description: 'x', parameters: {} }] })
const types = good.map(function (c) { return c.type })
check('chunk 序列严格符合契约', JSON.stringify(types) === JSON.stringify(['block-start', 'text-delta', 'block-end', 'usage', 'finish']), JSON.stringify(types))
check('finish.kind=stop', good[good.length - 1].reason.kind === 'stop', JSON.stringify(good[good.length - 1].reason))
check('variant 透传成 opencode 档位', mock.state.lastVariant === 'high', String(mock.state.lastVariant))
check('prompt 里没有 tools 声明（无函数通道）', String(mock.state.lastPrompt).includes('run_code') === false)
check('历史被压平成文本', String(mock.state.lastPrompt).includes('你好，回一句话'), JSON.stringify(String(mock.state.lastPrompt).slice(0, 60)))
check('会话用完即删（不污染 opencode 历史）', mock.sessions.size === 0, 'left=' + String(mock.sessions.size))
check('usage 是不相交计数（估算而非上游）', good[3].usage.inputTokens > 0 && good[3].usage.outputTokens > 0 && good[3].usage.totalTokens === good[3].usage.inputTokens + good[3].usage.outputTokens, JSON.stringify(good[3].usage))

const badEffort = await collect({ provider: 'local-opencode', model: 'opencode/fake-free', reasoningEffort: 'ultra', messages: messages })
check('非法档位：本地拦下并说明可用档位', badEffort.length === 1 && badEffort[0].reason.kind === 'error' && /不支持思考档位/.test(badEffort[0].reason.failure.message), JSON.stringify(badEffort[0].reason.failure.message))

const rate = await collect({ provider: 'local-opencode', model: 'opencode/fake-free', messages: [{ role: 'user', content: [{ type: 'text', text: 'BOOM-429' }] }] })
check('上游 429 -> RATE_LIMIT', rate[rate.length - 1].reason.failure.code === 'RATE_LIMIT', JSON.stringify(rate[rate.length - 1].reason.failure))
check('带上 provider 的退避时长', rate[rate.length - 1].reason.failure.providerRetryAfterMs === 60000, String(rate[rate.length - 1].reason.failure.providerRetryAfterMs))
check('RATE_LIMIT 不进可重试集合（不把一次额度墙付三次）', adapter.providerRetryPolicy('local-opencode').retryableCodes.includes('RATE_LIMIT') === false)

const region = await collect({ provider: 'local-opencode', model: 'opencode/fake-free', messages: [{ role: 'user', content: [{ type: 'text', text: 'BOOM-REGION' }] }] })
check('区域拒绝 -> AUTH 且提示换出口', region[region.length - 1].reason.failure.code === 'AUTH' && /区域|出口/.test(region[region.length - 1].reason.failure.message), JSON.stringify(region[region.length - 1].reason.failure.message))

const empty = await collect({ provider: 'local-opencode', model: 'opencode/fake-free', messages: [{ role: 'user', content: [{ type: 'text', text: 'BOOM-EMPTY' }] }] })
check('空答 -> EMPTY_RESPONSE（内核可退避重试）', empty[empty.length - 1].reason.failure.code === 'EMPTY_RESPONSE', JSON.stringify(empty[empty.length - 1].reason.failure))

const ctrl = new AbortController()
ctrl.abort()
const cancelled = await collect({ provider: 'local-opencode', model: 'opencode/fake-free', messages: messages, signal: ctrl.signal })
check('取消收尾成 aborted', cancelled[cancelled.length - 1].reason.kind === 'aborted', JSON.stringify(cancelled[cancelled.length - 1].reason))

const unknown = await collect({ provider: 'local-opencode', model: 'opencode/nope', messages: messages })
check('目录外模型 -> NOT_FOUND 明确说明', unknown.length === 1 && unknown[0].reason.failure.code === 'NOT_FOUND', JSON.stringify(unknown[0].reason.failure))

const discovered = await discovery.fn({})
check('模型发现返回带容量的候选', Array.isArray(discovered) && discovered.length === 1 && discovered[0].contextWindow === 200000, JSON.stringify(discovered))
check('发现按插件 settingsNs 注册', discovery.ns === 'local-opencode', String(discovery.ns))
check('两条可配置路由都申报了', configurable.length === 2 && configurable[0].provider === 'local-opencode', JSON.stringify(configurable.map(function (c) { return c.provider })))

const status = handle.statusView()
check('状态报出连接与免费数量', status.connection.status === 'connected' && /1 个免费模型可用/.test(status.connection.message), status.connection.message)
check('状态暴露内置默认（UI 用）', status.defaults.enabled === true && status.defaults.includePaid.githubCopilot === false)

// 设置改到"纳入 Copilot 计费模型"后重刷：主组仍只含免费，付费组出现该模型。
handle.settingsUpdate({ includePaid: { githubCopilot: true } })
await handle.refreshCatalog({ force: true })
const paidNow = await adapter.listModels('local-opencode-paid')
check('includePaid.githubCopilot 生效：计费组出现 Copilot 模型', paidNow.length === 1 && paidNow[0].id === 'github-copilot/fake-paid', JSON.stringify(paidNow.map(function (m2) { return m2.id })))
const mainNow = await adapter.listModels('local-opencode')
check('主组仍只含免费模型（计费模型不混进免费组）', mainNow.length === 1 && mainNow[0].id === 'opencode/fake-free', JSON.stringify(mainNow.map(function (m2) { return m2.id })))
handle.settingsUpdate({ includePaid: { githubCopilot: false } })
await handle.refreshCatalog({ force: true })
check('关掉开关后计费组回到空组', (await adapter.listModels('local-opencode-paid')).length === 0)

// 设置必须落盘：重启后配置不丢（同一次写入去抖 200ms，等一秒）。
handle.settingsUpdate({ refreshMinutes: 0, requestTimeoutMs: 30000 })
await new Promise(function (r) { setTimeout(r, 400) })
const settingsFile = path.join(process.env.DSH_HOME, 'local-opencode', 'settings.json')
const persisted = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {}
check('设置改动会落盘（重启后仍在）', persisted.includePaid.githubCopilot === false && persisted.refreshMinutes === 0 && persisted.requestTimeoutMs === 30000, JSON.stringify(persisted))
check('未知设置键不会被写进去（normalize 白名单）', persisted.bogusKey === undefined && Object.keys(persisted).every(function (k) { return ['enabled', 'includePaid', 'refreshMinutes', 'requestTimeoutMs'].includes(k) }), JSON.stringify(Object.keys(persisted)))

// opencode 关掉时：路由必须还在，调用给出可读的失败，插件不炸。
await mock.close()
mockUrlDown()
function mockUrlDown() { process.env.OPENCODE_SERVER_URL = 'http://127.0.0.1:1' }
const down = await collect({ provider: 'local-opencode', model: 'opencode/fake-free', messages: messages })
check('opencode 掉线：明确 TRANSPORT 失败', down[down.length - 1].reason.failure.code === 'TRANSPORT', JSON.stringify(down[down.length - 1].reason.failure.message))
check('掉线后旧目录仍在（选择器不整组消失）', (await adapter.listModels('local-opencode')).length === 1)

// 状态面板：路由挂在 /api/local-opencode，围栏要挡住跨源调用。
check('状态面板路由已挂上', apiRoutes.length === 1 && apiRoutes[0].path === '/api/local-opencode', JSON.stringify(apiRoutes.map(function (r) { return r.path })))
const handler = apiRoutes.length > 0 ? apiRoutes[0].handler : undefined
function fakeReq(url, host, origin) {
  const headers = { host: host || '127.0.0.1:' + String(3000), }
  if (origin !== undefined) headers.origin = origin
  return { url: url, method: 'GET', headers: headers }
}
function fakeRes() {
  const box = { status: 0, headers: undefined, body: '' }
  box.writeHead = function (status, headers) { box.status = status; box.headers = headers }
  box.end = function (text) { box.body = String(text) }
  return box
}
if (handler !== undefined) {
  const ok = fakeRes()
  await Promise.resolve(handler(fakeReq('/api/local-opencode/status'), ok))
  check('status 路由回 JSON', ok.status === 200 && JSON.parse(ok.body).connection.status !== undefined, String(ok.status))
  const cross = fakeRes()
  await Promise.resolve(handler(fakeReq('/api/local-opencode/status', '127.0.0.1:3000', 'http://evil.example'), cross))
  check('跨源 Origin 被围栏挡住(403)', cross.status === 403, String(cross.status))
  const unknown = fakeRes()
  await Promise.resolve(handler(fakeReq('/api/local-opencode/nope'), unknown))
  check('未知路径 404', unknown.status === 404, String(unknown.status))
}

// enabled=false 时不注册路由（模型从选择器消失，但插件仍能起来）。
{
  const quiet = { info: function () {}, warn: function () {} }
  const seen = []
  const offCtx = {
    logger: quiet,
    fiber: { entry: { options: { id: 'local-opencode' } } },
    effect: function (setup) { setup() },
    inject: function () {},
    get: function () { return undefined },
    llm: {
      registerAdapter: function (providers) { seen.push(providers); return function () {} },
      registerConfigurableProviders: function () { return function () {} },
      registerModelDiscovery: function () { return function () {} },
      emitAdaptersUpdated: function () {},
    },
  }
  const offHandle = plugin.apply(offCtx, { enabled: false, refreshMinutes: 0 })
  check('enabled=false 不注册任何路由', seen.length === 0, JSON.stringify(seen))
  check('enabled=false 时 statusView 仍报告未注册', offHandle.statusView().registered === false, String(offHandle.statusView().registered))
}

for (const disposer of disposers) { if (typeof disposer === 'function') { const r = disposer(); if (r && typeof r.catch === 'function') await r.catch(function () {}) } }
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true })

console.log(failures.length === 0 ? String.fromCharCode(10) + 'ALL PASS' : String.fromCharCode(10) + 'FAILURES: ' + JSON.stringify(failures))
process.exit(failures.length === 0 ? 0 : 1)
