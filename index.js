/**
 * local-opencode — 插件宿主入口。
 *
 * 干的事：发现本机 opencode 的服务（读它自己登记的 url+password）→ 拉它的模型目录
 * （GET /api/model，零成本模型默认进 local-opencode 组）→ 注册一个 llm 适配器，让 dsh
 * 的模型选择器能直接选中这些免费模型对话。
 *
 * 一条硬约束：所有 opencode 侧的失败（没装、没在跑、没登录、区域拒绝、额度墙）都必须
 * 变成模型选择器里看得见的状态，而不是让插件启动即失败。因此 apply 不 await 任何网络，
 * 首刷在后台 effect 里跑；路由一旦注册就常驻，refresh 失败只更新 connection 状态。
 *
 * 服务只在 inject 里声明 llm —— cordis 会把没声明的服务从 ctx 藏起来，且 fiber 会一直
 * PENDING；webServer 走嵌套 ctx.inject，没有 HTTP 服务的 headless 组合照样能出模型。
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CODE, OpenCodeError } from './src/errors.js'
import { DATA_DIR_NAME, DEFAULTS, createSettings, resolveDshHome } from './src/settings.js'
import { discoverOpenCode } from './src/discovery.js'
import { OpenCodeClient } from './src/client.js'
import { OpenCodeAdapter } from './src/adapter.js'
import { ROUTE, ROUTE_LABEL, ROUTE_PAID, ROUTE_PAID_LABEL, createState, membershipFor, toCatalogEntry } from './src/state.js'

export const name = 'local-opencode'

const PKG_DIR = fileURLToPath(new URL('./', import.meta.url))

function readPackageVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '') } catch { return '' }
}

export const version = readPackageVersion()

export const inject = ['llm']

/** 同机调用者可用的主机名（围栏的结构副本用）。 */
const LOOPBACK = ['127.0.0.1', '[::1]', '::1', 'localhost']

