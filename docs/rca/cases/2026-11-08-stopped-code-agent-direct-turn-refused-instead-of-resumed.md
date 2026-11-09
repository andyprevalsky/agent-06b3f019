---
id: 2026-11-08-stopped-code-agent-direct-turn-refused-instead-of-resumed
date: 2026-11-08
title: A user message to a stopped code agent returned 409 instead of resuming its persistent session
surface: cross
component: claude-code-direct-chat
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/claude-code/directChatService.ts requireOwnedLiveSession — any non-ACTIVE session threw 409 CODE_SESSION_CLOSED although the session is persistent and resumable
symptoms:
  - "This code session has finished. Ask Rose to continue the work."
  - "409 CODE_SESSION_CLOSED POST /api/claude-code-session/:taskId/turns"
  - message to a paused / completed code agent errors in the code-agent view composer
  - "completed browser and code agents cannot be messaged"
tags:
  - code-agent
  - direct-chat
  - persistent-session
  - resume
sources:
  - plan:back-end/src/domains/claude-code/directChatResume.ts
repro: back-end/src/tests/blackbox/claude-code-direct-chat.blackbox.ts ("a message to a stopped code agent resumes it instead of failing"); agents/tests/blackbox/agent_control.blackbox.py (user_message_resumes_completed_code_task); front-end/src/tests/blackbox/code-agent-resume-on-message.blackbox.tsx
status: fixed
---

## Problem

Typing in the code-agent view of a code agent that had stopped (its run ended
paused/idle, completed or failed) failed with "This code session has finished.
Ask Rose to continue the work." The user expects the session to unpause and
pick up where it left off, with the container's progress shown beside the
message's time.

Local repro (backend blackbox, real ws-server, mocked persistence): POST
`/api/agents/:id/code-agent/<closed task>/messages` with a paused background
code task under a running owner → `expected: 200, actual: 409`
(`CODE_SESSION_CLOSED`).

## Diagnosis

- FE `useDirectTurn` → POST `/claude-code-session/:taskId/turns` →
  `sendDirectTurn` → `requireOwnedLiveSession`, which threw 409 for any session
  whose status is not ACTIVE or that has no stream URL (directChatService.ts).
- The resume machinery already existed, but only for agent senders: the owner
  workflow's `receive_agent_message {wake_task_id, continue_conversation}`
  starts the task's next run; the persistent CodeSession resumes the paused
  sandbox and the CLI continues its conversation (`--resume`) with the
  message as its next turn. The direct-chat path never used it.
- The workflow refused every completed/failed code task
  (`background_message_refusal`), a rule written for model senders, so even a
  wired wake would have refused a completed code agent.
- The FE view was keyed by one task id; a resumed run gets a new task id
  under the same spawn tool call, so its output would not appear in the open
  view.

## Solution

- Backend `directChatResume.ts`: a turn to a stopped session never refuses. The
  routing is:
  - A later live run of the spawn takes the turn.
  - If a resume is already starting, the turn is queued in the spawn's startup
    row (`startupTurns.ts`, with a person variant that carries the turn's own
    id, files and settings).
  - If the owner is running, its background code task is woken
    (`receive_agent_message` with `from_user`, `continue_conversation` and
    attachments).
  - Otherwise (owner finished or paused, or a foreground spawn),
    `CodeAgentResumeWorkflow` runs the existing spawn manager on the stopped
    session's `code_session_id` with the same tool call id. The CLI continues
    with `--resume`.
  - Every path answers `queued` and persists the turn row with
    `resume_requested` after its run is started.
- Agents: a `from_user` wake may resume a completed or failed code task, and its
  attachments are forwarded. A refused user wake posts a UI-only ERROR row so the
  turn reads "Couldn't resume: <reason>". The new workflow is registered beside
  AgentWorkflow and included in the replay-surface hash.
- FE: `queued` is a successful send. Runs of one spawn are merged into the open
  view. `UserBubble` shows the time plus resume state (Resuming… / Starting
  container… / Delivered / Couldn't resume), derived from the spawn's rows.
- Round 3: supervised runs write under `code-resume:<agent>:*`, which the
  backend binds to the owner's live generation (`codeResumeGeneration.ts`). The
  run gets a pause signal (sent by the owner's pause), a generation handoff
  (continue-as-new carrying the drained session), and on any failure a
  "could not resume" row plus a non-retryable failure. A refused or failed
  resume ends the in-flight marker, and queued turns are kept. `cli_settings`
  on the create request applies the person's model, effort and speed to the
  first resumed turn. A paused background browser resumes from the Browser
  composer (the turn goes to the run's inbox and wakes the owner with
  `continue_conversation`). Rose agents get `resumedFrom`, so their bubbles
  show a resume status too.
- 10k agents: per typed turn there is one owner lookup, one ephemeral marker and
  one signal or workflow start. Nothing fans in and nothing polls.

## Human feedback

User (2026-11-08): "when I send a message to an agent that has stopped working,
it shouldn't error, it should just unpause the session and pick back up where it
left off (the state of the container coming back online should be reflected in
the user message next to the timestamp)".

## Reusable lesson

When a resource is persistent and resumable, a user action against its stopped
state must route through the existing resume path rather than refusing as if it
were destroyed; check for a resume mechanism that only another caller type uses.
