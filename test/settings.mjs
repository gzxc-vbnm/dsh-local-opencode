#!/usr/bin/env node
/**
 * Settings layer: defaults, override order, normalization, disk round-trip.
 *
 * The load-bearing invariant is the name of the data directory. The installed package
 * lives at ~/.dsh/<package-name>, so a data directory that equals the package name would
 * write user settings inside the package itself, where a reinstall deletes them.
 *
 * @module test/settings.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DATA_DIR_NAME, DEFAULTS, createSettings, resolveDshHome } from "../src/settings.js"

let failed = 0
const check = (label, ok, detail) => {
  if (ok !== true) failed += 1
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail === undefined ? "" : "   " + detail))
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lo-settings-"))
const dataDir = path.join(home, DATA_DIR_NAME)
const settingsFile = path.join(dataDir, "settings.json")

// 0. the invariant that decides where settings live at all
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
check("data dir name differs from the package name", DATA_DIR_NAME !== pkg.name, DATA_DIR_NAME + " vs " + pkg.name)
check("so settings never land inside the installed package dir", path.join(home, pkg.name) !== dataDir)

// 1. defaults
const fresh = createSettings({ dataDir: dataDir, logger: undefined, config: undefined })
check("absent file falls back to defaults", fresh.get().enabled === true && fresh.get().refreshMinutes === DEFAULTS.refreshMinutes)

// 2. override order: defaults <- disk <- bundle config
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(settingsFile, JSON.stringify({ refreshMinutes: 7, includePaid: { others: true } }))
const layered = createSettings({ dataDir: dataDir, logger: undefined, config: { refreshMinutes: 2 } })
check("bundle config outranks disk settings", layered.get().refreshMinutes === 2, String(layered.get().refreshMinutes))
check("disk settings outrank defaults", layered.get().includePaid.others === true && layered.get().enabled === true)

// 3. normalization: clamp out-of-range values, drop unknown keys, survive a broken file
const clamped = createSettings({ dataDir: dataDir, logger: undefined, config: { refreshMinutes: 999999, requestTimeoutMs: 1, bogus: "x" } })
check("refreshMinutes clamps to the ceiling", clamped.get().refreshMinutes === 1440, String(clamped.get().refreshMinutes))
check("requestTimeoutMs clamps to the floor", clamped.get().requestTimeoutMs === 5000, String(clamped.get().requestTimeoutMs))
check("unknown keys never enter the settings", clamped.get().bogus === undefined)
check("negative refreshMinutes clamps to zero rather than arming a timer backwards", createSettings({ dataDir: dataDir, config: { refreshMinutes: -5 } }).get().refreshMinutes === 0)
fs.writeFileSync(settingsFile, "{ not json at all")
const broken = createSettings({ dataDir: dataDir, logger: undefined, config: undefined })
check("a corrupt file falls back instead of throwing", broken.get().enabled === true && broken.get().refreshMinutes === DEFAULTS.refreshMinutes)

// 4. includePaid accepts both spellings
fs.rmSync(settingsFile, { force: true })
const shorthand = createSettings({ dataDir: dataDir, logger: undefined, config: { includePaid: true } })
check("includePaid=true expands to both channels", shorthand.get().includePaid.githubCopilot === true && shorthand.get().includePaid.others === true)
const alias = createSettings({ dataDir: dataDir, logger: undefined, config: { includePaid: { copilot: true, other: true } } })
check("aliases copilot/other also work", alias.get().includePaid.githubCopilot === true && alias.get().includePaid.others === true)
const partial = createSettings({ dataDir: dataDir, logger: undefined, config: { includePaid: { githubCopilot: "yes" } } })
check("a non-boolean channel value stays off rather than truthy", partial.get().includePaid.githubCopilot === false, JSON.stringify(partial.get().includePaid))

// 5. debounced flush survives a restart
const persist = createSettings({ dataDir: dataDir, logger: undefined, config: undefined })
persist.update({ refreshMinutes: 0, enabled: false })
await new Promise((resolve) => setTimeout(resolve, 400))
const reopened = createSettings({ dataDir: dataDir, logger: undefined, config: undefined })
check("edits persist to disk and reload", reopened.get().refreshMinutes === 0 && reopened.get().enabled === false, JSON.stringify(reopened.get()))
check("flush is atomic: no temp file left behind", fs.existsSync(settingsFile + ".tmp") === false)

// 6. dispose flushes a still-pending edit instead of losing it
const pending = createSettings({ dataDir: dataDir, logger: undefined, config: undefined })
pending.update({ refreshMinutes: 11 })
pending.dispose()
const afterDispose = createSettings({ dataDir: dataDir, logger: undefined, config: undefined })
check("dispose flushes a pending edit (hot reload must not lose it)", afterDispose.get().refreshMinutes === 11, String(afterDispose.get().refreshMinutes))

// 7. resolveDshHome honors DSH_HOME
const previous = process.env.DSH_HOME
process.env.DSH_HOME = home
check("resolveDshHome uses DSH_HOME", resolveDshHome() === home, resolveDshHome())
process.env.DSH_HOME = "   " + home + "  "
check("DSH_HOME is trimmed before use", resolveDshHome() === home, JSON.stringify(resolveDshHome()))
delete process.env.DSH_HOME
check("resolveDshHome falls back to home/.dsh", resolveDshHome() === path.join(os.homedir(), ".dsh"), resolveDshHome())
if (previous !== undefined) process.env.DSH_HOME = previous

fs.rmSync(home, { recursive: true, force: true })
console.log("")
console.log(failed === 0 ? "settings: clean" : "settings: " + failed + " failure(s)")
process.exit(failed === 0 ? 0 : 1)
