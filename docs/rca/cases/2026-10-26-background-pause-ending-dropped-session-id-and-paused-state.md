---
id: 2026-10-26-background-pause-ending-dropped-session-id-and-paused-state
date: 2026-10-26
title: A root pause ended its background browser run without the paused session id, and the dock read it as running/completed
surface: cross
component: background-agents
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/background_agents.py _record_background_event/_finish_background_task dropped the ending row's session_id; front-end agentsPanelGroups.taskStatus and backgroundSpawns.notificationState had no "paused" state
symptoms:
  - i paused the root agent, but the browser agent didn't close with paused
  - Message Type: FAILED ... Payload: User paused the browser agent
  - notification metadata status "paused" with messageType "FAILED" and no session id
  - dock shows "Running 1 agent" while the root is PAUSED
tags:
  - pause
  - background-agents
  - browser
  - session-id
  - agents-panel
  - spawn-browser-agent
sources:
  - agent 447576b9-f5e5-4f81-b883-865e5dad5fa9 (prod, paused 2026-10-26 16:08:51Z)
  - commit e32aa6cbc (front-end)
  - commit 6731c38da (agents)
  - commit 5dba44817 (regression drives the real browser manager)
repro: agents/tests/blackbox/agent_control.blackbox.py::test_root_pause_ends_background_browser_paused_with_its_session_id; front-end/src/tests/blackbox/background-agents.blackbox.tsx 'paused background browser (root pause)'
status: fixed
---

## Problem

Andy paused prod root 447576b9 ("Get me breakfast") at 16:08:51Z while its
background browser task `/root/order_breakfast_dd` (tool call `a05d020e5`) was
checking out on DoorDash. Read-only prod evidence:

- The pause did reach the browser: its activity was cancelled ("Browser Session
  Cancelled — Agent paused by user"), and the Kernel `BrowserSession` row
  `rpryg2dblkppepao5bd344aw` stayed `PAUSED` with `closedAt` null (paused, not
  torn down). The manager's "Browser Session Paused" row (ERROR) carried
  `metadata.session_id`.
- `Agent.backgroundTasks` recorded the task as `paused`.
- The owner's notification was `{status: "paused", messageType: "FAILED"}` with
  text `Message Type: FAILED … Payload: User paused the browser agent`: no
  session id anywhere the model or UI reads.
- The query-box dock lists in-activity tasks from two sources. The tree task
  status `paused` fell through `taskStatus` to `ACTIVE` ("Running 1 agent"
  while everything was paused), and the spawn's notification status `paused`
  fell through `notificationState` to `completed`.

## Diagnosis

Critical path: FE pause → `POST /api/agents/:id/pause` → `pauseAgent`
(DB PAUSED + Temporal `pause` signal) → `AgentWorkflow.pause` (sets
`is_paused`, increments `_pause_signal_sequence`, cascades to child
workflows) → the browser manager's `wait_condition(handle.done() or
tool_stop_requested)` → `activity_handle.cancel()` → the activity's
CancelledError branch closes the provider session with `pause=True` and returns
`session_id` → the manager posts its pause row → `_record_background_event` →
`_finish_background_task` → notification row → FE derivation.

Data stays correct up to the manager's pause row: the session id is on it. The
first point where it goes wrong is `_record_background_event`, which keeps
status, message, result and structured response from terminal rows but not
`session_id`, so `_finish_background_task` cannot hand it to the notification.
In the front end, both status mappers predate the "paused" task status that
dab1e6ad9 introduced, so the workflow's correct status fell through to their
defaults.

A sibling surfaced while writing the regression: `_run_background_task` read
the pause baseline at its first step, so a pause handled between the launch
and that step ended the run `failed` instead of `paused`. This is reproduced
by the second phase of the same test.

Why it was possible: the paused ending (A2A W3, dab1e6ad9) added a new terminal
status on the workflow side without a contract test that carried it, and the
session id, through every consumer: notification, dock, spawn derivation.

## Solution

- `agents/workflows/background_agents.py`: the recorder keeps a terminal row's
  `session_id`; `_finish_background_task` passes it to the notification on
  every ending (text section `Session ID: <id>`, metadata `sessionId`). The
  pause baseline is read in `_launch_background_task` and passed to the task.
- `agents/helpers/background_agents.py`: `build_agent_notification_text` and
  `agent_notification_metadata` accept an optional `session_id`.
- Front end: `BackgroundRunState` gains `paused`; a `paused` notification and a
  `paused` tree task map to `PAUSED` (status text "paused", never counted as running).

Continuation is unchanged: `send_message_to_agent(continue_conversation=true)`
restores the archived paused transcript and the same logical browser session.

10k agents: per-agent workflow state only, with one extra string on the
existing single notification row per task. There is no new channel, query or
fan-out.

Not covered: if the activity dies without returning (the synthetic
`{"status": "cancelled"}` result after an ActivityError), the workflow has no
session id to attach.

## Human feedback

Andy (2026-10-26): "i paused the root agent, but the browser agent didn't close
with paused? (should still return its session id for continuation)".
Standing lifecycle rule (2026-10-22): every ending returns the session_id.

## Reusable lesson

When adding a terminal status or handle to a background task, trace it through every consumer (notification text and metadata, persisted tree state, FE dock and spawn derivation) with one contract test, and read state baselines when the task launches, not after its first await.
