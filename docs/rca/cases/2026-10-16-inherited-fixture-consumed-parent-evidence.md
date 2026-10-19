---
id: 2026-10-16-inherited-fixture-consumed-parent-evidence
date: 2026-10-16
title: Inherited preconfig tests received already-consumed handoff evidence
surface: infra
component: cloudbench-bootstrap-recovery-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/cloudbench-bootstrap-recovery.test.py CrossControllerColdHandoffTests.setUp
symptoms:
  - "FileNotFoundError: runtime-evidence-unconfirmed"
  - "CrossControllerColdHandoffTests"
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

The subclass setup prepared a consumed-handoff fixture and removed its preconfig latches before inherited parent tests ran. Those tests require the original unconsumed preconfig fixture; they therefore failed before reaching their intended assertions.

The first wrong state is inside the test fixture, before the production
contract under examination. No benchmark or native-provider failure is
attributed to this test bug. Archive searches for the exact missing-latch
and retain/quarantine symptoms found no matching case for this fixture boundary.

## Solution

Return after the parent setup for inherited test methods. Only subclass-owned handoff tests transition the fixture. Keep all inherited methods and assertions registered.

The identical focused command then passed all 37 tests, and the full existing
registered suite passed all 104 tests in 40.993 seconds. Existing assertions
and test count were preserved. There is no production behavior, provider
request, shared state, timeout, or 10,000-agent scaling change. The production
ownership guards remain fail-closed.

## Human feedback

The user required every error to receive RCA and identical registered RED-to-GREEN
verification. No failure was waived as pre-existing or unrelated.

## Reusable lesson

Keep inherited tests on the fixture state their assertions require; perform subclass-only state transitions only for subclass-owned tests.
