---
id: 2026-10-26-periodic-snapshot-reupload-reopened-zero-progress-bar
date: 2026-10-26
title: Every 5-minute cookie re-upload reopened a synced browser's bar at "0 of N cookies", so the count read as reset to 0
surface: back-end
component: integrations-upload-progress
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/integrations/service.uploadProgress.ts uploadRunProgress().start() — wrote `syncing done 0 of total` for every upload, including the Mac app's periodic re-upload of a row whose last run had already finished synced
symptoms:
  - integrations randomly had cookies reset to 0
  - Default profile · 0% · 0 of 13,548 cookies
  - Processed cookies newlyInserted 0 every 5 minutes
  - POST /api/integrations/cookies/upload -> 200 duration_ms 130336
tags:
  - integrations
  - sync-progress
  - progress-bar
  - browser-cookies
  - periodic-sync
  - mac-app
  - misleading-ui-state
sources:
  - task Rose desktop UI review 2026-10-26 item 11 (Integrations screenshot; prod Render logs 15:00-16:30Z and read-only IntegrationSyncProgress rows for user 1f85ff25)
  - commit 75ce1addd (repro, branch fix/ui26-cookies)
  - commit 33f8e72c4 (fix, branch fix/ui26-cookies)
repro: back-end/src/tests/blackbox/integration-accounts.pipelines.cases.ts — "cookie re-upload of a synced browser keeps reading synced (no 0-of-N bar)" (bash scripts/run-blackbox-tests.sh integration-accounts)
status: fixed
---

## Problem

Andy's Integrations page showed Chrome as "Default profile · 0%" with an empty
bar and "0 of 13,548 cookies", and ChatGPT Atlas as "0% · 0 of 4,657 cookies",
for browsers that had been synced for hours. It looked random.

Runtime evidence (prod, read-only):

- Render logs: `Processed cookies` for chrome 13,548 (atlas 4,657, safari 83)
  roughly every 5 minutes from 15:02Z to 16:25Z, `newlyInserted` 0 (±2) each
  time. Two uploads ran concurrently at 15:03-15:04Z.
- One Chrome upload (request f12d25f15342): `Received cookies` 16:19:17.8Z,
  start() progress write 16:19:17.869Z, next progress write 16:21:15.117Z,
  `Processed cookies` 16:21:27.1Z, HTTP 200 in 130,336 ms. The row read
  "syncing 0 of 13,548" for 117 of those 130 s. Atlas sat at 0 for about 38 s
  of its 43 s upload.
- `IntegrationSyncProgress` at 16:23Z: chrome/atlas/safari/chrome_passwords
  all `synced`, done = total, each with 8 retired run ids (the cap).
  `Integration.config.cookieCount` 13,548 / 4,657. No data was lost; the bar
  was reporting a background refresh as a fresh import.

## Diagnosis

Critical path: Mac app `SyncManager` (browserState, `SYNC_INTERVAL` 5 min) →
`BrowserStateSync.sync()` re-reads and uploads every connected browser's full
cookie set → `POST /api/integrations/cookies/upload` → `processCookiesUpload`
→ `uploadRunProgress.start()` writes a new run `syncing, done 0, total N` →
`upsertCookieBatches` runs its per-realm snapshot pre-phase (two serial
queries per auth realm, about 40 ms each) before the first 100-cookie batch
calls `advance()` → `buildAccountsView` prefers a live `syncing` run over the
CONNECTED row → front-end chip shows `0%` and the bar "0 of 13,548 cookies"
instead of the synced "13,548 cookies".

- Why 1: the account read `syncing 0 of N` because every upload, including the
  periodic re-upload of unchanged data, started a new progress run at done 0
  and advanced only after the pre-phase (117 s for 13,548 cookies).
- Why 2: `uploadRunProgress` treated every upload as a first import. It never
  considered that the row's last run had already finished `synced`, so a
  background refresh replaced the synced state the UI shows.
- Why 3 would be "the progress contract has no refresh state". That is a
  design choice; the in-repo precedent (Gmail's incremental `history` phase,
  which never shows the full bar) already keeps background refreshes light.
  Stop at Why 2.

Siblings fixed by the same rung: Chrome passwords (re-uploaded in the same
5-minute sync, "0 of 552" flicker), Safari and Atlas cookies, and VCF contact
re-imports, which all use `uploadRunProgress`.

Local reproduction: the blackbox parks a second, unchanged upload in its
pre-phase by holding that browser's `CookieBundle` row, then reads
`GET /api/integrations`. On base it fails with `edge: while an unchanged
re-upload of a synced browser runs, it keeps reading synced 120 of 120 cookies,
got syncing 0 of 120 (0%)`.

## Solution

`uploadRunProgress.start()` reads the stored state of the upload's rows with one
indexed query (`providersLastSynced`, best-effort). Rows whose last run finished
`synced` are refreshed without any `syncing` writes: no start/advance writes, so
the row keeps reading synced with its count. `finish()` / `fail()` still write
every row, so a refresh still records its own run and a failed refresh still
reads `sync_failed`. A first sync, a retry after a failure, or a run whose writer
died still shows the bar. Regressions in
`integration-accounts.pipelines.cases.ts` cover the refresh case, the
first-upload bar and failed refreshes.

10k behavior: adds one indexed read (userId, accountId, provider IN …) per
upload and removes every per-batch progress transaction of a refresh (about 12
advisory-lock transactions per Chrome upload). Net DB work per 5-minute cycle
goes down.

Not changed (outside the reported defect): the Mac app still re-uploads
unchanged cookie sets every 5 minutes, and the per-realm pre-phase still costs
O(realms) serial queries. On a first import, the bar can therefore still sit
at 0% during that pre-phase.

Golden reference: none of the reference harnesses (claude-code-src, codex,
openclaw, hermes-agent) has an integration-sync progress bar. The nearest
precedent is in this repo: Gmail's `GMAIL_LIGHT_PHASE` keeps incremental
refreshes off the full bar.

## Human feedback

Andy's scope (2026-10-20): integrations are a UI change plus a sync-progress
loading bar; do not rebuild pipelines, add multi-account or migrations — fix
the specific defect.

## Reusable lesson

Report progress only for work the user is waiting on: a background re-sync of
a row that already finished synced must keep reading synced until its terminal
write, never reopen a from-zero bar.
