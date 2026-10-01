---
id: 2026-10-01-sms-reply-left-user-paused-agent-paused
date: 2026-10-01
title: SMS supervisor reply delivered a message to a user-paused agent without resuming it
surface: back-end
component: agent-resume
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/smsSupervisor/supervisorTools.ts commitReplyToAgent signaled receive_user_response and never sent resume
symptoms:
  - Agent paused by user
  - Signaled workflow
  - is_paused_query true after an SMS reply
  - Restored after code update
tags:
  - sms-supervisor
  - pause-resume
  - temporal-signal
sources:
  - agent 5c8b0ca4-fb14-4fb8-ac38-6d0f6b79f12f (Temporal run 94dadc5c-ca6c-4a1f-b36a-04ba57df4b54)
repro: back-end/src/tests/blackbox/sms-supervisor.paused-reply.behavior.ts
status: fixed
---

## Problem

The user paused prod agent `5c8b0ca4`. Message #621 at 17:18:53Z is the browser tool's cancellation, and the workflow's "Agent paused by user" row followed at 17:19:41Z. At 18:32:19Z a code-update `continue_as_new` started run `94dadc5c`, which carried `is_paused` over ("Restored after code update"). At 19:17:01Z the user texted "Skip DoorDash entirely. Buy the newest AirPods Pro…".

The SMS supervisor's `reply_to_agent` posted that USER row (`metadata.source = sms_supervisor`). Render logged `Posted USER message` and `Signaled workflow`. Run `94dadc5c` received exactly one signal: `receive_user_response`, with the plain message as payload (no `request_id`), at 19:17:01.377Z. It processed that signal while still paused, running `poll_new_messages` and then `set_response_schema_activity` for the response-schema refresh.

The run then went back to its 30-second `fetch_agent_queue_pointer` loop, and it was still in that loop at 20:28Z. `is_paused_query` returns `true` and the database still shows PAUSED. No `resume` signal ever arrived.

## Diagnosis

The history of run `94dadc5c` shows where the workflow was parked:

- From 18:32 to 18:42 it ran `run_agent`'s bounded paused poll (repeating 30-second and 1-second timers).
- After that it switched to a 30-second timer with `fetch_agent_queue_pointer`. That is `_handle_incomplete` → `_wait_for_unpause_or_handoff` (agent_workflow.py ~4620).

That wait exits only on `is_paused` becoming false or on a generation handoff. `receive_user_response` sets `_has_new_messages` and refreshes the response schema, but it never touches `is_paused`. For a user pause, `is_paused` is cleared only by the `resume` signal. `price_limit_increased` and parent-state transitions also clear it, but no user reply can reach those.

`commitReplyToAgent` posts the message, signals `receive_user_response`, and resolves attention. It has no resume step, and the supervisor has no resume tool, so the model could not work around it.

The deepest owned cause is a split contract. The rule "a user's message to a paused agent continues it" lived only in the web composer: `useMessageSending.ts` called `/resume` before posting. The backend never enforced it, so every other channel skipped it. That covers the SMS/WhatsApp supervisor, and `POST /api/agents/:id/messages` called from the public API (Rose API keys) or older clients.

`authAssistanceCompletion.ts` already signals and then resumes on the backend for auth help. So the backend precedent existed, but message delivery did not follow it.

A deeper alternative was rejected: having `receive_user_response` unpause inside the workflow. Internal USER relays (OTP codes, response-schema context) arrive through the same signal as plain strings, so the workflow cannot tell user intent apart. The status and replacement-snapshot transition must also happen under the generation lock to survive replacement windows.

Before the fix, the new blackbox cases failed:

- `cd back-end && bash scripts/run-blackbox-tests.sh sms-supervisor` reported `Expected an SMS reply to resume the PAUSED agent, status is still PAUSED`.
- The agents domain reported `a user message must resume the agent, got PAUSED`.

Archive searches for pause, resume, and SMS reply found no prior case at this boundary.

## Solution

`resumePausedAgentForUserMessage` in `providers/agentResume.ts` works in two steps.

1. An unlocked pre-read skips the common ACTIVE case and refuses a child whose parent is PAUSED or COST_LIMIT_REACHED. The `/resume` route already refuses that case; without the check, the child's row would read ACTIVE while its workflow rejected the signal.
2. The locked `recordWorkflowResumeIntent` transition then acts only when it durably moved a user pause (PAUSED, or a replacement whose prior status was PAUSED) to ACTIVE. It signals `resume` and rolls back if the signal fails, sharing that code with `resumeAgentWorkflow`. The helper never throws into the send path.

It has two callers:

- `commitReplyToAgent`, for plain replies, after a successful `receive_user_response` signal. Attention approvals and rejections leave the pause alone, matching the web approval path.
- `postMessage`, for user-authenticated USER rows only. Internal USER rows stay paused.

The web composer no longer calls `/resume` first, so one backend rule covers every client, and the message is durable before `resume` is sent.

Tests:

- The SMS case observes the fake Temporal signals `receive_user_response` and then `resume`.
- The HTTP case observes ACTIVE.
- Unit tests cover the parent guard, replacement pauses, signal failure, and non-pause statuses.
- `wf_user_message_alone_never_lifts_pause` pins the workflow contract. The existing `wf_pause_resume` and `wf_deployment_cold_states_do_not_poll` prove that `resume` wakes the run and that the continued run reaches `poll_new_messages`.

At 10k agents, every user message adds one indexed read. Only paused agents also take the per-agent advisory-locked transaction and send one Temporal signal. There is no fan-in.

Known gaps, not fixed here:

- **Benchmark coverage.** The benchmark harness stands in for the user with the internal API key, so no benchmark exercises this path.
- **Cost cap.** A cost-limited agent that the user then pauses is stored as PAUSED, and the workflow `resume` handler does not check `_cost_limit_reached`. Resuming it, already possible through `/resume`, can therefore continue past the cap while `run_agent` is still in its paused poll.
- **Prod agent.** `5c8b0ca4` is still paused; it needs one resume from the user.

## Human feedback

None recorded.

## Reusable lesson

When a user-facing state transition is implemented in one client, move it to the backend write path; otherwise every other channel silently skips it.
