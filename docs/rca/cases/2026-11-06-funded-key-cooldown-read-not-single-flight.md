---
id: 2026-11-06-funded-key-cooldown-read-not-single-flight
date: 2026-11-06
title: Concurrent Rose calls skipped the in-flight funded-key cooldown read and hit an out-of-credits API key in bursts
surface: agents
component: rose-client
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/providers/rose/client.py _anthropic_api_key_on_cooldown / _gpt_api_key_on_cooldown set the recheck clock before awaiting the backend read, so every concurrent caller inside the 15 s window returned "not on cooldown" while that read was still pending
symptoms:
  - "rose.complete.anthropic_apikey.fall_through reason=RosePaymentRequiredError"
  - "rose.complete.openai_apikey.fall_through reason=RosePaymentRequiredError"
  - "active_route=anthropic_apikey on a funded key whose shared cooldown row was already set"
  - "concurrent LLM calls reach a dead ANTHROPIC_API_KEY / GPT_API_KEY in bursts; each failure costs 5-28 s under event-loop saturation"
tags:
  - rose-client
  - funded-api-key
  - cooldown
  - single-flight
  - concurrency
  - descend
sources:
  - benchmark run descend-failed-neverrun-20261106 cluster I-12 (batch 2 epoch 2)
  - task job-applications r1
repro: agents/tests/blackbox/rose.blackbox.py::test_funded_api_key_cooldown_read_is_single_flight
status: fixed
---

## Problem

In descend run `descend-failed-neverrun-20261106`, both funded API-key legs
(`openai_apikey` from `GPT_API_KEY`, `anthropic_apikey` from
`ANTHROPIC_API_KEY`) were out of account credits (an external blocker). The
shared backend cooldown row correctly reported them as cooled, and 156 calls
in job-applications r1 (batch 2, epoch 2) skipped the dead key. Another 53
concurrent calls still reached it. Under event-loop saturation each wasted
attempt cost 5-28 s before falling through.

## Diagnosis

1. `_anthropic_api_key_on_cooldown` and `_gpt_api_key_on_cooldown` keep a
   15 s in-memory cache. The first caller after the window expires sets
   `_last_check = now` and only then awaits
   `GET /api/integrations/compute-code/{anthropic,gpt}-key/cooldown`.
2. Every other caller during that await sees
   `now - _last_check < 15` and returns `False` ("not on cooldown"). That is
   the same answer as a completed clear read, but no answer has arrived yet.
3. Those callers proceed to the dead funded key. Each failure marks the
   in-memory cooldown, but every call already past the check still fails.
   The burst repeats on each 15 s window. Slower reads (event-loop saturation,
   or the prod backend shared by bench guests) widen the window. A read slower
   than 15 s also stored an answer that expired as soon as it arrived, because
   both clocks started when the read began.
4. Local repro (`test_funded_api_key_cooldown_read_is_single_flight`, mocked
   backend read held pending): on the unfixed code, 7 of 8 concurrent callers
   answered `False` while the backend was going to answer `onCooldown: true`
   (`AssertionError: /anthropic-key/cooldown backend=cooldown: 7 callers
   answered while the read was pending`). The GPT key showed the same result:
   `[True, False, False, False, False, False, False, False]`.

Deepest owned cause: a cache of shared remote state recorded "check started"
as if it were "answer known". It had no in-flight state, so it could not tell
concurrent callers to wait for the pending answer.

## Solution

`_FundedKeyCooldown` in `agents/providers/rose/client.py` now owns both
keys' caches (one instance per key, keeping the existing module functions).
At most one backend read runs per key. It is an owned task. Concurrent callers,
including the one that started it, await it through `asyncio.shield`, so one
caller's cancellation never cancels the shared read or its other waiters.
This mirrors `providers/demo_cache/client.py::_fetch_position_http`. The
existing 15 s TTL and fail-open semantics are unchanged: a read that raises or
returns a non-cooled answer means "not on cooldown". The funded key remains a
fallback during a backend blip, and the real key failure still marks the
cooldown. A mark made while a read is pending is honored by its waiters. Both
clocks now start when the answer is known, so a slow read cannot leave later
callers with an expired answer.

10k-agent behavior: state is bounded per process (two floats and at most one
task per key). Backend reads stay at most one per key per process per 15 s
window. Concurrent callers now wait for that read (at most the 5 s HTTP
timeout) instead of each spending a paid request and 5-28 s on a dead key.
No per-agent state, polling, or fan-in is added.

## Human feedback

None recorded.

## Reusable lesson

When a cache refreshes shared remote state asynchronously, track the in-flight read and make concurrent callers await it, never answer from a "check started" timestamp before the result lands.
