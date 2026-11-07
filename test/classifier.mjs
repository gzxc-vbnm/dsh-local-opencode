/**
 * 分类器直测：分支顺序与取值都钉在内核/官方适配器的真实词表上。
 *
 * 为什么单独立一个文件：本项目曾被一次连环字符串替换吞掉了 5xx 分支和 UNKNOWN 兜底，
 * 而 stream 级断言完全看不出来（那条路径要真实上游才触发）。分类器是纯函数，
 * 直接喂状态码与失败体就能钉住每一条分支。
 *
 * @module test/classifier.mjs
 */

import { fromUpstream, CODE } from '../src/errors.js'

let failed = 0
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '   ' + detail))
  if (ok !== true) failed += 1
}
const cls = (status, fields) => fromUpstream(status, JSON.stringify(fields))

// 分支顺序：区域 > 凭据 > 终局配额 > 限速 > 4xx > 5xx > 未分类
check('区域 403 -> AUTH 并提示换出口', cls(403, { message: 'This model is not available in your country' }).failure.code === 'AUTH')
check('裸 401 -> AUTH', cls(401, { message: 'no' }).failure.code === 'AUTH')
check('provider reason=auth -> AUTH', cls(400, { _tag: 'ProviderRequestError', reason: 'auth', message: 'sign in required' }).failure.code === 'AUTH')
check('Free usage limit -> QUOTA 而不是 RATE_LIMIT', cls(429, { _tag: 'ProviderRequestError', reason: 'rate_limit', message: 'Free usage limit reached', retryAfterMs: 60000 }).failure.code === 'QUOTA')
check('quota exceeded 措辞 -> QUOTA', cls(400, { message: 'Quota exceeded for this account' }).failure.code === 'QUOTA')
check('纯限速 429 -> RATE_LIMIT', cls(429, { message: 'Too Many Requests' }).failure.code === 'RATE_LIMIT')
check('404 -> INVALID_REQUEST', cls(404, { message: 'Unknown model' }).failure.code === 'INVALID_REQUEST')
check('400 -> INVALID_REQUEST', cls(400, { message: 'bad input' }).failure.code === 'INVALID_REQUEST')
check('503 档位不可用 -> SERVER（opencode 就是这么报的）', cls(503, { _tag: 'ServiceUnavailableError', message: 'Variant unavailable for opencode/x: zzz' }).failure.code === 'SERVER')
check('502 的 retryAfterMs 落进 failure', cls(502, { _tag: 'ProviderRequestError', message: 'upstream died', retryAfterMs: 1500 }).failure.providerRetryAfterMs === 1500)
check('未知状态 -> UNKNOWN 兜底存在', cls(418, { message: 'teapot' }).failure.code === 'UNKNOWN')

// 任何分支都不得产出词表外的 code：内核按 code 决定退避与重试集合。
const statuses = [400, 401, 403, 404, 418, 422, 429, 500, 502, 503]
const messages = ['m', 'Free usage limit reached', 'This model is not available in your country', 'Too Many Requests']
const known = Object.values(CODE)
const stray = []
for (const status of statuses) {
  for (const message of messages) {
    const code = cls(status, { message: message, _tag: 'ProviderRequestError' }).failure.code
    if (known.includes(code) !== true) stray.push(String(status) + '/' + message.slice(0, 12) + '=' + String(code))
  }
}
check('每个 (状态码 x 措辞) 组合都落进 CODE 表', stray.length === 0, JSON.stringify(stray))

// failure 必须是自有数据属性：内核用 getOwnPropertyDescriptor 读，原型取值不算数。
const error = cls(429, { message: 'Too Many Requests', retryAfterMs: 5000 })
const codeOwn = Object.getOwnPropertyDescriptor(error, 'code')
check('code 是自有数据属性', codeOwn !== undefined && 'value' in codeOwn)
const failureOwn = Object.getOwnPropertyDescriptor(error, 'failure')
check('failure 是自有数据属性且 code 一致', failureOwn !== undefined && 'value' in failureOwn && failureOwn.value.code === error.code)
check('failure 已冻结（快照不会被下游改写）', Object.isFrozen(error.failure) === true)
check('status 与 retry-after 都进快照', error.failure.status === 429 && error.failure.providerRetryAfterMs === 5000, JSON.stringify(error.failure))

console.log('')
console.log(failed === 0 ? 'classifier: clean' : 'classifier: ' + failed + ' mismatch(es)')
process.exit(failed === 0 ? 0 : 1)
