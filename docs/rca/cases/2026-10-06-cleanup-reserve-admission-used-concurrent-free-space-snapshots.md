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


## Review recurrence: retired unadmitted members

The final review identified a separate admission-floor recurrence. A cohort's
parent can remain alive after a child retires before allocating its reserve.
The immutable custody manifest correctly retains that child, but the admission
loop counted every unconsumed member as pending. Its cleanup minimum and working
floor could then deny capacity to a surviving controller.

Two archive searches covered pending cohort members, native process births,
abandoned reservations and cleanup headroom. This case owns the allocator;
the pre-release-member failure case owns survivor scheduling. Custody membership
must remain unchanged in both.

An actual owning control invokes the real shell reserve function under a held
native parent lock. A waited/reaped child supplies the retired manifest PID.
The fixture isolates its accounting namespace and bounds the free-space
transport while preserving real process-birth observations and real 1 MiB native
physical allocation. Original 5c1fc870 fails the retired-member case and passes
both live-member and unassigned-member inverses (1 failed, 2 passed, 0.93 s).
The unchanged three cases pass against the repair (3 passed, 4.65 s). Initial
scratch setup errors from a missing adjacent library were retained separately
and are not causal reproduction credit. No provider or model calls occurred.

The accounting loop now rereads bounded, owned cohort membership and removes
only assigned, unconsumed members whose native process birth is absent from the
fresh snapshot. Unassigned members remain eligible to launch. Any live or
uncertain PID, including a possible reused PID, conservatively retains its
floor. Consumed owners retain the existing exact-birth accounting. No custody
manifest, provider resource, production budget, benchmark result or reservation
default changes. The new three-case control joins the existing
`cleanup_releases_emergency_disk` deploy selection; no separate gate is added.

This is owning-boundary evidence, not a claim that a fresh fifty-task fleet has
finished or that its live startup problem is resolved. The independent DAILY-50
control continues on its frozen pre-repair source without interference. Private
source, unchanged controls, native test results and independent-review receipts
are retained under `.context/fresh-basic-claude-final50-20261006/deploy/`.


## October 6 deployment-fixture recurrence

The normal structural gate on immutable `85070617776b8355565266bf16f08a58093c1072`
failed six existing fixture targets on a host observed at load 107 with 14 CPUs.
The fifty-owner reserve driver exceeded its outer 90-second observation guard.
That outer subprocess timeout killed the Python driver while 46 original Bash
owners remained alive, waiting for a retire marker in a subsequently deleted
pytest directory. The driver lacked cancellation cleanup, and its accounting
fixture shared the real filesystem admission namespace. Live fixture floors
could therefore interfere with later tiny reserve controls. This is a fixture
failure; it does not prove a new production admission defect.

The original deployment owner revalidated the exact source, fixture path, job,
native birth and command of every original owner before individual TERM signals.
All 46 original parents were positively absent and their original group was
empty afterward. No foreign namespace or Freedom resource changed. The shared
admission ledger was preserved; the later read-only classification contained
no exact-original fixture group. The unchanged ten-case capacity-loop control
then passed in 16.261 seconds with every recorded owner absent and child reaped.
That observation supports host interference, rather than a capacity-algorithm
repair or an accepted fleet speedup.

The fixture now uses a unique accounting namespace through its existing local
filesystem transport. It still runs all fifty default owners against the same
18,000 MiB modeled capacity, native process observations and original storage
floors. FIFO handoffs replace fork-heavy start/retire polling. On interruption,
the driver closes launch admission and drains its recorded private child
sessions only after matching native birth, fixture path and PGID. Reaped or
recycled leaders cannot authorize signaling. The existing owning test adds a
cancellation-before-admission handoff and requires all fifty children reaped;
the ordinary admission case retains every original outcome assertion.

The affected offline fixtures share a 600-second host observation guard.
Production task, provider, autoscaler-finalization and cleanup budgets are
unchanged. Final focused verification passed sixteen cases in 48.904 seconds,
including timezone/PID-reuse, capacity, ordinary inventory, repeated-cache
controls and the existing strict-barrier inverses. Both cohort handoffs created and reaped fifty children. The actual
permanent compact selector collected all eight cases without selector changes
or an unrelated catalog-count assertion. Initial private dependency and helper
module-layout setup failures receive zero final proof credit.

Private source, original failure, final native proofs and registration receipts
are in `.context/fresh-basic-claude-final50-20261006/deploy/root-structural-fixture-repair/`.
Full normal deployment composition and independent review remain separate gates.
No provider/model calls, benchmark results, acceptance credit or production
performance claim arise from these fixture controls. This case remains mitigated.
