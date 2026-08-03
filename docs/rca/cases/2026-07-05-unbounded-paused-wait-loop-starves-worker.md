---
id: 2026-07-05-unbounded-paused-wait-loop-starves-worker
date: 2026-07-05
title: The paused branch of the agent loop had no floor, so ~90 orphaned sub-agents busy-spun and starved both prod workers
surface: agents
component: agent-loop
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/loop/run_agent.py — the top-of-loop paused branch hot-`continue`d with no sleep floor and no escape, so `iteration` never advanced
symptoms:
  - every newly created agent hangs in STARTING_UP indefinitely
  - '"Agent paused, waiting..." logged ~30–100 times per second'
  - navi-agent-tasks Temporal queue saturated across both Fly workers
tags:
  - temporal
  - busy-loop
  - paused-agent
  - worker-starvation
  - parent-close-policy
sources:
  - PR #711
  - memory:project_pause_loop_livelock_prod_starvation
repro: agents/tests/blackbox/run_agent.blackbox.py
status: fixed
---

## Problem

On 2026-07-05 production agent creation stopped working: every new agent sat in
`STARTING_UP` forever. Both Fly workers were saturated, logging
`"Agent paused, waiting..."` roughly 30–100 times per second. Two user-paused
root agents had been terminated in Temporal with `parentClosePolicy=ABANDON`,
leaving about 90 orphaned sub-agent workflows alive.

## Diagnosis

Each orphaned sub-agent re-entered the top-of-loop paused branch in
`run_agent.py`, which `continue`d immediately — no sleep floor, no iteration
increment, no escape condition. With ~90 workflows hot-spinning, the
`navi-agent-tasks` queue had no capacity left for real work, so newly created
agents never got scheduled and hung in `STARTING_UP`. Two owned causes compound
here: (1) a wait implemented as a spin rather than a bounded sleep or a
`wait_condition`, and (2) `parentClosePolicy=ABANDON` orphaning children whose
parent is gone, so nothing would ever unpause them. The pause itself was not the
bug — the pause branch's ability to consume unbounded CPU was.

## Solution

`agents/loop/run_agent.py` now enforces a hard floor between paused iterations
(`PAUSED_WAIT_FLOOR_SECONDS`) so the loop can never busy-spin, rate-limits the
pause log, and after `MAX_CONSECUTIVE_PAUSED_ITERATIONS` returns `"paused"` to
hand off to the workflow's zero-CPU cold pause handler
(`wait_condition(not is_paused)` plus `continue_as_new` on resume). User-paused
roots still resume correctly. The regression test
`test_paused_agent_does_not_busy_spin_and_yields_to_cold_handler` drives an
orphaned paused agent whose `wait_for_messages()` returns instantly: pre-fix it
loops forever (bounded only by an `asyncio.wait_for` timeout), post-fix it
returns `"paused"` after a bounded number of iterations and never calls the LLM.
At 10k agents this is the difference between idle agents costing zero CPU and a
single stuck cohort denying service to everyone else.

## Human feedback

None recorded.

## Reusable lesson

Any wait branch inside an agent loop needs a sleep floor and a bounded escape to
a zero-CPU handler — an unbounded `continue` turns one stuck cohort into a
platform-wide outage.
