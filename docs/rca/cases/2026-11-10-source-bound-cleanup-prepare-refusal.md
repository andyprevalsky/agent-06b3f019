---
id: 2026-11-10-source-bound-cleanup-prepare-refusal
date: 2026-11-10
title: Cleanup prepare reconciliation rejected current zero-admission producers
surface: harness
component: native-cleanup-prepare
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: prepare validator accepts only earlier whole-file producer combinations
symptoms:
  - current campaign fails physical cleanup floor before starting any controller
  - all fourteen task outcomes remain unverified
  - cleanup-only reconciliation refuses the changed producer combination
tags:
  - deploy
  - cleanup
  - admission
sources:
  - PR #1881
  - commit 12b1ff359defa16996a3794b7b11043ea1567d8b
repro: python3 scripts/tests/deploy-test-cycle.test.py CleanupPrepareEvidence.test_source_bound_prepare_preserves_unknown_and_authenticates_custody
status: open
---

## Problem

Campaign 293871269fc99825eba103c7df33aef8e00dfda704d9f955519ad4ddf01d0a4a failed cleanup-ticket prepare with insufficient physical cleanup cohort floors. All fourteen jobs were cancelled before dispatch, with empty attempts and null start/controller outcomes. The native result and cleanup remain incomplete. The default fifteen-slot floor is 4,529,848,320 bytes before other liabilities; exact free bytes at the failure were not recorded.

## Diagnosis

The existing cleanup-only prepare validator accepts earlier whole-file producer combinations. Current campaign and adapter producers differ, and the current fourteen-check inventory plus historical no-retry custody does not fit the earlier twelve-check source-pinned branch. The original regression reproduces the refusal at prepare producer changed. This is distinct from repairing physical disk capacity; reconciliation must not waive that guard or supply execution credit.

## Solution

Add an explicit source-bound prepare proof path. Each failed producer blob must match the installed source file and its committed HEAD blob. Bind an immutable custody ledger witness to the original request's custody-state digest, then run the existing custody verifier and match the complete ordered fourteen-check inventory plus its exact historical exclusion. Preserve the original positive prepare error, zero-start job matrix, grant/lock/directory closure, supervisor/relay/publication checks and no-credit result. Earlier pinned contracts remain unchanged.

## Verification

The new owning assertion fails before the change and passes afterward. Three new controls pass five unchanged repetitions, and all thirteen tests in the existing prepare-evidence class pass. Negative controls reject false custody, changed ledger or producer, started/partial admission, unexpected resource artifacts and grants. The actual current receipt validates through the candidate with a 26-file proof and an immutable request-bound ledger; a second replay uses the serialized plain proof map. No canonical reconciliation, provider operation, source application or fresh benchmark was performed. Independent review and integration remain pending.

## Human feedback

Preserve every original UNVERIFIED result, cleanup false, historical no-remint obligation and physical admission floor. Do not use another failure layout, add broad SKIP acceptance, or reduce the controller reserve to make the gate run.

## Reusable lesson

Cleanup-only authority should prove the actual never-dispatched boundary and bind current reviewed producers and historical custody independently. A completed reconciliation does not mean a task executed or a capacity guard passed.
