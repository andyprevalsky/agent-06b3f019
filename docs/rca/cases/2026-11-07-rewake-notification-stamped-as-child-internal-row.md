---
id: 2026-11-07-rewake-notification-stamped-as-child-internal-row
date: 2026-11-07
title: A rewoken child's FINAL_ANSWER carried subAgentId, so the parent's context poll dropped it as the child's internal work
surface: agents
component: agent-control-rewake-notification
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_control.py AgentControlMixin._on_rewoken_child_completed stamped the parent-visible FINAL_ANSWER notification row with metadata.subAgentId, and helpers/context_scope.is_internal_subagent_message classifies every subAgentId row as a child's internal work, so loop/context_utils.poll_and_update_context (filter_internal_subagent_messages) and helpers/llm drop_rows_never_sent_to_model / build_verifier_context_messages removed it from the parent's model and verifier context
symptoms:
  - "tool reports they restarted, but wait_for reports them complete immediately and no corrected FINAL_ANSWER arrived"
  - "Your latest FINAL_ANSWER visible to coordinator still ends 'Andy Prevalsky'"
  - "[agent_control] rewoken child cf06780d finished again (completed)"
  - "Agent-tree view shows Garry/Sarah ACTIVE while parent wait_for reports completed, suggesting stale completion state during restarts"
  - tree-feedback-routing Timeout after 904s (task timeout=900s) with the coordinator re-asking rewoken drafters for corrected drafts
tags:
  - tree-feedback-routing
  - send-message-to-agent
  - restarted-finished-agent
  - agent-notification
  - context-scope
  - subagentid
  - wait-for
sources:
  - agent 29c987c1-4a03-4f9c-9d7e-b7424733f549 (tree-feedback-routing r1, campaign-20261107-181733-711331 r001-j0007, source 2556bdb2a4)
  - agent 4ed8f256-0471-4804-83a6-d300ca7def13 (coordinator); drafters cf06780d (Garry), 85308957 (Sarah), 47019531 (Anand)
  - fleet run /home/boxes/descend-launch-e18/.context/fleet/runs/20261107-183105-905812/tree-feedback-routing (run.json logs.tree, remote-logs/runtime-evidence/logs/worker.log)
  - benchmark run campaign-20261107-181733-711331 r001-j0007 triage card .context/descend/descend-failed-neverrun-20261106/triage/8/tree-feedback-routing-r1.json (descend cluster H-55)
  - commit f4c70095fb (introduced the rewake notification with the subAgentId stamp)
  - commit 0cc18c03a2 (related H-25b verifier delivery-visibility fix, case 2026-11-06-verifier-blind-to-displayed-authored-draft)
repro: agents/tests/blackbox/agent_control.blackbox.py::test_rewoken_child_final_answer_reaches_the_parents_model_context
status: open
---

## Problem

