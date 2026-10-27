---
id: 2026-10-26-messaging-history-upload-unbounded-and-fire-and-forget
date: 2026-10-26
title: Heavy-user iMessage/WhatsApp history uploads were one unbounded request parsed fire-and-forget in the web process
surface: cross
component: messaging-history-ingestion
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: mac-app main/domains/i-message-sync/service.ts runFullSync sent the whole history in one POST; back-end domains/integrations/uploadService.messaging.ts acknowledged it and parsed it in an un-owned `void (async () => ...)()`
symptoms:
  - "413 Payload Too Large on POST /api/integrations/imessage/upload"
  - "RangeError: Maximum call stack size exceeded"
  - "iMessage payload received, processing in background"
  - uploaded iMessage/WhatsApp messages missing after a backend deploy or restart
  - global express.json verify copies every request body into req.rawBody
tags:
  - imessage
  - whatsapp
  - telegram
  - ingestion
  - scale
  - durability
  - body-parser
sources:
  - memory:scalability-audit-100-seats-20261024
repro: back-end/src/tests/blackbox/integrations.messaging-ingestion.cases.ts; mac-app/tests/blackbox/i-message-sync.blackbox.ts (heavy full sync); back-end/src/tests/structural/json-raw-body-scope.test.ts
status: fixed
---

## Problem

A 2026-10-24 read-only audit for 100 user seats flagged heavy-user ingestion.
Local synthetic reproductions on origin/main `b3679ea7b` confirmed four defects:

1. **Single unbounded request.** `runFullSync` passed every chat.db row to
   `BatchUploader.uploadInBatches`, which despite its name posts one JSON body.
   A 300k-message history produced exactly one upload request (mac-app
   `heavy full sync` case: `expected 1 to be greater than 1`). Around 500k
   messages that request exceeds the backend's 100 MB JSON limit, so it fails
   with a 413 on every retry and the first sync never completes. The cursor
   computation `Math.max(...messages.map((m) => m.id))` throws
   `RangeError: Maximum call stack size exceeded` under Node's default stack at
   300k ids (`node -e` probe). The real-time watcher has the same spread.
2. **Fire-and-forget parsing.** `processIMessageUpload`, `processWhatsAppUpload`
   and `processTelegramUpload` returned 200 and parsed inside an un-owned
   `void (async () => ...)()` in the web process. The repro
   `.context/s6/repro-durability.ts` acknowledges 1,000 messages in a child
   process that then exits, as a deploy or OOM would. The result was
   `stored=0 expected=1000`, and nothing retained the payload to retry.
3. **Per-contact round trips.** `upsertPersonAndMessageRecords` ran one
   `messageRecord.createMany` and one `person.update` per contact. In
   `.context/s6/repro-roundtrips.ts`, 1,000 contacts took `dbCalls=2061 ms=3358`.
4. **Raw body doubled for every route.** The global `express.json({ limit: '100mb' })`
   had a `verify` hook that copied every body into a `req.rawBody` string. A
   large upload therefore held its bytes twice. Only the Plaid and Slack
   webhooks read that copy.

## Diagnosis

The client and server disagreed about who bounds an upload. The client called
`uploadInBatches` and assumed it batched; it was a pass-through. The server
assumed bodies were small enough to parse in-request and acknowledged before
any durable record existed. Neither side owned bounding or durability, so
payload size grew with the user's history:

- request bytes;
- web-process heap, doubled by the raw-body copy;
- one uninterruptible in-memory parse.

Any restart dropped the work silently. A further inconsistency followed:
`lastFrontendAccessAt` (the client's incremental cursor) advanced when the
upload was received, not when it was delivered. Once a sync was split, a
partial failure would therefore skip the history that was never sent.

## Solution

- **Durable bounded parts.** The new `MessagingUploadJob` table is created by
  migration `20261026180000_messaging_upload_job`, with RLS enabled. Each
  upload is stored as parts of at most 5,000 messages; one huge contact is
  sliced across parts. The route acknowledges only after the parts are
  committed. A claimed drain (`uploadService.messagingJobs.ts`) parses one part
  at a time. It is kicked in-process and also run every minute by cron, which
  recovers parts lost to a restart. Claims are conditional updates with a
  10-minute lease, and retries back off exponentially. After 5 attempts a part
  is marked failed and the integration is set to `SYNC_FAILED`. Payloads are
  cleared once processed or failed. Message inserts deduplicate on
  `(personId, channel, externalId)`, so re-running a part is idempotent
  (rule 20). Old clients' single large bodies still work and are split on the
  server.
- **Client chunking.** The client sends 5,000 rows per request and uses loops
  instead of spreads to compute the max ROWID. Every request carries the sync
  start as `accessedAt`; all but the last send `syncComplete: false`. The
  server keeps the previous cursor until the final request, so a failed sync
  resumes instead of skipping history.
- **Batched person stats.** Per 50-contact chunk, all messages are inserted
  with one `createMany` (sliced at 10k rows). Stats are updated with one
  `UPDATE ... FROM unnest(...)`. `messagesExchanged` is now the count of stored
  messages for the person, so a contact whose history spans several parts
  still counts in full. 1,000 contacts now take `dbCalls=101 ms=613`.
- **Raw-body scope.** Raw capture moved to scoped parsers on
  `/api/integrations/plaid/webhook` and `/api/webhooks/slack/auto-rca`. The
  global parser no longer copies bodies. A structural test fails on any new
  `rawBody` reader that is not mounted behind a scoped parser.

**10k-agent / scale behavior.** Ingestion is per user and never touches agent
hot paths. Memory per web instance is bounded by one part (≤5k messages)
rather than a user's whole history. The queue costs one indexed claim query
per part, so it is not a single-row hotspot. Several instances drain
concurrently using per-row conditional claims. DB round trips are O(contacts/50).

## Human feedback

None recorded.

## Reusable lesson

Never acknowledge user data before it is durably recorded in bounded units, and never advance a client's sync cursor until the final unit is delivered.
