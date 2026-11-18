#!/usr/bin/env node
/**
 * 假的 opencode 本机服务：只实现插件用到的那几条路由，覆盖两条通道。
 *
 * 刻意复刻真服务的三处易错细节（都是实测来的）：
 *  1. /api/event 的 types 是重复查询参数，逗号串会被判 400；
 *  2. SSE 帧之间用空行分隔，首帧恒为 server.connected；
 *  3. 会话的 permissions 决定工具是否静默执行：effect=allow 时真服务根本不发
 *     permission.asked，只有 ask 才发。插件要是以为 allow 也会问，就等于把
 *     「权限代答生效了」当成事实，而模型其实早就把文件写了。
 *
 * 路由匹配用路径分段而不是正则：这个文件被脚本反复改写过，正则里的反斜杠是事故源。
 *
 * @module test/mock-server.mjs
 */
import http from 'node:http'

/** SSE 帧分隔：两个换行。用字符码写出来，避免源码里的转义。 */
const SEP = String.fromCharCode(10, 10)

export const MOCK_MODELS = [
  { id: 'fake-free', providerID: 'opencode', name: 'Fake Free', type: 'chat',
    cost: [{ input: 0, output: 0 }], capabilities: { tools: true, input: ['text', 'image'], temperature: true },
    variants: [{ id: 'low' }, { id: 'high' }], status: 'active', enabled: true,
    limit: { context: 200000, output: 32000 } },
  { id: 'fake-paid', providerID: 'github-copilot', name: 'Fake Paid', type: 'chat',
    cost: [{ input: 1, output: 2 }], capabilities: { tools: true, input: ['text'], temperature: false },
    variants: [], status: 'active', enabled: true, limit: { context: 128000, output: 8192 } },
  { id: 'fake-disabled', providerID: 'opencode', name: 'Fake Disabled', type: 'chat',
    cost: [{ input: 0, output: 0 }], capabilities: { input: ['text'] }, variants: [],
    status: 'active', enabled: false, limit: { context: 1000, output: 100 } },
]

export const MOCK_AGENTS = [
  { id: 'build', name: 'Build', description: 'default agent', mode: 'primary', hidden: false },
  { id: 'plan', name: 'Plan', description: 'read-only planner', mode: 'primary', hidden: false },
  { id: 'title', name: 'Title', description: '', mode: 'primary', hidden: true },
]

function readText(req) {
  return new Promise(function (resolve) {
    let text = ''
    req.on('data', function (chunk) { text += chunk })
    req.on('end', function () { resolve(text) })
  })
}

function segments(pathname) {
  return pathname.split('/').filter(function (part) { return part !== '' })
}

/** 一条会话的剧本：由 prompt 文本决定走哪个结局。 */
function plan(prompt) {
  if (prompt.includes('BOOM-429')) return { kind: 'failed', error: { type: 'provider.rate_limit', message: 'Free usage limit reached', status: 429, retryAfterMs: 60000 } }
  if (prompt.includes('BOOM-REGION')) return { kind: 'failed', error: { type: 'provider.auth', message: 'This model is not available in your country', status: 403 } }
  if (prompt.includes('BOOM-STREAM-DEAD')) return { kind: 'stream-dies' }
  if (prompt.includes('BOOM-NO-ANSWER')) return { kind: 'succeeded', text: '   ', permissions: [] }
  const withPermissions = prompt.includes('PERM')
  return {
    kind: 'succeeded',
    text: withPermissions ? '带权限的回答' : 'agent 道回答',
    permissions: withPermissions ? ['read', 'bash'] : [],
    tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 40, write: 0 } },
  }
}

