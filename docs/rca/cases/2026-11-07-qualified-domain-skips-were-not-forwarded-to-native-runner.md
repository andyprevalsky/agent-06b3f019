---
id: 2026-11-07-qualified-domain-skips-were-not-forwarded-to-native-runner
date: 2026-11-07
title: Qualified domain exclusions were accounted but not forwarded to the native runner
surface: infra
component: scripts/deploy_test_backend.py
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: backend adapter validates qualified domain exclusions but launches the native runner without its two domain skip environment variables
symptoms:
  - Native treasury domain executes again after its standing-policy exclusion is qualified
  - Wrapper completion is zero while the preserved native sweep exit is one
tags:
  - staged-deploy-cycle
  - treasury
  - native-runner
sources:
  - PR #1716
repro: scripts/tests/deploy-test-worker.test.py
status: fixed
---

## Problem

Gate: INTRODUCED. The backend adapter's new qualification accounting excluded
the treasury row from required results but did not pass that exclusion to the
native coverage runner. The Nov7 failed-gates run therefore executed treasury
again, including its native recovery attempts. Its raw exit 1 remains recorded;
249 passing constituents and one qualified SKIP do not change that native exit.
The standing policy skips treasury failures with a warning and grants no
financial settlement credit.

## Diagnosis

An owning test intercepts the actual run_command environment. The qualified
request reaches it with neither BLACKBOX_TEST_SKIP_DOMAINS nor
CONTRACT_TEST_SKIP_DOMAINS set. This test is RED before the adapter correction.
The native runner already supports both variables; the missing boundary is
between trusted request qualification and native execution.

## Solution

After rejecting caller, sweep and setup skip-variable injection, derive both
native variables from the fixed integration-health exclusion and validated
qualified domain names. Leave requests without qualified exclusions unchanged.
The same owning command passes after the correction; all 25 Backend tests pass.
Peer failures retain FAIL/native exit 1, qualifications are not mutated, and
both variables reject untrusted injection before native launch. The existing
legacy excluded-row accounting remains covered. Ruff reports the same eleven
baseline findings with no new finding; no unrelated lint changes were made.

Approval: not applicable (no approval-gated hunk).

## Human feedback

The user required completing deployment. The earlier claim that the native
treasury domain was excluded was corrected when the raw run proved otherwise.
Three unresolved sandbox mints remain financial follow-up, not returned funds.

## Reusable lesson

Accounting for an authorized exclusion does not enforce it. Test the native
launch environment and retain raw native outcomes alongside qualified results.
