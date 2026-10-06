---
id: 2026-10-06-hub-final-upload-starved-by-queued-live-snapshots
date: 2026-10-06
title: A final Hub upload waited behind every queued live snapshot at the serial index writer
surface: back-end
component: benchmark-hub-store
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/src/providers/benchmarkHubStore.ts::withIndexLock admitted a one-shot final putRun in strict FIFO order behind superseded live snapshots"
symptoms:
  - "benchmark Hub upload attempt 1/4 failed transiently; retrying in 1s: The read operation timed out"
  - "durable hub mirror failed: benchmark Hub upload failed: The read operation timed out"
  - "Benchmark command did not print a result file marker (exit 1)"
tags:
  - benchmark-hub
  - admission
  - starvation
  - advisory-lock
  - durable-mirror
sources:
  - PR #1416
  - benchmark run 1b963a23-fcaa-42c3-b0e2-cf258cedad51
repro: back-end/src/tests/blackbox/benchmark-hub-index-read.blackbox.ts
status: open
---

## Problem

The `/deploy` Step 6a AgentCard lifecycle gate for PR #1416 passed all four
tasks in run `1b963a23-fcaa-42c3-b0e2-cf258cedad51`
(`agent-payment-test-shop`, `-setup-resume`, `-idempotent-aba`,
`-abandonment`), then exited 1. Its required durable mirror POST to the
production Hub hit four client response-read timeouts (`30 s + payload/512 KB`
each) and raised `HubVisibilityError`, so no result-file marker was printed.
Earlier POSTs from the same run had returned 201 in 2.4–5.4 seconds.

Production stored that exact final bundle (`live:false`) at
`2026-10-06T08:36:40.873Z`, roughly 188 seconds after the first attempt and
after the client had abandoned it. The three retries were stored at
`08:37:36.588Z`, `08:37:38.803Z` and `08:37:41.364Z`. A later production GET of
the run returned 200. The safe receipts are kept in
`.context/hub-final-starvation-rca/` (`run-store-and-requests.safe.json` and
`store-census.safe.json`).

## Diagnosis

Critical path: the client POSTs `/api/benchmarks/runs`, `putRun` enters
`withIndexLock`, process admission runs, then the PostgreSQL advisory
transaction lock. The holder then does about seven R2 reads and writes (index,
compact agent index and revision, bundle, visibility) and returns 201.

The bounded Render census for `08:30–08:38Z` (two complete pages) shows 127
stores: 123 live snapshots from 50 distinct runs, at 16–24 stores per minute.
The only final stores in that window were this run's four. The single global
writer was saturated. After the 2026-10-05 repair, admission was strict FIFO, so
the final upload queued behind every snapshot already waiting. At about 2.5
seconds per store, its wait exceeded every response window the client allows.

The snapshots are superseded by each run's next snapshot. The final upload is
one-shot and absorbing, and the mirror requires it. Giving them equal priority
let the replaceable stream starve the irreplaceable write.

Archive search found
`2026-10-05-hub-index-lock-waiters-starved-sql-pool`. That case moved waiters
ahead of SQL connection borrowing and explicitly kept the serial writer's
throughput limit. This failure is the next layer of the same boundary, not a
recurrence of its pool exhaustion: no SQL cancellation or pool timeout appears
here, and every request was eventually stored. The 2026-09-10
ambiguous-commit case concerned replay before reconciliation; here the client
never saw a response. No other branch carried a priority repair.

## Solution

`withIndexLock` now keeps two waiter classes. Foreground work (final
`putRun`, `deleteRun`, index reads, backfill) is admitted before queued live
snapshots. Each admission still holds at most one SQL connection and the same
cross-process advisory lock. Rejected work still hands admission to the next
waiter. The transaction text and bounds, the R2 write order, final absorption
and the revision floor are unchanged, and the structural transaction-policy
fingerprint still matches. To stay under the `max-lines` cap, the read-only
run-detail projection moved unchanged to `benchmarkHubRunDetail.ts`.

Reproduction:
- The permanent blackbox drives the real `putRun` against in-memory R2 and the
  local PostgreSQL lock. A held snapshot blocks while two snapshots and then a
  final upload queue behind it.
- On the original store, it wrote `holder, snapshot-a, snapshot-b, final`
  (exit 1).
- On the repaired store, it writes `holder, final, snapshot-a, snapshot-b`, and
  the published index shows the final `live:false` (exit 0). The other five
  controls in that blackbox pass unchanged.
- The extracted-owner unit suite adds a priority control and passes 5/5.
- The structural suite passes 1,384 checks.

At 10,000 agents, each backend process still uses one SQL connection here,
plus one queued closure per waiting request, and processes coordinate through
the same PostgreSQL lock. A final upload now waits for at most the current
holder plus queued foreground work, not the whole snapshot backlog. Live
snapshot latency still grows with fleet width, because a single global R2
writer is a throughput ceiling. Sharding the index by run would remove that
ceiling; it is not part of this repair.

This case stays open until production runs the repaired store and a fresh
saturated-fleet final upload completes within its client window.

## Human feedback

The user asked for the full `/deploy` after the messaging-mock change. That
requires every Group 4 gate to pass on the merged tree, including the durable
evidence mirror. Benchmark tasks, client timeouts and retry counts were left
unchanged.

## Reusable lesson

When one serialized writer serves both a superseded stream and one-shot
terminal writes, admit the terminal writes first; FIFO lets the replaceable
stream starve the write that cannot be replaced.
