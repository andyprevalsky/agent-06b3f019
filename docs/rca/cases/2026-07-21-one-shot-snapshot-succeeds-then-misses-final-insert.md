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
repro: front-end/src/tests/blackbox/hooks-lib-realtime-subscription.blackbox.ts
status: fixed
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
