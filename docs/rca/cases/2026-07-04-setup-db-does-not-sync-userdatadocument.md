---
id: 2026-07-04-setup-db-does-not-sync-userdatadocument
date: 2026-07-04
title: A prod-corpus benchmark pre-check failed on a local stack because setup-db.sh never syncs UserDataDocument
surface: harness
component: benchmark-runner
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/setup-db.sh — does not sync UserDataDocument (nor UserDataProviderSyncState/UserSnapshot), so a local DB has 0 documents"
symptoms:
  - 'user-data-prod-grep pre-check reports "got 0" for every provider'
  - benchmark fails pre-flight without ever spawning an agent
tags:
  - benchmarks
  - user-data
  - setup-db
  - local-fixture
  - prod-only-task
sources:
  - memory:project_user_data_export_bench_blockers
repro: none-recorded
status: mitigated
---

## Problem

`user-data-prod-grep` failed on a local isolated stack before spawning an agent: its
pre-check queries `UserDataDocument`, but `scripts/setup-db.sh` does not sync that
table, so the local DB holds 0 documents and the pre-flight reports `got 0` for every
provider.

## Diagnosis

The task is a `--prod` task by design — it validates the REAL synced corpus — but
nothing prevented it from being run against a local stack whose fixture cannot contain
that corpus. The failure is a fixture/environment mismatch, not a defect in grep: the
local setup path simply omits `UserDataDocument`,
`UserDataProviderSyncState`, and `UserSnapshot`.

## Solution

Operationally: run this task against the prod backend, not a local isolated stack. The
recorded durable option is to make `setup-db.sh` sync
`UserDataDocument`/`UserDataProviderSyncState`/`UserSnapshot` so a local stack can host
the pre-check at all. Run user-data benches through the unified eval system
(`benchmarks/run_eval_suite.py`, catalog `tasks.json`) — locally via
`python benchmarks/local.py --eval-suite --only <names>`, not the legacy
`run_benchmark.py --task` path.

## Human feedback

None recorded.

## Reusable lesson

When a benchmark pre-check reports zero rows for every provider, check whether the local
DB fixture even syncs that table — a `--prod` task must either run against prod or have
its tables added to the local sync.
