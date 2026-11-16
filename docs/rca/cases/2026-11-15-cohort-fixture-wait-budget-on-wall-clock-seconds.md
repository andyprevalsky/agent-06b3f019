---
id: 2026-11-15-cohort-fixture-wait-budget-on-wall-clock-seconds
date: 2026-11-15
title: The cohort barrier fixture measured a 1-tick borrowed inventory wait on bash's whole-second wall clock, so it could expire microseconds after it started
surface: harness
component: cloudbench-cohort-reconcile
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/tests/cloudbench-cohort-reconcile.test.py:ReconciliationFixture.spawn (campaign) — ran refresh_machines_snapshot_after with CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS=1 on live bash SECONDS (floor(now) - floor(start)), so `deadline=$((SECONDS + 1))` could expire at the next wall-second boundary, before the fixture's immediate publication was observed"
symptoms:
  - "FAIL: test_campaign_noop_and_mutation_share_the_completed_barrier (__main__.CohortReconciliation.test_campaign_noop_and_mutation_share_the_completed_barrier) (mutated=True)"
  - "AssertionError: 1 != 0 :"
  - "❌ timed out waiting for a new healthy parent inventory generation"
  - "reconcile_stale_fleet_registries || exit 1"
  - "deploy-command-structural cloudbench-cohort-reconcile FLAKY"
tags:
  - cloudbench
  - bash-seconds
  - timestamp-resolution
  - controlled-clock
  - load-sensitive
  - flake
  - deploy-gate
sources:
  - PR #2258
  - commit 2d99b77abfd3ae2f23fbcb16e48ef9c3d41a702d
  - PR #2104
  - commit 31641a67091091fa3920a6049773281b827fd2aa
  - commit cf458ba660fa059c2378e7c545ce3275fe3646f2
repro: scripts/tests/cloudbench-cohort-reconcile.test.py
status: fixed
---

## Problem

During PR #2104's deploy, `deploy-command-structural` reported FLAKY occurrence
`b7248ac5873d434aa5320ab2bea17f4c` on source `34fa5830ed`:
`test_campaign_noop_and_mutation_share_the_completed_barrier (mutated=True)`
failed with `AssertionError: 1 != 0 :` and empty output on the first
`f.join(f.spawn(index))` loop, then passed its rerun. A load A/B on that deploy
counted 6 of 50 failing files on main and 2 of 50 on the PR head.

Local repro on origin/main `31641a6709`, using the original command
`python3 scripts/tests/cloudbench-cohort-reconcile.test.py` with 6 busy-loop CPU
hogs and 4 concurrent runs: 2 of 40 runs exited 1. Run 23 matched the
reported failure exactly (empty `out+err`). Run 18 failed the same assertion
with `❌ timed out waiting for a new healthy parent inventory generation`.

## Diagnosis

1. The mutated campaign winner calls `refresh_machines_snapshot_after "$prior"
   "$recovery_deadline"` in `reconcile_stale_fleet_registries`
   (scripts/run-bench-fleet). The fixture configures
   `CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS=1`, and its tick publishes the new
   generation immediately, so the wait is one tick long.
2. The borrowed branch sets `deadline=$((SECONDS + wait_seconds))`. Bash 5.2
   computes `SECONDS` as whole wall-clock seconds since shell start. A probe
   started at x.97 s, `bash -c 'd=$((SECONDS+1)); sleep 0.06; echo $SECONDS'`,
   printed `deadline=1 SECONDS=1`. A one-tick budget measured on the live clock
   therefore ends at the next wall-second boundary, which can be microseconds
   away, and load makes crossing it more likely.
3. If the boundary passes before the second loop check, the loop exits with the
   timed-out message. If it passes between that check and the post-publish
   recheck, the function returns 1 silently. Either way `status=1`, the
   `complete` helper records a failed terminal, and
   `reconcile_stale_fleet_registries || exit 1` exits with empty output.
4. Why was this possible? The repository's own contract test for this function,
   `agents/benchmarks/cloudbench_campaign_inventory_test.py::test_campaign_inventory_borrowed_refresh_waits_for_same_owned_healthy_generation`,
   measures the borrowed wait in SECONDS ticks (`ticks == 4` for a wait of 4).
   It runs `unset SECONDS; SECONDS=0` because "unsetting SECONDS removes Bash's
   wall-clock binding: the controlled tick is then the only clock, so host load
   cannot expire the budget early". The cohort fixture reused the same function
   with a 1-tick budget but kept the live wall-clock binding.

Proof: the new `test_campaign_wait_is_spent_by_the_logical_clock_not_host_time`
delays the fixture publisher by 1.05 s of host time. With the old live-clock
fixture it failed 3/3 with `❌ timed out waiting for a new healthy parent
inventory generation`. With the controlled clock it passes 5/5. Its negative
control advances only the logical clock by one tick without publishing. It must
fail closed on the local 1 s deadline (one tick, caller cap 10 not reached),
with the timed-out message, a failed terminal, no completed receipt and no
provider call.

Production budgets for this wait (`SNAPSHOT_POLL + 2 + 3*SNAPSHOT_REFRESH_TIMEOUT + 5`,
at least about 20 s) include explicit slack for the whole-second truncation. A
production change (`SECONDS + N + 1` or a microsecond clock) was tried and
reverted. It contradicts the pinned tick contract above (it changes the tick
count) and would let a wait run longer than its configured N seconds.

## Solution

`ReconciliationFixture.spawn` (campaign mode, used only by the 600-member barrier
test) prefixes the controller body with `unset SECONDS; SECONDS=0`, the same
controlled-clock pattern as the inventory contract test. The fixture's immediate
publisher then no longer races the host clock. Production code, every assertion,
the configured 1 s wait, `CAPACITY_ADMISSION_DEADLINE=10` and the 8 s join
timeout are unchanged. The quarantine marker is removed. Budget expiry stays
covered by the inventory contract test's `caller-deadline`, `expired-caller`
and `stale-new-expires` cases. 10k agents: test-only change.

Shipped in PR #2258 (merged 2d99b77abf, 2026-11-16); all 17 deploy gates passed on 8277c90e7e and production semantics passed (verified by descendant 530b71fe93).

## Human feedback

None recorded. A peer repair thread (PR #2106) objected that `SECONDS + N + 1`
would let a borrowed wait run past N seconds and asked for a controlled clock
instead; that objection is why the production change was reverted.

## Reusable lesson

A bash fixture whose wait budget is a few SECONDS ticks must control the clock (`unset SECONDS; SECONDS=0`), because live SECONDS ticks on wall-clock boundaries.
