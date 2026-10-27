---
id: 2026-10-27-realtime-insert-broadcast-carried-full-rows
date: 2026-10-27
title: Committed message INSERT broadcasts carried full rows up to 256 KB, so a few large tool rows dominated Supabase Realtime's 1 MB/s project budget
surface: back-end
component: realtime-broadcast
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/chat/supabaseBroadcast.ts broadcast() — every committed INSERT up to the 256 KB lane cap streamed its full text and metadata live
symptoms:
  - busiest minute 1.53 MB of INSERT broadcasts with about 5 users
  - Supabase Realtime 1 MB/s project limit at 100 seats
  - browser_observation metadata in TOOL INSERT frames
  - INSERT frames of 186 KB on agent channels
tags:
  - supabase-realtime
  - broadcast
  - payload-size
  - capacity
  - scale-100-seats
sources:
  - task S15 realtime payload cap (100-seat readiness audit 2026-10-24)
  - memory:scalability-audit-100-seats-20261024
repro: back-end/src/tests/blackbox/realtime-payload-cap.blackbox.ts
status: fixed
---

## Problem

The 100-seat audit (Q2) found that realtime INSERT broadcasts had no practical
size cap. Supabase Realtime (Pro) allows 1 MB/s and 2,500 events/s per project.
Prod committed messages over the 7 days to 2026-10-27, measured read-only, were
15,631 rows and 33.4 MB: average 2.1 KB, p95 9.2 KB, p99 25.8 KB, max 895 KB.
The busiest minute (2026-10-20 23:21Z) carried 1.53 MB from about 5 users. The
audit projected 0.6–1.5 MB/s at 100 seats, past the project limit, at which
point live UI updates are dropped.

## Diagnosis

Critical path: `createMessage` → `broadcastMessageInsert` → `broadcast()` →
`CommittedMessageDelivery` → `POST /realtime/v1/api/broadcast` →
`agent:<id>` subscribers.

`broadcastMessageInsert` sends the full row (`text`, `metadata`,
`filePointer`). The only size boundary was `MAX_AGENT_BYTES` (256 KB), which
exists to bound one agent's retry lane, not live bandwidth. Rows over 8 KB were
5.7% of messages but 57.9% of bytes, mostly TOOL rows (7.7 MB of text and
10.5 MB of metadata). `browser_observation` alone was 9.0 MB. The UI does not
need those bytes live: an `INSERT_DEFERRED` notice plus a by-id read
(`GET /agents/:id/messages/:messageId`) already existed for WAF-refused and
>256 KB rows. The deepest owned cause is a missing live-bandwidth bound: the
broadcast contract sized frames by queue capacity rather than by what the
realtime budget can afford per message.

Local repro: `realtime-payload-cap` replays the prod size mix (100 percentile
midpoints plus the tail to the 895 KB max) through `broadcastMessageInsert`
with a captured transport. On main it sent a 186,759-byte frame and 635,100
wire bytes for 1,515,828 bytes of rows. The Python worker only broadcasts
stream frames, so the backend publisher is the single committed-row choke
point.

## Solution

`broadcast()` caps a committed INSERT frame at `LIVE_INSERT_MAX_BYTES` (8 KB,
env `SUPABASE_BROADCAST_LIVE_INSERT_MAX_BYTES`). A larger row is sent as
`INSERT_DEFERRED` with:

- `preview` (the first 1,000 characters of `text`),
- `filePointer`,
- the metadata that fits, dropping the largest keys first while always keeping
  `toolName`, `toolStatus`, `toolCallId` and `success`.

It never sends `text`. The front-end shows the preview and the reason, then
reads the row by id, as it already did for deferred rows. A refused bounded
notice falls back to the content-free blocked notice. Per-agent `agent:<id>`
topics and FIFO committed delivery are unchanged. `realtime-types`
(`InsertDeferredPayload.preview`, extractor validation) and the benchmark
smoke monitor (which now consumes `INSERT_DEFERRED` lifecycles) are updated.

Verification:

- `realtime-payload-cap`: largest frame 7,716 B, wire 138,621 B on the fixture
  (−90.9% of row bytes; −78% versus main). Percentile body −33.6%.
- The same cap applied to prod's 7 days gives 33.4 MB → 15.0 MB (−55%) and a
  busiest minute of 1.53 MB → 204 KB (−87%). The audit's 0.6–1.5 MB/s 100-seat
  projection becomes about 0.27–0.68 MB/s, and less at peak composition.
- Front-end `hooks-lib-insert-delivery` / `hooks-lib-realtime` and agents
  `realtime_monitor` regressions fail on main and pass on the fix, five
  consecutive times each.
- The existing capacity suites raise the env cap so they keep exercising lane
  and shard byte budgets with large frames.

Scale at 10k agents: each committed row costs at most one ≤8 KB frame on its
own `agent:<id>` topic. Only clients viewing that agent issue one primary-key
row read per oversized row. There is no new shared state or fan-in.

## Human feedback

None recorded.

## Reusable lesson

Bound realtime frames by the bandwidth budget, not by queue capacity: stream
small rows whole and send large ones as id + preview notices that clients
hydrate on demand, keeping the control fields every consumer needs.
