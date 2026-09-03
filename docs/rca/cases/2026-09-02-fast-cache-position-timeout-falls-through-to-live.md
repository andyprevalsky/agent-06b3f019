---
id: 2026-09-02-fast-cache-position-timeout-falls-through-to-live
date: 2026-09-02
title: Fast Mode get-position ReadTimeout fell through to live LLM on mass-agent T5
surface: agents
component: fast-cache get-position / RoseClient.complete
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "agents/providers/rose/client.py Fast Mode read path — lookup_failed skipped passthroughs then called _complete_impl; get-position had no retry"
symptoms:
  - test-mass-agent-run-0 T5 fail: cost_cents 41, cache_creation_input_tokens 372000, live_output_tokens 48406
  - 99.8% cache hit (4648 fast-cache vs 77 live claudeAuth/waterfall)
  - 379 fast_cache.get_position_error with empty error (httpx.ReadTimeout)
  - passing sibling run fa1980b8 the same day was 100% cache / $0 / 0 get_position_error
tags:
  - fast-cache
  - mass-agent
  - t5
  - fan-out
  - timeout
sources:
  - agent 14eda9c6-8fbf-4e74-af14-2195bcdce3cc
  - PR #1209
repro: agents/tests/fast_cache/test_fast_cache.py::test_get_error_on_allowlisted_bench_does_not_go_live
status: fixed
---

## Problem

Deploy smoke `test-mass-agent-run-0` completed in 445.8s but failed T5
(`t5-zero-live-spend`). Usage: $0.41, 372k cache-creation tokens, 48406 live
output tokens, 99.8% hit. Tree was 51 agents / 4725 LLM calls. The same branch
had already passed T5 earlier the same day (`fa1980b8`, 100% hit, $0).

The 420s/600s caps were not the failure. The agent finished. Live spend did.

## Diagnosis

Local isolated-stack worker logs (`.context/benchmarks/1788379165-1325735-66001`):

- 0 `get_failed` (the 2026-07-07 GET-500 path held)
- ~379 `fast_cache.get_position_error` with `error=""` at 20:01:08–13 (50-way fan-out)
- `Future exception was never retrieved ... ReadTimeout('')`
- Live models: 19× claude-sonnet-5-claude, 9× claude-fable-5-claude, 6× gemini-3.6-flash, 3× gpt-5.6-sol
- Follow-on `web_search_miss_live` / `web_fetch_miss_live` with
  `soft_complete_not_allowlisted` after the trajectory forked

The passing run's logs had **zero** get-position errors and **only**
`Rose model selected: fast-cache`.

Critical path:

`50-way GP fan-out → /api/fast-cache/get-position ReadTimeout → raise →
RoseClient.complete sets lookup_failed → skips passthroughs → _complete_impl live`

Two owned gaps vs the 2026-07-07 lesson ("never collapse a transport fault into
a miss"):

1. `cache_get_record` retries GET 3×; `_fetch_position_http` raised on the first
   timeout and logged `str(ReadTimeout())` which is empty.
2. `lookup_failed=True` only skipped synthetic passthroughs. The function then
   always fell through to live LLM. Browser-use already refused live on lookup
   error for allowlisted benches; Rose LLM did not.

The wait-normally / FCaptcha loop-breaker changes do not appear on this path
(no FCaptcha markers; prefix already cached on `fa1980b8`).

## Solution

- Retry get-position on timeout/5xx with the same 3× backoff as GET. Log
  `Type: message` so empty `ReadTimeout()` is visible.
- Shared `lookup_llm_cache()` retries the exact-key + July position walk.
- Allowlisted Fast Mode (`soft_complete_allowed`, mass-agent) re-raises
  `FastCacheLookupError` instead of calling live LLM. Non-allowlisted reads
  still degrade to live (#16).

## Human feedback

Do not raise the 600s mass-agent timeout or the T5 zeros. A sequential
mass-agent-only rerun does not satisfy the Group 4 gate — full predeploy
smoke must pass in one invocation.

## Reusable lesson

A `lookup_failed` flag that only disables stubs still bills the user if the
next line is the live provider. Transport faults need retries at the HTTP
boundary **and** a hard no-live on allowlisted Fast Mode reads.
