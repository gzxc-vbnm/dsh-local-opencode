/**
 * dsh 的 llm 适配器：把一次 GenerateOptions 变成 opencode 本机的一次生成。
 *
 * 结构上满足 LlmAdapter 契约即可（registerAdapter 是靠调用方法校验的，不做 instanceof），
 * 所以这里不 import '@deepseek-ai/dsh-llm'，跨内核版本更稳。
 *
 * 会话生命周期绑在这一轮上：create -> /model（带 variant）-> generate -> delete。
 * 目录在 prepareCall 时冻结成快照，中途刷新不会把上一代的档位表接到这一代的调用上。
 *
 * 取消：fetch 走 AbortSignal.any([timeout, 外层 signal])，外层取消即中断；随后尽力
 * POST /interrupt 让 opencode 也停手，最后仍会删除会话。
 *
 * @module src/adapter.js
 */

import { CODE } from './errors.js'
import { baseModelId, buildPrompt, estimateTokens } from './state.js'

/** 每张图按 0 视觉 token + 占位文本计价：这条通道只送文本。 */
const IMAGE_ONLY_TEXT_PRICING = Object.freeze({
  priceImages(images) {
    return (images || []).map(function (image) {
      return image && image.offloaded === true
        ? { visualTokens: 0, text: '[image omitted]' }
        : { visualTokens: 0, text: '[图片未发送：本通道只送文本]' }
    })
  },
})

export class OpenCodeAdapter {
  /**
   * @param {{state: () => object, settings: () => object,
   *          routeLabels: Record<string, string>, logger?: object,
   *          ensureClient: () => Promise<object>, onUpstreamFailure: (error: Error) => void}} deps
   */
  constructor(deps) {
    this.deps = deps
  }

  providerInfo(provider) {
    return { id: provider, name: this.deps.routeLabels[provider] || provider }
  }

  /**
   * 完整策略对象（不是配置片段）：内核把这里的返回值原样存进注册表，退避调度直接读顶层字段。
   * 故意不把 RATE_LIMIT / AUTH 放进可重试集合：额度墙与区域拒绝是出口的事实，
   * 同一轮重试三次只会把一次配额变成三次（同 dsh-our-free-model 的判断）。
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
   * 图像请求计价（内核的 token meter 会**无保护地**调用它）。
   *
   * 本插件只送文本，像素永不进请求，所以每张图都是 0 visualTokens + 我们实际发出的
   * 占位文本。返回 undefined 会让内核放弃整条含图结果的落盘（issue #151 同类教训），
   * 因此这里给一份同步、无 I/O 的估算而不是留空。
   * @returns {{priceImages: (images: readonly object[]) => readonly {visualTokens: number, text: string}[]}}
   */
  imageRequestPricing() {
    return IMAGE_ONLY_TEXT_PRICING
  }

  /**
   * 图像请求投影目标。本插件不改写图像（根本不发图像），原样返回即可；
   * 必须有这个方法：内核直接 adapter.imageRequestTarget(...)，缺了就是 TypeError。
   */
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

  async * runStream(options, snapshot) {
    const modelId = baseModelId(options.model)
    const entry = snapshot.catalog.find(function (candidate) { return candidate.id === modelId })
    if (entry === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'local-opencode: 模型 ' + options.model + ' 不在本机 opencode 的目录里；先刷新模型目录或检查渠道是否已登录', code: CODE.INVALID_REQUEST } } }
      return
    }

    const settings = this.deps.settings()
    let client
    try {
      client = await this.deps.ensureClient()
    } catch (error) {
      this.deps.onUpstreamFailure(error)
      const failure = error && error.failure ? error.failure : { message: String((error && error.message) || error), code: CODE.TRANSPORT }
      yield { type: 'finish', reason: { kind: options.signal && options.signal.aborted ? 'aborted' : 'error', failure: failure } }
      return
    }

    const prompt = buildPrompt(options)
    // 思考档位就是 opencode 的 variant：内核传来什么档位，就用对应档位跑。
    const variant = typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '' ? options.reasoningEffort : undefined
    if (variant !== undefined && entry.variants.length > 0 && entry.variants.indexOf(variant) < 0) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'local-opencode: ' + entry.id + ' 不支持思考档位 ' + variant + '（可用：' + entry.variants.join('/') + '）', code: CODE.INVALID_REQUEST } } }
      return
    }

    const timeoutMs = settings.requestTimeoutMs
    let sessionId
    try {
      sessionId = await client.createSession('dsh:local-opencode', timeoutMs, options.signal)
    } catch (error) {
      // 建会话失败也要走统一的收尾，不向内核抛：取消归 aborted，其余归 error。
      this.deps.onUpstreamFailure(error)
      const aborted = options.signal && options.signal.aborted
      yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure: aborted ? { message: 'local-opencode: 请求已取消', code: CODE.ABORTED } : (error && error.failure ? error.failure : { message: String((error && error.message) || error), code: CODE.UNKNOWN }) } }
      return
    }

    let closed = false
    const cleanup = async () => {
      if (closed) return
      closed = true
      if (options.signal && options.signal.aborted) await client.interrupt(sessionId)
      await client.deleteSession(sessionId, 15000)
    }

    try {
      await client.selectModel(sessionId, { id: entry.modelID, providerID: entry.providerID }, variant, timeoutMs, options.signal)
      const result = await client.generate(sessionId, prompt, timeoutMs, options.signal)

      if (result.text.trim() === '') {
        // 空答在内核 taxonomy 里是可重试的独立事实，不伪装成正常收尾。
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'local-opencode: ' + entry.name + ' 这一轮没给出任何内容', code: 'EMPTY_RESPONSE' } } }
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