export function startMockServer() {
  const sessions = new Map()
  const subscribers = new Set()
  const state = {
    generateCount: 0, promptCount: 0, lastPrompt: undefined, lastVariant: undefined,
    permissionReplies: [], lastCreateBody: undefined, framesSent: 0, askMode: 'auto',
  }

  function publish(event) {
    const frame = 'data: ' + JSON.stringify(event) + SEP
    for (const res of subscribers) {
      try { res.write(frame); state.framesSent += 1 } catch { subscribers.delete(res) }
    }
  }

  function emit(sessionID, type, extra) {
    publish({
      id: 'evt_' + Math.random().toString(16).slice(2),
      type: type,
      created: Date.now(),
      data: Object.assign({ sessionID: sessionID }, extra),
    })
  }

  /**
   * 剧本执行。askMode 控制是否发 permission.asked：
   *  - auto  按会话的 permissions 决定（effect=ask 才发），与真服务一致
   *  - force 无论如何都发（测代答逻辑本身）
   *  - off   一定不发（测 allow 静默执行这条真实路径）
   */
  function runScript(sessionID, row, script) {
    setTimeout(function () {
      emit(sessionID, 'session.execution.started', {})
      if (script.kind === 'stream-dies') {
        for (const res of subscribers) { try { res.end() } catch { /* 已关 */ } }
        subscribers.clear()
        return
      }
      if (script.kind === 'failed') { emit(sessionID, 'session.execution.failed', { error: script.error }); return }
      const effects = Array.isArray(row.permissions) ? row.permissions.map(function (p) { return p.effect }) : []
      const asked = state.askMode === 'force' || (state.askMode === 'auto' && effects.includes('ask'))
      emit(sessionID, 'session.text.started', { ordinal: 0 })
      if (asked) {
        for (const action of script.permissions) emit(sessionID, 'permission.asked', { id: 'per_' + action, action: action, resources: ['x'] })
      }
      emit(sessionID, 'session.reasoning.started', { ordinal: 1 })
      emit(sessionID, 'session.reasoning.delta', { ordinal: 1, delta: '想一下' })
      emit(sessionID, 'session.reasoning.ended', { ordinal: 1, text: '想一下' })
      emit(sessionID, 'session.text.delta', { ordinal: 0, delta: script.text })
      emit(sessionID, 'session.text.ended', { ordinal: 0, text: script.text })
      emit(sessionID, 'session.step.ended', { tokens: script.tokens, finish: 'stop' })
      emit(sessionID, 'session.usage.updated', { tokens: script.tokens, cost: 0 })
      emit(sessionID, 'session.execution.succeeded', {})
    }, 30)
  }

  const server = http.createServer(async function (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const seg = segments(url.pathname)
    const method = String(req.method || 'GET').toUpperCase()
    const send = function (status, payload) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    const noContent = function () { res.writeHead(204); res.end() }
    const notFound = function () { res.writeHead(404); res.end() }

    if (seg[0] !== 'api') return notFound()

    if (seg[1] === 'info') return send(200, { version: '9.9.9-mock', pid: 1, hostname: 'mock' })
    if (seg[1] === 'model') return send(200, { data: MOCK_MODELS })
    if (seg[1] === 'agent') return send(200, { data: MOCK_AGENTS })

    if (seg[1] === 'event') {
      // 真服务把 types 当重复参数：一个值里塞逗号会被判 400（实测）。
      // 注意 getAll 对 '?types=a,b' 返回 ['a,b'] —— 长度非零，所以必须看内容里的逗号。
      const listed = url.searchParams.getAll('types')
      const comma = listed.some(function (value) { return value.includes(',') })
      if (comma) return send(400, { _tag: 'BadRequest', message: 'types must repeat' })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ id: 'evt_hello', type: 'server.connected', data: {} }) + SEP)
      subscribers.add(res)
      req.on('close', function () { subscribers.delete(res) })
      return undefined
    }

    if (seg[1] !== 'session') return notFound()

    if (method === 'POST' && seg.length === 2) {
      const body = JSON.parse((await readText(req)) || '{}')
      state.lastCreateBody = body
      const id = 'ses_mock_' + String(sessions.size + 1)
      sessions.set(id, { model: undefined, permissions: body.permissions, agent: body.agent })
      return send(200, { data: { id: id } })
    }
    if (method === 'GET' && seg.length === 2) return send(200, { data: [] })

    const id = seg[2] === undefined ? '' : decodeURIComponent(seg[2])
    const row = sessions.get(id)
    if (seg.length === 3) {
      if (method === 'DELETE') { sessions.delete(id); return noContent() }
      if (method === 'GET') {
        if (row === undefined) return send(404, { _tag: 'NotFoundError' })
        return send(200, { data: { id: id, model: row.model, agent: row.agent } })
      }
      return notFound()
    }
    if (row === undefined) return send(404, { _tag: 'NotFoundError' })

    const leaf = seg[3]

    if (leaf === 'model' && method === 'POST') {
      const body = JSON.parse(await readText(req))
      const entry = MOCK_MODELS.find(function (m) { return m.id === body.model.id })
      if (entry === undefined) return send(404, { _tag: 'NotFoundError', message: 'Unknown model' })
      if (body.model.variant !== undefined && entry.variants.every(function (v) { return v.id !== body.model.variant })) {
        return send(503, { _tag: 'ServiceUnavailableError', message: 'Variant unavailable for ' + entry.providerID + '/' + entry.id + ': ' + body.model.variant })
      }
      row.model = body.model
      state.lastVariant = body.model.variant
      return noContent()
    }

    if (leaf === 'generate' && method === 'POST') {
      state.generateCount += 1
      const body = JSON.parse(await readText(req))
      state.lastPrompt = body.prompt
      if (typeof body.prompt !== 'string' || body.prompt === '') return send(422, { _tag: 'BadRequest', message: 'prompt required' })
      if (body.prompt.includes('BOOM-429')) return send(429, { _tag: 'ProviderRequestError', reason: 'rate_limit', message: 'Free usage limit reached', retryAfterMs: 60000 })
      if (body.prompt.includes('BOOM-REGION')) return send(403, { _tag: 'ProviderRequestError', reason: 'auth', message: 'This model is not available in your country' })
      if (body.prompt.includes('BOOM-EMPTY')) return send(200, { data: { text: '   ' } })
      return send(200, { data: { text: 'mock 回答：' + String(body.prompt).slice(0, 24) } })
    }

    if (leaf === 'prompt' && method === 'POST') {
      state.promptCount += 1
      const body = JSON.parse(await readText(req))
      state.lastPrompt = body.text
      const script = plan(String(body.text || ''))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { id: 'msg_mock_1', sessionID: id, type: 'user', payload: { text: body.text } } }))
      runScript(id, row, script)
      return undefined
    }

    if (leaf === 'message' && method === 'GET') {
      const text = row.fallbackText === undefined ? '兜底文本' : row.fallbackText
      return send(200, { data: [{
        id: 'msg_a1', type: 'assistant', content: [{ type: 'text', text: text }],
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop',
      }], cursor: {} })
    }

    if (leaf === 'permission' && method === 'GET' && seg.length === 4) return send(200, { data: [] })
    if (leaf === 'permission' && seg.length === 6 && seg[5] === 'reply' && method === 'POST') {
      const body = JSON.parse((await readText(req)) || '{}')
      state.permissionReplies.push({ sessionID: id, permissionId: decodeURIComponent(seg[4]), decision: body.decision, message: body.message })
      return send(200, { data: {} })
    }

    if (leaf === 'interrupt' && method === 'POST') return send(200, { interrupted: true })
    return notFound()
  })

  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({
        url: 'http://127.0.0.1:' + String(server.address().port),
        sessions: sessions,
        subscribers: subscribers,
        state: state,
        setFallback: function (sessionID, text) { const one = sessions.get(sessionID); if (one !== undefined) one.fallbackText = text },
        close: function () {
          for (const res of subscribers) { try { res.end() } catch { /* 已关 */ } }
          subscribers.clear()
          return new Promise(function (done) { server.close(function () { done() }) })
        },
      })
    })
  })
}
