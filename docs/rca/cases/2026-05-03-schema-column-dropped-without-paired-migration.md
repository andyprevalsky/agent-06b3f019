---
id: 2026-05-03-schema-column-dropped-without-paired-migration
date: 2026-05-03
title: A column deleted from schema.prisma with no paired migration stayed NOT NULL in prod and 500'd every agent create
surface: back-end
component: prisma-migrations
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/prisma/schema.prisma — Verifier.llmJudgePrompt was removed from the model while the prod column remained NOT NULL with no default
symptoms:
  - "POST /api/agents -> 500 (88ms)"
  - "prisma.verifier.create() — Null constraint violation on the fields: (`llmJudgePrompt`)"
  - passes locally, 500s on Render for every agent creation
tags:
  - prisma
  - migration
  - schema-drift
  - prod-500
  - db-push
sources:
  - PR #560
repro: back-end/src/tests/structural/migration-drift.test.ts
status: fixed
---

## Problem

Every `POST /api/agents` in production returned 500. Render logs captured the
exact failure:

```
2026-05-03T01:44:26 | POST /api/agents -> 500 (88ms)
  prisma.verifier.create() — Null constraint violation on the fields: (`llmJudgePrompt`)
```

Agent creation was fully broken in prod while local development and the entire
test suite were green.

## Diagnosis

PR #558 removed `Verifier.llmJudgePrompt` from `schema.prisma` (and orphaned a
`SharedMemory` table) without shipping a migration. Local dev runs
`prisma db push --accept-data-loss` (via `scripts/run.sh` and
`scripts/setup-db.sh`), which silently rewrites the local database to match the
schema, so locally the column disappeared. Prod runs `prisma migrate deploy`,
which applies only committed migration directories — so the prod column survived,
still `NOT NULL` with no default, while the generated client no longer supplied
a value. Every insert therefore violated the null constraint. The deepest owned
cause is that nothing in CI asserted that the migration history reproduces
`schema.prisma`, so the schema/migration split was structurally invisible; the
same latent gap also hid `Agent.reasoningEffort` and its enum, removed from prod
by hand long before.

## Solution

Migration `20260503010000` drops `llmJudgePrompt`, the orphan `SharedMemory`
table, and `Agent.reasoningEffort` plus its enum, all with `IF EXISTS` so the
statements are idempotent. The generalizable fix is the new structural test
`back-end/src/tests/structural/migration-drift.test.ts`, wired into
`npm run test:structural`: it parses every `migration.sql` and `schema.prisma`
and fails on textual drift in either direction, with no shadow DB required (so it
survives the repo's broken pre-init migrations). Removing the new migration makes
it print the exact columns that would re-trigger the prod 500, proving it is a
real repro rather than a tautology.

## Human feedback

None recorded.

## Reusable lesson

A schema edit that passes locally proves nothing about prod — `db push` rewrites
the local DB while `migrate deploy` only applies committed migrations, so require
a drift check that compares the migration history against `schema.prisma`.
