---
id: 2026-09-30-browser-origin-injection-materialized-jsonb
date: 2026-09-30
title: Browser-origin preparation materialized opaque JSONB into an unbounded Node object graph
surface: back-end
component: browser-origin-injection
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: injectUserData selected origin JSONB through Prisma before serializing whole-origin init scripts
symptoms:
  - "Failed to inject indexedDB"
  - "origin transfer exceeded 1200MB RSS: 1390.015625"
  - "Google credential preparation returned HTTP 500 after 32 seconds before an 8 GB guest OOM"
  - "Browser state injection timed out after 15000ms"
  - "Browser state injection timed out after 18000ms"
tags:
  - indexeddb
  - jsonb
  - prisma
  - oom
  - browser-credentials
  - init-script
sources:
  - PR #1299
  - commit d4c3d87c05f364a5dfb5ef28a6ed8828e9e537b0
  - fleet run 20260930-205255-27412
  - fleet run 20261001-195536-10470
  - fleet run 20261002-091933-1152
  - agent 07281fc3-5e49-4cd2-9573-235cb19b0481
repro: back-end/src/tests/blackbox/browser-origin-injection-memory.blackbox.ts
status: open
---

## Problem

The first proof82 fleet slice earned zero credit after an 8 GB guest lost its
backend. Native kernel evidence attributed approximately 6.45 GB anonymous RSS
to Node. Immediately preceding this, Google credential preparation stalled in
IndexedDB injection and returned HTTP 500 after 32 seconds. Exact live allocation
attribution remains open: current scoped metadata has a 79 MB IndexedDB row and
nine origins, while the original snapshot selected eight origins. No raw
credentials, trajectories or forensic logs are committed.

## Diagnosis

The proven owning path is selected user/realm origin metadata -> Prisma JSONB
codec -> Node object graph -> JSON.stringify -> remote addInitScript. The
original read selected every payload, and the script embedded the complete
origin. That boundary had no byte budget and decoded values Node needed only to
transport. The same gap affects LocalStorage and CacheStorage siblings.

The permanent real-Postgres blackbox builds 540,000 synthetic records in SQL and
transfers 78,617,865 bytes through the actual injectUserData path. It runs a
512 MB heap child, checks the unchanged 1,200 MB peak-RSS budget and verifies the
receiver hash against server-side md5. The unchanged test on the original source
failed at 1,390 MB. The draft passed at 459 MB; the final escaped-envelope budget
passed at 523 MB. After removing repeated SQL serialization, the final unchanged
reproduction passed at 455 MB in 9.19 seconds. Exact command, from back-end with both DATABASE_URL and
DIRECT_URL set privately to the owned isolated database:
`node --import tsx src/tests/blackbox/browser-origin-injection-memory.blackbox.ts`.

Archive searches were `Failed to inject indexedDB OOM` and `browser origin
preparation JSON memory amplification`. This is a relative of
2026-07-29-prisma-json-codec-decodes-41mb-row (seed transfer) and
2026-08-03-parallel-browser-state-injection-hung-jit-realm-preparation (remote
mutation scheduling), at a separately owned preparation boundary. Their tests
covered seeding and stalled calls, not large-payload preparation.

This proves a real memory-amplification defect, not the exact allocation source
of the original live OOM. The unchanged local benchmark outcome pair and exact
original live allocation remain open; fresh fleet proof is separately required.

## Solution

Origin ORM selects carry identity, user, origin, hash and revision only. One
transaction serializes the selected revision into temporary uncompressed bytea
staging, then reads bounded byte slices with a streaming UTF-8 decoder. Each read
rechecks the original identity/revision. Transaction commit or rollback drops the
stage, and CacheStorage retains its original names-only projection. Init scripts have a 1 MB budget including JSON escaping
and CDP envelope overhead. A per-injection assembler preserves arbitrary order,
duplicate delivery and Unicode, applies only after complete receipt in the
matching document, and never combines revisions. Timeout cancellation fences
subsequent SQL reads and script mutations. Storage restoration behavior remains
unchanged.

This removes Node's payload object graph and unbounded script transport. The
receiver assembler is necessary because init-script order is unspecified; the
old per-table serialization now shares one transfer implementation. At 10,000
agents there is no global lock, per-user fan-in or shared payload cache. Each
preparation has independent bounded transfer buffers and document state. A
transaction pins one pool connection during CDP awaits within the configured
state budget and uses temporary PostgreSQL disk proportional to payload bytes. Real
Playwright retains registered script sources, so total Node/browser storage is
not constant in payload size; the fake receiver does not prove that retention
fits the original live guest. No global resource or shared payload cache is added.

