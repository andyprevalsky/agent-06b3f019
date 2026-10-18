---
id: 2026-10-04-hub-transport-duplicated-diagnostic-logs
date: 2026-10-04
title: Final Hub transport duplicated diagnostic logs beyond the decoded body limit
surface: harness
component: benchmark-hub-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Hub uploader included duplicated process logs in its terminal HTTP body
symptoms:
  - Fifty evaluated task rows remained live after final upload returned HTTP 413
  - Gzip transport fit upstream size limits but failed the decoded Express limit
tags:
  - benchmark-hub
  - publication
  - payload-size
sources:
  - PR #1410
  - fleet run 20261004-201108-11163
  - PR #1453
  - agent bb938dbe-1cc2-437c-80e7-faf31f300ce2
repro: scripts/tests/benchmark-live-results.test.py
status: mitigated
---

## Problem

The real fifty-task parent prepared a 305,285,322-byte decoded request. Gzip
reduced its wire size, but Express still enforced its existing 100 MiB decoded
limit. Finalization returned HTTP 413, leaving the dashboard live.

## Diagnosis

Archive searches covered Hub 413, gzip, decoded limits and parent publication;
the October 2 plain-JSON case concerns the earlier wire boundary. An unchanged
actual-parent fixture sent through the real Express parser was RED (HTTP 413).
Worker diagnostic logs dominated the payload; Hub agent/index consumers require
messages/tree and task metadata. Independent review checked those consumers and
preservation. The same fixture became GREEN (HTTP 201, 2.125 seconds); original
full-child and metadata controls were unchanged. Diagnostic owners retired.

## Solution

Copy the transport projection and omit only worker_logs, backend_logs and
realtime_logs. Keep every complete message/tree, task metric and evidence
reference. The actual decoded body is now 22,557,739 bytes; all fifty transcript
pairs and original local bytes are unchanged. Forensic diagnostics remain in
local full bundles and their archive. Keep the parent live until actual release,
then publish final transcripts and stop frontend polling.

The compact deploy control exercises the same decoded boundary, full fan-out
transcript preservation and nonmutation. Backend round-trip and frontend phase
coverage own the rendering boundary. Production follow-up remains pending;
loopback proof grants no benchmark acceptance credit.

## Human feedback

The user requested accurate frontend state updates and rapid pass/fail visibility
before teardown, with compact tests cemented in deployment.

## Reusable lesson

A compressed body can still exceed a decoded parser limit. Keep duplicated
forensic blobs out of the view transport without truncating evidence or raising
the memory boundary.

## October 14 recurrence: inline native retirement

Run17's terminal publication returned HTTP 413 after the existing diagnostic
projection. Its complete original was 305,185,833 bytes; the compact prepared
HTTP body was 107,214,710 bytes, exceeding the uploader's 94,371,840-byte
budget. The remaining duplicated `logs.wmh_retirement` was 100,609,899 compact
bytes. The original worker/backend/realtime projection was already active and
could not remove this newly included diagnostic class.

Actual frontend consumers render messages/tree; the evidence publisher validates
browser cleanup/recordings and transcripts. Neither requires the native
retirement diagnostic inline. An earlier proposed hydration requirement was
unsupported and withdrawn after tracing those consumers.

The optional `--forensic-archive-receipt` publisher path now downloads the existing
encrypted forensic archive and authenticates/decrypts every frame, verifies all
member SHA256s and the embedded manifest, and exhausts the ciphertext/compressed
stream hashes. Canonical run and native root/session/content bindings come from
those recovered originals. Only then does the transport projection replace the
duplicated retirement with private object identity and digest references.
Ordinary publication without this explicit option retains its previous path.
Original local bytes, full archive, task verdict, messages/tree, and browser
verification requirements are preserved.

The same owning projection assertions recorded 107,214,710 bytes before and
6,605,816 bytes afterward. Registered owning tests passed 46 cases; independent
negative controls rejected unrelated-member tampering, duplicate manifest paths,
trailing ciphertext and receipt-flag bypass. Browser-validation and composite
publisher checks passed. The actual publisher authenticated all 1,160 archived
members, uploaded successfully, exited zero at 2026-10-14T18:28:13Z, and verified
175 messages in a fresh browser. The original fundraiser task remains FAILED
with duration 3,780.2 seconds; publication repair is not fundraising success.

Human feedback for this recurrence: infrastructure changes are automatically
approved; WHM context and logic acquiring runtime context require approval.
This change affects evidence transport only. No new paid benchmark/model run,
merge, deployment, WHM prompt/context change, or production setting change was
performed. Native/canonical JSON parsing can require substantial memory; this
run's publisher completed, but its peak memory was not measured.

Owning regressions: `agents/benchmarks/archived_diagnostics_test.py` and
`agents/benchmarks/hub_upload_test.py`, with the projection callback registered
in `agents/tests/blackbox/benchmark.blackbox.py`. Private proof/body/receipt
artifacts remain encrypted; nonsensitive terminal preservation receipts are in
`docs/handoffs/whm-b07d9037-preservation/run17-infra-verification60m.json`.
