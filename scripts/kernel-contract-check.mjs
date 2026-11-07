#!/usr/bin/env node
/**
 * Harness llm contract check.
 *
 * The plugin satisfies the adapter contract structurally on purpose: it imports nothing
 * from the harness LLM package, which is what lets one build mount on more than one kernel
 * line. The cost is that kernel movement is invisible to a dependency bump: a method the
 * kernel starts calling on every adapter instance, a chunk type it no longer names, or a
 * failure code it never sees only show up when the harness boots.
 *
 * This reads the published kernel source and compares it with ours:
 *   1. every method the kernel invokes on an adapter instance exists on ours;
 *   2. every chunk type we emit is in the kernel chunk vocabulary;
 *   3. every failure code we emit is a code the kernel or an official adapter uses;
 *   4. every CODE.x the plugin reads is a key of its own CODE table.
 *
 * Point DSH_ROOT at a directory that installed @deepseek-ai/dsh. CI runs this against the
 * current published build; the canary job repeats it on the moving prerelease with
 * CONTRACT_ALLOW_WARN=1, where a mismatch is reported but does not fail the run.
 *
 * Scanning is indexOf-based rather than regex-based on purpose: it keeps this file free of
 * backslash escapes, which were a real bug source in this repository.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const NL = String.fromCharCode(10)
const DQ = String.fromCharCode(34)
const SQ = String.fromCharCode(39)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(HERE, "..")
const root = process.env.DSH_ROOT
const allowWarn = process.env.CONTRACT_ALLOW_WARN === "1"
const failures = []

if (!root) {
  console.error("DSH_ROOT is not set: point it at a directory that installed @deepseek-ai/dsh.")
  process.exit(1)
}

function readIf(file) {
  try { return fs.readFileSync(file, "utf8") } catch { return undefined }
}

function versionOf(packageDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).version
  } catch { return "unknown" }
}

/**
 * Find a package directory under an install, covering the layouts that actually occur:
 * hoisted to the top level, nested inside the harness package, and the pnpm store.
 */
function findPackage(scope, name) {
  const inner = path.join("node_modules", scope, name)
  const candidates = [
    path.join(root, inner),
    path.join(root, "node_modules", scope, "dsh", inner),
  ]
  const store = path.join(root, "node_modules", ".pnpm")
  const slug = scope.slice(1) + "+" + name
  try {
    for (const dir of fs.readdirSync(store)) {
      if (dir.startsWith(slug + "@")) candidates.push(path.join(store, dir, inner))
    }
  } catch { /* no store: a plain install */ }
  for (const dir of candidates) {
    if (readIf(path.join(dir, "package.json")) !== undefined) return dir
  }
  return undefined
}

function isWordChar(char) {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9") || char === "_"
}

/** Read the identifier starting at index. */
function wordAt(source, index) {
  let word = ""
  let at = index
  while (at < source.length && isWordChar(source[at])) { word += source[at]; at += 1 }
  return { word: word, next: at }
}

/** Every dotted read of a receiver, call or not: adapter.x, CODE.x. */
function propertyReads(source, receiver) {
  const names = new Set()
  const needle = receiver + "."
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at < 0) break
    const read = wordAt(source, at + needle.length)
    if (read.word.length > 0) names.add(read.word)
    from = at + needle.length
  }
  return names
}

/** Only the dotted reads that are actually called: adapter.stream(...). */
function calledMethods(source, receiver) {
  const names = new Set()
  const needle = receiver + "."
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at < 0) break
    const read = wordAt(source, at + needle.length)
    if (read.word.length > 0 && source[read.next] === "(") names.add(read.word)
    from = at + needle.length
  }
  return names
}

/** Method names defined at the top level of a class body (two-space indent). */
function definedMethods(source) {
  const names = new Set()
  for (const line of source.split(NL)) {
    if (line.startsWith("  ") === false || line.startsWith("   ") === true) continue
    let body = line.slice(2)
    if (body.startsWith("async ")) body = body.slice(6)
    const read = wordAt(body, 0)
    if (read.word.length === 0) continue
    if (body[read.next] !== "(") continue
    names.add(read.word)
  }
  return names
}

/** ALL_CAPS words the source holds inside quotes: the failure-code vocabulary. */
function quotedCodes(source, minimumLength) {
  const words = new Set()
  for (const quote of [DQ, SQ]) {
    let from = 0
    for (;;) {
      const open = source.indexOf(quote, from)
      if (open < 0) break
      const close = source.indexOf(quote, open + 1)
      if (close < 0) break
      const text = source.slice(open + 1, close)
      if (text.length < minimumLength || text !== text.toUpperCase()) { from = close + 1; continue }
      let clean = true
      for (const char of text) {
        if ((char >= "A" && char <= "Z") || (char >= "0" && char <= "9") || char === "_") continue
        clean = false
        break
      }
      if (clean) words.add(text)
      from = close + 1
    }
  }
  return words
}

