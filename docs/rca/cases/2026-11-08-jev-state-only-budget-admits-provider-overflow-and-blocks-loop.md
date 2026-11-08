---
id: 2026-11-08-jev-state-only-budget-admits-provider-overflow-and-blocks-loop
date: 2026-11-08
title: A long browser run's JEV estimates failed on every step (TypeSafe 400 max_tokens_exceeded, then our 24k ValueError) while each rebuild stalled the activity event loop
surface: agents
component: jev-progress
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/jev_progress.py request() checks the 24k-token budget on the state alone, excluding the ~2.5k-token questions, so prefixes whose body exceeds TypeSafe's limit (between 24,629 and 25,637 cl100k body tokens) are posted and refused with 400. _predict_jev_progress_impl then built every later, larger prefix again on the event-loop thread (json + tiktoken clip loop, 0.14-0.37 s per prediction), and JEVSession kept scheduling one per browser step.
symptoms:
  - "{\"error_type\": \"HTTPStatusError\", \"event\": \"jev_progress.failed\"}"
  - "{\"error_type\": \"ValueError\", \"event\": \"jev_progress.failed\"}"
  - "JEV prefix exceeds 24k token budget"
  - "TypeSafe POST https://api.typesafe.ai/v1/systemone -> 400 {\"detail\": {\"error_type\": \"max_tokens_exceeded\"}}"
  - "loop.lag max_lag_s grows with browser step count; browser.step.phases unattributed grows 78 ms -> 425 ms p50"
tags:
  - jev-progress
  - typesafe
  - browser-agent
  - event-loop-stall
  - observability
  - descend-h-76
sources:
  - agent e64f404c-ac44-477f-a8db-0dc6d1f7f8fe (task 2920ea99-5bc8-53cb-ba8b-5e6221059c36)
  - fleet run 20261108-054415-3146305 browser-doordash-food-plan-grocery-cart-reauth r2 job r002-j0006 (descend-failed-neverrun-20261106 epoch 24, source d49ef3c511)
  - commit d49ef3c511 (failing source; fix on branch rca/h-76-20261108)
repro: agents/tests/blackbox/jev_progress.blackbox.py::test_prefix_build_runs_off_event_loop; ::test_http_failure_logs_status_and_stage; ::test_budget_exceeded_stops_session; ::test_provider_size_refusal_stops_session; ::test_transient_failures_do_not_stop_session
status: mitigated
---

## Problem

Epoch 24 copy r2 of `browser-doordash-food-plan-grocery-cart-reauth` (agent e64f404c) logged 84
`jev_progress.failed` warnings from its browser activity (span 54f487721651). The first 18 were
`HTTPStatusError` (06:23:20–06:26:20Z, browser steps 130–141) and the remaining 66 were `ValueError`
(from 06:26:34Z, step 142, until the end). The warning carried no HTTP status. The task timed out at
2704 s with about 43 of 46 cart lines done.

None of the other 11 e24 copies logged JEV warnings, because success is silent. Their backends
show successful `PATCH /api/agents/<id>/progress-estimate` 200s in the same window: build-boxing-payment
129, anti-bot copies 5 and 14. So the TypeSafe key and the provider were healthy. This copy's backend
also shows only 200s. The publishes between failures came from the root agent's own small-prefix session
(the browser runs in the background). This is the only e24 browser activity that ran past ~130 steps
(188 steps, 279 LLM calls).

## Diagnosis

1. Trigger: the browser loop calls `jev_session.schedule(...)` at the top of every step
   (`domains/spawn_browser_agent_v3/handler.py`). The prefix is the full own-call action history and only
   grows. Once its JSON reaches 20,000 bytes, `request()` re-clips the history at 1200/600/300/150/80
   characters and re-tokenizes with tiktoken until the state is under 20,000 tokens. It raises at 24,000
   state tokens.
2. Size, reproduced through the real `browser_prefix_events` + `request()` with a synthetic DoorDash-shaped
   history (every string longer than the 80-character clip). State tokens at the 80-character clip were
   22,137 at 130 steps, 23,145 at 136 and 23,815 at 140, and `JEV prefix exceeds 24k token budget` began
   at 143. This matches the run's step windows (HTTP errors from step 130, ValueError from step 142).
3. Provider status (live probe under `/var/tmp/descend-llm-replay.lock`, recorded in
   `/var/tmp/rca-H-76-evidence/probe-live.jsonl`):
   - Body tokens 19,595, 20,505, 21,957 and 24,629 (state ≤22,137): **200**, and the response decoded.
   - Body tokens 25,637 and 26,307 (state 23,145 and 23,815): **400 Bad Request
     `{"detail": {"error_type": "max_tokens_exceeded"}}`**.

   Our check counts the state only, but the provider limits the whole body, which also holds ~2.5k tokens
   of questions. Everything between the provider limit and our 24k state budget was therefore posted and
   refused. That is our request contract, not a provider outage or credential problem.
