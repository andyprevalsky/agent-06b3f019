---
id: 2026-10-05-stale-owner-recovery-omitted-unused-worker-reservations
date: 2026-10-05
title: Exact stale-owner recovery left an unused worker capacity reservation
surface: infra
component: cloudbench-capacity-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet capacity_release_stale_owner_reservations enumerated only the primary reservation
symptoms:
  - owner registry absent and all fifty Machines and volumes retired but one autoscaler-worker reservation remains
  - exact stale-owner recovery exits successfully while an unused worker admission claim remains
tags:
  - cloudbench
  - capacity-reservation
  - exact-owner
  - recovery
sources:
  - commit ab3f9edd7f1ae486a0dacc8fb7afd3940b2c5fc6
  - fleet run 20261005-224256-949
  - task local owning reproduction .context/acceptance/fleet-stage-speed-20261006/capacity-cohort-red.private.log
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_exact_recovery_releases_only_its_capacity_and_proxy_leases
status: fixed
---

## Problem

The completed fifty-task fleet required exact recovery after an IVR fixture
failed before agent allocation. Native verification subsequently proved all
fifty owned Machines and volumes absent, and normal recovery retired its owner
registry. One exact controller-owned `autoscaler-worker` capacity reservation
remained. Its unused clone attempt had made no native allocation. The original
record was preserved privately before a separately checked exact manual removal;
that workaround did not fix future recovery.

This case concerns reservation closure, not the IVR fixture failure or benchmark
grading. The baseline source was `ab3f9edd7f1ae486a0dacc8fb7afd3940b2c5fc6`.

## Diagnosis

The actual owning helper received the verified dead controller's metadata and
`<owner>-primary` argument, opened only that primary pathname, and returned
success when it was absent. Normal live teardown already enumerated the whole
owner prefix, including interrupted worker reservations. The first incorrect
boundary was equating retirement of one primary admission with retirement of
the controller's complete admission cohort.

The unchanged owning regression now seeds the primary, an unused worker and a
neighbor. It failed on the original helper because the worker remained. Three
inverse controls also failed: a symlinked worker, foreign PID birth and duplicate
metadata keys allowed the primary to disappear before unsafe cohort rejection.
The identical command produced **4 failed, 647 deselected in 2.41 seconds**:
`PATH=/opt/homebrew/bin:$PATH python -m pytest -q
benchmarks/cloudbench_dependency_sync_test.py -k
'exact_recovery_releases_only_its_capacity_and_proxy_leases or
exact_recovery_validates_complete_capacity_cohort_before_release'`, from the
activated agents environment.

Archive searches for `unused worker capacity reservation recovery primary` and
`serial clone teardown fleet reaping` found related admission and exact-owner
cases, including unknown inventory admission and prestart recovery, but no case
covering this primary-only release boundary. This is a relative of those cases,
not evidence that their fixes caused this failure.

## Solution

Keep the existing recovery call signature and authorization ordering. Under
the existing admission lock, enumerate only this owner's primary/worker token
prefix, reject symlinked or malformed records, verify app/host/PID/birth/owner
identity for every member, then remove the complete validated cohort and fsync
its directory. Missing primary does not hide remaining worker admissions.
Neighbor prefixes remain untouched. An unsafe same-prefix member prevents all
deletion, preserving every original receipt for investigation.

The unchanged command passed **4 passed, 647 deselected in 0.39 seconds**.
The existing benchmark blackbox domain owns these controls; no model calls or
new live verification stage are added. This proves the helper mechanism. A
fresh cloud lifecycle using this source must still establish live speed and
resource closure; the earlier manually recovered fleet supplies no new proof
credit.

At ten thousand agents this remains one bounded terminal sweep of the existing
reservation directory under its existing allocator lock. It adds no per-agent
provider inventory requests, polling loops, admission locks or runtime work.

## Human feedback

The user requested stage speed improvements through the supported CLI, compact
deploy regressions, parallel independent work and deployable checkpoints. They
explicitly prohibited reward hacking or changes that alter benchmark results.

## Reusable lesson

Close every exact controller-owned admission in recovery, including unused
worker reservations, only after validating the complete ownership cohort.
