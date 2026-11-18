/**
 * agent 道：把一轮请求交给 opencode 自己的 agent 循环执行（带工具）。
 *
 * 与文本道的分工：文本道走无状态的 session/generate，一次进一次出，永远不会有工具；
 * agent 道走 session/prompt + 事件流，opencode 会在它自己的工作目录里真的调用 read/
 * write/bash 等工具，并把结果喂回模型，直到这一轮收敛。dsh 看不到这些工具——它只收到
 * 最终的文本与推理块，所以 dsh 侧的工具声明在这条道上同样被丢弃。
 *
 * 权限（实测出来的关键点）：
 *   build agent 的默认权限是 *=allow，工具会【静默执行】，连 permission.asked 都不发。
 *   也就是说：不在建会话时显式下发 permissions，设置里的「权限代答策略」就是个摆设。
 *   实测显式 ask 会挂起并等 POST .../permission/{id}/reply，显式 deny 会被强制执行。
 *   所以三条策略都翻译成建会话时的 permissions + 事件流里的代答：
 *     allow-read  全部 ask，读类动作代答 once，其余 reject
 *     allow-all   全部 allow（真的会改用户文件，UI 上必须写明）
 *     reject      全部 deny（只剩多轮推理，无工具副作用）
 *
 * 断流兜底：事件流是 volatile 的（opencode 自己写着「慢消费者会溢出并断流」），所以
 * 一旦流提前结束而执行还没收尾，就改读 GET /api/session/{id}/message 取最终答案。
 *
 * @module src/agent-lane.js
 */

import { CODE } from './errors.js'
import { PERMISSION_MODES, READ_ONLY_ACTIONS } from './settings.js'

/** 只订阅这一道需要的类型：重复的 types 参数（实测逗号串会被判 400）。 */
export const AGENT_EVENT_TYPES = Object.freeze([
  'session.text.started',
  'session.text.delta',
  'session.text.ended',
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.step.ended',
  'session.usage.updated',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'permission.asked',
])

/**
 * 建会话时下发的权限规则：一条通配，具体决定留给代答。
 * allow-all 例外——直接 allow，省掉每个动作一次代答往返。
 */
export function permissionsFor(mode) {
  if (mode === PERMISSION_MODES.allowAll) return [{ action: '*', resource: '*', effect: 'allow' }]
  if (mode === PERMISSION_MODES.reject) return [{ action: '*', resource: '*', effect: 'deny' }]
  return [{ action: '*', resource: '*', effect: 'ask' }]
}

/** 代答决定：动作名命中读类清单才放行一次。 */
export function decisionFor(mode, action) {
  if (mode === PERMISSION_MODES.reject) return 'reject'
  const name = String(action || '').trim().toLowerCase()
  for (const read of READ_ONLY_ACTIONS) {
    if (name === read || name.startsWith(read + '_') || name.startsWith(read + '-')) return 'once'
  }
  return 'reject'
}

/** opencode 的 tokens 与内核的 disjoint 计数同构（实测 cache.read 可大于 input，说明 input 未含缓存），直接透传。 */
function mapTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return undefined
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const cache = tokens.cache || {}
  const usage = {
    inputTokens: number(tokens.input),
    outputTokens: number(tokens.output),
  }
  const cacheRead = number(cache.read)
  const cacheWrite = number(cache.write)
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite
  if (number(tokens.reasoning) > 0) usage.reasoningTokens = number(tokens.reasoning)
  usage.totalTokens = usage.inputTokens + usage.outputTokens + cacheRead + cacheWrite
  return usage
}

export class AgentLane {
  /**
   * @param {{client: object, settings: () => object, logger?: object, prompt: (options: object) => string}} deps
   */
  constructor(deps) {
    this.deps = deps
  }

