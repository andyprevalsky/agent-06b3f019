---
id: 2026-07-27-unserialized-concurrent-destructive-db-rebuild
date: 2026-07-27
title: Two concurrent setup-db.sh invocations raced one database, dropping the schema mid-seed
surface: infra
component: setup-db
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/setup-db.sh — DROP SCHEMA public CASCADE + prisma db push with no cross-process lock on the target container
symptoms:
  - 'ERROR: relation "public.LocalStorageOrigin" does not exist'
  - 'ERROR: relation "public.IndexedDBOrigin" does not exist'
  - "ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification"
  - 'ERROR: insert or update on table "PasskeyCredential" violates foreign key constraint "PasskeyCredential_userId_fkey"'
tags:
  - postgres
  - race-condition
  - locking
  - workspace-setup
  - prisma
sources:
  - commit 342669e27
repro: scripts/tests/setup-db-concurrency.test.sh
status: fixed
---

## Problem

A fresh Conductor workspace runs `bash scripts/setup-db.sh` as the tail of its
`setup` hook while the first `/sync` in that workspace runs the same script. Both
target ONE database. Observed 2026-07-27 22:52:17-22:52:20 UTC in the workspace
Postgres log, mid-seed:

```
ERROR: relation "public.LocalStorageOrigin" does not exist
ERROR: relation "public.IndexedDBOrigin" does not exist
ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification
ERROR: insert or update on table "PasskeyCredential" violates foreign key constraint "PasskeyCredential_userId_fkey"
```

The seed aborted and the workspace had no trustworthy local database, blocking the
`/sync` checkpoint of a `/descend` run.

## Diagnosis

Nothing serialized the two invocations, so the second one's
`DROP SCHEMA public CASCADE` + `prisma db push` ran straight through the first
invocation's in-flight prod seed. The errors are the seed observing tables
disappear and constraints be recreated underneath it. The deeper cause is that a
destructive, idempotent-looking bootstrap script was assumed to be single-writer
when two different lifecycle hooks (workspace `setup` and `/sync`) can both invoke
it at overlapping times.

## Solution

`scripts/lib/workspace-db-lock.sh` takes an exclusive per-DB-container lock
(`shlock` where available, atomic `noclobber` fallback) with a 30-minute budget, so
the loser **waits** for a live peer instead of aborting, and breaks a dead holder's
lock immediately. `setup-db.sh` acquires the lock before touching the container and
releases it on exit.

Repro: `scripts/tests/setup-db-concurrency.test.sh` drives the shipped script with
stubbed docker/npx, releases the second invocation only once the first is provably
inside its seed, and fails if either one's reset/push lands in the other's seed
window — pre-fix exit 1 ("invocation B ran a destructive RESET inside A's seed
window"), post-fix exit 0. Real confirmation: two concurrent unstubbed runs — the
first completed the full prod sync (RC=0, 0 errors, past the exact LocalStorage /
IndexedDB / BrowserPermission / PasskeyCredential steps that previously died), the
second printed "waiting for the victoria-db-tel-aviv database lock" and ran cleanly
afterward. Cemented as deploy structural gate `setup-db-concurrency`.

## Human feedback

None recorded.

## Reusable lesson

Any script that destructively rebuilds a shared resource needs a cross-process
lock that makes the loser wait, because two independent lifecycle hooks can invoke
the same bootstrap concurrently.
