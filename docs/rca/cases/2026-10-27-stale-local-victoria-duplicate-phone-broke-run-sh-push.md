---
id: 2026-10-27-stale-local-victoria-duplicate-phone-broke-run-sh-push
date: 2026-10-27
title: Fresh devboxes inherited a pre-merge duplicate phone in local victoria, so run.sh's schema push failed on the unique User.phone index
surface: infra
component: local-stack-schema-sync
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run.sh schema sync — ran prisma db push without the localhost User.phone normalizer that prisma-local-push and the blackbox runners already run first
symptoms:
  - "Unique constraint failed on the fields: (`phone`)"
  - run.sh stops at "Syncing Prisma schema..."
  - "Error: P2002"
tags:
  - local-dev
  - seed
  - prisma
  - devbox
  - scale-100-seats
sources:
  - commit 3a40d3448 (made User.phone unique, 2026-10-18)
  - memory:local-victoria-duplicate-phone-blocks-run-sh
  - task S17 of the 100-seat readiness audit
repro: back-end/scripts/prisma-local-push.test.sh
status: fixed
---

## Problem

Every new devbox's `scripts/run.sh --benchmark` died at "Syncing Prisma
schema..." with `Unique constraint failed on the fields: (phone)`. Agents
worked around it by nulling account c49b4ce3's phone by hand (S4, S11).

## Diagnosis

- The canonical seed dump is clean. Restored, it has one row for
  +19729777432 and already contains `User_phone_key`.
- Prod no longer holds the duplicate: c49b4ce3 exists with a NULL phone.
- The duplicate comes from the box's persisted `victoria`.
  - An earlier `seed-local.ts` run (`syncWaitlistAccounts`) copied prod Users
    by phone while c49b4ce3 still held Andy's phone (row `createdAt`
    2026-10-08).
  - The phone became unique on 2026-10-18, and the local DB never dropped the
    stale row.
  - `cloud-init.sh` skips reseeding when the dev user exists, so new boxes
    inherit that DB.
- `normalize-local-user-phones.sh` already fixes exactly this. It is
  localhost-only and idempotent, and gives a duplicated phone to the oldest
  account, matching prod.
- `prisma-local-push.sh` and the blackbox/coverage runners already call it.
  `run.sh` and `setup-db.sh` pushed without it.

Repro on a fresh DB restored from the canonical dump, with the stale state
recreated (unique index dropped, c49b4ce3 inserted with Andy's phone):

- `prisma db push` gives P2002.
- Normalizer, then push: "in sync". 1f85ff25 keeps the phone and the index is
  recreated.

## Solution

`run.sh` and `setup-db.sh` run the normalizer immediately before their schema
push. `back-end/scripts/prisma-local-push.test.sh` (in `npm run
test:structural`) now fails if any non-comment `npx prisma db push` in either
script lacks a normalizer call in the preceding lines. It failed on main's
`run.sh` and passes after. The canonical fixture is already clean and was not
republished.

Scale: local tooling only, so no production effect.

## Human feedback

The parent (S17) asked for a durable fix to the canonical seed path or to
seed-local normalization, proven on a fresh local DB.

## Reusable lesson

When a normalization step exists for a schema constraint, assert that every
path that pushes the schema runs it. One unguarded path keeps the old failure
alive for every new environment that inherits stale data.
