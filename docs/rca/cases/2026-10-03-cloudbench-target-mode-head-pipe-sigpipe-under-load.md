---
id: 2026-10-03-cloudbench-target-mode-head-pipe-sigpipe-under-load
date: 2026-10-03
title: The cloudbench driver read the benchmark target mode through `printf | head -1`, which exits 141 under pipefail when head wins the race
surface: harness
component: cloudbench-driver
classification: our-bug
problem_class: other
first_bad_boundary: scripts/cloudbench-run.sh took the first line of the target plan with `printf '%s\n' "$PLAN" | head -1` (both the stack-mode and run-mode parse); bash line-buffers builtin output, so head can exit after the first line and the next write raises SIGPIPE, failing the command substitution with 141
symptoms:
  - "FAILED agents/benchmarks/cloudbench_dependency_sync_test.py::test_isolated_backend_production_only_cloud_route_targets_production"
  - "assert 141 == 0"
tags:
  - cloudbench
  - deploy
  - flaky-test
  - bash
sources:
  - PR #1401
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_isolated_backend_target_plan_mode_parse_survives_early_reader_exit
status: fixed
---

## Problem

During the deploy Group 3 rerun on a 4-core host (load average about 15), the agents coverage lane failed in the `benchmark` domain. Its permanent cloudbench gate ran `test_isolated_backend_production_only_cloud_route_targets_production`, which executes the driver's real `BENCH_ARGS` block under `set -euo pipefail`. The block exited 141 with empty stdout and stderr. The same test passed 5 of 5 times when run alone on an idle host.

## Diagnosis

Exit 141 is SIGPIPE. The only pipeline in that block is `BENCH_TARGET_MODE="$(printf '%s\n' "$BENCH_TARGET_PLAN" | head -1)"`. The production plan is two lines (`prod`, `--prod`). Bash line-buffers builtin output, so `printf` writes each line separately. When `head` reads the first line and exits before `printf` writes the second, that write raises SIGPIPE, `pipefail` reports 141, and `set -e` aborts. On a loaded host the scheduler lets `head` win often enough to fail the gate. The stack-mode parse at the top of the driver uses the same pattern.

The production driver runs with `set -uo pipefail` but without `-e`, so in real fleets the 141 was ignored and the mode still parsed (head had printed it). The defect was fatal only where the code runs under `-e`, which is the permanent test.

Local repro: a new test stubs the target resolver to print `prod` plus 20,000 argument lines and runs both parse sites under `set -euo pipefail`. On the old driver it fails 5 of 5 times with `assert 141 == 0`; with the fix it passes 5 of 5.

## Solution

- Both parse sites take the first line with parameter expansion (`${PLAN%%$'\n'*}`), so no pipe and no early-exiting reader are involved.
- The new test name contains `isolated_backend`, so both permanent gates select it: the agents `benchmark` blackbox (`test_cloudbench_dependency_rebuild_behavior_is_in_permanent_gate`) and the deploy Step 4cb controller lane.
- No 10,000-agent impact: the change removes one subprocess per fleet guest launch and touches only the benchmark controller.

## Human feedback

None recorded.

## Reusable lesson

Never take the head of a multi-line value with `| head` under `pipefail`; the writer can be killed by SIGPIPE depending on scheduling. Use parameter expansion or `read` for the first line.