Both new tests are automatically discovered by the permanent backend runner
used by /deploy. The runner passed all three domains:
`node --import tsx src/tests/blackbox/run.ts steel-injection,browser-origin-payload,browser-origin-injection-memory --concurrency=1`.
The payload suite covers serialized wire bounds, Unicode, reverse order,
duplicates, missing chunks, interleaving, origin isolation, LocalStorage and
IndexedDB values, CacheStorage names, cancellation and real SQL revision/user
boundaries. Backend typecheck and the agent browser_credentials suite passed.
Independent adversarial review found repeated full-row SQL serialization in the
first draft: a 79,200,012-byte fixture took 8,232.00 ms for 19 reads, reserializing
1.50 GB. After staging once, serialization took 285.95 ms and the 19 reads took
19.90 ms (305.85 ms total, 96.3% less SQL time). The same-connection review also
verified READ COMMITTED and ON COMMIT DROP. The revised source has no remaining
review blocker. Actual-SQL astral Unicode and cancellation cases now supplement
the legacy-value tests. Final reverse-import lint and typecheck passed. Cloud
source synchronization and the fresh ten-slice fleet outcome remain pending.

The main integration structural gate requires the canonical transaction wrapper.
The staging read uses `runTransactionWithRetry` with one attempt and the same
15-second maxWait/timeout, preserving the cancellation fence and prohibiting
replay of partially executed CDP mutations. The unchanged memory and functional
blackboxes passed on this integrated source. Peak RSS was 431 MB. The same
memory test also passed with V8 coverage in 10.04 seconds. Parallel full-suite
execution failed at the short injection deadlines while the unchanged isolated
V8 test passed; fixture contention is inferred from that isolation and the
subsequent scheduling result, rather than a measured database/CPU attribution.
The
existing runner's late exclusive phase now owns the memory and Steel injection
domains after its fixture-writing pool drains. Their assertions, phase limits,
RSS budget and domain coverage remain unchanged; both then passed in the full
backend coverage run. That initial run failed its separate live Kernel parity
check; the later integrated backend coverage gate passed on `5c6f095`. This
scheduling evidence does not establish the original live OOM's allocation source.

### October 1 live timeout and approved infrastructure headroom

Proof94's second slice failed on `polar-odysseys-8f005e9f0910`. A browser
initialization exhausted the 15-second state-injection budget on five attempts.
Its peer initialized successfully, but the failed browser had no recording;
the archive correctly rejected incomplete browser evidence. Exact provider
cleanup and subsequent zero-credit forensic retirement succeeded. All ten
Machines were independently confirmed stopped with zero claims and no owner
registry. The consecutive acceptance streak reset to zero.

The original backend evidence selected 34 LocalStorage and eight IndexedDB
origins per initialization. The successful peer took 14.686 seconds overall,
including 13.347 seconds in IndexedDB injection. One failed attempt completed
IndexedDB in 13.176 seconds and then expired in CacheStorage. Summed successful
raw SQL operations consumed 3.430–5.320 seconds per request. These observations
show accumulated preparation time; they do not isolate the remaining time
between script construction and CDP acknowledgements. The existing immediate
receiver proves memory and assembly, but does not exercise real CDP latency.

The user explicitly authorized 20% more infrastructure timeout headroom and
then clarified that harness timeouts must remain unchanged. Credential CDP
connection and browser-state injection therefore default to 18 seconds. The
payload transaction derives its timeout from the same configured state budget,
retaining one attempt, revision checks, byte bounds and cancellation fences.
This is an approved budget mitigation, not proof that the original OOM's exact
allocation source was found. The normal 7200-second harness limit, temporary
300-second execution backstop and independent 1800-second fleet E2E cutoff are
unchanged.

A private real-Chromium/CDP extension of the same owning fixture transferred
78.6 MB through 133 bounded scripts (101.78 MB of escaped wire data), then read
back all 540,000 IndexedDB records and verified both full-content hashes. The
original 15-second budget passed in 9.55 seconds at 351 MB peak Node RSS; the
approved 18-second policy passed in 11.78 seconds at 304 MB. Each run retired
its exact browser processes, profile and SQL fixture. An initial profile run
had a readback-oracle serialization error; that failed diagnostic is retained
privately and earns no verification credit. These Mac profiles do not reproduce
the cloud timeout and establish neither its exact cause nor fleet acceptance.
Independent scoped review passed the timeout policy, explicit override behavior
and unchanged cancellation/ownership boundaries. A fresh consecutive fleet proof
remains required before reporting qualification.

