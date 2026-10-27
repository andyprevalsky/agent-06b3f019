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
  - 'prod migration-declared GIN trigram indexes ("Agent_title_trgm_idx", "Message_text_trgm_idx") missing while _prisma_migrations records them applied'
  - 'statement: DROP INDEX "Agent_goal_trgm_idx" followed by insert or update on table "Credit" violates foreign key constraint "Credit_userId_fkey"'
  - "prisma migrate diff emits DROP INDEX for trigram indexes unrelated to the migration being authored"
  - "relrowsecurity false on User, RoseApiKey, PlaidItem; anon PostgREST count on User returned */9526"
tags:
  - prisma
  - db-push
  - prod-500
  - schema-drift
  - supabase
  - trigram-index
  - rls
  - schema-object-drift
sources:
  - memory:project_prod_agents_500_fastmodecache_jun2026
  - PR #1417
  - PR #1511
  - memory:scalability-audit-100-seats-20261024
repro: back-end/src/tests/structural/migration-schema-objects.test.ts
status: fixed
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

Declare every index Prisma can introspect in `schema.prisma` (GIN trigram
included) and verify migration-declared objects against the live catalog
after each deploy; `_prisma_migrations` saying "applied" proves nothing about
what still exists.

Earlier lesson:

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

## Recurrence: the restored indexes were dropped again the next night (2026-10-08)

Found by the 2026-10-24 100-seat audit: `Agent_title_trgm_idx`,
`Agent_goal_trgm_idx`, `Message_text_trgm_idx` and
`AgentTrajectorySearch_searchText_trgm_idx` were absent from prod while
`_prisma_migrations` recorded them applied. Prod logs DDL (`log_statement=ddl`).
Supabase `postgres_logs` show the 2026-10-07 04:07–04:43Z manual restore, then at
**2026-10-08 03:30:02.675Z** a new pooled session issued uncommented
`DROP INDEX "Agent_goal_trgm_idx"`, `"Agent_title_trgm_idx"`,
`"Message_text_trgm_idx"`, then
`ALTER TABLE "Credit" ADD CONSTRAINT "Credit_userId_fkey"`, which failed with
23503. That is a `prisma db push` against prod: Prisma's DropIndex steps run
before AddForeignKey, each statement commits separately, and the FK step then
fails on orphan Credit rows. The same FK failure appears on 2026-10-01 16:53Z
and 2026-10-14 22:56Z. The push came 26 minutes after PR #1417 merged, and the
session arrived through Supavisor, so the client cannot be attributed further.

**Why the 2026-10-07 guard did not hold:** it fixed the instructions (CLAUDE.md
and the guarded `prisma:push:local` wrapper), but a bare `npx prisma db push`
from `back-end/` still selects the production `DIRECT_URL` from `back-end/.env`.
An agent working from an older context, or a direct executable, reaches prod.
The owned cause underneath is in the schema. Prisma introspects plain-column
indexes of every access method, including GIN with `gin_trgm_ops`. Because
`schema.prisma` did not declare these four, every `db push` treated them as
surplus and dropped them. Every `migrate diff` also emitted
`DROP INDEX` for them; `20261020235500_browser_template_keep_best` records an
author hand-stripping that drop. Expression and partial indexes
(`Person_grep_contact_trgm_idx`, `Message_jev_*`, `PurchaseSpend_legacy…`)
survived, because Prisma ignores them. That confirms the boundary.

**Repro (local Postgres, ran):** scratch DB → guarded db push of the current
schema → create the indexes from their migration SQL → `prisma migrate diff
--from-url … --to-schema-datamodel` → guarded `db push` again
(`/tmp/s3/repro.sh <worktree>`). On origin/main `b3679ea7b`: migrate diff
printed 4 `DROP INDEX` lines and the second push removed all of them
(`FAIL: schema sync drops migration-declared trigram indexes`). With the fix,
the three declared indexes survive and are not in the diff
(`PASS`). Permanent regression:
`back-end/src/tests/structural/migration-schema-objects.test.ts` (in
`npm run test:structural`, which /deploy runs). It fails on origin/main
listing the four indexes and passes on the fix (5/5 consecutive runs).

**Wider drift found by the new verifier** (`back-end/scripts/verify-schema-objects.ts`):
it replays applied migrations and compares indexes, triggers, functions,
policies, extensions and RLS flags against the live catalog. Prod also had RLS disabled on 20 baseline tables
(User, RoseApiKey, PlaidItem, SteelSessionAuth, Subscription, ToolUsage, …),
19 baseline policies missing, and 21 later tables never RLS-enabled. `anon` and
`authenticated` hold SELECT on every public table and the Data API exposes
`public`: an anon count probe on `User` returned `*/9526`. No `DISABLE ROW LEVEL
SECURITY` or `DROP POLICY` appears in retained logs (2026-10-01 onward), so when
RLS was lost between the 2026-07-07 baseline and October is an **open
observability gap**. The parent thread contained it with approval on
2026-10-26 17:30Z (ENABLE RLS on all 41 tables).

**Solution (this recurrence):**
- `schema.prisma` declares the three restored trigram indexes
  (`@@index([col(ops: raw("gin_trgm_ops"))], map: …, type: Gin)`) and
  `extensions = [vector, pg_trgm]`, so neither `db push` nor `migrate diff` can
  drop them. The new structural test immediately caught a fifth one when this
  branch synced main: S7's `MessageRecord_message_trgm_idx` (PR #1581) shipped
  undeclared, so it is declared here too.
- `20261027020002` drops only INVALID leftovers of those index names, since
  `IF NOT EXISTS` would otherwise skip a failed earlier build.
  `20261027020003..5` then rebuild them `CONCURRENTLY IF NOT EXISTS`.
  The session first runs `20261027020001`, a lone
  `SET statement_timeout = 0`: `migrate deploy` applies pending migrations on
  one session (verified locally with a 1 ms database default), and the pooled
  session's 120 s limit is shorter than the 177 s Message build.
- `20261027020006` drops `AgentTrajectorySearch_searchText_trgm_idx`
  `CONCURRENTLY IF EXISTS`, recording the approved absence. Measured: 2.0M
  rows × ~494 trigrams ≈ 1e9 postings, so the concurrent validation sort alone
  would need roughly 16 GB+ of temporary space against 27 GB free on the 90 GB
  disk, and a blocking build would stall the Message trigger. Revisit after
  lane S4 shrinks the table.
- `20261027020000` re-enables RLS on all 41 tables and recreates the 19 baseline
  policies verbatim. It is idempotent after the manual containment
  (`DROP POLICY IF EXISTS` / `CREATE POLICY`, `SET LOCAL lock_timeout`).
- `scripts/prod-endpoint-smoke.ts` (/deploy Step 13a) now runs the read-only
  verifier. It also fails on INVALID indexes and on any public table that anon or
  authenticated can read without RLS, so future drift fails the next deploy
  loudly.

Scale (10k agents): no hot-path change. The three GIN indexes add per-insert
maintenance on Agent and Message (as originally designed). Every user's search
query becomes an index scan instead of a scan of their rows. The verifier is
one bounded catalog read per deploy.

Remaining path: a bare `npx prisma db push` from `back-end/` still targets prod
via `.env` `DIRECT_URL`. It can no longer drop these indexes, but it can still
attempt other DDL. Closing it requires moving the prod direct URL out of the
default `.env` variable, which is an env change needing approval.
