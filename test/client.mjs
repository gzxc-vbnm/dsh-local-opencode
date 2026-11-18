#!/usr/bin/env node
/**
 * 浏览器半边的契约测试。
 *
 * 面板是纯声明式的：它不知道自己注册到了哪里，宿主也不检查它注册了什么。
 * 一旦座位名、id、order 或导出形状写错，表现是"侧栏没有这一行"——一个不报错、
 * 不进日志、也没有测试覆盖的失败。这套测试把约定钉在文本与运行两侧：
 *
 *  1. 文本侧：bundle 必须由 window.__ModuleLoader__.load 包起来，导出 apply 与
 *     inject，且 fetch 路径不得有前导斜杠（子路径部署会失效，issue #1707）。
 *  2. 运行侧：在假 window / require 里真的跑一遍工厂、执行 apply，
 *     断言它往正确的座位注册了正确的 id/order/key，并能渲染出两种通道的页面。
 *
 * @module test/client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

let failed = 0
function check(label, ok, detail) {
  if (ok !== true) failed += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '   ' + detail))
}

// ---- 文本契约 ----
check('包在 window.__ModuleLoader__.load 里', source.includes('window.__ModuleLoader__.load({') === true)
check('模块 id 等于包名', source.includes('id: "dsh-local-opencode"') === true)
const firstCode = source.split(String.fromCharCode(10)).find((line) => line.trim() !== '' && line.trim().startsWith('*') === false && line.trim().startsWith('/*') === false)
check('包裹是文件第一条语句（前面只有注释）', firstCode !== undefined && firstCode.startsWith('window.__ModuleLoader__.load({') === true, firstCode === undefined ? 'empty' : firstCode.slice(0, 40))
check('导出 apply 与 inject', source.includes('exports.apply = apply') === true && source.includes('exports.inject = inject') === true)
check('inject 声明 slots 服务', source.includes('var inject = ["slots"]') === true)

// 文档相对的 fetch 路径：根绝对路径会逃出 <base href="./"> 的子路径前缀（issue #1707）。
const apiPaths = [...source.matchAll(/"(api\/local-opencode[^"]*)"/g)].map((match) => match[1])
check('至少声明了 status 路由', apiPaths.some((one) => one.endsWith('/status')) === true, apiPaths.length + ' 条')
check('所有路由都是文档相对（无前导斜杠）', apiPaths.every((one) => one.startsWith('/') === false), JSON.stringify(apiPaths))
const absolute = [...source.matchAll(/(["'])(\/api\/[^"']+)/g)].map((match) => match[2])
check('没有根绝对 API 路径', absolute.length === 0, JSON.stringify(absolute))

// ---- 运行契约 ----
const fakeReact = {
  createElement(type, props, ...children) { return { type: type, props: props || {}, children: children.flat() } },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
}
const seatsInjected = []
const registrations = []
const ctx = {
  // 真实语义是「宿主声明座位后才回调」；这里立刻回调，等于座位已就位。
  slots: {
    inject(seat, callback) { seatsInjected.push(seat); const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    register(meta, component) { registrations.push({ meta: meta, component: component }); return () => {} },
  },
  effect(setup) { const dispose = setup(); return typeof dispose === 'function' ? dispose : () => {} },
}

const holder = {}
Object.defineProperty(globalThis, 'window', { value: { __ModuleLoader__: { load(definition) { holder.loaded = definition } } }, configurable: true })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ visibility: [], agents: [] }) })

vm.runInThisContext(source, { filename: 'client.js' })
check('工厂被执行', holder.loaded !== undefined && typeof holder.loaded.factory === 'function')
const exportsObject = holder.loaded.factory((name) => {
  if (name === 'react') return fakeReact
  if (name === 'react/jsx-runtime') return {}
  throw new Error('bundle require 了未提供的模块：' + name)
})
check('apply 是函数', typeof exportsObject.apply === 'function')
check('inject 是数组且含 slots', Array.isArray(exportsObject.inject) && exportsObject.inject.includes('slots'), JSON.stringify(exportsObject.inject))

exportsObject.apply(ctx)
check('注入了两个座位', JSON.stringify(seatsInjected) === JSON.stringify(['sidebar.panellist', 'main']), JSON.stringify(seatsInjected))
check('注册了两处', registrations.length === 2, String(registrations.length))

const sidebar = registrations.find((entry) => entry.meta.name === 'sidebar.panellist')
const main = registrations.find((entry) => entry.meta.name === 'main')
check('侧栏行 id 稳定', sidebar !== undefined && sidebar.meta.id === 'local-opencode', sidebar && sidebar.meta.id)
check('侧栏行 order 排在 skill-explorer(30) 之后', sidebar !== undefined && sidebar.meta.order === 40, sidebar && String(sidebar.meta.order))
check('主区用 keyed seat 且 key 与行 id 一致', main !== undefined && main.meta.key === 'local-opencode', main && main.meta.key)
check('行标签是函数（宿主按需解析）', sidebar !== undefined && typeof sidebar.meta.label === 'function')
check('行标签解析出非空字符串', sidebar !== undefined && typeof sidebar.meta.label() === 'string' && sidebar.meta.label().length > 0, sidebar && sidebar.meta.label())

const iconTree = sidebar.component({ size: 16 })
check('图标画成 svg 并带 data-dsh-panel-entry', iconTree.type === 'svg' && iconTree.props['data-dsh-panel-entry'] === 'local-opencode', JSON.stringify(iconTree.props['data-dsh-panel-entry']))

/** 页面拿到的 store 由 inject() 提供；这里喂等价对象。 */
function store(status) {
  return { subscribe: () => () => {}, get: () => ({ status: status, busy: false, error: undefined }), load: async () => {}, loadAgents: async () => {}, act: async () => {} }
}
const page = main.component

