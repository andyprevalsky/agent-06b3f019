---
id: 2026-09-29-gate-fixture-stale-integration-unique-selector
date: 2026-09-29
title: Gate webhook fixture used a removed Prisma Integration unique selector
surface: back-end
component: gate-benchmark-fixture
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/gate-benchmark-fixture.ts seedOrgManagedAgentCardForUser
symptoms:
  - 'Unknown argument `userId_name`. Available options are marked with ?.'
  - 'gate-subscription-webhook-resume failed before root allocation; runtime evidence HTTP 409 and guest cleanup HTTP 500'
tags:
  - benchmark
  - cloud-fleet
  - prisma
  - fixture
sources:
  - PR #1299
  - commit ac4bfad56c4afe9e1d62ab44d3fbf4517b75506f
  - fleet run 20260930-013605-24832
repro: back-end/src/tests/blackbox/gate-fixture.blackbox.ts
status: open
---

## Problem

The third attempted ten-task Cloud slice on `ac4bfad56` was invalid. Nine tasks
reached normal evaluator outcomes and sealed runtime evidence. The
`gate-subscription-webhook-resume` guest reached a healthy stack, then its
supplemental fixture raised Prisma's `Unknown argument userId_name` from
`gate-benchmark-fixture.ts:77`. It allocated no benchmark root, so the driver
could not supply a normal run/evaluator result. The exact-owner controller
retained the stopped pool and classified the whole slice INFRA with zero proof
credit. The original bytes of the unsealed guest were captured from its exact
stopped volume before owner recovery.

## Diagnosis

Path: Cloud guest stack health → gate base fixture apply → webhook supplement →
`seedOrgManagedAgentCardForUser` → Prisma `Integration.upsert` validation →
benchmark root allocation → sealed runtime evidence. The healthy stack and
successful `gate-source-connect-gmail` sibling place the first wrong value in
the supplemental AgentCard seeding query. `Integration` now has compound unique
`[userId, name, accountId]` in `schema.prisma`; this helper still supplied the
removed `userId_name` selector. The unrelated `setup-benchmark-payment.ts`
already uses `userId_name_accountId`. Importing the helper also executed the
gate fixture CLI's unguarded `main()`, adding an unrelated asynchronous cleanup
and seed to the same user during the supplement.

Archive searches: `Unknown argument userId_name gate-subscription-webhook
fixture Prisma integration upsert` and `fixture import executes main side
effect benchmark root allocation cleanup acknowledgement`. Prior Prisma schema
and cleanup cases were relatives, not the same first-bad boundary.

Local isolated PostgreSQL reproduction (both `DATABASE_URL` and `DIRECT_URL`
set to the same disposable localhost database):

```text
node --import tsx src/tests/blackbox/gate-fixture.blackbox.ts
before: exit 1, PrismaClientValidationError: Unknown argument `userId_name`
after:  exit 0, PASS gate fixture AgentCard upsert, idempotency, and import safety
```

The test calls the actual exported seeding function against a real Prisma
client and database, re-seeds the same user, checks the persisted account and
cardholder, and rejects import-time CLI side effects. The assertion and task
definition were unchanged between red and green. The repository's blackbox
runner discovered it as `gate-fixture` and passed it. Canonical exact-task
benchmark validation and renewed Cloud fleet proof remain pending, so this
case stays open.

## Solution

Select the default AgentCard account with the current
`userId_name_accountId` unique key, including `accountId: ''` on create. Let
the webhook supplement pass its already-owned Prisma client to the helper,
and run the gate fixture CLI only when that file is invoked directly. This
keeps the database operation idempotent and prevents future imports from
silently applying unrelated fixture state. It changes no benchmark prompt,
task, evaluator, or runtime trajectory. The same fixed query applies to every
gate fixture user without per-agent work.

## Human feedback

The user requires infrastructure-only fixes, unchanged benchmark semantics,
at least three successful LLM calls per task, exact teardown, and ten
consecutive valid sequential ten-task slices. A task that fails to allocate a
root or cannot seal runtime evidence is INFRA even if other tasks evaluate.

## Reusable lesson

Run fixture helpers through the generated Prisma client in the permanent
blackbox suite, and keep imported CLI modules free of execution side effects.
