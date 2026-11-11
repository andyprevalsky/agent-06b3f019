---
id: 2026-11-10-cleanup-test-observer-shared-controller-group
date: 2026-11-10
title: Cleanup PID fixture included its own short-lived process collector
surface: harness
component: deploy-test-cycle
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The replacement-controller fixture used the observing test PID as its own process group
symptoms:
  - "native cleanup: prior native proof changed"
  - "test_cleanup_review_retired_pid_reuse_and_exact_live_identity"
tags:
  - deploy
  - cleanup
  - process-group
sources:
  - commit cc11dc60c2db1b1a2869425bd2f07ce0a7662831
  - PR #1905
repro: scripts/tests/deploy-test-cycle.test.py
status: open
---

## Problem

The unchanged native structural gate ran all 426 cycle tests, then automatically reran the single failed test. Both executions errored at the prior-proof guard. The gate remains FAILED. GitHub run 42772271615 recorded the full suite in 101.511 seconds and the one-test rerun in 0.187 seconds. The test and runtime guard were introduced in cc11 relative to e74943e655e50b910c4a35cb011fdd927e28d513.

## Diagnosis

The structural runner starts each test unit in its own session. The fixture treated that observing Python process as the replacement controller. Its process-list collector shared the tested group, included itself in its snapshot, and exited before the subsequent immutable-birth read. Actual local tracing identified the exact collector PID and FileNotFoundError; the guard conservatively refused the proof. Original assertions pass under an inherited group and fail under the native own-session launch. A separate real controller group passes under that same own-session launch. No CI contention or external-provider cause is claimed.

## Solution

The privately validated correction owns a real stdin-held helper in a distinct session and uses its exact PID and birth for both stale-original and exact-live controls. All four original assertion ASTs remain unchanged; three explicit fixture-ownership and EOF/join assertions are added. The production process guard is unchanged. The same corrected fixture passed under inherited and own-session launches. The complete existing 426-test candidate suite passed in 154.898 seconds with the standard temporary-directory environment. An earlier custom temporary-directory attempt violated existing strict path contracts; the unchanged baseline reproduced that operator error and the standard-environment control passed.

The correction is now integrated into the combined candidate. The full existing owning suite, including new recovery controls, passed 438 tests in 155.610 seconds with unchanged source hashes; independent review passed. Native structural acceptance and deployment remain pending. This correction does not repair the production availability edge where an unrelated group member disappears between snapshot and birth read. Unknown identity, actual older live members and missing original birth remain fail-closed. Archive searches and precise causal receipts are retained privately; no raw process logs or secrets are published here. Golden reference: not applicable; no approval-gated behavior change.

## Human feedback

Preserve assertions, deadlines, concurrency, authentic original evidence, privacy guards and protected instructions. Do not manufacture a pass or weaken cleanup guards to finish deployment.

## Reusable lesson

Give process-ownership fixtures a separate real controller group from their observer.
