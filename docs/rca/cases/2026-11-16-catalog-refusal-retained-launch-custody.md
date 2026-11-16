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
  - commit 562cc8c49008708918d15ee9844ab1c8c333062c
  - PR #2411
  - commit c04bacf96b8293782ec8810fed66561448f6a289
repro: scripts/tests/deploy-test-cycle.test.py (Cycle.test_catalog_refusal_preserves_outcomes_and_retires_only_launch_custody)
status: fixed
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
applicable: ordinary operational validation, no model-visible change. Live reconciliation and production verification subsequently completed as recorded below.

## Human feedback

The user required completing deployment. No user authorized relaxing outcome,
resource, benchmark or financial requirements.

## Reusable lesson

Preserve exact failed native outcomes while separately proving pre-admission launch custody, with observation across every original process owner.

## PR2411 delivery evidence

PR #2411 merged as `562cc8c49008708918d15ee9844ab1c8c333062c`.
The original failures and reproduction assertions above remain unchanged
historical evidence. Frozen source `4a9d224abd5bf5ab1770237f2a8097762938a876`,
digest `882008a4bc15beb817e758c96fd6fcabb8c9fddfcfd52454d9877be30fab17c0`,
passed all 17 selected native deploy gates. The original cycle and report
are preserved under `.context/rca-147bb3eb/validated-4a9/` and
`validated-4a9-report.log`; the report command exited 0.

The first production attempt failed semantic workflow dispatch with HTTP401
at 20:22:58 UTC before creating any workflow run. Its original FAIL and null
run identity remain in `.context/rca-147bb3eb/production-first-attempt/` and
the final production receipt's semantic_history. Render, Vercel, backend probes
and Mac release passed. The credential CLI repair was separately validated
and pushed as operations commit `6e2496487add55f3416737566873573528474fd3`;
its 91-test `/push` is not PR2411's 17-gate full deploy.

The normal semantic-only retry exited 0 at 2026-11-16T20:48:30Z. Run
[43951508861](https://github.com/Rose-Ai-Labs/rose/actions/runs/43951508861)
completed all five jobs successfully. It is **PASS-verified-by-descendant**,
not an exact-source PASS: target product merge is562cc8, effective live frontend
and tested specification source is `1ec28940191764ecf435ffc38b345006269bc95b`,
and workflow execution head is6e2496487add55f3416737566873573528474fd3.
The final `.context/deploy-pipeline/production-lanes.json` records all
applicable lanes satisfied: exact562cc8 Render/Vercel, backend probes, Mac
run43946926015 (v1.1.355), and descendant-verified semantic. Fly, WMH,
workflow migration and AgentCard remain SKIPPED-not-applicable, never PASS.
The native finish command exited0 at20:49:05Z. This resolves this repaired
boundary's delivery; it does not certify unrelated runtime repairs, original
paused-session recovery, marker release or whole-workspace deletion readiness.


Native reconciliation subsequently exited 0 at 18:41:09 UTC; see
`.context/rca-147bb3eb/custody-native-reconcile-exit.json` and
`custody-live-proof.json`. The frozen cycle's reconciled_owners entry for
request f7bbc7bc6f1441d987a1539684cf0d55 records
credit_granted=false, financial_cleanup_credit=false and
original_outcomes_preserved=true. This resolves that pre-admission launch
custody only. The original exit2, seven UNVERIFIED outcomes, absent result
and lingering_group record remain intact; the later smoke pass is a distinct
execution. No provider or financial cleanup credit follows from reconciliation.
