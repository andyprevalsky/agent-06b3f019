---
id: 2026-07-07-raw-uuid4-in-workflow-scope-regenerated-on-temporal-replay
date: 2026-07-07
title: A raw `uuid.uuid4()` in workflow-scope DAG code regenerated on Temporal replay, splitting one for_each fan-out into two
surface: agents
component: temporal-worker
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/loop/dag_executor.py — July tool_call_id; agents/domains/spawn_agent/handler.py — September explore task_id; both minted with raw uuid.uuid4() in workflow scope
symptoms:
  - for_each appears to fan out twice (~100 then ~121 sub-agents) and then stall
  - the first fan-out tool bubble spins forever with no matching FINISHED event
  - two for_each toolCallIds pointing at the same 50 subAgentIds (overlap 50, 0 new)
  - one spawn_agent tool call regenerates explore task IDs on workflow replay, leaving saved evidence under the original ID
tags:
  - temporal
  - determinism
  - for-each
  - dag-executor
  - uuid
sources:
  - agent 8874e0cf
  - agent d8897eaf-7c1b-46f7-911f-5a30b226cbce
  - agent 7da21688-9081-4bf1-9e32-62d9b0746575
  - memory:project_dag_foreach_split_fanout_nondeterminism
repro: agents/tests/blackbox/workflow_determinism.blackbox.py and agents/tests/blackbox/spawn_agent.blackbox.py
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
modules. The September recurrence showed that this guard did not cover domain
tool managers.

Test-harness follow-on: `workflow.uuid4()` / `workflow.now()` raise
"Not in workflow event loop" when blackbox tests drive workflow code directly. Fixed
process-wide in `tests/blackbox/_test_utils.py` by starting a patch that stubs
`temporalio.workflow.uuid4` (→ `uuid.uuid4`) and `.now` (→ a fixed datetime).

## 2026-09-30 recurrence

The unchanged `spawn-sub-agents` population smoke failed at 484 seconds in
`agents/benchmarks/runs/20260930_005924_spawn-sub-agents.json`. Its durable
viewer is `https://www.roselabs.ai/?agent-id=d8897eaf-7c1b-46f7-911f-5a30b226cbce`.
The Tokyo delegate's one `spawn_agent` tool call
`call_oZHqDvY0VnKllIN6c04mIPb1` first created explore task
`4fc8e936-c206-4e22-993a-e5e9d266a439`; completed web results were saved
under that ID. Worker eviction/replay then logged the *same* tool call with
new task IDs `27ba9006-9f2b-4d15-8b0d-039ca5a09876` and
`35a0444c-8a88-49f6-b5b0-ac2f9516ddab`. The latter produced
`Explore stopped before completion with no tool evidence.` while the original
task still had saved web results. This identifies `uuid.uuid4()` in
`domains/spawn_agent/handler.py` as the first bad identity boundary; it was
changed to `workflow.uuid4()` in `648066928`. The owning
`handler_explore_replay_keeps_evidence_task_id` blackbox failed with differing
IDs before that fix and passed afterward.

The July AST guard watched only `agent_workflow.py`, `run_agent.py`, and
`dag_executor.py`, so it missed workflow-scope domain tool managers. A scan of
direct `ToolManager` method bodies found two remaining raw UUID calls in
`domains/wait_for/handler.py`: the condition check's explore task ID and tool
call ID. The expanded `workflow_determinism` blackbox failed on both lines
before changing them and passed afterward; the full `wait_for` blackbox passed.
This static guard covers direct manager methods, including aliased or directly
imported UUID calls. Workflow helpers outside those methods still require
review; the manual search in this investigation found no additional confirmed
workflow-scope raw UUID call.
The browser handler's raw UUID calls execute inside its Temporal activity,
outside workflow replay. Production sub-agent spawn callers pass IDs minted by
`workflow.uuid4()` into their activities, so those activities' fallback UUIDs
were not the same workflow-replay defect.

With the original population prompt restored byte-for-byte, the exact local
`spawn-sub-agents` task passed 1/1 in 453.6 seconds under its 480-second cap.
The command was
`ROSE_USE_SYSTEM_PG=true bash scripts/run-bench --local spawn-sub-agents --max-concurrency 1 --no-dashboard`,
and the run artifact is `agents/benchmarks/runs/20260930_151340_spawn-sub-agents.json`.
Its durable viewer is
`https://www.roselabs.ai/?agent-id=7da21688-9081-4bf1-9e32-62d9b0746575`.
This outcome follows the joint evidence-formatting, timeout-recovery, and UUID
fixes; the isolated replay test proves the ID mechanism specifically. The
revised benchmark wording was removed because changing the task goal cannot
repair a workflow identity bug.

Owning regressions: before the spawn UUID fix,
`cd agents && ./venv/bin/python scripts/run_blackbox_tests.py spawn_agent`
failed `handler_explore_replay_keeps_evidence_task_id` because one logical
tool call acquired different task IDs. After the fix it passed. Before the
`wait_for` fix,
`cd agents && ./venv/bin/python scripts/run_blackbox_tests.py workflow_determinism`
failed on the two raw UUID calls in `wait_for/handler.py`; afterward it passed
5/5. `cd agents && ./venv/bin/python scripts/run_blackbox_tests.py wait_for`
also passed after the fake workflow supplied a stable UUID function.

## Human feedback

On 2026-09-30, the user rejected changing the population benchmark prompt for
a Temporal identity bug and asked for a repo-wide audit of the same failure
class and a plain explanation of replay. Keep the benchmark goal unchanged
while fixing workflow identity at its owner.

## Reusable lesson

Mint IDs and timestamps in workflow-scope code with `workflow.uuid4()` and
`workflow.now()`, and audit the workflow helpers called from domain managers
when expanding determinism guards. A raw value can regenerate on replay and
split one tool call's saved evidence across unrelated IDs.
