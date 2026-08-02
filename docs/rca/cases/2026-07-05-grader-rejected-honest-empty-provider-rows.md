---
id: 2026-07-05-grader-rejected-honest-empty-provider-rows
date: 2026-07-05
title: The user-data-prod-grep grader rejected a correct grep that legitimately returned nothing, producing a false negative
surface: harness
component: benchmark-evaluator
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py — the user-data-prod-grep grader required a populated result instead of an evidence boolean
symptoms:
  - user-data-prod-grep benchmark fails despite a correct provider grep
  - "grader rejects a provider row with verified=False and no path"
  - benchmark coverage gate surfaces a false negative
tags:
  - benchmark
  - evaluator
  - false-negative
  - grader
  - user-data-grep
sources:
  - PR #711
repro: agents/tests/blackbox/benchmark.blackbox.py
status: fixed
---

## Problem

The coverage gate surfaced a false negative in the `user-data-prod-grep` grader:
a provider that the agent had grepped correctly but which legitimately contained
no matching documents (`verified=False`, no path) was scored as a failure. The
agent's behavior was right; only the grader disagreed.

## Diagnosis

The grader's pass condition conflated "the agent did the work" with "the work
found something". An empty-but-honest provider row is indistinguishable, under a
result-presence check, from a provider the agent never touched — so the only way
to pass was to have data. Meanwhile the check the grader actually needed —
rejecting _fabricated_ rows, i.e. `verified=True` without a `documents/` path —
had been lost. The deepest cause is that the evaluator's contract encoded a data
expectation instead of an evidence expectation, which makes correct behavior on
an empty dataset unpassable.

## Solution

Restored the evidence-boolean gate in `agents/benchmarks/run_benchmark.py`: an
honest empty-provider row passes, while a row claiming `verified` without a
`documents/` path is still rejected. Covered by the benchmark blackbox domain,
which asserts `user_data_prod_grep` grading is restored. Any grader that scores
retrieval work should assert on the evidence of the attempt, not on the presence
of results.

## Human feedback

None recorded.

## Reusable lesson

Grade retrieval tasks on evidence that the search happened, not on non-empty
results — otherwise a correct search over an empty source is scored as a failure.
