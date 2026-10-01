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

The user paused prod agent `5c8b0ca4` at 17:19:41Z ("Agent paused by user"). At 19:17:01Z they texted "Skip DoorDash entirely. Buy the newest AirPods Pro…". The SMS supervisor's `reply_to_agent` posted that USER row (`metadata.source = sms_supervisor`), and Render logged `Posted USER message` and `Signaled workflow`. The agent still showed PAUSED. The live workflow's `is_paused_query` returned `true`. Its history held exactly one signal after the pause, `receive_user_response` at 19:17:01.377Z, followed by `poll_new_messages`, `set_response_schema_activity`, and an idle loop of 30-second handoff timers. No `resume` signal ever arrived.

## Diagnosis

In the workflow, the `receive_user_response` signal only sets `_has_new_messages` and refreshes the response schema; it never clears `is_paused`. The paused wait, `_wait_for_unpause_or_handoff`, only exits on `resume`, which is the single path that clears `is_paused`. So nothing could wake the agent until something sent `resume`. `commitReplyToAgent` did three things: it created the message, sent `receive_user_response`, and resolved attention. It had no resume step, and the supervisor has no resume tool, so the model could not work around it. The deepest owned cause is a split contract: the rule "a user message to a paused agent resumes it" lived only in the web composer (`useMessageSending.ts` called `/resume` before posting). It was missing from the backend, so every non-web channel missed it. That includes the SMS/WhatsApp supervisor and `POST /api/agents/:id/messages` from the public API or older clients. The client also called `/resume` before the message existed, which raced the message. On the old code, the new blackbox case failed with `Expected an SMS reply to resume the PAUSED agent, status is still PAUSED`, and the HTTP case failed with `a user message must resume the agent, got PAUSED`. Searches of the archive for pause, resume, and SMS reply found no prior case at this boundary.

## Solution

`resumePausedAgentForUserMessage` in `providers/agentResume.ts` reuses the locked `recordWorkflowResumeIntent` transition. It acts only when that transition durably moved a user pause (`PAUSED`, or a replacement whose prior status was `PAUSED`) to ACTIVE. In that case it signals `resume`, and if the signal fails it rolls the status back with the same logic as the `/resume` route. Cost-limit and out-of-credit stops are left alone. The helper never throws into the send path. Two callers use it, both after the message is durable and signaled: `commitReplyToAgent` and `postMessage`, the latter only for user-authenticated USER rows. Internal USER injections such as OTP relays and response-schema context rows stay paused. The web composer no longer calls `/resume` first, so one backend rule covers every client and ordering is message, then resume. With the fix, the SMS case observes the fake Temporal signals `receive_user_response` then `resume`, and the HTTP case observes ACTIVE. At 10k agents, each user message adds one per-agent advisory-locked transaction and, only for paused agents, one Temporal signal. There is no fan-in.

## Human feedback

None recorded.

## Reusable lesson

When a user-facing state transition is implemented in one client, move it to the backend write path; otherwise every other channel silently skips it.
