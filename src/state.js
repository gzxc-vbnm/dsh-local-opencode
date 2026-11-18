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
  // 如实声明：本插件走 opencode 的 stateless generate 通道，只送文本，像素到不了模型。
  // 上游渠道自己支持什么写进 description，避免选择器把"支持图片"当成这条通道的能力。
  const modalities = ['text']
  const effort = effortsFor(entry)
  const output = number(limit.output)
  const context = number(limit.context)
  const description = [
    '本机 opencode（' + String(entry.providerID) + '）',
    isZeroCost(entry) ? '免费·零成本' : '计费',
    context ? '上下文 ' + Math.round(context / 1024) + 'K' : undefined,
    effort ? '思考档位 ' + effort.efforts.map(function (e) { return e.name }).join('/') : undefined,
    input.length > 1 ? '上游支持 ' + input.join('/') + '（本通道仅文本）' : undefined,
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
    defaultVariant: entry.variants && entry.variants.length > 0 ? entry.variants[0] : undefined,
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

/**
 * agent 道的 prompt：与文本道同构（历史压平成文本），但结尾说明不同。
 *
 * 文本道要告诉模型「别声称要调工具」；agent 道里工具确实会执行 —— 只是执行者是
 * opencode，不是 dsh。所以这里说的是「工作目录与工具由 opencode 侧提供，dsh 声明的
 * 工具不可用」，否则模型会以为 dsh 的工具能跑，产出没人接管的调用。
 */
export function buildAgentPrompt(options) {
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
      if (lastRole === 'system') lines.push('【接上文】')
      lines.push(text)
      lastRole = 'user'
      continue
    }
    lines.push('【助手上一轮】' + text)
    lastRole = 'assistant'
  }
  lines.push(AGENT_NOTICE)
  return lines.join('\n\n')
}

/** agent 道结尾说明：工具由 opencode 执行，dsh 侧声明的那套不可用。 */
export const AGENT_NOTICE = [
  '说明：本轮由本机 opencode 的 agent 执行。你可以请求读写文件与执行命令，它们会由 opencode',
  '在它自己的工作目录里真实运行（受插件的权限设置约束，越权的动作会被自动拒绝）。',
  'dsh 侧声明的工具在这一道不可用，不要尝试调用它们；需要外部信息时直接说明缺什么。',
].join('\n')

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
    membership: { 'local-opencode': [], 'local-opencode-paid': [] },
    connection: { status: 'idle', message: '还没连过本机 opencode', at: 0, source: undefined, version: undefined },
    lastRefresh: undefined,
    refreshing: undefined,
    /** agent 目录缓存：侧栏下拉用，不参与模型成员表。 */
    agents: undefined,
  }
}

export function membershipFor(catalog, settings) {
  const paid = settings.includePaid || {}
  // 侧栏「显示/不显示」写进 hiddenModels；它优先于 includePaid，因为用户的显隐
  // 意图比「这一类要不要收」更具体（includePaid=true 也不能把被点名隐藏的模型放回来）。
  const hidden = new Set(Array.isArray(settings.hiddenModels) ? settings.hiddenModels : [])
  const main = []
  const paidRoute = []
  for (const entry of catalog) {
    if (entry.enabled === false) continue
    if (entry.status === 'deprecated') continue
    if (hidden.has(entry.id)) continue
    if (entry.free) { if (main.indexOf(entry.id) < 0) main.push(entry.id); continue }
    const want = entry.providerID === 'github-copilot' ? paid.githubCopilot : paid.others
    if (want && paidRoute.indexOf(entry.id) < 0) paidRoute.push(entry.id)
  }
  return { 'local-opencode': main, 'local-opencode-paid': paidRoute }
}

/**
 * 侧栏要渲染的完整清单：目录里每一个模型，标出它在哪个分组、是否被隐藏。
 *
 * 单靠 membership 无法渲染「不显示」按钮，因为隐藏的模型根本不在 membership 里；
 * 界面需要的是「所有可隐藏项 + 当前可见性」，所以这里按同一套规则再走一遍，但
 * 不丢掉被隐藏的项。可见性判定必须与 membershipFor 同源，否则界面与选择器会说谎。
 */
export function visibilityRows(catalog, settings) {
  const paid = settings.includePaid || {}
  const hidden = new Set(Array.isArray(settings.hiddenModels) ? settings.hiddenModels : [])
  const rows = []
  for (const entry of catalog) {
    if (entry.enabled === false || entry.status === 'deprecated') {
      rows.push(row(entry, 'unavailable', hidden.has(entry.id)))
      continue
    }
    if (hidden.has(entry.id)) { rows.push(row(entry, 'hidden', true)); continue }
    if (entry.free) { rows.push(row(entry, 'free', false)); continue }
    const want = entry.providerID === 'github-copilot' ? paid.githubCopilot : paid.others
    rows.push(row(entry, want ? 'paid' : 'unlisted', false))
  }
  return rows
}

function row(entry, group, hidden) {
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.providerID,
    free: entry.free === true,
    group: group,
    hidden: hidden === true,
    // 只有真的进了某个路由分组的模型才能被拨回来；unlisted 的模型是「计费但未纳入」，
    // 侧栏对它只读，避免点一下就把计费模型塞进选择器。
    toggleable: group === 'free' || group === 'paid' || group === 'hidden',
    contextWindow: entry.contextWindow,
    modalities: entry.modalities,
    variants: entry.variants,
    description: entry.description,
  }
}