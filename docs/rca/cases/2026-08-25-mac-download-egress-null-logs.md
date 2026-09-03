---
id: 2026-08-25-mac-download-egress-null-logs
date: 2026-08-25
title: Mac download egress monitor fails when Render returns logs:null for empty windows
surface: back-end
component: download-egress-health
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/download-egress-health-lib.ts fetchTelemetryLogs — treated Render `logs: null` (empty window) as a monitor diagnostic failure
symptoms:
  - Mac download egress health workflow red every ~15m despite HEALTHY probes/edge
  - report.status healthy with diagnostic failure "Render logs query returned no logs array"
  - Slack incident path stuck on failure→failure (no recovery notify) while downloads fine
tags:
  - download-egress
  - render-logs
  - mac-app
  - monitor
sources:
  - PR #1180
  - memory:mac-download-egress-null-logs
repro: cd back-end && DOWNLOAD_EGRESS_REPORT_PATH=/tmp/dl-egress-repro/report.json npx tsx scripts/download-egress-health.ts
status: fixed
---

## Problem

Scheduled `Mac download egress health` failed continuously after real updater
traffic left the 60-minute window. Synthetic range probes and Supabase edge
aggregates stayed healthy; the monitor still exited 2 because Render's logs API
returns `{ "logs": null, "hasMore": false }` when the text filter matches zero
rows — not `{ "logs": [] }`.

## Diagnosis

`fetchTelemetryLogs` required `Array.isArray(body.logs)`, so every quiet hour
became a diagnostic incident. `prod-health.ts` already used `data.logs || []`.

## Solution

Treat `logs: null` as an empty window (`[]`), matching the prod-health contract,
so quiet periods do not page as monitor failures.

## Human feedback

Ops noise: Slack stayed on failure→failure while downloads were healthy; the
monitor false-alarmed on empty Render log windows.

## Reusable lesson

Third-party "empty result" payloads are often `null`, not `[]`. Normalize both
before failing a health gate, and align new monitors with existing prod-health
parsers.
