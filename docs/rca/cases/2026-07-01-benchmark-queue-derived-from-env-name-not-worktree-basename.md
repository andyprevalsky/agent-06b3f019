---
id: 2026-07-01-benchmark-queue-derived-from-env-name-not-worktree-basename
date: 2026-07-01
title: `run_benchmark.py` derived the expected Temporal queue from `CONDUCTOR_WORKSPACE_NAME` while `run.sh` built the stack from the git dir basename
surface: harness
component: benchmark-runner
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: run_benchmark.py recomputes the expected queue from CONDUCTOR_WORKSPACE_NAME; run.sh names queue/DB from the git worktree dir basename
symptoms:
  - "benchmark worker-alignment check rejects the run: queue X but benchmark expects Y"
  - "run.sh logs: Warning: CONDUCTOR_WORKSPACE_NAME=X does not match workspace path .../Y; using Y for local resources"
  - data-real-user and send-sms tasks fail against a partially-seeded victoria-db-<envname>
tags:
  - benchmark-runner
  - temporal-queue
  - conductor-workspace
  - deploy-gate
  - env-mismatch
sources:
  - memory:project_deploy_gotchas_local_stack
  - memory:project_milan_workspace_setup
repro: none-recorded
status: mitigated
---

## Problem

On the agentcard-integration deploy (2026-07-01, `guangzhou` worktree) benchmarks
refused to run: the worker-alignment check rejected every attempt with
"queue X but benchmark expects Y". The Conductor workspace's logical name was
`agent-card`, but `run.sh` had built the stack as queue
`navi-agent-tasks-guangzhou` and DB `victoria-db-guangzhou` — the git worktree
directory basename.

## Diagnosis

Two components name the same local resources from two different sources of truth:

- `run.sh` derives the Temporal queue and DB container from the **git worktree
  directory basename**, and even logs the override:
  "Warning: CONDUCTOR_WORKSPACE_NAME=X does not match workspace path .../Y; using Y
  for local resources."
- `run_benchmark.py` recomputes the **expected** queue from
  `CONDUCTOR_WORKSPACE_NAME`.

When the Conductor logical name and the directory basename differ — which is normal,
not exotic — the two disagree and the alignment check fails. Confirmed again on the
diagnose-slow-prod-agent deploy (2026-07-02): env `cloud-flare-bot-cpu`, dir
`washington`.

A second, more dangerous face of the same split: the DB named after the env name may
exist but be only partially seeded. In the `mms--voice` worktree,
`victoria-db-mms--voice` lacked the real test user (`1f85ff25`, phone
`+19729777432`) so `data-real-user` and `send-sms` failed, while
`victoria-db-krakow` (the dir-basename DB) was the prod-synced one with 985 persons.
Note the test user is keyed by `userId`, not `id`.

Also important: passing `TEMPORAL_TASK_QUEUE` alone does **not** fix it —
`run_benchmark.py` ignores that env var and recomputes from
`CONDUCTOR_WORKSPACE_NAME`.

## Solution

Run the benchmark with `CONDUCTOR_WORKSPACE_NAME=<git dir basename>` so the expected
queue matches the stack `run.sh` actually built (for the `krakow` case, also override
`CONDUCTOR_PORT`, giving backend 55640, worker health 55642, frontend 55641, DB 55645,
queue `navi-agent-tasks-krakow`).

The durable lesson is that two components must not derive the same resource name from
two different inputs; until they share one derivation, always pass the dir basename
explicitly.

## Human feedback

None recorded.

## Reusable lesson

When a benchmark rejects a worker on queue mismatch, set
`CONDUCTOR_WORKSPACE_NAME` to the git worktree dir basename — `run.sh` names local
resources from the directory, not the Conductor logical name, and
`TEMPORAL_TASK_QUEUE` alone is ignored.
