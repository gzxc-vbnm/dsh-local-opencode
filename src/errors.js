/**
 * 失败类型：不 import '@deepseek-ai/dsh-llm'，跨内核版本更稳。
 *
 * 内核的 normalizeLlmFailure 先读错误对象【自有】的 failure 数据快照，并要求自有的
 * code 与它相等；两条命中即直接采用该快照（含 HTTP 状态与 retry-after）。所以一个带
 * 自有 code + 自有 failure 的普通 Error 就能被内核正确归类，不必依赖 LlmError 类本身。
 *
 * @module src/errors.js
 */

/** provider 中立的失败码；只有标了可重试的码才进内核退避队列。 */
export const CODE = Object.freeze({
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER: 'SERVER',
  TRANSPORT: 'TRANSPORT',
  TIMEOUT: 'TIMEOUT',
  NOT_FOUND: 'NOT_FOUND',
  /** 上游回了 200 但没有任何可见内容：内核按它做退避重试。 */
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  ABORTED: 'ABORTED',
  UNKNOWN: 'UNKNOWN',
})

export class OpenCodeError extends Error {
  /**
   * @param {string} message 面向人的失败摘要
   * @param {string} code provider 中立机器码
   * @param {{status?: number, providerRetryAfterMs?: number}} [facts]
   */
  constructor(message, code, facts) {
    super(message)
    this.name = 'OpenCodeError'
    // 必须是自有数据属性：内核用 getOwnPropertyDescriptor 读，原型链取值不算数。
    Object.defineProperty(this, 'code', { value: code, enumerable: true, configurable: true, writable: true })
    const failure = { message: message, code: code }
    if (facts && typeof facts.status === 'number') failure.status = facts.status
    if (facts && Number.isFinite(facts.providerRetryAfterMs) && facts.providerRetryAfterMs > 0) {
      failure.providerRetryAfterMs = Math.round(facts.providerRetryAfterMs)
    }
    Object.defineProperty(this, 'failure', { value: Object.freeze(failure), enumerable: false, configurable: true, writable: true })
  }
}

/** AbortSignal 取消：内核据此收尾成 aborted（不计为失败）。 */
export function abortedError(message) {
  return new OpenCodeError(message || 'local-opencode: 请求已取消', CODE.ABORTED)
}

export function transportError(message, cause) {
  const error = new OpenCodeError(message, cause && /timeout/i.test(String(cause.name || cause.message)) ? CODE.TIMEOUT : CODE.TRANSPORT)
  return error
}

function collapseSpace(value) {
  let out = ''
  let pending = false
  for (const char of value) {
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') { pending = out !== '' && !out.endsWith(' '); continue }
    if (pending) { out += ' '; pending = false }
    out += char
  }
  return out
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return undefined }
}

function pickNumber() {
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

/**
 * 把 opencode 的失败响应翻成内核分类。
 *
 * opencode 2.x 的失败体形如 { _tag: 'ProviderRequestError', reason, message, status,
 * retryAfterMs }；上游网关直连失败则是 OpenAI 风格 { error: { type, message } }。两条都
 * 覆盖：区域拒绝（'not available in your country'）归 AUTH（换出口才有解，重试无意义），
 * 额度墙（429 / FreeUsageLimit）归 RATE_LIMIT 并带上 provider 要求的退避时长。
 */
export function fromUpstream(status, bodyText) {
  const parsed = parseJson(bodyText || '')
  const tag = collapseSpace(String((parsed && (parsed._tag || parsed.reason)) || (parsed && parsed.error && parsed.error.type) || ''))
  const rawMessage = String((parsed && parsed.message) || (parsed && parsed.error && parsed.error.message) || bodyText || '')
  const message = (collapseSpace(rawMessage) || 'opencode 请求失败').slice(0, 400)
  const retryAfterMs = pickNumber(parsed && parsed.retryAfterMs, parsed && parsed.error && parsed.error.retry_after_ms)
  const prefix = 'local-opencode: opencode 返回 ' + status
  const facts = { status: status, providerRetryAfterMs: retryAfterMs }
  if (/region|not.?available|country/i.test(message)) return new OpenCodeError(prefix + ': ' + message + '（区域限制，需要可用出口或换模型）', CODE.AUTH, facts)
  if (status === 401 || status === 403 || /auth|credential|permission|sign.?in/i.test(tag)) return new OpenCodeError(prefix + ': ' + message, CODE.AUTH, facts)
  if (status === 429 || /rate.?limit|quota|usage.?limit|too.?many/i.test(tag + ' ' + message)) return new OpenCodeError(prefix + ': ' + message, CODE.RATE_LIMIT, facts)
  if (status === 404 || /not.?found/i.test(tag)) return new OpenCodeError(prefix + ': ' + message, CODE.NOT_FOUND, { status: status })
  if (status >= 500) return new OpenCodeError(prefix + ': ' + message, CODE.SERVER, facts)
  return new OpenCodeError(prefix + ': ' + message, CODE.UNKNOWN, { status: status })
}
