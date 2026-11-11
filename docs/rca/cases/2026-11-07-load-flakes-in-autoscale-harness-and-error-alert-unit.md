---
id: 2026-11-07-load-flakes-in-autoscale-harness-and-error-alert-unit
date: 2026-11-07
title: Two timing-dependent tests failed only under the staged cycle's host load, one by leaving a fixture child alive and one by a fixed 30 ms sleep
surface: cross
component: deploy-test-cycle
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: cloudbench-acceptance-autoscale.test.sh's finalization harness returned while its first fixture was still inside a trailing sleep, and error-alert.test.ts step 5 sent its retry alert after a fixed 30 ms before the DB-backed throttle slot of the rejected alert was released
symptoms:
  - "cloudbench-controller autoscale step: native_exit 0 with orphaned_children true, reaped pid 2254548 with SIGTERM, gate UNVERIFIED"
  - "AssertionError: a rejected transport remains immediately retryable 0 !== 1 at error-alert.test.ts:145"
tags:
  - load-flake
  - supervisor-orphans
  - error-alert
sources:
  - PR #1744
repro: BACKEND_UNIT_TEST_FILES=error-alert.test.ts BACKEND_UNIT_DATABASE_URL=<local victoria_*> npm run test:unit (green three times after); the autoscale orphan was not reproduced on a quiet host in 16 harness runs
status: mitigated
---

## Problem

The first staged cycle on this branch reported the cloudbench-controller gate UNVERIFIED (its autoscale step passed but a child was
still alive when the supervisor looked) and the backend gate FAIL on the error-alert unit. Both files are byte-identical to main,
so both are NOT_INTRODUCED; both only appeared with nine controllers and five gates sharing the host.

## Diagnosis

The autoscale harness starts `( sleep 1.5; touch marker; sleep 0.5 ) &`, and `wait_for_autoscaler_finalization` returns as soon as
the marker exists, so the 0.5 s tail is still running when the second scenario starts; the harness then exits without reaping.
Whether it survives to the supervisor's check depends on scheduler timing, which a quiet host did not reproduce, so the mechanism is
probable, not proven. The error-alert step sent its retry alert 30 ms after the first one; that alert is throttled by design until the
rejected one releases its DB-backed slot, which under coverage load takes longer than 30 ms. The same file already waits for DB-backed
alerts elsewhere (965941fbd).

## Solution

The harness ends with `wait` so no fixture outlives it. The error-alert step now sends the identical alert until one lands (bounded at
40 tries 50 ms apart) and still fails when a rejection spends the slot for good. Status is mitigated: the orphan cause stays an open
observability gap until it recurs with the supervisor receipt.

## Human feedback

None; found by the staged deploy cycle of PR #1744.

## Reusable lesson

Test fixtures that background work must reap it before they return, and a fixed sleep before a DB-backed effect is a load flake.

### Recurrence — November 11, 2026

The iPhone access-request `/push` full backend coverage run reproduced an earlier boundary in step 5: `the first alert reached the rejecting transport`, `0 !== 1` at line 147. The first rejected transport had not run after the fixed 30 ms sleep, before the existing retry-release guard was reached. Native evidence is retained in `.context/iphone-access-backend-coverage-final.log` and `.context/iphone-access-coverage-failed-073654/`; the failed run was terminated through its owned runner for disk capacity, with closed raw evidence preserved losslessly.

Reuse the independently reviewed three-line barrier from published commit `0cb3184d956a30ae32a0f77b24986fa4d448bc6d`: collect rejection events and use the existing bounded `waitForCalls` helper before the unchanged rejection-count assertion. This completes the missing precondition of the prior guard without changing product alert behavior, timeout constants or assertions. The focused alert test passed after the barrier; final full-gate outcomes belong to the access-request push receipt.
