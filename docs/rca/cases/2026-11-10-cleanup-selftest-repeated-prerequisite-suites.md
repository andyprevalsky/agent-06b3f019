---
id: 2026-11-10-cleanup-selftest-repeated-prerequisite-suites
date: 2026-11-10
title: Internal cleanup-exit probe reran ten already completed prerequisite suites
surface: harness
component: cloudbench-multi-workstream-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: prerequisite block executes before the recursive cleanup-exit-only early return
symptoms:
  - cleanup-exit self-test launches all ten prerequisite Python suites again
  - whole multi-workstream stability unit reaches its 1200-second limit
tags:
  - cloudbench
  - fixture
  - cleanup
  - synchronization
sources:
  - PR #1881
  - commit 79e326ef5ce039e269166aa589fb33b25bbb887e
repro: python3 scripts/tests/cloudbench-fixture-process-cleanup.test.py
status: mitigated
---

## Problem

The native loaded stability unit timed out at1200seconds after scenario9. The same frozen source passed its normal controller unit in1240.462seconds, which proves a budget conflict but not a scenario10 hang. Historical cutoff state was absent from returned artifacts; the containing aggregate remains incomplete and UNVERIFIED. Fresh scenario10 alone passes under the original load and case bounds, so it does not reproduce the cumulative history.

## Diagnosis

An authorized instrumented offline fake-provider capture shows the recursive cleanup-exit probe running ten prerequisite suites already completed by its parent. The child spends at least72.88seconds before its intended immediate cleanup exit, and scenario1 begins at elapsed156seconds. The prelude is identical in incoming main and this source. This is concrete redundant fixture work; its contribution to the original loaded timeout remains bounded by the capture and requires fresh full acceptance. It does not establish that all excess time or the historical timeout was caused by that duplication alone.

## Solution

Only the existing internal cleanup-exit mode bypasses the prerequisite block. The normal invocation retains the exact ten commands, ordering and hard failure propagation. The child still exercises the real forced exact-Hub cleanup failure and must exit1 with retained ownership. There is no new production flag or success fallback, and all normal scenario assertions remain.

Register the existing fixture-process-cleanup script directly in the structural registry and assert its exact unique command in that same test. Keep the separately added replay CLI gate. No test deadline, repetition count, CPU-load policy, concurrency, fixture task definition, provider behavior or acceptance threshold changes.

## Verification

The regression fails on the original block because the cleanup-exit mode records ten duplicate commands. It passes five unchanged candidate repetitions, including normal/default command ordering and a failed prerequisite stopping execution. The real isolated cleanup-exit path still returns1 and retains the failed cleanup obligation. The full owning helper suite and direct selector registration pass; missing, wrong and duplicate registry entries reject. Full native multi-workstream and loaded stability acceptance remain pending, and the original timeout remains visible.

An earlier external diagnostic-publisher candidate was rejected after synthetic dotdot and symlink-parent paths wrote outside its fixture. That publisher is omitted entirely from the proposed correction. Its rejected patch, findings and private capture are retained; they grant no new source or native credit.

## Human feedback

The deployment instructions require preserving the original1200-second cap, five repeats and loaded execution. Do not turn a timeout into a completed assertion failure, raise the budget or infer an unexecuted scenario passed.

## Reusable lesson

A direct cleanup probe should exercise its cleanup contract, not recursively rerun unrelated prerequisite suites. Measure and remove proven duplicate work while preserving the original full acceptance policy and unresolved timing limits.
