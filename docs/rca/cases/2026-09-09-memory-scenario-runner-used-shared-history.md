---
id: 2026-09-09-memory-scenario-runner-used-shared-history
date: 2026-09-09
title: Memory A/B runner validated corpus size but not frozen fixture identity
surface: harness
component: memory-scenario-runner
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/benchmarks/run_memory_scenarios.py main_async history validation
symptoms:
  - "history table: {'total': 17005"
  - "instacart-store-pinning on=0/3 mem=3"
  - "same-size but incorrect fixture corpus must fail closed"
tags:
  - planner-memory
  - benchmark-isolation
  - fixture-identity
sources:
  - plan:agents/benchmarks/runs/memory-scenarios-20260909T194245Z.json
  - plan:agents/benchmarks/runs/memory-scenarios-20260909T200122Z.json
  - plan:agents/benchmarks/runs/memory-scenarios-20260909T212747Z.json
repro: agents/tests/blackbox/planner_memory.blackbox.py
status: fixed
---

## Problem

The frozen 33-scenario A/B suite ran against a database containing 17,005
history rows and reported 32/33. `instacart-store-pinning` retrieved three
same-scoring histories, including a generic/Kroger route, and memory-on failed
0/3 to preserve the Sprouts requirement. A fresh fixture-only database passed
that unchanged case and the full suite passed 33/33. The original repair checked
only row count, which still accepted a wrong corpus containing the same number
of rows as the fixture.

The critical path was `fixture JSON -> runner upsert -> backend history table ->
runner preflight -> A/B retrieval -> scenario verdict`. The first bad boundary
was the preflight accepting storage it had not proven identical. Archive
searches for `expected fixture rows`, `shared history benchmark`, and
`same-size corpus` found no prior matching cause; this was novel.

## Diagnosis

The runner assumed that a matching cardinality implied a matching dataset.
That is false for replaced rows, stale content, wrong compressor versions, or
rows with the same IDs but mutated outcomes. The deeper owned gap was failure to
define and compare the fixture's identity-bearing fields, not merely failure to
start a fresh database.

## Solution

After upsert, the runner now fetches every expected ID and compares the exact
projection `id`, `goal`, `benchmark_task_name`, `passed`, `root_status`,
`world_model_mode`, `critical_path`, and `compressor_version`, in addition to
requiring the total count. Any missing, extra, or changed row fails before an
LLM trial. The permanent blackbox replaces one expected row with a different row
while keeping cardinality constant and observes `same-size but incorrect fixture
corpus must fail closed before an A/B run`.

`cd agents && python3 tests/blackbox/planner_memory.blackbox.py` passes the exact
guard. After rebuilding all 31 fixture rows with cp-v7, the final isolated
three-trial-per-arm run passed 33/33 in
`memory-scenarios-20260909T212747Z.json`: 17/17 fit, 16/16 held-out, 6/6 strict
improvements, and 2/2 controls. This change is harness-only and has no
production runtime cost.

## Human feedback

None recorded.

## Reusable lesson

Validate frozen corpora by exact identity-bearing content, never by cardinality alone.
