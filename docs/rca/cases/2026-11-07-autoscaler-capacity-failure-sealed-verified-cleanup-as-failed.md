---
id: 2026-11-07-autoscaler-capacity-failure-sealed-verified-cleanup-as-failed
date: 2026-11-07
title: A mandatory-autoscaler capacity denial sealed a verified teardown as a failed lifecycle, turning every deploy smoke case UNVERIFIED and leaving a native cleanup owner
surface: infra
component: cloudbench-fleet-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the run-bench-fleet lifecycle writer folded AUTOSCALER_FAILURE into the single status it seals as "final cleanup", so deploy_test_cloud.collect_fleet could not tell a run failure from unverified cleanup and refused the whole fleet
symptoms:
  - "dynamic worker capacity denied: 59 app Machines + 0 reserved + 1 requested > ceiling 56"
  - "mandatory autoscaler failed during the run: Machine-count capacity unavailable for worker clone"
  - "cloud ownership, exit or native cleanup was not verified"
  - "worker result identity/inventory mismatch" (cleanup_complete false)
  - all 13 smoke cases UNVERIFIED although 11 passed natively, and a retained native cleanup owner that blocked re-execution
tags:
  - cloudbench
  - run-bench-fleet
  - autoscaler
  - lifecycle
  - deploy-smoke
sources:
  - PR #1760 deploy, smoke gate at ddfe9f2881ce, campaigns 5be7f288fbd0 (17:29Z) and c15d7c8d8f (~19:00Z), job test-mass-agent-run-0 autoscaler.log
  - commit 54a651e43 (ceiling half, case 2026-11-07-worker-clone-reservation-kept-the-old-56-machine-ceiling)
repro: python3 scripts/tests/deploy-test-worker.test.py CloudCampaign (test_autoscaler_capacity_failure_is_one_verified_failure_not_an_unverified_gate runs the fleet's own lifecycle writer for an exit-1 autoscaler failure with verified teardown; on the old source the case is UNVERIFIED and cleanup unverified, on the fix it is one FAIL with 16 PASS peers and a receipt that validate() accepts)
status: fixed
---

## Problem

The 13-task deploy smoke of PR #1760 ran beside other deploys' fleets in `navi-whisper-lux-bench`. The
mass-agent task's worker clone was denied by the Machine-count check, and its mandatory autoscaler failed. In
the first campaign the task itself passed; in the second its child failed. Both times the fleet destroyed its
primary and verified provider teardown. The deploy adapter still recorded "cloud ownership, exit or native
cleanup was not verified", set `cleanup_complete=false`, the gate validator rejected the receipt ("worker result
identity/inventory mismatch"), and all 13 cases (11 natively PASS) became UNVERIFIED. The retained native cleanup
owner then blocked re-execution until the cycle was archived and re-initialised.

## Diagnosis

Two independent defects.

1. Capacity accounting. The failed source still had `reserve_worker_machine_slot` defaulting to the pre-2026-11-06
   56-Machine ceiling while startup admission used 300. That half is fixed on main by 54a651e43 (separate RCA,
   linked above). Live check on 2026-11-08: org `machines_per_org_limit=1000`; the bench app held 31 Machines
   (20 started, 7 stopped, 4 suspended) against the 300 ceiling. Stopped and suspended Machines occupy slots and
   are rightly counted. No ceiling or concurrency changed here; an over-ceiling worker request stays a hard
   failure, as the existing `test_autoscaler_runtime_handoff_capacity_observation_pending` requires.
2. Evidence. `run-bench-fleet` seals `_batch/lifecycle.json` after teardown with
   `status = verified` only when teardown, registry release, publication **and** `AUTOSCALER_FAILURE == 0` hold.
   The fleet's own legend says lifecycle.json "records final cleanup", but an autoscaler failure (a run verdict,
   already reflected in exit 1) made it `failed`. `deploy_test_cloud.collect_fleet` requires `status == verified`
   to trust cleanup, so it raised for the whole fleet. The campaign adapter then marked cleanup incomplete, which
   makes the validator reject every case. Teardown independently fails if an autoscaler process survives and
   verifies worker captures, so physical cleanup was proven; only the sealed record conflated the two facts.

Gate: NOT_INTRODUCED for PR #1760 (both files were byte-identical to main); this is the assigned repair.

## Solution

- The fleet aggregation loop attributes each mandatory-autoscaler failure to its bench
  (`AUTOSCALER_FAILED_BENCHES`). The lifecycle writer keeps `status` exactly as before for every existing
  consumer and adds `cleanup_verified` (the same predicate without the autoscaler term) and
  `autoscaler_failed_benches`.
- `collect_fleet` accepts a `failed` lifecycle only when `cleanup_verified` is true, the controller exited 1 and
  the failure names benches of this request. Those cases become FAIL (a passed task included) with the
  autoscaler's own reason in `mandatory_autoscaler_failure`; peers keep their verdicts and cleanup is complete,
  so no native cleanup owner is retained. Unattributed failures, unverified teardown and legacy lifecycles still
  fail closed as UNVERIFIED.

Regressions (deploy structural gate `deploy-test-worker`): the capacity-failure case above, plus
`test_autoscaler_failure_with_unverified_teardown_still_blocks_cleanup`,
`test_unattributed_failed_lifecycle_still_blocks_cleanup` and
`test_fleet_attributes_every_autoscaler_failure_branch_to_its_bench`.

10k-agent behavior: no change in Machines, channels or queries; one extra list field per fleet lifecycle record.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

A sealed record that downstream gates treat as "cleanup verified" must not also carry the run verdict; record each fact separately, or one run failure hides proven cleanup and blocks every peer.
