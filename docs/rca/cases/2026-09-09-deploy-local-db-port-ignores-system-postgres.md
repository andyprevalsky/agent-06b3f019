---
id: 2026-09-09-deploy-local-db-port-ignores-system-postgres
date: 2026-09-09
title: Deploy LOCAL_DB_PORT advertised conductor+5 while system Postgres listens on 5432
surface: harness
component: scripts/lib/deploy-local-env.sh
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/lib/deploy-local-env.sh::configure_deploy_local_env — LOCAL_DB_PORT always conductor+5
symptoms:
  - "Can't reach database server at localhost:3006"
  - "browser-take-control › user can take and hand back control"
  - "ROSE_USE_SYSTEM_PG=true"
  - "LOCAL_DB_PORT=3006"
tags:
  - deploy
  - system-postgres
  - local-db-port
  - semantic-gate
  - take-control
sources:
  - PR #1301
repro: scripts/tests/workspace-env.test.sh
status: fixed
---

## Problem

Cloud `/deploy` Step 5 uses system Postgres (`ROSE_USE_SYSTEM_PG=true`,
`localhost:5432`, db `victoria`). `configure_deploy_local_env` still
advertised `LOCAL_DB_PORT=CONDUCTOR_PORT+5` (3006 when the stack is on
3001). Semantic take-control seed failed with
`Can't reach database server at localhost:3006` while the backend already
read `victoria` on 5432.

Archive searches: `Can't reach database server at localhost:3006`,
`LOCAL_DB_PORT system Postgres`. Relative of
`2026-07-19-duplicate-conductor-port-assignment-collides-workspace-db-ports`
(same port helper, different mismatch: Docker collision vs system-PG
ignore). Not a recurrence.

## Diagnosis

1. Runtime: take-control seed used `LOCAL_DB_PORT` from
   `.context/deploy-local.env` and connected to 3006. Nothing listened.
2. `run.sh` + backend already honored `ROSE_USE_SYSTEM_PG` and used 5432.
3. The helper is the first-bad boundary: it derived the Docker published
   port even when Docker is unavailable.
4. Repro: with `ROSE_USE_SYSTEM_PG=true`, pre-fix `LOCAL_DB_PORT` is
   conductor+5; post-fix it is 5432. Take-control seed failed at 3006 and
   passed (6.9s) at 5432.

## Solution

When `ROSE_USE_SYSTEM_PG=true`, set `LOCAL_DB_PORT=5432`. Docker stacks
keep conductor+5. Cemented in `scripts/tests/workspace-env.test.sh` and
`scripts/tests/semantic-deploy-gate.test.sh`. 10k-agent behavior: one
env lookup per deploy stack, no per-agent cost.

## Human feedback

None recorded.

## Reusable lesson

When a helper advertises a derived Docker port, also branch on
`ROSE_USE_SYSTEM_PG` — Cloud stacks listen on 5432, not conductor+5.
