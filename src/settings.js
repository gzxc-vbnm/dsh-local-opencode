/**
 * 插件设置：内置默认 <- 磁盘设置文件 <- bundle config（cordis 注入，优先级最高）。
 *
 * 设置落在 '&lt;dsh home&gt;/local-opencode/settings.json'，而不是挂 dsh 的 settings 服务：
 * 两条内核线的 settings 形状不一样，而 headless 组合可能根本没挂它。自己拥有的文件在
 * 两边行为一致。写盘走 tmp + rename，坏文件回落默认值。
 *
 * @module src/settings.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 与内核 home-paths helper 一致的解析：$DSH_HOME 优先，否则 ~/.dsh。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * 运行时数据目录名（相对 dsh home）。它必须与 npm 包名不同：安装位置按惯例是
 * ~/.dsh/&lt;包名&gt;，同名就等于把用户设置写进包目录本身，重装时被连带删掉。
 */
export const DATA_DIR_NAME = 'local-opencode'

/** 两条通道：text = 无工具文本道；agent = 走 opencode 的 agent 循环（带工具）。 */
export const CHANNELS = Object.freeze({ text: 'text', agent: 'agent' })

/**
 * agent 道的权限代答策略。
 *
 * dsh 侧的权限模型传不到 opencode：agent 道里每次工具执行由 opencode 自己的 permission
 * 机制把关，插件必须应答，否则整轮挂在 pending 上永不返回。三种策略都是插件代答，
 * 区别只在答案：
 *  - allow-read 只放行读类动作，写类一律 reject（默认，最保守的可用档）
 *  - allow-all  全部放行 —— 模型可能真的改你的文件，只在明确知情时开
 *  - reject     一律拒绝，等于关掉 agent 道的工具能力（只剩多轮推理）
 */
export const PERMISSION_MODES = Object.freeze({ allowRead: 'allow-read', allowAll: 'allow-all', reject: 'reject' })

/** 读类动作名：allow-read 只认这些，其余一律按写类处理。 */
export const READ_ONLY_ACTIONS = Object.freeze(['read', 'list', 'grep', 'glob', 'find', 'view', 'search', 'ls', 'tree', 'skill', 'webfetch', 'websearch', 'question'])

export const DEFAULTS = Object.freeze({
  /** false 时不注册模型路由：组从选择器消失，但配置保留，随时能开回来。 */
  enabled: true,
  /** 默认只收零成本模型；true 时把 opencode 目录里有计费的模型也一并列出。 */
  includePaid: Object.freeze({ githubCopilot: false, others: false }),
  /** 后台刷新 opencode 模型目录的间隔（分钟）；0 表示只在启动与手动刷新时拉。 */
  refreshMinutes: 30,
  /** 单次上游请求超时（毫秒），作用于文本道的无状态生成。 */
  requestTimeoutMs: 180000,
  /** 当前通道。侧栏的「带工具」按钮切换它；两条道共用同一份模型目录。 */
  channel: 'text',
  /** 侧栏「显示/不显示」的隐藏清单：这些模型 id 不进任何路由分组。 */
  hiddenModels: Object.freeze([]),
  /** agent 道的权限代答策略。 */
  permissionMode: 'allow-read',
  /** agent 道的工作目录：opencode 的工具在它里面执行；空表示沿用服务自己的位置。 */
  workingDirectory: '',
  /** agent 道使用的 opencode agent（build / plan / explore …）；空表示服务端默认。 */
  agentName: '',
  /** agent 道一整轮（含多次工具往返）的超时上限（毫秒）。 */
  agentTurnTimeoutMs: 600000,
})

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function paidSetting(raw) {
  const base = { githubCopilot: false, others: false }
  if (raw === true) return { githubCopilot: true, others: true }
  if (raw === false || raw === undefined || raw === null) return base
  if (typeof raw !== 'object') return base
  return {
    githubCopilot: bool(raw.githubCopilot, bool(raw.copilot, false)),
    others: bool(raw.others, bool(raw.other, false)),
  }
}

/** 通道：接受新值与人类习惯的同义词；无法识别时返回 undefined（保持原值）。 */
function channelSetting(raw) {
  if (raw === true) return CHANNELS.agent
  if (raw === false) return CHANNELS.text
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  if (value === 'text' || value === 'plain' || value === 'no-tools') return CHANNELS.text
  if (value === 'agent' || value === 'tools' || value === 'with-tools') return CHANNELS.agent
  return undefined
}

