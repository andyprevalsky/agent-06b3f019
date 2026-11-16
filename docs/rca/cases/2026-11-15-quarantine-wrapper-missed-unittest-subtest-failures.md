---
id: 2026-11-15-quarantine-wrapper-missed-unittest-subtest-failures
date: 2026-11-15
title: The @quarantine wrapper reported QUARANTINED_PASS while a failing unittest subTest inside the method still failed the file
surface: harness
component: test-quarantine
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "scripts/lib/test_quarantine.py:quarantine.run_sync — relied on an exception escaping the test method, but unittest.subTest() records a failing block on the result and swallows it, so the wrapper saw a normal return"
symptoms:
  - "TEST_QUARANTINE status=QUARANTINED_PASS unit=CohortReconciliation.test_campaign_noop_and_mutation_share_the_completed_barrier"
  - "FAILED (failures=1)"
  - "(mutated=True)"
tags:
  - test-quarantine
  - unittest
  - subtest
  - deploy-gate
sources:
  - PR #2104
  - commit cf458ba660fa059c2378e7c545ce3275fe3646f2
repro: scripts/tests/test-quarantine.test.py
status: fixed
---

## Problem

After PR #2104 quarantined `test_campaign_noop_and_mutation_share_the_completed_barrier`
(occurrence `b7248ac5`), the file still exited 1 whenever its `mutated=True`
subtest failed, and the same log printed
`TEST_QUARANTINE status=QUARANTINED_PASS` for the method. Seen in local load-repro
runs 18 and 23 on main `31641a6709`. The marker's contract ("its failure never
fails the run") did not hold, and the progress row misreported a pass.

## Diagnosis

1. The wrapper calls the method and classifies on whether an exception escaped.
2. Inside `with self.subTest(...)`, unittest's `_Outcome.testPartExecutor(subTest=True)`
   catches the assertion, calls `result.addSubTest(..., exc_info)` and marks the
   outcome failed without re-raising.
3. The method returns normally, the wrapper records `QUARANTINED_PASS`, and the
   recorded subtest failure fails the run.

Proof: the extended `scripts/tests/test-quarantine.test.py` adds a quarantined
`test_subtest_fails` (one of three subtests fails) and `test_subtests_pass`. On
main's helper the child suite exits 1 with `FAIL: test_subtest_fails (...) (value=2)`;
on the fix it exits 0 and reports QUARANTINED_FAIL with the subtest parameters.

## Solution

While a quarantined unittest method runs, the wrapper wraps the instance's
`subTest`. Each block still runs under the original `subTest`, so skips stay
subtest skips. A non-passthrough failure is collected instead of being recorded
on the result, and later blocks still run. After the method returns, collected
failures are reported as one QUARANTINED_FAIL (an exception group when there
are several). The wrapper is removed afterwards. Sync and async methods share
the path.

## Human feedback

None recorded.

## Reusable lesson

A wrapper that classifies a test by whether an exception escaped must also intercept unittest subTest blocks, which record failures without raising.
