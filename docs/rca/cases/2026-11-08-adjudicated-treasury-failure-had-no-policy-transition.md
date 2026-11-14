---
id: 2026-11-08-adjudicated-treasury-failure-had-no-policy-transition
date: 2026-11-08
title: Adjudicated treasury failure had no native standing-policy transition
surface: harness
component: deploy-test-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: triage refused an already adjudicated original FAIL while standing-skip accepted only the native Claude policy
symptoms:
  - no failures awaiting RCA
  - standing skip requires the selected native cloud Claude check
tags:
  - deploy-cycle
  - treasury
  - standing-policy
  - native-evidence
sources:
  - commit 5809574d5e0323fb2f285ce34746f955acde7593
  - task .context/cli-nov08-user-sync/stall-review.json
repro: python3 scripts/tests/deploy-test-cycle.test.py TreasuryRequalification
status: open
---

## Problem

The standing treasury warning policy applied to an already executed, complete treasury FAIL, but its original occurrence was adjudicated under an earlier assigned-repair instruction. It was no longer pending. Native triage on an untouched copy of the actual607-failure state returned no failures awaiting RCA. The separate standing-skip action supported only the native Claude policy. Rerunning treasury is not a read-only workaround: its recovery path can mutate financial state.

## Diagnosis

Gate: NOT_INTRODUCED at the compared7c93/580 triage and standing-skip boundaries. The missing transition became necessary when the applicable user policy changed; attribution does not drop the assigned repair. The exact original occurrence c8030a32b60c477c950713a16331d78a and original source remain retained. Its native receipt records a complete treasury FAIL even though other backend cases left the aggregate incomplete. The copied current state remains bound to7c93; a call against current9fa correctly refuses its stale source. No source or phase was manually relabelled.

## Solution

Extend the existing standing-skip action only for this typed treasury policy transition. Require the current selected native backend contract, quiescent repair state, exact source/environment/plan/input binding, and the original complete assigned FAIL. Re-read the uniquely anchored native receipt and hash-bound request/result/log plus policy evidence. Preserve the original failure, RCA, attempts, phase and repair routing. Store only the current warning in existing skips; the full backend still runs every other case. Existing decision and refresh/adjudication renewal semantics remain responsible for the policy, with the original proof retained and revalidated after renewal.

Deterministic controls reproduce the old refusal, accept the current action, retain original records and reject unknown check/occurrence, incomplete or changed native facts, wrong source/command, stale plan/input, future or unknown policy, running state and tampered files. Existing treasury warning and renewal controls remain passing. The actual retained native bundle validates offline; its current action remains correctly blocked pending a real native source refresh. No financial release, cleanup or test PASS is inferred from this bookkeeping action.

## Human feedback

The parent task required no financial/provider/DB actions, no manual cycle edits, preservation of607 failures, seven cloud and six unpaid obligations, and reuse of existing decision/renewal/backend exclusion contracts. Parent owns integration and the real source refresh. The E2B review is separate.

## Reusable lesson

Provide an evidence-bound policy transition for an existing native result without rewriting its historical outcome or rerunning side-effecting work.
