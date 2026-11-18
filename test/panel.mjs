#!/usr/bin/env node
/**
 * 面板与通道的契约测试：假 cordis + 假 opencode，走插件真实的 api 处理器。
 *
 * 为什么单独一套：侧栏的两个新功能（模型显示/不显示、文本道/agent 道切换）都是
 * 「设置改了必须立刻反映到选择器和下一轮调用」的链路。链路跨四个模块
 * （路由 → settings → membershipFor → 适配器分叉），任何一环漏了，界面上都是一个
 * 点了没反应的按钮 —— 而那种失败在别处全是绿的。
 *
 * @module test/panel.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { startMockServer } from './mock-server.mjs'

const mock = await startMockServer()
process.env.OPENCODE_SERVER_URL = mock.url
process.env.OPENCODE_SERVER_PASSWORD = 'mockpw'
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-panel-'))

const registered = []
let emitCount = 0
const disposers = []
const apiMounts = []
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  fiber: { entry: { options: { id: 'dsh-local-opencode' } } },
  effect: (setup) => { disposers.push(setup()) },
  inject: (deps, cb) => {
    if (deps.indexOf('webServer') < 0) return
    cb({
      effect: (setup) => { disposers.push(setup()) },
      webServer: { register: (route) => { apiMounts.push(route); return () => { apiMounts.length = 0 } } },
    })
  },
  get: () => undefined,
  llm: {
    registerAdapter: (providers, adapter) => {
      registered.push({ providers: providers, adapter: adapter })
      const dispose = () => { registered.length = 0 }
      dispose.replace = () => {}
      return dispose
    },
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => () => {},
    emitAdaptersUpdated: () => { emitCount += 1 },
  },
}

const plugin = await import('../index.js')
const handle = plugin.apply(ctx, { refreshMinutes: 0 })
const adapter = registered[0].adapter
const api = handle.api

let failed = 0
function check(label, ok, detail) {
  if (ok !== true) failed += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '   ' + detail))
}
function request(method, pathname, body, extraHeaders) {
  const res = {
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) { res.status = status; res.headers = headers },
    end(text) { res.body = String(text || '') },
  }
  const text = body === undefined ? '' : JSON.stringify(body)
  let ended = false
  const req = {
    method: method,
    url: pathname,
    headers: Object.assign({ host: '127.0.0.1:3080' }, extraHeaders || {}),
    setEncoding() {},
    destroy() {},
    /**
     * 注册即回放：readBody 是在 api() 内部才挂监听器的，而调用方没法预知那一刻。
     * 真实可读流正是这个语义（订阅后继续收到后续数据），所以这里在注册时把已备好
     * 的 body 排进微任务。上一版先把数据推完再挂监听器，body 就此丢失，
     * readBody 永不 resolve，整套测试卡死在第二个用例。
     */
    on(event, listener) {
      if (event === 'data') {
        if (text !== '') queueMicrotask(() => listener(text))
        return
      }
      if (event === 'end') {
        queueMicrotask(() => { if (ended === false) { ended = true; listener() } })
        return
      }
      if (event === 'error') return
      throw new Error('panel request: unexpected event ' + event)
    },
  }
  return Promise.resolve()
    .then(() => api(req, res))
    .then(() => {
      let parsed
      try { parsed = JSON.parse(res.body) } catch { parsed = undefined }
      return { status: res.status, json: parsed, raw: res.body }
    })
}
const drain = async (options) => { const out = []; for await (const chunk of adapter.stream(options)) out.push(chunk); return out }

await handle.refreshCatalog({ force: true })
const FREE = 'opencode/fake-free'
const listIds = async () => (await adapter.listModels('local-opencode')).map((model) => model.id)

// 1) 侧栏要的可见性清单：含隐藏项，且只有可拨的才标 toggleable
const rows0 = handle.statusView().visibility
check('visibility 列出全部条目（含不显示的）', rows0.length === 3, JSON.stringify(rows0.map((r) => r.id + ':' + r.group)))
check('免费项可拨，未纳入/停用的不可拨', rows0.filter((r) => r.toggleable).length === 1, JSON.stringify(rows0.map((r) => r.toggleable)))

// 2) 不显示 → 选择器立刻少一个，且宿主被通知
const hidden0 = emitCount
const off = await request('POST', '/api/local-opencode/visibility', { id: FREE, hidden: true })
check('隐藏返回 200', off.status === 200, String(off.status))
check('隐藏后从路由消失', (await listIds()).includes(FREE) === false, JSON.stringify(await listIds()))
check('隐藏后设置落盘（重启不回弹）', JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME, 'local-opencode', 'settings.json'), 'utf8')).hiddenModels.includes(FREE))
check('隐藏会通知宿主重读拓扑', emitCount > hidden0, 'emit=' + emitCount)
const rowsHidden = handle.statusView().visibility.find((r) => r.id === FREE)
check('界面仍看得见被隐藏的项', rowsHidden.group === 'hidden' && rowsHidden.hidden === true && rowsHidden.toggleable === true)

// 3) 显示 → 回来
await request('POST', '/api/local-opencode/visibility', { id: FREE, hidden: false })
check('拨回后重新出现在选择器', (await listIds()).includes(FREE) === true)

