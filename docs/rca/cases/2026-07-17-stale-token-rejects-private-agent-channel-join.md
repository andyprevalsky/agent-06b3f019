---
id: 2026-07-17-stale-token-rejects-private-agent-channel-join
date: 2026-07-17
title: A stale socket token made the private agent Realtime channel join Unauthorized for ~43s, and Realtime never replays missed broadcasts, so the answer was dropped
surface: front-end
component: realtime-subscription
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: front-end/src/lib/realtime.ts — the socket signed private-channel joins with a pre-rotation token because `autoRefreshToken` is off
symptoms:
  - chat stuck on "Thinking" in production
  - "Unauthorized" on the `agent:<id>` private Realtime channel join for ~43s after agent creation
  - prod `chat-lifecycle-ratchet` gate fails while the same flow passes locally
tags:
  - realtime
  - supabase
  - auth-race
  - private-channel
  - stale-token
  - chat-lifecycle-ratchet
sources:
  - PR #782
repro: front-end/src/tests/blackbox/hooks-lib-realtime-subscription.blackbox.ts
status: fixed
---

## Problem

The prod `chat-lifecycle-ratchet` gate failed with chat stuck on "Thinking". The
backend produced its answer in ~1.3s, but the frontend never rendered it: the
`agent:<id>` **private** Realtime channel join was rejected `Unauthorized` for
roughly 43 seconds right after agent creation, and Realtime does not replay
broadcasts missed while unsubscribed. The flow passed locally every time because
dev uses **public** channels (`realtime.ts` sets `private: !DEV`), so the
authorization path that failed in prod was never exercised in development.

## Diagnosis

`autoRefreshToken` is off, so when the Supabase session token rotated, the
already-open socket kept signing new channel joins with the pre-rotation token.
Private channels authorize per-join, so every join attempt was refused until
something else forced a rebind — the ~43s window. Two things made a transient
auth refusal into permanent data loss: Realtime's fire-and-forget broadcast
semantics (no replay of anything missed) and the UI's reliance on the channel as
its only path to new messages. The environment split (`private: !DEV`) is what
allowed the defect to reach production undetected.

## Solution

Two owned fixes. Root cause: `ensureFreshRealtimeAuth()` re-binds the current
session token before every private-channel subscribe, and no-ops when the token
is unchanged so it adds no redundant reauthentication. Class-kill resilience: a
disconnected-backfill poll reconciles from the authoritative agent-detail API
whenever the channel is not connected, so messages surface within one interval
regardless of why the channel is down — the merge rule was unified with the
reconnect backfill in `applyAgentBackfill`. The regression in
`front-end/src/tests/blackbox/hooks-lib-realtime-subscription.blackbox.ts` drives
"agent channel never connects" and asserts the poll surfaces API messages; it was
verified failing pre-fix (`setMessages` never called).

## Human feedback

None recorded.

## Reusable lesson

When a realtime flow fails only in production, first check whether dev and prod
use different channel authorization modes — and never let a non-replaying
broadcast channel be the only path to state the UI must eventually show.
