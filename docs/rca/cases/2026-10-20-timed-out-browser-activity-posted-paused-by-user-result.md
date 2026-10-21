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
status: open
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

The activity returns neutral cancellation/cleanup ownership to the workflow and
never emits a model-visible cancellation terminal. Timeout/shutdown still
re-raise after cleanup. Missing SDK details preserve the neutral cleanup return;
they do not establish user intent. Only the workflow's observed user pause sets
`userPauseRequested` from explicit pause-signal state (not automatic budget/auth pauses); a pause followed by immediate resume retains that observation.

The backend annotates the existing result atomically under its existing
agent-generation and per-tool locks. It keeps ID, original producer clocks,
original content as a byte-identical prefix, error fields and structured output,
adds `userPause: {reason: "user", recordedAt: ...}` plus a visible pause note,
and creates a terminal only if none exists. Repeats are idempotent and a late
cancelled-attempt write cannot replace the paused result. Existing terminal
results take priority over progress rows. Ordinary tools retain latest-result
semantics.

Same-ID broadcasts and timestamp-filtered polls deliver the annotation without
moving the original result in conversation order. Both workflow/planner caches
and the realtime UI accept this narrowly typed update and reject stale replay.
The separate `recordedAt` clock advances delivery cursors, not outcome clocks.

Opened golden references: `spawn_claude_code_agent/service.py` distinguishes
cancellation causes; `claude-code-src/src/query.ts:123` supplies missing tool
results. **Correction:** `query.ts:1044` skips the generic interruption message
for reason `interrupt`; it does not justify a user-pause inference from a generic
cancel request. None of these sources independently specifies Rose's new atomic
annotation contract; the explicit user alignment does.

Registered owning regressions cover neutral cancellation, actual user pause,
pause/resume race, cleanup, preserved approvals, same-row error/content clocks,
repeat pause, late writes, generation fences, real SQL polling, both transactional
completion/pause orderings, planner/workflow refresh and realtime UI replay.
The original read-only incident probe also runs against the repaired source.
Local causal proof is distinct from Polar outcome proof.

10k agents: existing lifecycle locks are reused, no global lock or provider call
is added. The poll query now also considers the user-pause annotation clock;
large-fleet throughput was not measured. Outcome proof and the reason the original
tasks used the full 30 minutes remain open. Parent owns the authorized same-60
rerun after all three clusters are integrated; this lane does not run it.

## Human feedback

User alignment: timeout must remain timeout; actual user pause is added to the
existing result without losing its content/error or inserting a second terminal.
Parent explicitly authorized continued implementation and the necessary shared
persistence/update delivery work. No approval for benchmark launch is claimed by
this lane.

## Reusable lesson

Transport cancellation is not user intent. Put pause ownership at the workflow
which observed that intent, and make it an idempotent annotation of the owned
result, preserving both its payload and position across durable and cached views.