The existing 75 ms stalled-CDP regression also exposed a fixture boundary issue:
one run spent 80 ms preparing SQL and never reached its intended browser stall,
while the unchanged isolated run reached it in 12 ms and passed all ten cases.
The fixture now uses permission and scrollbar mutations, which enter CDP
directly after metadata selection. It retains the 75 ms timeout, 500 ms outcome
guard and serial-call assertions, then releases the stalled call after timeout
to verify that no later mutation begins. Actual SQL scope, content and chunk
cancellation remain covered by the payload and memory blackboxes. No production
behavior or harness deadline was changed for this fixture correction.

### October 1 recurrence: bounded packets still amplified encoding work

The unchanged exact cloud diagnostic on source `67e420e` completed task
evaluation, 27 correlated LIVE queries, durable publication and native teardown,
but four browser-state injections exhausted the approved 18-second budget and
returned HTTP 500 before a fifth succeeded. It was rejected with zero campaign
credit. All five attempts selected 34 LocalStorage and eight IndexedDB origins.
The failures took 18.228, 18.249, 18.326 and 18.223 seconds; completed raw SQL
inside their serial state phases consumed 4.507, 8.201, 4.999 and 6.441 seconds.
Existing logs lacked per-CDP timings, so the remainder cannot be assigned to
browser transfer alone. The same frozen origin set passed an isolated one-core
profile in 11.200 seconds, including 6.430 seconds awaiting browser calls.

That profile measured 502.944 MB of payload/envelope serialization for 42.462 MB
of delivered envelopes. Packet sizing started from the complete unsent SQL
chunk on every iteration, encoded impossible candidates and repeatedly halved
them. The existing real-Postgres memory blackbox now also measures large JSON
encoding work, with an eight-times-delivered-byte ceiling for its unchanged
78.6 MB fixture. On the buggy source it failed with 1,344,412,305 encoded bytes
for 101,644,555 delivered bytes. After bounding the initial candidate and
shrinking by measured escaped size, the identical command passed in 10.327
seconds at 461 MB peak RSS. Hash, record count, RSS ceiling and test timeout
were unchanged. This is a deterministic work regression, not a machine-speed
deadline or a universal ratio guarantee for arbitrary payloads.

Every candidate still receives the exact serialized-envelope check. A minimum
10% shrink ensures progress for nonuniform escaping, and the existing assembler
preserves Unicode content across split surrogate pairs, order and complete content. Numeric per-origin
transfer timing now captures encoding work, CDP wait including failed awaits,
and any in-flight wait at cancellation; it includes no payload, origin or user
identity. The existing memory, assembly and Steel injection blackbox domains all
passed, as did affected lint and backend typecheck. Independent review found no
static packet-sizing blocker. The next exact live outcome remains required:
this work reduction does not yet establish resolution of the 18-second cloud
timeouts or the original live OOM. Archive searches were
`BrowserStateInjectionTimeout 18000` (no exact hit) and
`large origin payload injection timeouts serialization` (this open case).

### October 2: bounded scripts still replayed the entire payload to every target

The exact cloud diagnostic reproduced a browser-action save ReadTimeout during
execution. Its 614-byte request first entered the pre-Express observer 5.297
seconds after the worker began saving, 207 ms after the client timed out. The
same backend had acknowledged 50 IndexedDB scripts containing 41,255,356 raw
bytes. Critical CPU samples were dominated by Playwright's attached-target
initialization and synchronous init-script WebSocket serialization/writes.
Those samples identify the active path, not an exact attribution of every
millisecond of the failed request. The request correlation and limits are
recorded in the October 2 browser-action-save case. The diagnostic remained
INFRA despite evaluation, 17 LIVE queries, durable evidence and native cleanup.

The earlier memory receiver executed each script immediately and discarded it.
It therefore missed Playwright's retained script list: every newly attached page
or iframe receives every context init script. The script's origin condition runs
in Chromium, after Node has serialized and transmitted the whole source. Bounded
individual envelopes did not bound this repeated work.

