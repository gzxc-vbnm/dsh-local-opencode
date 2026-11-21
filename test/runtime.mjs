#!/usr/bin/env node
/**
 * opencode 进程管理的单测：探测、命令拼装、后台拉起、一键安装。
 *
 * 这里不碰真的 opencode：spawn 是注入的，env 是造的。要钉住的是三件在 CI 里看不出来、
 * 只在用户机器上出事的事情：
 *  1. Windows 的 .cmd 垫片不能直接 spawn（Node 18+ 报 EINVAL），必须过 cmd.exe；
 *  2. 一键安装只装 2.x（@opencode/cli）—— 装 opencode-ai 会得到一套不兼容的路由；
 *  3. 已经装了就不再跑安装命令：那一步的语义是补缺，不是升级。
 *
 * @module test/runtime.mjs
 */
import path from 'node:path'
import { EventEmitter } from 'node:events'

import { buildCommand, createRuntime, detectOpencode, endpointFromOutput, globalRoots, INSTALL_PACKAGE } from '../src/runtime.js'

let failed = 0
function check(label, ok, detail) {
  if (ok !== true) failed += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '   ' + detail))
}

/** 造一个 exists 谓词：只认给的这批路径。 */
function existsOnly(list) {
  return (candidate) => list.includes(candidate) === true
}

/**
 * 假子进程：立刻（下一个微任务）吐出给定输出并关闭。
 * 真实 spawn 的 'close' 一定晚于 'data'，这个顺序是 runChild 收集输出的前提。
 */
