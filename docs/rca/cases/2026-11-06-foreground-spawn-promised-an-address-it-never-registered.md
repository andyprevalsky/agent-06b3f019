---
id: 2026-11-06-foreground-spawn-promised-an-address-it-never-registered
date: 2026-11-06
title: A foreground explore/browser/code spawn got the /root/<task_name> address its schema promises, but no record, so sends to it failed with "No agent or background task"
surface: agents
component: background-agents
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_workflow.py _execute_tool ran a foreground spawn_agent(type=explore|browser|code) without the task record that background spawns get (workflows/background_agents.py), so neither the owner's resolve_message_target nor the persisted Agent.backgroundTasks held its path
symptoms:
  - "Message delivery failed: No agent or background task at /root/rose_repo_status"
  - send_message_to_agent failed after spawn_agent(run_in_background=false, task_name=...)
  - "No agent or background task at /root/<task_name>" for a task_name the agent itself spawned
  - foreground explore/browser/code agent missing from list_agents and the tree's backgroundTasks
tags:
  - agent-messaging
  - background-agents
  - task-path
  - send-message-to-agent
  - foreground-spawn
sources:
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82
  - commit c41d7b6abe
repro: agents/tests/blackbox/background_agents.blackbox.py test_foreground_spawns_are_addressable_and_answer_truthfully_once_finished
status: fixed
---

## Problem

Prod root 1a3d495c ("Rose Repo Status", 2026-11-06; FE
https://www.roselabs.ai/?agent-id=1a3d495c-826c-4eca-afe0-382fcbf72e82) spawned a code
agent with `spawn_agent(type=code, task_name=rose_repo_status,
run_in_background=false)`. After it returned "Task Incomplete" at 04:20:55, the
root itself (an ASSISTANT tool call, not the card's composer) called
`send_message_to_agent(to="/root/rose_repo_status")` at 04:21:05 and got
`Message delivery failed: No agent or background task at /root/rose_repo_status`
(the user's screenshot S2). The prod row `Agent.backgroundTasks` of the root
listed only its background explore and browser tasks. The root then spawned a
second code agent instead.

## Diagnosis

The spawn schema requires `task_name` on every spawn and says "Its address
becomes <your path>/<task_name>". Only `_start_background_spawn` creates the
task record that `resolve_message_target`, `list_agents` and the backend
resolver (`agentAddressResolver.resolvePath` over `Agent.backgroundTasks`)
read. A foreground explore/browser/code spawn ran with no record, so its
promised address never existed (general_purpose children are Agent rows with a
task path and were addressable). While a foreground task ran, other agents in
the tree could not reach it either; after it finished, the send failed with an
error that named no state.

Local repro (fails before, passes after, unchanged):
`cd agents && python scripts/run_blackbox_tests.py background-agents`, case
`foreground_spawns_addressable_and_truthful_once_finished`. Pre-fix:
`AssertionError: ('explore', [])`, no tree entry for the running foreground spawn.

Relative: commit c41d7b6abe (WMH experiment branches, never merged) only made
the error say foreground tasks have no address.

## Solution

`_execute_tool` records a foreground explore/browser/code spawn under its task
path while it runs (`_begin_foreground_spawn`, the same record and task_name
uniqueness rule as a background spawn, flagged `foreground`) and finishes it on
return (`_end_foreground_spawn`; a parked call stays running for the next
generation). While running it is in the tree state, so other agents' sends
reach its inbox, and for code the backend's existing running-code-task path
makes the message a CLI turn. Its rows stay the model's result (never stamped
FE-only), it posts no notification and never relaunches after a continuation.
PLAN-phase foreground explores are not recorded: PLAN has no `send_message_to_agent`,
and recording them would reserve their `task_name` against the plan's own tasks.
Once finished, a send gets `<path> is a <status> foreground <type> agent: its
result is the result of the spawn_agent call that ran it, and it takes no more
messages. Spawn a new <type> agent for new work.` (code: plus "spawn a new code
agent with the code_session_id from its result").

Golden reference: claude-code-src/src/tools/AgentTool/AgentTool.tsx:700-702
registers names for async agents only ("Sync agents skipped — coordinator is
blocked"); claude-code-src/src/tools/SendMessageTool/SendMessageTool.ts:822-835
resumes a stopped agent with the message. Rose diverges on purpose: its
schema promises every spawn an address and other agents in the tree can
message a running foreground task. A finished foreground task is refused, not
resumed, because its result is already the spawn call's result and a woken run
has no "started" row to keep its rows out of the model context
(toolLifecycleMessages.withBackgroundExecutionStamp).

## Human feedback

Orchestrator (2026-11-06): cover all three foreground kinds (explore/browser/code)
addressable at /root/<task_name>, plus a truthful result after the target
finishes.

## Reusable lesson

When a tool schema promises an address for every call, register it on every execution path, not only the asynchronous one.
