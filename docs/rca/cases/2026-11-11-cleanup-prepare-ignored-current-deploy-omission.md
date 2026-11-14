---
id: 2026-11-11-cleanup-prepare-ignored-current-deploy-omission
date: 2026-11-11
title: Cleanup prepare proof rejected a recorded current-source deploy omission
surface: harness
component: native-cleanup-prepare
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: source-bound prepare validator compares the current request to the fixed fourteen-check inventory
symptoms:
  - insufficient physical cleanup cohort floors
  - native cleanup prepare custody inventory
  - thirteen cancelled jobs with peak concurrency zero remain UNVERIFIED
tags:
  - deploy
  - cleanup
  - admission
  - custody
sources:
  - PR #1881
  - commit c90b8b4bf5dd3f1e68489b1c869c5dd6c4df3f63
repro: python3 scripts/tests/deploy-test-cycle.test.py CleanupPrepareEvidence.test_source_bound_prepare_accepts_only_authenticated_current_omission
status: open
---

## Problem

The c90 smoke request 0e635412caf74640b6605f2f24e0f8dc selected thirteen tasks after an explicit catalog deploy exclusion of test-mass-agent-run-0. Campaign deploy-2036005a0292e4d0fa4e8720399fa43042965d828b8650090cf657b50c4d0de9 failed physical cleanup-budget admission before dispatch. All thirteen jobs were cancelled with empty attempts and peak concurrency zero. Original task outcomes remain UNVERIFIED, complete=false and cleanup_complete=false.

## Diagnosis

Physical disk capacity caused the original admission refusal; this change does not repair or weaken that guard. A second boundary prevented cleanup-only reconciliation: the source-bound prepare validator accepted only the historical fourteen-check inventory, despite the existing current-source omission audit and catalog authority selecting thirteen. The earlier source-bound producer case is a relative: its lesson to authenticate source and custody still applies, but its fixed inventory omitted this valid user election.

Archive searches covered source_bound_prepare and prepare custody inventory in code and docs/rca/cases; the related case is 2026-11-10-source-bound-cleanup-prepare-refusal. The new owning assertion fails on the original code at prepare custody inventory and passes on the candidate. This is an authored integration defect in the cleanup-only validator, separate from operational disk capacity.

## Solution

In the source-bound branch only, use current_deploy_omissions to authenticate same-source, unexecuted, uncredited omission audit rows and their exact current catalog reasons. Bind the catalog bytes to the failed source Git blob and finite proof. Derive the ordered expected list by subtracting only these authorized names from the original fourteen and derive the exact count from that list. Preserve fixed twelve/fourteen historical paths, exact argv, original historical no-retry custody, job/receipt/producer hashes, no-grant, physical namespace, supervisor and publication guards. No task definition, assertion, timeout, concurrency policy, or resource operation changes.

## Verification

The new positive regression is original RED and candidate GREEN. It exercises the real current_deploy_omissions and catalog reader, while the existing fixture mocks historical custody and publication just as the owning suite already does. Negative controls reject missing/stale/executed/credited/foreign/reason-mismatched/ordinary-quarantine/arbitrary omission records and a catalog differing from the failed source. Both new tests pass five unchanged repetitions; all fifteen CleanupPrepareEvidence cases pass, preserving the old twelve/fourteen contracts. The registered structural deploy-test-cycle gate owns these tests.

The actual c90 request, receipt, namespace and request-bound ledger validate directly with the candidate, including a second plain serialized 27-file proof replay and zero credit. The canonical cycle is not reconciled or edited, and remains at its actual phase. Candidate module source-root override points to the unchanged checkout solely because candidate files live externally. A future source refresh requires new validation; neither this replay nor the patch grants fresh task execution, native cleanup, financial or release credit. Integration, independent review and the full original native validation remain pending.

## Human feedback

Preserve all original UNVERIFIED results and false cleanup/credit flags. Keep the physical floor intact. Subtract only authoritative current-source catalog omissions, retain old fixed contracts, and do not use another layout or invent a missing task to force reconciliation.

## Reusable lesson

A source-bound cleanup proof must authenticate the actual admitted selection as well as the old baseline. A supported user exclusion changes the inventory, not the authority needed to reconcile an unexecuted campaign or the requirement to execute the next native validation.
