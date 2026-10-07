---
id: 2026-10-06-controller-diagnostic-export-gated-native-retirement
date: 2026-10-06
title: Optional controller diagnostics were combined with mandatory native release
surface: harness
component: cloudbench-controller-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: retire_owned_container required successful copying of every temporary file in addition to exact native container retirement
symptoms:
  - exact controller container retirement and private evidence export were not proven
  - partial diagnostics were retained after the exact container was removed
tags:
  - cloudbench
  - diagnostic-export
  - native-retirement
sources:
  - commit 83e02e99ae6c75ea8e8cf860a72c9028cf619a96
  - PR #1424 deploy
  - plan:.context/fresh-basic-claude-final50-20261006/deploy/controller-export-warning-followup.private/review-handoff.safe.json
repro: scripts/tests/cloudbench-controller-linux.test.py ContainerOwnership.test_export_failure_warns_and_preserves_exact_native_retirement
status: open
---

## Problem

The native Linux dispatcher stopped and removed its exact owned container after
an unsuccessful copy of all temporary fixture diagnostics. Its combined return
predicate rejected retirement despite positive native absence. The underlying
full fixture also failed, and that genuine failure remains unchanged. An
incomplete diagnostic export cannot establish that uncopied files were absent.

## Diagnosis

Archive searches used the exact retirement/export error and diagnostic-export
cleanup terms. Existing evidence-retention cases concern required runtime or
ownership evidence, whose guards remain correct. Copying every offline test
container temporary file is an optional forensic observation, not the usable
native stage-end state. No benchmark evidence requirement is relaxed here.

The helper already verifies full container identity, name, owner label, image
and exactly two read-only source mounts before mutation. It stops only that
verified owner, attempts private diagnostics, removes that same owner, and
positively checks native absence. Its return additionally required copy success,
conflating diagnostic completeness with mandatory release.

## Solution

Report incomplete diagnostic copy as a warning and keep available partial files
private. Return release success only after the same identity predicates, accepted
stop, exact removal and positive native absence. Failed stop/removal observations,
foreign identities, foreign images, writable or extra mounts and malformed IDs
retain their rejection behavior. The actual fixture exit code is preserved: a
failed test still fails after successful release.

This change is restricted to the offline native verification dispatcher. Paid
benchmark terminal publication, complete durable task evidence, ownership audits
and full resource-release requirements remain mandatory and unchanged.

## Verification

The existing export-failure control with its final assertions fails against the
original dispatcher in 0.086 seconds and passes against the candidate. The same
final test bytes run all twelve existing ownership/dispatch controls successfully
in 3.474 seconds. Controlled export failure and export exception warn, preserve
private partial-file modes and retire the exact owner; all prior foreign-owner
and stop-failure inverses remain. One additional invocation through the existing
dispatch helper confirms a fixture exit of one remains one after retirement.

These controls make no provider/model calls or native resource allocations. Root
independently reviewed the exact source diff and native original/owning controls.
Final registered qualification on the combined source remains pending, so this
case remains open. All original failures and partial-capture limits are retained.

## Human feedback

The user required usable stage ends and correct overall bounds, rather than
optional intra-stage observations as acceptance gates. Root explicitly retained
mandatory native ownership/source/release proof while making all-temporary-file
forensics best effort.

## Reusable lesson

Keep a diagnostic completeness warning distinct from mandatory resource release
and the workload's actual verdict. Positive absence does not make a failed test
pass, and a partial export does not prove a missing producer artifact.
