---
id: 2026-11-10-disposable-reaper-bypassed-runtime-evidence-latch
date: 2026-11-10
title: Disposable teardown bypassed the runtime evidence preservation latch
surface: infra
component: cloudbench-fleet-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: reap_registry_clones bypasses runtime-evidence-unconfirmed when DISPOSABLE_REAP is set
symptoms:
  - runtime evidence is incomplete; failed result retained while disposable resources are retired
  - accepted execution cannot use rejected startup cleanup
  - refusing to destroy fleet machines whose runtime evidence is unconfirmed
tags:
  - cloudbench
  - cleanup
  - evidence
  - ownership
sources:
  - PR #1881
  - commit b5ede511a36a1f9a0eab538d6c539bdbefba3415
  - fleet run 20261109-232926-2403824
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_exact_recovery_routes_quarantined_owner_to_guest_recovery_before_reapers
status: mitigated
---

## Problem

A six-check deployment campaign refused incompatible warm Python dependencies before task execution. Runtime evidence remained unsealed, yet disposable cleanup retired the original Machines and left detached pending-destroy volumes. Each check remained UNVERIFIED. Exact-owner recovery could not collect a sealed original runtime manifest; all six supported recovery attempts refused and retained ownership. These are operational failures, not passing tasks or financial clearance.

## Diagnosis

The existing exact-owner recovery respects the runtime evidence latch. The live `reap_registry_clones` path instead skipped that latch when `DISPOSABLE_REAP=1`. A replay of the actual function reached its deletion sink for an unsealed disposable owner. The unchanged registered recovery regression, extended to call the actual disposable policy selector and reaper, failed on the original source with the same behavior. Sealed owners and non-disposable owners provide neighboring controls. This recurrence of an evidence-preservation contract violation is related to the native release-audit and boot-terminal collection cases; those cases do not close this incident.

The first original Machine was observed destroyed and its exact volume pending_destroy and detached. Equivalent typed observations bind the other five pairs. These states do not prove byte absence or complete cleanup. Earlier recovery and original-volume capture routes require an admissible original capture or a stopped attached original Machine; their refusal must not be bypassed.

## Solution

Remove the disposable exemptions from the runtime-evidence-unconfirmed guard and the failed worker-capture result. The worker path now fails before reaping, terminal-audit publication or ownership release; its ledger and readiness remain available for recovery. A regular file or dangling symlink latch now blocks deletion for either policy; sealed owners retain the ordinary cleanup path. The same registered regression also exercises the actual worker cleanup function with disposable/non-disposable and sealed/unsealed controls. It passes after this change and is selected by the controller's existing selected-pytest recipe. Five unchanged focused repetitions pass. This contains future deletion; it cannot recreate the six historical originals or certify their cleanup.

The unchanged isolated-validation contract can exclude the exact six quarantined Machine/Volume pairs from a new request namespace while retaining original control records, obligations and false cleanup status. That launch-only proof grants no task, financial or retirement credit. Full current-source deployment validation remains required.

## Human feedback

None recorded for this containment repair. Existing instructions require preservation of original evidence and prohibit inventing cleanup or passing execution credit.

## Reusable lesson

Apply evidence-preservation latches before every deletion path, including disposable cleanup.
