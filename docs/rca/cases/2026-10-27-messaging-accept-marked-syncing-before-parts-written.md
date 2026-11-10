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
repro: back-end/src/tests/blackbox/integrations.messaging-ingestion.cases.ts testMessagingUpload_finalizeDuringAcceptKeepsFinalChunk + testMessagingUpload_staleFinalizeDoesNotStrandNewerUpload
status: fixed
---

## Problem

Under backend coverage concurrency, the integrations case "messaging upload -- non-final chunk keeps the incremental cursor" timed out once (S18). Its 60s `drainUntil` waited for `lastFrontendAccessAt` after the final chunk, and the cursor stayed undefined even though all 5 messages were stored.

## Diagnosis

`acceptMessagingUpload` first upserted the integration to SYNCING (committed), then inserted the upload parts. `finalizeIntegration` only visits SYNCING integrations. When a concurrent drain (the backend's own kick or cron, or the test's drain) finalized between those two writes, it saw the SYNCING flag, 0 pending parts, and only the earlier non-final part. It marked the sync CONNECTED without a cursor. The final part was then inserted under a CONNECTED integration, and finalization never revisited it, so the cursor never advanced. Load widens the window between the two writes.

Deterministic repro: the new case runs a full drain from a spy at the instant the final parts are written. Before the fix: `FAIL ... final chunk finalized after an interleaved drain (status CONNECTED, cursor undefined)`, integrations 286/287.

A second interleaving (found by CodeRabbit on PR #1609, reproduced by `testMessagingUpload_staleFinalizeDoesNotStrandNewerUpload`) has the same effect. A finalization reads the sync's processed parts; the final request then inserts its parts and re-marks SYNCING; the finalization then writes CONNECTED from its stale view. Before the compare-and-set: `FAIL ... (status CONNECTED, cursor undefined)`, 287/288.

Deepest owned cause: finalization was a read-then-write over two independently written facts, the SYNCING flag (its work list) and the parts (its input), with nothing tying the write to the state it read. Ordering the writes alone cannot close a read-then-write gap.

## Solution

`acceptMessagingUpload` now writes the parts first, re-marks the integration SYNCING afterwards, and only then kicks the drain. `enqueueMessagingUpload` no longer kicks the drain itself. A first-ever upload still creates the row before its parts, since the parts need its id; a finalize in that gap finds no parts and leaves it alone. Finalization is now a compare-and-set (`finalizeMessagingIntegrationIfCurrent`): one UPDATE sets CONNECTED and the cursor only while the integration is still SYNCING and no part newer than the one finalization read exists. Accept still writes parts before re-marking SYNCING, so a newer request is always visible to that guard. After both changes, integrations passes 288/288 with the identical command (`bash scripts/run-blackbox-tests.sh integrations`).

10k-agent behaviour: accept does no extra queries (one reordered upsert). Finalization replaces its Prisma update with one UPDATE that carries a correlated NOT EXISTS on the integration's parts. It is bounded per integration and has no new fan-in, but there is still no index on `MessagingUploadJob.integrationId` (an open S6 follow-up).

Open sibling (not fixed here): `findSyncingMessagingIntegrations(..., 100)` has no ordering or paging. Prod has 17 legacy iMessage integrations stuck SYNCING with no parts. They are rescanned on every drain, and past 100 such rows newer syncs would starve.

## Human feedback

None recorded.

## Reusable lesson

When a status flag is a worker's work list, publish it only after its work is durable, and make the worker's completing write conditional on the state it read.

## October28 separate test-observation race

Batch12 on b3364256 failed the large legacy upload's payload-release assertion. The retained runner read parts at02:49:02.120 and cleaned up by02:49:02.330; the concurrent backend completed that same user's part parser at02:49:02.559 and its processedAt/payload bookkeeping at02:49:02.569. MessageRecord count was visible before the worker finished. This is a test readiness defect, not evidence that the earlier accept/finalize fix regressed.

A native barrier after final-part parsing and before markProcessed reproduces the exact assertion in2.875s. The identical command passes3.249s when the existing single drainUntil waits for both the message count and the already-required processedAt/nonpayload predicate. All33 assertions,120 retries and500ms delays remain unchanged; no production code changes. Independent GROUNDED review cleared exact patch14ab7ae6c60b7ef3d0924eee2a7983e0cb023771fddf836ecf93961a63ed0581 before coordinator application. Native receipts and exact-owned DB/process cleanup are in plan:.context/deploy-fresh-20261027/rca-workflow-terminal-batch12/backend-upload/REPORT.md. The registered integration case remains the regression; full coverage acceptance stays separate.
