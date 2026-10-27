---
id: 2026-10-27-messaging-accept-marked-syncing-before-parts-written
date: 2026-10-27
title: Messaging upload accept marked the integration SYNCING before writing its parts, so a concurrent drain stranded the final chunk
surface: back-end
component: integrations-messaging-upload-queue
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/domains/integrations/uploadService.messaging.ts acceptMessagingUpload (upsertIntegrationForUpload before enqueueMessagingUpload)
symptoms:
  - "messaging upload -- non-final chunk keeps the incremental cursor"
  - "final request advances the cursor to the sync start (undefined)"
  - "drainUntil timed out at 60s with cursor undefined under coverage concurrency"
  - "integration CONNECTED but lastFrontendAccessAt never set after the final chunk"
tags:
  - messaging-upload
  - imessage
  - durable-queue
  - toctou
  - flake
sources:
  - PR #1583 (introduced the durable queue; flake reported by lane S18 under coverage)
repro: back-end/src/tests/blackbox/integrations.messaging-ingestion.cases.ts testMessagingUpload_finalizeDuringAcceptKeepsFinalChunk
status: fixed
---

## Problem

Under backend coverage concurrency, the integrations case "messaging upload -- non-final chunk keeps the incremental cursor" timed out once (S18). Its 60s `drainUntil` waited for `lastFrontendAccessAt` after the final chunk, and the cursor stayed undefined even though all 5 messages were stored.

## Diagnosis

`acceptMessagingUpload` first upserted the integration to SYNCING (committed), then inserted the upload parts. `finalizeIntegration` only visits SYNCING integrations. When a concurrent drain (the backend's own kick or cron, or the test's drain) finalized between those two writes, it saw the SYNCING flag, 0 pending parts, and only the earlier non-final part. It marked the sync CONNECTED without a cursor. The final part was then inserted under a CONNECTED integration, and finalization never revisited it, so the cursor never advanced. Load widens the window between the two writes.

Deterministic repro: the new case runs a full drain from a spy at the instant the final parts are written. Before the fix: `FAIL ... final chunk finalized after an interleaved drain (status CONNECTED, cursor undefined)`, integrations 286/287.

Deepest owned cause: the SYNCING flag (finalization's work list) and the parts (its input) are two writes. They were ordered so the flag could become visible before its input.

## Solution

`acceptMessagingUpload` now writes the parts first, re-marks the integration SYNCING afterwards, and only then kicks the drain. `enqueueMessagingUpload` no longer kicks the drain itself. A first-ever upload still creates the row before its parts, since the parts need its id; a finalize in that gap finds no parts and leaves it alone. A drain that runs mid-accept now sees either no SYNCING flag or every part, and any drain after the re-mark finalizes the full sync. After the fix, integrations passes 287/287 with the identical command (`bash scripts/run-blackbox-tests.sh integrations`).

10k-agent behaviour: no extra queries per upload, just one reordered upsert, and nothing changes in the drain.

Open sibling (not fixed here): `findSyncingMessagingIntegrations(..., 100)` has no ordering or paging. Prod has 17 legacy iMessage integrations stuck SYNCING with no parts. They are rescanned on every drain, and past 100 such rows newer syncs would starve.

## Human feedback

None recorded.

## Reusable lesson

When a status flag is a worker's work list, publish the flag only after the work it points to is durable, never before.
