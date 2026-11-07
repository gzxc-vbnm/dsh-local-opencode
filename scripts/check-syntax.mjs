#!/usr/bin/env node
/**
 * Syntax gate: 'node --check' over every module the plugin ships or tests.
 *
 * There is no build step and no dependency, so no compiler would ever see a
 * typo: a broken src/*.js only surfaces when the harness boots, where it reads
 * as a silently inactive plugin. This parses every module instead — in CI, and
 * before publish.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const targets = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) { walk(full); continue }
    if (/.\.(js|mjs|cjs)$/.test(name)) targets.push(full)
  }
}
walk(root)

let failed = 0
for (const file of targets) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  const rel = path.relative(root, file)
  if (result.status !== 0) {
    failed += 1
    console.error('FAIL  ' + rel)
    console.error(String(result.stderr || '').trim().split('\n').slice(0, 6).map((line) => '      ' + line).join('\n'))
  } else {
    console.log('ok    ' + rel)
  }
}
console.log('')
console.log(failed === 0 ? 'check-syntax: ' + targets.length + ' files parse' : 'check-syntax: ' + failed + ' file(s) broken')
process.exit(failed === 0 ? 0 : 1)