4. Loop cost: `_predict_jev_progress_impl` ran `request()` synchronously inside the asyncio task, on the
   browser activity's event-loop thread. Measured locally on d49ef3c511 (1 prediction, mocked HTTP), the
   maximum event-loop stall was 138.5 ms at 60 steps, 269.5 ms at 130 and 371.7 ms at 190. Build CPU
   summed over 188 steps is ~19.6 s per prediction-per-step; with ~1.45 predictions per step, about 28 s
   ran on the loop. About 13 s of that was spent on the doomed rebuilds after step 130. Guest evidence
   matches: `loop.lag` max_lag p50 rose from 0.25 s (05:55–06:05) to 0.46 s (06:33–06:41), and
   `browser.step.phases` unattributed time rose from 78 ms p50 (steps 1–40) to 425 ms (steps 160–188).
   This is a measurable drag of roughly 1% of the 2704 s budget. It is not shown to be the cause of the
   cart timeout.
5. Deepest owned cause: the JEV runtime contract never modelled the provider's whole-request limit or the
   fact that the own-call prefix grows monotonically. A deterministic refusal was retried on every step
   at increasing CPU cost on the agent's own loop, with no status in the log.

Archive searches: `jev_progress.failed HTTPStatusError typesafe systemone` returned no hits.
`background progress estimate request exceeds provider input limit long browser history token budget`
returned relatives only: SMS body limit, attachment budget and replay frame limit. The relative
2026-10-25 demo-replay CPU case removed JEV from DEMO replays only. This case is novel.

## Solution

`agents/helpers/jev_progress.py`, without changing the prompt, input format, clip levels, budget, bins,
decoding or concurrency:

- The prompt read and the `request()` build run in `asyncio.to_thread` (`_prepare`). With the fix, the
  local stall measurement fell from 138/270/372 ms to 5.6/4.5/2.9 ms.
- `jev_progress.failed` now logs `stage` (prepare/predict/decode/publish). For HTTP errors it also logs
  `status_code` and `response_class`. No body or credential is logged.
- The budget overflow raises `JEVBudgetExceeded`, a ValueError subclass. A predict-stage size refusal
  (413, or 400 with `detail.error_type == "max_tokens_exceeded"`) also stops the session. In both
  cases the prediction returns `{"stopSession": true}` and `JEVSession` stops scheduling, because the
  own-call history only grows. The result is one warning per long session instead of one per step.
- The stop is recorded in Temporal history for the rest of the `run_agent` call, so nothing else may
  stop a session. Other 400s, 401/403/404/408/409/425/429, 5xx, network errors and publish-stage
  errors all keep estimating. An adversarial review rejected the first version, which stopped on
  every non-408/429 4xx.

Regression: five tests in the `jev-progress` agents blackbox domain. The four behavior tests fail on
d49ef3c511; the fifth is a "does not stop" boundary test. All pass 5/5 consecutive runs on the fix.
The stall test warms tiktoken before measuring. The `workflow` and `run-agent` domains pass on the
first revision.

10k agents: per-agent CPU drops to zero after a session stops, and builds no longer block a shared
worker loop. The thread pool is bounded by the existing per-loop semaphore of 4.

Open, research-gated: long browser prefixes (above ~22.5k state tokens) still get no estimate. A deeper
clip, or older-event omission within the token budget, would change the model input, so it needs JEV
research approval. The exact provider limit is between 24,629 and 25,637 cl100k body tokens. The cloud
outcome on the original task is pending.

## Human feedback

The parent coordinator directed: keep the fix minimal and measurable, run the prefix build off the
event-loop thread with a regression for the stall, log status_code and response class, stop
re-attempting once the budget is deterministically exceeded, and do not change the JEV prompt or
format. Report a model-input-changing clip as an option only. Adversarial review of 55f3d1f439
(CHANGES_REQUIRED): stopping on every predict 4xx except 408/429 lets a transient 401/404 disable
JEV for a whole multi-day session through Temporal history. Stop only on the budget overflow, 413 or
400 max_tokens_exceeded, and add "does not stop" boundary tests.

## Reusable lesson

Check a provider input budget against the whole materialized request body, keep CPU-heavy request
construction off the agent's event loop, and stop rescheduling a growing prefix after its first
deterministic refusal.
