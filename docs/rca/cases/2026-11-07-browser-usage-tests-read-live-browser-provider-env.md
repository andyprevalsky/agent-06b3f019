---
id: 2026-11-07-browser-usage-tests-read-live-browser-provider-env
date: 2026-11-07
title: Two browser usage tests assert a Kernel/Steel label but read BROWSER_PROVIDER from the live agents/.env
surface: agents
component: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: test_build_usage_items_carries_browser_pool_model and test_build_usage_items_emits_one_row_per_actual_model call build_usage_items without pinning BROWSER_PROVIDER, which defaults to os.getenv("BROWSER_PROVIDER", "kernel")
symptoms:
  - "AssertionError: assert tool_usage[\"service\"][0][\"provider\"] in (\"Kernel Browser\", \"Steel.dev Browser\")"
  - "spawn-browser-agent-v3 FAIL (build_usage_items_carries_browser_pool_model, build_usage_items_emits_one_row_per_actual_model)"
  - agents-coverage-blackbox UNVERIFIED while agents/.env sets BROWSER_PROVIDER=tilion
tags:
  - browser-provider
  - tilion
  - blackbox
  - env-coupling
  - staged-deploy-cycle
sources:
  - PR #1721
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

Gate: NOT_INTRODUCED. In the PR #1721 staged cycle on head 89186966c, the
`agents-coverage-blackbox` gate failed with `spawn-browser-agent-v3 FAIL` and
two failing cases: `build_usage_items_carries_browser_pool_model` and
`build_usage_items_emits_one_row_per_actual_model`, both
`AssertionError` on `provider in ("Kernel Browser", "Steel.dev Browser")`. The
same gate had passed on the previous head one cycle earlier.

## Diagnosis

`build_usage_items` resolves its provider with
`(provider or os.getenv("BROWSER_PROVIDER", "kernel"))` and labels `tilion` as
"Tilion Browser" (`service.py`, since 2026-10-21). The workers copy the box's
`agents/.env`, and the managed project env now sets `BROWSER_PROVIDER=tilion`
(the prod default since 2026-10-28), while the worker copies taken before that
sync still said kernel. The sibling tests pin the provider with
`patch.dict(os.environ, {"BROWSER_PROVIDER": "kernel"})`; these two did not, so
they passed only when the box env happened to say kernel or steel.

Reproduction: with `BROWSER_PROVIDER=tilion` in the environment the unchanged
test fails with the same assertion; with the pin it passes.

## Solution

Both tests carry `@patch.dict(os.environ, {"BROWSER_PROVIDER": "kernel"})`,
matching their siblings. The assertions are unchanged. Sibling prevention: any
test of a provider-labelled row pins the provider it expects instead of reading
the ambient env. No runtime behavior changes; no per-agent cost.

## Human feedback

None recorded.

## Reusable lesson

A blackbox test that asserts a provider-specific label must pin `BROWSER_PROVIDER` itself, because the devbox's managed env changes the ambient value.