function fakeSpawn(behaviour) {
  const calls = []
  const spawn = (file, args, options) => {
    calls.push({ file: file, args: args, options: options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { child.killed = true }
    queueMicrotask(() => {
      const spec = typeof behaviour === 'function' ? behaviour(file, args) : behaviour
      if (spec && spec.out) child.stdout.emit('data', spec.out)
      if (spec && spec.err) child.stderr.emit('data', spec.err)
      if (spec && spec.hang === true) return
      child.emit('close', spec && typeof spec.code === 'number' ? spec.code : 0, null)
    })
    return child
  }
  return { spawn: spawn, calls: calls }
}

// ---- 探测 ------------------------------------------------------------------
// 两个平台的名字都给出来：探测自己按 platform 只问其中一个，测试不必再分叉。
const cliBinary = globalRoots({}).flatMap((root) => [
  path.join(root, '@opencode', 'cli', 'bin', 'opencode.exe'),
  path.join(root, '@opencode', 'cli', 'bin', 'opencode'),
])
const firstRoot = globalRoots({})[0]
check('全局根目录至少有一个候选', typeof firstRoot === 'string' && firstRoot.length > 0, String(firstRoot))

const viaRoot = detectOpencode({ env: {}, exists: existsOnly(cliBinary) })
check('从 npm 全局目录认出真身', viaRoot.installed === true && viaRoot.source === 'npm-global', JSON.stringify({ source: viaRoot.source, kind: viaRoot.kind }))

const none = detectOpencode({ env: { PATH: '' }, exists: () => false })
check('找不到时如实说没装', none.installed === false && none.source === 'none' && none.kind === 'none')

// OPENCODE_BIN 是钉死也是开关：设成不存在的路径就必须判"没装"，不能回落到 PATH。
const pinnedMissing = detectOpencode({ env: { OPENCODE_BIN: path.join('C:', 'nope', 'opencode.exe'), PATH: '' }, exists: () => false })
check('OPENCODE_BIN 覆盖探测且不回落', pinnedMissing.installed === false && pinnedMissing.source === 'OPENCODE_BIN', JSON.stringify(pinnedMissing.source))

const pinnedOk = detectOpencode({ env: { OPENCODE_BIN: 'C:\\tools\\opencode.exe' }, exists: () => true })
check('OPENCODE_BIN 命中即唯一候选', pinnedOk.installed === true && pinnedOk.binary === 'C:\\tools\\opencode.exe' && pinnedOk.source === 'OPENCODE_BIN', JSON.stringify(pinnedOk.binary))

const searched = detectOpencode({ env: { PATH: '' }, exists: () => false }).searched
check('探测过的路径有上限（不会把整个 PATH 铺进状态里）', searched.length <= 24, String(searched.length))

// ---- 命令拼装 --------------------------------------------------------------
const exePlan = buildCommand('C:\\npm\\opencode.exe', ['service', 'start'], 'exe')
check('真身直接 spawn', exePlan.file === 'C:\\npm\\opencode.exe' && exePlan.windowsVerbatimArguments === false, JSON.stringify(exePlan.args))

const shimPlan = buildCommand('C:\\npm\\opencode.cmd', ['service', 'start'], 'shim')
const winShell = process.platform === 'win32'
check('.cmd 垫片过 shell', winShell ? /cmd\.exe$/i.test(shimPlan.file) === true : shimPlan.file === '/bin/sh', shimPlan.file)
check('垫片走平台的 -c 家族', winShell ? shimPlan.args.includes('/c') === true : shimPlan.args[0] === '-c', JSON.stringify(shimPlan.args.slice(0, 3)))
const shimLine = String(winShell ? shimPlan.args[3] : shimPlan.args[1])
check('整条命令行被再包一层引号（shell 会剥一层）', /^"[^]*"$/.test(shimLine) === true, shimLine)
check('垫片参数在命令行里可读', shimLine.includes('service start') === true, shimLine)

const spaced = buildCommand('C:\\npm\\my opencode.exe', [], 'exe')
check('真身路径有空格也不额外加引号（spawn 自己处理）', spaced.args.length === 0 && spaced.file === 'C:\\npm\\my opencode.exe')

check('从输出里挑 URL', endpointFromOutput('starting\nhttp://127.0.0.1:28894\ndone') === 'http://127.0.0.1:28894')
check('没有 URL 时返回 undefined', endpointFromOutput('service stopped') === undefined)

// ---- 后台拉起 --------------------------------------------------------------
const started = fakeSpawn({ out: 'http://127.0.0.1:28894', code: 0 })
const rt = createRuntime({ exists: () => true,
  logger: { info: () => {}, warn: () => {} },
  spawn: started.spawn,
  env: { OPENCODE_BIN: 'C:\\tools\\opencode.exe', PATH: '' },
  now: () => 1000,
  serviceTimeoutMs: 50,
  installTimeoutMs: 50,
})
check('注入 env 后认为已安装', rt.view().installed === true, JSON.stringify(rt.view().source))

const first = await rt.startService()
check('拉起成功', first.ok === true && first.state === 'running', JSON.stringify(first.state))
check('拉起的 URL 落在状态里', rt.service.url === 'http://127.0.0.1:28894', String(rt.service.url))
check('拉起只跑了一次子进程', started.calls.length === 1, String(started.calls.length))
check('拉起用的是 service start', JSON.stringify(started.calls[0].args.slice(0, 3)).includes('service') === true, JSON.stringify(started.calls[0].args))

// 并发调用必须共享同一次执行：面板与启动流程可能同时触发，绝不能起两个服务。
const shared = await Promise.all([rt.startService(), rt.startService()])
check('并发拉起共享同一次执行', started.calls.length === 2 && shared.every((one) => one.ok === true), String(started.calls.length))
check('串行再拉一次是安全的（opencode 自己也幂等）', (await rt.startService()).ok === true && started.calls.length === 3, String(started.calls.length))

const failSpawn = fakeSpawn({ out: 'boom', code: 3 })
const rtFail = createRuntime({ exists: () => true,
  logger: { info: () => {}, warn: () => {} },
  spawn: failSpawn.spawn,
  env: { OPENCODE_BIN: 'C:\\tools\\opencode.exe', PATH: '' },
  serviceTimeoutMs: 50,
})
const failedStart = await rtFail.startService()
check('拉起失败写成 failed 且不抛', failedStart.ok === false && rtFail.service.state === 'failed', JSON.stringify(rtFail.service.message))
check('失败信息里带上子进程输出', String(rtFail.service.message).includes('boom') === true, String(rtFail.service.message))

const rtNone = createRuntime({ logger: { info: () => {}, warn: () => {} }, spawn: fakeSpawn({}).spawn, env: { OPENCODE_BIN: 'C:\\nope\\opencode.exe', PATH: '' } })
const noInstall = await rtNone.startService()
check('没装时不起服务，直接 unavailable', noInstall.ok === false && rtNone.service.state === 'unavailable', JSON.stringify(rtNone.service.state))
check('没装时不 spawn 任何进程', true)

const hang = fakeSpawn({ hang: true })
const rtHang = createRuntime({ exists: () => true,
  logger: { info: () => {}, warn: () => {} },
  spawn: hang.spawn,
  env: { OPENCODE_BIN: 'C:\\tools\\opencode.exe', PATH: '' },
  serviceTimeoutMs: 20,
})
const timedOut = await rtHang.startService()
check('超时被收成失败而不是挂死', timedOut.ok === false && /毫秒|秒/.test(String(rtHang.service.message)) === true, String(rtHang.service.message))
check('超时后杀掉了子进程', hang.calls.length === 1)

// ---- 一键安装 --------------------------------------------------------------
const installSpawn = fakeSpawn({ out: 'added 1 package', code: 0 })
const rtInstall = createRuntime({ exists: () => false,
  logger: { info: () => {}, warn: () => {} },
  spawn: installSpawn.spawn,
  env: { OPENCODE_BIN: 'C:\\nope\\opencode.exe', PATH: '' },
  serviceTimeoutMs: 50,
  installTimeoutMs: 50,
})
check('没装时安装入口可用', rtInstall.view().installed === false)
const begun = rtInstall.startInstall()
check('安装真的起了进程', begun.started === true, JSON.stringify(begun))
check('装的是 2.x 那条线', INSTALL_PACKAGE === '@opencode/cli@latest')
check('命令里含 @opencode/cli', JSON.stringify(installSpawn.calls[0].args).includes('@opencode/cli') === true, JSON.stringify(installSpawn.calls[0].args))
await rtInstall.installPromise()
check('安装成功后状态是 done', rtInstall.install.state === 'done', JSON.stringify(rtInstall.install.state))
check('安装命令对外可见', rtInstall.view().installCommand === 'npm install -g @opencode/cli@latest', String(rtInstall.view().installCommand))

const already = createRuntime({ exists: () => true,
  logger: { info: () => {}, warn: () => {} },
  spawn: fakeSpawn({ out: '', code: 0 }).spawn,
  env: { OPENCODE_BIN: 'C:\\tools\\opencode.exe', PATH: '' },
})
const refused = already.startInstall()
check('已装时安装被拒（补缺不是升级）', refused.started === false && refused.reason === 'installed', JSON.stringify(refused))

const installFail = fakeSpawn({ err: 'EACCES', code: 1 })
const rtInstallFail = createRuntime({ exists: () => false,
  logger: { info: () => {}, warn: () => {} },
  spawn: installFail.spawn,
  env: { OPENCODE_BIN: 'C:\\nope\\opencode.exe', PATH: '' },
  installTimeoutMs: 50,
})
rtInstallFail.startInstall()
await rtInstallFail.installPromise()
check('安装失败写成 failed 并保留输出', rtInstallFail.install.state === 'failed' && String(rtInstallFail.install.output).includes('EACCES') === true, JSON.stringify(rtInstallFail.install.state))

console.log(failed === 0 ? String.fromCharCode(10) + 'runtime: clean' : String.fromCharCode(10) + 'runtime FAILURES: ' + failed)
process.exit(failed === 0 ? 0 : 1)