const loadingTree = JSON.stringify(page({ store: store(undefined) }))
check('无状态时显示加载提示', loadingTree.includes('正在读取状态') === true, loadingTree.slice(0, 60))

const statusBase = {
  plugin: { version: '0.1.0' },
  connection: { status: 'connected' },
  channel: 'text',
  permissionMode: 'allow-read',
  permissionModes: ['allow-read', 'allow-all', 'reject'],
  workingDirectory: '',
  agentName: '',
  agents: [{ id: 'build' }, { id: 'plan' }],
  visibility: [
    { id: 'opencode/big-pickle', name: 'Big Pickle', provider: 'opencode', free: true, group: 'free', hidden: false, toggleable: true, contextWindow: 200000 },
    { id: 'opencode/hy4-flash-free', name: 'Hy4 Flash', provider: 'opencode', free: true, group: 'hidden', hidden: true, toggleable: true, contextWindow: 1000000 },
    { id: 'github-copilot/gpt-5', name: 'GPT-5', provider: 'github-copilot', free: false, group: 'unlisted', hidden: false, toggleable: false },
  ],
}

const textTree = JSON.stringify(page({ store: store(statusBase) }))
const textExpect = ['Local OpenCode', '无工具文本通道', '带工具 agent 通道', '模型显示', '显示中 · 免费', '已隐藏', '不显示', '计费未纳入']
check('文本通道页渲染完整', textExpect.every((word) => textTree.includes(word) === true), textExpect.filter((word) => textTree.includes(word) === false).join(',') || 'all present')
check('文本通道页不显示权限区', textTree.includes('权限策略') === false)

const agentTree = JSON.stringify(page({ store: store(Object.assign({}, statusBase, { channel: 'agent' })) }))
const agentExpect = ['权限策略', '只放行读', '全部放行', '一律拒绝', '工作目录', 'opencode agent']
check('agent 通道页显示权限区', agentExpect.every((word) => agentTree.includes(word) === true), agentExpect.filter((word) => agentTree.includes(word) === false).join(',') || 'all present')
// 权限区必须写明后果：allow-all 真的会改文件，界面上不能只写"全部放行"。
check('显式标注带工具通道的风险', agentTree.includes('会真的读写文件') === true)
check('风险条只出现一次（不重复渲染）', (agentTree.match(/会真的读写文件/g) || []).length === 1)

// 三个模型里只有一个被隐藏 → 页面上"不显示"按钮恰好一个（另两个不显示该按钮的语义相反）。
const hideButtons = (textTree.match(/不显示/g) || []).length
check('隐藏中的模型给出反向按钮', hideButtons === 1, String(hideButtons))
check('不可拨的模型拿不到开关', textTree.includes('计费未纳入') === true)

// 英文环境独立走一遍，确认翻译表不是复用中文。
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true })
const holderEn = {}
Object.defineProperty(globalThis, 'window', { value: { __ModuleLoader__: { load(definition) { holderEn.loaded = definition } } }, configurable: true })
vm.runInThisContext(source, { filename: 'client.en.js' })
const enExports = holderEn.loaded.factory((name) => (name === 'react' ? fakeReact : {}))
const enRegs = []
enExports.apply({
  slots: { inject(seat, callback) { callback(); return () => {} }, register(meta, component) { enRegs.push({ meta: meta, component: component }); return () => {} } },
  effect(setup) { return setup() },
})
const enPage = enRegs.find((entry) => entry.meta.name === 'main').component
const enTree = JSON.stringify(enPage({ store: store(Object.assign({}, statusBase, { channel: 'agent' })) }))
const enExpect = ['Text only', 'Agent (with tools)', 'Permission policy', 'Read only', 'Model visibility']
check('英文环境用英文文案', enExpect.every((word) => enTree.includes(word) === true), enExpect.filter((word) => enTree.includes(word) === false).join(',') || 'all present')
check('英文页不残留中文标题', enTree.includes('无工具文本通道') === false)

// ---- manifest 侧 ----
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
check('exports 导出 ./client', manifest.exports && manifest.exports['./client'] === './client.js', JSON.stringify(manifest.exports && manifest.exports['./client']))
check('dsh.client.platform 是 web', !!(manifest.dsh && manifest.dsh.client && manifest.dsh.client.platform === 'web'))
const injectList = (manifest.dsh && manifest.dsh.client && manifest.dsh.client.inject) || []
// 座位由 ui-sidebar 与 ui-layout 声明，slots 服务来自 ui-renderer；缺一个就注册不上。
const needed = ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar']
check('client.inject 声明座位提供方', needed.every((name) => injectList.includes(name) === true), JSON.stringify(injectList))
check('files 包含 client.js', Array.isArray(manifest.files) && manifest.files.includes('client.js') === true)

console.log(failed === 0 ? String.fromCharCode(10) + 'client: clean' : String.fromCharCode(10) + 'client FAILURES: ' + failed)
process.exit(failed === 0 ? 0 : 1)
