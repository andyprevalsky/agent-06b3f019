---
id: 2026-10-23-committed-insert-content-rejection-dropped-without-pointer
date: 2026-10-23
title: A committed INSERT refused by Supabase's edge WAF was dropped with no pointer for the client
surface: cross
component: realtime-broadcast
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/chat/committedMessageDelivery.ts settle() — a non-retryable 4xx ended delivery with only a log line, and the subscribed client had no per-row way to learn the committed row existed
symptoms:
  - "[Broadcast] Failed status=403 body=<!DOCTYPE html> ... Sorry, you have been blocked"
  - "Committed INSERT delivery exhausted topic=agent:<id> message_id=<id> attempts=1 status=403"
  - "broadcast.span ... event=INSERT status=403"
  - spawn_claude_code_agent tool card stays IN_PROGRESS in the UI although the FINISHED row is in the DB
  - Cloudflare Ray ID in the broadcast response body
tags:
  - realtime
  - supabase
  - cloudflare
  - waf
  - delivery
  - code-agent
sources:
  - fleet run 20261023-230227-25495 browser-smoke r004-j0049 (descend-full69-20261023 proof 2, message 75e5af12, Cloudflare Ray a4f47669fe39d6d3)
  - agent cddadfb3-2a5a-4782-9653-afdb4202fdee
  - commit 7eb275b1b (buggy base; fix on branch rca/Q4-broadcast-waf-403)
repro: back-end/src/tests/blackbox/committed-message-broadcast.blackbox.ts
status: open
---

## Problem

In descend-full69 proof 2 (browser-smoke r004-j0049, source 7eb275b1b) the
root agent's `spawn_claude_code_agent` FINISHED row `75e5af12` (158,184 chars)
was stored (POST 201 at 23:18:43.504Z). Its realtime INSERT got HTTP 403 with
the Cloudflare "Sorry, you have been blocked" page (Ray a4f47669fe39d6d3).
`CommittedMessageDelivery` logged `attempts=1 status=403` and stopped, so the
selected UI never received the tool-close frame. Two earlier code-session
transcript rows (`f745e47e`, 252 chars; `a3a5e436`, 259 chars) were refused the
same way at 23:17:49.492Z and 23:17:51.573Z. 74 other INSERTs and 17 UPDATEs in
the same run returned 202.

## Diagnosis

Path: worker POST message → committed Message row → `broadcastMessageInsert`
→ `CommittedMessageDelivery` → `POST /realtime/v1/api/broadcast` (Supabase,
behind Cloudflare) → selected-agent channel → `onInsert`.

1. Size is not the trigger: two of the three refused rows were ~250 chars, and
   larger rows were accepted. All three contain the same codex shell command
   (`… 2>/dev/null | head -80; mkdir -p …; curl -L --fail --silent https://… -o /tmp/…; sed -n …`):
   transcript events 53/55 for the two small rows, and the SDK event JSON
   embedded in the 158 KB result. This is a classic command-injection WAF
   signature. The first-bad trigger is third-party content filtering of
   agent-produced text, which we do not control and cannot sanitize without
   truncating content the user needs.
2. A 403 is classified non-retryable (correctly: resending identical bytes
   cannot pass a deterministic rule). `settle()` then logs "delivery exhausted"
   and drops the cohort. The subscriber gets nothing.
3. The FE reconciles from the API only on (re)subscribe and inside the chat-turn
   and browser completion windows. A connected agent-mode view never
   re-reads, so the row stays missing until the page reloads.
4. Deepest owned cause: the committed-delivery contract treated "the broker
   refused these bytes" as terminal, and offered no content-independent path to
   tell the client which committed row exists. In a multi-row batch, one refused
   record also fails every other cohort in that HTTP request.

Repro (owning boundary, recorded response replayed):
`cd back-end && npx tsx src/tests/blackbox/committed-message-broadcast.blackbox.ts`.
On 7eb275b1b: `FAIL a content-rejected committed INSERT still tells the client
which row to fetch: the subscribed client must learn that committed row
waf-blocked exists`, RESULTS 10/11.

## Solution

The DB write succeeded (Message create 23:18:43.498Z, POST 201 at .504Z); only
the realtime push was refused (.536Z). After a non-retryable 4xx on a committed
INSERT, `CommittedMessageDelivery` now tries ordered substitutes, one send each,
and never resends the plain record:

1. `INSERT_ENCODED`: the identical record, with text/metadata/filePointer as one
   base64 JSON blob (`encoding: "base64"`). The FE extractor decodes it into the
   normal INSERT path.
2. If that is also refused, `INSERT_DEFERRED`: ids, timestamp, role, the tool
   lifecycle scalars (toolName/toolStatus/toolCallId/success) and a visible
   reason. The UI shows the reason as the message body at once, which also
   closes the tool card. It then reads only that row with
   `GET /api/agents/:id/messages/:messageId` and swaps it in. If the read fails,
   the reason stays visible.

A record larger than one agent lane (256 KB) used to be dropped at enqueue
(`delivery rejected reason=capacity`; sibling R6, Display HTML of 285-311 KB in
r001-j0014 and r005-j0070). It now gets the same `INSERT_DEFERRED` placeholder
with the reason "too large to stream live; loading it from the server."

Live proof on the real path (`COMMITTED_BROADCAST_LIVE=1 npx tsx
src/tests/blackbox/committed-message-broadcast.blackbox.ts`, our Supabase
project, real publisher, real subscriber, 158 KB record carrying the recorded
command): wire `[INSERT 403, INSERT_ENCODED 202]`, and the subscriber received
INSERT_ENCODED and decoded the full text and metadata intact. Supabase's
websocket send path was not used: the backend has no realtime socket client,
and one would add a connection per process.

10k agents: no new channel, subscription or shared structure. Per refused row:
one extra frame of ~1.33x the size on the agent's own topic. Only when that is
also refused: one ~400-byte placeholder plus one PK read per viewing client.
The healthy path is unchanged.

Golden reference: `claude-code-src/src/cli/transports/SerialBatchEventUploader.ts:12`
drops a batch that cannot be sent but counts it. `claude-code-src/src/bridge/replBridge.ts:217`
then has the reader resume from the durable store (`from_sequence_num`) rather
than trusting push delivery. The placeholder path converges on that model: push
is a hint, the DB row is authoritative, and the reader pulls what it missed.

Related case: 2026-10-13-committed-broadcast-discarded-after-timeout (same queue, transient
failures; its non-retryable 403 branch is where this gap lived).

## Human feedback

- The parent coordinator required rehydrating only the deferred row by ID
  rather than refetching the whole agent detail (10k-agent rule). It also
  required flagging the new realtime payload type as an approval-gated schema
  change.
- Andy (2026-10-24): "if its just a ui stream issue, can we force the push
  somehow, if we do default to a smaller msg, the message should include a
  reason we truncated the fe UI (which is honestly ok) ... along w the successs
  thing". This produced the base64 force-push first and the reason placeholder
  carrying the tool success status second.
- The parent asked that the oversize capacity drop (R6) use the same
  placeholder with its own reason.

## Reusable lesson

When a broker deterministically refuses a committed record's bytes, re-send it
once in a different encoding, then fall back to a visible content-free
placeholder that the client fills from the source of truth; never drop the row
silently.
