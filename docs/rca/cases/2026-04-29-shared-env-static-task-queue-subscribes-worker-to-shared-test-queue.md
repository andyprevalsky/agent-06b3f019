---
id: 2026-04-29-shared-env-static-task-queue-subscribes-worker-to-shared-test-queue
date: 2026-04-29
title: A manually launched worker fell back to the shared `.env` task queue and picked up other worktrees' agents
surface: agents
component: temporal-worker
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/.env (symlinked and shared across all worktrees) pins TEMPORAL_TASK_QUEUE="navi-agent-tasks-test"; load_dotenv(override=False) lets it win when no export is present
symptoms:
  - worker subscribes to navi-agent-tasks-test instead of the per-workspace queue
  - a worktree's worker picks up other worktrees' test agents
  - agents dispatched to the per-workspace queue are never claimed
tags:
  - temporal
  - task-queue
  - shared-env
  - conductor-worktree
  - cross-contamination
sources:
  - memory:project_milan_workspace_setup
repro: none-recorded
status: mitigated
---

## Problem

A worker launched by hand in a Conductor worktree (`milan`, `CONDUCTOR_PORT=3007`,
intended queue `navi-agent-tasks-milan`) subscribed instead to the shared
`navi-agent-tasks-test` queue and began picking up **other** worktrees' test agents —
while agents dispatched to the worktree's own queue went unclaimed.

## Diagnosis

`agents/.env` is a symlink to the canonical repo's `.env`, shared by every worktree,
and it carries a static `TEMPORAL_TASK_QUEUE="navi-agent-tasks-test"`. Because the
worker loads config with `load_dotenv(override=False)`, an absent process-env export
means the shared static value wins.

`scripts/run.sh` exports the per-workspace queue, so the normal path is fine. Only a
manual `python worker.py` inherits the shared default — and it does so silently, with
no mismatch warning, which is what turns a config default into cross-workspace agent
theft.

The structural cause: per-worktree state (task queue) is stored in a file that is by
design shared across all worktrees.

## Solution

Always launch via `scripts/run.sh`, which exports the per-workspace queue. When
launching a worker manually, `export TEMPORAL_TASK_QUEUE=navi-agent-tasks-<workspace>`
**before** invoking Python — never trust the `.env` value.

## Human feedback

None recorded.

## Reusable lesson

Per-worktree values must never be read from the shared symlinked `.env` — export the
task queue explicitly before launching a worker, or it will silently join the shared
test queue and steal other workspaces' agents.
