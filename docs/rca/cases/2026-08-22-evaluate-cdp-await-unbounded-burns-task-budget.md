---
id: 2026-08-22-evaluate-cdp-await-unbounded-burns-task-budget
date: 2026-08-22
title: Unbounded Runtime.evaluate await burns 330s before hard recover, starving payment
surface: agents
component: spawn-browser-agent-v3-evaluate-cdp
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_actions.py::_execute_inspection_action evaluate — bare await Runtime.evaluate with no inner asyncio.wait_for
symptoms:
  - "Browser action 'evaluate' timed out after 330s; hard renderer recovery ran after CDP classified renderer_main_thread_blocked."
  - "action_timeout_evaluate_330s"
  - "Timeout after 900s (dynamic cap=900s)"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
  - "Hard recovery after renderer-frozen action timeout"
tags:
  - evaluate
  - cdp
  - runtime-evaluate
  - konva
  - signature
  - alchemy
  - momence
  - hard-recover
  - budget
sources:
  - agent 9fb21e4f-6693-472b-b625-e59597569c11
  - fleet run 20260822_041522_browser-alchemy-springs-sauna
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_execute_action_evaluate_honors_llm_timeout
status: fixed
---

## Problem

Alchemy k=5 fail `9fb21e4f-6693-472b-b625-e59597569c11` reached Momence guest
checkout / waiver, called `evaluate` to draw a Konva signature via MouseEvents,
and hung until the **full** 330s outer `BROWSER_SUPERVISOR_ACTION_TIMEOUT`. CDP
classified `renderer_main_thread_blocked` and hard recover recycled the page
(`recycled=true` at 04:14:02), but only ~60s of the 900s task budget remained —
insufficient to re-fill the wiped form and reach `payment_approval`.

FE: https://roselabs.ai/?agent-id=9fb21e4f-6693-472b-b625-e59597569c11

Same k=5 cohort: 2 agents hard-recovered evaluate freezes and still paid
(eef77f64, 40e02fb4) because they reached waiver earlier; 2 never froze
(f968f2bf, b47fa3be). Fail agent also landed on
`Monday-Night-Sauna-Garden/136816016` (wrong vs Sunday Morning) which burned
steps before the freeze — contributing, not the first-bad for the 330s burn.

## Diagnosis

Archive: relative/recurrence of
`2026-08-21-evaluate-timeout-poisons-js-thread-blocks-recovery` — that fix made
hard recover run on frozen evaluate (confirmed here). Outcome still fails when
the freeze is late because classify+hard recover only run **after** the outer
330s `wait_for(execute_action)`.

Critical path:

1. Waiver → `evaluate` with canvas MouseEvents (code_sha `5119bb53ba6a`).
2. Page-target `Runtime.evaluate` never returns (renderer frozen).
3. `_execute_inspection_action` awaits CDP with **no inner timeout**.
4. Outer supervisor waits full 330s, then classify + hard recover (works).
5. `goto_resume_url` reloads empty form; ~60s left → timeout, no payment.

Owning-boundary blackbox: hanging CDP evaluate under
`test_execute_action_evaluate_honors_llm_timeout` /
`test_execute_action_evaluate_default_timeout_bounds_hang`.

## Solution

LLM-settable `timeout` on `EvaluateTool` (seconds, max 60). Default **15s** when
omitted. `service_actions` wraps `Runtime.evaluate` in `asyncio.wait_for` with
`normalize_evaluate_timeout_seconds` (clamps >60 at runtime; schema `le=60`
rejects invalid model output). On timeout, re-raise `TimeoutError` from both
`_execute_inspection_action` and `execute_action` (which otherwise swallows
exceptions as soft errors) so the outer classify + hard-recover path runs
immediately — without burning the full 330s action budget. Do **not** raise the
330s action or 900s task caps.

10k-agent: O(1) timer per evaluate; no new fan-in.

## Human feedback

Approved with edit: make the bound an LLM-settable timeout, max 60s
(`rca-evaluate-cdp-inner-timeout-20260822`).

## Reusable lesson

Hard recover after a frozen evaluate is not enough if `Runtime.evaluate` itself
is unbounded — bound the CDP await (LLM-tunable, hard-capped) so
classify+recycle can run before the task budget is gone.
