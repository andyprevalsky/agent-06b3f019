---
id: 2026-11-16-catalog-refusal-retained-launch-custody
date: 2026-11-16
title: Historical catalog preflight refusal retained launch custody without a result
surface: harness
component: deploy-cloud-preflight-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: catalog ValueError returned before result publication while the native-producer cycle retained unknown ownership
symptoms:
  - missing complete case receipt
  - lingering_group
  - "cloud source refusal: unaudited legacy source"
tags:
  - deploy
  - custody
  - preflight
  - process-ownership
sources:
  - PR #2411
  - commit c04bacf96b8293782ec8810fed66561448f6a289
repro: scripts/tests/deploy-test-cycle.test.py (Cycle.test_catalog_refusal_preserves_outcomes_and_retires_only_launch_custody)
status: open
---

## Problem

The original smoke native producer returned2 when its strict catalog reader
rejected duplicate quarantine metadata. It exited before namespace creation,
capacity admission or any provider call, and published no result.json. The
cycle correctly failed closed: seven outcomes UNVERIFIED and retained launch
custody. Existing reconciliation supported different exact historical source
refusals, but refused this capture as an unaudited legacy source. Ordinary
refresh/retry therefore remained blocked even after all native processes ended.

## Diagnosis

Immutable sourcec04bacf96b, request f7bbc7bc6f1441d987a1539684cf0d55 and native
receipt are captured under .context/rca-147bb3eb/smoke-watch. The original
reader replay reproduces the exact refusal before admission; namespace and
result are absent. No campaign or fleet handle was emitted. This is no proof
of test execution, provider cleanup, or settled funds.

The original validator fails the new permanent acceptance assertion with
unaudited legacy source. The reviewed extension passes the identical assertion
and rejects modified source, request, output, reader, contract, timeout,
cancellation, admitted namespace, result, UID and observer failure. Review
caught real root/boxes visibility gaps: single-UID scans could miss a foreign
file holder or namespace consumer. The final capture-specific observer checks
both original root and checkout UID1002, failing closed on unavailable evidence.
The real cross-UID file-holder assertion fails a mutation removing its guard.
Five unchanged eleven-case runs pass, retaining the old source/legacy controls.

## Solution

Extend the existing historical refusal validator for this one pinned capture,
including original producer/import hashes, request/receipt hashes, exact old
parent admission identity, unchanged execution contract, actual strict-reader
replay and absent namespace/result. Reuse normal reconciliation with fresh
holder observations under root. All later retained-owner checks also require
root because they repeat validation. Other deployments cannot reuse this
capture-specific proof.

The entry retires launch custody only and explicitly grants no test or financial
credit. Original FAIL, seven UNVERIFIED outcomes, lingering_group=true and no
result remain immutable. No synthetic result, altered receipt, state reset,
provider retry or generalized string allowance is permitted. Regression lives
in the registered deploy-test-cycle owning suite. Golden reference is not
applicable: ordinary operational validation, no model-visible change. Live
reconciliation and deployment remain pending.

## Human feedback

The user required completing deployment. No user authorized relaxing outcome,
resource, benchmark or financial requirements.

## Reusable lesson

Preserve exact failed native outcomes while separately proving pre-admission launch custody, with observation across every original process owner.
