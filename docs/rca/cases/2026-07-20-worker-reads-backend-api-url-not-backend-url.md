---
id: 2026-07-20-worker-reads-backend-api-url-not-backend-url
date: 2026-07-20
title: A manually relaunched worker read BACKEND_API_URL (not BACKEND_URL), so every activity hit a dead localhost:3001 and agents hung at STARTING_UP
surface: agents
component: temporal-worker
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: 'agents/config.py:264 — os.getenv("BACKEND_API_URL", "https://navi-j9a9.onrender.com"); agents/.env ships a static BACKEND_API_URL=http://localhost:3001 that overrides nothing else'
symptoms:
  - "worker log: Failed to poll messages ... 500 Internal Server for http://localhost:3001/..."
  - agents hang at STARTING_UP with cost 0
  - "poll_new_messages / check_user_usage activities all 500"
tags:
  - agents
  - temporal-worker
  - env-var
  - conductor-port
  - static-dotenv
sources:
  - memory:project_worker_relaunch_backend_api_url
repro: none-recorded
status: fixed
---

## Problem

When the agents Temporal worker is relaunched manually (`python worker.py`) outside
Conductor's `run.sh`, exporting `BACKEND_URL=<conductor port>` and sourcing
`agents/.env` is not enough: the worker still calls `http://localhost:3001`, which is
dead, so every `poll_new_messages` / `check_user_usage` activity gets a 500 and agents
hang at STARTING_UP with cost 0. The worker log shows
`Failed to poll messages ... 500 Internal Server` against `http://localhost:3001/...`.

## Diagnosis

The worker's backend URL comes from `BACKEND_API_URL`
(`agents/config.py:264`, defaulting to `https://navi-j9a9.onrender.com`), NOT from
`BACKEND_URL`. `agents/.env` ships a STATIC `BACKEND_API_URL=http://localhost:3001`,
so sourcing the dotenv actively overwrites the intended value while the exported
`BACKEND_URL` is simply ignored. This is the same class of static-`.env`-override bug as
the milan workspace queue-name incident: a checked-in dotenv value silently wins over the
operator's intent because the two names look interchangeable but only one is read.

## Solution

When relaunching, export `BACKEND_API_URL=http://localhost:<CONDUCTOR_PORT>` alongside
`DATABASE_URL`/`DIRECT_URL`, `TEMPORAL_TASK_QUEUE=navi-agent-tasks-<workspace-dir-basename>`,
`HEALTH_CHECK_PORT`/`SDK_METRICS_PORT`, `CONDUCTOR_PORT`, `CONDUCTOR_WORKSPACE_NAME`, and
`KERNEL_MOBILE_FALLBACK_ENABLED=1` for mobile-tier tests. Capture the running worker's
real environment with `ps eww -p <pid>` BEFORE killing it, rather than reconstructing it.
Note the Conductor queue name uses the workspace DIRECTORY BASENAME, which can differ
from `CONDUCTOR_WORKSPACE_NAME`.

## Human feedback

None recorded.

## Reusable lesson

Before relaunching a service by hand, read which env var the code actually consumes and
snapshot the live process env with `ps eww` — a static checked-in `.env` value will
override the variable you think you set.
