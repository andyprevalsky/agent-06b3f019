---
id: 2026-10-27-manifest-lock-connection-test-counted-other-suites-transactions
date: 2026-10-27
title: Manifest-lock connection test counted other coverage domains' idle transactions
surface: back-end
component: trace-archive-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/tests/blackbox/archive-run-cost.helper.ts heldInTransaction matched every idle-in-transaction backend in the shared coverage database, not the manifest lease's connection
symptoms:
  - "manifest lock held a pooled connection in an open transaction during storage I/O"
  - archive domain fails only in the full backend coverage run
  - "FAIL manifest lock holds no connection during storage I/O -- observer must detect an old owned transaction (28ms)"
  - "observer missed 46 of 200 old owned transactions"
tags:
  - trace-archive
  - flaky-test
  - coverage
  - postgres
  - clock-resolution
  - pg-stat-activity
sources:
  - task User Scale Bug Bash lane S14 /deploy (parent thread thr_1981ff79aa724ae59870f1829121c7e1)
  - PR #1586
  - PR #1751 deploy attempt 2 backend-coverage-blackbox (Blacksmith VM, shard 1, 2026-11-07T06:03:57Z)
  - commit 5aa624b5a1 (failing regression) and commit 7c3909df6d (fix) on branch rca/archive-manifest-lock-observer
repro: back-end/src/tests/blackbox/archive-run-cost.helper.ts
status: fixed
---

## Problem

During the S14 `/deploy` backend coverage run, the `archive` domain failed. The
failing test was "manifest lock holds no connection during storage I/O", which
reported 7 pids idle in transaction. The same domain passed 5/5 when run alone.

## Diagnosis

The test looked for any backend in `current_database()` that stayed idle in
transaction across its 1.2 s window. The coverage run executes four domains
concurrently against that one database, and also overlapped agents coverage. Any
other suite's interactive transaction therefore read as the manifest lock's
connection.

Local repro on `victoria_s14`, using two sessions:
- an unrelated `BEGIN; SELECT 1` held idle;
- a transaction touching `"TraceArchiveManifestLease"`.

The old predicate counted 2 backends. The scoped predicate counts 1, the lease
one. So it still catches the regression it guards (the lock holding a pooled
connection in a transaction) and ignores other suites.

## Solution

`heldInTransaction` now counts only idle-in-transaction backends that hold a
lock on `TraceArchiveManifestLease` or whose last statement touched it. The
assertion is unchanged. The `archive` domain passed 5/5 after the change.

10k-agent behaviour: test-only. There is no runtime change.

## Human feedback

None recorded.

## Reusable lesson

A pg_stat_activity assertion in a shared-database suite must identify the connection under test (its locks or statements), never every backend in the database.

## Recurrence 2026-11-07: the observer's positive control compared JS time with microsecond `xact_start`

The 2026-10-27 fix scoped the observer to the right connections but kept
`heldInTransaction(new Date())`. The positive control (an owned transaction
that the observer must find) then failed once in the PR #1751 deploy's
`backend-coverage-blackbox` gate on a Blacksmith VM: 249 of 250 cases passed
and the `archive` domain reported `FAIL manifest lock holds no connection
during storage I/O -- observer must detect an old owned transaction (28ms)`.
The original message carried no values, so that run cannot say what the
observer returned.

First-bad boundary: `xact_start <= ${since}` in `heldInTransaction`.
`pg_stat_activity.xact_start` has microsecond resolution; a JS `Date` has
millisecond resolution and truncates. A transaction that began in the same
millisecond that `new Date()` reads has `xact_start` greater than `since`, so
the observer returns nothing and the control fails.

Evidence (all against local PostgreSQL 16, the same apt install the CI setup
script provisions, Etc/UTC, node and PostgreSQL on one host):
- Scratch probe, 1,000 positive controls per run on a warm connection, run
  twice: JS `new Date()` missed 335 and 313. The same transactions with
  `since + 1 ms` missed 0 and 0; with `clock_timestamp()::text` from the
  database missed 0 and 0. Only the clock source changed.
- Every one of the 648 JS-clock misses had `xact_start - since` between 1 us
  and 610 us (always positive, always under 1 ms), and every missed backend
  was `idle in transaction` with the expected `application_name`. State,
  owner stamping, privilege and visibility are therefore not the cause; a
  timezone or host clock skew would give offsets of hours or a mix of signs.
- The first transaction in a fresh process is slow (BEGIN plus
  `pg_backend_pid()` took 3.6 to 18 ms, 0 misses in 40 fresh processes), so
  the case does not fail on a cold local run. The unmodified domain passed
  7 of 7 runs. The miss needs sub-millisecond round trips, which a warm
  connection on a fast CI host provides.
- The CI log corroborates that position: in `archive.log` the case's three
  `$queryRaw` calls logged `duration_ms` 1, 0 and 2, and the owned
  transaction's `pg_backend_pid()` query ended in the same millisecond
  (`06:03:57.299`) as the query before it. This is corroboration, not a
  recovered value: the CI assertion did not print `since` or the rows.
- Archive cases run sequentially in one process (`for ... await runTest`), and
  the observer filters by `application_name`, so concurrent cases and other
  domains (domainConcurrency=4) cannot hide the owned backend.

Repro through the owning runner (`BLACKBOX_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_<worktree> CONDUCTOR_WORKSPACE_NAME=<worktree> ROSE_USE_SYSTEM_PG=true bash back-end/scripts/run-blackbox-tests.sh archive`):
the new case `owned-transaction observer never misses an old transaction`
(200 positive controls) failed on commit 5aa624b5a1 with `observer missed 46
of 200 old owned transactions`, exit 1, while the original manifest-lock case
passed on the same run.

Fix (commit 7c3909df6d): every instant the observer compares comes from the
database clock as text, `SELECT clock_timestamp()::text`, bound as
`${since}::timestamptz`. Text keeps the microseconds that a Date, or a Date
returned by Prisma, drops, and both sides of the comparison now come from one
clock. The 600 ms waits, the zero-pinned-owned-transactions assertion and the
foreign-owner control are unchanged. A mutation check (an owned transaction
held across the lock's storage-I/O window) still fails the manifest-lock case
with `manifest lock held a pooled connection in an open transaction during
storage I/O`. The failure message now includes the owned pid, `since`, the
owner and the rows the observer returned. After the fix: 5 of 5 consecutive
`archive` runs passed, plus 3 of 3 under 16 CPU burners at load average 17 on
8 CPUs. Branch only; not merged.

Why the earlier fix did not hold: it fixed which backends the observer looks
at, but never exercised the observer's own detection path more than once, and
mixed two clocks of different resolution. The regression case now repeats the
positive control so a resolution error is a deterministic failure, not a
1-in-N CI flake.

Attribution: `Gate: NOT_INTRODUCED`. The helper, `run.ts`,
`archive.blackbox.ts`, `database.ts` and `traceArchiveManifest.ts` are
byte-identical between main 308315a4bc and the PR #1751 source 9997bca37f.
Main would fail identically under the same timing. The PR's Blacksmith
executor is only where a fast host first exposed an intermittent timing race.

