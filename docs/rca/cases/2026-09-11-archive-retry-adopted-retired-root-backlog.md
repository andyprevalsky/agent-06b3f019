---
id: 2026-09-11-archive-retry-adopted-retired-root-backlog
date: 2026-09-11
title: A successful current archive write adopted retired roots and exhausted the local backend pool
surface: cross
component: trace-archive-outbox
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/trace_archive.py _submit_archive_job called _drain_backend_outbox without its submitted root identity
symptoms:
  - "Transaction API error: Unable to start a transaction in the given time."
  - "mass-agent backend stops answering pause/status after the 300-second task ceiling"
  - "archive artifact requests for a retired root appear in a new isolated run"
tags:
  - trace-archive
  - ownership
  - outbox
  - connection-pool
  - advisory-lock
sources:
  - PR #1299
  - agent b5f8c575-1585-4098-807e-02a51517d670
  - agent 71b15f0f-6eca-4c35-b00c-77ecd2cfdd4d
repro: agents/tests/blackbox/trace_archive.blackbox.py
status: open
---

## Problem

The exact `test-mass-agent-run-0` capture rerun on September 11 started
successfully, then its backend stopped serving the workload and the
300-second pause request failed. The controller still reported running
at 385 seconds. Its exact PID and birth were verified before SIGINT at
13:14 UTC; canonical local teardown removed its workers, backend, database
container and volume. This is a failed interrupted run, not a pass or a
finished evidence bundle. The run ID is `d05c89bd-af63-4fe9-9d48-87816830a5dd`.

## Diagnosis

The first new cache replay and dump occurred at 13:07:47. Archive requests
started accumulating slow `$queryRaw` calls by 13:07:54, the archive queue
saturated at 13:08:30, and transaction-start failures began at 13:09:07.
The backend explicitly referenced the old finalized root `71b15f0f` at
13:08:39. Its 78 pending encrypted records were created at 12:47–12:48,
before the current run existed.

The request-ID join in `independent-mass-timeline.json` found 739 archive
lock queries with median 30,145 ms, p95 34,740 ms, and maximum 35,808 ms.
The 8,302 message lock queries had median 0 ms and p95 1 ms. Archive writes
for a finalized root enter manifest reconciliation, which holds a Prisma
transaction while acquiring a root advisory lock and reading/writing R2.
Many requests for the same retired root can therefore occupy the current
backend's connection pool while waiting. No live PostgreSQL wait graph was
captured, so this is not a claim to have observed every blocking connection.

The old mass run handled 5,211 archive posts without message errors; the new
run completed only 195 archive posts and had 1,937 message HTTP 500s. Raw
new dump volume alone is not a sufficient diagnosis. Each successful async
archive job called an unscoped shared-outbox drain. That operation could
submit any previous run's pending artifacts to the new isolated backend.
Its limit counts successful deletions, not attempts, so unrelated failing
records could also occupy an archive worker for many requests.

The permanent owning-boundary test creates actual encrypted pending files
for current and retired roots through failed external HTTP writes, then
successfully submits a new current-root artifact. Before the fix, the real
executor/drain posts the retired artifact as well. The assertion fails with
the exact extra root in `root-outbox-before-final.log`. Afterward the same
test passes: only the current backlog drains; the retired payload and
metadata remain byte-identical. Explicit recovery of the retired root still
works. Existing current-root failure/retry and bounded-terminal-flush tests
also pass in the complete trace_archive blackbox suite (4.6 seconds).

## Solution

Carry the submitted `safe_root` into the automatic outbox drain. A current
completion may retry its own root's backlog. Recovery of other roots remains
an explicit root-scoped operation. No database pool, transaction, provider,
recording, or task timeout is increased. At 10,000 agents this removes
cross-root work adoption without a new global lock or per-agent service.
The existing bounded archive executor and finalization deadline remain.

The unchanged 300-second rerun produced its canonical FAILED/PAUSED result
at 300.8 seconds, with 10,209 message posts (median 12 ms), zero transaction
errors, and zero references to the retired root. The pause endpoint returned
200 in 366 ms. All 156 retired encrypted-payload/metadata files retained
their hashes, and the exact database container and volume were absent after
cleanup. The canonical publisher verified the production FE (239 messages)
and the captured cache-replay dump. An initial nonfatal Hub upload SSL error
was followed by a successful canonical publication; it is not silently
counted as an initially successful upload.

The independent receipt is `root-scoped-mass-independent-verification.json`.
The capture and backend-availability outcomes are verified. The task itself
did not complete within the user-imposed five-minute ceiling; this case
remains open for normal-budget benchmark qualification and does not label
that FAILED result a pass. Evidence is under
`.context/acceptance/completion-dump-rca/` and the original run's logs under
`.context/benchmarks/1789132036-54964-33151/logs/`.

## Human feedback

The user requires no repeated permission requests, normal 120-minute task
backstops, and a temporary five-minute validation ceiling. The failed run
was stopped when that ceiling could not terminate work through its backend.
The next run has an independent monitor that interrupts after the existing
pause-request bound if no execution result appears. The ten sequential
cloud slices have not been claimed complete.

## Reusable lesson

A deferred retry inherits the initiating operation's ownership. A shared
outbox is storage for many owners, not authority to attach every owner's
recovery work to whichever backend happens to be alive next.