  /**
   * 跑一轮并把事件流投影成内核 StreamChunk。
   * @param {object} options - 内核的 GenerateOptions
   * @param {object} entry - 目录行（providerID/modelID/variants）
   * @param {object} client - 已发现的 opencode 客户端
   * @param {string|undefined} variant - 已由调用方校验过的思考档位
   *   （client 一路传到 consume：实例在适配器上共享，不能挂在 this 上）
   */
  async * run(options, entry, client, variant) {
    const settings = this.deps.settings()
    const logger = this.deps.logger
    const timeoutMs = Number(settings.agentTurnTimeoutMs) || 600000

    const model = { id: entry.modelID, providerID: entry.providerID }
    if (variant !== undefined) model.variant = variant
    const body = {
      title: 'dsh:local-opencode:agent',
      model: model,
      permissions: permissionsFor(settings.permissionMode),
    }
    if (typeof settings.agentName === 'string' && settings.agentName !== '') body.agent = settings.agentName
    // location.directory 实测被建会话接受（会换成对应的 projectID）；留空则沿用服务自己的位置。
    if (typeof settings.workingDirectory === 'string' && settings.workingDirectory !== '') {
      body.location = { directory: settings.workingDirectory }
    }

    // 事件流必须在 prompt 之前开好：prompt 回的是「用户消息已入队」，答案全在流里。
    const stream = await client.openEventStream(AGENT_EVENT_TYPES, timeoutMs, options.signal)
    let sessionId = undefined
    try {
      const created = await client.createSessionWith(body, timeoutMs, options.signal)
      sessionId = created
      await client.promptSession(sessionId, this.deps.prompt(options), timeoutMs, options.signal)
      yield * this.consume(stream, sessionId, options, logger, client)
    } catch (error) {
      if (options.signal && options.signal.aborted) {
        if (sessionId !== undefined) await client.interrupt(sessionId)
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'local-opencode: 请求已取消', code: CODE.ABORTED } } }
        return
      }
      throw error
    } finally {
      stream.close()
      if (sessionId !== undefined) await client.deleteSession(sessionId, 15000)
    }
  }

  /**
   * 读事件流直到执行收尾。每个文本/推理块独立成块，索引按到达顺序分配。
   *
   * 没有嵌套 yield：块打开逻辑返回待发的 chunk，由本循环自己发出，
   * 否则就落在非生成器的箭头函数里（那是语法错误，不是风格问题）。
   */
  async * consume(stream, sessionId, options, logger, client) {
    let index = 0
    const blocks = new Map()
    let usage
    let closed = false
    let terminal
    let visibleText = false

    const ensure = (key, kind) => {
      const existing = blocks.get(key)
      if (existing !== undefined) return undefined
      const block = { index: index++, kind: kind, text: '', open: true }
      blocks.set(key, block)
      return { type: 'block-start', index: block.index, blockType: kind === 'reasoning' ? 'reasoning' : 'text' }
    }
    const keyFor = (kind, data) => (kind === 'reasoning' ? 'r' : 't') + String(data.ordinal !== undefined ? data.ordinal : (data.assistantMessageID || '0'))

    for await (const event of stream.events()) {
      if (options.signal && options.signal.aborted) {
        await client.interrupt(sessionId)
        closed = true
        terminal = { kind: 'aborted', failure: { message: 'local-opencode: 请求已取消', code: CODE.ABORTED } }
        break
      }
      const data = event && event.data
      if (!data || data.sessionID !== sessionId) continue
      const type = event.type

      if (type === 'session.text.started' || type === 'session.reasoning.started') {
        const kind = type === 'session.reasoning.started' ? 'reasoning' : 'text'
        const chunk = ensure(keyFor(kind, data), kind)
        if (chunk !== undefined) yield chunk
        continue
      }

      if (type === 'session.text.delta' || type === 'session.reasoning.delta') {
        const kind = type === 'session.reasoning.delta' ? 'reasoning' : 'text'
        const key = keyFor(kind, data)
        const chunk = ensure(key, kind)
        if (chunk !== undefined) yield chunk
        const delta = typeof data.delta === 'string' ? data.delta : ''
        if (delta === '') continue
        blocks.get(key).text += delta
        if (kind === 'text' && delta.trim() !== '') visibleText = true
        yield { type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: blocks.get(key).index, text: delta }
        continue
      }

      if (type === 'session.text.ended' || type === 'session.reasoning.ended') {
        const kind = type === 'session.reasoning.ended' ? 'reasoning' : 'text'
        const key = keyFor(kind, data)
        const chunk = ensure(key, kind)
        if (chunk !== undefined) yield chunk
        const block = blocks.get(key)
        if (block.open === false) continue
        // ended 带完整文本：以它为准（delta 可能因断流缺失），只在更长时补尾。
        if (kind === 'text' && typeof data.text === 'string' && data.text.trim() !== '') visibleText = true
        if (typeof data.text === 'string' && data.text.length > block.text.length) {
          const tail = data.text.slice(block.text.length)
          block.text = data.text
          if (tail !== '') yield { type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: block.index, text: tail }
        }
        block.open = false
        yield { type: 'block-end', index: block.index, block: { type: kind, text: block.text } }
        continue
      }

      if (type === 'session.step.ended' || type === 'session.usage.updated') {
        const mapped = mapTokens(data.tokens)
        if (mapped !== undefined) usage = mapped
        continue
      }

      if (type === 'permission.asked') {
        const mode = this.deps.settings().permissionMode
        const decision = decisionFor(mode, data.action)
        try {
          await client.replyPermission(sessionId, data.id, decision, decision === 'reject' ? 'local-opencode 按当前权限设置拒绝了该动作' : null)
        } catch (error) {
          // 代答失败不能判死整轮：opencode 自己会等或超时，日志留下线索。
          if (logger && typeof logger.warn === 'function') logger.warn('local-opencode: 权限代答失败（' + String((error && error.message) || error) + '）')
        }
        continue
      }

      if (type === 'session.execution.succeeded') {
        closed = true
        terminal = { kind: 'stop' }
        break
      }
      if (type === 'session.execution.failed') {
        closed = true
        terminal = this.failureFrom(data.error)
        break
      }
      if (type === 'session.execution.interrupted') {
        closed = true
        terminal = { kind: 'aborted', failure: { message: 'local-opencode: opencode 中断了这一轮', code: CODE.ABORTED } }
        break
      }
    }

    if (closed === false) {
      // 流断了，或收尾事件被类型过滤漏掉：改读持久化的 assistant 消息兜底。
      const fallback = await client.lastAssistantText(sessionId).catch(function () { return undefined })
      const text = fallback && typeof fallback.text === 'string' ? fallback.text : undefined
      if (text !== undefined && text !== '') {
        if (text.trim() !== '') visibleText = true
        yield { type: 'block-start', index: index, blockType: 'text' }
        yield { type: 'text-delta', index: index, text: text }
        yield { type: 'block-end', index: index, block: { type: 'text', text: text } }
        index += 1
        if (fallback.tokens !== undefined) usage = mapTokens(fallback.tokens)
        terminal = { kind: 'stop' }
        if (logger && typeof logger.warn === 'function') logger.warn('local-opencode: 事件流未给出收尾事件，已用会话消息兜底')
      } else {
        terminal = { kind: 'error', failure: { message: 'local-opencode: agent 道的事件流提前结束，且会话里没有最终回答', code: CODE.TRANSPORT } }
      }
    }

    for (const block of blocks.values()) {
      if (block.open === false) continue
      block.open = false
      yield { type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } }
    }

    if (terminal === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'local-opencode: agent 道没有收到执行收尾事件', code: CODE.TRANSPORT } } }
      return
    }

    // 可见性按累计文本判定，不能只看 blocks：兜底路径的文本是直接发出的，
    // 没进 blocks，用 blocks 判定会把一次成功的兜底误判成空答。
    if (visibleText === false && terminal.kind === 'stop') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'local-opencode: agent 这一轮没有给出任何可见回答', code: CODE.EMPTY_RESPONSE } } }
      return
    }
    if (usage !== undefined) yield { type: 'usage', usage: usage }
    yield { type: 'finish', reason: terminal }
  }
  /** opencode 的执行失败体 → 内核 failure。 */
  failureFrom(error) {
    if (!error || typeof error !== 'object') {
      return { kind: 'error', failure: { message: 'local-opencode: agent 道执行失败（无错误详情）', code: CODE.UNKNOWN } }
    }
    const message = String(error.message || error.type || 'agent 道执行失败').replace(/\s+/g, ' ').slice(0, 400)
    const status = typeof error.status === 'number' ? error.status : undefined
    const retryAfterMs = typeof error.retryAfterMs === 'number' ? error.retryAfterMs : undefined
    const code = /region|not.?available|country/i.test(message) ? CODE.AUTH
      : /usage.?limit|quota/i.test(message) ? CODE.QUOTA
        : /rate.?limit|too.?many/i.test(message) ? CODE.RATE_LIMIT
          : /auth|credential|sign.?in/i.test(String(error.type || '')) ? CODE.AUTH
            : status !== undefined && status >= 500 ? CODE.SERVER
              : CODE.UNKNOWN
    const failure = { message: 'local-opencode: ' + message, code: code }
    if (status !== undefined) failure.status = status
    if (retryAfterMs !== undefined && retryAfterMs > 0) failure.providerRetryAfterMs = Math.round(retryAfterMs)
    return { kind: 'error', failure: failure }
  }
}
