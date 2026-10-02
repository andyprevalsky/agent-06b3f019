---
id: 2026-10-01-test-launchers-rewrote-prisma-client-under-parallel-lint
date: 2026-10-01
title: Test launchers rewrote the Prisma client on every start, so a parallel lint saw every Prisma result as any
surface: harness
component: backend-test-launchers
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/scripts/run-coverage.sh and run-blackbox-tests.sh ran `npx prisma generate` unconditionally before every test run
symptoms:
  - Unexpected any value in conditional
  - strict-boolean-expressions errors in files nobody changed
  - deploy stage eslint exit=123
tags:
  - prisma
  - deploy-gates
  - concurrency
sources:
  - PR #1364
repro: back-end/src/tests/unit/sync-prisma-client.test.ts
status: fixed
---

## Problem

During `/deploy` Group 3, the ESLint verifier failed with 19 `@typescript-eslint/strict-boolean-expressions` errors ("Unexpected any value in conditional"). The errors were in reverse importers such as `agentMessageService.ts` (185:10, 190:10), `agentControlService.ts`, and `repo.ts`, none of which the branch had changed. TypeScript, which ran next, passed.

## Diagnosis

The ESLint stage started at 22:10:51Z. The backend coverage lane, started in parallel, rewrote `node_modules/.prisma/client/index.d.ts` at 22:10:53.8Z while ESLint was building its type program. `run-coverage.sh` and `run-blackbox-tests.sh` both ran `npx prisma generate` on every start, even when the client already matched the schema. While the declarations were mid-rewrite, every Prisma call resolved to `any`.

The mechanism reproduces deterministically: truncating `index.d.ts` and running `node scripts/lint-affected.mjs src/domains/agents/agentMessageService.ts` gives exactly the two deploy errors (185:10, 190:10). Restoring the file makes them go away.

Two concurrent launchers on a stale client also regenerated over each other. Without the lock, the new unit test counts 8 generations where 6 are expected.

Prisma reformats the schema copy it embeds, so a byte comparison against `prisma/schema.prisma` cannot detect freshness.

## Solution

`back-end/scripts/sync-prisma-client.sh` regenerates only when the client is stale. "Fresh" means:

- the generated `index.js` was built by the installed `@prisma/client` version (`clientVersion`), and
- a marker ties its embedded `inlineSchemaHash` to the SHA-256 of the source schema.

A manual `prisma generate` of the same schema keeps the embedded hash, so it does not force another regeneration. Regeneration is serialized with the shared `scripts/lib/workspace-db-lock.sh` lock and re-checks freshness after acquiring it. Both launchers call the helper, and `coverage-script.test.ts` asserts that neither launcher still calls `npx prisma generate`.

Tests: `sync-prisma-client.test.ts` drives the helper against a sandbox with a fake `npx`. It covers a missing client, an unchanged schema, a schema edit, a manual same-schema generate, a foreign embedded hash, a client-version change, and three concurrent launchers on a stale client (exactly one generation). After the fix, five concurrent helper runs left the real client untouched while the full deploy lint list passed.

At 10k agents this is test tooling only, with no runtime cost.

## Human feedback

None recorded.

## Reusable lesson

A step that rewrites shared generated code must be a no-op when the output is already current. Otherwise every parallel reader can see it half-written.
