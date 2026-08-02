---
id: 2026-07-17-cold-start-subscribe-skips-realtime-backfill
date: 2026-07-17
title: Realtime backfill was gated to reconnections, so a brand-new agent's cold-start subscribe never replayed the missed answer
surface: front-end
component: realtime-subscription
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "the realtime subscribe handler only backfilled when it detected a reconnection (`initialLoadDoneRef !== agentId`, `forceResubscribeCounter === 0` on a first subscribe), so cold starts skipped reconciliation"
symptoms:
  - new-agent chat stalls on "Thinking" forever
  - answer exists in the database but never renders in the UI
  - prod chat-lifecycle-ratchet gate stays red after the reconnect-backfill fix
tags:
  - realtime
  - supabase
  - chat
  - cold-start
  - backfill
sources:
  - PR #783
repro: none-recorded
status: fixed
---

## Problem

A brand-new agent's chat stalled on "Thinking" indefinitely even though the answer
had already been produced and persisted. The prod `chat-lifecycle-ratchet` gate
stayed red even after PR #782 added a reconnect backfill, so the first fix
demonstrably did not cover the failing case.

## Diagnosis

The backfill was gated on detecting a _reconnection_. A brand-new agent's first
`agent:<id>` subscribe is a **cold start**, not a reconnection
(`initialLoadDoneRef !== agentId`, `forceResubscribeCounter === 0`), so the gated
backfill never fired. Meanwhile the answer streamed during the ~1–2 s
subscribe/auth-race window, arriving before the client was listening — with no
replay path it stayed stranded in the DB while the UI waited forever. The deeper
cause is the gate itself: reconciliation was treated as a recovery mechanism for an
exceptional path, when the ordinary path has the same gap.

## Solution

Reconcile from the API on **every** successful (re)subscribe, cold start included,
with an idempotent merge so a replay can never duplicate messages. The reconcile is
O(1) per viewed agent, which is what keeps it scale-safe under the 10k-agent rule
rather than fanning in per user. Cemented by a cold-start backfill test in the
`hooks-lib-realtime-subscription` blackbox suite (9/9 passing including the new
case).

## Human feedback

This PR landed CLAUDE.md rule 27 — every change must hold at 10k agents — and the
fix is explicitly justified as `O(1)` per viewed agent against it, so the scale
constraint was imposed on the fix rather than discovered afterwards.

## Reusable lesson

If a gap exists between "state was produced" and "client started listening", the
reconcile must run on every subscribe — never only on reconnect — because the first
subscribe has the same race as a resubscribe.
