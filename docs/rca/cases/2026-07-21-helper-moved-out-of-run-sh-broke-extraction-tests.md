---
id: 2026-07-21-helper-moved-out-of-run-sh-broke-extraction-tests
date: 2026-07-21
title: Tests that extracted a shell helper from run.sh broke when the helper moved into a sourced library
surface: harness
component: cloudbench-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/benchmarks/cloudbench_dependency_sync_test.py extracted backend_ready_budget from scripts/run.sh alone after it moved to scripts/lib/seed-cache.sh"
symptoms:
  - "backend_ready_budget: command not found"
  - cloudbench dependency-sync tests fail after a run.sh refactor
  - blackbox mock lambdas fail with unexpected keyword/positional argument
tags:
  - shell
  - cloudbench
  - test-harness
  - refactor-fallout
  - seed-cache
sources:
  - PR #820
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

Two blackbox/harness tests failed as a direct result of the branch's own refactors.
The cloudbench dependency-sync tests died with
`backend_ready_budget: command not found`, and the agents benchmark blackbox failed
because its mock lambdas did not accept newly added arguments.

## Diagnosis

The tests reconstructed a runnable shell fragment by extracting helper functions
**from `scripts/run.sh` only**. When `backend_ready_budget()` was moved into
`scripts/lib/seed-cache.sh` (sourced by `run.sh`), the extraction still succeeded
but produced a fragment missing that function, so the helper was undefined at call
time. The same class of coupling caused the second failure: `_apply_live_fixture`
gained a `tolerate_gpt_code_unavailable` kwarg and a cookie-domains positional, and
the test's arg-less mock lambdas were pinned to the old signature. In both cases the
test encoded an implementation detail (where the code lives / its exact arity) rather
than the behavior, so an ordinary refactor broke the harness rather than the product.

## Solution

`isolated_backend_ready_attempts()` now delegates to `backend_ready_budget()` and
prepends the budget helper plus the `DB_RESTORED` / `FIRST_RUN_SEEDED=false`
defaults that `run.sh` sets, so extraction follows the helper wherever it is
sourced from. The benchmark blackbox mocks were updated to accept the new
kwarg/positional. Landed alongside the ecommerce-slice cloud-bench work
(per-task cookie-domain scoping, seed-cache stale-dump decision plus
`backend_ready_budget` so a restore gets the same health budget as a cold seed,
compute-token sync tolerating an exhausted Codex `gpt_code`, and a Fast-Mode
cache-schema pooler retry).

## Human feedback

None recorded.

## Reusable lesson

A test that greps or extracts code out of one shell script silently rots when the
helper is moved to a sourced library — source the same libraries the real script
sources instead of reconstructing its body.
