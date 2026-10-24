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

Back end: after a non-retryable 4xx for a committed INSERT cohort,
`CommittedMessageDelivery` sends one `INSERT_DEFERRED` frame per member
carrying only `{agentId, id}`. It goes through the existing bounded retry path,
so it is retried only on transient statuses. The full record is never resent.
If the notice is also refused, the existing "delivery exhausted" receipt is
kept. A new `GET /api/agents/:id/messages/:messageId` reads one row by primary
key with the agent-detail access rules (owner, internal, admin inspection).

Front end: `subscribeToAgent` validates `INSERT_DEFERRED`. The selected-agent
handler fetches only that row (with the existing 10 s backfill request timeout),
then replays it through the unchanged INSERT path: id claim, stream/plan/tool
settlement, cloud-mode transitions, dispatch. A failed read keeps the existing
reconnect reconcile as the backstop.

10k agents: no new channel, subscription or fan-in. Per refused row: one extra
broadcast (~100 bytes) and one PK lookup per viewing client. Nothing happens on
the healthy path. A full agent-detail refetch was rejected because it costs
O(messages) per notice on long agents.

Also prevents: innocent rows sharing a refused batch (each cohort gets its own
notice), and any other deterministic 4xx from the broker (400/413).

Golden reference: `claude-code-src/src/cli/transports/SerialBatchEventUploader.ts:12`
drops a batch that cannot be sent but counts it. `claude-code-src/src/bridge/replBridge.ts:217`
then has the reader resume from the durable store (`from_sequence_num`) rather
than trusting push delivery. This fix converges on that model: the push frame
is a hint, the DB row is authoritative, and the reader pulls what it missed.
It uses a per-row pointer instead of a sequence cursor.

Related case: 2026-10-13-committed-broadcast-discarded-after-timeout (same queue, transient
failures; its non-retryable 403 branch is where this gap lived).

## Human feedback

The parent coordinator required rehydrating only the deferred row by ID rather
than refetching the whole agent detail (10k-agent rule). It also required
flagging the new realtime payload type as an approval-gated schema change.

## Reusable lesson

When a broker deterministically refuses a committed record's bytes, send a
content-free pointer and let the client read the row from the source of truth;
never resend the content or drop the row silently.
