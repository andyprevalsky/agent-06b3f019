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

## Human feedback

Continue autonomously, preserve genuine evidence and exact-owner teardown,
and reset the task pool whenever restarting from slice zero.

## Reusable lesson

When integrating two cleanup layers, check task identity and which drain owns
each child. Retaining exceptions must not transfer expired optional I/O into
the recording/provider cleanup budget.
