---
id: 2026-07-06-simulate-mode-passed-with-zero-world-model-steps
date: 2026-07-06
title: Simulate-mode benchmarks passed with zero World Model steps because cache replay served the run and the worker was never in simulate mode
surface: harness
component: world-model-harness
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: run.sh worker env — BENCHMARK_WORLD_MODEL_MODE/WMH_BASE_URL were never exported into the process the worker forks from
symptoms:
  - "simulate benchmark reports a pass with 0 WMH /step calls"
  - simulate run costs $0 because every LLM call is fast-cache replayed
  - "WorldModelToolExecutionAdapter.from_env() sees no simulate mode"
tags:
  - simulate
  - world-model
  - fast-cache
  - false-green
  - benchmark
sources:
  - memory:project_simulate_e2e_wired_rose_provider
repro: none-recorded
status: fixed
---

## Problem

`--simulate` benchmark runs reported passes while making **zero** World Model
Harness steps — a fake pass. Nothing in the run exercised the simulated
environment it was supposed to validate.

## Diagnosis

Two independent reasons the WMH was bypassed, plus an ordering hazard:

1. **Fast-cache replay served the whole run**, so no LLM call and no tool boundary
   ever reached the world model — the run was green because it replayed a prior
   non-simulate trajectory.
2. **The worker was never actually in simulate mode.** `world_model_cache_scope()`
   and `WorldModelToolExecutionAdapter.from_env()` read **process** env, but
   `run.sh` alone never set the mode — so the forked worker had no
   `BENCHMARK_WORLD_MODEL_MODE` / `WMH_BASE_URL` / `WMH_MODEL_NAME`.
3. WMH session creation was order-dependent, requiring injection at the right
   moment rather than on demand.

The general shape: a mode flag that is read from process env but set only in a
wrapper script is silently off, and a cache that replays across modes hides the
difference.

## Solution

Three fixes made simulate actually exercise the WMH: (1) cache OFF for sim
validation — `local.py` sets `BENCHMARK_FAST_MODE_CACHE=false` when `--simulate`;
(2) `start_services` sets `BENCHMARK_WORLD_MODEL_MODE=simulate`,
`WMH_BASE_URL=localhost:(base+6)` and `WMH_MODEL_NAME` in the run.sh env the worker
forks from; (3) lazy per-agent WMH session creation in
`agents/helpers/world_model_runtime.py` (`ensure_world_model_session`, module-level
cache keyed by `(agent_id, model)`), removing the ordering/injection problem. Proof
after the fix: 13 real `/step` 200s, cost climbing with cache off, one reused
session. Shipped 2026-07-06 alongside `RoseWMHProvider`
(`agents/benchmarks/wmh_rose_provider.py`) and
`agents/benchmarks/serve_world_model.py`.

## Human feedback

None recorded.

## Reusable lesson

A simulate/mock mode that passes without any call to the simulator is a false
green — assert a nonzero step count and disable trajectory caching before trusting
any mode-specific run.
