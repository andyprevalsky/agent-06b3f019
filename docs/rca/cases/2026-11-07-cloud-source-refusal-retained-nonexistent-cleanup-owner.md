---
id: 2026-11-07-cloud-source-refusal-retained-nonexistent-cleanup-owner
date: 2026-11-07
title: A pre-admission source refusal retained an unreconcilable smoke cleanup owner
surface: harness
component: staged-deploy-cloud-admission
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: deploy_test_cloud.execute refused a stale source before admission but its handled-error exit omitted the negative admission receipt required by the coordinator
symptoms:
  - gates still own unreconciled cleanup refuse launch smoke
  - source mismatch exit 2 had no adapter result
  - native cleanup dereferenced a missing worker_result
tags:
  - deploy
  - admission
  - cleanup-custody
sources:
  - commit 3043c89624e3d1994adaad6c1131290266086868 PR1770 source-refusal custody repair
  - commit b544c29434ccbb5075952850b7701ffec14545c9
repro: scripts/tests/deploy-test-cycle.test.py
status: fixed
---

## Problem

The smoke adapter correctly refused the frozen source after the coordinator
checkout changed. It exited 2 in 1.467 seconds with the exact source-guard
message, before its request directory, capacity checks, canary or provider
command. No cloud allocation occurred. The adapter wrote no result, so the
coordinator conservatively retained unknown native custody. Neither ordinary
native cleanup (which requires an adapter) nor interrupted cleanup (which
requires a real cancellation and campaign) could retire this earlier refusal.
All 13 smoke cases remained UNVERIFIED.

## Diagnosis

The first bad boundary was the missing explicit negative admission result,
not the correct source check or the conservative cleanup guard. Auditing the
original producer and five-file import closure established that this exact
handled error precedes every admission side effect. The immutable request,
receipt, exact stdout/stderr and source hashes identify that path; absence
of a directory or a log string alone does not prove zero allocation.

Archive searches for cloud source refusal and preflight synthetic cleanup
found the November 6 interrupted-preallocation case as a relative. Its
cancelled campaign had launched controllers and native cleanup audits;
this uncancelled, pre-mkdir source refusal is a different boundary.

## Solution

SourceRefusal is raised only before admission and emits an explicit typed
negative-admission result. The coordinator accepts this only for the native
cloud adapter with matching identity, inventory, exit, namespace and no
abnormal process state. It releases custody while preserving every case as
UNVERIFIED and the gate as incomplete/FAIL. Other errors remain fail closed.

A separate typed historical reconciliation supports only audited producer
versions. It binds all original file bytes, source/import hashes, command,
owner, clock and exact refusal; it checks the request namespace was not
admitted and re-observes log holders and namespace consumers. It appends only
a launch-eligibility entry. Original receipts, verdicts and timestamps remain
immutable; no execution or financial cleanup credit is granted. Unsupported
sources, missing/corrupt/symlink evidence, admitted namespaces and unknown
consumers refuse. A fresh full smoke run remains mandatory.

## Verification

The identical permanent tests run against the frozen original modules failed:
reconcile rejected the typed proof as missing fields; the source guard produced
no result; and the coordinator retained lingering_group. Three coordinator
regressions pass on repaired source, including idempotence, immutable history,
audited-source and unsafe-evidence controls. The producer suite passes with
sentinels forbidding allocation, capacity, canary and provider execution on
source refusal, and post-mkdir/generic errors cannot claim negative admission.

The actual supported reconcile changed only reconciled_owners, kept all 13
UNVERIFIED outcomes and all original file hashes, and cleared only the smoke
launch latch. Independent read-only review found no blocking objection. This
proves custody retirement, not successful smoke execution or deployment;
those require their fresh frozen-source native receipts.

The first resume also exposed a quiescent final phase whose gate had never
started: refresh accepted unstarted quick phases but refused this equally
unstarted final boundary. A permanent regression failed on the original
refresh and passes after allowing this narrow state. Pending/running/resuming
phases and an already-started final phase still refuse; history and full-gate
requirements remain intact.

## Human feedback

None recorded.

## Reusable lesson

Emit a typed negative admission receipt at every audited pre-allocation refusal and keep custody retirement separate from test execution credit.
