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
for (const entry of ["index.js", "src/adapter.js", "src/client.js", "src/state.js", "src/settings.js", "src/discovery.js", "src/errors.js"]) {
  check("shipped module: " + entry, exists(entry) === true)
}

console.log("")
console.log(failed === 0 ? "bundle manifest: clean" : "bundle manifest: " + failed + " problem(s)")
process.exit(failed === 0 ? 0 : 1)
