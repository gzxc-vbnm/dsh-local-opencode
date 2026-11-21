/**
 * opencode 的安装探测、后台拉起与一键安装。
 *
 * 三件事都必须自己拥有，不能借道插件以外的东西：
 *  - 探测：dsh 启动时要知道这台机器上到底有没有 opencode（决定面板显示安装卡还是运行卡）；
 *  - 拉起：`opencode service start` 会把后台服务拉起来并回写 service.json，冷启动约 9 秒，
 *    已运行时是幂等的 0.5 秒——所以它可以在插件载入时静默跑一次，不需要用户点任何东西；
 *  - 安装：给还没装的人一条路，装的必须是 2.x 那条线（包名 @opencode/cli）。1.x 的
 *    opencode-ai 走的是另一套 HTTP 路由，装上它插件反而连不上，所以这里不能写“装最新版 opencode”。
 *
 * 进程一律 windowsHide + 管道，失败只改状态绝不抛给调用方：插件载入不该因为本机没装
 * opencode 而失败，该失败的是“打开面板时看到一条说明”。
 *
 * @module src/runtime.js
 */

import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 一键安装装的包：2.x 线（/api/* 路由）。1.x 的 opencode-ai 与插件不兼容。 */
export const INSTALL_PACKAGE = '@opencode/cli@latest'
/** `service start` 冷启动实测 9.2 秒，留足首次解包的时间。 */
export const SERVICE_TIMEOUT_MS = 180000
/** 一次全局 npm 安装要下载几十 MB 的二进制。 */
export const INSTALL_TIMEOUT_MS = 600000
const DETECT_TTL_MS = 5000
const OUTPUT_LIMIT = 4000

function trimText(value) {
  const text = String(value === undefined || value === null ? '' : value)
  return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text
}

/** npm 的全局 node_modules 目录候选（探测 @opencode/cli 的真实安装位置）。 */
export function globalRoots(env) {
  const source = env || process.env
  const roots = []
  const add = function (value) {
    if (typeof value !== 'string' || value.trim() === '') return
    if (roots.indexOf(value) >= 0) return
    roots.push(value)
  }
  const prefix = source.NPM_CONFIG_PREFIX || source.npm_config_prefix
  if (typeof prefix === 'string' && prefix.trim() !== '') {
    if (process.platform === 'win32') add(path.join(prefix, 'node_modules'))
    else { add(path.join(prefix, 'lib', 'node_modules')); add(path.join(prefix, 'node_modules')) }
  }
  // node 可执行文件旁边就是 npm 的默认前缀（Windows 的 C:/Users/<u>/AppData/Roaming/npm）。
  add(path.join(path.dirname(process.execPath), 'node_modules'))
  if (process.platform === 'win32') {
    if (source.APPDATA) add(path.join(source.APPDATA, 'npm', 'node_modules'))
  } else {
    add(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'))
    add('/usr/local/lib/node_modules')
    add('/opt/homebrew/lib/node_modules')
  }
  return roots
}

/** 包自带的二进制（npm 的 bin 垫片只是转手，直接命中真身更省一层）。 */
function packageBinaries(root) {
  const base = path.join(root, '@opencode', 'cli', 'bin')
  return process.platform === 'win32' ? [path.join(base, 'opencode.exe')] : [path.join(base, 'opencode')]
}

function pathNames() {
  return process.platform === 'win32'
    ? ['opencode.exe', 'opencode.cmd', 'opencode.bat']
    : ['opencode']
}

function kindOf(binary) {
  const lower = String(binary || '').toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return 'shim'
  if (lower.endsWith('.ps1')) return 'powershell'
  return 'exe'
}

function isFile(candidate) {
  try { return fs.statSync(candidate).isFile() } catch { return false }
}

/**
 * 找本机的 opencode。
 *
 * OPENCODE_BIN 一旦设置就是【唯一】候选：它既是“钉死版本”的正常用法，也是测试里
 * 造出“没装”这一态的干净开关（否则 PATH 里那台真身永远会被找到）。
 */
export function detectOpencode(options) {
  const opt = options || {}
  const env = opt.env || process.env
  const exists = opt.exists || isFile
  const pinned = typeof env.OPENCODE_BIN === 'string' ? env.OPENCODE_BIN.trim() : ''
  if (pinned !== '') {
    const found = exists(pinned)
    return {
      installed: found,
      binary: pinned,
      kind: found ? kindOf(pinned) : 'none',
      source: 'OPENCODE_BIN',
      searched: [pinned],
    }
  }
  const searched = []
  for (const root of globalRoots(env)) {
    for (const candidate of packageBinaries(root)) {
      if (searched.length < 24) searched.push(candidate)
      if (exists(candidate)) return { installed: true, binary: candidate, kind: kindOf(candidate), source: 'npm-global', searched: searched }
    }
  }
  const raw = env.PATH || env.Path || ''
  for (const dir of String(raw).split(path.delimiter)) {
    if (dir.trim() === '') continue
    for (const name of pathNames()) {
      const candidate = path.join(dir, name)
      if (searched.length < 24) searched.push(candidate)
      if (exists(candidate)) return { installed: true, binary: candidate, kind: kindOf(candidate), source: 'PATH', searched: searched }
    }
  }
  return { installed: false, binary: undefined, kind: 'none', source: 'none', searched: searched }
}

function quoteForShell(value) {
  const text = String(value)
  if (text.indexOf(' ') < 0 && text.indexOf('\t') < 0) return text
  return '"' + text.split('"').join('') + '"'
}

/**
 * 把“程序 + 参数”翻成 spawn 的真参数。
 *
 * Windows 的 npm 垫片是 .cmd，Node 从 18 起不再允许直接 spawn 它（EINVAL），必须过
 * cmd.exe /d /s /c；而 /s 会剥掉最外层那对引号，所以整条命令行自己再包一层引号。
 * 这两点都写在 Node 文档里，但写错时的症状是“什么都没发生”，值得在这里钉住。
 */
export function buildCommand(binary, args, kind) {
  const list = (args || []).map(String)
  const lower = String(binary).toLowerCase()
  const shim = kind === 'shim' || lower.endsWith('.cmd') || lower.endsWith('.bat')
  if (shim === false) return { file: binary, args: list, windowsVerbatimArguments: false }
  const line = '"' + binary + '"' + (list.length === 0 ? '' : ' ' + list.map(quoteForShell).join(' '))
  if (process.platform !== 'win32') return { file: '/bin/sh', args: ['-c', line], windowsVerbatimArguments: false }
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + line + '"'], windowsVerbatimArguments: true }
}

