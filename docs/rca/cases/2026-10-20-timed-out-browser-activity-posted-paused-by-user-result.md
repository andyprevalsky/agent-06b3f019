---
id: 2026-10-20-timed-out-browser-activity-posted-paused-by-user-result
date: 2026-10-20
title: Timed-out browser activity posted a second "Agent paused by user" result that replaced the workflow's timeout error
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/handler.py `_spawn_browser_agent_activity_v3_real` `except asyncio.CancelledError` — wrote a model-visible FINISHED `Browser Session Cancelled: Agent paused by user` on the spawn toolCallId for every cancel, including a StartToClose timeout whose result the workflow manager had already posted"
symptoms:
  - "Context validation error: [role_alternation] Consecutive assistant messages at OAI indices 3 and 4. This usually indicates context duplication (dual-write bug)."
  - "AGENT FAIL: Context validation error: [role_alternation] Consecutive assistant messages at OAI indices"
  - "Agent status: ACTIVE (expected COMPLETED)"
  - "Browser automation failed: activity StartToClose timeout followed seconds later by Browser Session Cancelled: Agent paused by user on the same toolCallId"
  - model is told the user paused a browser task that actually timed out after 30 minutes
tags:
  - role-alternation
  - context-validator
  - browser-activity-cancellation
  - start-to-close-timeout
  - dual-terminal-write
  - polar
sources:
  - agent e2176bec-206d-41d5-879c-5a219991f6d8
  - agent 05c018cb-57ca-4075-95f3-81635a49a879
  - agent fbc09c47-af40-4576-9f2b-4d3a2c287430
  - commit 0a2470cc6
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_timed_out_browser_activity_leaves_the_tool_result_to_the_workflow
status: mitigated
---

## Problem

Polar batch 1 (2026-10-20, source 0a2470cc6) failed 10 tasks mid-run with
`Context validation error: [role_alternation] Consecutive assistant messages at
OAI indices N and N+1` (N = 3, 5, 7, 9, 16) while the agent was still ACTIVE.
Every one of the 10 Hub snapshots shows the same rows on one spawn toolCallId:
IN_PROGRESS at T, `Browser automation failed` ERROR `activity StartToClose
timeout` at T+30 min, the root's next tool-calling ASSISTANT turn ~8 s later,
then a FINISHED `Browser Session Cancelled` / `Agent paused by user` 2–50 s
after that turn. Replaying those exact snapshots through `validate_context`
reproduces the failure; removing only the late "paused" rows clears it on all 10.

## Diagnosis

1. The browser activity reached its 30-minute StartToClose timeout. The workflow
   got `ActivityError(TimeoutError)`; `SpawnBrowserAgentManagerV3` re-raised it to
   its `except Exception` and posted the call's result, ERROR `activity
   StartToClose timeout`. The planner then took its next turn.
2. The worker's local timeout cancelled the still-running attempt. Its
   `except asyncio.CancelledError` branch closed the session and unconditionally
   posted FINISHED `Agent paused by user` on the same toolCallId — a second
   terminal result, mislabeled as a user pause.
3. `collapse_duplicate_tool_results` keeps the latest terminal row per call, so
   the late row replaced the timeout error and sorted after the next ASSISTANT.
   The benchmark validator (unmerged OAI view) flagged consecutive assistants
   and aborted the task. In the real provider path `build_llm_messages` merges
   the two assistants, so no 400 occurs, but the model sees "paused by user"
   in place of the timeout.
4. Deepest owned cause: the activity treated every cancellation as a
   workflow-requested pause. `activity.cancellation_details()` distinguishes
   `cancel_requested` from `timed_out` / `worker_shutdown` / `reset`, and
   `spawn_claude_code_agent` already uses it to avoid reporting a non-requested
   cancel as "Session Cancelled". The browser activity lacked that check.

Repro (pre-fix, origin/main b61d9d0da): the regression runs the real activity
under `ActivityEnvironment`, cancels it mid-step with
`ActivityCancellationDetails(timed_out=True)`, appends what it wrote to the real
e2176bec rows, and runs `validate_context`. It failed with `got late terminal
writes [('Browser Session Cancelled', 'Agent paused by user')]; validator:
['Consecutive assistant messages at OAI indices 2 and 3 ...']`.

## Solution

In the activity's CancelledError branch, read `activity.cancellation_details()`.
Only a workflow-requested cancel (`cancel_requested`, or no details) posts
`Browser Session Cancelled` and returns `status: cancelled`. Any other cause
still closes the browser session, then re-raises so the workflow's own
ActivityError result is the only tool result. Matches the Claude Code activity
and claude-code-src `query.ts:1046`, which treats only an `interrupt` abort as a
user interruption, and `query.ts:123` (`yieldMissingToolResultBlocks`), where the
owning loop emits exactly one result per tool_use. Regressions:
`test_timed_out_browser_activity_leaves_the_tool_result_to_the_workflow`
(fail→pass) and control `test_requested_browser_cancel_still_posts_the_pause_result`
(passes both sides) in the spawn-browser-agent-v3 blackbox domain.

10k agents: one in-memory read per cancelled activity; one fewer DB write and
broadcast on timeouts. No new shared state.

Still open: why these browser activities ran the full 30 minutes (separate
cluster), and outcome proof (exact Polar tasks rerun) pending approval.

## Human feedback

None recorded.

## Reusable lesson

Only a cancel the workflow requested may post a "paused/cancelled" tool result from inside an activity; on timeout or shutdown the workflow already owns that call's result.
