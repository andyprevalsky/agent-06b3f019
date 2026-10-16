---
id: 2026-06-27-stray-db-push-from-another-worktree-dropped-a-prod-column
date: 2026-06-27
title: A `db push` from another worktree against the prod `DATABASE_URL` dropped `Agent.fastModeCacheEnabled` after its migration had been recorded applied
surface: back-end
component: prisma-migrations
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/.env DATABASE_URL points at PROD Supabase, so any prisma db push / migrate dev from any worktree rewrites prod DDL
symptoms:
  - 'The column "Agent.fastModeCacheEnabled" does not exist in the current database.'
  - "every GET /api/agents returns 500 while /health returns 200"
  - 'component Agents logs "Failed to fetch agents"; dashboard fully broken'
  - 'prod migration-declared GIN trigram indexes ("Agent_title_trgm_idx", "Message_text_trgm_idx") missing while _prisma_migrations records them applied'
  - "local DATABASE_URL override left production DIRECT_URL selected; Credit_userId_fkey failed during Prisma AddForeignKey"
tags:
  - prisma
  - db-push
  - prod-500
  - schema-drift
  - supabase
  - trigram-index
sources:
  - memory:project_prod_agents_500_fastmodecache_jun2026
  - PR #1417
  - PR #1511
repro: back-end/scripts/prisma-local-push.test.sh
status: mitigated
---

## Problem

On 2026-06-27 at about 01:25Z prod was effectively down: `/health` returned 200, but
**every** `GET /api/agents` returned 500 with
`The column "Agent.fastModeCacheEnabled" does not exist in the current database.`
(component `Agents`, "Failed to fetch agents"). The dashboard was fully broken.

## Diagnosis

The deployed backend (commit `c28e0105`, "feat: add fast mode provider cache") queries
`Agent.fastModeCacheEnabled`. Migration `20260622000000_add_fast_mode_cache` was
recorded in `_prisma_migrations` as **fully applied** (finished 2026-06-23T00:58Z, one
step, not rolled back), and the `FastModeCacheEntry` table from that same migration was
present — but the `ALTER TABLE "Agent" ADD COLUMN "fastModeCacheEnabled"` from that same
migration was gone. So the column had been dropped **after** the migration ran, while
Prisma still believed the migration had succeeded; `migrate deploy` therefore had
nothing to re-apply.

Most likely mechanism: `back-end/.env`'s `DATABASE_URL` points at **prod** Supabase
(`aws-1-us-east-2.pooler.supabase.com:6543`). A `prisma db push` or `migrate dev` run
from another Conductor workspace on an older `schema.prisma` — one without the column —
would silently drop the column from prod to "match" that schema. This is a recurring
footgun: prod DDL is one stray `db push` away, from any worktree.

Distinguishing evidence for the class: green health checks with route-specific 500s means
the DB and the code disagree, not that a dependency is down (unlike the separate LLM
outage of the same month).

## Solution

Restored the column safely and idempotently, reproducing the schema default exactly:

```sql
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "fastModeCacheEnabled" BOOLEAN NOT NULL DEFAULT false;
```

Executed via `cd back-end && source .env && npx tsx -e "...$executeRawUnsafe..."`.
`/api/agents` recovered to 200 immediately and the error cleared from prod logs.

The durable rule: never run `prisma db push` / `migrate dev` with `back-end/.env`
loaded — it writes prod. Use `migrate deploy` only.

## Human feedback

None recorded.

## Reusable lesson

Prod 500s with a green `/health` and a Prisma "column does not exist" mean the DB was
mutated out from under the code — check `_prisma_migrations` says applied, then restore
with `ADD COLUMN IF NOT EXISTS` and stop pointing `db push` at prod.

## Recurrence: CLAUDE.md's own migration recipe pushed to prod (2026-10-07)

While deploying PR #1417, an agent followed CLAUDE.md's Database step 2 literally:
`migrate diff --from-url "$DATABASE_URL"`, then "`npx prisma db push` to apply
locally", from `back-end/` with its `.env` loaded. Both `DATABASE_URL` and
`DIRECT_URL` there point at prod Supabase. The push created the branch's
unmerged `PhoneCallSession` table in prod (0 rows, `relrowsecurity` false) and,
because Prisma cannot model GIN trigram indexes, dropped `Agent_title_trgm_idx`,
`Agent_goal_trgm_idx`, `Message_text_trgm_idx` and
`AgentTrajectorySearch_searchText_trgm_idx`. All 130 migrations stayed recorded
as finished, so `migrate deploy` would never have restored them. The four
indexes back prod's agent, message and trajectory text search.

Reproduced on a scratch local database: after a guarded local push, the five
migration-declared indexes were created from their migration SQL. A second
push printed "Your database is now in sync" without any data-loss prompt and
removed all four trigram indexes. It kept the partial
`PurchaseSpend_legacyFingerprintBackfill_idx`, so that index's separate absence
in prod predates this push; its cause is not recorded. The previous case's
lesson lived only in this file, while the instruction every agent reads still
told it to run the bare push. That contradiction is the owned cause.