const ROUTE_LABELS = {}
ROUTE_LABELS[ROUTE] = ROUTE_LABEL
ROUTE_LABELS[ROUTE_PAID] = ROUTE_PAID_LABEL

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  // 数据目录与包目录必须不同名：见 src/settings.js 的 DATA_DIR_NAME
  const settings = createSettings({ dataDir: path.join(resolveDshHome(), DATA_DIR_NAME), logger: logger, config: config })
  const state = createState()
  const settingsNs = (ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.options && ctx.fiber.entry.options.id) || name

  /** 缓存的 client；endpoint 变化或失败后置空重来。 */
  let client = undefined
  let clientPromise = undefined
  let lastError = undefined

  function snapshot() { return state }

  function setConnection(patch) {
    state.connection = Object.assign({}, state.connection, patch, { at: Date.now() })
    return state.connection
  }

  function describeError(error) {
    if (error && error.failure && typeof error.failure.message === 'string') return error.failure.message
    return String((error && error.message) || error)
  }

  /**
   * 拿到一个可用 client（并发共享同一个发现过程）。发现失败会写 connection 状态，
   * 并把错误抛给调用方——适配器据此回一个带原因的 finish chunk。
   */
  function ensureClient() {
    if (client !== undefined) return Promise.resolve(client)
    if (clientPromise !== undefined) return clientPromise
    clientPromise = (async function () {
      const found = await discoverOpenCode({ logger: logger })
      const next = new OpenCodeClient({ endpoint: found.url, password: found.password, logger: logger, version: found.version })
      client = next
      setConnection({ status: 'connected', message: '已连上本机 opencode ' + (found.version || '?') + '（' + found.url + '）', source: found.source, version: found.version })
      return next
    })().catch(function (error) {
      client = undefined
      lastError = describeError(error)
      setConnection({ status: 'disconnected', message: lastError, source: undefined })
      throw error
    }).finally(function () { clientPromise = undefined })
    return clientPromise
  }

  async function refreshCatalog(_options) {
    const options = _options || {}
    if (state.refreshing !== undefined && options.force !== true) return state.refreshing
    const run = (async function () {
      try {
        const active = await ensureClient()
        const raw = await active.listModels(settings.get().requestTimeoutMs, undefined)
        const catalog = raw.map(toCatalogEntry)
        state.catalog = catalog
        state.membership = membershipFor(catalog, settings.get())
        // "可用"按路由成员数算：enabled=false 或 deprecated 的模型在目录里但不进选择器。
        const usable = (state.membership[ROUTE] || []).length
        state.lastRefresh = { at: Date.now(), models: catalog.length, free: usable, listed: catalog.filter(function (e) { return e.free }).length }
        if (state.connection.status === 'connected') setConnection({ message: '已连上本机 opencode ' + (active.version || state.connection.version || '?') + '（' + active.endpoint + '），' + state.lastRefresh.free + ' 个免费模型可用' })
        logger.info && logger.info('local-opencode: 目录刷新完成，' + catalog.length + ' 个模型（免费 ' + state.lastRefresh.free + ' 个）')
        return catalog
      } catch (error) {
        // 保留旧目录：选择器继续显示上一次的模型，调用会带着明确的失败原因重试。
        lastError = describeError(error)
        if (error && error.code !== CODE.ABORTED) setConnection({ status: 'disconnected', message: lastError })
        logger.warn && logger.warn('local-opencode: 模型目录刷新失败——' + lastError)
        throw error
      } finally {
        if (state.refreshing === run) state.refreshing = undefined
      }
    })()
    state.refreshing = run
    // 后台刷新不希望产生 unhandled rejection。
    run.catch(function () {})
    return run
  }

  function onUpstreamFailure(error) {
    lastError = describeError(error)
    // 只有传输/发现级别的失败才改连接状态；单次上游 4xx 是对话事实，不是链路断了。
    if (error && (error.code === CODE.TRANSPORT || error.code === CODE.AUTH || error.code === CODE.SERVER)) {
      client = undefined
      setConnection({ status: 'degraded', message: lastError })
    }
  }

  const adapter = new OpenCodeAdapter({
    state: snapshot,
    settings: function () { return settings.get() },
    routeLabels: ROUTE_LABELS,
    logger: logger,
    ensureClient: ensureClient,
    onUpstreamFailure: onUpstreamFailure,
  })

  // ── 注册 ────────────────────────────────────────────────────────────────────
  const routes = settings.get().enabled ? [ROUTE, ROUTE_PAID] : []
  const registration = routes.length > 0 ? ctx.llm.registerAdapter(routes, adapter) : undefined
  if (registration !== undefined) {
    ctx.llm.registerConfigurableProviders && ctx.llm.registerConfigurableProviders([
      { provider: ROUTE, displayName: ROUTE_LABEL, settingsNs: settingsNs, settingsPath: [] },
      { provider: ROUTE_PAID, displayName: ROUTE_PAID_LABEL, settingsNs: settingsNs, settingsPath: [] },
    ])
    // 模型探测（GUI 的"检测模型"按钮）：直接问本机 opencode。
    ctx.llm.registerModelDiscovery && ctx.llm.registerModelDiscovery(settingsNs, async function (request, signal) {
      const catalog = await refreshCatalog({ force: true })
      void request
      const advertised = {}
      for (const ids of Object.values(state.membership)) for (const id of ids) advertised[id] = true
      return catalog.filter(function (entry) { return advertised[entry.id] === true }).map(function (entry) {
        return { id: entry.id, name: entry.name, contextWindow: entry.contextWindow, maxTokens: entry.maxOutput, inputModalities: entry.modalities }
      })
    })
  } else {
    logger.info && logger.info('local-opencode: enabled=false，本次不注册模型路由（改设置后重启或热重载即生效）')
  }

  // ── 生命周期：首刷 + 周期刷新 ────────────────────────────────────────────────
  let timer = undefined
  ctx.effect(function () {
    if (!settings.get().enabled) return undefined
    // 不在 apply 里 await：opencode 没在跑时插件仍要起来，状态面板会说明原因。
    refreshCatalog({ force: true }).catch(function () {})
    const minutes = settings.get().refreshMinutes
    if (minutes > 0) {
      timer = setInterval(function () { refreshCatalog({}).catch(function () {}) }, minutes * 60000)
      if (timer.unref) timer.unref()
    }
    return function () {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }
  }, 'local-opencode: catalog loop')

  ctx.effect(function () { return function () { if (registration !== undefined) registration() } }, 'local-opencode: adapter routes')
  ctx.effect(function () { return function () { settings.dispose() } }, 'local-opencode: settings')

  // ── 状态与设置面板（可选：没有 webServer 就没有 UI，模型通道不受影响）──────────
  ctx.inject(['webServer'], function (scoped) {
    const server = scoped.webServer
    if (server === undefined || typeof server.register !== 'function') return
    scoped.effect(function () { return server.register({ kind: 'prefix', path: '/api/local-opencode', handler: api }) }, 'local-opencode: api routes')
    logger.info && logger.info('local-opencode: 状态面板 API 挂在 /api/local-opencode')
  })

  function statusView() {
    return {
      plugin: { name: name, version: version },
      settings: settings.get(),
      defaults: DEFAULT_SETTINGS_VIEW,
      connection: state.connection,
      lastRefresh: state.lastRefresh,
      catalog: state.catalog.map(function (entry) {
        return { id: entry.id, name: entry.name, provider: entry.providerID, free: entry.free, modalities: entry.modalities, contextWindow: entry.contextWindow, maxOutput: entry.maxOutput, variants: entry.variants, status: entry.status, enabled: entry.enabled }
      }),
      membership: state.membership,
      routes: routes,
      registered: registration !== undefined,
      lastError: lastError,
    }
  }
  const DEFAULT_SETTINGS_VIEW = Object.assign({}, DEFAULTS)

  function json(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  /**
   * 插件前缀比内核的 /api 更长，webServer 是最长前缀优先——这些路由跑在内核准入之前，
   * 所以必须自己做围栏：优先复用 composition 的 connection.admit（与内核同一决策），
   * 没有它则退化成"仅回环 + Origin/Referer 同源"的结构副本。
   */
  function rejectionFor(req) {
    const connection = ctx.get && ctx.get('connection')
    if (connection && typeof connection.admit === 'function') {
      try { const verdict = connection.admit(req); if (verdict && typeof verdict.rejection === 'number') return verdict.rejection } catch { /* 落到结构副本 */ }
    } else if (connection && typeof connection.requestRejection === 'function') {
      try { const status = connection.requestRejection(req); if (typeof status === 'number') return status } catch { /* 落到结构副本 */ }
    }
    const host = String(req.headers.host || '').replace(/:\d+$/, '')
    if (!LOOPBACK.includes(host)) return 403
    const source = req.headers.origin || req.headers.referer
    if (typeof source === 'string' && source !== '') {
      let authority
      try { authority = new URL(source).hostname } catch { authority = undefined }
      // 桌面端 dsh-app://app 中继没有 http 主机名，放行；其余跨源拒绝。
      if (authority !== undefined && !LOOPBACK.includes(authority) && authority !== host) return 403
    }
    return undefined
  }

  async function api(req, res) {
    const rejection = rejectionFor(req)
    if (rejection !== undefined) { json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' }); return }
    const pathname = String(req.url || '').split('?')[0].replace(/\/+$/, '')
    if (req.method === 'GET' && (pathname === '/api/local-opencode' || pathname === '/api/local-opencode/status')) { json(res, 200, statusView()); return }
    if (req.method === 'POST' && pathname === '/api/local-opencode/refresh') {
      try { await refreshCatalog({ force: true }); json(res, 200, statusView()) } catch (error) { json(res, 502, { error: describeError(error), status: statusView() }) }
      return
    }
    if (req.method === 'POST' && pathname === '/api/local-opencode/settings') {
      let patch
      try { patch = JSON.parse(await readBody(req) || '{}') } catch { json(res, 400, { error: 'body 不是合法 JSON' }); return }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) { json(res, 400, { error: 'body 需要是 JSON 对象' }); return }
      const before = settings.get().enabled
      settings.update(patch)
      const after = settings.get().enabled
      if (before !== after) json(res, 200, Object.assign({}, statusView(), { notice: 'enabled 改了；重启 dsh 或热重载本插件后路由才会跟着起/停' }))
      else json(res, 200, statusView())
      return
    }
    if (req.method === 'POST' && pathname === '/api/local-opencode/test') {
      // 一次真实的最小往返：证明"选它就能用"，并给出区域/额度问题的原始答案。
      let body = {}
      try { body = JSON.parse(await readBody(req) || '{}') } catch { /* 用默认 */ }
      const wanted = typeof body.model === 'string' ? body.model : (state.membership[ROUTE] || [])[0]
      if (wanted === undefined) { json(res, 409, { error: '目录里还没有可用模型；先跑一次 refresh' }); return }
      try {
        const entry = state.catalog.find(function (candidate) { return candidate.id === wanted })
        if (entry === undefined) { json(res, 404, { error: '模型不在目录里：' + wanted }); return }
        const active = await ensureClient()
        const sessionId = await active.createSession('dsh:local-opencode:test', settings.get().requestTimeoutMs, undefined)
        try {
          await active.selectModel(sessionId, { id: entry.modelID, providerID: entry.providerID }, entry.variants[0], settings.get().requestTimeoutMs, undefined)
          const answer = await active.generate(sessionId, String(body.prompt || '只回复两个字：可用'), settings.get().requestTimeoutMs, undefined)
          json(res, 200, { ok: true, model: entry.id, ms: answer.ms, text: answer.text.slice(0, 400) })
        } finally { await active.deleteSession(sessionId, 15000) }
        return
      } catch (error) { json(res, 502, { ok: false, error: describeError(error), code: error && error.code }) }
    }
    json(res, 404, { error: 'not found: ' + req.method + ' ' + pathname })
  }

  function readBody(req) {
    return new Promise(function (resolve, reject) {
      let text = ''
      req.setEncoding('utf8')
      req.on('data', function (chunk) { text += chunk; if (text.length > 200000) { reject(new OpenCodeError('local-opencode: 请求体过大', CODE.UNKNOWN)); req.destroy() } })
      req.on('end', function () { resolve(text) })
      req.on('error', reject)
    })
  }

  return { statusView: statusView, refreshCatalog: refreshCatalog, settingsUpdate: function (patch) { return settings.update(patch) }, settings: settings, adapter: adapter }
}
