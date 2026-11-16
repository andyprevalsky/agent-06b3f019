---
id: 2026-11-06-planner-memory-fixture-stale-compressor-version
date: 2026-11-06
title: planner-memory-blue-bottle-on planned without memory because its fixture row was compressed by cp-v3, not the current cp-v7
surface: harness
component: planner-memory-benchmark-fixtures
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/benchmarks/fixtures/memory/blue-bottle-ferry-pickup-v1.json rows[0].compressor_version (cp-v3) vs agents/providers/planner_memory/compressor.py COMPRESSOR_VERSION (cp-v7), rejected by retrieval.py select_hits
symptoms:
  - "Plan shape: no_tools: spawn_explore_agent present"
  - "planner_memory.compress_timeout"
  - "skipped_uncompressed: 1"
  - "injected_chars=0"
tags:
  - planner-memory
  - benchmark-fixture
  - planner-memory-blue-bottle-on
  - compressor-version
sources:
  - agent fdd82785-6e2c-49d4-a411-1a63a960b35d
  - fleet run 20261106-095029-2036429
  - commit e194087f63
repro: agents/tests/blackbox/planner_memory.blackbox.py::test_benchmark_memory_fixtures_are_cache_hits_at_the_current_compressor_version
status: fixed
---

## Problem

`planner-memory-blue-bottle-on` (memory ON arm) failed its plan-shape evaluator in
/descend batch 1 (cloud job r001-j0016, agent fdd82785):
`Plan shape: no_tools: spawn_explore_agent present in ['spawn_explore_agent', 'spawn_browser_agent', 'display']`.
Its OFF sibling `planner-memory-blue-bottle-off` passed in the same batch, and the
ledger had 2 prior ON attempts with 0 passes.

The guest loaded the fixture (`🧠 memory fixture blue-bottle-ferry-pickup-v1: 1 row(s) loaded`)
and retrieval found it (`candidates: 1`), but treated it as uncompressed:
`planner_memory.retrieved hits=[] compressed=0 skipped_uncompressed=1` after
`planner_memory.compress_timeout timeout_seconds=15.0`, then
`Planner memory retrieval: ... injected_chars=0`. The planner therefore planned
exactly like the OFF arm: explore first, then browser.

## Diagnosis

1. `select_hits` (agents/providers/planner_memory/retrieval.py) keeps a row's
   `critical_path` only when `compressor_version == COMPRESSOR_VERSION`; any other
   version is a stale cache that must be recompressed lazily.
2. The fixture row was written with `compressor_version: "cp-v3"` while
   `COMPRESSOR_VERSION = "cp-v7"`. Both arrived in the same squashed commit
   (e194087f63), so the fixture was stale from the day it landed. Its content was
   also incompatible: its entry point used the retired generic `spawn_agent` tool,
   which the cp-v7 parser rejects. The other checked-in fixture
   (`memory-scenarios-v1.json`, 31 rows) is cp-v7.
3. Because the row was stale, retrieval tried to recompress the archived bundle at
   plan time inside a 15 s budget. The compressor call (`call_site=memory_compressor`)
   ran with no leased compute token (`claude_auth_present: false, gpt_auth_present: false`),
   so it fell through exhausted API-key legs (OpenAI `RosePaymentRequiredError`,
   Anthropic 400) and timed out. With no hit, nothing was injected.

Local proof with `scripts/run-bench --local planner-memory-blue-bottle-on`: on the
stale fixture the run failed identically (`compress_timeout`, `hits=[]`,
`injected_chars=0`). On the rebuilt fixture retrieval injected the memory
(`hits=1, compress=0.0ms, injected_chars=3678`), but that single local planner
sample (served by `gpt-6.1-sol-foundry`) still planned an explore "route
verification" task, following the system prompt's MANDATORY invariant ("Plan
information retrieval and discovery in spawn_explore_agent before dependent
execution") over the memory's "no separate discovery task is needed for a route a
memory already shows". Seven exact replays of that dumped planner call
(`scripts/replicate_llm_dump.py --mode exact --assert forbid_tool:spawn_explore_agent`,
served by `openai/gpt-6.1-sol`) all passed both plan-shape checks, so this residual
is unreproduced and remains an open observability question, not a proven cause.

The deepest owned cause is the benchmark fixture contradicting its own contract:
"pre-compressed PlannerMemory rows ... so the memory-on arm retrieves exactly the
declared history" (run_benchmark._apply_memory_fixtures). The plan-time
recompression and its unauthenticated compressor call are a separate, real
condition (it also limits production recompression of stale rows), recorded
separately and not changed here.

## Solution

Rebuilt the fixture with the current compressor through the supported builder
(`agents/scripts/build_memory_fixture.py --name blue-bottle-ferry-pickup-v1
--bundle-id 1cba6647-b233-42f2-aafe-40fd6729494b`), same source bundle and
description. The rebuilt row is cp-v7 and enters through `spawn_browser_agent`
at `https://bluebottlecoffee.com/`.

Added `test_benchmark_memory_fixtures_are_cache_hits_at_the_current_compressor_version`
to the `planner_memory` agents blackbox domain: every row of every checked-in
memory fixture must be a retrieval cache hit at the current `COMPRESSOR_VERSION`.
It failed on the old fixture (`compressed by 'cp-v3', not 'cp-v7'`) and passes 5/5
on the rebuilt one; any future compressor bump now fails the deploy gate until the
fixtures are rebuilt. No task prompt, evaluator, timeout or retrieval rule changed.
10k-agent behavior: unchanged (fixture data and an offline test only).

## Human feedback

None recorded.

## Reusable lesson

When a cache key (here the compressor version) changes, every checked-in artifact
pre-built under the old key is silently a cache miss; pin artifact/key agreement with
a test instead of trusting the artifact's name.
