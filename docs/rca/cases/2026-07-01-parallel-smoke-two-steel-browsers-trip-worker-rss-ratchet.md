---
id: 2026-07-01-parallel-smoke-two-steel-browsers-trip-worker-rss-ratchet
date: 2026-07-01
title: Parallel smoke put two Steel browsers in one worker, tripping the RSS-growth ratchet even with 6/6 tasks passing
surface: harness
component: benchmark-runner
classification: configuration-error
problem_class: concurrency-inefficiency
first_bad_boundary: run_benchmark.py --parallel — two browser tasks share one worker process tree, whose RSS growth is checked against BENCHMARK_SMOKE_MEMORY_MAX_GROWTH_MB=256
symptoms:
  - smoke exits 1 despite reporting 6/6 tasks passed
  - worker process-tree RSS growth ~+490MB against a 256MB cap
  - "playwright_drivers=0 (no leaked drivers)"
tags:
  - smoke-benchmark
  - memory-ratchet
  - steel
  - parallelism
  - deploy-gate
sources:
  - memory:project_deploy_gotchas_local_stack
repro: none-recorded
status: mitigated
---

## Problem

Smoke exited 1 even though all 6 tasks passed. The failing gate was the memory
ratchet: `run_benchmark.py` checks worker-process-tree RSS growth against
`BENCHMARK_SMOKE_MEMORY_MAX_GROWTH_MB=256`, and the run grew about **+490MB**.

## Diagnosis

Running with `--parallel` placed `browser-smoke` and `browser-biometrics-webdecoy` in
the same worker process tree, so two Steel browsers plus Playwright peaked
simultaneously inside one worker. That is genuine retained RSS, not a leak:
`playwright_drivers=0` confirmed no drivers were left behind.

The ratchet itself is not a regression — it lives on main (introduced in #574) — and
the tasks' own behavior was correct. What was wrong was pairing a per-worker memory
budget sized for one browser with a scheduling mode that puts two in the same worker.

Related detail worth keeping: recordings are off by default in smoke
(`BROWSER_AGENT_RECORDINGS` unset → `browser_recordings_enabled()` is False), so
recording code never contributes to smoke memory.

## Solution

Re-run smoke **without** `--parallel`, so only one browser is live at a time: growth
drops to about +114MB and the gate passes. This is the deploy-sanctioned remedy for
resource contention.

Explicitly not done: raising `BENCHMARK_SMOKE_MEMORY_MAX_GROWTH_MB`. The cap is a real
invariant and lifting it to accommodate a scheduling choice would hide future leaks.

## Human feedback

The user's standing rule against relaxing bounds was applied — the cap stays where it
is and the concurrency changes instead.

## Reusable lesson

Two browser tasks in one worker will trip the smoke RSS ratchet: drop `--parallel`
rather than raising the memory cap.
