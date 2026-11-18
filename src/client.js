/**
 * opencode 2.x 本地服务的极小客户端。
 *
 * 只用到三条路由：模型目录（GET /api/model）、会话（POST/DELETE /api/session）、
 * 以及生成（POST /api/session/{id}/generate）。为什么走 session 上的 generate 而不是
 * 无状态的 POST /api/experimental/generate/text：本机 A/B 实测前者出字、后者被上游判成
 * FreeUsageLimitError(429) —— 匿名免费额度绑定在 opencode 会话的身份上，跳过会话就没有
 * 那份亲和。而 session/generate 本身不累积历史（实测连问两次，第二次答"不知道"），所以
 * 它是一轮一次的干净通道，正好匹配 dsh 每轮重放全量历史的调用方式。
 *
 * 会话生命周期是 per-call：create -> setModel -> generate -> delete（delete 进 finally，
 * 失败只记日志）。不做跨调用共享会话，因为切换 model/variant 是改会话的共享状态，两个并发
 * 调用会互相踩；也不做历史注入，因为这条通道不读历史。
 *
 * @module src/client.js
 */

import { CODE, OpenCodeError, abortedError, fromUpstream, transportError } from './errors.js'
import { openEventStream } from './event-stream.js'
import { basicAuth } from './discovery.js'

const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' }

function headerWith(password) {
  const headers = {}
  for (const key in JSON_HEADERS) headers[key] = JSON_HEADERS[key]
  headers.authorization = basicAuth(password)
  return headers
}