tree-feedback-routing r1 (root 29c987c1, source 2556bdb2a4) timed out after 904 s
with the root ACTIVE. At 18:49:12 a mid-run user correction (sign as "Andy
Prevalskii") went root → `/root/outreach_coordinator` → the three drafters. Garry
had already finished with "Prevalsky", so `send_message_to_agent` rewoke him at
18:52:13 ("had finished; this message started its next run. You will get a new
FINAL_ANSWER agent message when it finishes again."). Sarah's correction arrived
at 18:52:13, after her verifier had accepted her completion at 18:52:08, so her
first run also returned "Prevalsky" (18:52:18).

The worker log shows the rewoken children finishing again and the coordinator
posting their notifications: `[agent_control] rewoken child cf06780d finished
again (completed)` at 18:53:36 and 18:55:16, and for 85308957 at 18:55:21 and
18:57:31. The coordinator's stored rows include those USER rows. The 18:53:36 row
has Garry's corrected body ending "Andy Prevalskii, Founder, Rose Labs". Its
metadata is `{agentNotification: true, …, subAgentId: "cf06780d-…"}`.

The coordinator's model never saw any of them:

- 18:54:01 it re-sent to Garry: "Your latest FINAL_ANSWER visible to coordinator
  still ends 'Andy Prevalsky'".
- 18:54:29 it told the root: "tool reports they restarted, but wait_for reports
  them complete immediately and no corrected FINAL_ANSWER arrived".
- LLM call i10 (18:54:00) added only 1,089 cache-write tokens plus 126 uncached.
  That fits Anand's ~3.2k-char first-run notification plus the wait_for result.
  It does not fit Garry's ~3.1k-char corrected notification as well.
- The model saw only wake headlines ("Woken early by a background agent
  notification (/root/outreach_coordinator/draft_garry_tan)").
- It spawned an explore audit agent to read the drafters' trajectories, then
  re-asked Sarah to "return your corrected draft … in your OWN completion".
  The audit had found the corrected text only in a tool extraction.
- The 900 s budget ran out at 18:57:28 (PAUSE), one second after Sarah's final
  notification row.

## Diagnosis

Critical path: rewoken child `child_completed` signal → parent
`AgentWorkflow.child_completed` → `_on_rewoken_child_completed` posts one USER
`agentNotification` row → `run_agent` context poll (`poll_and_update_context`)
→ `build_llm_messages` → provider.

1. **The row is correct in the DB.** The corrected body and FINAL_ANSWER
   message type are in the stored row (`run.json` `logs.tree[4ed8f256].messages`,
   18:53:36.643Z).
2. **The row is gone after the poll.** `poll_and_update_context` runs
   `filter_internal_subagent_messages`. `is_internal_subagent_message` returns
   True for any row with `metadata.subAgentId`. That is the marker for a child's
   own work stream: progress rows, explore tool rows, the FE-only "Sub-agent
   completed" TOOL row. The converters' `drop_rows_never_sent_to_model`, and
   `build_verifier_context_messages`, apply the same test, so neither the
   parent's planner nor its verifier can see the row.
3. **Why it had the stamp.** `_on_rewoken_child_completed` (added in
   f4c70095fb) copied `"subAgentId": child_agent_id` from the FE-only child rows
   onto a model-facing notification. A first-run notification
   (`_finish_background_task`) uses `agent_notification_metadata` alone and is
   visible. The two notification producers disagreed on the delivery contract.
   The send tool promises a new FINAL_ANSWER, and the rewake path delivered one
   only to the FE.
4. **Why one stamp could do this (Step 5a).** The context-scope classifier keys
   on one generic metadata field that any producer can attach. No invariant or
   test bound "the row a parent receives as its child's result" to "survives the
   parent's context poll". That is the guard the new regression adds. The next
   rung would be making `is_internal_subagent_message` exempt
   `agentNotification` rows, which needs a twin change in
   `back-end/src/providers/chat/contextScope.ts` and the shared fixtures. No
   other producer stamps `subAgentId` on a notification or agent-message row
   today, so there is no named sibling to justify that wider rung. Deleting the
   stray stamp removes the failure surface (Step 6a: delete).

Classification: Our bug — logical inconsistency in harness contracts.

Not the first-bad boundary, but observed in the same run (open contributor):

- After the parent sends to its finished durable `general_purpose` child and the
  backend wakes it, the parent's `_background_finished` record stays
  "completed".
- So before the child re-terminates, `wait_for(agents=[child])` returns
  "<address> already finished." with status "completed" (18:52:22 and 18:54:07).
- The `<environment>` block says "Running agents you started: none", while the
  backend tree (`list_agents`) shows the child ACTIVE.
- The child's own record is truthful (ACTIVE, then COMPLETED with the corrected
  result).
- The parent learns the new result only through the rewake notification row,
  which is what this fix makes visible.

Repairing the stale parent record touches the background lifecycle (reopening
the record, and ordering against a `child_completed` that can arrive before the
send result). It is left as a separate lane.

Local repro (fails on 2556bdb2a4):

```
cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py agent-control
# pre-fix: AssertionError ("the rewoken child's FINAL_ANSWER row was dropped by the context poll",
#   {'agentNotification': True, ..., 'idempotencyKey': 'agent-mid:agent-garry:rewake:run-1:1', 'subAgentId': 'agent-garry'})
```

## Solution

`_on_rewoken_child_completed` now posts the rewake notification with exactly
`agent_notification_metadata(...)`, the same parent-visible contract as a
first-run notification, and no `subAgentId` stamp. The regression drives the real
`AgentWorkflow.child_completed` for a rewoken background child, then runs the
stored rows through the real `poll_and_update_context`, `build_llm_messages` and
`build_verifier_context_messages`. It asserts the corrected FINAL_ANSWER reaches
the parent's model and verifier. It is registered in the `agent-control`
blackbox domain, which deploy runs through agents coverage.

The fix also covers the parent's execute verifier, which dropped rewake
notifications the same way. No prompt, schema, benchmark or timeout changed.

At 10k agents it is unchanged: one row per re-completion, per-agent state, no new
reads or channels.

Golden reference: not applicable (no approval-gated hunk). It matches Codex's
`InterAgentMessage` (codex-rs/core/src/context/inter_agent_message.rs): a child's
completion is always parent-visible context.

Outcome proof pending: the exact tree-feedback-routing rerun belongs to the
descend loop. This RCA ran no benchmark against the live campaign.

## Human feedback

None recorded.

## Reusable lesson

When a parent "never received" a child result that is stored in the DB, check
whether the row carries a child-internal scope marker (`subAgentId`): every row
a parent is promised as its child's result must use the same parent-visible
metadata as the first-run notification and be tested through the real context
poll.
