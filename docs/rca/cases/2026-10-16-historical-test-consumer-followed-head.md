---
id: 2026-10-16-historical-test-consumer-followed-head
date: 2026-10-16
title: Historical cleanup test accidentally executed the current consumer
surface: infra
component: cloudbench-bootstrap-recovery-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/cloudbench-bootstrap-recovery.test.py test_older_cleanup_policy_consumer_keeps_source_retained
symptoms:
  - "AssertionError: 'quarantined' != 'retain'"
  - "test_older_cleanup_policy_consumer_keeps_source_retained"
tags:
  - cloudbench
  - test-fixture
sources:
  - PR #1525
  - commit 5011dff116a29f0c966d5cedbac9984e601ba513
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py CrossControllerColdHandoffTests
status: fixed
---

## Problem

The full registered bootstrap-recovery suite exposed this test failure while
verifying the process-scan deadline fix. It reproduced under the required
activated Python 3.11.9 environment; this was not a Python-version difference.
The focused command `python3 scripts/tests/cloudbench-bootstrap-recovery.test.py
PreconfigStartupArchiveTests CrossControllerColdHandoffTests -v` initially ran 37 tests with 18 errors and
one failure across the two independently identified fixture defects.
Original output is retained in the private continuation `scan-timer-rca` directory.

## Diagnosis

The test named an older cleanup consumer but loaded run-bench-fleet from current HEAD. The current consumer correctly recognizes a cold handoff and returns quarantined. Treating that stronger current behavior as the old contract made the history test unstable after the handoff feature landed.

The first wrong state is inside the test fixture, before the production
contract under examination. No benchmark or native-provider failure is
attributed to this test bug. Archive searches for the exact missing-latch
and retain/quarantine symptoms found no matching case for this fixture boundary.

## Solution

Embed the exact historical 16-line consumer from commit 9b2447b4deb33c3f15aa3d83d674eecf8c387146, bound by SHA256 f3e48015335510aef80e0e53602a93bf2cf9e6708cea63ebff620415cce7f029. Retain the older retain assertion and additionally assert the current consumer returns quarantined. The fixture requires no unavailable Git objects in shallow checkouts.

The identical focused command then passed all 37 tests, and the full existing
registered suite passed all 104 tests in 40.993 seconds. Existing assertions
and test count were preserved. There is no production behavior, provider
request, shared state, timeout, or 10,000-agent scaling change. The production
ownership guards remain fail-closed.

## Human feedback

The user required every error to receive RCA and identical registered RED-to-GREEN
verification. No failure was waived as pre-existing or unrelated.

## Reusable lesson

Bind historical behavior tests to immutable historical bytes, and test the current contract independently.
