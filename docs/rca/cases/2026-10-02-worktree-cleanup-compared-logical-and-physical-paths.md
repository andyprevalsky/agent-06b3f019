---
id: 2026-10-02-worktree-cleanup-compared-logical-and-physical-paths
date: 2026-10-02
title: Worktree cleanup missed a worker because macOS lsof and PWD used different path forms
surface: infra
component: run-process-cleanup
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/run.sh process_cwd_in_this_worktree compared physical lsof cwd to logical PWD
symptoms:
  - "FAIL: stale-stack sweep reaps a same-worktree worker.py: process 71036 is still alive"
  - "failed deploy structural gates: workspace-env, run-process-cleanup"
tags:
  - deploy
  - macos
  - process-cleanup
sources:
  - PR #1344
repro: scripts/tests/run-process-cleanup.test.sh
status: fixed
---

## Problem

The integrated deploy structural gate's stale-stack sweep left a same-worktree `worker.py` alive after it had reaped the sibling Vite server. The pre-fix failure is in `.context/deploy-runs/20261002-155611-70059/logs/deploy-command-structural-20261002-160236-50733.log`.

## Diagnosis

The sweep identifies workers by current working directory when their argv lacks an explicit worktree path. `lsof -d cwd` returned macOS's physical `/private/var/...` path, while `$PWD` in the same test used the logical `/var/...` spelling. The string prefix check rejected the worker as outside the worktree, so the sweep did not terminate it. Archive searches for the literal sweep failure and for macOS lsof/physical cwd cleanup found related teardown incidents but no matching boundary.

## Solution

Compare lsof's cwd to the physical worktree path from `pwd -P`. This preserves the same ownership check and finds workers launched under a symlinked path. `bash scripts/tests/run-process-cleanup.test.sh` failed on the old comparison and passed on the new one; the full 31-suite deploy structural runner then passed. This is local stack cleanup only, with no runtime per-agent cost at 10,000 agents.

## Human feedback

None recorded.

## Reusable lesson

Normalize both sides of a process cwd ownership comparison to the same physical path form.
