---
id: 2026-07-16-cloud-calibrated-timeouts-applied-to-5-concurrent-local-smoke
date: 2026-07-16
title: Cloud-fleet-calibrated per-task timeouts were applied to 5 concurrent local agents on one Mac
surface: harness
component: deploy-pipeline
classification: configuration-error
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-predeploy-local — ran 5 concurrent agents against timeouts calibrated for 1 agent per cloud machine
symptoms:
  - local pre-deploy smoke fails on task timeouts
  - a different benchmark task times out on each run
  - chat task takes 287s at concurrency 5 vs 123s at concurrency 2
tags:
  - smoke
  - deploy-gate
  - concurrency
  - timeouts
  - flaky
sources:
  - commit 62977fe91
  - memory:project_cerebras_ratecap_chat_fallback
repro: none-recorded
status: fixed
---

## Problem

The local pre-deploy smoke suite failed on per-task timeouts, and — the tell —
a _different_ benchmark task timed out on each run. Measured directly: the chat
task took 287s when 5 agents ran concurrently versus 123s at concurrency 2.

## Diagnosis

Per-task timeouts are calibrated against the **cloud fleet**, where the topology
is one agent per machine. The local path ran 5 of those agents concurrently on a
single Mac, so agents were CPU-starved and overran limits that are correct for
their intended topology. The randomly-rotating victim task is the signature of
resource contention rather than a task-specific defect.

The owned defect is the harness: it reused cloud-calibrated timeout budgets under
a fundamentally different local concurrency profile.

## Solution

`scripts/run-predeploy-local` now caps concurrency at `--max-concurrency 2`
(overridable via `PREDEPLOY_LOCAL_CONCURRENCY`). Result: a stable 7/7 local smoke.

Explicitly **not** benchmark tuning — no timeout, task definition, or pass
criterion was changed; only the local concurrency was brought in line with what
the machine can actually serve. Note the cache-ratchet gate in
`run_benchmark.py` remains intermittent because it depends on prod's 5-minute
Anthropic ephemeral cache warmth, but it passed in the concurrency-2 run.

## Human feedback

The user's standing rule was upheld rather than worked around: raising the
timeouts was rejected as reward hacking; the fix had to reduce contention with
timeouts unchanged.

## Reusable lesson

When a _different_ task times out on every run, treat it as host resource
contention and lower local concurrency — never raise the timeout.
