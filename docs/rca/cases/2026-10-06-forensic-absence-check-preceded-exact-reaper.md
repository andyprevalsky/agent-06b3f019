---
id: 2026-10-06-forensic-absence-check-preceded-exact-reaper
date: 2026-10-06
title: Failed-owner recovery required native absence before admitting its exact reaper
surface: infra
component: cloudbench-forensic-retirement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: generic forensic verify required owned native IDs absent while recover_exact_stale_fleet_owner still had to run its resource reaper
symptoms:
  - exact stale-owner runtime evidence is incomplete
  - original archive cannot admit teardown while owned Machines and volumes exist
tags:
  - cloud-fleet
  - recovery
  - evidence
sources:
  - PR #1299
  - PR #1424
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: mitigated
---

## Problem

The ordinary exact-owner recovery path verifies runtime evidence before its
native resource reaper. The generic original-archive verifier instead required
every owned Machine and volume already absent. Complete, preserved evidence
therefore could not authorize the operation needed to satisfy that requirement.
Running the same verifier after reaping also cannot work: the normal reaper
changes original `owned` dispositions and removes clone records.

## Diagnosis

The existing owning fixture supplied a complete original archive, failed
controller lifecycle, exact ownership ledger and acknowledged guest cleanup.
Adding original native resources and executing the real extracted recovery
functions failed before any reaper event at the native-absence assertion.
The permanent control models the normal disposition update and clone removal,
preserves a foreign resource, and requires the reaper followed by finalization.
The unchanged control on original scripts failed in 3.123 seconds; the repaired
source passed all 26 existing and new forensic cases in 4.781 seconds.

Archive searches for `forensic retirement archive native absence` and
`exact stale-owner runtime evidence is incomplete` found the September 30
all-sealed archive contract case and October 5 independent retirement case.
Those are relatives with different first bad boundaries; neither proves this
stage cycle. The first baseline attempt omitted the unchanged inventory helper and has zero
causal credit; its setup failure is retained separately. Corrected source
materialization reproduces the native-absence assertion before any reaper.
Private runtime evidence and immutable RED/GREEN receipts are in
`.context/fresh-basic-claude-final50-20261006/deploy/root-unexpected-unit-repair/.context/forensic-ordering-review-packet/`.

## Solution

Generic failed-owner recovery validates complete original evidence before
mutation and publishes a distinct `cloudbench-forensic-archive-verified-v1`
receipt with `native_release_verified=false` and zero proof credit. It clears
only the aggregate evidence-readiness latch, admitting the existing exact
reaper. The ordinary provider audit still gates full release and owner removal.
Default final-retirement verification keeps its native-absence checks and
receipt unchanged. Other forensic manifest modes retain their existing paths.

The compact existing deploy gate registers the forensic controls. Corrupt
archives cannot admit mutation; pending native release cannot close recovery;
live-resource, foreign-owner, altered-copy and worker inverses remain intact.
No task, prompt, model, evaluator, execution timeout or benchmark result changes.
This is a local owning proof, not LIVE acceptance or actual cloud release proof.
Native full recovery and the consecutive LIVE campaign remain pending.

## Human feedback

Check useful lifecycle stage endpoints without inventing aggressive inner
timers. Keep task failures distinct from infrastructure failures, preserve
original evidence, and require actual full release before calling a run done.

## Reusable lesson

Archive readiness can authorize teardown; only the native final audit proves
resource release. Preserve separate durable receipts for these two statements.
