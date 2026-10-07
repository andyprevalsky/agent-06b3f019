---
id: 2026-10-05-normal-fleet-retirement-serialized-independent-native-receipts
date: 2026-10-05
title: Normal fleet teardown serialized independent exact native retirement receipts
surface: infra
component: cloudbench-registry-retirement
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-bench-fleet reap_registry_clones awaited every native Machine and volume receipt before starting the next record
symptoms:
  - fresh clone teardown performs native Machine and volume retirement one record at a time
  - normal registry cleanup has peak native retirement concurrency one at fleet width
tags:
  - cloudbench
  - teardown
  - native-receipts
  - parallelism
sources:
  - commit ab3f9edd7f1ae486a0dacc8fb7afd3940b2c5fc6
  - fleet run 20261005-224256-949
  - task local owning reproduction .context/acceptance/fleet-stage-speed-20261006/parallel-retirement-red.private.log
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_current_registry_retirement_is_bounded_parallel_and_joins_receipts
status: fixed
---

## Problem

The fifty-wide fresh fleet's reported lifecycle included slow abnormal recovery
and resource closure. That aggregate duration cannot establish how much normal
teardown would save: it includes forensic collection and manual recovery. The
actual controller source separately exposed an avoidable serialization boundary
for fresh clone retirement. Pooled Machine stops were already concurrent;
fresh registry-owned Machine/volume retirements were not.

This case fixes that normal owning mechanism. It does not attribute the whole
prior recovery delay to serialization, claim a measured cloud speedup, or change
the prior fifty-task fleet's benchmark outcomes.

## Diagnosis

After guest cleanup and complete runtime evidence authorize provider retirement,
`reap_registry_clones` walked the exact registry. For each record it completed
native name/identity verification, mounted-volume reconciliation, Machine
retirement, volume terminal verification and durable audit publication before
moving to its independent sibling. The first bottleneck was awaiting each
independent record's complete native lifecycle on the shared controller thread.

The actual owning function was executed with ten disjoint records and the same
controlled 100ms provider operation. Baseline peak overlap was **1**, all ten
records retired, and elapsed time was **1.645 seconds**. The permanent control
requires four independently admitted native operations to reach a concurrency
barrier, joins all submitted work, then checks complete audit/registry results.
It also verifies a pending volume stays owned while successful siblings finish.
Three inverse controls require linked, duplicated and protected-warm cohorts to
remain byte-identical without native calls.

The unchanged focused command, from activated agents, was
`PATH=/opt/homebrew/bin:$PATH python -m pytest -q
benchmarks/cloudbench_dependency_sync_test.py -k 'current_registry_retirement'`.
It produced **5 failed, 651 deselected in 12.24 seconds** on the original source.
The concurrency barrier's five-second guard is a fixture escape hatch, not a
production deadline or an elapsed-time acceptance assertion.

Archive searches for `serial clone teardown fleet reaping` and `unused worker
capacity reservation recovery primary` found related exact-volume and interrupted
ownership cases, including the default-list absence defect and name-only cleanup
sweep abort. Neither established this independent-record serialization boundary.
This is a relative, not a recurrence attributed from archive text alone.

## Solution

Normal `current` teardown validates its entire local record cohort before
submitting any native operations: regular bounded records, unique exact Machine
and volume IDs, matching names and exclusion of protected warm resources. It
then runs the existing per-record state machine in bounded joined batches,
default four (`CLOUDBENCH_REAP_MAX_IN_FLIGHT`). Every submitted child is joined,
and any unresolved receipt keeps its record and makes aggregate cleanup fail.
Native identity, mounted-volume and terminal-state checks remain unchanged.

Stale/forced recovery remains serial, preserving existing ordered legacy
reconciliation, continue-on-pending and stop-on-hard-error contracts. This is
intentionally a normal teardown optimization, not a new recovery policy.

The identical permanent command passed **5 passed, 651 deselected in 0.88
seconds**. Fourteen existing related ownership, pending-volume, exact recovery
and legacy controls passed unchanged in **5.62 seconds**. The original ten-record
controlled operation then reached peak overlap **4**, retired the same ten
records, and took **1.193 seconds**, a **27.5% mechanism improvement**. This small
sample includes local process overhead and is not a cloud width-fifty estimate.
The compact controls are registered in `benchmark-live-results.test.py`; no paid
model calls or additional live proof stage are added.

At ten thousand agents, local cohort validation is linear and uses bounded
record reads. Native retirement concurrency stays four independent of width;
there is no unbounded thread/process launch, provider-wide inventory fan-out,
new polling loop or lock on active agent execution.

## Human feedback

The user requested genuine uncached startup and fifty-wide lifecycle speedups
through the supported CLI, with compact deploy tests, independent parallel work
and deployable checkpoints. Benchmark prompts, grading and results must remain
unchanged; stage improvements cannot be manufactured by weakening verification.

## Reusable lesson

Retire independent exact-owned resources with bounded joined concurrency while
preserving every native receipt and unresolved ownership record.
