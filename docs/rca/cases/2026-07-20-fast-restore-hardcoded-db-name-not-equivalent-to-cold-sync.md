---
id: 2026-07-20-fast-restore-hardcoded-db-name-not-equivalent-to-cold-sync
date: 2026-07-20
title: The seed fast-restore branch hardcoded the database name, so an isolated bench run restored into the wrong DB and poisoned the shared cache
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/run.sh seed fast-restore branch — pg_restore/pg_dump target a hardcoded `victoria` instead of $LOCAL_DB_NAME
symptoms:
  - '"✅ DB restored" then backend never healthy'
  - 41/42 boxes wedged in fleet run 20260720-102212-78585
  - app DB victoria_bench_* left with 0 tables after a restore
  - Message trgm/grep index absent after a fast restore
tags:
  - cloudbench
  - pg-restore
  - benchmark-seed
  - db-isolation
  - observability
sources:
  - commit 97f5fd1b6
repro: scripts/tests/cloudbench-restore-readiness.test.sh
status: fixed
---

## Problem

Fleet run `20260720-102212-78585` wedged 41 of 42 boxes: each printed
`✅ DB restored` and then the backend never became healthy. The fast-restore
branch had reported success over a database the backend could not operate on.

## Diagnosis

The seed fast-restore branch in `run.sh` was **not equivalent** to the cold-sync
(`else`) branch, in three separate ways:

1. It restored (`pg_restore -d victoria`) and saved (`pg_dump ... victoria`) a
   HARDCODED database name, while the backend's `DATABASE_URL` uses
   `$LOCAL_DB_NAME` — which `run.sh` sets to `victoria_bench_<run-id>` for an
   isolated benchmark run. When the names diverge, the restore populates the wrong
   DB (app DB left empty) and the saved dump is taken from the wrong DB, poisoning
   the shared R2 cache for every later box. Reproduced locally: an isolated-run
   restore into hardcoded `victoria` leaves the app DB `victoria_bench_*` with 0
   tables; restoring into `$LOCAL_DB_NAME` yields the full 63 tables, seeded users
   and trgm index.
2. It skipped `ensure-agent-network-grep-indexes.ts`, the readiness step the
   cold-sync path always runs, so a dump published by an older box or a partial
   restore leaves the Message trgm/grep index absent.
3. It swallowed `pg_restore` stderr to `/dev/null`. `pg_restore` continues past
   per-object errors and still exits 0 without `-e`, so a partial restore reported
   `✅ DB restored` over an incomplete, backend-unusable DB with no trace.

For THIS run the isolated names happened to match (`BENCHMARK_RUN_ID` unset), and
a local backend is fully healthy against the exact R2 dump — proving the restored
DB is not structurally deficient, and refuting the DB-content hypotheses (a static
`/health` plus non-fatal DB errors mean no DB state can block `app.listen`). The
remaining "backend never reached app.listen" signature is an on-box process/startup
stall whose backend stdout was not captured in the fleet artifacts — an open
observability gap.

## Solution

Make the fast-restore branch equivalent to cold-sync and observable: target
`$LOCAL_DB_NAME` for both restore and dump, re-run
`ensure-agent-network-grep-indexes.ts` idempotently on the restore branch, and keep
`pg_restore` stderr on the stack log. Cemented by
`scripts/tests/cloudbench-restore-readiness.test.sh` (wired into
`scripts/test.sh`), which fails on the pre-fix `run.sh` and passes after. The
recommendation before re-enabling the R2 fast-restore is to capture
`back-end/backend-logs.log` per box.

## Human feedback

None recorded.

## Reusable lesson

A "fast path" that bypasses the slow path must be proven equivalent to it —
identical target names, identical readiness steps, identical error visibility —
or it will silently hand downstream consumers a broken artifact.
