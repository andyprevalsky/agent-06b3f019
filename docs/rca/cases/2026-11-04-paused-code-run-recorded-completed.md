---
id: 2026-11-04-paused-code-run-recorded-completed
date: 2026-11-04
title: A paused background code agent (user pause, idle, usage limit) was recorded "completed", so it could not be messaged or resumed
surface: agents
component: background-agents
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/background_agents.py _finish_background_task derived failed/completed from result error or ERROR status only and ignored the executor's structured metadata.session_paused, while the code handler reports every pause as FINISHED
symptoms:
  - "Message Type: FINAL_ANSWER | Sender: /root/timed_counter | Payload: User paused the agent"
  - "Woken by a background agent notification ... /root/timed_counter: completed"
  - "is a completed code agent; completed browser and code agents cannot be messaged. Spawn a new code agent for new work."
  - "AssertionError: {'toolu_user': 'completed', 'toolu_idle': 'completed', 'toolu_limit': 'completed'}"
  - after resume the root spawned an explore agent to inspect the paused code agent instead of resuming it
tags:
  - background-tasks
  - code-agents
  - pause
  - a2a
  - multi-day
sources:
  - agent c4eaace9 (root, live repro on 28a7bfc99, 2026-11-04 22:50Z)
  - commit dab1e6ad9 (W3: paused browser/code tasks resume with continue_conversation)
  - commit 4317820584 (fix)
repro: agents/tests/blackbox/agent_control.blackbox.py test_paused_code_task_endings_are_recorded_paused_and_resumable
status: fixed
---

## Problem

Live repro (parent, local stack on 28a7bfc99): root c4eaace9's background code
agent `/root/timed_counter` ran a 15s counter loop. POST /pause at 22:50:09Z.
Rows: "Code session paused" FINISHED "User paused the agent", then the USER
notification `status=completed`, "Message Type: FINAL_ANSWER … Payload: User
paused the agent", and wait_for "… /root/timed_counter: completed". The DB had
the CodeSession PAUSED with a checkpoint, yet after /resume the root spawned an
explore agent to read the trajectory instead of resuming the session.

## Diagnosis

`domains/spawn_claude_code_agent/handler.py` reports a user pause, an idle
pause (C11) and a usage limit (C15) as FINISHED with
`metadata.session_paused=True` (resumable, never failed: C11/W5b). The W3
"paused" task status (commit dab1e6ad9) was implemented for the browser shape:
`status = paused` only when `failed and paused` (a browser pause is cancelled
as ERROR). For code, `failed` is False, so every pause became "completed";
`background_message_refusal` then refuses messages to it and the tree lists it
as completed. agent_control.blackbox.py stubbed `{"error": True}` for the code
task, so the real handler shape was never tested.

Step 5a: why possible? The workflow inferred pause from a failure flag instead
of the executor's structured outcome (two sources of truth). Next rung (the
handler's FINISHED-for-pause contract) is a deliberate C11 design; stop.

Repro: `cd agents && python scripts/run_blackbox_tests.py agent_control`,
pre-fix `AssertionError: {'toolu_user': 'completed', 'toolu_idle':
'completed', 'toolu_limit': 'completed'}`.

## Solution

`_record_background_event` keeps `outcome.session_paused` from the terminal
row; `_finish_background_task` records "paused" for a resumable type when the
executor reported its session paused, or when a user pause cancelled it
(browser, unchanged). Kill reasons still win. The notification's Message Type
follows the run outcome (FINAL_ANSWER unless failed), as Codex sends every
completion as FINAL_ANSWER with the state in the payload; the payload now says
the session is paused (see 2026-11-04-code-user-pause-result-omitted-session-id).
10k agents: O(1) per finished task, workflow-local.

Golden reference: claude-code-src/src/tools/SendMessageTool/SendMessageTool.ts
~:822-845 resumes a stopped agent with the message; Rose's W3 keeps the
explicit continue_conversation for paused tasks.

## Human feedback

None recorded. (W3 direction, Andy 2026-10-23: completed browser/code agents
refuse messages; paused ones resume with continue_conversation. Kept.)

## Reusable lesson

Derive a task's lifecycle state from the executor's structured outcome field, never from a failure flag that only one executor kind sets.
