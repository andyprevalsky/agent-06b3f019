---
id: 2026-10-02-agent-store-daemon-probe-assumed-procfs
date: 2026-10-02
title: The agent-store daemon identity probe assumed Linux procfs on macOS
surface: infra
component: workspace-env
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/lib/workspace-env.sh cloud_env_agent_id read /proc/$pid/cmdline unconditionally
symptoms:
  - "FAIL: a running store daemon's id is the agent id: got '', expected 'bc-live'"
  - "failed deploy structural gates: workspace-env, run-process-cleanup"
tags:
  - deploy
  - macos
  - workspace
sources:
  - PR #1344
repro: scripts/tests/workspace-env.test.sh
status: fixed
---

## Problem

The integrated deploy structural gate failed its `workspace-env` suite on macOS while checking a live agent-store daemon. The pre-fix log is `.context/deploy-runs/20261002-155611-70059/logs/deploy-command-structural-20261002-160236-50733.log`.

## Diagnosis

The test supplied a live daemon PID and expected its `self-store-id`. `cloud_env_agent_id` accepted the ID only when `/proc/$pid/cmdline` contained `agent-store-fuse`. macOS has no `/proc`, so the process check returned false and the function returned an empty ID even though the daemon was running. The code had carried a Linux-only process probe into a cross-platform deploy path. Archive searches for the literal failure and for macOS procfs/agent-store daemon behavior found no matching first-bad boundary.

## Solution

Read procfs when available and fall back to `ps -p "$pid" -o command=` on hosts without it. Both paths still require the command to identify `agent-store-fuse` before trusting the stored ID, so stale or reused PIDs remain rejected. The same `bash scripts/tests/workspace-env.test.sh` command failed before the change and passed after it; the complete deploy structural runner then passed 31 suites. This runs only during workspace setup and adds no production per-agent work at 10,000 agents.

## Human feedback

None recorded.

## Reusable lesson

Use a process inspection method available on the host before treating a live daemon as absent.
