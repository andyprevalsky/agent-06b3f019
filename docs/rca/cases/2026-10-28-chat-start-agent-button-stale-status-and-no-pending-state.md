---
id: 2026-10-28-chat-start-agent-button-stale-status-and-no-pending-state
date: 2026-10-28
title: Chat "Start agent" button never showed after a follow-up on a finished run (reactivation not broadcast) and gave no click feedback
surface: cross
component: chat-mode-actions
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/agents/agentMessageService.ts routeUserMessage — clearWorkflowForTerminalAgent set the row ACTIVE with no workflow but broadcast nothing, so clients kept the finished run's COMPLETED/FAILED status that ChatModeActions is gated on
symptoms:
  - start agent button is laggy and shows inconsistently
  - Start agent button missing after a chat reply
  - Start agent button only appears after reload
  - Failed to start agent / Agent is already in agent mode after clicking Start agent twice
  - Start agent click does nothing for seconds
tags:
  - chat-mode
  - realtime
  - agent-status
  - rose-desktop
  - mac-app
sources:
  - task Andy Mac-app report 2026-10-28 start agent button is laggy and shows inconsistently
repro: front-end/src/tests/blackbox/chat-mode-start-agent.blackbox.tsx; back-end/src/tests/blackbox/chat-reasoning-identity.blackbox.ts (follow-up-after-completed-run)
status: fixed
---

## Problem

The chat-mode "Start agent" action under a chat answer (ChatModeActions) is
shown only when the last row is a FINISHED send_message_to_user, nothing is
streaming/animating, and the client's `agent.status === 'ACTIVE'`.

1. Inconsistent visibility: after a cloud run ends (COMPLETED/FAILED/...), the
   client restores chat mode but keeps the terminal status. A follow-up message
   makes the backend clear the dead workflow and set the row ACTIVE
   (`clearWorkflowForTerminalAgent`), but no realtime UPDATE was sent and the
   composer does not refetch detail, so the client status stayed COMPLETED and
   the button never appeared until a reload or reselect. Fresh chat agents
   (status ACTIVE from the create response) did show it, hence "inconsistent".
   Backend blackbox on main saw only INSERT/ASSISTANT_STREAM/ATTENTION_STREAM
   frames, no UPDATE; the FE provider replay of that exact frame sequence kept
   the button absent for 3 s+ (indefinitely).
2. Laggy: clicking ran `POST /start-agent`, which awaits a Temporal workflow
   start + DB write before `AGENT_MODE_STARTED`; the button showed no pending
   state and stayed clickable, so a second click POSTed again and the backend
   answered 400 "Agent is already in agent mode" (toast "Failed to start agent").

## Diagnosis

Path: POST /api/agents/:id/messages → routeUserMessage → clearWorkflowForTerminalAgent
(DB ACTIVE) → handleChatMessage → INSERT broadcasts → FE AgentProvider
(`agent.status` only changes via UPDATE frames or a detail snapshot) →
MessageList.computeChatModeActionsVisible (`agentStatus === 'ACTIVE'`).
The first wrong data is the client agent status after reactivation: the DB is
ACTIVE, the client is COMPLETED, because the state change was never published.
Relative of 2026-10-07-composer-chat-mode-required-explicit-workflow-id (same
class: client state that only changes from a realtime field nobody sends).

## Solution

- Backend: after a successful chat reactivation, broadcast UPDATE
  `{status: 'ACTIVE', temporalWorkflowId: null}` on `agent:<id>` (and the tree
  bus) before the chat turn streams. One frame per follow-up on a finished run,
  on the existing per-agent channel; O(1) per agent at 10k agents.
- Front-end: ChatModeActions enters STARTING on click (disabled,
  "Starting agent…", one POST), returns to IDLE on failure, and unmounts when
  AGENT_MODE_STARTED leaves chat mode.
- Regressions: FE `chat-mode-start-agent.blackbox.tsx` (real AgentProvider +
  MessageList, realtime callbacks) and backend `chat-reasoning-identity`
  case `follow-up-after-completed-run` (asserts the UPDATE precedes the answer INSERT).

## Human feedback

None recorded.

## Reusable lesson

When a server write changes a field the UI gates on, publish it on the realtime channel the UI already consumes; never rely on a later snapshot to correct client state.
