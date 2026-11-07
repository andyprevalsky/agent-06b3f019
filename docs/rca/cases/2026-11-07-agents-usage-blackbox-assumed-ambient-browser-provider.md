---
id: 2026-11-07-agents-usage-blackbox-assumed-ambient-browser-provider
date: 2026-11-07
title: Two browser usage blackbox tests asserted a Kernel or Steel provider without pinning BROWSER_PROVIDER
surface: agents
component: spawn-browser-agent-v3-usage
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_build_usage_items_carries_browser_pool_model and test_build_usage_items_emits_one_row_per_actual_model called build_usage_items with the ambient BROWSER_PROVIDER, which build_usage_items reads from os.environ
symptoms:
  - "❌ build_usage_items_carries_browser_pool_model: AssertionError"
  - "❌ build_usage_items_emits_one_row_per_actual_model: AssertionError"
  - "assert tool_usage[\"service\"][0][\"provider\"] in (\"Kernel Browser\", \"Steel.dev Browser\")"
  - "Agents blackbox: 123 passed, 1 failed, 124 total"
tags:
  - agents
  - blackbox
  - browser-provider
  - tilion
  - environment
sources:
  - PR #1723 staged deploy sweep 3, agents-coverage-blackbox, source 0d7de94dcece9ffd58482e9e7bc8ceddba89e2ea
  - task .context/deploy-pipeline/attempts/2/initial/agents-coverage-blackbox/output.log
  - commit 1a7d768083 (2026-07-27, wrote both assertions)
repro: python3 -B agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

Gate: NOT_INTRODUCED. `agents-coverage-blackbox` ran 124 agents blackbox domains in sweep 3 of the PR #1723 deploy and
123 passed. `spawn-browser-agent-v3` failed on two usage tests with a bare `AssertionError` at
`assert tool_usage["service"][0]["provider"] in ("Kernel Browser", "Steel.dev Browser")` (and the same assertion on
`service_rows[0]`). The PR changes nothing under `agents/`.

## Diagnosis

`build_usage_items` picks the service provider with `os.getenv("BROWSER_PROVIDER", "kernel")` and maps it to a
display name: `kernel` to `Kernel Browser`, `steel` to `Steel.dev Browser`, `browser-use` to `Browser Use Browser`,
`tilion` to `Tilion Browser`. Neighbouring tests in the same file (17 `patch.dict` pins) wrap the call in
`patch.dict(os.environ, {"BROWSER_PROVIDER": ...})`; these two did not, since July 2026, when Kernel and Steel were the only options. The devbox `agents/.env` now carries
`BROWSER_PROVIDER=tilion` (the production default since 2026-10-28), the worker copy inherited it, and the result was
`Tilion Browser`. The earlier sweep's agents gate started at 23:24:26, before the env file was rewritten at 23:26:16, and passed.

Local repro (scratch clone at 0d7de94dc, calling the two test functions directly): with `BROWSER_PROVIDER=tilion` both
fail with `AssertionError`; with `BROWSER_PROVIDER=kernel` both pass. The unchanged assertions pass after the fix
under `tilion`, `steel`, `browser-use` and `kernel` (the env is pinned inside the test).

Archive search for `Kernel Browser Steel.dev Browser provider assertion tilion` found no earlier case: novel, though
the class (a test reading ambient environment) is the one the CLAUDE.md note about injected env vars describes.

## Solution

Both tests now call `build_usage_items` inside `patch.dict(os.environ, {"BROWSER_PROVIDER": "kernel"})`, like their
neighbours. The assertions are unchanged. They run in the `agents-coverage-blackbox` deploy gate
(`spawn-browser-agent-v3` domain). Tilion's own display name stays covered by `browser_tilion.blackbox.py`.

10k agents: test-only change; nothing at runtime moves.

## Human feedback

None recorded.

## Reusable lesson

A blackbox test that asserts on a value derived from `os.environ` must pin that variable with `patch.dict`, because the
devbox and production environments change underneath it.
