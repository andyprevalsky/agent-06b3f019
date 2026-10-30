---
id: 2026-10-20-sharded-e2e-default-omitted-post-barrier-task-tail
date: 2026-10-20
title: Sharded default e2e (task+2100 from admission) TERMed a controller before a full-window copy was graded
surface: infra
component: cloudbench-original600-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-original600-runner.py campaign_timeouts/STARTUP_ALLOWANCE and scripts/run-original600-controller.py bound_timeouts — default e2e = task_timeout + 2100 counted from admission, while the copy window starts only at strict barrier release and its grade lands after the window
symptoms:
  - "Timeout after 7200s (wall-clock backstop=7200s)"
  - "no current run artifact produced"
  - INFRA_ERROR on a copy whose benchmark already finished rc=1
  - controller exit 143 at epoch + 9300
  - shard e2e deadline TERMed the controller before it collected the result
tags:
  - sharded
  - original600
  - e2e-timeout
  - start-barrier
  - polar
sources:
  - commit 0a2470cc6 (cherry-picked as a22e40431)
  - fleet run 20261020-043621-26573 (Polar batch 1 r003-j0054, shard-01, guest 811d32dbee54d8)
repro: scripts/tests/original600-portable-operator.test.py Portable.test_default_e2e_keeps_a_full_window_grade_after_barrier_release
status: fixed
---

## Problem

Polar batch 1 (2026-10-20, `--timeout 7200`) bound each shard to e2e 9300 s.
r003-j0054 (polar-odysseys-adc644f33f82) used its whole 7200 s window (agent
elapsed 7281 s) and was graded FAIL; its benchmark finished rc=1 at 06:55:45Z.
The shard's TERM fence (caller.json epoch 1792470090.92 = 04:21:30Z, deadline
+9300 = 06:56:30Z) TERMed the controller at 06:56:31 before it collected that
result: exit 143, Hub row `INFRA_ERROR` "no current run artifact produced".

## Diagnosis

Receipts: global release `released_at` 1792471441.49 (04:44:01Z), 1350.6 s
after admission; j0054's rc came 7904 s after release, i.e. 704 s beyond its
window. 0a2470cc6 made the default e2e `task + STARTUP_ALLOWANCE (2100)`, where
2100 was the canary 720 + fleet readiness 900 + evidence/release 480 stage
targets. That budget had no term for a copy's own work outside its window
after release (agent creation, backstop pause, terminal evidence, judge). Needed
1350.6 + 7200 + 704 + 480 = 9734.6 s > 9300 s. Under the old 1200 s cap the
5400 s deadline hid the omission (4200 s of overhead).

## Solution

Split the allowance: `STARTUP_ALLOWANCE = 720+900` (admission to barrier
release), `COPY_TAIL_ALLOWANCE = 720` (bounded by the single-copy canary
create-to-release target; 704 s measured), `RELEASE_ALLOWANCE = 480`;
`E2E_ALLOWANCE = 2820`. `campaign_timeouts` and the supervisor's
`shard_timeouts` require `e2e >= task + 2820`; `MAX_RUN_DEADLINE = 7200 + 2820
= 10020`. The runner owns `default_e2e_timeout(task) = max(5400, task + 2820)`
and `gate_watchdog_seconds(e2e) = max(7200, e2e + 1800)`; the operator uses both,
and the runner refuses a gate watchdog below it. MAX_TASK_TIMEOUT stays 7200 and
the refusal message is unchanged. Default 1200 s runs keep exactly 5400. Explicit
e2e values that cannot hold a full window (for example 3300/5400, 7200/9300) are
now refused up front. Recovery of an already-launched run uses that run's own
pinned runner, so historical 9300 receipts stay valid. No per-agent cost; the
change is constant arithmetic per shard.

## Human feedback

None recorded.

## Reusable lesson

When a deadline clock starts before a barrier, budget barrier wait + full task window + post-window grading + release from receipts, never task + one lumped startup constant.