/** Keys of the flat ALL_CAPS object literal that starts at marker. */
function tableKeys(source, marker) {
  const start = source.indexOf(marker)
  if (start < 0) return new Set()
  const body = source.slice(start, source.indexOf("})", start))
  const keys = new Set()
  for (const line of body.split(NL)) {
    if (line.startsWith("  ") === false) continue
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const word = line.slice(2, colon)
    if (word.length === 0 || word !== word.toUpperCase()) continue
    let clean = true
    for (const char of word) {
      if ((char >= "A" && char <= "Z") || char === "_") continue
      clean = false
      break
    }
    if (clean) keys.add(word)
  }
  return keys
}

function report(label, problems, seenCount) {
  if (problems.length === 0) {
    console.log("ok    " + label + " (" + seenCount + ")")
    return
  }
  failures.push(label)
  console.log((allowWarn ? "WARN  " : "FAIL  ") + label + " -> " + problems.join(", "))
}

const llmDir = findPackage("@deepseek-ai", "dsh-llm")
if (llmDir === undefined) {
  console.error("cannot locate @deepseek-ai/dsh-llm under " + root)
  process.exit(1)
}
const kernel = [
  readIf(path.join(llmDir, "lib", "index.js")),
  readIf(path.join(llmDir, "lib", "types", "index.d.ts")),
].filter((text) => typeof text === "string").join(NL)
if (kernel.length === 0) {
  console.error("no kernel source found in " + llmDir)
  process.exit(1)
}
console.log("kernel: @deepseek-ai/dsh-llm@" + versionOf(llmDir))

// Official adapters carry failure-code vocabulary the LLM package does not spell out.
const official = ["dsh-llm-pi-ai", "dsh-llm-deepseek", "dsh-llm-retry"]
  .map((name) => findPackage("@deepseek-ai", name))
  .filter((dir) => dir !== undefined)
  .map((dir) => readIf(path.join(dir, "lib", "index.js")) || "")
  .join(NL)

const adapterSource = fs.readFileSync(path.join(pluginRoot, "src", "adapter.js"), "utf8")
const errorsSource = fs.readFileSync(path.join(pluginRoot, "src", "errors.js"), "utf8")

// 1) Methods the kernel invokes on an adapter instance must all exist on ours.
const called = new Set([...calledMethods(kernel, "adapter"), ...calledMethods(kernel, "adapterCall")])
const implemented = definedMethods(adapterSource)
const missing = Array.from(called).filter((method) => implemented.has(method) === false).sort()
console.log("kernel calls: " + Array.from(called).sort().join(", "))
console.log("we define:    " + Array.from(implemented).sort().join(", "))
report("every kernel-invoked adapter method exists", missing, called.size)

// 2) Chunk vocabulary.
const emitted = new Set()
for (const line of adapterSource.split(NL)) {
  const at = line.indexOf("type: ")
  if (at < 0) continue
  const quote = line[at + 6]
  if (quote !== SQ && quote !== DQ) continue
  const close = line.indexOf(quote, at + 7)
  if (close < 0) continue
  const value = line.slice(at + 7, close)
  if (value.length > 1) emitted.add(value)
}
const unknownChunks = Array.from(emitted)
  .filter((type) => kernel.includes(SQ + type + SQ) === false && kernel.includes(DQ + type + DQ) === false)
  .sort()
report("every emitted chunk type is kernel vocabulary", unknownChunks, emitted.size)

// 3) Failure codes must be vocabulary the kernel or an official adapter actually uses.
const codeReads = propertyReads(adapterSource, "CODE")
const ourCodes = new Set([...tableKeys(errorsSource, "export const CODE"), ...codeReads])
const known = new Set([...quotedCodes(kernel, 3), ...quotedCodes(official, 3)])
const unknownCodes = Array.from(ourCodes).filter((code) => known.has(code) === false).sort()
report("every emitted failure code is kernel/official vocabulary", unknownCodes, ourCodes.size)

// 4) A dangling CODE.x read yields failure.code === undefined, and the kernel selects its
//    retry behaviour by that code, so the table and the reads must agree.
const table = tableKeys(errorsSource, "export const CODE")
const dangling = Array.from(codeReads).filter((name) => table.has(name) === false).sort()
report("every CODE.x read exists in the CODE table", dangling, codeReads.size)

console.log("")
if (failures.length === 0) {
  console.log("contract check: clean against dsh-llm@" + versionOf(llmDir))
  process.exit(0)
}
console.log("contract check: " + failures.length + " mismatch group(s) against dsh-llm@" + versionOf(llmDir))
process.exit(allowWarn ? 0 : 1)
