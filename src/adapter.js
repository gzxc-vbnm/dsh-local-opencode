/**
 * dsh 的 llm 适配器：把一次 GenerateOptions 变成本机 opencode 的一次生成。
 *
 * 结构上满足 LlmAdapter 契约即可（registerAdapter 靠调用方法校验，不做 instanceof），
 * 所以这里不 import '@deepseek-ai/dsh-llm'，跨内核版本更稳。
 *
 * 两条通道（设置里的 channel，侧栏可切）：
 *  - text  无状态 session/generate：一次进一次出，永远没有工具，零副作用。
 *  - agent opencode 的 agent 循环：工具在它的工作目录里真的执行，权限由插件代答。
 * 两条道共用同一份目录与同一套档位校验，所以校验放在分叉之前，只此一处。
 *
 * 会话生命周期绑在这一轮上；目录在 prepareCall 时冻结成快照，中途刷新不会把
 * 上一代的档位表接到这一代的调用上。
 *
 * @module src/adapter.js
 */

import { CODE } from './errors.js'
import { baseModelId, buildAgentPrompt, buildPrompt, estimateTokens } from './state.js'
import { AgentLane } from './agent-lane.js'

/** 每张图按 0 视觉 token + 占位文本计价：两条通道都只送文本。 */
const IMAGE_ONLY_TEXT_PRICING = Object.freeze({
  priceImages(images) {
    return (images || []).map(function (image) {
      return image && image.offloaded === true
        ? { visualTokens: 0, text: '[image omitted]' }
        : { visualTokens: 0, text: '[图片未发送：本通道只送文本]' }
    })
  },
})

/** 一个纯失败收尾 chunk。 */
function failureChunk(failure) {
  return { type: 'finish', reason: { kind: 'error', failure: failure } }
}

/** 取消归 aborted，其余归 error；两条都带完整 failure。 */
function abortedOrError(options, error, fallbackCode) {
  if (options.signal && options.signal.aborted) {
    return { type: 'finish', reason: { kind: 'aborted', failure: { message: 'local-opencode: 请求已取消', code: CODE.ABORTED } } }
  }
  const failure = error && error.failure
    ? error.failure
    : { message: String((error && error.message) || error), code: fallbackCode || CODE.UNKNOWN }
  return { type: 'finish', reason: { kind: 'error', failure: failure } }
}

export class OpenCodeAdapter {
  /**
   * @param {{state: () => object, settings: () => object,
   *          routeLabels: Record<string, string>, logger?: object,
   *          ensureClient: () => Promise<object>, onUpstreamFailure: (error: object) => void}} deps
   */
  constructor(deps) {
    this.deps = deps
    this.lane = new AgentLane({
      settings: deps.settings,
      logger: deps.logger,
      prompt: buildAgentPrompt,
    })
  }

  providerInfo(provider) {
    return { id: provider, name: this.deps.routeLabels[provider] || provider }
  }

  /**
   * 完整策略对象（不是配置片段）：内核把这里的返回值原样存进注册表，退避调度直接读
   * 顶层字段。故意不把 AUTH / RATE_LIMIT / QUOTA 放进可重试集合：区域拒绝与额度墙是
   * 出口的事实，同一轮重试三次只会把一次配额变成三次。
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 800,
      maxDelayMs: 6000,
      jitterRatio: 0.2,
    })
  }

  /**
   * 图像请求计价。内核的 token meter 会无保护地调它，缺了就是 TypeError；
   * 返回 undefined 会让内核放弃整条含图结果的落盘，所以给一份同步、无 I/O 的估算。
   */
  imageRequestPricing() {
    return IMAGE_ONLY_TEXT_PRICING
  }

  /** 本插件不改写图像（根本不发图像），原样返回；内核同样是无保护调用，必须有。 */
  imageRequestTarget(_provider, _model, image) {
    return image
  }

  async listModels(provider) {
    const snapshot = this.deps.state()
    const ids = snapshot.membership[provider] || []
    const out = []
    for (const id of ids) {
      const entry = snapshot.catalog.find(function (candidate) { return candidate.id === id })
      if (entry === undefined) continue
      out.push({ provider: provider, id: entry.id, name: entry.name, description: entry.description, inputModalities: entry.modalities })
    }
    return out
  }

  async resolveModel(provider, model) {
    const snapshot = this.deps.state()
    const base = baseModelId(model)
    const entry = snapshot.catalog.find(function (candidate) { return candidate.id === base })
    if (entry === undefined) {
      // 目录没命中也要能路由（内核说目录成员是建议性的）：给一份保守元数据。
      return { provider: provider, id: base, name: base, context: { contextWindow: 200000 }, defaultMaxTokens: 32000 }
    }
    const info = {
      provider: provider,
      id: entry.id,
      name: entry.name,
      description: entry.description,
      inputModalities: entry.modalities,
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: entry.maxOutput,
    }
    if (entry.effort) info.reasoning = entry.effort
    return info
  }

  async prepareCall(provider, model) {
    const snapshot = this.deps.state()
    return {
      // 必须是已解析的对象：内核只 await prepareCall 本身，然后同步校验 .model 的字段。
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream(options, snapshot),
    }
  }

