---
id: 2026-10-26-cookie-full-jar-select-is-retired-cumulative-stat
date: 2026-10-26
title: The 2.9 s Cookie id/domain/name/expiresUtc SELECT is a retired caller's cumulative pg_stat_statements row, not live load
surface: back-end
component: integrations-routes
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: GET /api/integrations (commit 6829a23da, 2026-01-21) called prisma.cookie.findMany({ where: { userId }, select: { domain, name, expiresUtc } }) on every request and filtered auth cookies in Node; commit 65e1ab2a4 (2026-03-06) replaced it with the filtered SELECT DISTINCT in domains/integrations/repo.ts, but pg_stat_statements (reset 2025-11-21) still reports the old statement's lifetime totals
symptoms:
  - "pg_stat_statements: SELECT Cookie.id, domain, name, expiresUtc FROM Cookie WHERE userId = $1 OFFSET $2 — 3,810 calls, 2,885 ms mean, 119 s max, 1.95 B rows"
  - "1.95 B rows / 3,810 calls = 512k rows per call, while the whole Cookie table now holds 53k live rows"
  - "No current back-end source selects that column set; the call count did not move across a 10-minute production sample"
tags:
  - postgres
  - pg-stat-statements
  - cookies
  - scale
  - measurement
sources:
  - task S11 prod pg_stat_statements read-only snapshot 2026-10-26 (stats since 2025-11-21)
  - commit 6829a23da
  - commit 65e1ab2a4
  - task S5 cookie snapshot RCA 2026-10-26-cookie-snapshot-upload-rewrote-every-row-and-queried-per-realm
repro: none-recorded
status: fixed
---

## Problem

After PR #1579 shipped, lane S5 flagged a Cookie statement averaging ~2.9 s:

```sql
SELECT "public"."Cookie"."id", "public"."Cookie"."domain", "public"."Cookie"."name",
       "public"."Cookie"."expiresUtc"
FROM "public"."Cookie" WHERE "public"."Cookie"."userId" = $1 OFFSET $2
```

Production, read-only (`BEGIN READ ONLY`, 15 s statement timeout), 2026-10-26:

| Measure | Value |
| --- | --- |
| calls / mean / max | 3,810 / 2,885 ms / 119,353 ms |
| total time | 10,992 s |
| rows returned | 1,952,259,791 (≈512k per call) |
| shared blocks hit / read | 32.1M / 41.2M |
| stats reset | 2025-11-21 07:40 UTC |
| Cookie table now | 53,082 live rows, 72 MB total, 44 MB heap |
| largest user now | 24,743 rows / 2,580 domains (49% of table) |

## Diagnosis

1. **Exact SQL producer.** Prisma 5.22 adds the primary key to a narrowed
   selection. Locally, `prisma.cookie.findMany({ where: { userId }, select:
   { domain: true, name: true, expiresUtc: true } })` emitted the byte-identical
   statement above, including `OFFSET $2`.
2. **Caller.** That call existed only in `GET /api/integrations` from commit
   `6829a23da` (2026-01-21, "unified browser state sync"). It loaded the
   user's whole cookie jar on each request so Node could choose auth domains.
   Commit `65e1ab2a4` (2026-03-06) replaced it with the filtered `SELECT
   DISTINCT … name ~* … expiresUtc …` query in
   `back-end/src/domains/integrations/repo.ts`, which has its own result cache.
   In prod that successor shows 38,440 calls at 59.9 ms mean. No current
   `back-end/src` or `back-end/scripts` code selects `id, domain, name,
   expiresUtc` with a `userId`-only filter; every remaining `expiresUtc`
   selection also filters by `browserSource`/`browserProfile` and a domain.
3. **Not live.** pg_stat_statements has no last-call timestamp. Snapshots at
   22:32:55 and 22:42:49 UTC left this queryid at exactly 3,810 calls and
   10,992,030 ms. The other sampled Cookie SELECTs also did not move in that
   quiet window, so the delta alone is weak. The decisive evidence is that
   current source has no producer for the statement. Its 512k average rows per
   call is ten times larger than today's whole table.
   It reflects earlier duplicated cookie jars (6.17M inserts and 6.48M deletes
   recorded on the table), before dedup and the March route change.
4. **No index fix exists for this shape.** The statement asks for every cookie a
   user owns. Today's plain EXPLAIN for the largest user chooses a sequential
   scan (`rows=24717`). That is the correct plan for 49% of a 44 MB heap; a
   covering index would still return every row. A synthetic local copy with
   the production distribution (53,098 rows, same indexes, PG16) runs it in
   10.4 ms (`Index Scan using Cookie_userId_idx`, 2,497 shared hits) and 31 ms
   through Prisma. The historical 2.9 s came from the row volume, not from a
   missing index.

## Solution

No code, index, or migration change. The defect, an unbounded per-request read
of the full cookie jar, was removed by commit `65e1ab2a4` in March 2026.
Adding an index for a dead statement would only add write cost to a table that
sees millions of inserts and deletes during snapshot uploads.

**10k-agent statement:** the current integrations path runs one filtered,
cached aggregate per user request, not per agent, and returns distinct auth
domains instead of the jar. Agent count adds no Cookie reads to that route.
The live Cookie cost leaders remain those addressed by S5: the snapshot
identity SELECT, with 55.9M calls and 179,210 s total, and the CookieBundle
cleanup DELETE, with 237k calls and 199 ms mean. Judge them by deltas after
PR #1579, not by lifetime totals.

## Human feedback

None yet.

## Reusable lesson

pg_stat_statements totals are cumulative since `pg_stat_statements_info.stats_reset`
(here 11 months) and carry no last-execution time. Before assigning a slow
statement for repair, (1) take two snapshots of its `calls`/`total_exec_time`
some minutes apart and require a non-zero delta, (2) compare `rows / calls`
against the table's current size, and (3) reproduce the exact statement text
from current source, e.g. by logging Prisma's emitted SQL against a local
database. A statement with no delta, impossible row counts, and no producer in
the tree is a retired caller, not a scaling defect.
