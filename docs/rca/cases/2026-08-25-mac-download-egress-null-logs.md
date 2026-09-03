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
  - commit dae9b0c3
repro: cd back-end && DOWNLOAD_EGRESS_REPORT_PATH=/tmp/dl-egress-repro/report.json npx tsx scripts/download-egress-health.ts
status: fixed
---

## Problem

Scheduled `Mac download egress health` failed continuously after real updater
traffic left the 60-minute window. Synthetic range probes and Supabase edge
aggregates stayed healthy; the monitor still exited 2 because Render's logs API
returns `{ "logs": null, "hasMore": false }` when the text filter matches zero
rows — not `{ "logs": [] }`.

`fetchTelemetryLogs` required `Array.isArray(body.logs)`, so every quiet hour
became a diagnostic incident. `prod-health.ts` already used `data.logs || []`.

Archive search (`Render logs query returned no logs array download egress`,
`download egress Render telemetry`): no prior case on this contract.

## Diagnosis

`download-egress-health-lib.ts` rejected `logs: null` as a malformed Render
response even though Render and the existing production-health parser use null
for an empty log window. The monitor converted normal provider emptiness into a
diagnostic failure.

## Solution

Treat `logs == null` as an empty page (same as prod-health). Keep throwing when
`logs` is present but not an array. Unit test covers live `logs: null` empty
window → exit 0, and malformed `logs` string → exit 2.

## Evidence

Pre-fix (local, same credentials as CI):

```
HEALTHY: ... diagnostic failures 1
- Render download telemetry unavailable: Error: Render logs query returned no logs array
EXIT:2
```

Live Render empty filter:

```
{"hasMore":false,"logs":null,...}
```

Post-fix: same command exits 0 with empty diagnostic-failure list.

## Human feedback

None recorded.

## Reusable lesson

Normalize provider-specific empty-result representations at the API boundary
when an established sibling integration already defines their meaning.
