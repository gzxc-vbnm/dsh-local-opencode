/**
 * 找到本机 opencode 的服务：读它自己登记的地址与口令。
 *
 * opencode 2.x 把 { id, version, url, pid, password } 写在
 * '<XDG_STATE_HOME ?? ~/.local/state>/opencode/service.json'（~/.config/opencode/service.json
 * 是只存口令的旧落点，一并兜底）。url 里的端口是它按 channel 派生的固定端口（latest 是
 * 28894），所以只要 opencode 的后台服务在跑，这里就能直接连上。
 *
 * 读到还要用 GET /api/info 证明它真的活着：pid 复用、登记文件陈旧都会造成
 * "文件在、服务没了"。OPENCODE_SERVER_URL / OPENCODE_SERVER_PASSWORD 是手动覆盖，
 * 给"opencode 换了端口/装在别处"留一条不改代码的路。
 *
 * @module src/discovery.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CODE, OpenCodeError, transportError } from './errors.js'

const BASIC_USER = 'opencode'

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir()
}

function trimSlashes(value) {
  let out = value
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

function isHttpUrl(value) {
  return value.startsWith('http://') || value.startsWith('https://')
}

function registrationFiles() {
  const files = []
  if (process.env.XDG_STATE_HOME) files.push(path.join(process.env.XDG_STATE_HOME, 'opencode', 'service.json'))
  files.push(path.join(homeDir(), '.local', 'state', 'opencode', 'service.json'))
  if (process.env.XDG_CONFIG_HOME) files.push(path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'service.json'))
  files.push(path.join(homeDir(), '.config', 'opencode', 'service.json'))
  return files
}

function readRegistration() {
  for (const file of registrationFiles()) {
    let raw
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
    if (!raw || typeof raw !== 'object') continue
    const url = typeof raw.url === 'string' && isHttpUrl(raw.url) ? trimSlashes(raw.url) : undefined
    const password = typeof raw.password === 'string' && raw.password !== '' ? raw.password : undefined
    if (url === undefined && password === undefined) continue
    return { file: file, url: url, password: password, version: typeof raw.version === 'string' ? raw.version : undefined }
  }
  return undefined
}

export function basicAuth(password) {
  return 'Basic ' + Buffer.from(BASIC_USER + ':' + password, 'utf8').toString('base64')
}

async function probe(endpoint, password, signal, logger) {
  const headers = { accept: 'application/json' }
  if (password !== undefined && password !== '') headers.authorization = basicAuth(password)
  let response
  try {
    response = await fetch(endpoint + '/api/info', { headers: headers, signal: signal, cache: 'no-store' })
  } catch (error) {
    if (signal && signal.aborted) throw transportError('local-opencode: 探测 opencode 服务时被取消', error)
    throw transportError('local-opencode: 连不上本机 opencode（' + endpoint + '）。请确认 opencode 已安装并在跑（opencode serve，或开着 TUI）', error)
  }
  if (!response.ok) {
    const text = await response.text().catch(function () { return '' })
    if (response.status === 401 || response.status === 403) {
      throw new OpenCodeError('local-opencode: opencode 服务拒绝口令（' + endpoint + '）。若你手动改过 OPENCODE_SERVER_PASSWORD，请与 ~/.local/state/opencode/service.json 对齐', CODE.AUTH, { status: response.status })
    }
    logger && logger.warn && logger.warn('local-opencode: /api/info 应答 ' + response.status + '：' + String(text).slice(0, 160))
    throw new OpenCodeError('local-opencode: opencode 服务应答 ' + response.status + '（' + endpoint + '），它可能是更老/更新的版本', CODE.SERVER, { status: response.status })
  }
  const info = await response.json().catch(function () { return {} })
  return { url: endpoint, password: password, version: typeof info.version === 'string' ? info.version : undefined, capabilities: info.capabilities }
}

/**
 * @returns {Promise<{url: string, password: string, version?: string, source: string}>}
 * @throws {OpenCodeError} 找不到登记文件或连不上时（TRANSPORT / AUTH / SERVER）。
 */
export async function discoverOpenCode(_arg) {
  const logger = _arg && _arg.logger
  const signal = _arg && _arg.signal
  const envUrl = process.env.OPENCODE_SERVER_URL ? trimSlashes(process.env.OPENCODE_SERVER_URL) : undefined
  const envPassword = process.env.OPENCODE_SERVER_PASSWORD

  if (envUrl !== undefined && envUrl !== '') {
    const live = await probe(envUrl, envPassword === undefined || envPassword === '' ? undefined : envPassword, signal, logger)
    return Object.assign({}, live, { password: live.password || '', source: 'env OPENCODE_SERVER_URL' })
  }

  const registered = readRegistration()
  if (registered === undefined) {
    throw new OpenCodeError(
      'local-opencode: 没找到本机 opencode 的服务登记文件（~/.local/state/opencode/service.json）。'
      + '请先在本机安装并跑一次 opencode（npm i -g @opencode/cli，然后 opencode 登录渠道或 opencode serve）',
      CODE.TRANSPORT,
    )
  }
  if (registered.url === undefined) {
    throw new OpenCodeError('local-opencode: ' + registered.file + ' 里没有 url 字段，无法确定服务地址；请用 OPENCODE_SERVER_URL 指定', CODE.TRANSPORT)
  }
  const password = envPassword !== undefined && envPassword !== '' ? envPassword : registered.password
  if (password === undefined) {
    throw new OpenCodeError('local-opencode: ' + registered.file + ' 里没有 password，且未设置 OPENCODE_SERVER_PASSWORD', CODE.AUTH)
  }
  const live = await probe(registered.url, password, signal, logger)
  return Object.assign({}, live, { password: password, source: registered.file })
}

/** 供状态面板展示：当前会去读哪些登记文件。 */
export function registrationPaths() {
  return registrationFiles()
}
