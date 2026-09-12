---
id: 2026-09-12-unlocked-hub-index-read-observed-partial-publication
date: 2026-09-12
title: Unlocked Hub index reads observed an in-flight multi-object publication
surface: back-end
component: benchmark-hub-resolution
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: benchmarkHubStore.readAgentRunIndexStrict read the compact index and durable revision floor outside the Postgres publication lock held by every writer
symptoms:
  - 'DELETE /:id — read-after-write: deleted agent → 404 on GET: Expected status 404, got 503'
  - Benchmark Hub archive index is temporarily unavailable; retry shortly
  - Benchmark Hub agent-run index trails its durable revision floor
  - Persistent failure retried shared storage for every agent request
tags:
  - benchmark-hub
  - snapshot-consistency
  - concurrent-publication
  - retry-amplification
sources:
  - PR #1299
  - commit 5efdd5db0c3fbe00107ebcc7bc3c9993a7466387
  - agent 546f71d7-75e6-45aa-9673-031beb33cbfe
repro: back-end/src/tests/blackbox/benchmark-hub-index-read.blackbox.ts
status: open
---

## Problem

A fresh combined backend coverage/blackbox gate passed 163 of 164 domains but
failed the agents DELETE read-after-write assertion. Root
`546f71d7-75e6-45aa-9673-031beb33cbfe` was deleted successfully at
`2026-09-12T07:08:49.908Z` (HTTP 204). Its following GET began at `.909Z`, logged
`Benchmark Hub agent-run index trails its durable revision floor` at `.914Z`,
and returned HTTP 503 at `.915Z`. An unrelated Hub upload completed at `.921Z`.
The exact test requires HTTP 404 for the deleted, non-Hub agent.

## Diagnosis

Critical path: DELETE commits the local soft deletion → GET live row query
excludes deleted rows → authorized archive fallback → coalesced compact-index
load → independent index/floor object reads → strict revision validation → 503.

The writer serializes upload/delete/backfill with the existing Postgres
transaction advisory lock. It deliberately publishes the durable revision floor
before the compact index, so a failed second write cannot roll revision recovery
back below an already-observed version. The public reader used neither that
lock nor another consistent-snapshot protocol. It could therefore read floor 2
with index 1 during a successful publication. The floor check correctly rejected
that incomplete snapshot; the missing reader synchronization caused ordinary
concurrent publication to look like a durable failure.

The smallest reproduction runs the real `putRun` and public compact reader
against real Postgres. Only the external object-store adapter is replaced. A
barrier pauses the writer after its floor write while its transaction lock is
still held. Before the fix, the reader settled immediately with the same
trails-floor error instead of waiting for publication. The test also preserves
a failed second write: readers must still reject the durable mismatch after the
writer exits. No HTTP status, parser, write ordering, or archive fallback is
weakened.

An additional reproduction found 22 object reads for 100 concurrent requests
followed by ten sequential requests during a persistent read failure. Active
loads coalesced, but only successful loads set freshness; each later request
could immediately retry. Adding a database lock without bounding this path
would move the same request amplification into Postgres.

Archive searches used the literal deleted-agent/404 failure and the behavioral
`read after write delete cache stale` terms, then the literal Hub error and
revision-floor terms. This is a relative of
`2026-09-06-background-hub-child-index-sync-io-starved-backend`, whose first bad
boundary was synchronous full-archive scanning. Its compact-index design and
strict floor recovery remain valid; the current defect is the unsynchronized
read half of that publication contract. Local branch history contained no later
reader repair. Independent RCA review agreed with that distinction.

## Solution

The permanent blackbox was run on the buggy revision and failed all five
controls, then passed all five unchanged after the repair. The exact command
was `cd back-end && node --import tsx
src/tests/blackbox/benchmark-hub-index-read.blackbox.ts`, with both Prisma URLs
set to the owned workspace Postgres database. Logs are retained under
`.context/acceptance/hub-index-read-race/permanent-before.log` (exit 1) and
`permanent-after.log` (exit 0). The full backend HTTP outcome gate remains
pending; this case stays open until it passes.

The repair unifies the public compact snapshot read with the existing
writer lock and preserves the strict floor/index checks. Cache only non-ready
load results for the existing five-second refresh interval, coalesce concurrent
loads, and clear the cooldown after recovery. Include error, legacy, and stale
results so persistent failure cannot produce one shared storage/lock attempt
per incoming agent request.

At 10,000 agents, warm misses remain O(1) Map/Set lookups without a Postgres
lock. Compact loads coalesce per backend process; failed attempts have a
five-second cooldown. Compact parsing is proportional to index size once per
refresh, as before. A cold reader can queue behind a rare locked archive repair
up to the existing five-minute transaction backstop; Prisma's 30-second
transaction admission setting is not a 30-second advisory-lock wait bound.
No timeout changes are part of this repair.

The permanent store blackbox belongs to the backend runner discovered by
`npm run test:coverage`. Required post-fix outcome evidence includes the
unchanged agents DELETE assertion and Hub root/child/sentinel transcript tests.
The cloud ten-slice acceptance remains a separate pending validation.

## Human feedback

The user directed continued autonomous completion, retained a normal 120-minute
root backstop, and authorized only a temporary five-minute bound for the cloud
proof. No benchmark definition, deadline, or assertion changes were authorized
for this backend defect.

## Reusable lesson

Read a multi-object snapshot inside its writer's consistency boundary and bound failed refresh attempts independently of request volume.
