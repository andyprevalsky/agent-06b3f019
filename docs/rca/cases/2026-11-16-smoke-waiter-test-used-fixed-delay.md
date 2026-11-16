---
id: 2026-11-16-smoke-waiter-test-used-fixed-delay
date: 2026-11-16
title: A waiter regression used a fixed delay instead of an event boundary and failed the sleep ratchet
surface: harness
component: codex-smoke-waiter-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/code-session-merge-facts.blackbox.ts delayed the current turn end with a literal 30ms setTimeout
symptoms:
  - "FAIL: test files added fixed literal sleeps used as synchronization"
  - "code-session-merge-facts.blackbox.ts: 1 fixed literal sleeps, baseline 0"
  - "RatchetCase.test_current_tree_passes"
tags:
  - test-synchronization
  - websocket
  - fixed-sleep
sources:
  - PR #2290
  - commit 546e440154645f394ddb683bf6dd019fe8f44474
  - PR #2290 deploy gate deploy-command-structural, occurrence 6963913c123946998be741fd48bc9369
repro: scripts/tests/condition-waits.test.py RatchetCase.test_current_tree_passes
status: fixed
---

## Problem

The deploy structural gate rejected a newly added waiter regression because it
used a literal 30ms timer to release the current turn's end. The production
waiter change had passed its behavior test, but the regression violated the
repository's condition-based synchronization contract. The native test and its
single automatic rerun both failed; neither is hidden by later results.

## Diagnosis

Gate: INTRODUCED relative to main bd35eaed. The delay was added by the repair
candidate, not by the existing test. A local unchanged invocation of
`source agents/venv/bin/activate && python3 scripts/tests/condition-waits.test.py RatchetCase.test_current_tree_passes`
failed with exit1 and the same count1/baseline0 assertion. The fixture had used
elapsed time to separate old-turn completion from a new-turn terminal event.
It should establish that ordering through observable transport events.

An isolated real-WebSocket probe replaces the delay with a ping/pong barrier.
The pong follows the preceding frames; its handler emits the new turn end.
The identical probe fails against the older waiter (exit1, resolved before the
current turn ended) and passes against the repaired waiter (exit0), without a
fixed sleep or a changed timeout. This proves the proposed fixture still
catches the original waiter bug. The canonical regression now uses this barrier.

## Solution

After the frozen smoke source lease ended, replaced the timer with the
event-driven barrier. The identical ratchet invocation changed from exit 1
(9.483 seconds) to exit 0 (7.654 seconds). All 15 condition-wait tests passed
(10.346 seconds), and the owning backend domain passed 13/13. The isolated
real-WebSocket probe still rejects the older waiter and accepts the repair.
No timeout, assertion, concurrency setting, scanner or sleep baseline changed.
The full deployment gates remain required; this case is open pending shipping.

### Landed qualification (2026-11-16)

The event-barrier regression and unchanged ratchet checks landed in PR #2290,
merge cc7a39b2846aa385320386bbb1374e74c989e6a4. All 17 final native gates passed
on 96d12280, including the owning backend and structural gates. This closes the
fixed-delay test defect; it grants no broader production-lane credit.

## Human feedback

None recorded.

## Reusable lesson

Use a transport event barrier to establish regression ordering instead of delaying the event with a fixed timer.
