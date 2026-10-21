---
id: 2026-10-21-browser-observation-replay-order
date: 2026-10-21
title: Older replay rows could replace newer Browser URL and model labels
surface: front-end
component: latestBrowserTaskValue
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Browser label readers treated array append order as observation time
symptoms:
  - Browser address or model reverts after older replay data arrives
tags:
  - browser
  - realtime
  - replay-order
sources:
  - agent ph72t0bddfe98xg6ytzjxscx8n8gnyfx
  - agent ph7erx59v4y5qfrxncmmtzzkfn8gngm8
repro: front-end/src/tests/structural/browser-task-replay-order.test.ts
status: fixed
---

## Problem

Release review identified that realtime hydration can append older rows after
newer observations. The new Browser model reader and existing URL reader both
scanned the array backwards. A local unchanged reproduction failed both tests:
a later-appended replay row replaced the newer URL/model; an invalid timestamp
row replaced a dated observation. This is a reproduced reader defect, not proof
that replay ordering caused the user's original Connecting label or missing UI
updates. The separate URL producer fix addresses absent persisted observations.

## Diagnosis

The reader equated array position with event time. Its exact-task filter was
correct, but replay append order is not a chronology guarantee. Existing
terminal reconnect behavior preserves replay messages rather than sorting them
for these readers. The first bad boundary is the pure label selection function.

## Solution

One shared linear scan selects the newest valid timestamp among matching-task
rows that contain a usable value. Equal timestamps use stable last-row order.
When no matching candidate has a valid timestamp, retain the prior stable
last-row fallback. URL and actual model remain field-specific and never consume
sibling task data. No subscriptions, polling, database or provider work is added.

The owning unchanged command is `vitest run
src/tests/structural/browser-task-replay-order.test.ts --maxWorkers=1
--no-file-parallelism`, from front-end. Original 2/2 failures are retained at
/dev/shm/rose-websocket-rca/replay-red.log; final focused receipt is
/dev/shm/rose-websocket-rca/final-focused.log.

## Human feedback

The user reported a missing Browser URL and requested the actual Browser task's
model pinned in its composer. Code Main requested replay-safe selection during
source review. No additional user diagnosis is inferred.

## Reusable lesson

Choose observed UI state by event time, not replay append order; scope it to the
exact task and retain a documented fallback for legacy undated records.