function runChild(spawnImpl, plan, options) {
  const opt = options || {}
  const timeoutMs = typeof opt.timeoutMs === 'number' ? opt.timeoutMs : SERVICE_TIMEOUT_MS
  return new Promise(function (resolve) {
    let child
    try {
      child = spawnImpl(plan.file, plan.args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: plan.windowsVerbatimArguments === true,
        cwd: opt.cwd,
        env: opt.env,
      })
    } catch (error) {
      resolve({ ok: false, code: null, output: '', error: String((error && error.message) || error) })
      return
    }
    let output = ''
    let settled = false
    let timer
    const collect = function (chunk) { output = trimText(output + String(chunk)) }
    const finish = function (payload) {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (payload.output === undefined) payload.output = output.trim()
      resolve(payload)
    }
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', collect)
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', collect)
    timer = setTimeout(function () {
      try { child.kill() } catch { /* 已经退了 */ }
      finish({ ok: false, code: null, timedOut: true, error: '超过 ' + String(timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) + ' 秒' : timeoutMs + ' 毫秒') + '没有结束' })
    }, timeoutMs)

    if (typeof child.on === 'function') {
      child.on('error', function (error) { finish({ ok: false, code: null, error: String((error && error.message) || error) }) })
      child.on('close', function (code, signal) { finish({ ok: code === 0, code: code, signal: signal }) })
    }
  })
}

/** service status 的输出里挑 URL：正常是单独一行 http://…，失败时是说明文字。 */
export function endpointFromOutput(text) {
  for (const line of String(text || '').split(String.fromCharCode(10))) {
    const value = line.trim()
    const at = value.toLowerCase().indexOf('http://')
    if (at === 0) return value
  }
  return undefined
}

