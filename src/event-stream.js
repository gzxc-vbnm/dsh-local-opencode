/**
 * opencode 事件流（SSE）订阅器。
 *
 * 单独成模块的原因：这里是全插件唯一的 async generator，把生成器逻辑留在 client 里
 * 会把普通方法与 yield 混在同一个类体上（那既是语法错误也是坏形状）。
 *
 * 语义要点（均实测于 opencode 2.3.0）：
 *  - types 过滤必须是重复查询参数；逗号串会被服务端判 400。
 *  - 流是 volatile 的：服务端对慢消费者直接溢出断流，所以消费方不能把它当可靠队列，
 *    agent 道另有「读会话消息」兜底（见 agent-lane.js）。
 *  - 第一帧恒为 server.connected，与业务无关，交给调用方按类型过滤自行忽略。
 *
 * @module src/event-stream.js
 */

import { abortedError, fromUpstream, transportError } from './errors.js'
import { basicAuth } from './discovery.js'

/** 解析一帧 SSE：只取 data: 行，容忍多行 data、心跳与 comment 帧。 */
export function parseFrame(frame) {
  const lines = String(frame).split('\n')
  let data = ''
  for (const line of lines) {
    if (line.startsWith('data:') === false) continue
    data += (data === '' ? '' : '\n') + line.slice(5).replace(/^ /, '')
  }
  if (data === '') return undefined
  try { return JSON.parse(data) } catch { return undefined }
}

/**
 * @param {{endpoint: string, password: string}} transport
 * @param {string[]} types 想订阅的事件类型（重复 types 参数）
 * @param {number} timeoutMs 整轮上限，到点主动掐流
 * @param {AbortSignal} [outer] 外层取消
 */
export function openEventStream(transport, types, timeoutMs, outer) {
  const query = (types || [])
    .map(function (type) { return 'types=' + encodeURIComponent(type) })
    .join('&')
  const path = '/api/event' + (query === '' ? '' : '?' + query)
  const controller = new AbortController()
  const onOuterAbort = function () { controller.abort(outer && outer.reason) }
  if (outer !== undefined && outer !== null) {
    if (outer.aborted === true) onOuterAbort()
    else outer.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(function () { controller.abort(new Error('local-opencode: agent 轮次超时')) }, timeoutMs)
    : undefined
  if (timer !== undefined && timer.unref) timer.unref()

  const started = fetch(transport.endpoint + path, {
    method: 'GET',
    headers: { accept: 'text/event-stream', authorization: basicAuth(transport.password) },
    signal: controller.signal,
    cache: 'no-store',
  })

  async function* iterate() {
    let response
    try {
      response = await started
    } catch (error) {
      if (outer !== undefined && outer !== null && outer.aborted === true) throw abortedError()
      throw transportError('local-opencode: 打不开 opencode 事件流（' + path + '）', error)
    }
    if (response.ok !== true) {
      const text = await response.text().catch(function () { return '' })
      throw fromUpstream(response.status, text)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done === true) {
          if (buffer.trim() !== '') {
            const tail = parseFrame(buffer)
            if (tail !== undefined) yield tail
          }
          return
        }
        buffer += decoder.decode(chunk.value, { stream: true })
        for (;;) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary < 0) break
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseFrame(frame)
          if (parsed !== undefined) yield parsed
        }
      }
    } catch (error) {
      // 主动掐断（外层取消/本轮超时）不是故障：调用方按未收到收尾事件走兜底路径。
      const selfAbort = controller.signal.aborted === true
      const outerAbort = outer !== undefined && outer !== null && outer.aborted === true
      if (selfAbort === false || outerAbort === false) throw error
    } finally {
      try { reader.cancel() } catch { /* 已关闭 */ }
      try { reader.releaseLock() } catch { /* 已释放 */ }
    }
  }

  return {
    events: function () { return iterate() },
    /** 取消时先掐本地流，再由调用方中断服务端那一轮。 */
    interruptIfNeeded: function (sessionId) {
      controller.abort()
      return sessionId
    },
    close: function () {
      if (timer !== undefined) clearTimeout(timer)
      if (outer !== undefined && outer !== null) outer.removeEventListener('abort', onOuterAbort)
      controller.abort()
    },
    signal: controller.signal,
  }
}
