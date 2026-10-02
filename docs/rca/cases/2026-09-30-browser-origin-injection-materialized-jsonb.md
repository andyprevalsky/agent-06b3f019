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
