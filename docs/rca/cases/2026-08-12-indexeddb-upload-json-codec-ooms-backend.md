---
id: 2026-08-12-indexeddb-upload-json-codec-ooms-backend
date: 2026-08-12
title: IndexedDB upload JSON.parse of databases blobs OOM-killed the Render backend and took login down with 502s
surface: back-end
component: integrations-indexeddb-upload
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: POST /api/integrations/indexedDB/upload — decryptCompressedPayload JSON.parse + processIndexedDBUpload JSON.stringify(databases) through Prisma's query protocol
symptoms:
  - "FATAL ERROR: Zone Allocation failed - process out of memory"
  - "Received IndexedDB origins"
  - "npm error code 134"
  - "server_failed nonZeroExit 134"
  - "https://navi-j9a9.onrender.com/health -> 502"
tags:
  - indexeddb
  - oom
  - upload
  - prisma
  - jsonb
  - render
  - login
  - 502
sources:
  - agent bc-019ff52c-1af4-7932-b397-677856e94aac
repro: back-end/src/tests/blackbox/indexeddb-upload-memory.blackbox.ts
status: fixed
---

## Problem

Production login was down: `https://navi-j9a9.onrender.com/health` and every
auth route returned Render's HTML 502 page. The Navi web service was
crash-looping every ~5 minutes with `server_failed` / `nonZeroExit: 134`. App
logs showed `FATAL ERROR: Zone Allocation failed - process out of memory`
immediately after `Received IndexedDB origins` for user
`1f85ff25-6e29-4c1b-8739-f917bd101a30`. The matching HTTP span
`POST /api/integrations/indexedDB/upload` started ~80s earlier and was still
decrypting while 24 concurrent localStorage batches and the 5-minute Plaid cron
ran. Frontend (Vercel) stayed up (200/307); only the backend was dead.

## Diagnosis

Archive searches (`Zone Allocation failed out of memory IndexedDB`,
`Received IndexedDB origins upload crash`, `backend OOM crash loop login 502`)
surfaced the relative
`2026-07-29-prisma-json-codec-decodes-41mb-row` (seed path) and the older
`2026-03-03-unbounded-llm-request-logging-oom`. This incident is a **relative**:
same class (V8 JSON codec on a multi-MB IndexedDB `databases` blob), different
boundary (machine-upload ingest, not seed sync).

Critical path:

```
mac-app sync → POST /indexedDB/upload (multer)
  → decryptCompressedPayload (gunzip + JSON.parse full envelope)
  → processIndexedDBUpload (JSON.stringify(databases) per origin)
  → Prisma $executeRawUnsafe bind (JSON query protocol re-stringifies params)
  → V8 heap / Zone Allocation OOM → process abort 134 → Render 502 → login down
```

Prod DB evidence: largest `IndexedDBOrigin.databases` is an 8.7MB
`https://drive.google.com` row for the same user. Seed RCA already proved that
decoding that shape into a V8 object graph costs gigabytes of RSS.

Local repro (`indexeddb-upload-memory.blackbox.ts`): a ~50MB nested fixture under
`--max-old-space-size=256`.

- **Pre-fix control:** `JSON.parse` + `JSON.stringify(databases)` (+ protocol-shaped
  re-encode) → `FATAL ERROR: JavaScript heap out of memory`.
- **Pre-fix treatment (buggy ingest):** peak RSS 722MB for a 49.9MB payload; pulling
  `databases` back through Prisma and rebinding also FATAL'd on `JsonStringify`.
- **Post-fix treatment:** set-based Postgres upsert (databases never enters Node)
  survives the same 256MB heap and round-trips by server-side md5.

Deepest owned cause (Step 5a): blob-origin machine uploads used the ORM/JSON
codec on a bulk transfer that never needed the value decoded in process — the
same gap the seed path already fixed, left open on the HTTP ingest boundary.

## Solution

1. `decryptCompressedToUtf8` — decrypt/gunzip to text without `JSON.parse`.
2. `ingestIndexedDBUploadJson` / `ingestIndexedDBUploadJsonDocument` — bind the
   document once into a TEMP table inside an interactive transaction, then
   set-based `INSERT … SELECT … e->'databases'` so the blob never crosses back
   into Node. 64MB decompressed ceiling returns 413.
3. Route `POST /indexedDB/upload` uses the text path exclusively.
4. Cemented by `indexeddb-upload-memory` (auto-discovered by
   `run-blackbox-tests.sh` / coverage).

10k-agent behavior: per-request memory is now O(decompressed JSON text) + fixed
Postgres work, not O(object-graph × concurrent uploads). One large IndexedDB
sync can no longer abort the shared web process and take auth for every user
with it. Sibling failures prevented: any future origin whose `databases` grows
past a few MB (Gmail/Drive-class) on the upload path.

## Human feedback

None recorded.

## Reusable lesson

Never JSON.parse or re-bind multi-megabyte browser-origin blobs through Node —
keep `databases`/`entries`/`caches` as Postgres jsonb text for the whole ingest,
exactly as the seed blob path already requires.