  stream(options, snapshot) {
    const iterator = this.runStream(options, snapshot || this.deps.state())
    return {
      [Symbol.asyncIterator]: function () { return this },
      next: function (value) { return iterator.next(value) },
      return: function (value) { return iterator.return ? iterator.return(value) : { done: true, value: value } },
      throw: function (error) { return iterator.throw ? iterator.throw(error) : Promise.reject(error) },
    }
  }

  /**
   * 两条通道的公共前段：定位目录行、拿到 client、校验档位。
   * 失败就地 yield 终止 chunk 并结束；成功返回 {entry, client, variant}。
   */
  async * dispatch(options, snapshot) {
    const modelId = baseModelId(options.model)
    const entry = snapshot.catalog.find(function (candidate) { return candidate.id === modelId })
    if (entry === undefined) {
      yield failureChunk({
        message: 'local-opencode: 模型 ' + options.model + ' 不在本机 opencode 的目录里；先刷新模型目录或检查渠道是否已登录',
        code: CODE.INVALID_REQUEST,
      })
      return
    }

    let client
    try {
      client = await this.deps.ensureClient()
    } catch (error) {
      this.deps.onUpstreamFailure(error)
      const aborted = options.signal && options.signal.aborted
      yield abortedOrError(options, error, CODE.TRANSPORT)
      return
    }

    // 思考档位就是 opencode 的 variant：内核传来什么档位，就用对应档位跑。
    const variant = typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '' ? options.reasoningEffort : undefined
    if (variant !== undefined && Array.isArray(entry.variants) && entry.variants.length > 0 && entry.variants.indexOf(variant) < 0) {
      yield failureChunk({
        message: 'local-opencode: ' + entry.id + ' 不支持思考档位 ' + variant + '（可用：' + entry.variants.join('/') + '）',
        code: CODE.INVALID_REQUEST,
      })
      return
    }

    return { entry: entry, client: client, variant: variant }
  }

  async * runStream(options, snapshot) {
    const prepared = yield * this.dispatch(options, snapshot)
    // dispatch 已经自己发完终止 chunk（或没找到可继续的东西）时，prepared 是 undefined。
    if (prepared === undefined) return
    const entry = prepared.entry
    const client = prepared.client
    const variant = prepared.variant

    if (this.deps.settings().channel === 'agent') {
      yield * this.runAgent(options, entry, client, variant)
      return
    }
    yield * this.runText(options, entry, client, variant)
  }

  /** agent 道一轮：交给 AgentLane（会话与事件流的生死都在那里收尾）。 */
  async * runAgent(options, entry, client, variant) {
    try {
      for await (const chunk of this.lane.run(options, entry, client, variant)) {
        // 传输级失败要让宿主知道链路可能断了，别的（额度/区域）只是这一轮的事实。
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          const code = chunk.reason.failure && chunk.reason.failure.code
          if (code === CODE.TRANSPORT || code === CODE.TIMEOUT || code === CODE.SERVER) this.deps.onUpstreamFailure({ code: code, failure: chunk.reason.failure })
        }
        yield chunk
      }
    } catch (error) {
      if (options.signal && options.signal.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'local-opencode: 请求已取消', code: CODE.ABORTED } } }
        return
      }
      this.deps.onUpstreamFailure(error)
      const failure = error && error.failure ? error.failure : { message: String((error && error.message) || error), code: CODE.UNKNOWN }
      yield { type: 'finish', reason: { kind: 'error', failure: failure } }
    }
  }

  /** 文本道一轮：建会话 → 设模型档位 → 无状态生成 → 删会话。 */
  async * runText(options, entry, client, variant) {
    const settings = this.deps.settings()
    const timeoutMs = settings.requestTimeoutMs
    let sessionId
    try {
      sessionId = await client.createSession('dsh:local-opencode', timeoutMs, options.signal)
    } catch (error) {
      // 建会话失败也走统一收尾，不向内核抛：取消归 aborted，其余归 error。
      this.deps.onUpstreamFailure(error)
      yield abortedOrError(options, error, CODE.UNKNOWN)
      return
    }

    let cleaned = false
    const cleanup = async () => {
      if (cleaned) return
      cleaned = true
      if (options.signal && options.signal.aborted) await client.interrupt(sessionId)
      await client.deleteSession(sessionId, 15000)
    }

    try {
      const prompt = buildPrompt(options)
      await client.selectModel(sessionId, { id: entry.modelID, providerID: entry.providerID }, variant, timeoutMs, options.signal)
      const result = await client.generate(sessionId, prompt, timeoutMs, options.signal)

      if (result.text.trim() === '') {
        // 空答在内核 taxonomy 里是可重试的独立事实，不伪装成正常收尾。
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'local-opencode: ' + entry.name + ' 这一轮没给出任何内容', code: CODE.EMPTY_RESPONSE } } }
        return
      }

      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: result.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: result.text } }
      const inputTokens = estimateTokens(prompt)
      const outputTokens = estimateTokens(result.text)
      yield { type: 'usage', usage: { inputTokens: inputTokens, outputTokens: outputTokens, totalTokens: inputTokens + outputTokens } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      if (options.signal && options.signal.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'local-opencode: 请求已取消', code: CODE.ABORTED } } }
        return
      }
      this.deps.onUpstreamFailure(error)
      const failure = error && error.failure ? error.failure : { message: String((error && error.message) || error), code: CODE.UNKNOWN }
      yield { type: 'finish', reason: { kind: 'error', failure: failure } }
    } finally {
      await cleanup()
    }
  }
}
