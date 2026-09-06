---
id: 2026-09-06-wait-for-live-fast-mode-skipped-inter-check-sleep
date: 2026-09-06
title: Live Fast Mode skipped wait_for wall-clock sleeps, burning max_checks before external state could change
surface: agents
component: wait-for-handler
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/wait_for/handler.py — inter-check / timestamp sleep skips gated on bare fast_mode_cache_enabled"
symptoms:
  - "fast cache on seems to ruin wait_for explores"
  - "Next check in 10 minutes"
  - "Condition not met after 18 checks"
  - "POST /api/fast-cache/get-many ... explore_agent:p:1"
  - fast_mode_cache_enabled=True wait_for check_interval_seconds=600
tags:
  - wait-for
  - fast-cache
  - fast-mode
  - explore
  - poll-interval
  - oai-demo
sources:
  - agent 515c4894-62b4-40ae-b463-222608fe9ee2
repro: agents/tests/blackbox/wait_for.blackbox.py::test_handler_condition_live_fast_mode_honors_check_interval_sleep
status: fixed
---

## Problem

Agent `515c4894-62b4-40ae-b463-222608fe9ee2` (Top Rent A Car amendment) called
`wait_for` with `check_interval_seconds=600` / `max_checks=18` while waiting for
an inbound email. With `fast_mode_cache_enabled=True`, checks 1→15 ran from
`20:34:39Z` to `20:36:16Z` (~6s apart) instead of every 10 minutes. The UI still
said "Next check in 10 minutes". The poll exhausted with
"Condition not met after 18 checks" before any reply could arrive.

Render logs showed Fast Mode explore position keys
`goalHash=8055e3d841d43210 explore_agent:p:1|p:2` written once, then
`get-many` replayed on every later check. Greps still executed live and only
found outbound mail; condition eval correctly returned not-yet-met. The ruin
was the missing wall-clock wait, not a false condition verdict.

## Diagnosis

Critical path:

`wait_for condition mode → skip sleep when fast_mode_cache_enabled → spawn
explore (LLM position-replayed) → live grep → evaluate_condition → next check
immediately → burn max_checks`

Why 1: inter-check `workflow.sleep(check_interval_seconds)` was skipped whenever
`fast_mode_cache_enabled` was true.

Why 2: that skip was written for OAi-demo Fast Mode *replay*, where recorded
condition evaluations do not need wall-clock polling — but the same flag is
true for live agents that only want LLM record/replay.

Why 3 (deepest owned): a demo-replay shortcut was bound to the generic live FM
flag instead of the OAi-demo allowlist already used elsewhere
(`is_oai_demo_mass_agent_task`). Sibling timestamp skips (past, >31d, sleep
until target) had the same bare-flag gate.

Position-keyed explore `p:1`/`p:2` replay is **orthogonal** for this incident:
tool greps still ran live and the judge matched mailbox evidence. It does not
explain the 600s→~6s cadence.

Archive searches (`wait_for explore fast cache`, `wait_for`, `fast cache`,
`wait_for skip sleep`, `position key ignore tool output`): relatives exist
(fast-cache transport, wait_for exploreTaskId, provider cache affinity) but
**no prior case** on live-FM skip-sleep — novel, not a recurrence.

## Solution

Introduce `skip_wait_wall_clock_for_fast_mode_replay()` =
`fast_mode_cache_enabled and is_oai_demo_mass_agent_task(workflow_instance)`.
Gate all wait_for wall-clock shortcuts through it:

- condition-mode inter-check sleep
- timestamp sleep until target
- past-timestamp FINISH bypass
- >31-day FINISH bypass

Live Fast Mode still sleeps / errors like non-FM. OAi-demo replay keeps the
instant path. Blackbox coverage:
`handler_cond_live_fm_honors_interval`,
`handler_cond_oai_demo_fm_skips_interval`,
`handler_ts_live_fm_sleeps_until_target`,
`handler_ts_live_fm_past_errors`,
`handler_ts_live_fm_far_future_errors`.

10k-agent behavior: per-agent Temporal sleeps only; no shared fan-in. Live FM
agents pay the intended wait interval instead of amplifying explore spawn rate.

## Human feedback

None recorded.

## Reusable lesson

Never gate wait_for wall-clock sleeps on bare Fast Mode — only allowlisted
demo/bench replay may skip waits that observe live external state.
