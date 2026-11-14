---
id: 2026-11-05-warm-stop-prerequisite-preceded-execution-provenance
date: 2026-11-05
title: Warm stopped-state prerequisite failed before execution provenance
surface: harness
component: deploy-test-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-fleet crosses resource admission before the shared-warm stopped prerequisite but publishes execution provenance afterward
symptoms:
  - warm source must be stopped before fleet provisioning
  - preallocation evidence absent from original adapter result
  - worker result identity/inventory mismatch
tags:
  - cloudbench
  - isolated-validation
  - retained-owner
sources:
  - commit 9dccd611b2d067139a4a379ecc2f5fc46006265d
repro: python3 scripts/tests/deploy-test-cycle.test.py Round14WarmIsolation
status: mitigated
---

## Problem

Round14 failed browser-smoke after 60 unchanged stopped-state checks. The owned
infra threshold cancelled nine siblings. All ten native controllers terminated,
and the original adapter/reference exist. Cleanup validation still requires
missing execution provenance or an authentic early-abort record. Resource
admission had already been crossed, so an early-abort exception cannot apply.

## Diagnosis

All ten original task logs reached the stopped-warm prerequisite before the
later snapshot/dependency/fresh-provisioning path. Exact original source,
request, adapter, source intent, patch, preallocation producer binding, native
lifecycle records, local/canonical audit hashes and inventories are retained.
The source intent is not executed-task provenance. Historical side effects are
not disproved by empty task inventories. Fresh same-instance guest observation
and complete local process/Hub identity checks establish execution exclusion.
Two current Hub records remain debt, alongside ce/e92 and six round12 records.

## Solution

Add one independently pinned round14 investigator admission, sharing the tested
live guest and local observation logic with round12 without changing the normal
cleanup validator. Return cleanup_complete=false, credit_granted=false and
obligations_preserved=true. Original failures and missing execution provenance
remain. Require all three inherited admissions before a fresh-token/root request.
Only a validated round14 entry explicitly naming a prior receipt may allow that
prior observation to be renewed; the normal full-successor validator is unchanged.
This preserves every obligation instead of claiming an incomplete successor passed.

The canonical source was not edited. The repair does not stop or resize the warm
machine. Parking requires all cloud owners terminal, fresh identity/guest checks,
exclusive maintenance ownership and native stopped/volume confirmation. A stop
with unchanged identity/config is supported by explicit observation renewal;
changed instance/configuration still blocks pending separate proof/review.
A general future producer should seal post-admission/pre-task phase and shared
resource custody into its original adapter, not manufacture historical aborts.
Delete/unify cannot reconstruct that missing historical authority. This narrow
legacy predicate is bounded to one exact source and original byte inventory.
Golden reference: not applicable (no approval-gated hunk).

## Human feedback

The user required current-owner resolution before any retry, no synthetic
adapter/provenance/abort, no cleanup or test credit, and preservation of all old
and new debt. Provider mutations, canonical edits and live gate reruns were
forbidden. Parent and independent review must precede integration.

## Reusable lesson

Prove current execution exclusion separately from historical cleanup, and retain every prior obligation when admitting an independently validated successor.

End-to-end synthetic reconcile/renew/request coverage found renewal incorrectly
required the prior occurrence to be the request token, although normal
reconciliation records a failure ID. For only the two pinned investigator
admissions, renewal now also accepts that exact retained UNVERIFIED failure ID
with matching gate/case. Missing or changed failure obligations still reject.
The test preserves all failures and four owner entries, rejects missing inherited
debt and a wrong adapter hash, and rejects reused token/root at next admission.
