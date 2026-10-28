---
id: 2026-10-28-stream-deltas-crowd-out-committed-insert-admission
date: 2026-10-28
title: A burst of droppable stream deltas filled the topic's initial-send queue, so the committed final-answer INSERT was refused for capacity and dropped
surface: back-end
component: realtime-broadcast
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/chat/committedMessageDelivery.ts InitialBroadcastDispatcher.enqueueGroup — committed cohorts shared the 64-message per-topic cap with ephemeral ASSISTANT_STREAM frames, and supabaseBroadcast settled a refusal as non-retryable
symptoms:
  - "ERROR [CommittedMessageDelivery] Initial broadcast delivery rejected topic=agent:<id> message_id=undefined reason=capacity bytes=~400"
  - "Committed INSERT delivery exhausted topic=agent:<id> message_id=<id> attempts=1 status=error age_ms=0"
  - "web_search sample 1 missed milestones"
  - "waiting for locator('[data-message-kind=\"final-answer\"][data-message-state=\"canonical\"]') ... Timeout 15000ms exceeded"
tags:
  - realtime
  - supabase
  - broadcast
  - admission
  - chat-stall
  - semantic-gate
sources:
  - task chat-lifecycle-latency.spec.ts web_search sample 1 (deploy semantic-latency gate 2026-10-28)
  - agent d631f487-6614-4368-8c44-12f33f596ca7
repro: back-end/src/tests/blackbox/committed-message-broadcast.blackbox.ts ("a stream-delta burst cannot crowd out the committed final answer")
status: fixed
---

## Problem

During the /deploy semantic-latency gate on branch feat/omni-video-code-agent,
`chat-lifecycle-latency.spec.ts` web_search sample 1 never showed the canonical
final answer within 15 s; samples 2–5 finished in ~2.4 s. The backend log for
agent d631f487 at 06:39:16.461–.466Z shows ~45
`Initial broadcast delivery rejected ... message_id=undefined reason=capacity`
(ASSISTANT_STREAM deltas, ~400 B each), then at 06:39:16.473Z the final
ASSISTANT INSERT `c8736973` and a TOOL INSERT were both
`Initial broadcast delivery rejected ... reason=capacity` followed immediately by
`Committed INSERT delivery exhausted ... attempts=1 status=error age_ms=0`.

## Diagnosis

1. The generator emitted a synchronous burst of >100 deltas on `agent:<id>`
   while that topic's single in-flight initial request (~60 ms RTT) was open.
2. `InitialBroadcastDispatcher` admits at most 64 messages per topic; deltas
   past that were refused (acceptable: they are droppable).
3. The committed INSERT cohort went through the same `enqueueGroup` admission
   and was refused by the same 64-message cap that the deltas had filled.
4. `supabaseBroadcast`'s `enqueueFirst` callback settled that refusal with
   `{ ok: false, retryable: false }`, so `CommittedMessageDelivery.settle`
   ended delivery after one attempt. The canonical row was never broadcast; the
   UI waited on a row that existed only in the DB.

Deepest owned cause: droppable ephemeral frames and committed rows competed for
one admission budget, contradicting CommittedMessageDelivery's contract that a
committed row is retried/ordered/never silently lost while it fits its own lane
budget. Related cases: 2026-10-13 (uncertain send discarded) and 2026-10-23
(content rejection) fixed other exits from the same contract; this is a new
exit (admission), not a recurrence. The 2026-07-21 frontend reconcile is a
backstop but did not recover within the gate's 15 s window.

Repro (fails pre-fix, deterministic):
`cd back-end && npx tsx src/tests/blackbox/committed-message-broadcast.blackbox.ts`
→ `FAIL a stream-delta burst cannot crowd out the committed final answer ... RESULTS: 12/13 passed`.

## Solution

`InitialBroadcastDispatcher` now has `enqueue` (ephemeral, capped and refusable
as before) and `enqueueCommitted` (never refused). Committed cohorts are already
bounded upstream by CommittedMessageDelivery: one in-flight cohort per agent
lane, 32 messages / 256 KB per agent, 1 MiB / 128 lanes per shard. They still
join the same per-topic FIFO, so the INSERT stays ordered after the deltas it
supersedes. The dead non-retryable refusal branch in `supabaseBroadcast` was
removed. Same command post-fix: `RESULTS: 13/13 passed` (5/5 repeated runs);
realtime-payload-cap, aggregate-message-broadcast, committed-message-throughput,
chat-reasoning-identity and code-session-resources pass.

10k-agent behavior: no new per-agent state, channels or polling. Dispatcher
memory per shard is bounded by the ephemeral cap (1 MiB, 64 msgs/topic) plus
the committed accounting bound (1 MiB, 128 lanes); ephemeral frames still drop
first under pressure.

## Human feedback

None recorded.

## Reusable lesson

Never let droppable frames and committed rows share one refusable admission budget; bound committed rows in their own accounting and keep them in the ordered FIFO.
