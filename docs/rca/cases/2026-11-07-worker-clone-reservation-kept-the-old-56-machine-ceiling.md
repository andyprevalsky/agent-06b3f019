---
id: 2026-11-07-worker-clone-reservation-kept-the-old-56-machine-ceiling
date: 2026-11-07
title: A mass-agent worker clone was denied at "61 app Machines > ceiling 56" because reserve_worker_machine_slot kept the pre-2026-11-06 default while startup admission used 300
surface: harness
component: cloudbench-fleet-capacity
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet reserve_worker_machine_slot read CLOUDBENCH_APP_MACHINE_CEILING with the old default 56 while the startup admission of the same script (and the campaign planner) defaulted to 300 after the 2026-11-06 ceiling raise
symptoms:
  - "dynamic worker capacity denied: 61 app Machines + 0 reserved + 1 requested > ceiling 56"
  - "mandatory autoscaler failed during the run: Machine-count capacity unavailable for worker clone"
  - "worker result identity/inventory mismatch"
  - "test-mass-agent-run-0 REAL PASS but fleet exit 1"
tags:
  - cloudbench
  - run-bench-fleet
  - machine-ceiling
  - autoscaler
  - deploy-smoke
sources:
  - PR #1747 deploy attempt 2, gate smoke at 768b04db49 (campaign deploy-c597d9ea, job r001-j0001 test-mass-agent-run-0, autoscaler.log line 4)
  - commit 331fab7412
  - memory:blacksmith-deploy-gates
repro: python3 -m pytest agents/benchmarks/cloudbench_dependency_sync_test.py -k startup_admission_ceiling
status: fixed
---

## Problem

The 14-task deploy smoke campaign (concurrency 14) admitted all 14 primaries and ran them to completion. 12
tasks PASSED and the AgentCard abandonment task SKIPPED on the documented release stall. The mass-agent task
passed its own evaluators (`REAL PASS`), but its mandatory autoscaler, which clones worker Machines for the
fan-out, was refused: `dynamic worker capacity denied: 61 app Machines + 0 reserved + 1 requested > ceiling 56`.
The fleet exited 1, the campaign failed, and the gate came back UNVERIFIED ("worker result identity/inventory
mismatch" is the validator's message for `cleanup_complete` not being true) although the task itself had passed.

## Diagnosis

Gate: NOT_INTRODUCED. `scripts/run-bench-fleet` is byte-identical to main. Commit 331fab7412 (2026-11-06) raised
the app Machine ceiling default from 56 to 300 after measuring that Fly allows far more (org
`machines_per_org_limit=1000`), and changed the startup admission (`:-300`). `reserve_worker_machine_slot`, the
one-Machine check every dynamic worker clone runs, kept `${CLOUDBENCH_APP_MACHINE_CEILING:-56}`. A smoke run
beside other workloads (47 Machines at idle, 61 with its 14 primaries) therefore passed startup admission and failed
the first worker clone. The unit tests of that function set the ceiling explicitly, so no test saw the default.

## Solution

`reserve_worker_machine_slot` defaults to 300, like the startup admission. Regression in
`agents/benchmarks/cloudbench_dependency_sync_test.py`:
`test_worker_capacity_reservation_uses_the_startup_admission_ceiling_by_default` asserts that every
`CLOUDBENCH_APP_MACHINE_CEILING:-N` default in the fleet script is the same value and that the worker reservation
passes 300 to `capacity_reserve_slots` with the variable unset and 61 Machines present (fails on 56).

10k-agent behavior: no change; the ceiling is a fleet-wide cap checked once per worker clone.

Golden reference: not applicable (no approval-gated hunk).


Recurrence (independent, same day): PR #1762's deploy smoke on 6427f84e1 (fleet run
20261107-165840-2136305) denied test-mass-agent-run-0's worker with "60 app Machines + 0 reserved
+ 1 requested > ceiling 56". Before syncing, that PR fixed the same line in parallel (e32957dc4) and
added `agents/benchmarks/cloudbench_campaign_inventory_test.py::test_worker_slot_admission_uses_the_startup_machine_ceiling_default`.
That test extracts the real `capacity_reserve_slots` and `reserve_worker_machine_slot`, reproduces the
exact denial against a 60-Machine inventory, and asserts that every ceiling default in the script
agrees. On sync it kept this case's code and folded its own case into this one.

## Human feedback

None recorded.

## Reusable lesson

When a limit is raised, grep for every default of that variable, and pin them to one value with a test, because a stale copy only fails once load reaches the old number.
