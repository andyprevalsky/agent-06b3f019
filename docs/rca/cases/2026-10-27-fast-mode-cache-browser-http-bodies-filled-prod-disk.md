---
id: 2026-10-27-fast-mode-cache-browser-http-bodies-filled-prod-disk
date: 2026-10-27
title: Fast Mode cache stored every browser_http response body inline, filling 50 GB of the 61 GB production database
surface: back-end
component: demo-cache
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/src/providers/demoCacheStore.ts cacheSetWithAck upserted every browser_http value (base64 response bodies up to ~30 MB) inline into FastModeCacheEntry.value and rewrote the whole TOASTed value on every identical re-record"
symptoms:
  - "FastModeCacheEntry: 1.41M rows, 50 GB (heap 0.84 GB, TOAST 48 GB) of a 61 GB database with ~27 GB free"
  - "browser_http: 1.12M rows, ~42–46 GB; 82% of its bytes in rows of 64 KB or more; grew ~18 GB in October"
  - "pg_stat_user_tables: 2.98M updates against 1.49M inserts (identical bodies re-recorded)"
tags:
  - demo-cache
  - fast-mode
  - disk
  - postgres
  - toast
  - storage
sources:
  - memory:scalability-audit-100-seats-20261024
  - memory:feedback-sim-shared-fast-cache
  - memory:mass-agent-fully-demo-cached
repro: back-end/src/tests/blackbox/demo-cache-offload.blackbox.ts
status: fixed
---

## Problem

Production's database was 61 GB with about 27 GB free, and `FastModeCacheEntry` held 50 GB of it. The table has no TTL, so it was the main disk-exhaustion risk.

## Diagnosis

Read-only measurement (5% `TABLESAMPLE`, ClickHouse worker logs):

- **Where the bytes are:** browser_http is ~46 GB of compressed values. Of its bytes, 34.6% are in rows over 1 MB and 82% in rows of 64 KB or more. The content is mostly JavaScript bundles, JSON, HTML, images and mp4.
- **Who writes it:** none of it is sim, demo-goal or mass-agent data. Sim rows are `llm`/`web_*` kinds; demo and mass-agent replay reads LLM rows. browser_http growth comes from write-through recording of Andy's and Tamy's real tasks. In the last 7 days of production logs there were 63,760 `browser_http_stored` events and 0 hits.
- **Churn:** the upsert rewrote the full value on every re-record, giving 2.98M updates against 1.49M inserts. Overwrites keep the original `createdAt`, so the age buckets understate recent growth.

The table's design stored arbitrary response bodies inline in Postgres, which is the most expensive place for blobs. A blob-pointer mechanism (`blobPath` plus the attachments bucket) already existed, but only `web_fetch` used it.

## Solution

Bodies move to Storage without changing what any reader sees.

- **Write path** (`demoCacheOffload.ts`, `cacheSetWithAck`): a browser_http value whose serialized size is 64 KB or more is uploaded to `attachments/fast-mode-cache/values/<sha256>.json`. The path is content-addressed and the upload immutable, so identical bodies under many keys are stored once. The row keeps `{"$fastCacheOffload": {path, sha256, bytes}}`.
- **Identical re-records:** if the row already points at the same sha256, the write skips both the upload and the row write.
- **Read path** (`cacheGetMany`): the backend rehydrates pointers, verifies the sha256 and returns the original value. A missing or corrupt object is a cache miss, never a wrong hit. Agents and the HTTP contract are unchanged. `llm` and other kinds, including every demo, sim and mass-agent row, stay inline.
- **Existing rows** (`scripts/offload-fast-cache-values.ts`): a primary-key-ordered, resumable backfill with `--dry-run`, per-batch receipts and statement/lock timeouts. It reads only rows whose stored size is 16 KB or more. Each body is uploaded and read back before the row is pointed at it, and the row is replaced only if it still holds the uploaded value.
- **Prod dry run** (40,000 rows): 1,714 rows (0.59 GB) would move, with 16 workers at ~9 rows/s.
- **Order matters:** the backfill must run only after this backend is live, because older backends would serve pointers raw.

At 10,000 agents: a write performs at most one indexed read and one content-addressed upload per large body. A read adds one Storage GET per large row that misses the in-process cache. Database growth from browser_http falls to the sub-64 KB remainder, about 18% of its bytes.

Not done here (product decision): evicting never-read write-through rows (TTL/LRU), which would need a `lastHitAt` column. Offloading alone removes the disk risk without changing what the cache keeps.

## Human feedback

Andy's constraints: sim guests write `sim.*` rows to this store by design, mass-agent is fully demo-cached, and demos depend on the store. Only the storage location changed, so every hit behaves as before.

## Reusable lesson

Store large opaque bodies in object storage behind a verified content-addressed pointer, not inline in a relational row. Skip rewriting values that have not changed.
