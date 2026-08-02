---
id: 2026-07-25-migration-marked-applied-but-column-dropped-from-prod
date: 2026-07-25
title: A migration marked applied but whose column had been dropped from prod is invisible to `migrate deploy`
surface: back-end
component: prisma-migrations
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: prod _prisma_migrations had 20260723021512_add_agent_world_model_mode marked applied, so migrate deploy skipped it while the column was absent
symptoms:
  - "The column Agent.worldModelMode does not exist in the current database"
  - "prod GET /api/agents 500s while models, people and benchmarks domains stay healthy"
tags:
  - prisma
  - migration
  - schema-drift
  - prod-500
  - db-push
sources:
  - PR #860
  - commit eab7b107
  - memory:project_worldmodelmode_prod_migration_drift
repro: none-recorded
status: fixed
---

## Problem

Deploying the WHM/Simulator work (PR #860, merged 2026-07-25 as `eab7b107`) took
prod `/api/agents` down with a 500:
`The column Agent.worldModelMode does not exist in the current database`. Every
other domain — models, people, benchmarks — stayed healthy; only the Agent domain
500'd, because only it selects that column.

## Diagnosis

The migration
`back-end/prisma/migrations/20260723021512_add_agent_world_model_mode/migration.sql`
(`ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "worldModelMode" TEXT NOT NULL
DEFAULT 'real'`) existed, was committed, and was recorded in prod's
`_prisma_migrations` — a prior session had `migrate resolve --applied` it after
adding the column by hand. The column was subsequently dropped from prod by a
stray `prisma db push` from another workspace (the same class of incident as
`Agent.fastModeCacheEnabled` on 2026-06-27 and the compute-token tables on
2026-07-06). Because the migration is marked applied, `migrate deploy` skips it,
so the column stays absent forever and `prisma.agent.findMany()` 500s. The deeper
cause is that `_prisma_migrations` records intent, not the present state of the
schema, so a marked-applied-but-absent migration is invisible to every static
check.

## Solution

Live remediation: re-apply the idempotent DDL directly to prod —
`cd back-end && npx prisma db execute --url "$DIRECT_URL" --file
prisma/migrations/20260723021512_.../migration.sql` — after which `/api/agents`
returned 200 and the endpoint smoke passed 13/13. The durable defense is the
`/deploy` Step 13a functional probe (`GET /api/agents` +
`prod-endpoint-smoke.ts`), which is what caught this; the static
`migration-drift.test.ts` cannot see prod-DB drift by construction. The other half
of the defense is procedural: other workspaces must never `prisma db push` against
the prod database.

## Human feedback

None recorded.

## Reusable lesson

Writing idempotent DDL (`ADD COLUMN IF NOT EXISTS`) and keeping a post-deploy
functional probe is the only defense against a marked-applied migration whose
column is gone — `migrate deploy` will never re-run it.
