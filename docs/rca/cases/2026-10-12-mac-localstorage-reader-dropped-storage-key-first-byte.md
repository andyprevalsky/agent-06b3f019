---
id: 2026-10-12-mac-localstorage-reader-dropped-storage-key-first-byte
date: 2026-10-12
title: Mac localStorage reader dropped the storage key's first byte, so restores replayed duplicate and cross-site storage
surface: cross
component: local-storage-reader
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: mac-app/main/domains/local-storage-reader/service.ts parseKey treated the first storage-key byte as an origin encoding byte; Chrome writes "_" + ASCII storage key + NUL + encoding byte + key
symptoms:
  - "ttps://www.google.com"
  - "hrome-extension://"
  - "ttps://secure-devicefp.visa.com/^0https://google.com"
  - "Browser session init failed after 5 transient-proxy retries"
tags:
  - localstorage
  - leveldb
  - mac-app
  - browser-credentials
  - storage-partitioning
  - data-quality
sources:
  - agent 07281fc3-5e49-4cd2-9573-235cb19b0481
  - commit 842e04479
repro: mac-app/tests/blackbox/local-storage-reader.blackbox.ts
status: open
---

## Problem

Agent `07281fc3-5e49-4cd2-9573-235cb19b0481` restored 38–39 localStorage
origins for every google.com browser init. Prod rows for that user held
duplicate keys such as `ttps://www.google.com` (Mac) beside
`https://www.google.com` (cloud harvest), plus partitioned third-party keys
such as `ttps://secure-devicefp.visa.com/^0https://google.com`. Fleet-wide,
10,709 of 11,070 `LocalStorageOrigin` rows (230 users) were truncated and 4,632
were partitioned; extension rows appeared as `hrome-extension://`, so the
reader's `chrome-extension://` filter never matched. Each extra origin cost
~165 ms per init from Render and ~340 ms from a dev box, contributing to the
18-second state-injection timeouts in
2026-09-30-browser-origin-injection-materialized-jsonb.

## Diagnosis

Real Chromium writes `_https://www.example.com\x00\x01first_party_key` (bytes
read from a fresh profile's `Local Storage/leveldb/000003.log`). `parseKey`
consumed `h` as an origin encoding byte. Its blackbox fixture encoded the same
wrong framing and claimed it matched Chrome, so the suite cemented the defect.
Commit 842e04479 noticed `ttps://` origins and patched them at injection
(`ttps` → `https`, strip `/^0…`). That patch replayed partitioned third-party
storage as first-party storage on unrelated origins (visa.com, youtube.com,
cardinalcommerce.com in a Google session). It also visited an origin once per
row, in arbitrary order, so Mac and cloud-harvest rows for one origin cost
separate navigations and the newer value did not reliably win.

Local repro: the real `parseKey` on the captured bytes returned
`ttps://www.example.com`. A drafted mac blackbox case failed on the unchanged
reader with exactly the prod prefixes (`evtools://`, `hrome-extension://`,
`hrome://`, `ile://`, `ttp://`, `ttps://…^0…`). On Linux, run it with the
mac-app's pinned vitest 2.1.9.

## Solution

Landed now, at the restore boundary that every environment shares:
`injectLocalStorageState` decodes stored keys through one rule. It repairs
only the dropped `h`, keeps only first-party http(s) origins (skipping
partitioned, extension and internal keys), and restores each origin's rows
oldest-first in a single visit. Regression: `verifyRealmRestoreBudget` in
`browser-origin-payload.blackbox.ts`. The old restorer failed it with
`partitioned third-party storage was replayed first-party`.

Deferred, and why. A drafted reader fix with ingest canonicalization and a
prod data migration was withdrawn after adversarial review:
1. Local, Conductor and cloud databases (via `db push`) and the frozen seed
   fixtures keep legacy rows that a prod-only migration never reaches.
2. The in-place rename would make `seed-jsonb-stream.ts` hit a primary-key
   conflict.
3. `LocalStorageOrigin` has no source dimension. Once Mac keys are canonical,
   the Mac upload (replaces whole rows) and the cloud harvest (merges keys)
   would share one row, and every Mac sync would erase cloud sign-in keys.

Fixing the reader needs a source column like `Cookie.browserSource` first. The
Mac IndexedDB reader also rebuilds origins from folder names and drops
non-default ports (`indexed-db-reader/native/discovery.ts`).

## Human feedback

None recorded.

## Reusable lesson

Build parser fixtures from bytes the real producer wrote, and decode legacy stored keys at the boundary every environment reads, not with a prod-only data migration.
