---
id: 2026-11-06-mac-app-indexeddb-scan-blocked-main-process-beachball
date: 2026-11-06
title: The Mac app froze with the spinning beachball because the periodic browser-state sync decoded Chrome IndexedDB synchronously on the Electron main process
surface: mac-app
component: mac-app/main/domains/indexed-db-reader (called by browser-state-sync every 5 minutes and at startup)
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: mac-app/main/domains/indexed-db-reader/service.ts readIndexedDB — `await Promise.resolve()` then a fully synchronous readIndexedDbDatabases + JSON.stringify hash per origin on the main process
symptoms:
  - Mac app freezes with the spinning beachball
  - periodic browser-state sync blocks the Electron main process
  - synchronous IndexedDB scan stalls the event loop
tags:
  - mac-app
  - electron-main
  - beachball
  - indexeddb
  - browser-state-sync
sources:
  - memory: user report 2026-11-06
  - task local repro .context/beachball-rca (headless Chromium profile, 20,000 Gmail-like IndexedDB records)
repro: mac-app/tests/blackbox/indexed-db-reader.blackbox.ts › main-process responsiveness
status: fixed
---

## Problem

Andy saw intermittent stutters and the macOS spinning beachball in the Rose
Mac app. A beachball means the app's main event loop stopped processing
events. In Electron that loop is the main process: every window freezes when
main-process JavaScript runs for seconds.

## Diagnosis

1. `SyncManager` runs `browserState` sync at startup and every 5 minutes for
   any connected browser integration (`sync-manager/config.ts`).
2. That sync reads Chrome IndexedDB for `amazon`, `google`, `doordash`,
   `instacart`, `uber`, `netflix` and `spotify` origins
   (`browser-state-sync/config.ts` `INDEXED_DB_FILTERS`). Google matches
   Gmail/Docs/Drive offline stores, which are often tens of MB.
3. `indexed-db-reader/service.ts` yielded once (`await Promise.resolve()`,
   a microtask, which does not yield to the event loop) and then called the
   pure-TypeScript LevelDB/V8 decoder synchronously per origin, followed by a
   synchronous `JSON.stringify` of the entire origin for its hash. Its own
   comment called this "synchronous CPU/IO work".
4. Measured with the real decoder in this repo:
   - A real Chromium profile created by headless Chromium (20,000 Gmail-like
     records, 7 MB on disk) blocked the event loop for **3,569 ms** in one
     task (scan 3,555 ms). macOS shows the beachball after about 2 s.
   - The cemented fixture (8,000 records) stalls the loop for about 600 ms.
5. The same sync then uploads the payload: `browser-state-sync/repo.ts`
   `postEncryptedPayload` ran one `JSON.stringify` over the batch. For the
   20,000-record profile (38 MB JSON) that alone blocked for **1,476 ms**.

## Solution

- `main/base/timeSlice.ts` `SliceClock` (8 ms budget) hands the loop back with
  `setImmediate` once a slice is used up.
- `readIndexedDbDatabasesSliced` drains raw LevelDB records and decodes object
  store records in slices. `computeOriginHashSliced` (`service-hash.ts`) feeds
  sha256 the exact bytes `JSON.stringify(databases)` produced, record by
  record, so change-detection hashes are unchanged.
- `readIndexedDB` uses both. The synchronous decoder remains for tests.
- `jsonToBufferSliced` (`main/base/timeSlice.ts`) produces the exact UTF-8
  bytes of `JSON.stringify(payload)` in slices, encoding in bounded chunks.
  Every encrypted browser-state upload now uses it.

After the fix, the same 20,000-record Chromium profile had a longest stall of
**58–82 ms** (hash identical), and its upload serialization stalled for
**17 ms** instead of 1,476 ms (byte-identical). The fixture stall went from
about 600 ms to about 30 ms.

## Regression

`mac-app/tests/blackbox/indexed-db-reader.blackbox.ts` › "keeps the event loop
responsive while scanning a large IndexedDB (no beachball)". The control
synchronous scan must stall for more than 200 ms. The production
`IndexedDBReader.readIndexedDB` must stall for less than 250 ms and less than a
third of the control. Its payload and hash must equal the synchronous output.
`mac-app/tests/blackbox/time-slice.blackbox.ts` asserts byte parity with
`JSON.stringify` across value shapes, including `toJSON(key)` and boxed
primitives. Flat primitive arrays and wide objects must also yield. A 74 MB
payload must stall for less than 150 ms and less than half of
`JSON.stringify`, which itself must stall for more than 150 ms. Both run in
the mac-app vitest suite used by `/deploy`.

## Open / Mac-only

The archive status denotes the measured main-process fix; Mac-side confirmation remains pending.

- This repro runs on Linux Node 22, not Electron on Andy's Mac, and his IndexedDB
  size is unknown. The console log line
  `[IndexedDBReader] Read N origins, D databases, R records` in
  `~/Library/Application Support/Rose/mac-app-console-logs.log` gives the
  scale. If he freezes again, capture an Activity Monitor **Sample Process** of
  the Rose main process during the freeze.
- LevelDB files are now read lazily, one at a time during iteration. A single
  huge record or blob, the metadata passes and runs of non-matching records
  still execute without checkpoints (reviewer finding; not measured as a stall).
- Other main-process synchronous work was not measured on macOS:
  - `security find-generic-password` via `execSync` every 10 s from the compute
    credential sync
  - better-sqlite3 reads of copied cookie databases and `chat.db`
  - `node-mac-contacts` enumeration
- The renderer liquid-metal shader (`@paper-design/shaders`) pauses only when
  `document.hidden`. It is one small canvas in the update chip, which makes it
  an unlikely cause of a multi-second freeze.

## Human feedback

The original report described intermittent Mac-app stutters and the spinning beachball. Preserve the distinction between the measured local reproduction and the still-pending Mac-side confirmation above.

## Reusable lesson

Bound synchronous decoding and serialization on a UI-owning event loop, and test responsiveness alongside byte and hash equivalence. A local regression result does not replace platform-specific acceptance.
