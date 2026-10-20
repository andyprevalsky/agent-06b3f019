---
id: 2026-10-19-operator-capacity-snapshot-single-shot-inventory-read
date: 2026-10-19
title: One slow flyctl apps list aborted a sharded launch before allocation and left its experiment UNRECORDED
surface: infra
component: original600-sharded-operator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-original600-controller.py capacity_snapshot — single-shot read-only `flyctl apps list --org <org> --json` (20 s timeout, no retry) inside the 110 s admission I/O alarm; sharded_run recorded the ledger launch but had no end path for a pre-allocation exception
symptoms:
  - "subprocess.TimeoutExpired: Command '['flyctl', 'apps', 'list', '--org', 'personal', '--json']' timed out after 20 seconds"
  - sharded operator --run exits LIVE_EXIT=1 right after SHARDED_ADMISSION_STARTED with no capacity-proof.private.json
  - scorecard shows the launch as an UNRECORDED experiment (END UNRECORDED) with only admission-intent.private.json in the admission directory
tags:
  - cloudbench
  - original600
  - sharded-operator
  - capacity
  - experiments-ledger
  - scorecard
sources:
  - PR #1542
  - benchmark run original600-1792433714160918322 (launch attempt 1, 2026-10-19T18:15:14Z → 18:15:34Z)
repro: scripts/tests/original600-portable-operator.test.py (test_transient_app_inventory_timeout_is_retried_and_persistent_failure_fails_closed, test_preallocation_abort_ends_the_ledger_entry_and_admission_as_aborted)
status: fixed
---

## Problem

Launch attempt 1 of a 4-task × 9 sharded live proof (source f9c01f05c) printed
`SHARDED_ADMISSION_STARTED` at 18:15:14Z, appended the experiments-ledger
`launch` line (`triggered_at` 1792433714.16, goal `4-tasks`), then died at
18:15:34Z with `subprocess.TimeoutExpired` from `capacity_snapshot`'s
`flyctl apps list --org personal --json` (exactly the 20 s timeout). No Machine
was allocated: the admission directory holds only `admission-intent.private.json`.
The ledger has no `end` line for that id, so every later scorecard renders it as
an UNRECORDED experiment. Attempt 2 (same inputs, 18:16Z) passed the same read.

## Diagnosis

Critical path: `sharded_run` → `open_admission` → ledger `launch` →
`runner['bounded'](110)` → `capacity_snapshot` → GraphQL org settings (20 s) →
`flyctl apps list` (20 s, `check=True`, no retry) → per-app Machine reads.

1. First bad: the app-list read is read-only and idempotent, yet one transient
   slow call was terminal. The 110 s alarm had ~90 s left when it failed.
2. Why possible: both control-plane inventory reads in `capacity_snapshot`
   (GraphQL settings and the app list) were single-shot; no shared retry rule
   for read-only inventory existed in the operator. The sibling GraphQL read has
   the same failure mode (TimeoutError/5xx).
3. Why UNRECORDED: `sharded_run` appends `launch` before any provider read, but
   only reaches `ledger['record']('end', ...)` after `coordinate()` returns. Any
   exception in between (capacity read, insufficient capacity, prepare refusal)
   left an open launch. The scorecard's `load()` also had no artifact for this
   case and fell to `UNRECORDED` even when a ledger end exists.

Proof: before the fix, the new regression tests on origin/main 7441b41f4
raise the identical `TimeoutExpired: Command '['flyctl', 'apps', 'list',
'--org', 'personal', '--json']' timed out after 20 seconds` on one slow read,
and the ledger holds `['launch']` only. After the fix both pass.

RCA archive searches: "flyctl apps list timed out after 20 seconds
capacity_snapshot" and "transient provider read operator launch aborted before
allocation UNRECORDED ledger". Relatives, not recurrences:
2026-10-06-live-inventory-freshness-miss-aborted-autoscaler,
2026-10-18-final-worker-probe-conflated-ssh-transport-with-worker-death.

Outcome-gate note: this is an operator admission failure before any task ran,
so `scripts/run-bench --local <task>` cannot exercise it; the failing boundary
is reproduced directly in the owning operator suite.

## Solution

`retried_read` gives both control-plane inventory reads in `capacity_snapshot`
(GraphQL settings, flyctl app list) up to 3 attempts (pauses 2 s, 5 s) on
errors that can heal: TimeoutExpired, non-zero flyctl exit, socket/OS errors,
HTTP 429/5xx. Malformed or out-of-scope inventory, HTTP 4xx, a missing flyctl
binary, an untrusted certificate and the caller's `Deadline` (a BaseException
from the existing 110 s alarm) refuse at once. Retries run only while that alarm
allows: one slow call plus its retry fits comfortably, but the worst case
(3×20 s + 3×20 s + 7 s) exceeds 110 s, and then the alarm ends the read —
persistent failure stays fail-closed and no retry outlives the deadline. Every
capacity_snapshot caller (sharded admission, shard respawn, prepare,
continuation) inherits it.

`sharded_run` wraps everything between the ledger `launch` and `coordinate()`
(nothing allocated yet); on any exception `preallocation_abort` writes
`preallocation-abort.json` (ended_at, reason, allocated=false) and a ledger
`end` with state ABORTED, then re-raises. The scorecard loads that receipt as
ABORTED with its real end time. Nothing in the wrapped region allocates a
Machine: `prepare()` writes local configs, `publish_shard_group` writes only the
Hub, and `spawn`/`respawn` run inside `coordinate()`, outside the wrapper.

Open: the per-app `/machines` reads are still one attempt each (retrying N reads
would consume the alarm); an exception from `coordinate()` or later still leaves
a post-allocation launch without a ledger end; whether a second `flyctl apps
list` would have succeeded at 18:15Z is inferred (attempt 2 passed a minute
later), not observed. 10k-agent behaviour: unchanged — at most two
extra read-only control-plane calls per admission, none per agent.

## Human feedback

Parent requested bounded retries inside the existing deadline, fail-closed on
persistent failure, and a proper ledger end for an aborted pre-allocation launch.

## Reusable lesson

Retry read-only provider inventory reads boundedly inside the caller's deadline, and close every ledger launch on every pre-allocation exit path.
