#!/usr/bin/env node
/**
 * Live acceptance against the real local opencode: list the catalog, run one short
 * round per zero-cost model, and report the outcome per model.
 *
 * Three verdicts, not two. A model that answers is usable; a model the channel itself
 * refuses (region gate, free-quota wall) is reported as the environment fact it is and
 * does not fail the run — otherwise this suite is red on every restricted network for a
 * reason no code change can fix. Anything else (transport, unknown model, a stream that
 * produced nothing, a broken chunk sequence) is a real failure and does exit nonzero.
 *
 * Usage: node test/live.mjs [--quick] [--model <id>]
 *
 * @module test/live.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const quick = process.argv.includes("--quick")
const onlyAt = process.argv.indexOf("--model")
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined

// Keep the run off the real harness home: settings are written next to DSH_HOME.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lo-live-"))

const registered = []
let discovery
const disposers = []
const ctx = {
  logger: { info: () => {}, warn: (message) => console.log("[warn] " + String(message)) },
  fiber: { entry: { options: { id: "dsh-local-opencode" } } },
  effect: (setup) => { disposers.push(setup()) },
  inject: () => {},
  get: () => undefined,
  llm: {
    registerAdapter: (providers, adapter) => {
      registered.push({ providers: providers, adapter: adapter })
      const dispose = () => { registered.length = 0 }
      dispose.replace = () => {}
      return dispose
    },
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: (ns, fn) => { discovery = { ns: ns, fn: fn }; return () => {} },
    emitAdaptersUpdated: () => {},
  },
}

const plugin = await import("../index.js")
const handle = plugin.apply(ctx, { requestTimeoutMs: 120000, refreshMinutes: 0 })
if (registered.length === 0) {
  console.error("the plugin registered no route (enabled=false?)")
  process.exit(1)
}
const adapter = registered[0].adapter

try {
  await handle.refreshCatalog({ force: true })
} catch (error) {
  console.error("catalog refresh failed: " + String((error && error.message) || error))
  console.error("is opencode installed and running here? (opencode serve, or the TUI open)")
  process.exit(2)
}

const models = await adapter.listModels("local-opencode")
console.log("local opencode zero-cost models: " + models.length)
for (const model of models) console.log("  - " + model.id)

const usable = []
const refused = []
const failures = []

async function oneRound(model, variant) {
  const chunks = []
  const started = Date.now()
  const options = {
    provider: "local-opencode",
    model: model.id,
    reasoningEffort: variant,
    messages: [{ role: "user", content: [{ type: "text", text: "只回复四个字：本地通道可用" }] }],
    tools: [{ name: "demo_tool", description: "must be ignored by this lane", parameters: { type: "object", properties: {} } }],
  }
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return { chunks: chunks, ms: Date.now() - started }
}

// A channel refusal is an environment fact: the code and the wording both say so.
const CHANNEL_CODES = new Set(["AUTH", "QUOTA", "RATE_LIMIT"])

const targets = models.filter((model) => only === undefined || model.id === only)
const sample = quick ? targets.slice(0, 3) : targets
for (const model of sample) {
  const entry = handle.statusView().catalog.find((row) => row.id === model.id)
  const variants = entry && Array.isArray(entry.variants) ? entry.variants : []
  const variant = variants.length > 0 ? variants[Math.min(1, variants.length - 1)] : undefined
  const run = await oneRound(model, variant)
  const last = run.chunks[run.chunks.length - 1]
  const reason = last && last.reason ? last.reason : { kind: "missing" }
  const tag = model.id + (variant ? " (" + variant + ")" : "") + " " + run.ms + "ms"
  if (reason.kind === "stop") {
    const text = (run.chunks.find((chunk) => chunk.type === "text-delta") || {}).text || ""
    const sequence = JSON.stringify(run.chunks.map((chunk) => chunk.type))
    const expected = JSON.stringify(["block-start", "text-delta", "block-end", "usage", "finish"])
    if (text.trim() === "") {
      failures.push(tag + " answered with no content")
    } else if (sequence !== expected) {
      failures.push(tag + " chunk sequence " + sequence)
    } else {
      usable.push(tag); console.log("usable    " + tag + "  " + JSON.stringify(text.slice(0, 24)))
    }
    continue
  }
  if (reason.kind === "error" && reason.failure && CHANNEL_CODES.has(reason.failure.code)) {
    refused.push(tag + " " + reason.failure.code)
    console.log("refused   " + tag + "  [" + reason.failure.code + "] " + reason.failure.message)
    continue
  }
  failures.push(tag + " " + JSON.stringify(reason))
  console.log("FAILED    " + tag + "  " + JSON.stringify(reason))
}

const discovered = await discovery.fn({})
console.log("");
console.log("model discovery: " + discovered.length + " candidates")
const status = handle.statusView()
console.log("connection: " + status.connection.message)
if (status.connection.status !== "connected") failures.push("connection is " + status.connection.status)
if (discovered.length !== models.length) failures.push("discovery listed " + discovered.length + " of " + models.length)

for (const dispose of disposers) {
  if (typeof dispose === "function") {
    const result = dispose()
    if (result && typeof result.catch === "function") await result.catch(() => {})
  }
}
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true })

console.log("");
console.log("usable " + usable.length + " | refused by channel " + refused.length + " | failures " + failures.length)
if (usable.length === 0) failures.push("not one model answered: the free lane is unavailable from here")
if (failures.length === 0) {
  console.log("live acceptance: clean")
  process.exit(0)
}
console.log("live acceptance FAILED:");
for (const failure of failures) console.log("  - " + failure)
process.exit(1)
