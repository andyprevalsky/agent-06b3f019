---
id: 2026-10-01-blackbox-runner-orphaned-isolated-backends
date: 2026-10-01
title: The blackbox runner's cleanup signalled only the npx launcher, so every run orphaned its isolated backend and 23 of them OOM-killed later gates
surface: back-end
component: blackbox-runner
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/run-blackbox-tests.sh cleanup() ran `kill "$BACKEND_PID"`, where `$BACKEND_PID` is `npm exec`; npm runs `sh -c tsx …`, and the tsx process and its server re-parent to PID 1 and keep serving
symptoms:
  - "eslint exit 123 Killed"
  - "vitest worker exited unexpectedly (OOM)"
  - "node /workspace/node_modules/.bin/tsx src/bootstrap.ts with PPID 1"
  - isolated blackbox ports 3101-3123 still serving after their runs finished
tags:
  - deploy
  - blackbox
  - process-lifecycle
  - memory
sources:
  - PR #1364
repro: back-end/src/tests/unit/process-tree-teardown.test.ts
status: fixed
---

## Problem

During `/deploy` Group 3 on a Cursor Cloud VM (4 cores, 16GB, no swap), the static lane's ESLint died with `exit 123 Killed` and a front-end vitest worker was OOM-killed. The same lanes had passed earlier on the same branch.

## Diagnosis

`ps` showed 46 orphaned processes (PPID 1) using 9.7GB of RSS: 23 `node …/.bin/tsx src/bootstrap.ts` launchers, each with its server child. They were the isolated backends from earlier `run-blackbox-tests.sh` runs (one per domain run, ports 3101–3123), and all were still serving hours after their runs had finished.

The runner starts its backend as `npx tsx src/bootstrap.ts &` and records `BACKEND_PID=$!`. That PID is `npm exec`, which runs `sh -c tsx src/bootstrap.ts`, which runs `tsx`, which runs the server. The old `cleanup()` sent TERM to `$BACKEND_PID` only. Reproduced against the real launcher: after `kill "$BACKEND_PID"`, `npm exec` and `sh` exit within a second, but `tsx` re-parents to PID 1 and the port keeps serving. Every blackbox run therefore leaked about 400MB, and a deploy that runs many domains leaks enough to starve whatever runs next.

## Solution

`scripts/lib/process-tree.sh` adds `stop_process_tree`: it collects the PID and all of its descendants, sends TERM to all of them, waits up to a grace period (zombies count as stopped), and then sends KILL to whatever is left. The tree stays in the caller's process group, so an outer launcher that signals the group still reaches it. The runner's `cleanup()` now calls `stop_process_tree "$BACKEND_PID"`. It runs on EXIT, and INT/TERM now just exit with 130/143 so the EXIT trap runs cleanup exactly once.

`back-end/src/tests/unit/process-tree-teardown.test.ts` launches a wrapper that, like `npx`, starts a child and exits on TERM without forwarding it. The control case (signal the leader only) proves the fixture leaks the child. The other cases prove that `stop_process_tree` stops the tree and that a tree ignoring TERM is KILLed within the grace period. The test also checks that the runner records `BACKEND_PID` and calls `stop_process_tree` from `cleanup()`. With a stub that kills only the leader, the test fails with "stop_process_tree left the wrapper's server … running". With the fix, the test passes, and a real `npx tsx src/bootstrap.ts` backend stops completely: port closed, no process left with that run's ID, both for a normal exit and for TERM to the runner's process group.

## Human feedback

None recorded.

## Reusable lesson

`$!` for `npx …` / `npm exec …` / `tsx …` is a launcher, not the service. Signalling it alone orphans the real process, which keeps its port and memory. Stop the whole process tree (TERM, bounded wait, KILL), and check for leftovers by run ID or port instead of trusting the launcher's exit.
