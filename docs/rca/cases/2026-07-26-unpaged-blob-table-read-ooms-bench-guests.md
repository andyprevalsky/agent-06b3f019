---
id: 2026-07-26-unpaged-blob-table-read-ooms-bench-guests
date: 2026-07-26
title: Unpaged findMany over blob-bearing credential tables OOM-killed every cloud bench guest during first-run seed
surface: back-end
component: seed-local
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: seed-local.ts — read whole blob-bearing tables with an unpaged findMany before writing a single row
symptoms:
  - "Out of memory: Killed process 1487 (node) anon-rss:3482344kB"
  - "daily slice returned 0/44 with no benchmark verdict on any task"
  - three SIGKILLs per guest during first-run DB seed, then stack abort
  - run looked like "stuck in queue" for 40 minutes
tags:
  - oom
  - benchmark-seed
  - cloudbench
  - paging
  - prisma
sources:
  - PR #909
  - commit de8a81f1b
repro: back-end/src/tests/blackbox/seed-origin-paging.blackbox.ts
status: fixed
---

## Problem

All 44 cloud bench guests were OOM-killed during the first-run DB seed — three
SIGKILLs each — then aborted their stack. The daily slice returned 0/44 with no
benchmark verdict on any task. Kernel evidence:

```
[172.798] Out of memory: Killed process 1487 (node) anon-rss:3482344kB  (4GB guest)
[155.271] Out of memory: Killed process 1507 (node) anon-rss:5946368kB  (8GB guest)
```

## Diagnosis

`seed-local.ts` read whole blob-bearing tables with an unpaged `findMany` before
writing a single row. `LocalStorageOrigin.entries` is 84MB of JSON across ~3.7k
prod rows, and one `IndexedDBOrigin.databases` row is 38MB uncompressed; parsed
into V8 objects that is multiple GB. Memory usage grew to fill whatever the guest
had — which is why the 8GB guests died too. A bigger box was never the fix; the
read was O(table) by construction.

## Solution

`syncPagedCredentials` pages the remote read and releases each page before
fetching the next, so peak heap is O(page) rather than O(table). The local
snapshot read is narrowed to the current page — an unscoped snapshot
re-materializes every already-synced blob row and restores the O(table) peak.
Page sizes are per-table: blob-heavy origin tables page at 1 row, because a
single 38MB row measured OOM at a 400MB heap and passed at 900MB, making the
largest single row the irreducible bound. Cemented by
`seed-origin-paging.blackbox.ts`, observed failing on `origin/main` first (1/6
pre-fix, 6/6 post-fix) and asserting peak residency is bounded by page size.

## Human feedback

`/descend` gained a hard rule as a result: zero started tasks after 5 minutes is
a fault, not a slow start — poll every 60s and prove liveness from the guest,
never from the controller's own waiting line.

## Reusable lesson

Any seed or sync that reads a blob-bearing table must page and release per page —
an unpaged read is O(table) memory and a larger guest only moves the crash later.
