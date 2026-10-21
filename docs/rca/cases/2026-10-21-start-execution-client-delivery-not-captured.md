---
id: 2026-10-21-start-execution-client-delivery-not-captured
date: 2026-10-21
title: Start Autonomous Execution resumed the matched workflow but client delivery remains unproven
surface: cross
component: attention-message-dispatch
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: Unproven client delivery or rendering boundary; matched USER writes and workflow continuation succeeded
symptoms:
  - Start Autonomous Execution does nothing
  - Your Rose agent will continue working after your reply
  - Preview Mode
  - Ending hunger worldwide requires coordinated action over years
tags:
  - autonomous-execution
  - preview
  - message-dispatch
  - evidence-gap
sources:
  - commit 56a3ada9b
  - agent ph7erx59v4y5qfrxncmmtzzkfn8gngm8
  - agent 5d9ff625-60fa-4bf6-8288-503266d50ee6
repro: none-recorded
status: mitigated
---

## Problem

Andy reported that the outlined Start Autonomous Execution button did nothing
in the public frontend preview. The supplied screenshot shows the answer
"Ending hunger worldwide requires coordinated action over years", an amber
"Your Rose agent will continue working after your reply" indicator, the button,
and Preview Mode / Open Mac App. It contains no agent ID or network result.
The preview serves the local frontend on port 3905 and uses the production
backend; it is not a staging backend.

A read-only snapshot of the existing preview browser tab on 2026-10-21 showed
the signed-out landing page with Login and no Start Autonomous Execution
button. This is the current evidence boundary, not proof of the original cause.
Existing local backend/worker log files were dated October 8, so they cannot
establish this October 21 click's outcome. No production mutation, sign-in,
browser navigation, restart, deployment, or migration was performed.

Production was queried through the repository read-only helper using the
complete backend env, explicit BEGIN READ ONLY / ROLLBACK and bounded statement
timeout. The user-scoped seven-day hunger search found one matching root:
`5d9ff625-60fa-4bf6-8288-503266d50ee6`, goal `End world hunger`, created
07:03:41.196 UTC. Its exact attention sentence matches the screenshot.

Observed persisted sequence on 2026-10-21 (UTC):

- 07:04:33.390: IN_PROGRESS attention message `918e31f6-94cd-4d2d-a091-27c90e189caf`.
- 07:10:12.689: exact button prompt USER row `0dd4d0bc-9a82-49db-9b0b-6e3ccf761918`.
- 07:10:13.149: FINISHED attention row `e700a18c-143a-42b7-a4cf-52df49cf59aa`, same
  toolCallId `90c73163-57a2-4b8d-8095-01f78cdeb19f`, title `User response received`,
  `isWaitingForUser: false`.
- 07:10:18.197: second exact button prompt USER row `61c69542-f964-4972-aadd-60f25033e724`.
- 07:10:30.271 through .656: four research `spawn_agent` calls began in the same
  workflow generation. These were existing production actions, not investigator launches.

The two USER rows prove dispatch and persistence, and the terminal attention plus
research calls prove the workflow continued. They do not prove which browser
displayed or received each realtime event. The screenshot timestamp 00:10:20 PDT
falls after the persisted FINISHED row; it still shows the waiting button.

## Diagnosis

The screenshot identifies the waiting AttentionMessage route. On the examined
source, the path is:

1. `AttentionMessage` button invokes `AttentionMessageWrapper`'s fixed
   AUTONOMOUS_EXECUTION_PROMPT callback.
2. `MessageList` supplies `useMessageListState.handleSendMessage`, which invokes
   `ctx.sendMessage`. Its rejected promise is logged to console only.
3. `useAgentMessaging.sendMessage` reads the selected agent ref and invokes
   `postAgentMessage` -> `lib/api/messages.postMessage`.
4. The frontend sends POST `/api/agents/:id/messages` with `{message}` and auth
   headers. This is not a dedicated start-execution API or a button that just
   populates the composer. There is no Preview Mode check in this dispatch path.
5. `routes.messages.ts` authenticates and validates; `agentMessageService.postMessage`
   checks ownership, persists a USER row, and calls `routeUserMessage`.
6. With a live workflow, `deliverUserMessageToWorkflow` signals
   `receive_user_response` then lifts a user pause when appropriate. Without a
   live workflow, it starts `handleChatMessage`. The workflow's plain-text
   signal branch sets `_last_signal_response` and `_has_new_messages`.

The runtime evidence rules out a failed message submission or a workflow that
never woke for these two persisted button clicks. The earliest remaining
unproven boundary is delivery of the FINISHED attention to the screenshot's
browser, followed by rendering that event. The original HTTP status/body and
browser realtime/console trace were not captured. Console-only rejection handling
is an observed code property, not an established cause of this incident.

Archive searches executed before hypotheses: `Start Autonomous Execution` and
`button does nothing continue working after your reply`; additional archived
searches use `autonomous button` and `continue working after your reply`.
The search is token-ranked and returned relatives, not an exact proven recurrence.
The full 2026-10-01-sms-reply-left-user-paused-agent-paused case was read; its
backend delivery fix is present here, so that prior diagnosis cannot be reused
without new runtime evidence.

Golden reference: `codex/codex-rs/tui/src/chatwidget/questions.rs:149` routes a
question answer through ordinary user-message submission and only accepts the
answer after submission succeeds. This is a submission analogue, not evidence
for Rose's HTTP or Temporal outcome. No production fix was selected.

## Solution

The submission-feedback aspect is mitigated by the separately proven client fix;
the original realtime-delivery cause remains open. The offline dispatch coverage in
`front-end/src/tests/blackbox/start-autonomous-execution.blackbox.tsx` exercises
the real visible button, context hook, and HTTP wrapper against an MSW-owned
endpoint. It is a baseline test, not the missing RED-to-GREEN incident reproduction.
It is discoverable by the existing Vitest blackbox include and frontend coverage
gate. A separate submission-feedback defect is fixed in
`2026-10-21-start-execution-discarded-submission-result`; that fix does not prove
why the original browser lacked its FINISHED event. No backend, prompts, schemas,
or workflow semantics were changed.

Required next evidence is the screenshot session's received realtime events,
console errors and rendered state around 07:10:13–07:10:20 UTC. Correlate the
FINISHED row and toolCallId above with that client capture before choosing a fix.
The affected agent is now identified; missing auth/ID is not the diagnosis.
Reproduce the resulting first-bad boundary in its owning
suite, observe RED, and run the identical test GREEN after the fix. Parent owns
canonical integration, combined validation, and deployment.

## Human feedback

Andy explicitly required investigating the actual button through HTTP and the
backend workflow rather than UI cosmetics. Missing task ID or current auth is
not an acceptable root cause. Preserve Freedom, browser/login state and the
3905 preview; use an isolated sparse worktree, coordinate memory-heavy tests,
and leave the parent's dirty files and deployment ownership alone.

## Reusable lesson

Capture the actual button request and owning workflow before attributing a no-op to authentication, preview mode, or client error handling.
