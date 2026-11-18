# Changelog

All notable changes to `dsh-local-opencode` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (0.x: minor bumps may change the settings shape).

## [0.2.0] - 2026-11-18

The plugin grows a second channel — opencode's own agent loop, with tools — and a
sidebar panel to switch between them. The text channel and every 0.1.0 route keep
working unchanged; nothing in the settings you already have is renamed.

### Added
- **Sidebar panel.** A `Local OpenCode` row in the sidebar (order 40, after the
  built-in panels) opens a page with the two switches this release is about. The
  browser half (`client.js`) registers into `sidebar.panellist` and `main`,
  declared through `exports["./client"]` and `dsh.client.inject` in
  `package.json`, so one bundle row mounts both halves at once.
- **Per-model visibility.** Every catalog entry is listed with its provider, its
  free/paid badge and its context window, each with a hide/show button. Hidden ids go
  into `hiddenModels`, leave every route group, and stay in the catalog so they can
  be brought back. The page deliberately does not update optimistically: what changes
  is the picker's membership, and a wrong guess there is harder to trace than a slow
  round-trip.
- **Tool channel.** `channel: "agent"` sends the turn to opencode's own agent loop
  (`POST /api/session/{id}/prompt` plus `GET /api/event`) instead of the stateless
  `generate` call. The tools that run are opencode's, not `dsh`'s: the model can
  read, write, grep and run commands inside a working directory you choose, and `dsh`
  only ever sees the final text and reasoning. `dsh`'s own tool declarations stay
  dropped on both lanes, which is why the channel is a setting rather than a default.
- **Permission policies that are actually enforced.** `permissionMode` is
  `allow-read` (default), `allow-all` or `reject`. Measured on opencode 2.3.0:
  the `build` agent's default permission is `*=allow` and tools execute *silently*,
  with no `permission.asked` event at all — so a plugin that merely *records* a policy
  would be lying. This one sends `permissions` when it creates the session and answers
  every `permission.asked` per policy: read/search/list actions `once` and everything
  else `reject` under `allow-read`, nothing to answer under `allow-all` (tools just
  run) or `reject` (the server refuses; verified the file was not written).
- **Stream-death fallback.** opencode documents its event stream as volatile, so when
  the stream ends before a terminal event the plugin reads the persisted assistant
  message (`GET /api/session/{id}/message`) instead of reporting a transport failure.
- **Routes** `/visibility`, `/channel`, `/agent-settings` and `/agents` behind
  the same admission fence as the existing three.
- **Two test suites.** `test/panel.mjs` (45 assertions) drives the sidebar routes and
  both channels against the fake server, including all three permission policies and the
  stream-death fallback; `test/client.mjs` (33) runs the browser bundle in a fake
  window and asserts the seat registrations and both channel pages.
- **Both-halves assertions** in `bundle-manifest-check.mjs` (43 checks now): the two
  `exports` entries, `dsh.client.platform`, every seat provider named in
  `dsh.client.inject`, and that no client fetch path starts with a root-absolute
  `/api/` (the GUI serves the app from a sub-path, so those would escape it).

### Changed
- The settings file now holds ten keys instead of five; `DEFAULTS` in
  `src/settings.js` is the single source of truth, and the contract suite reads it
  instead of hard-coding a whitelist.
- `statusView` reports `visibility`, `channel`, `permissionMode`,
  `workingDirectory`, `agentName` and `agents` alongside the catalog, and
  `POST /visibility` recomputes route membership and emits
  `emitAdaptersUpdated` so the picker follows immediately.
- `check-syntax.mjs` parses 21 modules (up from 16).

### Fixed
- **Region blocks are `INVALID_REQUEST`, not `AUTH`.** Found on a live run: opencode
  answers `This model is not available in your country` with a 503, the plugin
  classified that as a credential problem, and the chat UI turned `AUTH` into a fixed
  "API key is invalid" — dropping the reason the adapter had written
  (`dsh-client-ui-chat/lib/client.js` clears the message for `AUTH` at :9952 and
  substitutes its own string at :6041). `INVALID_REQUEST` is rendered verbatim and is
  still outside the retryable set, so a region block is neither mis-explained nor paid
  twice. Same fix in the agent lane's classifier.

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
  clamping and disk round-trip; `scripts/check-syntax.mjs` parses all 16 modules (21 as of 0.2.0); and
  `scripts/bundle-manifest-check.mjs` asserts the bundle wiring that a profile needs.
  `scripts/kernel-contract-check.mjs` reads the published harness source and fails if
  the kernel starts calling an adapter method we lack, or if a chunk type or failure
  code we emit is outside its vocabulary. `test/live.mjs` drives the real local
  opencode, one round per zero-cost model, and grades three ways: usable, refused by
  the channel (region or quota, an environment fact that does not fail the run), or a
  genuine failure.

### Known limitations
- **No function calling in the text channel.** That lane is plain text: dsh's tool declarations are not
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
