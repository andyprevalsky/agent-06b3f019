---
id: 2026-10-28-same-tick-stream-burst-exhausted-broadcast-topic-cap
date: 2026-10-28
title: A same-tick burst of ASSISTANT_STREAM deltas exhausted the 64-message broadcast topic cap, dropping live chunks and the turn's INSERT
surface: back-end
component: realtime-broadcast
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/src/providers/chat/committedMessageDelivery.ts InitialBroadcastDispatcher.enqueueGroup admitted each stream delta as its own queued message, capped at MAX_INITIAL_TOPIC_MESSAGES=64 per topic"
symptoms:
  - "prod Render: 100s of `CommittedMessageDelivery Initial broadcast delivery rejected reason:capacity` per hour since at least 2026-10-21, bursty"
  - "up to 176 rejections for one agent topic inside ~10 ms (agent:fbf33fde at 2026-10-27T20:51:32Z)"
  - "the same burst ended with `Committed INSERT delivery exhausted` for the turn's message"
tags:
  - realtime
  - supabase-broadcast
  - streaming
  - 10k-agents
sources:
  - memory:scalability-audit-100-seats-20261024
repro: back-end/src/tests/blackbox/committed-message-broadcast.blackbox.ts ("a same-tick burst of stream deltas reaches the client whole, and the turn INSERT still sends")
status: fixed
---

## Problem

Prod Render logs show `Initial broadcast delivery rejected` with `reason:"capacity"` and small `bytes` (p50 413). These occur in bursts on single `agent:` topics, back to at least 2026-10-21, so they predate S15's #1594 (merged 2026-10-27 20:53Z). In the agent fbf33fde burst at 20:51:32Z, the chat generator emitted about 240 `ASSISTANT_STREAM` deltas within roughly 12 ms. The first 64 queued and the next 176 were rejected. The turn's committed INSERT was also refused, so the client lost streamed text and the final row's live frame. A second burst (ec9378bd, 04:06:35Z) had the same shape: 185 deltas, 134 rejected. Broadcast round trips stayed around 50 ms, and the Supabase quota was not involved.

## Diagnosis

Every non-INSERT event enters `InitialBroadcastDispatcher` as one queued message, with at most 64 per topic. The drain runs from a 10 ms timer. A producer that awaits already-resolved broadcast promises in a loop only yields microtasks, so the whole burst is admitted before any drain. Any burst over 64 for one agent is therefore dropped. Local repro, failing on main: the new blackbox case logs 178 `capacity` rejections and the reconstructed client text is missing chunks.

## Solution

`InitialBroadcastDispatcher` takes an optional `coalesce(queued, next)`. `supabaseBroadcast` supplies `coalesceAssistantStream`, which folds a delta into the topic's last queued and unsent delta of the same stream. The merged frame concatenates `delta` and carries the newest `sequence`, `done` and flags. The client already appends `delta` and keeps the highest `sequence` (`realtimeHandlers.handleAssistantStream`), so the rendered text is identical. Merging never crosses a committed INSERT cohort, a `done` frame or the sequence-0 stream start, and it respects the per-topic and shard byte caps. Nothing is dropped or hidden: the cap still rejects genuinely unbounded non-stream traffic.

At 10,000 agents, a burst now costs one queue slot and one Supabase event per drain, instead of one per chunk. That lowers the project-wide broadcast rate toward the 1 MB/s and 2,500 events/s Realtime limits. Coalescing is O(1) per enqueue.

## Human feedback

None yet.

## Reusable lesson

A per-key message cap needs a merge rule for streams whose elements are composable deltas; otherwise a producer that emits faster than the drain timer turns a backpressure cap into data loss.