The permanent `browser-origin-target-replay.blackbox.ts` uses actual Chromium,
an observed CDP WebSocket and out-of-process frames. It supplies a 2,097,172-byte
synthetic IndexedDB value through the real storage helper. On the original
source the final frozen test failed in 6.232 seconds because an unrelated new
page received 2,104,969 bytes of payload scripts. The identical test passed in
1.644 seconds after the fix: both unrelated page and iframe received zero bulk
payload bytes, and all observed init-script traffic totaled 416 bytes. The
fixture also reads the exact IndexedDB value from the first application script
after injector disconnect and again after reload; it checks additive existing
records, LocalStorage including empty/Unicode values, CacheStorage names, caller
pages and cancellation during a pending page acquisition. The command, from
`back-end` with the owned local database environment, is
`node node_modules/tsx/dist/cli.mjs src/tests/blackbox/browser-origin-target-replay.blackbox.ts`.

Storage restoration now reuses one lazily created, owned page across the existing
serial preparation phase. Page-scoped routing fulfills only its exact synthetic
navigation and aborts other requests; page-scoped service-worker bypass prevents
an existing worker from substituting application content. Bounded evaluation
transfers the opaque slices into the matching origin once. IndexedDB transaction
completion or abort and CacheStorage opens settle before that page closes.
Existing stores are restored without an unnecessary version upgrade; a required
upgrade remains subject to the original phase deadline. No cookies, existing
stores, caller pages or context-wide state are cleared. No origin-partition
metadata is invented beyond the stored origin-only schema.

The SQL snapshot/revision lease, Unicode assembly, cancellation fences, escaped
packet budget and 18-second infrastructure budget remain. Permissions and
scrollbar scripts remain small context init scripts. The existing memory and
assembly fixtures now use the one-time evaluation seam while retaining their
content, scope, serialization-work and 1,200 MB RSS assertions. All four owning
backend domains passed the canonical runner in 50.533 seconds before the final
review cleanup; final full backend validation is tracked separately. Independent
review removed an early transaction-error settlement and a new blocked-upgrade
early return, preserving terminal commit/abort and the existing timeout behavior.

Initial fixture attempts are retained as setup failures, not causal evidence:
the CDP relay initially used binary instead of text frames; a Mac loopback alias
did not navigate; and CacheStorage requires a secure context. The final fixture
uses trusted loopback for storage and locally mapped distinct test hosts for
unrelated targets, with no external service or model calls. Private immutable
RED/GREEN and cleanup receipts live under
`.context/acceptance/proof110-origin-target-replay-rca/`.

This proves and repairs retained-payload fanout at its owning boundary. The
original live OOM allocation and a fresh post-repair cloud outcome are separate
claims and remain unverified here. The ten-slice fleet gate is still required.

### October 2: remove redundant payload-completion acknowledgments

The unchanged `a1114c7` cloud diagnostic `20261002-160354-21125` evaluated
`polar-odysseys-082aa17f3e88` and completed 18 correlated LIVE queries, but four
browser preparations returned `BrowserStateInjectionTimeout`. It therefore
received zero credit. Native cleanup verified all ten pool Machines stopped,
zero claims and no remaining owner registry. Teardown completed about 24 seconds
after its guest acknowledgment; the failures occurred during execution.

The original state phases continued making useful progress up to their
18-second deadline. The first reached 31 of 34 LocalStorage rows; three others
finished LocalStorage and exhausted the remaining budget transferring IndexedDB.
The fifth preparation completed in 14.707 seconds. Completed SQL occupied
0.200, 3.071, 2.696, 3.377 and 3.152 seconds respectively. These observations do
not attribute the remaining time to one transport operation or prove a new cause.
Archive searches for `BrowserStateInjectionTimeout` and `browser state storage
injection timeout` led to this recurrence and earlier CDP/serialization cases.

A configured owning diagnostic used the canonical Kernel creation helper, its
validated browser, fresh persistent profile, residential city proxy, the retained
34 LocalStorage / eight IndexedDB / eight cache / seven permission rows, and a
preserved canonical cookie bundle with 161 cookies. It completed injection in
8.342 seconds under the unchanged 18-second budget, with 148 evaluations and
50 navigations. Its lifecycle took 19.932 seconds and all exact resources retired.
Its frozen cookies cannot prove equality to the original run's refreshed cookie
version. An earlier attempt stopped before injection because its test guard
compared raw location formatting with canonical normalized proxy formatting;
that artifact is preserved as a test setup failure, not a timeout reproduction.

