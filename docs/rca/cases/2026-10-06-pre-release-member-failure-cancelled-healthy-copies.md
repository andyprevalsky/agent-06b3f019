---
id: 2026-10-06-pre-release-member-failure-cancelled-healthy-copies
date: 2026-10-06
title: One pre-release member failure cancelled healthy campaign copies
surface: infra
component: benchmark-campaign-startup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-campaign promoted a terminal member failure into a global startup abort
symptoms:
  - a controller exiting before startup release cancels healthy ready peers
  - an entirely failed startup cohort cancels later queued cohorts
tags:
  - cloudbench
  - campaign
  - strict-barrier
  - ownership
  - stage-readiness
sources:
  - PR #1299
  - commit 83e02e99ae6c75ea8e8cf860a72c9028cf619a96
  - agent /root/fresh_claude_monitor_qualification
repro: agents/benchmarks/cloudbench_campaign_barrier_test.py
status: fixed
---

## Problem

The campaign preserves genuine task outcomes and strict readiness before release.
Its parent additionally promoted one terminal pre-release controller into a
global abort, stopping healthy peers and later queued cohorts. The user's current
stage rule requires healthy work to continue while failed members remain failed;
partial execution earns no full-width success credit.

This case proves the scheduler/barrier mechanism offline. It does not prove that
the separately retained full multi-workstream failure is fixed or that a live
fifty-copy benchmark has run or passed.

## Diagnosis

The path is exact waitable controller exit → campaign terminal-member handling →
global `barrier_failure` and cohort abort marker → healthy fleet gate refuses
release → later cohort cancellation. The first bad boundary promotes a member
failure into shared cancellation. Removing that promotion alone would deadlock:
the release loop returns when the departed member no longer has a live process,
and the original expected count still includes it.

Two archive searches used the literal controller-exit/cohort-abort symptom, then
failed member, survivor, readiness, cancellation and partial-width vocabulary.
The earlier strict campaign case introduced correct cross-controller readiness
and deliberately aborted all members on an early exit. This is a related failure
policy revised by the current instruction, not a recurrence of premature release.
The failed-cohort canary case preserves a failed shared prerequisite and prevents
redundant canary allocations; survivor release does not override that receipt.

The existing campaign test executes the actual campaign scheduler, actual fleet
release function and actual campaign barrier helper with local child/transport
fixtures. The same final assertions were run against private byte-exact source
files from commit 83e02e99 using the existing
`CLOUDBENCH_FLEET_SCRIPT_UNDER_TEST` seam. The three owning controls include normal
full readiness, one failed member with ready survivors, and all members of the
first cohort failing before a later cohort progresses. Original source passes
the normal inverse and fails both new controls. The first failure is
`failed-member-aborted-healthy-survivors`; the other records later members as
cancelled instead of executing them. The repaired source passes those identical
assertions.

One additional compact inverse invokes the actual barrier helper under a held
parent lifetime lock. The original helper accepts release excluding the current
job; the new helper rejects both an excluded job and a wrong controller PID.
This adds no network call or new readiness timing. The original three-control
red/green receipts and digest remain retained; the additional inverse has its own
source-bound receipt and updated test-file digest.

Private commands, immutable original sources, test digest, logs, campaign summary
and event receipts are under
`.context/fresh-basic-claude-final50-20261006/deploy/monitor-inventory-repair.private/`.
No provider, model or network calls were made. Raw process identities and
forensic bodies are excluded from this archive.

## Solution

A known terminal controller before release remains a failed job, even when its
exit code is zero. It sets the existing campaign failure result and records
`startup_failed_before_release`, but does not abort healthy peers or later
cohorts. The original job, custody manifest and expected count remain intact.

The release loop excludes only those observed terminal members. It still checks
every surviving waitable controller and verifies every ready receipt's cohort,
job and exact controller PID. The cohort records its failed count and actual
released count separately from the original expected count. If no live members
remain, it settles as failed with zero released count and no release timestamp
or release marker, allowing later cohorts to progress.

The release marker includes exact surviving job/PID membership. The existing
barrier helper checks that membership before consuming release, so a descendant
of an excluded controller cannot use another member's release. The original
manifest remains unchanged because cleanup reserve ownership seals and hashes
that full membership.

Shared publisher death, invalid readiness ownership, corrupt release membership,
parent loss and explicit user cancellation retain catastrophic refusal/cleanup.
No surviving unready controller is dropped merely because of a transient read
or readiness observation. Existing stage deadlines and task/overall budgets are
unchanged. Actual task intervals, rather than controller occupancy or a smaller
survivor count, still establish measured execution width.

The compact deploy selector already includes this existing campaign family. The
existing agents benchmark runtime-handoff blackbox wrapper also includes it,
alongside the existing capacity family, without adding a separate deploy gate.
The release owner performs combined mandatory qualification after composition.

## Human feedback

Continue healthy work through transient stage observations and isolate actual
member failure. A stage must be usable for its next stage within the agreed
overall bound. Preserve catastrophic ownership/resource-loss handling and honest
failure/partial-width reporting. Do not tune many small deadlines, rerun paid
providers, invent success width or introduce a large verification framework.

## Reusable lesson

Release eligibility and custody membership serve different purposes. Remove a
terminal failed member only from the live release set, preserve its ownership
and failure evidence, and retain the original requested denominator. An empty
live set settles failure; it cannot establish a successful release.
