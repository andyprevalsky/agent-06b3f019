---
id: 2026-08-03-gate-resolution-transaction-fan-in
date: 2026-08-03
title: Gate resolution exhausted its interactive transaction while redundant reads and agent-wide lifecycle locks queued under concurrent coverage load
surface: back-end
component: agent-attention-requests
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/gateResolution.ts resolveAndSignal and back-end/src/providers/toolLifecycleMessages.ts persistLockedToolLifecycleMessage
symptoms:
  - "Transaction already closed: A query cannot be executed on an expired transaction"
  - "Transaction API error: Transaction not found"
  - "auth-looking metadata without child row responds generically" returned 500
  - "repeat respond preserves first terminal response" returned 500
tags:
  - approvals
  - prisma
  - advisory-locks
  - transaction-timeout
  - concurrency
sources:
  - PR #924
repro: back-end attention-request blackbox under canonical test:coverage concurrency plus back-end/src/tests/unit/workflow-generation-locks.test.ts and workflow-restart-tools.test.ts
status: fixed
---

## Problem

The canonical backend coverage gate passed 114 of 115 blackbox domains but the
attention-request domain returned 500 for 2 of 36 cases. In
`back-end/coverage/server.log`, request `4a9b6b9d8cbc` entered
`POST /attention-requests/:id/respond`, spent 1.196 seconds in the conditional
request update and 3.840 seconds re-reading that request, then failed its first
message query after the five-second interactive transaction had already elapsed.
Request `0ede8e00a345` failed the same way after its request update consumed 3.840
seconds and the following read reached 5.022 seconds. A focused concurrency unit
run also exposed the sibling lock problem as `Transaction API error: Transaction
not found` while 24 distinct tool calls for one agent resolved together.

## Diagnosis

Both failures entered healthy routes and authenticated successfully, so the
first bad boundary was the atomic gate/lifecycle persistence transaction. Gate
resolution performed a conditional `updateMany`, re-read the same request with
`findUnique`, selected matching message rows, then re-read every message before
updating it. Under the coverage gate's concurrent database load, those redundant
round trips spent the transaction's entire deadline before the required read
model transition completed.

The unit failure exposed the deeper concurrency class: every lifecycle write
took the same *exclusive* workflow-generation advisory lock even when the writes
belonged to different tool calls. The 24 interactive transactions therefore
started together but queued behind one agent-wide lock; their deadlines elapsed
while waiting. The tool-call-specific exclusive advisory lock already provides
the required same-call serialization. The generation lock only needs to exclude
a deployment cutover, so making ordinary writes mutually exclusive was stricter
than the consistency contract and created avoidable fan-in.

## Solution

`resolveAndSignal` now claims and returns the unresolved attention request with
one conditional `UPDATE ... RETURNING`, eliminating the redundant request read.
It acquires the generation lock before touching the attention row, matching
deployment cleanup's lock order and preventing an attention-row/generation-lock
ABBA deadlock.
`finishAttentionMessages` locks the agent generation once, keeps the per-tool
lock, and compare-and-swaps each selected metadata snapshot with `updateMany`
instead of re-reading every row. This preserves the request/message atomic commit
and still signals Temporal only after commit.

Lifecycle persistence now takes a shared workflow-generation advisory lock.
Independent tool calls can proceed together, while deployment cutovers retain
the exclusive version of the same lock and therefore still fence all in-flight
writes. Each tool call retains its own exclusive lifecycle lock, preserving its
single-terminal-result invariant. At 10,000 agents, locks remain keyed per agent
and per tool call; there is no global queue, scan, or coordinator, and database
work is proportional only to the responding request and that agent's matching
pending messages. A single gate with many Temporal waiters still has its
pre-existing per-gate waiter list and sequential signaling cost; this change
removes cross-tool and cross-agent fan-in rather than claiming that one hot gate
is constant-time.

## Human feedback

The adversarial review rejected the first lock-order attempt because gate
resolution took the attention row before the generation lock while deployment
cleanup used the inverse order. It required generation-lock-first ordering plus
deterministic shared/exclusive compatibility and persisted-request race tests.

## Reusable lesson

When an atomic write path expires under load, remove redundant round trips and
match advisory-lock scope to the actual invariant before considering a larger
timeout.
