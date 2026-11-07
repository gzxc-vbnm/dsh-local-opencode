# Changelog

All notable changes to `dsh-local-opencode` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (0.x: minor bumps may change the settings shape).

## [0.1.0] - 2026-11-07

Initial release: the free models already configured in your local
[opencode](https://opencode.ai) become selectable in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

### Added
- **Service discovery.** Reads the opencode server's own registration file
  (`~/.local/state/opencode/service.json`, honoring `XDG_STATE_HOME`) for its url
  and HTTP basic-auth password, then proves it is alive with `GET /api/info`
  before using it. `OPENCODE_SERVER_URL` / `OPENCODE_SERVER_PASSWORD` override both.
- **Live model catalog.** `GET /api/model` is the source of truth, so channels you
  log into later show up without touching this plugin. Zero-cost and enabled models
  go into the `local-opencode` route; billed models go into `local-opencode-paid`,
  which stays an empty group by default (the GUI drops empty groups, so the picker
  shows only the free ones until you opt in via `includePaid`).
- **Per-call session lane.** One dsh turn = `POST /api/session` →
  `POST /api/session/{id}/model` → `POST /api/session/{id}/generate` →
  `DELETE /api/session/{id}`. The generate lane is stateless (verified: a second
  question does not remember the first), which matches dsh replaying full history
  each turn; deleting the session leaves no residue in your opencode session list.
- **Reasoning-effort mapping.** dsh's effort selection maps onto opencode's model
  `variant` (`low`/`high`/`max` …). Only the variants the catalog actually declares
  are offered; an unsupported one is refused locally with the usable list, instead
  of paying a 503 upstream.
- **Failure taxonomy that does not burn quota.** Branch order is region > credential >
  terminal quota > rate limit > 4xx request error > 5xx server error > unclassified, and
  every value comes from the vocabulary the kernel and its official adapters actually
  use (`AUTH`, `QUOTA`, `RATE_LIMIT`, `INVALID_REQUEST`, `SERVER`, `EMPTY_RESPONSE`,
  …) — never a code of our own invention. Terminal quota is separated from a transient
  rate limit by wording, matching the kernel's own `isQuotaExceededError`, so a
  `Free usage limit reached` with hours of `retryAfterMs` is not mislabelled as "retry
  shortly". Neither quota nor credential failures enter the retryable set: one quota
  wall is paid once, not three times. `usage` is reported as disjoint estimated counts
  (this lane returns none).
- **Status surface** at `/api/local-opencode` (`status` / `refresh` / `test`), mounted
  only when the composition provides a web server, behind a trust fence that reuses
  the host's own `connection` admission when present and otherwise replicates it
  structurally (loopback host, same-origin `Origin`/`Referer`).
- **Test suites.** `test/mock-runtime.mjs` (49 assertions) runs the plugin against a
  minimal cordis context and a fake opencode server, covering every hard check the
  kernel performs on an adapter; `test/classifier.mjs` (16) pins the failure mapping
  branch by branch; `test/settings.mjs` (19) covers defaults, override order,
  clamping and disk round-trip; `scripts/check-syntax.mjs` parses all 16 modules; and
  `scripts/bundle-manifest-check.mjs` asserts the bundle wiring that a profile needs.
  `scripts/kernel-contract-check.mjs` reads the published harness source and fails if
  the kernel starts calling an adapter method we lack, or if a chunk type or failure
  code we emit is outside its vocabulary. `test/live.mjs` drives the real local
  opencode, one round per zero-cost model, and grades three ways: usable, refused by
  the channel (region or quota, an environment fact that does not fail the run), or a
  genuine failure.

### Known limitations
- **No function calling.** This lane is plain text: dsh's tool declarations are not
  forwarded, and history is flattened to text with a note telling the model not to
  announce tool calls. Use it for chat, writing and analysis, not as a coding agent.
  The trade buys zero side effects: no files touched, no credentials read, no
  writes on the opencode side.
- The anonymous free lane is quota- and region-limited, and its size moves with
  opencode's own catalog (the plugin reads it live rather than shipping a list).
  Measured 2026-11-07: every zero-cost model the local catalog listed answered in
  about 1.5 seconds except `crouton-alpha-free` and `beam-free`, which returned
  `RegionError`.

### Fixed
- The adapter now implements `imageRequestPricing` and `imageRequestTarget`. The kernel
  calls both on the adapter instance without a guard, so a route that omits them throws
  `TypeError` the moment a request contains an image. Pricing answers zero visual tokens
  plus the placeholder text this lane actually sends.
- `inputModalities` declares `text` only. The lane cannot deliver pixels, and claiming
  vision would make the kernel hand us image blocks to serialize; the upstream channel's
  own capability stays in the model description instead, worded as what the channel
  supports rather than what this bridge forwards.
- `prepareCall` returns an already-resolved `model` object. The kernel awaits
  `prepareCall` itself and then validates `.model` synchronously
  (`normalizeModelInfo`), so a missing `await` hands it a Promise and every call
  dies with `INVALID_MODEL_INFO`. Found against a real harness boot; pinned by an
  assertion in the contract suite.
