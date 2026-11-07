/**
 * 模型目录与运行时状态。
 *
 * 目录来自本机 opencode 的 GET /api/model —— 它就是"这台机器上现在真的能用哪些模型"
 * 的唯一权威来源（opencode 已经登录的渠道、各自的 cost/context/能力/思考档位都在这里）。
 * 插件自己不再抄一份清单：抄来的清单会在 opencode 换渠道后立刻说谎。
 *
 * 失败策略：刷新失败时**保留旧目录**，只把连接状态标成 disconnected 并记下原因。
 * 路由不撤（撤了选择器会整组消失，用户看不到"为什么没了"的线索）；等下一次真正的
 * 调用或后台刷新自愈。
 *
 * @module src/state.js
 */

import { CODE, OpenCodeError } from './errors.js'

/** 主路由：默认只装零成本模型。 */
export const ROUTE = 'local-opencode'
export const ROUTE_LABEL = 'Local OpenCode'
/** 付费路由：默认空组；includePaid 打开后填充。GUI 会丢掉空组，所以默认等于"只看到免费模型"。 */
export const ROUTE_PAID = 'local-opencode-paid'
export const ROUTE_PAID_LABEL = 'Local OpenCode · 计费模型'

const VARIANT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const VARIANT_NAMES = {
  none: '不思考', minimal: '极轻', low: '轻', medium: '中', high: '高', xhigh: '极高', max: '最大',
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 一个 opencode 模型条目是否零成本（cost 数组里每档 input/output 都是 0）。 */
function isZeroCost(entry) {
  const cost = entry.cost
  if (!Array.isArray(cost) || cost.length === 0) return true
  return cost.every(function (row) {
    const input = number(row && row.input)
    const output = number(row && row.output)
    return (input === undefined || input === 0) && (output === undefined || output === 0)
  })
}

/** dsh 里展示的模型 id：provider 前缀保证跨渠道不撞名。 */
export function harnessModelId(entry) {
  return String(entry.providerID) + '/' + String(entry.id)
}

/** 剥掉内核可能附加的 "(level)" 思考后缀，回到基础模型 id。 */
export function baseModelId(model) {
  const text = String(model === undefined || model === null ? '' : model).trim()
  const open = text.lastIndexOf('(')
  if (open > 0 && text.endsWith(')')) {
    const candidate = text.slice(open + 1, -1).trim().toLowerCase()
    if (candidate !== '' && VARIANT_ORDER.includes(candidate)) return text.slice(0, open).trim()
  }
  return text
}

function effortsFor(entry) {
  const variants = Array.isArray(entry.variants) ? entry.variants : []
  const ids = []
  for (const variant of variants) {
    const id = String((variant && variant.id) || '').toLowerCase()
    if (id !== '' && VARIANT_ORDER.includes(id) && !ids.includes(id)) ids.push(id)
  }
  if (ids.length < 2) return undefined
  ids.sort(function (a, b) { return VARIANT_ORDER.indexOf(a) - VARIANT_ORDER.indexOf(b) })
  return {
    efforts: ids.map(function (id) { return { id: id, name: VARIANT_NAMES[id] || id } }),
  }
}

/** 把一条 opencode 目录投影成 dsh 需要的模型形状（目录用的精简版）。 */
export function toCatalogEntry(entry) {
  const limit = entry.limit || {}
  const capabilities = entry.capabilities || {}
  const input = Array.isArray(capabilities.input) ? capabilities.input : ['text']
  const modalities = input.includes('image') ? ['text', 'image'] : ['text']
  const effort = effortsFor(entry)
  const output = number(limit.output)
  const context = number(limit.context)
  const description = [
    '本机 opencode（' + String(entry.providerID) + '）',
    isZeroCost(entry) ? '免费·零成本' : '计费',
    context ? '上下文 ' + Math.round(context / 1024) + 'K' : undefined,
    effort ? '思考档位 ' + effort.efforts.map(function (e) { return e.name }).join('/') : undefined,
    input.length > 1 ? '输入 ' + input.join('/') : undefined,
    entry.status && entry.status !== 'active' ? entry.status : undefined,
  ].filter(Boolean).join(' · ')
  return {
    id: harnessModelId(entry),
    providerID: String(entry.providerID),
    modelID: String(entry.id),
    name: String(entry.name || entry.id),
    description: description,
    free: isZeroCost(entry),
    modalities: modalities,
    contextWindow: context || 200000,
    maxOutput: output || 32000,
    temperature: capabilities.temperature !== false,
    variants: Array.isArray(entry.variants) ? entry.variants.map(function (v) { return String(v.id) }) : [],
    effort: effort,
    status: entry.status,
    enabled: entry.enabled !== false,
  }
}

/**
 * dsh 的 ContentBlock[] -> 一段纯文本 prompt。
 *
 * 这条通道没有函数调用，也没有原生图片槽位，所以历史一律压成文本：
 * - 取消 dsh 的 tools 声明（否则模型会照旧"说要调工具"却没有任何机制把结果喂回去）；
 * - tool-call / tool 结果渲染成可读的对话片段，让模型知道自己上一轮被叫停过；
 * - image 落成占位文本（文件名/类型），file 已由内核投影成 handle 文本。
 */
export function flattenBlocks(content) {
  const parts = []
  for (const block of content || []) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text': if (block.text) parts.push(String(block.text)); break
      case 'reasoning': break
      case 'image': {
        const ref = block.attachment || {}
        parts.push('[图片 ' + (ref.name || ref.mediaType || 'image') + (ref.width ? ' ' + ref.width + 'x' + ref.height : '') + '；这条通道收不到像素，请据文字描述回答]')
        break
      }
      case 'file': {
        const ref = block.attachment || {}
        parts.push('[文件 ' + (ref.name || 'file') + ']')
        break
      }
      case 'tool-call': parts.push('[此前请求调用工具 ' + block.name + '，参数 ' + (block.arguments || '{}') + ']'); break
      case 'tool-addition': parts.push('[工具 ' + block.toolName + ' 已声明]'); break
      case 'tool-removal': parts.push('[工具 ' + block.toolName + ' 已移除]'); break
      default: if (typeof block.text === 'string' && block.text) parts.push(String(block.text)); break
    }
  }
  return parts.join('\n').trim()
}

