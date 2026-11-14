---
id: 2026-11-14-launch-preflight-single-shot-fly-read-timeout
date: 2026-11-14
title: One slow flyctl secrets list (20 s, no retry) aborted a cloud benchmark launch before any Machine started
surface: infra
component: run-bench-cloud-launch-preflight
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud verify_app_environment — single-shot read-only `_with_timeout 20 flyctl secrets list -a $APP --json`; its timeout (exit 124) was terminal for run-bench-fleet verify_fleet_environment; same-class sibling scripts/lib/cloudbench-inventory.sh start_machines_snapshot_loop first refresh (fly_with_timeout 30 machines/volumes list, once, timeout 142 aborts via start_admitted_machines_snapshot_loop)
symptoms:
  - "❌ Could not read app secrets for navi-whisper-lux-bench (read exit=124)."
  - "❌ Cloud benchmark environment is not ready; no benchmark machine was started."
  - "❌ shared inventory snapshot did not initialize"
  - "❌ post-admission inventory authority unavailable (status=1); refusing provisioning"
tags:
  - cloudbench
  - run-bench
  - fleet
  - preflight
  - flyctl
  - retry
sources:
  - fleet run 20261114-180643-303337 (devbox 2b4e64bd, main 60d5ca599f, 2026-11-14T18:06Z)
  - hub run 20261114-180643-303337 (found by repair thread thr_717118a13d76431a95869b1abba1577b, Gate NOT_INTRODUCED)
  - commit 525d655381
repro: scripts/tests/cloudbench-campaign-env.test.py (test_actual_verifier_retries_one_slow_read_then_verifies, test_actual_verifier_persistent_timeout_fails_after_three_reads, test_actual_verifier_missing_secret_after_slow_read_fails_loud, test_actual_verifier_retains_native_failure_status_and_stderr); scripts/tests/cloudbench-inventory-site-startup.test.py (test_snapshot_init_retries_one_slow_read_then_publishes, test_snapshot_init_persistent_timeout_and_other_failures_refuse)
status: fixed
---

## Problem

`scripts/run-bench browser-biometrics-webdecoy --wait` on main 60d5ca599f at
2026-11-14T18:06Z exited 1 before any Machine started:
`❌ Could not read app secrets for navi-whisper-lux-bench (read exit=124).` then
`❌ Cloud benchmark environment is not ready; no benchmark machine was started.`
Exit 124 is `_with_timeout`'s timeout status: the 20 s read never returned.
Four immediate re-reads from the same devbox and token succeeded in 2.5–4.5 s,
so one slow Fly API read was enough to abort the whole launch.

## Diagnosis

Critical path: `run-bench` → `run-bench-fleet` → `verify_fleet_environment` →
`bash run-bench-cloud --verify-secrets` → `verify_app_environment` →
`_with_timeout 20 flyctl secrets list` (once) → `return 1` → fleet `exit 1`.

1. First bad: the secrets listing is read-only and idempotent, but one timed-out
   attempt was terminal. Nothing downstream retries it (the campaign verifier
   shares a single result, and the plain path runs it once).
2. Why possible: the launch path has no shared policy for read-only Fly reads.
   The 2026-10-19 relative fixed the same class only inside the Python sharded
   operator (`retried_read`); the bash launchers kept single-shot reads.
3. Same-class sweep of the default single-task path before allocation:
   `start_machines_snapshot_loop`'s first `refresh_inventory_snapshot` runs
   `fly_with_timeout 30 machines list` and `volumes list` once. A timeout
   (status 142) returns 1, and outside a campaign
   `start_admitted_machines_snapshot_loop` refuses provisioning. That is the same
   class. The steady-state `machines_snapshot_loop` already backs off and retries.

Proof: before the fix, on main's code, the new slow-then-fast case prints the
production string `Could not read app secrets for fixture (read exit=124).` and
exits 1. The snapshot-init case prints `shared inventory snapshot did not
initialize` after one read. After the fix, both pass, and the negative controls
still pass.

RCA archive searches: "Could not read app secrets read exit=124
verify_app_environment" and "single-shot read-only flyctl preflight timeout no
retry aborts launch". Relative, not a recurrence:
2026-10-19-operator-capacity-snapshot-single-shot-inventory-read (same class,
different component; its Solution pattern is reused here).

Outcome-gate note: this is a launcher preflight failure before any task ran, so
the failing boundary is reproduced directly in the owning launcher suites. The
original command was rerun on the cloud fleet with the fix.

## Solution

Both sites now retry only a timeout (`_with_timeout` 124, `fly_with_timeout`
142), with at most 3 attempts and pauses of 2 s and 5 s, matching the
2026-10-19 policy. Each retry prints a `⚠️ … timed out (attempt N/3)` line. Any
other native failure fails at once with its original status and stderr: auth,
a missing app, an interrupt (128+n), or an empty listing. A listing that is
missing required secrets still fails with `missing secrets:`. Persistent
timeouts still fail closed after the third read. Worst-case added latency is
2×20 s + 7 s for secrets and 2×60 s + 7 s for the inventory init. Both are
bounded, and the campaign verifier's `--deadline` still kills the verifier if
its original deadline expires first. `_refresh_inventory_snapshot_unlocked`
records the failing read's status in `INVENTORY_REFRESH_READ_STATUS` without
changing its return codes for other callers.

Both owning suites are now registered as `/deploy` structural gates
(`cloudbench-campaign-env`, `cloudbench-inventory-site-startup`). Before this,
neither ran in any `/deploy` lane.

Not changed (different class, recorded): `FLY machines list` and
`volumes list` at run-bench-fleet warm-source lookup, warm volume lookup, the
stale-fleet capacity refresh and `admit_app_capacity_with_wait`. They have no
timeout, so a slow read waits instead of aborting. Only a transient non-zero
flyctl exit aborts them, and telling a transient exit from an auth error would
need stderr classification. There are also timeout-only siblings on non-default
paths: `validate_private_fleet_source` (needs `CLOUDBENCH_SOURCE_MANIFEST`) and
`cloudbench-worker-snapshot.py ensure` (needs a non-empty pool ids file). Both
remain open.

10k-agent behavior: unchanged. At most four extra read-only control-plane
calls per launch occur, and only after a timeout. There is no per-agent or
per-task work.

## Human feedback

The repair `/goal` asked for this: bounded retry or a deadline for read-only Fly
reads, keep failing loudly on real missing secrets and auth errors, no fallback
that skips the check, no changes to tasks, timeouts or concurrency, and extend
`cloudbench-campaign-env.test.py` with a slow-then-fast case.

## Reusable lesson

Every read-only provider read that can abort a launch gets the same bounded timeout-only retry; register the owning test in a /deploy lane in the same change.
