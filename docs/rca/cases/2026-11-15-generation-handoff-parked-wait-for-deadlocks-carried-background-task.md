---
id: 2026-11-15-generation-handoff-parked-wait-for-deadlocks-carried-background-task
date: 2026-11-15
title: A parked wait_for re-entered before carried background tasks were relaunched, so it waited forever on the new generation
surface: agents
component: agent-workflow-generation-handoff
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_workflow.py AgentWorkflow._run_agent_turns awaited _resume_pending_tools() (re-entering the parked wait_for) before _relaunch_background_tasks(), so the carried background browser spawn wait_for was waiting on never ran again
symptoms:
  - Resuming 1 tool call(s) parked by the previous generation
  - Parked wait_for
  - "[background] toolu_ carried across generation handoff"
  - agent stays ACTIVE and silent after a cooperative cutover
tags:
  - generation-handoff
  - cooperative-cutover
  - background-agents
  - wait-for
  - deadlock
sources:
  - agent 08aa04a2-7ed4-50d4-9c08-7764f72203e6
repro: agents/tests/blackbox/background_agents.blackbox.py::test_a_parked_wait_for_on_a_carried_background_browser_finishes_on_the_next_generation
status: fixed
---

## Problem

Prod root agent 08aa04a2 (iPhone setup) ran a background `spawn_agent(type=browser)`
(`toolu_01EgP7EN2pM1vngrYxWBYC1x`, browser task 14905be3) and then `wait_for` on it
(`toolu_01Bf9JVtgZTxgCUS1CzBGLVE`). A cooperative cutover moved it from
`navi-agent-tasks-pool-701ac3d5ae3d@f38b8b178a7e` to `...-5c33f46a4b8d@40e8aa1c8933`
at 02:54:05Z on 2026-11-15. On the new generation (worker 8d4537ce92e458) the last
workflow line was 02:54:06 "Resuming 1 tool call(s) parked by the previous generation".
After that there was no "Browser agent starting (v3)" and no "[background] relaunching",
only one "Fetched agent queue pointer" at 03:14:07 (wait_for's safety-slice re-check).
The agent stayed ACTIVE with no messages until the coordinator paused it at ~03:23Z,
and the phone lease expired 02:55:57Z.

## Diagnosis

ClickHouse `observability.fly_logs` (`raw LIKE '%08aa04a2%'`):

1. 02:53:58 old gen: "Parked wait_for (toolu_01Bf9…) for generation handoff". The
   foreground wait_for went into `_pending_tool_resumes`.
2. 02:54:05 old gen: "Parked background task toolu_01EgP…", "Browser task parked for
   generation handoff", "[background] toolu_01EgP… carried across generation handoff".
   The browser travelled as a background record with a `resume` hint, which
   `_relaunch_background_tasks` is supposed to restart.
3. 02:54:05.309 new gen picked the run up within 80 ms, so the live generation had
   pollers. The pointer was healthy, and the concurrent failed Fly deploys did not strand it.
4. `_run_agent_turns` awaited `_resume_pending_tools()` first. That re-entered wait_for,
   which blocks in `sleep_until_woken_or_generation_handoff` until the browser record
   finishes. `_relaunch_background_tasks()` ran only after that await returned, so the
   browser was never relaunched and the wait could only end at its deadline.

Why ladder: the agent was silent → wait_for never woke → its target never ran → the
relaunch is ordered after the parked-call re-entry → when background spawns gained
foreground waiters (wait_for on agents), the two resume paths were never ordered
relative to each other. Existing tests called `_relaunch_background_tasks()` by hand
before `_resume_pending_tools()`, so they never ran the production order.

Repro: the new blackbox test drives the real `_run_agent_turns` on a restored
continuation (a parked wait_for plus a carried background browser). On the old code it
times out with only `wait_for` executed. On the fix both run, the browser finishes and
notifies once, and wait_for returns.

## Solution

`_run_agent_turns` now relaunches carried background records before re-entering parked
foreground calls. `_background_spawns_enabled` still turns on only before `run_agent`,
so a re-entered foreground `spawn_agent` stays foreground. The first fix attempt also
moved that flag earlier, and `deploy_resume_e2e::cutover_resumes_browser_task_on_the_new_generation`
caught the foreground browser being re-routed to the background. If a re-entered tool
hands off again, the existing `generation_handoff` path settles the relaunched
in-flight tasks before `continue_as_new`, as it does mid-turn. 10k behavior: no new
reads, polling or fan-in. The change only reorders O(own background records) of
in-memory work that already ran once per phase.

## Human feedback

None recorded.

## Reusable lesson

When a continuation restores both background tasks and parked foreground calls that can
wait on them, start the background tasks before awaiting any parked call.
