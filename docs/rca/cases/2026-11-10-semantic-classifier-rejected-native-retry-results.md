---
id: 2026-11-10-semantic-classifier-rejected-native-retry-results
date: 2026-11-10
title: Semantic evidence classifier rejected the automatic retry results
surface: harness
component: deploy-test-semantic
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: classify_lane rejects two native result attempts although the deploy Playwright configuration enables one retry
symptoms:
  - semantic-stack UNVERIFIED
  - complete=false
  - len(results) != 1
tags:
  - playwright
  - retries
  - flaky
  - native-evidence
sources:
  - PR #1881
  - commit 4c698c1d2a85085ad0c82a6aa35de82b90c7fa37
repro: scripts/tests/deploy-test-semantic.test.py
status: mitigated
---

## Problem

The source-bound semantic run42745186364 produced55 expected and3 unexpected UI tests; every unexpected test failed both retry0 and retry1, and all5 latency cases passed. Its stack cleanup completed. The native adapter nevertheless retained3 UNVERIFIED units and an incomplete aggregate. The original request, result, receipt, reports, both attempts and native assertions remain unchanged; no completed-case waiver can be applied to that incomplete execution.

## Diagnosis

The first evidence-consumption failure is the single-result/retry0 predicate in classify_lane. The reporter supplies complete Before/After Hook and test lifecycle events for each native retry. Incoming main enabled one retry, while this consumer still required exactly one attempt. An unchanged recorded-report replay reproduces55 PASS and3 UNVERIFIED before the correction and55 PASS and3 FAIL after it. The product sidebar assertions are distinct failures, confirmed from their original traces; correcting classification does not repair or erase them.

Independent review found a second boundary in the initial candidate: classifying a retried pass as complete while trusting advisory live progress can lose FLAKY attribution during progress read failure or REST fallback. The authoritative final worker result must preserve that retry outcome. A local real Playwright fixture reproduced this without a browser, service, model or provider call; the original cycle opens no attribution when the advisory row is absent.

Archive searches for semantic adapters, single-attempt evidence and retry classification found related native-cleanup and canonical-seed incidents. Their cleanup/startup causes do not explain this complete native retry report; their lesson of preserving unknowns until evidence is complete still applies.

## Solution

Accept only one complete attempt0 or two ordered complete attempts0,1, with retry1 following a failed or timed-out attempt. Each attempt must independently corroborate both successful hooks and matching begin/end/status events. Missing, duplicated, interrupted, contradictory or extra attempts remain UNVERIFIED. A final assertion failure remains FAIL.

For a verified retried pass, derive FLAKY metadata from the final native report, retaining the original first error, actual final-result timestamp, reporter-compatible unit and attempts2. Carry it in the source/token/recipe-bound final worker evidence. Validate it before the coordinator accepts the result, merge it with advisory rows by case/unit, and point the attribution request to the retained worker result. Missing live progress no longer removes the existing merge-blocking attribution requirement. Foreign or malformed final metadata rejects a complete pass. Native report bytes, retries, assertions, deadlines, selected inventory, worker concurrency and cleanup/source guards do not change.

Both existing owning suites pass33 tests against the candidate, and six added regressions pass five unchanged runs. The real no-browser Playwright fixture plus actual candidate cycle retains exactly one FLAKY occurrence and blocks completion after deleting live progress. The original cycle fails the same final-evidence integration assertions. Full source-bound native validation remains required after integration; this case is mitigated, not proof of a passing semantic aggregate.

## Human feedback

None recorded for this adapter repair. Existing instructions require keeping real failed attempts and FLAKY attribution; passing a rerun is not a clean original PASS.

## Reusable lesson

When a runner adds retries, update its strict evidence consumer and preserve authoritative final retry attribution independently of best-effort progress delivery.
