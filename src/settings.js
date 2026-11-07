/**
 * 插件设置：内置默认 <- 磁盘设置文件 <- bundle config（cordis 注入，优先级最高）。
 *
 * 设置落在 '<dsh home>/local-opencode/settings.json'，而不是挂 dsh 的 settings 服务：
 * 两条内核线的 settings 形状不一样，而 headless 组合可能根本没挂它。自己拥有的文件在
 * 两边行为一致（同 dsh-our-free-model 的判断）。写盘走 tmp + rename，坏文件回落默认值。
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

export const DATA_DIR_NAME = 'local-opencode'

export const DEFAULTS = Object.freeze({
  /** false 时不注册模型路由：组从选择器消失，但配置保留，随时能开回来。 */
  enabled: true,
  /** 默认只收零成本模型；true 时把 opencode 目录里有计费的模型也一并列出。 */
  includePaid: Object.freeze({ githubCopilot: false, others: false }),
  /** 后台刷新 opencode 模型目录的间隔（分钟）；0 表示只在启动与手动刷新时拉。 */
  refreshMinutes: 30,
  /** 单次上游请求超时（毫秒）。 */
  requestTimeoutMs: 180000,
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

function normalize(raw) {
  const out = {}
  if (raw === undefined || raw === null) return out
  if (typeof raw !== 'object') return out
  if ('enabled' in raw) out.enabled = bool(raw.enabled, DEFAULTS.enabled)
  if ('includePaid' in raw) out.includePaid = paidSetting(raw.includePaid)
  if ('refreshMinutes' in raw && Number.isFinite(raw.refreshMinutes)) out.refreshMinutes = Math.min(1440, Math.max(0, Math.round(raw.refreshMinutes)))
  if ('requestTimeoutMs' in raw && Number.isFinite(raw.requestTimeoutMs)) out.requestTimeoutMs = Math.min(1800000, Math.max(5000, Math.round(raw.requestTimeoutMs)))
  return out
}

export function createSettings(_ref) {
  const dataDir = _ref.dataDir
  const logger = _ref.logger
  const config = _ref.config
  const file = path.join(dataDir, 'settings.json')
  let current = Object.assign({}, DEFAULTS)

  try {
    current = Object.assign({}, current, normalize(JSON.parse(fs.readFileSync(file, 'utf8'))))
  } catch (error) {
    if (error && error.code !== 'ENOENT') logger && logger.warn && logger.warn('local-opencode: 设置文件读不出来，先用默认值（' + String((error && error.message) || error) + '）')
  }
  // bundle config 覆盖磁盘：安装器/打包方给的是意图，用户改的是现状，意图赢。
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
      logger && logger.warn && logger.warn('local-opencode: 设置无法落盘（' + String((error && error.message) || error) + '）')
      return false
    }
  }

  return {
    file: file,
    get: function () { return current },
    update: function (patch) {
      current = Object.assign({}, current, normalize(patch))
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(function () { timer = undefined; flush() }, 200)
      if (timer.unref) timer.unref()
      return current
    },
    flush: flush,
    dispose: function () { if (timer !== undefined) { clearTimeout(timer); timer = undefined } flush() },
  }
}