function timeoutSignal(ms, outer) {
  const signals = []
  if (Number.isFinite(ms) && ms > 0) signals.push(AbortSignal.timeout(ms))
  if (outer) signals.push(outer)
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

function abortReason(outer, ms) {
  if (outer && outer.aborted) return true
  return false
}


function bestEffortText(response) {
  return response.text().catch(function () { return '' })
}

export class OpenCodeClient {
  /**
   * @param {{endpoint: string, password: string, logger?: object, version?: string}} options
   */
  constructor(options) {
    this.endpoint = options.endpoint
    this.password = options.password
    this.logger = options.logger
    this.version = options.version
  }

  async request(path, init, timeoutMs, signal) {
    const usedSignal = timeoutSignal(timeoutMs, signal)
    let response
    try {
      response = await fetch(this.endpoint + path, Object.assign({}, init, { headers: headerWith(this.password), signal: usedSignal, cache: 'no-store' }))
    } catch (error) {
      if (signal && signal.aborted) throw abortedError()
      throw transportError('local-opencode: 请求本机 opencode 失败（' + path + '）：' + String((error && error.message) || error), error)
    }
    return response
  }

  /** 模型目录：GET /api/model 返回 opencode 当前实际可用的模型（含 cost/capabilities/variants）。 */
  async listModels(timeoutMs, signal) {
    const response = await this.request('/api/model', { method: 'GET' }, timeoutMs, signal)
    if (!response.ok) throw fromUpstream(response.status, await bestEffortText(response))
    const payload = await response.json().catch(function () { return undefined })
    const data = payload && payload.data
    if (!Array.isArray(data)) throw new OpenCodeError('local-opencode: opencode 的 /api/model 应答形状不认识（缺 data 数组）', CODE.SERVER)
    return data
  }

  async createSession(title, timeoutMs, signal) {
    const response = await this.request('/api/session', { method: 'POST', body: JSON.stringify({ title: title }) }, timeoutMs, signal)
    if (!response.ok) throw fromUpstream(response.status, await bestEffortText(response))
    const payload = await response.json().catch(function () { return undefined })
    const id = payload && payload.data && payload.data.id
    if (typeof id !== 'string' || id === '') throw new OpenCodeError('local-opencode: opencode 建会话应答里没有 session id', CODE.SERVER)
    return id
  }

  async deleteSession(sessionId, timeoutMs) {
    try {
      const response = await this.request('/api/session/' + encodeURIComponent(sessionId), { method: 'DELETE' }, timeoutMs || 15000, undefined)
      // 204/200 都算删掉；404 说明已经没了，同样成功。
      if (response.ok || response.status === 404) return true
      this.logger && this.logger.warn && this.logger.warn('local-opencode: 清理 opencode 会话 ' + sessionId + ' 应答 ' + response.status)
      return false
    } catch (error) {
      this.logger && this.logger.warn && this.logger.warn('local-opencode: 清理 opencode 会话失败（' + String((error && error.message) || error) + '）')
      return false
    }
  }

  async selectModel(sessionId, model, variant, timeoutMs, signal) {
    const body = { model: { id: model.id, providerID: model.providerID } }
    // variant 为空时不传：让 opencode 用它自己的默认档位。
    if (variant !== undefined && variant !== null && variant !== '') body.model.variant = String(variant)
    const response = await this.request('/api/session/' + encodeURIComponent(sessionId) + '/model', { method: 'POST', body: JSON.stringify(body) }, timeoutMs, signal)
    if (!response.ok && response.status !== 204) throw fromUpstream(response.status, await bestEffortText(response))
  }

  /**
   * 一轮生成：整段回答一次性返回（opencode 这条通道不给增量）。
   * @returns {Promise<{text: string, ms: number}>}
   */
  async generate(sessionId, prompt, timeoutMs, signal) {
    const started = Date.now()
    const response = await this.request('/api/session/' + encodeURIComponent(sessionId) + '/generate', { method: 'POST', body: JSON.stringify({ prompt: prompt }) }, timeoutMs, signal)
    const ms = Date.now() - started
    if (!response.ok) {
      // 取消时 fetch 已抛错走到上面；这里只处理服务侧失败。
      throw fromUpstream(response.status, await bestEffortText(response))
    }
    const payload = await response.json().catch(function () { return undefined })
    const text = payload && payload.data && typeof payload.data.text === 'string' ? payload.data.text : undefined
    if (text === undefined) throw new OpenCodeError('local-opencode: opencode 的 generate 应答缺少 data.text', CODE.SERVER)
    return { text: text, ms: ms }
  }

  /**
   * 打开事件流（实现见 src/event-stream.js）。
   *
   * types 用重复查询参数：实测 opencode 2.3.0 对逗号串回 400。流必须在 prompt
   * 之前开好 —— prompt 的响应体只是「用户消息已入队」，答案全在流里。
   * close() 必须在 finally 里调用，否则这条长连接一直挂在服务上。
   */
  openEventStream(types, timeoutMs, outer) {
    return openEventStream({ endpoint: this.endpoint, password: this.password }, types, timeoutMs, outer)
  }

  /** 建会话，body 由调用方给全（agent 道需要 agent/model/location/permissions）。 */
  async createSessionWith(body, timeoutMs, signal) {
    const response = await this.request('/api/session', { method: 'POST', body: JSON.stringify(body) }, timeoutMs, signal)
    if (!response.ok) throw fromUpstream(response.status, await bestEffortText(response))
    const payload = await response.json().catch(function () { return undefined })
    const id = payload && payload.data && payload.data.id
    if (typeof id !== 'string' || id === '') throw new OpenCodeError('local-opencode: opencode 建会话应答里没有 session id', CODE.SERVER)
    return id
  }

  /** 把一轮输入交给 agent 循环；返回即入队，真正的产出走事件流。 */
  async promptSession(sessionId, text, timeoutMs, signal) {
    const response = await this.request('/api/session/' + encodeURIComponent(sessionId) + '/prompt', {
      method: 'POST', body: JSON.stringify({ text: text }),
    }, timeoutMs, signal)
    if (!response.ok) throw fromUpstream(response.status, await bestEffortText(response))
    // 200 的响应体是入队的用户消息，不是回答；这里只校验形状，避免把空 id 当成成功。
    const payload = await response.json().catch(function () { return undefined })
    const id = payload && payload.data && payload.data.id
    if (typeof id !== 'string') throw new OpenCodeError('local-opencode: prompt 入队应答缺少消息 id', CODE.SERVER)
    return id
  }

  /** 代答一次权限请求（opencode 侧工具执行的门禁）。 */
  async replyPermission(sessionId, permissionId, decision, message, timeoutMs) {
    const response = await this.request('/api/session/' + encodeURIComponent(sessionId) + '/permission/' + encodeURIComponent(permissionId) + '/reply', {
      method: 'POST',
      body: JSON.stringify({ decision: decision, message: message === null || message === undefined ? null : String(message).slice(0, 200) }),
    }, timeoutMs || 15000, undefined)
    if (!response.ok && response.status !== 404) throw fromUpstream(response.status, await bestEffortText(response))
    // 404：这一条已被别处应答或过期，不算失败（幂等）。
    return response.ok
  }

  /** 事件流断掉时的兜底：读会话里最后一条 assistant 消息的纯文本与 token。 */
  async lastAssistantText(sessionId, timeoutMs) {
    const response = await this.request('/api/session/' + encodeURIComponent(sessionId) + '/message?limit=12', { method: 'GET' }, timeoutMs || 15000, undefined)
    if (!response.ok) throw fromUpstream(response.status, await bestEffortText(response))
    const payload = await response.json().catch(function () { return undefined })
    const rows = (payload && Array.isArray(payload.data) ? payload.data : []).filter(function (m) { return m && m.type === 'assistant' })
    const last = rows[rows.length - 1]
    if (last === undefined) return undefined
    const text = (Array.isArray(last.content) ? last.content : [])
      .filter(function (block) { return block && block.type === 'text' && typeof block.text === 'string' })
      .map(function (block) { return block.text })
      .join('')
    return { text: text, tokens: last.tokens, finish: last.finish, error: last.error }
  }

  /** opencode 的 agent 目录（侧栏的下拉选项）。 */
  async listAgents(timeoutMs, signal) {
    const response = await this.request('/api/agent', { method: 'GET' }, timeoutMs || 15000, signal)
    if (!response.ok) throw fromUpstream(response.status, await bestEffortText(response))
    const payload = await response.json().catch(function () { return undefined })
    const data = payload && payload.data
    if (!Array.isArray(data)) throw new OpenCodeError('local-opencode: /api/agent 应答形状不认识（缺 data 数组）', CODE.SERVER)
    return data
  }
  /** 尽力中断一次正在跑的生成（取消路径），失败不改变结果。 */
  async interrupt(sessionId) {
    try { await this.request('/api/session/' + encodeURIComponent(sessionId) + '/interrupt', { method: 'POST' }, 8000, undefined) } catch { /* 尽力而为 */ }
  }
}
