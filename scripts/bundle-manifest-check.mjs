#!/usr/bin/env node
/**
 * Bundle manifest sanity gate.
 *
 * A dsh bundle mounts through package.json dsh.bundle.patch, which points at a
 * cordis.patch.yml whose row imports the plugin by its real package name. Three ways
 * this breaks silently, none visible to a normal test run: the patch pointer drifts,
 * the row names a package the profile never installed (Cannot find package), or a
 * declared files entry does not exist on disk. This asserts all of it.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8")
const exists = (rel) => fs.existsSync(path.join(root, rel)) === true
const pkg = JSON.parse(read("package.json"))
const patch = read("cordis.patch.yml")

let failed = 0
const check = (label, ok) => {
  if (ok !== true) failed += 1
  console.log((ok ? "ok    " : "FAIL  ") + label)
}

check("package name is dsh-local-opencode", pkg.name === "dsh-local-opencode")
check("bundle patch pointer", pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === "./cordis.patch.yml")
check("patch row imports the real package name", patch.includes("name: dsh-local-opencode") === true)
check("patch row keeps the stable entry id", patch.includes("id: local-opencode") === true)
check("license declared", pkg.license === "MIT")
check("publishable (not private)", pkg.private !== true)
check("repository points at this repo", typeof pkg.repository === "object" && String(pkg.repository.url).includes("gzxc-vbnm/dsh-local-opencode") === true)
check("bugs + homepage present", typeof pkg.homepage === "string" && typeof pkg.bugs === "object")
check("engines match the harness floor", typeof pkg.engines === "object" && String(pkg.engines.node).includes("22") === true)
check("dsh keywords", Array.isArray(pkg.keywords) && pkg.keywords.includes("dsh-plugin") === true && pkg.keywords.includes("opencode") === true)
check("LICENSE file exists", exists("LICENSE") === true)
check("CHANGELOG exists", exists("CHANGELOG.md") === true)
check("README exists", exists("README.md") === true)

// Every files entry must exist on disk: npm packs exactly this list.
for (const entry of pkg.files) {
  check("files entry: " + entry, exists(entry) === true)
}

// The modules the harness imports at boot.
for (const entry of ["index.js", "client.js", "src/adapter.js", "src/client.js", "src/state.js", "src/settings.js", "src/discovery.js", "src/errors.js", "src/agent-lane.js", "src/event-stream.js", "src/runtime.js"]) {
  check("shipped module: " + entry, exists(entry) === true)
}


// A dual-face plugin ships two modules behind one patch row: the host half (index.js)
// and the browser half (client.js). Four ways this breaks with no other symptom than
// "the sidebar has no row": the export is not declared, the file is not packed, the
// client declaration is missing, or a seat provider is unlisted (the panel then registers
// into a seat nobody declared, and the inject never fires).
check("exports declares the host half", pkg.exports && pkg.exports["."] === "./index.js", JSON.stringify(pkg.exports && pkg.exports["."]))
check("exports declares the browser half", pkg.exports && pkg.exports["./client"] === "./client.js", JSON.stringify(pkg.exports && pkg.exports["./client"]))
check("client.js is packed", pkg.files.includes("client.js") === true)
check("dsh.client declares the web platform", !!(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === "web"))
const seatProviders = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || []
for (const provider of ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"]) {
  check("client injects " + provider, seatProviders.includes(provider) === true)
}
const clientSource = read("client.js")
// Seats are declared by ui-sidebar and ui-layout; registering into any other name is silent.
check("browser half registers the sidebar row", clientSource.includes("sidebar.panellist") === true)
check("browser half registers the main panel", clientSource.includes("\"main\"") === true)
check("panel id matches the entry id", clientSource.includes("var PANEL_ID = \"local-opencode\"") === true)
// A root-absolute path escapes <base href="./"> on a sub-path deployment (issue #1707).
check("browser half uses document-relative API paths", /["`]\/api\/local-opencode/.test(clientSource) === false)
console.log("")
console.log(failed === 0 ? "bundle manifest: clean" : "bundle manifest: " + failed + " problem(s)")
process.exit(failed === 0 ? 0 : 1)