// 4) 未知 id 必须被拒：拼错的 id 会安静地躺在隐藏清单里没人能清掉
const bogus = await request('POST', '/api/local-opencode/visibility', { id: 'opencode/no-such', hidden: true })
check('目录外的 id 被拒 404', bogus.status === 404, String(bogus.status))
check('拒掉的 id 没进隐藏清单', handle.settings.get().hiddenModels.includes('opencode/no-such') === false)

// 5) 默认通道 = 无工具文本道：走 generate，不碰 prompt
const textRun = await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] })
check('默认走文本道', mock.state.generateCount === 1 && mock.state.promptCount === 0, 'gen=' + mock.state.generateCount + ' prompt=' + mock.state.promptCount)
check('文本道 prompt 声明不支持工具', String(mock.state.lastPrompt).includes('不支持函数调用'))
const lastText = textRun[textRun.length - 1]
check('文本道正常收尾', lastText.reason.kind === 'stop', JSON.stringify(lastText.reason))

// 6) 切到 agent 道：走 prompt + 事件流，并且 generate 不再被碰
const sw = await request('POST', '/api/local-opencode/channel', { channel: 'agent' })
check('通道切换返回 200 且标记 changed', sw.status === 200 && sw.json.changed === true, JSON.stringify({ st: sw.status, ch: sw.json && sw.json.changed }))
check('切换立即落盘', JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME, 'local-opencode', 'settings.json'), 'utf8')).channel === 'agent')
const genBefore = mock.state.generateCount
const agentRun = await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: '看看文件' }] }] })
check('agent 道走 prompt 而不是 generate', mock.state.generateCount === genBefore && mock.state.promptCount === 1, 'gen=' + mock.state.generateCount + ' prompt=' + mock.state.promptCount)
const types = agentRun.map((chunk) => chunk.type)
check('agent 道产出含推理块与文本块', types.includes('reasoning-delta') === true && types.includes('text-delta') === true, JSON.stringify(types))
const seqOk = JSON.stringify(types) === JSON.stringify(['block-start', 'block-start', 'reasoning-delta', 'block-end', 'text-delta', 'block-end', 'usage', 'finish'])
check('agent 道 chunk 序列合法', seqOk, JSON.stringify(types))
const answer = agentRun.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
check('agent 道答案到手', answer === 'agent 道回答', JSON.stringify(answer))
check('agent 道 prompt 说明由 opencode 执行工具', String(mock.state.lastPrompt).includes('opencode') && String(mock.state.lastPrompt).includes('真实运行'))
const created = mock.state.lastCreateBody
check('agent 道建会话下发 permissions', Array.isArray(created.permissions) === false || created.permissions.length > 0, JSON.stringify(created.permissions))
check('agent 道用完即删会话', mock.sessions.size === 0, 'left=' + mock.sessions.size)

// 7) 权限策略真的传到 permissions，且 allow 下不发 ask（真实静默执行）
await request('POST', '/api/local-opencode/agent-settings', { permissionMode: 'allow-all' })
mock.state.askMode = 'auto'
const before = mock.state.permissionReplies.length
await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM 改文件' }] }] })
check('allow-all 下发 effect=allow', mock.state.lastCreateBody.permissions[0].effect === 'allow', JSON.stringify(mock.state.lastCreateBody.permissions))
check('allow 下没有代答（工具静默执行，与真服务一致）', mock.state.permissionReplies.length === before, 'replies=' + mock.state.permissionReplies.length)
await request('POST', '/api/local-opencode/agent-settings', { permissionMode: 'allow-read' })
const readReplies = []
mock.state.askMode = 'auto'
await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM 改文件' }] }] })
for (const reply of mock.state.permissionReplies.slice(before)) readReplies.push(reply.permissionId + '=' + reply.decision)
check('allow-read 下 read 放行一次、bash 拒绝', readReplies.includes('per_read=once') === true && readReplies.includes('per_bash=reject') === true, JSON.stringify(readReplies))
// reject 的真实语义：插件下发 effect=deny，opencode 自己就把工具拒了，
// 根本不会问 —— 所以这里断言的是【没有代答】而不是【代答全是 reject】。
// （真机实测：显式 deny 下文件没被写、也没有 pending permission。）
await request('POST', '/api/local-opencode/agent-settings', { permissionMode: 'reject' })
const beforeReject = mock.state.permissionReplies.length
const rejRun = await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: 'PERM 改文件' }] }] })
check('reject 下发 effect=deny', mock.state.lastCreateBody.permissions[0].effect === 'deny', JSON.stringify(mock.state.lastCreateBody.permissions))
check('reject 下无需代答（服务端自己拒）', mock.state.permissionReplies.length === beforeReject, 'added=' + (mock.state.permissionReplies.length - beforeReject))
check('reject 下仍拿到答案', rejRun.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') !== '')

// 8) 非法的通道/权限值被 normalize 挡掉，不会把设置写成垃圾
await request('POST', '/api/local-opencode/channel', { channel: 'turbo' })
check('非法通道值被忽略', handle.settings.get().channel === 'agent', handle.settings.get().channel)
await request('POST', '/api/local-opencode/agent-settings', { permissionMode: 'yolo' })
check('非法权限值被忽略', handle.settings.get().permissionMode === 'reject', handle.settings.get().permissionMode)

// 9) 工作目录：不存在要拒，存在才收
await request('POST', '/api/local-opencode/agent-settings', { workingDirectory: 'Z:\\no-such-dir-here' })
check('不存在的工作目录被拒', handle.settings.get().workingDirectory === '', JSON.stringify(handle.settings.get().workingDirectory))
await request('POST', '/api/local-opencode/agent-settings', { workingDirectory: os.tmpdir() })
check('存在的工作目录被接受', handle.settings.get().workingDirectory === os.tmpdir().replace(/[\\/]+$/, '') || handle.settings.get().workingDirectory !== '')
// 工作目录要真的进建会话体：留空则不带 location（沿用服务自己的位置）。
await request('POST', '/api/local-opencode/channel', { channel: 'agent' })
await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: '位置测试' }] }] })
check('设了工作目录后建会话带 location', (mock.state.lastCreateBody.location || {}).directory !== undefined, JSON.stringify(mock.state.lastCreateBody.location))
await request('POST', '/api/local-opencode/agent-settings', { workingDirectory: '' })
await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: '位置测试2' }] }] })
check('清空工作目录后不再下发 location', mock.state.lastCreateBody.location === undefined, JSON.stringify(mock.state.lastCreateBody.location))
await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: 'agent 名测试' }] }] })
check('agentName 留空时不覆盖服务默认', mock.state.lastCreateBody.agent === undefined, JSON.stringify(mock.state.lastCreateBody.agent))
await request('POST', '/api/local-opencode/agent-settings', { agentName: 'plan' })
await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: 'agent 名测试2' }] }] })
check('agentName 设了就传给 opencode', mock.state.lastCreateBody.agent === 'plan', JSON.stringify(mock.state.lastCreateBody.agent))
await request('POST', '/api/local-opencode/agent-settings', { agentName: '' })

