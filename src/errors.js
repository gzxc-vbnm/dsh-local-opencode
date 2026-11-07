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
  /** 请求本身有问题（400/404/未知模型/未知档位）：重试无意义。官方适配器对 40x 也用这个码。 */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** 上游回了 200 但没有任何可见内容：内核按它做退避重试。 */
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  /**
   * 账号侧终局额度墙。注意它和 RATE_LIMIT 的区别不是状态码而是措辞：内核自己的
   * isQuotaExceededError 把 "usage limit reached"/"quota exceeded" 这类话判成配额，
   * 而 opencode 匿名通道的 429 正是 FreeUsageLimitError + retryAfter 数小时——那是配额，
   * 不是"稍后再试"的限速，标成 RATE_LIMIT 会让调度语义说谎。
   */
  QUOTA: 'QUOTA',
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

/**
 * 终局配额措辞。与内核 isQuotaExceededError 的判断面保持一致：额度/余额/积分耗尽、
 * usage limit reached、out of budget 等。命中它就不是"等一会儿再来"的限速。
 */
function isQuotaWording(detail) {
  return /insufficient[_ -]?(?:quota|balance|credits?)/i.test(detail)
    || /(?:quota|usage[_ -]limit)[_ -]?(?:exceeded|exhausted|reached)/i.test(detail)
    || /exceed(?:ed|s)?[_ -]?(?:your|the)?[_ -]?(?:current[_ -]?)?quota/i.test(detail)
    || /(?:balance|credits?)[_ -]?(?:exhausted|depleted)/i.test(detail)
    || /out[_ -]of[_ -]+(?:credits?|budget)/i.test(detail)
    || /free[_ -]?usage[_ -]?limit/i.test(detail)
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
 * 覆盖。分支顺序即优先级：区域拒绝 > 凭据 > 终局配额 > 限速 > 4xx 请求错误 > 5xx 服务
 * 错误 > 未分类。取值全部落在 CODE 表内，绝不产出内核词表之外的 code。
 */
export function fromUpstream(status, bodyText) {
  const parsed = parseJson(bodyText || '')
  // _tag 与 reason 是 opencode 失败体里两个独立字段（reason 才是语义所在，如 rate_limit/auth）；
  // 用 || 取值会因 _tag 总是真值而丢掉 reason，让凭据类 4xx 落到 4xx 分支上去。
  const parts = []
  if (parsed) {
    if (typeof parsed._tag === 'string') parts.push(parsed._tag)
    if (typeof parsed.reason === 'string') parts.push(parsed.reason)
    if (parsed.error && typeof parsed.error.type === 'string') parts.push(parsed.error.type)
  }
  const tag = collapseSpace(parts.join(' '))
  const rawMessage = String((parsed && parsed.message) || (parsed && parsed.error && parsed.error.message) || bodyText || '')
  const message = (collapseSpace(rawMessage) || 'opencode 请求失败').slice(0, 400)
  const retryAfterMs = pickNumber(parsed && parsed.retryAfterMs, parsed && parsed.error && parsed.error.retry_after_ms)
  const prefix = 'local-opencode: opencode 返回 ' + status
  const facts = { status: status, providerRetryAfterMs: retryAfterMs }
  if (/region|not.?available|country/i.test(message)) return new OpenCodeError(prefix + ': ' + message + '（区域限制，需要可用出口或换模型）', CODE.AUTH, facts)
  if (status === 401 || status === 403 || /auth|credential|permission|sign.?in/i.test(tag)) return new OpenCodeError(prefix + ': ' + message, CODE.AUTH, facts)
  if (isQuotaWording(tag + ' ' + message)) return new OpenCodeError(prefix + ': ' + message + '（免费额度已到顶，等渠道重置或换模型）', CODE.QUOTA, facts)
  if (status === 429 || /rate.?limit|too.?many/i.test(tag + ' ' + message)) return new OpenCodeError(prefix + ': ' + message, CODE.RATE_LIMIT, facts)
  if (status === 400 || status === 404 || status === 422 || /not.?found|bad.?request|invalid|unsupported/i.test(tag + ' ' + message)) return new OpenCodeError(prefix + ': ' + message, CODE.INVALID_REQUEST, facts)
  if (status >= 500) return new OpenCodeError(prefix + ': ' + message, CODE.SERVER, facts)
  return new OpenCodeError(prefix + ': ' + message, CODE.UNKNOWN, { status: status })
}
