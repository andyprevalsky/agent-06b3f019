---
id: 2026-09-12-predeploy-local-selected-production-only
date: 2026-09-12
title: Local predeploy selected a production_only payment task and failed in 0s
surface: harness
component: select-predeploy-benches
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/select_predeploy_benches.py _eligible — skipped local-only on cloud but not production_only on local
symptoms:
  - agent-payment-production-abandonment is production-only; rerun with --prod
  - RESULTS: 7/8 passed
  - local predeploy selected a production_only task
tags:
  - predeploy
  - production-only
  - smoke
  - payment
  - deploy-gate
sources:
  - commit 515a418783ab14616f94bd26afde99b08de2219c
  - benchmark run 20260912-211324-76991
repro: cd agents && ./venv/bin/python -m pytest -q benchmarks/select_predeploy_benches_test.py::test_local_surface_skips_production_only_even_with_pass_streak
status: fixed
---

## Problem

`/deploy` Step 6 local smoke (`scripts/run-predeploy-local`) failed with
`RESULTS: 7/8 passed`. The only failure was
`agent-payment-production-abandonment` in 0s:

`agent-payment-production-abandonment is production-only; rerun with --prod`

Run `.context/predeploy-runs/20260912-211324-76991`. The task is tagged
`agentcard-lifecycle-production` and `"production_only": true`. It is a
Step 13c / `--prod` gate, not a local smoke task.

## Diagnosis

`_eligible()` already skips `local-only` tasks when `surface == "cloud"`.
It did not skip `production_only` when `surface == "local"`. Payment path
extras from `org-runtime.ts` therefore selected the production abandonment
task onto `--surface local`. `run_benchmark.py` correctly refused it
immediately.

Local repro: the new selector unit test fails on the pre-fix `_eligible`
(prod-payment is selected) and passes after the skip.

This is not a task-definition change. Production-only stays production-only.

## Solution

Treat `production_only` as ineligible on the local surface, matching the
existing cloud/`local-only` guard. Path extras and floor canaries then pick
local-eligible payment tasks instead.

At 10k agents this is selector-only: one fewer doomed 0s local slot, no
extra runtime fan-in.

## Human feedback

None recorded.

## Reusable lesson

Surface filters must be symmetric. If the runner refuses `production_only`
against a local backend, the predeploy selector must not emit those names
on `--surface local`.
