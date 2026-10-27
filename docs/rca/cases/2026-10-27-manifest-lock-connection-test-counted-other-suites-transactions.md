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
tags:
  - trace-archive
  - flaky-test
  - coverage
  - postgres
sources:
  - task User Scale Bug Bash lane S14 /deploy (parent thread thr_1981ff79aa724ae59870f1829121c7e1)
  - PR #1586
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
