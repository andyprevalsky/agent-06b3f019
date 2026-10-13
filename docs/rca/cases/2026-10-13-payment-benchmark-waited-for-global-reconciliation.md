---
id: 2026-10-13-payment-benchmark-waited-for-global-reconciliation
date: 2026-10-13
title: Payment benchmark observed pending cleanup without resuming its owned reconciliation
surface: harness
component: benchmark-payment-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Both production benchmark callers waited with GET-only observations after an accepted abandonment left funding RECLAIMING
symptoms:
  - "Payment lifecycle did not reach the expected terminal state before timeout"
  - "expected VOIDED, got HELD despite a closed card and reclaimed provider transfer"
  - "purchase reconciliation skipped seven overlapping cron ticks"
tags:
  - agentcard
  - payment
  - cleanup
  - benchmark
  - reclaim-lease
sources:
  - commit 6f5c4a9f9502dcd0a4a25cfe7cbffccc64edd1e5
  - agent 61107054-c3e6-4089-941d-43393b3cf04b
  - agent 5200169a-bf31-46ca-855c-78c2b47252b0
  - agent 07281fc3-5e49-4cd2-9573-235cb19b0481
repro: agents/tests/blackbox/benchmark.blackbox.py registered owned payment caller controls
status: open
---

## Problem

The unchanged `/deploy` production task
`scripts/run-bench agent-payment-production-abandonment` failed twice while
qualifying PR1495. Runs `4a0fab53-8c43-42be-83ad-2c6ac7f84dba` and
`abc5af37-83c0-4988-beef-a2a5df679555` retained `ERROR`, with task durations
569.1s and 578.7s and recorded LLM cost 0c. Both agents completed before the
benchmark's existing 420-second reconciliation wait expired. The last snapshots
still showed `HELD`/`RECLAIMING` although the exact cards were `CLOSED` with zero
balance and their organization transfers were reclaimed for 100c.

Fresh exact-owner lifecycle reads at 10:57:24 and 11:14:54 UTC subsequently passed
every original lifecycle assertion: purchase `VOIDED`, funding `RECLAIMED`, live
organization release 100c, successful 100c Stripe refund, card closed with zero
balance, all integrity counters, and no open payment attention. No recovery POST
was performed by the investigator. Later cleanup does not make either failed
benchmark a PASS, and neither failed run was discarded.

This was discovered while verifying the Google session investigation. It is a
separate harness problem and provides no evidence of original Google acceptance
or correct password selection.

## Diagnosis

The backend serializes seven purchase reconcilers under one overlap guard. For
the first purchase, ticks from 10:47 through 10:53 were skipped while the prior
cycle remained active. The next cycle began at 10:54:00.695397 and reached this
purchase at 10:54:35.978851; its transfer first read reclaimed at
10:54:36.209449. For the second purchase, ticks from 11:00 through 11:07 were
skipped. The 11:08 cycle reached it at 11:10:16.679220 and observed release at
11:10:16.955946. The two-minute stale lease makes a row eligible; it does not
guarantee execution while that shared cycle is busy.

Both `_poll_agent`'s card-ready branch and `ensure_payment_lifecycle_cleanup`
called `_wait_for_expected_payment_lifecycle` without its existing recovery
callback. They could only observe the busy global reconciler. The same
purchase-scoped, idempotent abandonment endpoint used by later finalization can
resume eligible compensation with the existing backend stale-lease CAS,
fencing, and refund idempotency.

Archive searches for GET-only cron/recovery waiting found no matching owning
case. The October2 closed-card transfer-never-release case is related: unlike
those unreleased transfers, these transfers were observed reclaimed. The
specific preceding slow job and exact provider release/local CAS/refund times
remain unmeasured. Captured database operations were fast; slow benchmark Hub
uploads and one unfinished Agent GET do not establish a broad database outage
or the cause of this payment wait.

## Solution

Two new permanent controls exercise the actual production task and both real
caller paths through a local HTTP transport. A first abandonment and subsequent
GETs retain the observed pending state; only a second abandonment of the exact
same existing agent/purchase can return the full expected lifecycle. The
transport rejects creation, funding, and unrelated endpoints. The module-only
clock advances the original 420-second budget without changing the event-loop
clock or the 900-second catalog task.

The exact same selector command failed 0/2 on `6f5c4a9f95` and passed 2/2 after
the repair:

```bash
agents/venv/bin/python -u .context/google-session-rca/agentcard-owned-callers-regression.py payment_cleanup_recovers_owned_pending_lifecycle payment_card_ready_poll_recovers_owned_pending_lifecycle
```

The private selector checks normal registration before invoking those unchanged
permanent callbacks. The normal owning domain remains
`cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py benchmark`.

Both callers now read first. A fully valid terminal read needs no additional
POST. When the lifecycle remains resumable after the existing 120-second lease
interval, they may resume the same purchase through the existing endpoint.
Backend ownership remains authoritative; an idempotent provider close may occur
before a retry CAS, so this does not promise zero repeated provider calls. It
creates no new allocation, card, or funding operation.

An independent review found a second boundary: a card-ready signal at task age
800s could previously accept recovery at age960s within the full 420s phase,
past the unchanged 900s catalog limit. The same new late-card control failed
before the outer correction and passed after it; explicitly disabled wall-clock
mode still passes. The card-ready caller now includes initial abandonment in
remaining task time, caps its reconciliation phase by that remaining time,
and rejects expired results. Final compensation remains a separate owner and
cannot turn the earlier failed task into a PASS.

The single wait owns the remaining deadline across sleep, GET and recovery POST,
checks expiry before resumption, and rejects late terminal responses. A hung
callback control fails on the old code and passes after the repair. Existing
one-POST/terminal-GET, already-valid snapshot, disconnected-response, pending,
provider-error, cancellation and deadline controls remain intact. The 420s wait,
900s task, 180s cleanup API timeout, task oracle, merchant, amount and payment
expectations are unchanged. Cancelling a local wait does not prove an already
accepted backend operation stopped; its original compensation owner and
idempotency remain responsible for that operation.

## Status

Local causal and safety controls pass. Candidate review, applicable deployment
gates, and the unchanged live task outcome remain pending. Keep this case open
until the native task passes; do not substitute later refunds or a local mock
for that result. The original Google case remains open independently.

## Human feedback

None recorded.

## Reusable lesson

A stale lease establishes eligibility, not scheduler availability. A benchmark
with ownership of an idempotent compensation operation should observe first and
resume that same operation within its original budget instead of depending only
on a busy global backstop. Keep native task outcomes separate from later cleanup
and local proof, and preserve backend ownership for accepted operations after a
local wait is cancelled.
