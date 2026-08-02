---
id: 2026-07-29-prisma-json-codec-decodes-41mb-row
date: 2026-07-29
title: Prisma's JSON codec decoded a single 41MB JSONB row into V8 objects and OOM-killed the bench guest
surface: back-end
component: seed-local
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: syncOriginCredentials — read and wrote the origin payload through Prisma's JSON codec
symptoms:
  - "browser-biometrics-webdecoy produced no verdict on the cloud bench guest"
  - "seed-local.ts stdout ends abruptly after \"LocalStorage: 3733 synced\" with no error and no stderr"
  - "FATAL \"JavaScript heap out of memory\" during --credentials-only sync"
  - "LocalStorage credential sync failed after 3 attempts:" (message empty after the colon)
tags:
  - prisma
  - oom
  - sigkill
  - benchmark-seed
  - jsonb
sources:
  - commit 281c494e9
repro: back-end/src/tests/blackbox/seed-blob-origin-memory.blackbox.ts
status: fixed
---

## Problem

The `browser-biometrics-webdecoy` benchmark returned no verdict on a cloud bench
guest. Its live fixture runs `seed-local.ts --credentials-only`, whose stdout
ended abruptly after `LocalStorage: 3733 synced` with no error and no stderr —
the SIGKILL signature. The next table in the sequence is IndexedDB, whose
largest prod row is a single 41MB JSON blob. Measured on the real production
sync path against real Postgres: FATAL "JavaScript heap out of memory" under a
256MB heap and 3454MB peak RSS when given 2048MB, on a shared-cpu-2x/4096MB
guest that was also running Postgres, the backend, a Temporal worker and a
browser stack.

## Diagnosis

`syncOriginCredentials` read and wrote the payload through Prisma's JSON codec.
Decoding a 41MB JSONB value into hundreds of thousands of V8 objects and
re-encoding the graph to write it back cost ~3.5-4.0GB RSS **for that one row**.
A prior RCA had added paging, which bounded the ROW COUNT but not the BYTE SIZE
— so even at page size 1 the peak was still set by the largest single row. The
deeper cause is that the ORM's value-materialising codec was on the path of a
bulk blob transfer that never needed the value decoded at all.

A second, independent defect hid the failure: Prisma driver errors routinely
carry an empty `message`, so one failure rendered as
`LocalStorage credential sync failed after 3 attempts:` with nothing after the
colon.

## Solution

The payload is now never decoded and never fully resident. Origin pages carry
identity + hash only (`ORIGIN_META_SELECT`), so an unchanged origin transfers no
payload at all. Payloads cross as `::text` under a 4MB byte budget per round trip
and go back in as `$n::jsonb` (Postgres normalises jsonb identically on both
sides, so the stored value is byte-for-byte what a decoded round trip produced).
A row too big for one round trip streams through a per-row `ON COMMIT DROP` temp
table inside an interactive transaction, with window offsets measured in Postgres
characters rather than JS UTF-16 code units so astral-plane characters cannot
desynchronise the splice. The batch read is byte-budgeted rather than per-row, so
the ~3.7k small LocalStorage origins still cost about one read per page.
`describeSyncError()` falls back to name/code/meta so a seed failure can never
describe itself as the empty string. Applied to all three blob-origin tables, so
LocalStorage and CacheStorage get the same bound, not only the table that
happened to blow up.

Post-fix: green under a 96MB heap, 311MB peak RSS on a 50MB synthetic row. Full
production `--credentials-only` sync into a fresh database: 208s, 574MB peak RSS,
every origin verified byte-identical to prod by server-side md5 — IndexedDB
16/16 (40.9MB), LocalStorage 3734/3734 (81.4MB), CacheStorage 67/67, zero
missing, zero mismatched. Cemented by `seed-blob-origin-memory` (byte-size bound)
alongside `seed-origin-paging` (row-count bound), both auto-discovered by the
blackbox runner `/deploy` invokes.

## Human feedback

None recorded.

## Reusable lesson

When bulk-moving blob columns, bound the transfer by BYTES and keep the ORM's
value codec off the path entirely — paging by row count does not bound peak
memory when one row is huge.