The protocol sent every data packet without a completion marker, then always
spent an extra acknowledgment on an empty completion packet. The existing actual
Chromium/CDP blackbox now counts both runtime evaluation forms used by Playwright.
Its positive observation assertion prevents a missing observer from becoming
false causal evidence. On the buggy implementation, the frozen test failed in
11.702 seconds: a fitting LocalStorage payload used two acknowledged mutations
instead of one. The identical test and command passed in 12.961 seconds after
the change, with one mutation. This proves eliminated protocol work, not a
wall-clock speedup or resolution of the original live timeout.

`injectOriginPayload` now retains only its last bounded packet until the opaque
SQL read transaction succeeds, then carries the completion marker with that
packet. Earlier packets still stream with completion unset. The combined envelope
receives the exact unchanged 1 MB check; if it no longer fits, the original
separate completion protocol remains. Cancellation checks, immutable
user/origin/revision predicates and storage settlement remain unchanged. Memory
adds one bounded pending packet per active injector, independent of fleet width;
there is no shared lock or per-user fan-in at 10,000 agents.

The frozen command, from `back-end` with the existing owned local database, is
`node node_modules/tsx/dist/cli.mjs src/tests/blackbox/browser-origin-target-replay.blackbox.ts`.
The test retains storage after disconnect/reload, Unicode and empty values,
existing records/cache names, foreign page/iframe isolation, caller-page
preservation and late cancellation. The existing real-Postgres payload, memory
and Steel domains also passed the canonical blackbox runner in 76.435 seconds;
the memory budget remains 1,200 MB. Typecheck, affected lint and independent
implementation review passed. Private immutable artifacts are under
`.context/acceptance/proof111-completion-packet-rca/`; no payloads or raw logs
are committed. The owning file remains automatically discovered in the normal
backend `/deploy` blackbox gate. Full final-source deploy and fleet evidence are
separate required gates. The original OOM allocation and 18-second timeout
attribution remain open.

### October 12 recurrence: the restored volume itself was unbounded

Prod agent `07281fc3-5e49-4cd2-9573-235cb19b0481` (Mac app, Kernel) failed
eight `spawn_browser_agent` inits between 20:11 and 21:28Z with `Browser
session init failed after 5 transient-proxy retries: {"error":"Browser state
injection timed out after 18000ms"}`. Render logs for every google.com init
that day: localStorage 4.4–6.8 s (28–38 origins), then IndexedDB 9.7–13.5 s for
`rawBytes=79151599` in 93–94 scripts (`cdpWaitMs` 6.5–10.3 s). Successful
attempts finished at 15.9–17.0 s; the rest hit 18 s. The blob is
`https://drive.google.com` → `ODPMC` `modules`/`cssModules`: 76 MB of Drive's
cached JS/CSS code (25.9k records), 19.9 MB stored. Prod's only rows over
2.3 MB raw are three Drive caches (79, 79, 37 MB); the next largest is mail at
1.3 MB stored. A start URL of `admin.google.com` restored all of it because
selection is realm-wide.

Why earlier fixes did not hold: each one sped up or bounded the transport of
this blob (codec, packet sizing, target replay, completion packet, 18 s
headroom) without bounding how much is restored. The memory blackbox that owns
it transfers 78.6 MB under `BROWSER_STATE_INJECTION_TIMEOUT_MS=60000`, so no
gate measured feasibility under the production budget.

