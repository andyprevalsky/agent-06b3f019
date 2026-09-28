---
id: 2026-09-28-system-postgres-workflow-ddl-probed-dead-docker
date: 2026-09-28
title: System Postgres startup waited on a dead Docker daemon while applying workflow DDL
surface: harness
component: local-workflow-ddl
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/apply-local-workflow-ddl.sh database transport selection
symptoms:
  - "docker inspect victoria-db-edmonton --format {{.State.Running}}"
  - "local deploy stack never reached backend health after credential sync"
tags:
  - system-postgres
  - docker
  - deploy
sources:
  - commit 626423775a
  - PR #1312
repro: scripts/tests/workflow-deployment-migration.test.sh
status: fixed
---

## Problem

During the Foundry deploy gate, Docker Desktop's engine was unavailable, so
`run.sh` used its supported `ROSE_USE_SYSTEM_PG=true` path. Production browser
credentials synchronized into local Postgres, but the backend never started.
The child process was `docker inspect victoria-db-edmonton` inside
`apply-local-workflow-ddl.sh` for over a minute.

## Diagnosis

Archive searches for `docker inspect system postgres workflow ddl` and
`run.sh stuck after credential sync docker daemon unavailable` found related
Docker fallback cases, but none at this DDL boundary. The data path was
`ROSE_USE_SYSTEM_PG=true` → `run.sh` exports a DB container name for workspace
identity → DDL script treats that name as evidence of a usable Docker database
→ Docker socket hangs. The named container was only a configuration value;
system Postgres was the selected database.

An isolated reproduction ran the original script with a Docker shim that
reported a running container and a host `psql` shim. Despite
`ROSE_USE_SYSTEM_PG=true`, it invoked Docker and never called host `psql`.
After the fix, the same fake transport setup in
`workflow-deployment-migration.test.sh` asserts Docker was not invoked and
host `psql` received the workflow function and trigger DDL. The unchanged
structural test passes. The local command is
`bash scripts/tests/workflow-deployment-migration.test.sh`: before the fix the
shim left `docker-invoked` and no `psql-invoked`; after the fix it prints
`PASS: system Postgres DDL applies through host psql without Docker`.

The deeper transport was checked in `scripts/setup-db.sh`, `scripts/run.sh`,
and `scripts/cloud-init.sh`: each selects its database before invoking this
shared DDL script. The false Docker probe is at this script's transport branch,
not in the SQL or a missing migration. The fix covers all three callers when
they supply `ROSE_USE_SYSTEM_PG=true`; Docker-backed callers still use Docker.

## Solution

Skip the Docker inspection when system Postgres is selected, and apply the
idempotent DDL through the supplied database URL with host `psql`. No DB
container or volume is deleted. The local stack is restarted from a clean
process tree before semantic tests.

## Human feedback

None recorded.

## Reusable lesson

Select database transport from the explicit mode even when a container name
remains in the environment for workspace identity.
