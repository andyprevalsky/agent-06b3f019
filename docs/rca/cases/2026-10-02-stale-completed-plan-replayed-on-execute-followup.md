---
id: 2026-10-02-stale-completed-plan-replayed-on-execute-followup
date: 2026-10-02
title: Post-completion follow-up with start_phase=execute replayed the completed set_plan DAG instead of the new USER instruction
surface: agents
component: dag-executor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_workflow.py EXECUTE skip_plan path — extract_plan_from_context + execute_dag treated a historical set_plan as live work after it was completed or superseded
symptoms:
  - "get a refund, the doordasher delivered to the wrong location"
  - "the second agent spawned here had no context on the first"
  - cloud_agent startPhase execute after completion_summary isFinalSummary
  - "Order one package of Oral-B Glide traditional dental floss"
  - order_confirmation_id product_name platform after refund request
tags:
  - dag
  - follow-up
  - post-completion
  - start-phase-execute
  - stale-plan
  - spawn-agent
  - chat-escalation
sources:
  - agent 601d673f-78e8-4007-b2b3-4b8b5e387c79
  - agent e08e3285-dc5e-484b-b2bb-829b8f3b455f
  - agent 2cf11dfa-90fd-5e93-b6fb-cab4870b6171
  - agent 838908eb-b818-46cc-bd1e-a820f56ad274
  - agent b3d8aac8-26bb-55af-8885-1a384a903ca7
repro: agents/tests/blackbox/workflow.blackbox.py
status: fixed
---

## Problem

Root agent `601d673f-78e8-4007-b2b3-4b8b5e387c79` (goal "order me glide floss
from doordash") completed at 19:13 UTC with `completion_summary` /
`isFinalSummary` and DoorDash order `dff187de-9b01-45a1-84f7-d9d493a4b070`.
The same agent id persisted. At 21:06 the user sent "get a refund, the
doordasher delivered to the wrong location". Chat re-escalated with
`cloud_agent startPhase=execute`. The new workflow skipped PLAN, loaded the
original `set_plan`, and re-ran both DAG tasks: explore
`838908eb-b818-46cc-bd1e-a820f56ad274` researched how to *buy* floss again,
then browser `b3d8aac8-26bb-55af-8885-1a384a903ca7` spawned with the original
"Order one package of Oral-B Glide..." goal. The second explore had no
context of the completed order because it was given the original buy-floss
research task, not a context-inheritance miss on a refund task. The Agent
row also kept the original output schema (`order_confirmation_id`,
`product_name`, `platform`); chat re-escalation never cleared
`responseSchema`, and the new workflow reused it because
`response_schema is not None`.

## Diagnosis

Critical path: USER follow-up → `postMessage` → terminal agent clears
`temporalWorkflowId` → `handleChatMessage` → router
`start_superintelligence(mode=execute)` → new Temporal workflow
`start_phase=execute` → `skip_plan` → `extract_plan_from_context` finds the
old `set_plan` → `execute_dag` replays every task (`resume_completed_tasks_from_context`
is only wired for `execute_dag_resume`).

Midpoint check: the refund USER row is in history (message 224) and the
router ASSISTANT (225) understood the refund. Data is still correct there.
The first wrong derived value is the EXECUTE entry treating the completed
plan as live work (spawn_agent 229 `dagTaskIndex=0` with the original
explore goal; spawn_browser 243 original order goal). Message 226
`cloud_agent` metadata: `startPhase=execute`, `toolCallId=832d47d0-...`.

Step 5a class: a historical `set_plan` has no liveness predicate — "latest
FINISHED set_plan" is not "the work for this execute." Why 2: chat
`start_phase=execute` means "new simple task, skip planning"; the workflow
auto-DAG-runs any leftover plan. Why 3 (next-deeper class tried): tombstone
or delete the `set_plan` row on completion, or split the execute enum into
execute-new vs execute-replay. That failed to be coherent because the
`set_plan` row is the user-visible plan artifact and the
`execute_dag_resume` input; mutating history to encode liveness couples UI
to control flow, and splitting the enum still needs a workflow-side
predicate so a mis-tagged execute cannot replay. Stop at the liveness
predicate.

Archive searches (`second agent spawned no context stale plan DAG
follow-up`, `completion_summary start_phase execute extract_plan_from_context
re-run DAG`, `get a refund doordasher delivered post-completion follow-up
cloud_agent`) found relatives (2026-09-28 post-completion context-window,
2026-07-19 DAG-failure fall-through, 2026-06-30 execute-mode routing) but
not this boundary — novel instance of the execute-contract class.

Local repro (identical command): load
`test_workflow_execute_skips_stale_plan_after_completion_followup` from
`agents/tests/blackbox/workflow.blackbox.py`. Pre-fix:
`AssertionError: a USER message after completion_summary must not re-run the
completed DAG; execute_dag was called 1 time(s)`. Post-fix: PASS.

## Solution

`plan_superseded_by_new_user_instruction` in `agents/loop/dag_executor.py`
treats a plan as not-live when either `completion_summary isFinalSummary`
already posted, or a real (non-hidden) USER instruction arrived after
`set_plan`. A fresh `plan`/`execute` start (no `resume_state`) then drops
that plan (`plan_data = None`) and falls through to `run_agent`. Terminal
reactivation (`clearWorkflowForTerminalAgent`) and follow-up Temporal start
immediately null `responseSchema`, `structuredResponse`, `progress`,
`toolsInUse`, and `statusMessage` on the Agent row so the new run never
observes the old contract. Startup must not rebuild the schema from
`Agent.goal`; it generates from the latest real USER instruction only.
`continue_as_new` / deploy resume keep the live schema and plan. A live
plan with no later USER and no Task Complete still runs `execute_dag`.
A later root run on the same Agent row must resume the latest
`context_reset` checkpoint (compressed context + tail), not re-ingest the
raw first-run dump.
Cemented by `wf_execute_skips_stale_plan_after_completion_followup`,
`wf_execute_nulled_schema_does_not_regenerate_from_old_goal`,
`wf_plan_followup_does_not_regenerate_schema_from_old_goal`,
`wf_execute_skips_plan_after_user_followup_without_summary`, and
`clearWorkflowForTerminalAgent` in `workflow-terminal-cleanup.test.ts`.

Siblings this also prevents: post-completion "cancel that" / "also get X" /
"do it for a different address" replaying the original book/order/send DAG;
FAILED / `OUT_OF_CREDITS` / `COST_LIMIT_REACHED` re-escalation that never
wrote Task Complete; restart after Task Complete with no new USER.

10k-agent: one O(messages) scan per new workflow start, same bound as
`extract_plan_from_context`. No shared topic, lock, or per-user fan-in.

## Human feedback

User asked whether chat `execute` means continue the existing plan, why the
second spawn looked like it had no prior chat, and noted the output schema
was not reset either.

## Reusable lesson

A historical set_plan and its output schema are not live work after the run
is completed or a later USER instruction arrives — `start_phase=execute`
must not replay or reuse them.