Local repro, real production path: `initSession` against a real Kernel browser
(SF residential proxy) for a local user seeded with this realm's prod shape
(real origin keys and sizes, synthetic values, 78.6 MB synthetic Drive row).
Unchanged main failed 3/3 with `BrowserStateInjectionTimeout: Browser state
injection timed out after 18000ms` (localStorage 13.1–13.4 s for 39 keys from
the dev box, about 2× Render's per-origin latency; IndexedDB reached 12–16 MB).
With the byte bound only, the dev box still failed 3/3 because of that
localStorage latency. Projection from Render's measured phases: 6.3 s + 1.0 s
non-Drive IndexedDB + 0.9 s cache ≈ 8.3 s. With the localStorage key handling
from 2026-10-12-mac-localstorage-reader-dropped-storage-key-first-byte, the
dev box passed 3/3 at 12.4–13.5 s.

Fix: restoration uses an 8 MiB serialized-payload ceiling
(`BROWSER_STATE_ORIGIN_PAYLOAD_MAX_BYTES`) after a conservative stored-size
prefilter. This is not an escaped CDP wire-byte ceiling. The existing staging statement
first compares the O(1) `pg_column_size` against the budget, so an oversized
row is never serialized, then checks the exact staged byte length. There is no
extra round trip. Skips log table and byte counts at warn, with no origin
because origins are browsing history; restored counts stay truthful.
Permanent regression: `verifyRealmRestoreBudget` in
`browser-origin-payload.blackbox.ts`. The old source failed it with
`over-budget origin reached the browser: 27404739 bytes`. The memory blackbox
raises both bounds explicitly to keep its large-transfer assertions.

Residual, by adversarial review:
1. The bound is per origin, so many sub-budget origins can still sum past the
   phase, and realm-wide selection stays the next-deeper class. The next fix
   is start-origin-first priority with a cumulative budget.
2. Skipping a whole origin also drops any small database next to its cache.
3. The Mac app still uploads the cache on every sync.
4. The worker classifies every init 5xx, including this deterministic
   timeout, as a "transient-proxy" retry.
5. The regression asserts the mechanism with an instant fake browser; only the
   scratch real-Kernel repro measures the 18 s outcome.
6. The original live OOM allocation is still unattributed.

### October 12 Codex continuation verification

The preservation checkpoint is `8a2c8981701511d4ee8b933ffd1b48af5b18d39f`;
the durable resume receipt is committed in `3f5eac4db`. All 22 archived source
originals and all five private artifacts matched their recorded SHA256 hashes.
The two owning domains passed again through separate canonical
`bash scripts/run-blackbox-tests.sh <domain>` invocations against the explicitly
local isolated `victoria_cloud-452e0019` database.

Read-only adversarial review reconciled the preserved final `+fix-v2` variant
against its `a040520d5` baseline. Its two production files are byte-identical to
the continuation's owning code: `injectionOriginPayload.ts` SHA256
`f5773e5def892645835d4057cc4e5afff10e2f6291a4fc04ee635165b6f9fff0` and
`injectionState.ts` SHA256
`6d229793a7fd8058a92a9ff0c473eb5f7d23e7b356baaa8a9d8536add5b3385b`.
The existing RED/GREEN Kernel receipts therefore exercise the final owning
implementation. They reproduce the init boundary with representative adverse
origin shapes and synthetic values, not byte-exact production credential inputs
or completion of the original user's task. No additional paid Kernel run was
needed merely to establish this source correspondence. Production resolution
still requires rollout verification; September's original OOM attribution and
fleet acceptance remain open.

The stored-size prefilter examines the full CacheStorage column before its
names-only projection. Current Mac ingestion stores names only; no observed
production failure from an enriched large cache row is established. Many
sub-budget origins can still exhaust the phase, and fewer bounded transfers
are an improvement at 10,000 agents, not a measured capacity guarantee.

### Golden-reference comparison for the October 12 fix

Searched all four available reference trees for browser storage-state APIs,
LocalStorage/IndexedDB, retained init scripts, profile snapshots/persistence,
opaque JSONB/chunk transfer and duplicate-origin reconciliation.
`hermes-agent/hermes_cli/browser_connect.py:355` excludes large cache and
replay-prone IndexedDB state from profile snapshots; its copy operation applies
that policy at line 691. Rose converges on reducing restore volume while
retaining smaller IndexedDB origins, rather than excluding the storage class.
`openclaw/extensions/browser/src/browser/chrome.ts:716` chooses persistent
per-profile storage, and `pw-tools-core.storage.ts:151` mutates individual keys
through the targeted page. That matches document-scoped mutation but avoids
Rose's SQL-to-CDP transfer boundary.

`claude-code-src/src/utils/claudeInChrome/mcpServer.ts:253` delegates browser
implementation to the external Chrome MCP server.
`codex/codex-rs/config/src/browser_use.rs:9` defines origin-access policy rather
than restoration. No complete opaque-origin transport, byte-budget or
oldest-first duplicate reconciliation analog was found in these trees; Rose's
owning regression tests supply that proof. Reference files were read only.

## Human feedback

The user required completing the infrastructure repair and ten consecutive
width-ten fleet slices autonomously, preserving genuine evaluation and strict
live-query/teardown proof. A failed slice earns no credit after recovery. The
user explicitly instructed that the separate cybersecurity issue must not become
a prerequisite and that synthetic memory evidence must not be reported as
resolution of the original live OOM.
On October 1 the user approved approximately 20% longer infrastructure timeouts
and explicitly excluded harness timeouts from that authorization.

## Reusable lesson

Keep opaque browser-origin blobs out of the ORM object codec and bound their escaped transport while preserving scope, revision and complete assembly.
