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
