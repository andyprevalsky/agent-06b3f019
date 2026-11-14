---
id: 2026-10-27-sharded-route-refused-bounded-concurrency-batches
date: 2026-10-27
title: Wide batches above the provider cap could not run as one sharded launch; --concurrency below the copies refused or fell back to one host
surface: infra
component: run-bench
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench sharded route — an explicit --concurrency below tasks x K was refused ("admits all N copies behind one barrier") on the strict route and silently fell back to one single-host ordinary campaign on auto, while the provider-capacity preflight caps simultaneous copies at 70
symptoms:
  - "the sharded operator admits all 90 copies behind one barrier; omit --concurrency or pass 90"
  - "--concurrency is not a sharded operator option; using the ordinary fleet path"
  - "Benchmark concurrency is limited by provider rate limits: requested 210 concurrent benches, maximum 70"
  - Polar batch 1 split by hand into two ordinary 30-copy campaigns
tags:
  - sharded
  - waves
  - concurrency
  - provider-capacity
  - polar
  - descend
sources:
  - benchmark run descend-polar-k3-20261027 (cluster I3, ramp from 30 to 70 tasks x K3)
  - commit 788396881 (rca/descend-polar-I3-sharded-waves)
repro: scripts/tests/original600-portable-operator.test.py RunBenchShardedRouting.test_concurrency_below_the_copies_runs_one_batch_of_bounded_waves; scripts/tests/run-bench-sharded-waves.test.py; scripts/tests/cloudbench-shard-coordinator.test.py
status: fixed
---

## Problem

The Polar descent ramps from 30 to 70 tasks x K3, which is 90 to 210 copies.
The provider-capacity preflight (Parallel Search+Extract, 600 requests/min per
key) allows at most 70 simultaneous copies. The sharded operator admits every
copy behind one global barrier, so it refuses anything above 70.

Passing `--concurrency 70` did not help:

- On the strict route, run-bench refused it.
- On auto, run-bench silently ran the whole batch as one ordinary campaign on
  the devbox's single host controller. Batch 1 instead had to be split by hand
  into two separate campaigns.

Either way the batch lost its single identity and its fixed 5% infra
denominator.

## Diagnosis

On descend/polar-k3-recovery `077cc4f2c`, `run-bench <70 polar-bu> -k 3
--concurrency 210 --timeout 7200 --check` was refused by the provider cap, and
`--concurrency 70` was refused by the sharded route. This was the contract gap:
nothing could bound simultaneous copies while keeping one batch, one source,
and the original scheduled denominator. The coordinator could only take its
own launch's copies as `scheduled_total`.

## Solution

`run-bench` now runs an explicit 32 < C < copies batch through
`scripts/run-bench-sharded-waves.py` as ordered, task-aligned waves of
floor(C/K) tasks, so all copies of a task stay together.

- **Each wave:** a normal operator `--check` then `--run`, at the same pushed
  HEAD, task timeout and e2e budget.
- **Release gate:** a wave starts only after the previous admission's
  `native-release-audit.json` shows `released: true`, observed after that wave
  started.
- **Infra stop:** the operator's new `--scheduled-total` and `--prior-infra`
  make the coordinator stop at
  `20 * (earlier waves + live infra) >= original scheduled copies`, and refuse
  to launch once that is reached.
- **Aggregate record:** `waves-*/batch.json` records every wave, the explicit
  NOT_LAUNCHED remainder and the cumulative infra count. `batch_complete`
  requires every wave released with no missing job, and acceptance credit is
  never granted by the driver.
- **Scorecard:** renders the waves directory as one FORMAT v8 card over the
  original denominator, with unlaunched copies kept as QUEUED.

The real `--check` passes at this HEAD:

- 70 tasks: waves of 23/23/23/1 tasks (69/69/69/3 copies).
- 30 tasks: 69 + 21 copies.

Each wave is bound to the batch's 210 or 90 scheduled copies.

Scaling: waves are sequential and bounded by C. Per-wave cost is unchanged,
and the driver adds one small JSON record per wave, so nothing grows per agent.

## Human feedback

None recorded.

## Reusable lesson

When a capacity cap is below a batch's size, bound concurrency inside one batch identity: keep the original denominator and the source, and make the unlaunched remainder explicit. Never split the batch into unrelated launches or silently fall back to a different execution path.
