---
id: 2026-10-06-cleanup-reserve-admission-used-concurrent-free-space-snapshots
date: 2026-10-06
title: Concurrent fleet controllers consumed disk capacity from independent snapshots
surface: infra
component: cloudbench-fleet-cleanup-reserve
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: reserve_cleanup_disk_space read free space independently before concurrent physical allocations
symptoms:
  - fifty-copy cached campaign failed during preflight before any task allocation
  - twenty-eight controllers reported cleanup reserve refusal
  - native controller filesystem reached its capacity limit
tags:
  - cloudbench
  - disk-reserve
  - cohort-admission
  - concurrency
  - process-identity
sources:
  - PR #1422 follow-up
  - fleet run 20261006-180139-2969
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fleet_cleanup_releases_emergency_disk_reserve_for_cohort_budget
status: mitigated
---

## Problem

The supported CLI launched fifty controllers for the existing cached mass task.
All fifty finished without a task allocation, execution or evaluation. The
campaign took 782.915 seconds through controller exit and receives zero proof
credit. Native observations showed the controller filesystem reaching its
capacity limit, with about 3.42 GiB free at the earlier observation. Twenty-eight
controller logs reported reserve refusal. Two infrastructure canaries were
allocated and required exact-owner recovery; they were separate from the fifty
task copies.

Original logs and native ownership captures remain private under
`.context/fresh-basic-claude-final50-20261006/`. The original allocator suppressed
its low-level stderr. Consequently, the precise first failing live controller's
allocation-error versus post-allocation-floor branch remains unproven. This
case does not claim that local evidence alone resolves the live fifty-copy
failure or proves its startup performance.

## Diagnosis

Archive searches used the literal reserve refusal, concurrent cleanup reserve
headroom and physical allocation. The
[temporary-filesystem case](2026-09-27-cloud-controller-temp-root-ignored-persistent-volume.md)
concerns a launcher's choice of filesystem; the
[zero-fill case](2026-09-27-fleet-cleanup-reserve-zero-fill-delayed-readiness.md)
concerns unnecessary writeback. Neither owns this admission race.

Each controller independently observed free space and preferred a 512 MiB
reserve. Fifty callers could therefore request 25 GiB from overlapping free
space snapshots. No transaction reserved the pending cohort's 32 MiB per-copy
cleanup minimum and 256 MiB per-copy working headroom before allocation.

An unchanged owning-boundary driver ran fifty real reserve functions against a
bounded storage transport. The original source admitted 32 and failed 18;
the candidate admitted all fifty while preserving every cleanup and working
floor. The transport held admitted owners alive through all admissions and
performed no provider or task calls. It models capacity accounting, rather
than proving fifty native physical allocations. A separate real macOS control
verifies native physical allocation and release.

Independent review also reproduced two owner-identity defects in an intermediate
draft: timezone-dependent process birth strings could lose a live owner's
headroom, and a changed birth for the same PID could be adopted during
allocation. The unchanged interleavings passed after pinning the `ps` child to
UTC and requiring the final birth to equal the initial birth. The reviewer
independently reproduced the PID-reuse rejection and neighboring-file
preservation.

## Solution

Admission now holds one user/filesystem lock across a fresh free-space read,
sealed cohort validation, fair sizing, physical allocation, synchronization and
post-allocation floor checks. Pending sealed cohort members retain both minimum
cleanup capacity and working headroom. Live admitted owners retain their working
floor until their exact process birth retires. Standalone calls use the same
atomic transaction without reserving capacity for unknown future callers.

Accounting hints are bounded, validated and separate from provider ownership.
They never release a Machine, volume or ownership claim. Failed allocation
removes only the reserve whose captured inode/device still matches. The storage
defaults, workload, task grading, model calls and production timeouts are
unchanged. The native macOS allocation recurrence is documented in the existing
zero-fill case.

The permanent owning controls are selected by
`scripts/tests/benchmark-live-results.test.py`, already part of the normal
deploy process. They cover fifty-owner admission, timezone and PID-reuse
interleavings, allocation capability/error boundaries, physical reserve shape,
exact cleanup order and preservation of unrelated files. Fixture observation
guards allow sixty seconds without changing outcome assertions or runtime
limits. Combined runtime source SHA256 at independent review was
`219ac91bdcc0497834d0e2fda37f4717cdf42b142ad1984b428fd55f8feae3c4`.

The code-level admission repair has causal proof and independent review.
Successful fresh fifty-copy execution and full native release remain the
outcome gate, so this case is mitigated rather than a completed fleet proof.

## Human feedback

The user required parallel optimization work, a five-minute cached execution
window, truthful stage timings, unchanged benchmark behavior and exact resource
release. Quick regression tests must run in the ordinary deploy process; large
performance diagnostics require an explicit request. The user rejected overly
aggressive observation assertions and requested realistic breathing room.

## Reusable lesson

Admit a sealed concurrent cohort against fresh disk capacity in one transaction before allocating its physical cleanup reserves.
