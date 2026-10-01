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
transaction pins one pool connection during CDP awaits for at most its 15-second
bound and uses temporary PostgreSQL disk proportional to payload bytes. Real
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
backend coverage run. That run still failed its separate live Kernel parity
check, which is being investigated independently. This scheduling evidence does
not establish the original live OOM's allocation source.

## Human feedback

The user required completing the infrastructure repair and ten consecutive
width-ten fleet slices autonomously, preserving genuine evaluation and strict
live-query/teardown proof. A failed slice earns no credit after recovery. The
user explicitly instructed that the separate cybersecurity issue must not become
a prerequisite and that synthetic memory evidence must not be reported as
resolution of the original live OOM.

## Reusable lesson

Keep opaque browser-origin blobs out of the ORM object codec and bound their escaped transport while preserving scope, revision and complete assembly.
