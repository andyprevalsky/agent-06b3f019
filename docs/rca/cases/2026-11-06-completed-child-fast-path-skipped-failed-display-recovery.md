---
id: 2026-11-06-completed-child-fast-path-skipped-failed-display-recovery
date: 2026-11-06
title: The completed-child fast path finished the parent after its planned display had failed, so the agent never retried with the PNG it already had
surface: agents
component: completed-child-structured-handoff
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py _completed_child_task_structured_handoff — returned a schema-covering child result even though a newer action (the planned display) had failed after it
symptoms:
  - "run_agent.completed_child_forces_completion"
  - "Progress satisfied by completed child task structured response"
  - "is not a displayable file"
  - "SVG excluded"
  - "Agent Display showed 0 item(s)"
tags:
  - completed-child-handoff
  - display
  - recovery
  - agent-display-revenue-chart
sources:
  - agent 38a8d172-1054-4c5a-b5ef-ebbce0b8caf4
  - agent df5c1696-5667-4d0c-be06-49e74f4849db
  - benchmark run descend-failed-neverrun-20261106 epoch 4 r002-j0028
repro: agents/tests/blackbox/run_agent.blackbox.py::test_completed_child_handoff_yields_to_later_failed_action
status: mitigated
---

## Problem

`agent-display-revenue-chart` (descend epoch 4, copy r002-j0028, agent
38a8d172) finished COMPLETED with Agent Display showing nothing, failing
`display-shown`: "Agent Display showed 0 item(s) of kinds ['bundle', 'image',
'page']". Copy r001-j0008 (agent df5c1696) of the same task passed.

The failing trajectory:

1. The code-agent goal writer asked for a chart "preferably SVG with a PNG
   companion". Claude Code produced both and returned `revenue_chart` /
   `display_path` = the SVG, with the PNG named in its verification text.
2. The planned display task passed the SVG. The backend rejected it: "Invalid
   media: completed-revenue-2026-09-21_to_23.svg: is not a displayable file
   (... SVG excluded)" (displayService.ts TYPES_HELP).
3. The DAG logged "Task 2 failed — falling through to run_agent for recovery".
4. run_agent immediately logged `run_agent.completed_child_forces_completion`
   and `run_agent.completed_child_dispatches_completion`, synthesized
   attempt_completion without an LLM call, and the verifier logged "Progress
   satisfied by completed child task structured response" (score 100%).

The root model never saw the display failure, so it never retried with the PNG
that already existed. The passing copy differed only in the planner asking for
a PNG directly, so display succeeded.

Production shows the same display rejection: 4 "SVG excluded" display errors
across 2 agents in the 30 days to 2026-11-06, against 60 successful displays.

## Diagnosis

- Symptom boundary: the evaluator saw 0 displayed items.
- One rung up: the planned display failed with a truthful, recoverable error
  (the PNG companion was available).
- First-bad boundary: `_completed_child_task_structured_handoff` scans the
  context newest-first and returns the first finished code/browser child whose
  structured response covers the parent response schema. It ignored that a
  newer action had failed after that child. The parent schema
  (`revenue_chart`, `daily_totals`) was satisfied by the child, but the goal
  also required a later side effect (the display), which is not a schema field.
  Both the run_agent fast path (forced attempt_completion) and the verifier's
  deterministic accept use this predicate, so neither gave the model a turn.

Local repro: the new run_agent blackbox case builds the same context (completed
code child, then a display TOOL message with toolStatus ERROR). On 8d8d6a316d
it synthesizes attempt_completion with no LLM call ("expected an LLM recovery
turn, got synthesized actions [attempt_completion]").

## Solution

`_completed_child_task_structured_handoff` returns None when it meets a TOOL
message with toolStatus ERROR or FAILED before finding a qualifying child,
meaning the failure is newer than every completed child. The parent model then
gets its normal turn with the truthful failure in context (and the normal LLM
verifier runs), as in Claude Code (query.ts tool_use → needsFollowUp with the
is_error tool_result), Codex (tools/parallel.rs FunctionCallOutput success:false
returned to the model) and Hermes (model_tools.py tool_error returned to the
model). A child that completes after the failure still fast-paths.

The SVG rejection itself is a deliberate backend policy and is unchanged; the
display tool description does not list the excluded types, which remains a
follow-up for prompt review.

10k agents: one extra field read per message in an existing linear scan of the
agent's own context; no new I/O, state or fan-in.

## Human feedback

None recorded.

## Reusable lesson

A deterministic "child already finished the work" shortcut must stand down as
soon as any newer action has failed; let the model see truthful failures and
recover.