function permissionSetting(raw) {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  if (value === 'allow-read' || value === 'readonly' || value === 'read') return PERMISSION_MODES.allowRead
  if (value === 'allow-all' || value === 'all' || value === 'trust') return PERMISSION_MODES.allowAll
  if (value === 'reject' || value === 'deny' || value === 'none') return PERMISSION_MODES.reject
  return undefined
}

function stringSetting(raw, maximum) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value.length > maximum) return undefined
  return value
}

/** 隐藏清单：只收非空字符串 id，去重并限长，避免一个坏数组把选择器整个清空。 */
function idList(raw, maximum) {
  if (!Array.isArray(raw)) return undefined
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (value === '' || out.includes(value)) continue
    out.push(value)
    if (out.length >= maximum) break
  }
  return out
}

function normalize(raw) {
  const out = {}
  if (raw === undefined || raw === null) return out
  if (typeof raw !== 'object') return out
  if ('enabled' in raw) out.enabled = bool(raw.enabled, DEFAULTS.enabled)
  if ('includePaid' in raw) out.includePaid = paidSetting(raw.includePaid)
  if ('refreshMinutes' in raw && Number.isFinite(raw.refreshMinutes)) out.refreshMinutes = Math.min(1440, Math.max(0, Math.round(raw.refreshMinutes)))
  if ('requestTimeoutMs' in raw && Number.isFinite(raw.requestTimeoutMs)) out.requestTimeoutMs = Math.min(1800000, Math.max(5000, Math.round(raw.requestTimeoutMs)))
  if ('channel' in raw) { const value = channelSetting(raw.channel); if (value !== undefined) out.channel = value }
  if ('hiddenModels' in raw) { const list = idList(raw.hiddenModels, 512); if (list !== undefined) out.hiddenModels = list }
  if ('permissionMode' in raw) { const value = permissionSetting(raw.permissionMode); if (value !== undefined) out.permissionMode = value }
  if ('workingDirectory' in raw) { const value = stringSetting(raw.workingDirectory, 512); if (value !== undefined) out.workingDirectory = value }
  if ('agentName' in raw) { const value = stringSetting(raw.agentName, 64); if (value !== undefined) out.agentName = value }
  if ('agentTurnTimeoutMs' in raw && Number.isFinite(raw.agentTurnTimeoutMs)) out.agentTurnTimeoutMs = Math.min(3600000, Math.max(30000, Math.round(raw.agentTurnTimeoutMs)))
  return out
}

export function createSettings(_ref) {
  const dataDir = _ref.dataDir
  const logger = _ref.logger
  const config = _ref.config
  const warn = (message) => { if (logger && typeof logger.warn === 'function') logger.warn(message) }
  const info = (message) => { if (logger && typeof logger.info === 'function') logger.info(message) }
  const file = path.join(dataDir, 'settings.json')
  let current = Object.assign({}, DEFAULTS)

  try {
    current = Object.assign({}, current, normalize(JSON.parse(fs.readFileSync(file, 'utf8'))))
  } catch (error) {
    if (error && error.code !== 'ENOENT') warn('local-opencode: 设置文件读不出来，先用默认值（' + String((error && error.message) || error) + '）')
  }
  // bundle config 覆盖磁盘：安装器给的是意图，用户改的是现状，意图赢。
  current = Object.assign({}, current, normalize(config))

  let timer = undefined

  function flush() {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(current, null, 2))
      fs.renameSync(tmp, file)
      return true
    } catch (error) {
      warn('local-opencode: 设置无法落盘（' + String((error && error.message) || error) + '）')
      return false
    }
  }

  return {
    file: file,
    get: function () { return current },
    /** 合并并去抖落盘；返回值是当前完整设置。 */
    update(patch) {
      current = Object.assign({}, current, normalize(patch))
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(function () { timer = undefined; flush() }, 200)
      if (timer.unref) timer.unref()
      return current
    },
    /** 立即合并并同步落盘：侧栏点一下按钮就要马上生效，不能等去抖窗口。 */
    updateNow(patch) {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      current = Object.assign({}, current, normalize(patch))
      flush()
      return current
    },
    flush: flush,
    info: info,
    dispose: function () { if (timer !== undefined) { clearTimeout(timer); timer = undefined } flush() },
  }
}
