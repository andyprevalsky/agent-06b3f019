---
id: 2026-11-07-usage-test-inherited-ambient-browser-provider
date: 2026-11-07
title: Browser usage-row tests inherited the ambient BROWSER_PROVIDER=tilion while asserting a Kernel/Steel service row
surface: agents
component: spawn-browser-agent-v3-usage-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_build_usage_items_carries_browser_pool_model and test_build_usage_items_emits_one_row_per_actual_model called build_usage_items without a provider, so the service row followed os.getenv("BROWSER_PROVIDER")
symptoms:
  - "assert tool_usage[\"service\"][0][\"provider\"] in (\"Kernel Browser\", \"Steel.dev Browser\")"
  - "assert service_rows[0][\"provider\"] in (\"Kernel Browser\", \"Steel.dev Browser\")"
  - "❌ build_usage_items_carries_browser_pool_model: AssertionError"
  - "❌ build_usage_items_emits_one_row_per_actual_model: AssertionError"
tags:
  - browser-provider
  - tilion
  - kernel
  - fixture-environment
  - ambient-env
  - agents-coverage
sources:
  - task /deploy PR #1745 staged cycle agents-coverage-blackbox gate on a305adcf71fd04407ee90840b21f41efa4b12cb6
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_build_usage_items_carries_browser_pool_model / test_build_usage_items_emits_one_row_per_actual_model under BROWSER_PROVIDER=tilion
status: fixed
---

## Problem

During the PR #1745 `/deploy` staged cycle (2026-11-07), the agents coverage
gate failed one domain: `spawn-browser-agent-v3` with
`❌ build_usage_items_carries_browser_pool_model: AssertionError` and
`❌ build_usage_items_emits_one_row_per_actual_model: AssertionError`
(123/124 domains passed). The PR changed no `agents/` file; `agents/` was
byte-identical to `origin/main`.

## Diagnosis

`build_usage_items(..., provider=None)` picks the service row from
`provider or os.getenv("BROWSER_PROVIDER", "kernel")`. The two tests did not
pass a provider and asserted the row is Kernel or Steel. This devbox's managed
`agents/.env` now sets `BROWSER_PROVIDER=tilion` (Tilion is the production
default since 2026-10-28), which the coverage runner loads, so the row read
`Tilion Browser`.

Local repro on `git archive origin/main agents` with the agents env loaded:
`BROWSER_PROVIDER=tilion` → both cases FAIL at the provider assertion;
`BROWSER_PROVIDER=kernel` → both PASS. Gate: NOT_INTRODUCED (failure depends
only on ambient configuration).

Why possible: the tests consumed process configuration that the unit under
test documents as an override, instead of fixing their input. Same class as
`2026-10-28-provider-capacity-inprocess-fixture-inherited-browser-selection`
(a different fixture that inherited the ambient Tilion selection).

Golden reference: not applicable (no approval-gated hunk).

## Solution

Both tests pass `provider="kernel"` explicitly; every assertion is unchanged.
After the change both cases PASS under `BROWSER_PROVIDER=tilion` and
`BROWSER_PROVIDER=kernel` (same repro script). The regression is the existing
pair of tests, which run in the agents blackbox suite on every `/deploy`.

## Human feedback

None recorded.

## Reusable lesson

A test that asserts a provider-specific value must pin the provider as an input, never inherit BROWSER_PROVIDER (or any deployment default) from the ambient environment.
