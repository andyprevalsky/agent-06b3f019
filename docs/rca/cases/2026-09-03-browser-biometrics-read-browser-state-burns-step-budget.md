---
id: 2026-09-03-browser-biometrics-read-browser-state-burns-step-budget
date: 2026-09-03
title: read_browser_state burned MAX_ITERATIONS so webdecoy hit max steps on Submit
surface: agents
component: spawn-browser-agent-v3 / step budget
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/handler.py action loop — increments MAX_ITERATIONS for read_browser_state after d5b79a331 removed free per-turn DOM injection"
symptoms:
  - pre-deploy smoke browser-biometrics-webdecoy PAUSED at ~423s / cap 420s
  - agent b4b36b53: 16× read_browser_state, Submit as last action, Task Incomplete - Max Steps Reached
  - parent respawned a second browser agent; harness timeout
tags:
  - browser
  - smoke
  - biometrics
  - step-budget
  - read_browser_state
sources:
  - agent b4b36b53-d6ed-4574-a141-38687c6fab37
  - fix agent 3d4a0f56-0c17-4c83-82b3-1cf9779c2f80
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_read_browser_state_does_not_consume_step_budget
status: fixed
---

## Problem

Pre-deploy smoke `browser-biometrics-webdecoy` timed out (~423s / cap 420s) with
agent `b4b36b53` PAUSED. The browser sub-agent called `read_browser_state` 16
times, scrolled extensively, eventually clicked the checkbox, filled the form,
and clicked Submit — then immediately returned **Task Incomplete - Max Steps
Reached** (60). The parent spawned a second browser agent; the harness paused
the tree before a score was reported.

## Diagnosis

`d5b79a331` replaced free per-turn DOM injection with an explicit
`read_browser_state` tool. The main loop still did `iteration += 1` for every
tool, including observation-only reads. That burns the action budget on
state that the loop already prefetches for auth/URL (`observe_page_state`).

Owning-boundary: `adjust_iteration_after_action` refunds the step for
`read_browser_state` (capped consecutive so a stuck model still terminates).
Without the refund, 16 observation turns leave too few action turns to wait
after Submit and call `attempt_completion`.

## Solution

Refund `read_browser_state` against `MAX_ITERATIONS` via
`adjust_iteration_after_action` in the live browser loop. Cap consecutive
observation refunds at 5. Cement blackbox tests for refund, consecutive cap,
and click reset.

Local proof on fixed revision: `scripts/run-bench --local browser-biometrics-webdecoy`
→ PASSED in 204s, agent `3d4a0f56-0c17-4c83-82b3-1cf9779c2f80`.

## Reusable lesson

When an observation tool replaces free per-turn context injection, it must not
consume the same action budget as clicks/typing, or agents systematically hit
max steps on the first late-stage irreversible action (Submit).
