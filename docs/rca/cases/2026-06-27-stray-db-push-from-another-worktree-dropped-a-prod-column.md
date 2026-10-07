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
  - "a table from an unmerged branch exists in prod without RLS before its migration was deployed"
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
repro: back-end/scripts/prisma-local-push.test.sh
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
`SET statement_timeout = 0` inside the session. The stray `PhoneCallSession`
table must be dropped before the branch's migration can deploy; that prod DDL
waits for explicit human approval.

CLAUDE.md now names the local database explicitly for both the diff and the
push, which goes through `npm run prisma:push:local`. That wrapper refuses any
non-localhost `DATABASE_URL` or `DIRECT_URL`. `back-end/scripts/prisma-local-push.test.sh`,
in `npm run test:structural`, now also fails when CLAUDE.md, AGENTS.md or any
instruction doc under `.claude/` or `docs/` contains an `npx prisma db push`
without both URLs scoped to localhost. It failed on the previous CLAUDE.md and
passes on the corrected one.
