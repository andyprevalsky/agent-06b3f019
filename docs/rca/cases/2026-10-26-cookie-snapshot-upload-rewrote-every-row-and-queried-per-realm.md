---
id: 2026-10-26-cookie-snapshot-upload-rewrote-every-row-and-queried-per-realm
date: 2026-10-26
title: Mac cookie snapshot upload rewrote every Cookie row and ran two queries per site every 5 minutes
surface: back-end
component: integrations-cookie-upload
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/domains/integrations/uploadService.browser.ts upsertCookieBatches (per-realm cookieBundleSnapshotChanged SELECT + upsertCookieBundle) and repo.bulk.ts bulkUpsertCookies (ON CONFLICT DO UPDATE with no change guard, syncedAt = NOW())
symptoms:
  - 'SELECT domain || CHR($6) || name || CHR($7) || path || CHR($8) || "topFrameSiteKey" || CHR($9) || COALESCE("browserProfile", $10) AS identity'
  - pg_stat_statements 55,802,527 calls / 178,788 s for the cookie snapshot SELECT
  - 'DELETE FROM "CookieBundle" bundle WHERE ... NOT EXISTS mean 199 ms'
  - Cookie n_tup_upd 327,941,150 with ~53k live rows
  - expected unchanged re-upload to rewrite 0 Cookie rows, rewrote 40/40
tags:
  - scale
  - cookies
  - mac-app-sync
  - write-amplification
  - postgres
sources:
  - PR #1579
  - commit 1670e21437631f85c8fcc431862f4281f77e9b13
  - memory:scalability-audit-100-seats-20261024 (thread thr_1981ff79aa724ae59870f1829121c7e1, lane S5)
  - task S5 prod pg_stat_statements read-only snapshot 2026-10-26 (stats since 2025-11-21)
repro: back-end/src/tests/blackbox/browser-credential-sync.blackbox.ts ("unchanged cookie re-upload rewrites no rows and issues O(1) statements per upload")
status: fixed
---

## Problem

The Mac app uploads the full cookie snapshot for each browser every 5 minutes
(`mac-app/main/domains/sync-manager/config.ts`). Each upload did per-realm work
on the server: one snapshot SELECT and one CookieBundle upsert for every site.
It also re-upserted every cookie with `syncedAt = NOW()`, writing a new tuple
for every row, and ran a cleanup DELETE whose `NOT EXISTS` suffix join cost
about 200 ms per profile.

Prod pg_stat_statements, read-only, cumulative since 2025-11-21:

| Statement                   | Calls | DB time   | Notes     |
| --------------------------- | ----- | --------- | --------- |
| Snapshot SELECT             | 55.8M | 178,788 s |           |
| CookieBundle upsert         | 55.8M |           |           |
| Cookie batch upsert         | 3.2M  |           | 322M rows |
| CookieBundle cleanup DELETE | 237k  | 47,259 s  |           |

`pg_stat_user_tables` shows 327.9M Cookie updates against about 53k live rows.
These are cumulative counters, so they don't show how many users caused them.
The Cookie table's `syncedAt` showed 18,288 cookies re-written for one user in
the last day. At 100 Macs with 1–4k sites each, this is about 1–3k queries/s
of pure no-op churn.

## Diagnosis

**First-bad boundary:** `upsertCookieBatches` loops over `groupByProfileAndRealm`.
For each realm it calls `cookieBundleSnapshotChanged`, a SELECT that
re-signatures every stored cookie of that realm, then `upsertCookieBundle`.
The number of statements therefore grows with the number of sites.
`bulkUpsertCookies` had no `WHERE` guard on `DO UPDATE`, so identical content
still produced a new tuple for every row.

**Deepest owned cause:** a snapshot-replace sync was implemented as
"rewrite everything, then compare". The LocalStorage/IndexedDB uploads skip
unchanged rows by hash; this path had no such guard.

**Local repro:** a 40-realm unchanged re-upload rewrote 40/40 Cookie rows,
measured by `xmin`.

## Solution

**Cookie upsert.** It now carries
`WHERE (stored columns) IS DISTINCT FROM (EXCLUDED columns)` and
`RETURNING domain, browserProfile, (xmax = 0) AS inserted`. Unchanged cookies
get no new tuple. `syncedAt` now records when the content last changed.

**Changed-realm detection.** The snapshot DELETE gained `RETURNING domain`.
The changed realms are derived from the rows that the upsert and DELETE
actually returned, using the same suffix match as before. This replaces one
SELECT per site. Bundle writes are set-based:

- one `INSERT ... SELECT unnest(...) ON CONFLICT DO NOTHING` for missing bundles;
- one `UPDATE ... FROM unnest(...)`, only for changed realms. It bumps
  `updatedAt` and clears the disabled state, as before.

**Orphan cleanup.** One indexed SELECT of the profile's bundles, an in-memory
suffix match against the uploaded hosts, and a `DELETE ... id IN (...)` only
when orphans exist. This replaces the `NOT EXISTS` join.

**Unchanged semantics:**

- Bundle ranking still uses each cookie's own `lastUpdateUtc`/`lastAccessUtc`.
- A disabled bundle is re-enabled only when its realm's cookies change.
- An empty snapshot still deletes everything.
- Integration `lastSyncAt` is still bumped on every upload.

The only `syncedAt` reader is a benchmark diagnostic string, so "last content
change" is a safe meaning for it.

**Scale (rule 28).** Per upload the cost is:

```
1 + P + ceil(N/100) + ≤1 + 1 + ≤1 statements
```

where P is the number of profiles and N the number of cookies. Rows written are
proportional to the cookies that actually changed. The previous cost was
`2·realms + ceil(N/100) + 2P` statements, with all N rows rewritten. Everything
stays keyed per user; no shared rows or locks are added. Clients already in
the field get the fix without a Mac release.

**Shipped (PR #1579, merge 1670e2143, Render live 2026-10-26 ~20:50Z).** Prod check, read-only, 20:52→21:02Z:

- The old per-realm bundle upsert and the cleanup DELETE made 0 new calls.
- The set-based bundle insert ran 6 times, one per upload.
- Cookie row updates were +235 in 10 minutes, about 24/min. Before the fix the rate was about 3.4k/min.

CodeRabbit found that the touched/live realm keys were not canonical (a mixed-case host). That was fixed with its own regression test before merge.

## Human feedback

None recorded.

## Reusable lesson

Give every periodic snapshot upsert an `IS DISTINCT FROM` guard. Derive
"what changed" from the write's `RETURNING`, never from a per-key comparison
SELECT.
