---
id: 2026-07-21-one-shot-snapshot-succeeds-then-misses-final-insert
date: 2026-07-21
title: A successful one-shot post-subscribe snapshot stopped reconciling, so a missed final-message INSERT left the UI waiting forever on an answer already in the DB
surface: front-end
component: realtime-subscription
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the post-subscribe reconcile was one-shot — a snapshot that succeeded before the canonical answer was persisted ended reconciliation for the turn
symptoms:
  - chat waits indefinitely while the canonical answer is already returned by the agent-detail API
  - connected realtime channel misses an individual message INSERT
  - production semantic run 29807459093 stranded final answer
tags:
  - realtime
  - backfill
  - reconcile
  - missed-insert
  - chat-stall
sources:
  - PR #835
repro: front-end/src/tests/blackbox/hooks-lib-connected-backfill.blackbox.ts
status: open
---

## Problem

Production persisted and broadcast the canonical answer, but a connected
frontend never displayed it. The answer was retrievable from the agent-detail
API the whole time; the UI simply waited indefinitely. The checked-in regression
cites production semantic run 29807459093, where the first authoritative snapshot
landed after the router/tool messages but before the final answer was persisted.

## Diagnosis

The post-subscribe reconcile was one-shot and keyed on _success_, not on
completeness. Because the snapshot returned 200 with the turn still in progress,
reconciliation was considered done — and the connected channel then dropped the
individual final-message INSERT. Realtime does not replay broadcasts, so there was
no second chance: a successful-but-incomplete snapshot plus one lost INSERT
equals a permanently stalled turn. The owned defect is treating HTTP success as
proof of state convergence rather than checking whether the latest user turn has
its canonical answer.

## Solution

Keep a bounded authoritative-message reconcile active while the latest connected
chat turn is still incomplete, and stop as soon as the canonical final response
appears or the turn enters agent mode. Deduplication and ordering are preserved on
merge, and the reconcile is canceled when the subscription is replaced or closed.
The regression drives a successful early snapshot followed by a missed
final-message broadcast in
`front-end/src/tests/blackbox/hooks-lib-realtime-subscription.blackbox.ts`. The
reconcile is bounded per chat turn rather than an unconditional poll, so it does
not add per-agent polling load in steady state.

## Human feedback

The smoke benchmark suite was skipped as an explicitly safe frontend-only diff,
and the Claude Code agent benchmark was omitted per the user's direction.

## Reusable lesson

A one-shot reconcile must terminate on _completeness_, not on HTTP success — if a
snapshot can legitimately return mid-turn, keep reconciling until the turn's
canonical result is present.

## Recurrence — 2026-10-13

Production semantic workflow 38324164007, attempt 2, reproduced the same
termination mistake with a nine-snapshot burst instead of a single snapshot.
For synthetic root `3c82b0d7-01d7-4447-88bc-5281d210da5f`, the last detail GET
was at 00:21:29.910 UTC and the canonical response committed at 00:21:30.098,
188 ms later. All five broadcast spans for that turn failed at their two-second
request bound. No further detail GET occurred before the failed milestone.
The browser's subscription state itself was not captured; source and GET cadence
identify the connected recovery path as the candidate owner.

The earlier regression covered a final answer in snapshot two. It did not cover
an answer arriving after the fixed nine-attempt limit. The unchanged
late-answer assertion fails with the old runtime and passes after extending the
recovery owner beyond its initial burst. This is causal proof for that boundary;
it does not substitute for the full production semantic outcome.

The repair retains nine fast snapshots, then uses the existing two-second
cadence for a finite 150-second recovery lease for the selected turn. This is
a frontend resource budget, not a claimed total backend completion deadline.
Successful incomplete reads and reconnects do not renew the same turn's lease.
Each read has the existing ten-second abort bound, with remaining lease time
limiting follow-up reads. Completion, workflow handoff, the existing current-turn
`chat_handler_failure` notice, four consecutive read failures, selection changes,
or unmount stop recovery. Earlier failures and intermediate tool errors do not
terminate a newer pending turn. Recovery starts on subscription; this change
does not add a new owner for every later message on an unchanged joined channel.

Permanent regressions cover late completion, current versus earlier failure
notices, a hung read, finite ownership through reconnects, and a new turn on
either side of the previous lease expiry. Local owning-boundary checks pass;
rollout and production semantic verification remain pending.

Two other failed samples in that workflow never committed a router decision or
canonical answer. Both router attempts ended with a JSON parse failure.
Production retained only a 200-character error prefix, not the full model call;
these samples remain a separate capture gap and are not attributed to this UI
repair.
