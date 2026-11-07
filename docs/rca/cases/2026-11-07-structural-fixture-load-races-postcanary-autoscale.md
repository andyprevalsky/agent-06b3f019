---
id: 2026-11-07-structural-fixture-load-races-postcanary-autoscale
date: 2026-11-07
title: Two deploy-structural fixtures raced their own background children under gate load (post-canary inventory join, autoscale finalization harness)
surface: harness
component: deploy-structural-fixtures
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/cloudbench_campaign_inventory_test.py run_consumers standalone join counted admission reads as snapshot-loop reads; scripts/tests/cloudbench-acceptance-autoscale.test.sh finalization harness never reaped its fake autoscaler
symptoms:
  - "test_campaign_inventory_post_canary_admission_uses_parent_feed_without_native_fanout[False] ... assert 5 == 6"
  - "test_campaign_inventory_post_canary_admission_wait_keeps_feed_and_standalone_reads[False] ... assert 7 == 8"
  - "GATE_STEP autoscale status=UNVERIFIED exit=0"
tags:
  - deploy-structural
  - cloudbench
  - fixture-race
  - load-flake
sources:
  - PR #1752
repro: delay the snapshot loop start by 0.5 s (post-canary) / widen the fake autoscaler's trailing sleep to 5 s (autoscale), then run the unchanged tests
status: fixed
---

## Problem

During the PR #1752 `/deploy` staged cycles (2026-11-07, load average 16 on 8
vCPUs with backend, agents and semantic lanes running), the structural gate
failed in cycles 5 and 6 on two sibling `post_canary` standalone cases that
counted one fewer native `machines` read. Cycle 6's cloudbench-controller gate
also reported `autoscale` UNVERIFIED with every assertion passing. Each case
passed alone.

## Diagnosis

Post-canary: in `run_consumers`, a standalone job waits for the snapshot loop's
first read before exiting. The join condition was "fewer than 2 `machines` rows
for this job, or `INVENTORY_REFRESH_LOCK` exists". With `post_canary=True`,
`admit_app_capacity_with_wait` has already made one native read (two with
`admission_wait`), so the total of 2 is reached once the initial refresh ends.
If the backgrounded `machines_snapshot_loop &` has not yet created its lock,
the job exits and `finish` kills the loop before its read is logged: 5/6 and
7/8. Product code behaves correctly.

Autoscale: the finalization harness starts `( sleep 1.5; : > marker; sleep 0.5 ) &`.
`wait_for_autoscaler_finalization` correctly returns at the marker, but the
harness never reaps that subshell. When the harness exits first, the trailing
sleep is orphaned and the native supervisor (correctly) records
`orphaned_children: true` with a TERM, making the step UNVERIFIED.

Repro: delaying only the snapshot loop start by 0.5 s gives `assert 4 == 6` and
`assert 6 == 8` (a no-admission control still passes). Widening only the fake
autoscaler's trailing sleep to 5 s gives `orphaned=True term=[pid]` under
`scripts/cloudbench-local-supervisor.py`.

Gate: NOT_INTRODUCED (fixture timing; the PR changes no fleet code).

## Solution

The standalone join counts reads relative to the rows the job already had just
before `start_machines_snapshot_loop`. The autoscale harness `wait`s each fake
autoscaler after its assertions. No assertion, expected count, timeout or sleep
changed. After: delayed-loop probe 10/10, both real cases 10/10 under 4 CPU
hogs, whole inventory file 381/381; widened autoscale `orphaned=False`, and
the step passed 5/5.

## Human feedback

None recorded.

## Reusable lesson

A fixture that joins on "N events happened" must count only the events of the
thing it is waiting for, from a baseline taken when that thing starts; and a
harness must reap every background child it starts, even after its assertion is
satisfied.