// 10) 断流兜底：事件流提前结束时改读会话消息
mock.state.askMode = 'off'
const fallback = await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: 'BOOM-STREAM-DEAD' }] }] })
const fbText = fallback.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
check('断流后用消息兜底出字', fbText === '兜底文本', JSON.stringify(fbText))
const fbFinish = fallback[fallback.length - 1]
check('兜底轮仍正常收尾', fbFinish.reason.kind === 'stop', JSON.stringify(fbFinish.reason))

// 11) 空答：agent 道不得把空白当成功
const empty = await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: 'BOOM-NO-ANSWER' }] }] })
const emptyFinish = empty[empty.length - 1]
check('agent 空答归 EMPTY_RESPONSE', emptyFinish.reason.kind === 'error' && emptyFinish.reason.failure.code === 'EMPTY_RESPONSE', JSON.stringify(emptyFinish.reason))

// 12) 上游失败：事件流里的 failed 要翻成内核分类
const boom = await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: 'BOOM-429' }] }] })
check('agent 道 429 归 QUOTA', boom[boom.length - 1].reason.failure.code === 'QUOTA', JSON.stringify(boom[boom.length - 1].reason.failure))

// 13) agents 端点过滤 hidden（侧栏下拉不能出现内部 agent）
const agents = await request('GET', '/api/local-opencode/agents')
check('agents 端点过滤 hidden', agents.status === 200 && agents.json.agents.length === 2 && agents.json.agents.every((a) => a.id !== 'title'), JSON.stringify(agents.json && agents.json.agents.map((a) => a.id)))
check('statusView 带出 agentName 选项源', Array.isArray(handle.statusView().agents) && handle.statusView().agents.length === 2)

// 14) 通道切回文本道后，agent 端点不再被调用
await request('POST', '/api/local-opencode/channel', { channel: 'text' })
const promptsBefore = mock.state.promptCount
await drain({ provider: 'local-opencode', model: FREE, messages: [{ role: 'user', content: [{ type: 'text', text: '再试' }] }] })
check('切回文本道后不再走 agent 循环', mock.state.promptCount === promptsBefore && mock.state.generateCount >= 2, 'prompt=' + mock.state.promptCount + ' gen=' + mock.state.generateCount)

// 15) 面板路由也在围栏后面
const mounts = apiMounts.length === 1 && apiMounts[0].path === '/api/local-opencode'
check('面板 API 仍挂在同一个前缀下', mounts, JSON.stringify(apiMounts.map((m) => m.path)))
const cross = await request('POST', '/api/local-opencode/visibility', { id: FREE, hidden: true }, { origin: 'http://evil.example' })
check('跨源调用面板路由被拒', cross.status === 403, String(cross.status))

await mock.close()
for (const dispose of disposers) { if (typeof dispose === 'function') { const r = dispose(); if (r && typeof r.catch === 'function') await r.catch(() => {}) } }
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true })
console.log(failed === 0 ? String.fromCharCode(10) + 'panel: clean' : String.fromCharCode(10) + 'panel FAILURES: ' + failed)
process.exit(failed === 0 ? 0 : 1)
