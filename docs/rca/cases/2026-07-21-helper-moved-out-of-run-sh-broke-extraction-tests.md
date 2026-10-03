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

## Recurrence: isolated worker cleanup fixture (2026-10-03)

The canonical agents coverage run on `2f52838680f4d490a8d9ef71c76d2b584c3e4ca5`
passed 105 of 106 domains. The worker domain's existing
`test_stack_reaps_services_when_pending_receipt_cannot_be_written` failed after
its extracted `cleanup()` called `remove_isolated_frontend_build`, which the
fixture had not extracted. The original stderr records that missing command;
the original assertion did not record the shell's return code. The aggregate
remains failed, and its cache/unit/coverage tail did not execute.

The same existing case was then called directly with a private process observer.
It failed in 3.638 seconds with shell return code 127. Adding the actual
`remove_isolated_frontend_build` function to the fixture's extraction list made
that same case pass in 6.876 seconds: both worker-exit variants returned the
required shell code 1. All observed shell owners retired. The observer, selector,
environment, production helpers and assertions were unchanged; only the private
receipt label and the one-line fixture dependency addition differed. The real
helper returns immediately when no frontend build is assigned. No no-op stub,
production change, timeout change or weakened cleanup assertion was introduced.

The case remains registered in the existing worker blackbox domain. A focused
worker refresh plus the previously unrun canonical coverage tail is required;
the failed aggregate must not be relabeled as a fresh passing full-suite run.
This recurrence shows why extracting the caller alone does not preserve its
real shell dependency set, including error paths that retain `errexit`.
