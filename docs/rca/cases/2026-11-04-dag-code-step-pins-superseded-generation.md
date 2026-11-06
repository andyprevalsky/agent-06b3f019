---
id: 2026-11-04-dag-code-step-pins-superseded-generation
date: 2026-11-04
title: A code agent started from a DAG step finishes on the superseded worker generation, so a multi-day DAG code agent can hold the old worker bank through a deploy (unreproduced)
surface: agents
component: generation-handoff
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "candidate (causality unproven end to end): agents/domains/spawn_claude_code_agent/handler.py sets code_session['generation_yield'] = False when park_pending_tool returns False; agents/workflows/agent_workflow.py _park_pending_tool returns False while _tool_parking_enabled is off (DAG turns)"
symptoms:
  - "Parking is unavailable here (DAG turn or payload budget): finish on this generation instead of yielding every second."
  - "Old bank remains served until its queue is certified retired"
  - "PoolCapacityPending"
  - deploy cutover waits on an old worker bank while a DAG code agent runs
tags:
  - generation-handoff
  - cutover
  - code-agents
  - dag
  - multi-day
sources:
  - commit 4317820584 (investigation only; no fix)
repro: none-recorded
status: open
---

## Problem

Code review lead: a code agent started from a DAG step cannot be parked across a
generation handoff, so it reattaches on the superseded generation and runs
there to completion (`generation_yield=False`). If that code agent runs for
days, its worker queue stays served; scripts/worker_pool_cutover.py keeps the
old bank until `retire-agent-queue.ts --verify-retired` passes ("Old bank
remains served until its queue is certified retired" → PoolCapacityPending),
which would push a deploy into its job timeout.

## Diagnosis

Code evidence only. handler.py (drain branch): park_pending_tool → False in a
DAG turn → `code_session["generation_yield"] = False` → the activity finishes
on this generation. agent_workflow.py `_park_pending_tool` returns False when
`_tool_parking_enabled` is off, which is the case for DAG turns ("the DAG
treats any tool return as task completion"). The existing test
test_cc_manager_finishes_on_superseded_generation_when_parking_unavailable
asserts this pinning as intended behaviour. Not reproduced: no local cutover
was run with a long DAG code step, so the bank hold and the deploy timeout are
unobserved. Classification stays unresolved.

## Solution

None yet. Candidate: let a DAG step park its in-flight code tool like a
run_agent turn (carry the step's tool record across continue_as_new and resume
the step on the live generation), or run DAG code steps as background tasks,
whose records already travel in the continuation snapshot. Both change
cutover/terminal semantics in agent_workflow.py (approval-gated) and need a
local cutover repro first: start a DAG code step with a fake long CLI, flip the
live generation pointer, and assert the old queue can retire.

## Human feedback

None recorded.

## Reusable lesson

Any tool that cannot park across a handoff pins its generation for its whole lifetime; check that lifetime before calling the pin harmless.
