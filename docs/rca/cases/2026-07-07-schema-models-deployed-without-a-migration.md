---
id: 2026-07-07-schema-models-deployed-without-a-migration
date: 2026-07-07
title: Compute-token tables existed in schema.prisma and shipped code but had no migration, so prod 500s while local passes
surface: back-end
component: prisma-migrations
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/prisma/migrations — ComputeTokenLineageLease/ComputeTokenFastCacheAffinity had no migration directory, so `migrate deploy` never created them
symptoms:
  - compute-token endpoint returns 500 in production but works locally
  - every agent falls through to the paid provider waterfall
  - Prisma reports a missing table only on Render, never on a local run
tags:
  - prisma
  - migration
  - schema-drift
  - prod-500
  - compute-token
  - db-push
sources:
  - PR #714
repro: back-end/src/tests/structural/migration-drift.test.ts
status: fixed
---

## Problem

`ComputeTokenLineageLease` and `ComputeTokenFastCacheAffinity` were present in
`schema.prisma` and referenced by deployed backend code, but no migration ever
created them in production. The compute-token endpoint therefore 500'd in prod,
and because that endpoint is what hands agents their direct-auth token, **every**
agent silently fell through to the paid provider waterfall. Locally everything
passed, so no gate caught it before deploy.

## Diagnosis

Two layers. The proximate cause: local dev and setup scripts apply the schema with
`prisma db push`, which conjures tables straight from `schema.prisma` and therefore
hides a missing migration entirely — local tests pass on a DB that prod can never
reach, since Render runs `prisma migrate deploy`, which only applies committed
`<timestamp>_<name>/migration.sql` directories.

The deeper owned cause: the migration history itself was broken. 58 tangled
migrations with scrambled timestamps meant the history could never rebuild prod
from scratch, so nobody could tell whether a migration was missing — the safety
net that should have flagged the drift was already unusable.

## Solution

Squashed the 58 migrations into a single prod-faithful baseline
(`00000000000000_init`, generated from a `pg_dump` of prod via
`back-end/scripts/clean-baseline-dump.py`) that reproduces prod exactly: 60 tables
including `_prisma_migrations`, 51 RLS tables, 56 policies, 3 triggers, and the
pg_trgm trigram index. A fresh `prisma migrate deploy` on PG17 was verified to
reproduce prod and to be idempotent; prod was reconciled with
`migrate resolve --applied`.

Two guards cement it: `migration-drift.test.ts` now fails the build when a
`schema.prisma` model or column has no migration (the exact defect that shipped
this), and `prod-endpoint-smoke.ts` probes one DB-backed endpoint per domain after
deploy so a missing table surfaces as a red gate rather than as a silent cost
regression.

## Human feedback

None recorded.

## Reusable lesson

When something 500s in prod but passes locally, first ask whether the local DB was
built by `db push` rather than `migrate deploy` — a schema edit with no migration
directory is invisible everywhere except production.
