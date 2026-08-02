---
id: 2026-07-11-harness-startup-marks-other-active-agents-stale-failed
date: 2026-07-11
title: Each benchmark harness run marked every other ACTIVE agent stale-FAILED, killing a concurrent run's live agent mid-flight
surface: harness
component: benchmark-runner
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: run_benchmark.py startup staleness sweep — marks all other ACTIVE agents FAILED regardless of which run owns them
symptoms:
  - a still-ACTIVE agent from a previous harness run flips to FAILED mid-flight
  - second concurrent gate benchmark kills the first one's agent
  - gate messages persist and FE links survive, but the agent is dead
tags:
  - benchmark
  - concurrency
  - agent-lifecycle
  - stale-sweep
sources:
  - memory:project_gate_benchmarks_fe_verification
repro: none-recorded
status: mitigated
---

## Problem

While verifying gate benchmarks against a shared live stack
(`.context/benchmarks/gate-all-20260710/`, backend :61100), starting a second
harness run flipped the first run's still-ACTIVE agent to FAILED mid-flight. The
agent's gate messages persisted and its FE link kept working, but the agent itself
was dead, so a browser gate that needed ~66s to reach "Payment card approval
required" could be killed by an unrelated run.

## Diagnosis

Harness startup performs a staleness sweep that marks **all** other ACTIVE agents
as FAILED, with no notion of which run owns which agent. Against a shared stack
that is indistinguishable from cleanup of genuinely orphaned agents — so any two
concurrent harness invocations are mutually destructive by design.

## Solution

Mitigated operationally, not fixed in code: run browser gate tasks
**sequentially** against a shared stack. Re-run a single task with
`cd agents && CONDUCTOR_WORKSPACE_NAME=<ws> BENCHMARK_CONTEXT_DIR=<abs ctx> BENCHMARK_MODE=1 PUBLIC_BASE_URL=<ngrok> python benchmarks/run_benchmark.py --task <t> --port 61100 --keep-agents`.
Note the related requirement that payment approval needs the harness's
`auto_approve`, or the run blocks before the mint.

## Human feedback

None recorded.

## Reusable lesson

Before starting a second benchmark harness against a shared stack, remember that
startup staleness sweeps are un-scoped and will fail the other run's live agents —
serialize, or scope the sweep to the current run's agents.
