---
id: 2026-11-07-blacksmith-plan-followed-coordinator-host-memory
date: 2026-11-07
title: Blacksmith gate plans derived worker counts from the coordinating host's live MemAvailable, so a regenerated plan never matched the staged cycle
surface: harness
component: deploy-gates
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: deploy_test_plan.standard_template() ran run_deploy_pipeline.py plan without a host profile, so the structural gate's --max-workers (and other lane worker counts) followed the devbox's MemAvailable even when the gate ran on its own Blacksmith VM
symptoms:
  - "is bound to a different plan or source; it was kept unchanged. Use deploy_test_cycle.py refresh --input <its plan>"
  - "DEPLOY_CYCLE BLOCKED: repair replaced an original case command or deadline"
  - "--max-workers 4 vs --max-workers 5 between two plan generations 15 minutes apart"
tags:
  - deploy-gates
  - blacksmith
  - staged-cycle
  - plan-determinism
  - environment-digest
sources:
  - PR #1751 deploy rounds at sources f8c0511b0d and 9c6d9c3622
  - commit f8c0511b0d
  - memory:blacksmith-deploy-gates
repro: python3 scripts/tests/deploy-gates.test.py
status: fixed
---

## Problem

Regenerating the gate plan for the same source produced a different plan: the structural gate's `--max-workers` was 4
at one moment and 5 at another, so `deploy_test_cycle.py refresh` refused to bind the cycle ("different plan or
source", then "repair replaced an original case command").

## Diagnosis

`run_deploy_pipeline.py plan` scales lane worker counts with the host's `MemAvailable`. The Blacksmith executor keeps the
standard template's concurrency because each gate runs on its own VM, but the standard template itself was computed
from the coordinator's live memory (a few hundred MB flipped 4 and 5 around 14,000 MB available). A second, related
trap: `environment_digest()` covers the whole process environment, so `refresh` run from a shell with an extra exported
variable (a venv-prefixed PATH, GITHUB_TOKEN) re-binds the cycle to an environment the coordinator does not have, and
the next `scripts/deploy gates` reports the source/plan as changed.

## Solution

`BLACKSMITH_REFERENCE_HOST` (8 CPUs, 13,500 MB available, 16,000 MB total, 14,400 MB watchdog, which yields 4
structural workers, the count of the first sweep) is passed to the planner whenever the executor is blacksmith
(`standard_template(host)`, `build_template`), with regression
`test_blacksmith_plan_uses_a_fixed_reference_host_and_local_follows_this_host`. Operationally, run `refresh` under the
coordinator's exact PATH and without extra exports (recorded in memory `blacksmith-deploy-gates`).

## Human feedback

None.

## Reusable lesson

A plan that is bound to a state machine must be a pure function of the source and the declared executor, not of live
host telemetry; and any digest of the process environment makes every helper run in the cycle's environment a
protocol step, not a convenience.