const NO_TOOLS_NOTICE = '说明：当前模型通道不支持函数调用/工具执行。请不要声明要调用任何工具，直接用文字给出你的答案；需要执行操作时，把你要做的事写清楚即可。'

export function buildPrompt(options) {
  const lines = []
  let lastRole = ''
  if (typeof options.system === 'string' && options.system.trim() !== '') {
    lines.push('【系统】' + options.system.trim())
    lastRole = 'system'
  }
  for (const message of options.messages || []) {
    const text = flattenBlocks(message.content)
    if (text === '') continue
    if (message.role === 'system') { lines.push('【系统】' + text); lastRole = 'system'; continue }
    if (message.role === 'developer') { lines.push('【开发者】' + text); lastRole = 'developer'; continue }
    if (message.role === 'tool') { lines.push('【工具 ' + (message.toolCallId || '') + ' 的结果】' + text); lastRole = 'tool'; continue }
    if (message.role === 'user') {
      // 内核把每轮的最新系统提示作为 system 消息放进历史；压成一段标注，避免与尾部说明重复两次。
      if (lastRole === 'system') lines.push('【接上文】')
      lines.push(text)
      lastRole = 'user'
      continue
    }
    lines.push('【助手上一轮】' + text)
    lastRole = 'assistant'
  }
  lines.push(NO_TOOLS_NOTICE)
  return lines.join('\n\n')
}

export function estimateTokens(text) {
  // 粗略：CJK 约 1 token/字，其余约 4 字符/token。上游不回报 usage，所以只能估算。
  let cjk = 0
  let other = 0
  for (const char of String(text || '')) {
    const code = char.codePointAt(0)
    if (code > 0x2e7f && code < 0xac00) cjk += 1
    else if (code >= 0xf900 && code <= 0xfaff) cjk += 1
    else if (code >= 0x3000 && code <= 0x30ff) cjk += 1
    else if (code >= 0xff00 && code <= 0xffef) cjk += 1
    else other += 1
  }
  return Math.max(1, Math.round(cjk + other / 4))
}

export function createState() {
  return {
    /** 目录（opencode 全量模型，含不计费的）。 */
    catalog: [],
    /** 路由成员表：{ [route]: string[] } */
    membership: { ROUTE: [], PAID: [] },
    connection: { status: 'idle', message: '还没连过本机 opencode', at: 0, source: undefined, version: undefined },
    lastRefresh: undefined,
    refreshing: undefined,
  }
}

export function membershipFor(catalog, settings) {
  const paid = settings.includePaid || {}
  const main = []
  const paidRoute = []
  for (const entry of catalog) {
    if (entry.enabled === false) continue
    if (entry.status === 'deprecated') continue
    if (entry.free) { if (main.indexOf(entry.id) < 0) main.push(entry.id); continue }
    const want = entry.providerID === 'github-copilot' ? paid.githubCopilot : paid.others
    if (want && paidRoute.indexOf(entry.id) < 0) paidRoute.push(entry.id)
  }
  return { 'local-opencode': main, 'local-opencode-paid': paidRoute }
}
