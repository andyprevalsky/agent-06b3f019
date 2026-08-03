---
id: 2026-07-19-strict-gpt-code-token-gate-blocked-browser-benchmarks
date: 2026-07-19
title: A strict compute-token gate failed every benchmark when prod's Codex (gpt_code) integration was rate-limited, including tasks that never use Codex
surface: harness
component: benchmark-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "run_benchmark.py:_refresh_local_compute_tokens_for_run → seed-local.ts --compute-tokens-only — syncComputeTokensWithRetries throws when gpt_code has no usable integration"
symptoms:
  - "RuntimeError: Benchmark run could not refresh local compute tokens"
  - "No usable gpt_code integrations after sync"
  - browser-only bench slice lands 0/7 about a minute into every run
  - 'fleet classifies the fastest boxes'' early rc=1 exit as "failed before the barrier (infra)"'
tags:
  - benchmarks
  - compute-tokens
  - codex
  - external-quota
  - fleet
sources:
  - commit 05ad371ad
  - memory:project_ecommerce_slice_compute_token_gate
repro: agents/benchmarks/run_benchmark_compute_tokens_test.py
status: fixed
---

## Problem

On 2026-07-19 the 7-task ecommerce browser slice landed 0/7 with a single root
cause that had nothing to do with browsers. Each on-box run aborted about a minute
into the benchmark with
`RuntimeError: Benchmark run could not refresh local compute tokens`, raised from
`agents/benchmarks/run_benchmark.py:_refresh_local_compute_tokens_for_run` →
`back-end/scripts/seed-local.ts --compute-tokens-only` →
`syncComputeTokensWithRetries` throwing `No usable gpt_code integrations after
sync` because prod's `gpt_code` (Codex) integration was rate-limited/quota
exhausted. None of the 7 browser tasks ever spawn Codex.

## Diagnosis

The failure also disguised itself: the "3 excluded as infra" boxes were the SAME
failure, not slow boot — those 3 booted fastest, ran the benchmark first, and
exited `rc=1` _before_ the tolerant start-barrier released, so the fleet
classified their early exit as "failed before the barrier (infra)". The other 4
exited `rc=1` post-barrier → NORESULT. The owned cause: the pre-flight token sync
treated every provider as mandatory, so an _external_ quota condition on one
unrelated provider became a hard gate on all benchmark execution, and the fleet's
infra/verdict classifier then hid the shared cause behind two different labels.

## Solution

`run_benchmark.py:_sync_compute_tokens(*, allow_missing_gpt_code=True)` now always
sets `SEED_ALLOW_MISSING_GPT_CODE=1` on the `seed-local` subprocess env:
`gpt_code` availability is external quota and can NEVER block a benchmark, while
`claude_code` sync still hard-fails. `seed-local.ts` keeps its strict default for
direct, non-benchmark callers, so the relaxation is scoped to the harness. Test:
`agents/benchmarks/run_benchmark_compute_tokens_test.py`.

## Human feedback

None recorded.

## Reusable lesson

A pre-flight credential sync must only hard-fail on credentials the run actually
needs — scope the strictness to the harness caller, and suspect one shared
pre-flight gate when a whole slice fails identically about a minute in.