Remediation used read-only inspection first, then `CREATE INDEX CONCURRENTLY IF
NOT EXISTS` from each migration's own SQL, including the partial index. The
Supavisor pooler ignored `PGOPTIONS`, so the first pass hit the role's 2-minute
`statement_timeout` on `Message` and `AgentTrajectorySearch` and left INVALID
indexes. The second pass dropped each invalid index and rebuilt it with
`SET statement_timeout = 0` inside the session. `Message_text_trgm_idx` became
valid after 177 seconds. The 8.2 GB `AgentTrajectorySearch` build ran for 1,315
seconds and then failed with `could not write to file "base/pgsql_tmp/...": No
space left on device`, leaving a 1,801 MB INVALID index. Render recorded 30
`cannot execute UPDATE in a read-only transaction` (25006) failures from
04:36:34Z to 04:37:02Z on `agent.update`, `user.updateMany` and
`toolSideEffect.deleteMany`, and none before or after; that 29-second window
ends with the build's failure at 04:37:00Z. So the remediation itself briefly
made prod read-only by exhausting its disk. A fresh session afterwards reported
`default_transaction_read_only` off, and `DROP INDEX CONCURRENTLY` removed the
invalid index (database 51 GB → 49 GB, zero invalid indexes). Which build
phase spilled was not captured: `pg_stat_progress_create_index` was not
sampled. A concurrent build's validation phase sorts the TIDs it finds in the
new index, and a trigram GIN index holds one posting per trigram per row, which
is the likely source. `AgentTrajectorySearch_searchText_trgm_idx` therefore
remains absent until prod has measured disk headroom; a blocking build would
stall the `Message` trigger that maintains the table. With explicit human
approval, the empty stray `PhoneCallSession` table was dropped on 2026-10-07 at
15:21Z (`to_regclass` null afterwards) so the branch's migration can create it
with RLS; the approved decision for the trajectory index is to leave it absent
until disk headroom is measured.

Before building an index concurrently on a large prod table, compare its
expected temporary sort size with free disk, not only the statement timeout.

CLAUDE.md now names the local database explicitly for both the diff and the
push, which goes through `npm run prisma:push:local`. That wrapper refuses any
non-localhost `DATABASE_URL` or `DIRECT_URL`. `back-end/scripts/prisma-local-push.test.sh`,
in `npm run test:structural`, now also fails when CLAUDE.md, AGENTS.md or any
instruction doc under `.claude/` or `docs/` contains an `npx prisma db push`
without both URLs scoped to localhost. It failed on the previous CLAUDE.md and
passes on the corrected one.

## Recurrence: a local URL override bypassed the guarded entry point (2026-10-14)

During PR #1511 integration tests, a direct Prisma schema-push command from an
isolated worktree overrode only `DATABASE_URL`. From `back-end/`, Prisma 5.22
loaded the linked backend `.env` and selected its production `DIRECT_URL`.
The existing local-only wrapper and canonical coverage/setup scripts already
pin both URLs; the direct executable bypassed those guards. This recurrence
therefore exposes an operational bypass of the existing protection, rather
than a demonstrated failure of the guarded wrapper.

There were two failed commands, but only the second is proven to have reached
production. The first ran from the worktree root with an explicit schema path;
its redirected output was overwritten. Its root/schema-directory dotenv
candidates were absent and no `DIRECT_URL` was inherited. A subsequent
configuration-only `prisma validate` under those equivalent lookup conditions
failed with P1012 (`Environment variable not found: DIRECT_URL`), without a
schema push or database connection. This supports a pre-connection failure for
the first command; it does not recover the original stderr.

Independent Supabase logs record the second command's attempted
`Credit_userId_fkey` addition at 2026-10-14 22:56:56.061 UTC and SQLSTATE 23503
at 22:56:56.068. A bounded, untruncated provider query covering
22:56:30–22:57:15 returned five events: that statement/error pair and three
unrelated cache statements before the first command's earliest filesystem
time bound. No successful incident DDL was confirmed. The installed Prisma
engine (`605197351a3c8bdd595af2d2a9bc3025bca48ea2`) submits rendered SQL
statements separately, without one transaction around the complete push, so
failure alone cannot establish that no earlier DDL committed.

All remote schema operations stopped. The subsequent audit verified both
session and transaction read-only protection before querying the catalog.
No canonical application tables or columns were missing, no recently changed
cluster of surviving catalog rows was found, and `/health` and `/health/deep`
returned 200. The currently absent Credit foreign key, orphan Credit rows and
other schema drift cannot be dated to this incident from a local seed or live
catalog. Provider ingestion completeness is not certified, and dropped catalog
rows are not visible. The conclusion remains **no confirmed successful
incident DDL**, with incomplete before/after attribution; it is not proof of
zero impact. No repair, inferred drift cleanup, index rebuild or production
restore was attempted or justified by these findings.

The original output, command receipt and independent log/catalog evidence are
retained under `.context/rca-main-integration/.context/db-push-incident.json`
and `.context/rca-ae17b024/production-db-impact-readonly/`. The archive searches
`Credit_userId_fkey` and `local DATABASE_URL directUrl production` found this
existing failure class; the former had no exact match. No user instruction
requested production schema work. The user was informed of the mistake and
attribution limits while the audit ran.

Testing resumed only through the canonical local coverage runner with a
validated loopback `victoria_<workspace>` target. Its actual runner/backend
children were independently checked to carry matching local `DATABASE_URL`
and `DIRECT_URL`. The existing `prisma-local-push.test.sh` also passed: either
remote URL is rejected and the both-local dry-run is accepted. These checks do
not imply that a bare Prisma executable is guarded. Preserve the receipts,
use the guarded local entry points, and obtain a trustworthy production
before-image before attributing or repairing unrelated catalog drift.
