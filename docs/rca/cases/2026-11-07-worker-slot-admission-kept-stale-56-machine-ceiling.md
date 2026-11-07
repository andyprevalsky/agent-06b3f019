---
id: 2026-11-07-worker-slot-admission-kept-stale-56-machine-ceiling
date: 2026-11-07
title: Autoscaler worker admission kept the old 56-Machine default after startup admission moved to 300
surface: infra
component: run-bench-fleet-capacity-admission
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet reserve_worker_machine_slot (CLOUDBENCH_APP_MACHINE_CEILING default 56)
symptoms:
  - '❌ dynamic worker capacity denied: 60 app Machines + 0 reserved + 1 requested > ceiling 56'
  - '❌ [test-mass-agent-run-0] mandatory autoscaler failed during the run: Machine-count capacity unavailable for worker clone'
  - 'smoke FAIL worker result identity/inventory mismatch (every case UNVERIFIED, campaign job has no verified cleanup)'
tags:
  - cloudbench
  - capacity-admission
  - autoscaler
  - deploy-smoke
sources:
  - PR #1762
  - commit 331fab741
  - fleet run 20261107-165840-2136305
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py (test_worker_slot_admission_uses_the_startup_machine_ceiling_default)
status: fixed
---

## Problem

The deploy smoke gate for PR #1762 ran 13 tasks on 6427f84e1. 12 tasks reached a native
verdict (11 PASS, plus 1 standing AgentCard release-stall SKIP). The test-mass-agent-run-0
task itself reported REAL PASS, but its job exited 1 because the mandatory per-bench
autoscaler could not add a worker:
`dynamic worker capacity denied: 60 app Machines + 0 reserved + 1 requested > ceiling 56`.
That job then had no verified exit or cleanup, so the cloud adapter marked the whole smoke
receipt incomplete and every case UNVERIFIED.

## Diagnosis

Commit 331fab741 (2026-11-06) raised the startup admission ceiling in `run-bench-fleet` to
300 Machines. That was justified by measured Fly organization limits; explicit lane ceilings
replaced the implicit protection. The same commit left `reserve_worker_machine_slot`, which
admits each dynamic autoscaler worker clone, at `${CLOUDBENCH_APP_MACHINE_CEILING:-56}`.

Startup therefore admitted the 13 primaries against 300. The bench app already held about
36 standing (mostly stopped or suspended) Machines, and other tasks' autoscalers added
workers. Once the count passed 56, worker admission refused mass-agent's required worker.
The earlier 9-task smoke stayed under 56, so it passed. Main's deploy-v2 change (#1751) moved
the four AgentCard lifecycle tasks into the smoke fleet, which made the overflow routine.

Repro: the new test extracts the real `capacity_reserve_slots` and
`reserve_worker_machine_slot` functions, stubs a 60-Machine inventory and leaves the ceiling
unset. On HEAD~1 it fails with the exact production message; with the fix it passes.

## Solution

`reserve_worker_machine_slot` now uses the same default (300) as startup admission. The
regression also asserts that every `CLOUDBENCH_APP_MACHINE_CEILING` default in
`run-bench-fleet` is identical, so the two admission sites cannot drift again. The explicit
lane ceilings (DEMO ≤50, REAL/SIM ≤70) and the org-measured limits are unchanged. At 10k
agents nothing changes per agent; this only affects how many benchmark worker Machines one
app may hold.

## Human feedback

None recorded.

## Reusable lesson

When raising a resource ceiling, change every admission site that reads the same setting, and test that their defaults agree.
