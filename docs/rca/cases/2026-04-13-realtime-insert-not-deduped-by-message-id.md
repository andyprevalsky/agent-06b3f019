---
id: 2026-04-13-realtime-insert-not-deduped-by-message-id
date: 2026-04-13
title: Realtime INSERT handler appended messages without a message_id dedup check
surface: front-end
component: realtime-handlers
classification: our-bug
problem_class: other
first_bad_boundary: front-end/src/features/agent-context/hooks/realtimeHandlers.ts — `handleInsertMessage` appended unconditionally
symptoms:
  - duplicate messages appear in the agent chat UI until a page refresh
  - the same message renders twice after a realtime reconnect
tags:
  - realtime
  - supabase
  - front-end
  - deduplication
  - chat-ui
sources:
  - PR #371
repro: none-recorded
status: fixed
---

## Problem

Messages appeared twice in the agent chat UI and stayed duplicated until the page
was refreshed, at which point the refetched history rendered each message once.

## Diagnosis

`handleInsertMessage` appended every realtime INSERT event into state without
checking whether that message was already present. The delivery of an INSERT
event and the initial history fetch are independent paths that can both produce
the same row: the event can arrive while the message is already in state from the
initial fetch, or be re-delivered after a channel reconnect. Realtime delivery is
at-least-once with respect to the client's own state, so any handler that treats
an event as "new by construction" will double-insert; the refresh "fixing" it
confirmed the duplication was client-state-only and the backend rows were fine.

## Solution

Added a `message_id` dedup check in `handleInsertMessage` so an INSERT for a
message already in state is dropped. The identity check makes the handler
idempotent, which also covers reconnect replays and any future path that seeds
state before the subscription is live.

## Human feedback

None recorded.

## Reusable lesson

Treat every realtime event handler as at-least-once and key it on the record id —
duplicate UI rows that vanish on refresh are a client-state merge bug, not a
backend one.
