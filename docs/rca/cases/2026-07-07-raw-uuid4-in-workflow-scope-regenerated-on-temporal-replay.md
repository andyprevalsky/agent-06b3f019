---
id: 2026-07-07-raw-uuid4-in-workflow-scope-regenerated-on-temporal-replay
date: 2026-07-07
title: A raw `uuid.uuid4()` in workflow-scope DAG code regenerated on Temporal replay, splitting one for_each fan-out into two
surface: agents
component: temporal-worker
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/loop/dag_executor.py:659 — tool_call_id minted with str(uuid.uuid4()) inside workflow-scope code awaited directly from AgentWorkflow.run
symptoms:
  - for_each appears to fan out twice (~100 then ~121 sub-agents) and then stall
  - the first fan-out tool bubble spins forever with no matching FINISHED event
  - two for_each toolCallIds pointing at the same 50 subAgentIds (overlap 50, 0 new)
tags:
  - temporal
  - determinism
  - for-each
  - dag-executor
  - uuid
sources:
  - agent 8874e0cf
  - memory:project_dag_foreach_split_fanout_nondeterminism
repro: agents/tests/blackbox/workflow_determinism.blackbox.py
status: fixed
---

## Problem

Prod agent `8874e0cf` (2026-07-07, a "top 50 creators" `for_each` plan) appeared to
fan out **twice** — roughly 100 then 121 sub-agents — and then stall with the first
fan-out spinning forever. It was actually **one** task-2 `for_each`, rendered as two
because it was split across a Temporal workflow replay.

## Diagnosis

`agents/loop/dag_executor.py:659` minted the fan-out's `tool_call_id` with a raw
`str(uuid.uuid4())`. That line sits in **workflow-scope** code
(`execute_dag` / `_execute_single_task`, awaited directly from `AgentWorkflow.run`,
not behind an `@activity`), and Temporal recomputes any non-recorded value on every
replay.

The workflow migrated workers mid-fan-out (Fly instance `7815696f` → `d8d177dc` at
~19:54), replay ran, and the id regenerated from `2c04f317` to `16b11f13`. Every
IN_PROGRESS/child event emitted before the replay carried the old id; every FINISHED
event after it carried the new one. The frontend keys tool bubbles by `tool_call_id`,
so the old-id bubble never received a FINISHED event (the "stall") and the completion
surfaced as an apparent second fan-out. Both id batches point at the **same 50
sub-agent IDs** — child agent IDs are deterministic; only the tool-call wrapper
diverged. The DAG itself ran clean: "Starting task 2" once, "Task 2 completed" once
(20:05:04), then tasks 3/5/6 normally.

Discriminators that identify this specific failure: two `for_each` `toolCallId`s with
the same 50 `subAgentIds` (overlap 50, 0 new), a single Temporal `run_id`
(no `continue_as_new`, no pause), a root DAG log showing task 2 started and completed
exactly once, and IN_PROGRESS children timestamped before the completion children.
It is **not** the DAG→`run_agent` fall-through, **not** a pause/resume DAG re-run, and
**not** the nested-recursion sub-agent bug (synthesis leaves re-spawning under
verifier rejection — separate).

## Solution

Replaced `uuid.uuid4()` with `workflow.uuid4()` and
`datetime.now(timezone.utc)` with `workflow.now()` across the three workflow-scope
modules: `dag_executor.py` (659, 665) and `run_agent.py` (`stream_id` 274,
`tool_call_id` fallback 1194, `verifier_call_id` 1997, plus 13 `datetime.now` calls).
`agent_workflow.py` was already clean.

Cemented by `agents/tests/blackbox/workflow_determinism.blackbox.py`, which AST-bans
`uuid.uuid4` / `datetime.now` / `utcnow` / `time.time` / `random.*` in those three
modules — so the whole class of defect, not just this call site, can no longer
return.

Test-harness follow-on: `workflow.uuid4()` / `workflow.now()` raise
"Not in workflow event loop" when blackbox tests drive workflow code directly. Fixed
process-wide in `tests/blackbox/_test_utils.py` by starting a patch that stubs
`temporalio.workflow.uuid4` (→ `uuid.uuid4`) and `.now` (→ a fixed datetime).

## Human feedback

None recorded.

## Reusable lesson

Any id or timestamp minted in workflow-scope code must use `workflow.uuid4()` /
`workflow.now()` — a raw one regenerates on replay and silently splits one
tool call into two, one of which can never complete.
