---
id: 2026-04-07-planner-tool-descriptions-missing-from-registry
date: 2026-04-07
title: Tools absent from PLANNING_TOOL_DESCRIPTIONS were invisible to the planner, which routed email tasks to the browser agent
surface: agents
component: set-plan
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/tools/set_plan.py — PLANNING_TOOL_DESCRIPTIONS omitted message_person, call_phone_number, and send_message_to_user_execute_phase
symptoms:
  - outreach-batch benchmark stuck at 9/40 approval requests
  - planner assigns spawn_browser_agent for ~50% of email tasks
  - planner never selects message_person for an outreach step
tags:
  - planner
  - tool-descriptions
  - benchmark
  - outreach
  - prompt-contract
sources:
  - PR #319
repro: none-recorded
status: fixed
---

## Problem

The `outreach-batch` benchmark (rows 71–110, 40 rows) plateaued at 9/40 approval
requests. Inspecting the plans showed roughly half of the email tasks assigned
to `spawn_browser_agent` — i.e. the planner tried to send emails by driving a
browser rather than using the messaging tool.

## Diagnosis

`PLANNING_TOOL_DESCRIPTIONS` in `set_plan.py` is the planner LLM's entire view
of the available tools. `message_person`, `call_phone_number`, and
`send_message_to_user_execute_phase` existed as runtime tools but had no entry
in that registry, so the planner literally did not know `message_person`
existed and picked the closest thing it could see. The deepest cause is a split
source of truth: the executable tool set and the planner-visible tool set were
maintained separately, so adding a tool did not make it plannable. This is a
harness-contract inconsistency, not a model failure — the model chose correctly
given the tools it was shown.

## Solution

Added the three missing descriptions to `PLANNING_TOOL_DESCRIPTIONS` and added
explicit anti-email guidance to the `spawn_browser_agent` description ("Do NOT
use for sending emails — use message_person instead") so the negative case is
also stated. Any tool added to the execute phase must be registered in the
planning descriptions at the same time, or it is unreachable from a plan.

## Human feedback

None recorded.

## Reusable lesson

When the planner picks an obviously wrong tool, check whether the right tool has
a description in the planner-visible registry before suspecting model quality.
