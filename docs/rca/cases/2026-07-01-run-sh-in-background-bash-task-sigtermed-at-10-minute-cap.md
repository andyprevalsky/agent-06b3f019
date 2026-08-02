---
id: 2026-07-01-run-sh-in-background-bash-task-sigtermed-at-10-minute-cap
date: 2026-07-01
title: A local stack started via `run_in_background` was SIGTERM'd at the 600s Bash-task cap, tearing down backend and worker mid-smoke
surface: harness
component: deploy-pipeline
classification: our-bug
problem_class: other
first_bad_boundary: run.sh launched through the Bash tool's run_in_background — the task is SIGTERM'd at exactly 600s and run.sh's EXIT trap tears down the stack
symptoms:
  - stack dies at exactly 600s with backend and worker torn down
  - smoke run fails partway through because its services vanished
  - "setsid: command not found" and nothing starts on macOS
tags:
  - deploy-pipeline
  - background-task
  - sigterm
  - macos
  - run-sh
sources:
  - memory:project_deploy_gotchas_local_stack
repro: none-recorded
status: fixed
---

## Problem

On the agentcard-integration deploy (2026-07-01) the local stack died at exactly
600s. Because `run.sh`'s EXIT trap tears down backend and worker, running blackbox
tests and _then_ smoke on one stack meant the stack aged out mid-smoke and the smoke
run failed for want of services. (The DB survives if `DB_OWNED_BY_US=false`.)

## Diagnosis

A stack started with the Bash tool's `run_in_background=true` is a managed task, and
that task is SIGTERM'd at the tool's 600s maximum. `run.sh` treats any termination as
a shutdown and its EXIT trap tears the stack down — so the service lifetime was
silently capped at 10 minutes regardless of how long the deploy needed.

The first attempt at a fix failed for a second reason: `setsid` **does not exist on
macOS**, so a `setsid`-based detach silently reported "command not found" and started
nothing at all.

Honest scope note from the record: on the 2026-07-02 deploy the `run_in_background`
stack did _not_ hit the cap — the worker died once cleanly at ~4–5 min with code 0 and
no traceback, and a plain kill-services + relaunch was stable for the full ~8-minute
smoke. So the 600s cap is not always the culprit; a fresh relaunch often just works.

## Solution

Launch the stack **detached** from a foreground Bash call so it is immune to the task
cap: `nohup env ... bash scripts/run.sh --benchmark > log 2>&1 & disown` — using
`nohup ... & disown`, **not** `setsid`. The same applies to any smoke run expected to
exceed 10 minutes.

## Human feedback

None recorded.

## Reusable lesson

Launch long-lived local stacks detached with `nohup ... & disown` (never `setsid` on
macOS) — a `run_in_background` task is SIGTERM'd at 600s and `run.sh`'s EXIT trap
takes the services with it.
