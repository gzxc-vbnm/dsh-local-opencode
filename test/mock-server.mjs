/**
 * 假的 opencode 本机服务：只实现插件用到的那几条路由，用来在无真 opencode 的环境里
 * 跑契约测试；也能主动制造 429 / 503 / 档位不存在这些形状。
 *
 * @module test/mock-server.mjs
 */

import http from 'node:http'

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

function readText(req) {
  return new Promise(function (resolve) {
    let text = ''
    req.on('data', function (chunk) { text += chunk })
    req.on('end', function () { resolve(text) })
  })
}

export function startMockServer() {
  const sessions = new Map()
  const state = { generateCount: 0, lastPrompt: undefined, lastVariant: undefined, closed: false }

  const server = http.createServer(async function (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = function (status, payload) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (url.pathname === '/api/info') return send(200, { version: '9.9.9-mock', pid: 1, hostname: 'mock' })
    if (url.pathname === '/api/model') return send(200, { data: MOCK_MODELS })

    if (url.pathname === '/api/session' && req.method === 'POST') {
      const id = 'ses_mock_' + String(sessions.size + 1)
      sessions.set(id, { title: undefined, model: undefined })
      return send(200, { data: { id: id } })
    }

    const getSession = url.pathname.match(/^\/api\/session\/([^/]+)$/)
    if (getSession && req.method === 'DELETE') { sessions.delete(decodeURIComponent(getSession[1])); res.writeHead(204); return res.end() }

    const setModel = url.pathname.match(/^\/api\/session\/([^/]+)\/model$/)
    if (setModel && req.method === 'POST') {
      const body = JSON.parse(await readText(req))
      const entry = MOCK_MODELS.find(function (m) { return m.id === body.model.id })
      if (entry === undefined) return send(404, { _tag: 'NotFoundError', message: 'Unknown model' })
      if (body.model.variant !== undefined && entry.variants.every(function (v) { return v.id !== body.model.variant })) {
        return send(503, { _tag: 'ServiceUnavailableError', message: 'Variant unavailable for ' + entry.providerID + '/' + entry.id + ': ' + body.model.variant })
      }
      sessions.get(decodeURIComponent(setModel[1])).model = body.model
      state.lastVariant = body.model.variant
      res.writeHead(204)
      return res.end()
    }

    const generate = url.pathname.match(/^\/api\/session\/([^/]+)\/generate$/)
    if (generate && req.method === 'POST') {
      state.generateCount += 1
      const body = JSON.parse(await readText(req))
      state.lastPrompt = body.prompt
      if (typeof body.prompt !== 'string' || body.prompt === '') return send(422, { _tag: 'BadRequest', message: 'prompt required' })
      if (body.prompt.includes('BOOM-429')) return send(429, { _tag: 'ProviderRequestError', reason: 'rate_limit', message: 'Free usage limit reached', retryAfterMs: 60000 })
      if (body.prompt.includes('BOOM-REGION')) return send(403, { _tag: 'ProviderRequestError', reason: 'auth', message: 'This model is not available in your country' })
      if (body.prompt.includes('BOOM-EMPTY')) return send(200, { data: { text: '   ' } })
      return send(200, { data: { text: 'mock 回答：' + body.prompt.slice(0, 24) } })
    }

    const interrupt = url.pathname.match(/^\/api\/session\/([^/]+)\/interrupt$/)
    if (interrupt && req.method === 'POST') return send(200, { interrupted: true })

    res.writeHead(404)
    return res.end()
  })

  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({
        url: 'http://127.0.0.1:' + String(server.address().port),
        sessions: sessions,
        state: state,
        close: function () { return new Promise(function (done) { server.close(function () { done() }) }) },
      })
    })
  })
}

if (process.argv[1] && process.argv[1].endsWith('mock-server.mjs')) {
  const mock = await startMockServer()
  console.log(JSON.stringify({ url: mock.url }))
  process.stdin.resume()
}
