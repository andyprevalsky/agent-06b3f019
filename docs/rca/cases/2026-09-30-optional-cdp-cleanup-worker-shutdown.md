---
id: 2026-09-30-optional-cdp-cleanup-worker-shutdown
date: 2026-09-30
title: Optional CDP timeout retention collided with strict worker shutdown ownership
surface: agents
component: browser-cleanup-worker-ownership
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: optional CDP cleanup retained unnamed expired tasks in the recording cleanup set
symptoms:
  - "Worker shutdown left unrelated tasks pending"
  - "Expired CDP children consumed another recording drain"
tags:
  - browser-cleanup
  - cdp
  - worker-shutdown
  - main-integration
sources:
  - PR #1299
  - commit 06f714328
repro: agents/tests/blackbox/worker.blackbox.py
status: mitigated
---

## Problem

Integrating current main introduced optional, non-raising CDP cleanup into the
branch's strict worker shutdown owner. Main retained cancellation-resistant CDP
children to retrieve late exceptions. These unnamed children failed the branch's
unrelated-task shutdown check and spent another default 65 seconds in the drain
intended for recording and provider cleanup. This was found before allocating
the next acceptance slice; the source-bound campaign was retired with zero credit.

## Diagnosis

Independent review ran the exact main helper with the existing worker owner:
an unnamed cancellation-resistant child exited 1; giving only that child the
existing terminal-I/O ownership prefix exited 0. A separate owning drain
reproduction consumed 121 ms under a 120 ms test bound; excluding expired CDP
children returned immediately. Actual recording tasks were still drained.

The permanent subprocess blackbox combines the public optional disconnect,
recording cleanup, the real shutdown drain and the real worker loop. It failed
on the unpatched integrated source. The unchanged test passed after the fix,
alongside the three existing strict shutdown regressions. Private runtime logs
remain outside the archive.

Archive searches were `Worker shutdown left unrelated tasks pending CDP` and
`background browser cleanup drain timed out`. They reinforce the existing
ownership principle: bounded CDP calls cannot waive recording/provider proof.

## Solution

Retain both policies: main's non-raising public capture/disconnect for attention
handoffs, and the branch's strict terminal primitive for resource teardown.
Name optional children `browser-terminal-io:optional-cdp-cleanup`. Keep strong
references after timeout, but exclude that exact expired child name from the
recording/resource drain. The bounded event-loop owner closes it later.

The permanent regression asserts recording actually finishes, rejects a second
CDP drain, and requires successful process exit. Existing unrelated pending
work rejection remains unchanged. Independent re-review ran all four worker
regressions successfully and found no blockers. Final-source live fleet proof
remains outstanding, so this case is mitigated pending that verification.

### 2026-10-01 review recurrence: preserve the original failure

CodeRabbit finding 4151506563 identified a second failure precedence issue in
this same loop owner. The permanent `worker` blackbox now creates an unrelated,
cancellation-resistant task and raises an original worker error. On unchanged
runtime, the test failed in 0.53 seconds because shutdown replaced that error
with its pending-task RuntimeError. The identical test passed in 0.45 seconds
after preserving the original exception and logging the shutdown violation.
Clean worker returns with unrelated pending work still fail closed.

The earlier tests covered clean returns plus abandoned CDP work, but never the
combination of a worker failure and a cleanup failure. This recurrence extends
that existing owning suite; it adds no model requests or live benchmark stage.
The new behavior stores one exception per worker and performs the same bounded
shutdown work, independent of the number of agents.

Archive searches were `Worker shutdown pending metrics poller` and
`supervisor teardown receipt cleanup signal`. Private unchanged RED/GREEN
receipts are `.context/acceptance/proof84-worker-review-{red,green}.receipt.json`;
the exact command activates `agents/venv`, runs from `agents/`, and invokes
`test_worker_event_loop_preserves_primary_failure_during_bad_shutdown` from
`tests/blackbox/worker.blackbox.py`. Registration is in that file's
`run_all_tests`, exercised by `python scripts/run_blackbox_tests.py worker`.
The live fleet outcome requirement remains open.

## Human feedback

Continue autonomously, preserve genuine evidence and exact-owner teardown,
and reset the task pool whenever restarting from slice zero.

## Reusable lesson

When integrating two cleanup layers, check task identity and which drain owns
each child. Retaining exceptions must not transfer expired optional I/O into
the recording/provider cleanup budget.
