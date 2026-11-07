---
id: 2026-11-06-messaging-connector-count-overwritten-by-upload-delta
date: 2026-11-06
title: iMessage connector showed 1 message after an incremental sync because each upload overwrote the stored total with its own size
surface: back-end
component: integrations-messaging-upload
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/integrations/uploadService.messaging.ts acceptMessagingUpload and uploadService.messagingJobs.ts finalizeIntegration wrote Integration.config.messages/contacts from the latest upload's payload size, while the Rose Desktop integrations row reads config.messages as the connector's total
symptoms:
  - iMessage connector said 200k messages on first connect, now it says 1
  - iMessage integration config {"contacts": 1, "messages": 1} while MessageRecord holds 209328 IMESSAGE rows
  - Rose Desktop integrations list iMessage row "1 messages" after an incremental sync
  - incremental sync keeps the total (expected 51 messages/2 contacts, got {"messages":1,"contacts":1})
  - totalMessagesProcessed 107733 lower than stored iMessage history
tags:
  - imessage
  - whatsapp
  - telegram
  - messaging-upload
  - integration-config
  - incremental-sync
  - derived-count
  - lost-update
sources:
  - task user report 2026-11-06 iMessage connector 200k to 1; prod read-only query of integration 1a7f14fc-8481-4e4e-95d3-c4f36718cab3
  - commit 86e00bb3d (Rose Desktop integrations list started rendering config.messages)
  - commit 8be441e32 (durable messaging uploads; config.messages = per-request size)
repro: back-end/src/tests/blackbox/integrations.messaging-ingestion.cases.ts testMessagingUpload_incrementalSyncKeepsTotalCount
status: fixed
---

## Problem

The user connected iMessage on 2026-11-05 and the Rose Desktop integrations
list showed about 200k messages; a day later the same row showed 1 message,
which looked like the incremental updater had overwritten the full sync.

Read-only production evidence (2026-11-06 23:3x UTC, user 1f85ff25):

- `MessagingUploadJob`: the first upload `…-1793921391763-58e4c13e` had 49
  parts, `contacts=774`, `messages=207920`, all processed 2026-11-05 23:30.
  The 41 later uploads were 1–20 message incremental syncs every few minutes;
  the latest (`…-1794007741509-2573819e`) carried `contacts=1, messages=1`.
- `Integration` (imessage): `status=CONNECTED`, config
  `{"contacts": 1, "messages": 1, "totalMessagesProcessed": 107733, "batchesReceived": 68, …}`.
- `MessageRecord`: 209,328 `IMESSAGE` rows for the user. No history was lost;
  only the displayed total was wrong.

## Diagnosis

Critical path: mac-app iMessage sync → `POST /api/integrations/imessage/upload`
→ `acceptMessagingUpload` (writes config) → `MessagingUploadJob` parts →
drain → `parseIMessageData` (MessageRecord, deduplicated) → `finalizeIntegration`
(writes config) → `GET /api/integrations` → `desktopSectionViews.tsx`
`countDetail(imessageRow?.config?.messages, 'messages')`.

Binary search: the stored records were correct (209,328 rows); the integration
config was wrong; the FE rendered the config faithfully. First bad data is the
config write. `acceptMessagingUpload` set `messages: totalMessages` (this
request's payload size) and `finalizeIntegration` set
`messages: latest.messages` (the latest part's request size). Every incremental
upload therefore replaced the total with its delta.

Step 5a ladder:

1. Why 1 — config.messages is overwritten by each upload's size.
2. Why 2 — `config.messages` had two meanings: Gmail's sync accumulates it as a
   total (`gmailSync.ts` `existingMessages + result.messages`) and the
   Desktop view (commit 86e00bb3d) reads it as the connector total, while the
   messaging pipeline (since commit 8be441e32 and earlier) wrote the latest
   request size. The display contract and the producer disagreed.
3. Why 3 — the total was a second, written copy of state the database already
   owns (MessageRecord, deduplicated per message). The only other attempt to
   keep a total, the parsers' `totalMessagesProcessed`/`batchesReceived`
   read-modify-write, was also wrong (107,733 vs 209,328): concurrent parts and
   the accept/finalize writers read and wrote the same JSON blob and lost
   updates. Any accumulated copy drifts (re-sent messages, lost updates); a
   count derived from the records cannot.
4. Why 4 would be "integration config is an untyped JSON blob" — a deliberate
   design; stop at Why 3.

Local repro (owning backend blackbox):
`cd back-end && source ../.cloud-env && bash scripts/run-blackbox-tests.sh integrations`
with the new case on the unfixed code →
`FAIL messaging upload -- incremental sync keeps the total message count -- incremental sync keeps the total (expected 51 messages/2 contacts, got {"messages":1,"contacts":1})`
(288 other cases passed).

Golden reference: not applicable (no approval-gated hunk).

## Solution

Derive, don't accumulate. `finalizeIntegration` now recounts the user's stored
history for the platform's channel (`countMessagingHistory`: a per-person
`COUNT(*)` over `MessageRecord` on the existing `(personId, channel)` index,
laterally joined to the user's `Person` rows) and writes it as
`config.messages`/`config.contacts`.
`acceptMessagingUpload` no longer writes payload sizes into the config. The
racy per-part `totalMessagesProcessed`/`batchesReceived` writers are deleted
from the iMessage, WhatsApp and Telegram parsers and the stale keys are dropped
at finalization, leaving one writer of the totals. Existing wrong rows correct
themselves at their next finalized sync; no backfill is required.

Siblings prevented: WhatsApp and Telegram totals (same pipeline), re-sent
messages inflating a naively accumulated total, and lost updates from the
parser read-modify-write of the shared config blob.

10k-agent behavior: no agent-path cost. One aggregate per finalized client sync
per user (background drain). The adversarial review found that a flat
`WHERE "userId" AND "channel"` count was planned on prod as an index scan of
the whole IMESSAGE channel across users (165 ms; 48,020 other users' rows
filtered), so the shipped query counts per person instead: prod EXPLAIN
ANALYZE (read-only) showed 1,646 index-only probes of `(personId, channel)`,
6,247 buffers, 47.8 ms for the 209,328-row user — bounded by that user's own
persons and rows, never other users'. Worst case measured: the prod user
with the most Person rows (2,275) on WHATSAPP took 435 ms cold, one probe per
person. If that becomes hot, add a `MessageRecord(userId, channel)` index. No
new channels, subscriptions, locks, shared rows or schema/index changes.

Regression: `testMessagingUpload_incrementalSyncKeepsTotalCount` (full sync of
50 → 1-message incremental sync → re-sent message; asserts 51 messages and 2
contacts after each) in the integrations backend blackbox, run by `/deploy`'s
backend blackbox gate.

## Human feedback

None recorded. (Adversarial reviewer, not the user, rejected the first count
query's cross-user plan; see Solution.)

## Reusable lesson

Never store a display total as a copy written from each upload; derive it from the deduplicated records it counts, and give each config field exactly one writer and one meaning.