export function createRuntime(reference) {
  const ref = reference || {}
  const logger = ref.logger || console
  const spawnImpl = ref.spawn || nodeSpawn
  const env = ref.env || process.env
  // exists 同样可注入：测试要能声明"这台机器上装了/没装"，而不必真的落一个二进制。
  const exists = typeof ref.exists === 'function' ? ref.exists : isFile
  const now = ref.now || Date.now
  // 超时同样可注入：两分钟级的等待在测试里没有意义，而这里是唯一能把它缩短的口子。
  const serviceTimeoutMs = typeof ref.serviceTimeoutMs === 'number' ? ref.serviceTimeoutMs : SERVICE_TIMEOUT_MS
  const installTimeoutMs = typeof ref.installTimeoutMs === 'number' ? ref.installTimeoutMs : INSTALL_TIMEOUT_MS
  const info = function (message) { if (logger && typeof logger.info === 'function') logger.info(message) }
  const warn = function (message) { if (logger && typeof logger.warn === 'function') logger.warn(message) }

  let detectCache
  const service = { state: 'unknown', message: '还没查过本机 opencode 服务', url: undefined, at: undefined, attempts: 0 }
  const install = { state: 'idle', command: 'npm install -g ' + INSTALL_PACKAGE, output: '', code: null, at: undefined }
  let startPromise
  let installPromise

  function detect(force) {
    const at = now()
    if (force !== true && detectCache !== undefined && at - detectCache.at < DETECT_TTL_MS) return detectCache.value
    const value = detectOpencode({ env: env, exists: exists })
    detectCache = { at: at, value: value }
    return value
  }

  function setService(patch) {
    Object.assign(service, patch)
    service.at = now()
    return service
  }

  function view() {
    const found = detect(false)
    return {
      installed: found.installed,
      binary: found.binary,
      kind: found.kind,
      source: found.source,
      searched: found.searched,
      service: Object.assign({}, service),
      install: Object.assign({}, install),
      installCommand: install.command,
      installPackage: INSTALL_PACKAGE,
    }
  }

  /** 执行 `opencode service <action>`；返回结果对象，绝不抛。 */
  async function runService(action) {
    const found = detect(true)
    if (found.installed !== true) {
      setService({ state: 'unavailable', message: '本机没有找到 opencode 可执行文件' })
      return { ok: false, state: 'unavailable', message: service.message }
    }
    const plan = buildCommand(found.binary, ['service', String(action)], found.kind)
    info('local-opencode: 运行 opencode service ' + String(action) + '（' + found.binary + '）')
    const started = now()
    const result = await runChild(spawnImpl, plan, { timeoutMs: serviceTimeoutMs })
    const elapsed = now() - started
    const url = endpointFromOutput(result.output)
    if (result.ok === true) {
      setService({ state: action === 'status' ? 'running' : 'running', message: url ? '服务在 ' + url + ' 上运行' : '服务已就绪', url: url || service.url, lastMs: elapsed })
      return { ok: true, state: service.state, url: url, ms: elapsed, output: result.output }
    }
    const message = result.error || result.output || ('opencode service ' + String(action) + ' 退出码 ' + String(result.code))
    setService({ state: 'failed', message: message, url: url || service.url, lastMs: elapsed })
    warn('local-opencode: opencode service ' + String(action) + ' 失败——' + message)
    return { ok: false, state: 'failed', message: message, ms: elapsed, output: result.output }
  }

  /** 幂等的后台拉起：并发调用共享同一次执行，失败只写状态。 */
  function startService() {
    if (startPromise !== undefined) return startPromise
    const found = detect(false)
    if (found.installed !== true) {
      setService({ state: 'unavailable', message: '本机没有找到 opencode，先装一次' })
      return Promise.resolve({ ok: false, state: 'unavailable', message: service.message })
    }
    service.attempts += 1
    setService({ state: 'starting', message: '正在后台启动 opencode 服务…' })
    startPromise = runService('start').then(function (result) {
      if (result.ok === true) detectCache = undefined
      return result
    }).finally(function () { startPromise = undefined })
    return startPromise
  }

  function npmPlan() {
    const binary = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    return buildCommand(binary, ['install', '-g', INSTALL_PACKAGE, '--no-fund', '--no-audit'], process.platform === 'win32' ? 'shim' : 'exe')
  }

  /**
   * 一键安装。已经装了就【不执行】任何命令：这条路由的语义是「补上缺的那一半」，
   * 不是「升级」。已经有 binary 的机器再跑一次全局安装，等于在没有告知的情况下换版本。
   */
  function startInstall() {
    const found = detect(true)
    if (found.installed === true) return { started: false, reason: 'installed', state: install.state }
    if (installPromise !== undefined) return { started: false, reason: 'running', state: install.state }
    const plan = npmPlan()
    install.state = 'running'
    install.output = ''
    install.code = null
    install.at = now()
    info('local-opencode: 开始一键安装 ' + INSTALL_PACKAGE)
    installPromise = runChild(spawnImpl, plan, { timeoutMs: installTimeoutMs }).then(function (result) {
      install.code = result.code === undefined ? null : result.code
      install.output = result.output || result.error || ''
      install.state = result.ok === true ? 'done' : 'failed'
      install.at = now()
      detectCache = undefined
      if (result.ok === true) info('local-opencode: ' + INSTALL_PACKAGE + ' 安装完成')
      else warn('local-opencode: ' + INSTALL_PACKAGE + ' 安装失败——' + (result.error || result.output || String(result.code)))
      return result
    }).finally(function () { installPromise = undefined })
    return { started: true, reason: 'started', state: install.state }
  }

  return {
    detect: detect,
    view: view,
    startService: startService,
    runService: runService,
    startInstall: startInstall,
    installPromise: function () { return installPromise },
    service: service,
    install: install,
  }
}