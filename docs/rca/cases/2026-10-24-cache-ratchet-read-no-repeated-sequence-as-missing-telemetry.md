---
id: 2026-10-24-cache-ratchet-read-no-repeated-sequence-as-missing-telemetry
date: 2026-10-24
title: Cache ratchet failed a run with no repeated cache sequence as if telemetry were missing
surface: harness
component: benchmark cache ratchet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py cache_ratchet_failures — any 0/0 repeatable metric failed a positive floor, but aggregate_repeatable_cache_usage reports 0/0 both for missing sequence telemetry and for a run whose sequences each ran once
symptoms:
  - "CACHE RATCHET FAILED (per-task repeatable prompt-cache hit floor):"
  - "claude-code-agent: 0.0% < 35.0% ratchet"
  - task PASS but bench exit 1, overall cache hit ~64%
tags:
  - cache-ratchet
  - benchmark
  - evaluator
sources:
  - agent 18748b72-3e2e-4eb3-ac89-ac04bdc04e3a
  - commit 20d7941fc (fix; red ab88d930b, branch rca/R3e-ratchet-zero-repeatable)
  - agent 24fa9261-fdfb-4de2-9d24-1ea0f7ed578a
  - agent 7ce60202-4212-4cb4-8f69-2f0e930593b7
repro: agents/tests/blackbox/cache_ratchet.blackbox.py::test_no_repeated_sequence_is_not_missing_telemetry
status: fixed
---

## Problem

After the code-agent handoff landed, local claude-code-agent 18748b72 passed the task but the
bench exited 1. The run had one root execute_loop call (13,768 read / 5,755 write) plus one-shot
summary and schema calls. The ratchet printed "0.0% < 35.0%".

## Diagnosis

The valid handoff makes the spawn a structured success, so the root completes without a second
planner call. No cache sequence ran twice, so the repeatable metric is 0/0.
`cache_ratchet_failures` treated every 0/0 as missing telemetry and failed. The aggregator already
knew the difference, but it did not report it.

## Solution

`aggregate_repeatable_cache_usage` now also reports `sequenced_call_count` and
`repeatable_call_count`, carried on TaskResult. A 0/0 metric passes only when at least one call
carried sequence telemetry and none repeated. A repeated sequence with no cache usage still
fails, and so does a run with no sequenced call at all (fail closed). The 35% floor is unchanged.
Verification:
- cache_ratchet red then green 5x.
- Local claude-code-agent passed twice in a row with exit 0: 24fa9261 (single-pass, 1 sequenced / 0 repeated) and 7ce60202 (3 repeated calls, 87.8% repeatable hit).

## Human feedback

Andy (2026-10-24): implement the evaluator change now and batch the approval at the end; the 35% floor stays.

## Reusable lesson

A zero-denominator metric must say why it is zero; record the counts so "nothing to measure" and "measurement missing" are not the same verdict.
