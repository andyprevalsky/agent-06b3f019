---
id: 2026-10-21-start-execution-discarded-submission-result
date: 2026-10-21
title: Start Autonomous Execution discarded its submission result and allowed repeated clicks
surface: front-end
component: attention-message-action
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: useMessageListState.handleSendMessage discarded the submission Promise and AutonomousExecutionButton had no request lifecycle
symptoms:
  - Start Autonomous Execution does nothing
  - Start Autonomous Execution remains enabled while POST is pending
  - Failed to send message logged without visible error
  - two identical autonomous execution USER messages five seconds apart
tags:
  - autonomous-execution
  - submission-feedback
  - duplicate-request
sources:
  - commit 56a3ada9b
  - agent 5d9ff625-60fa-4bf6-8288-503266d50ee6
  - agent ph7erx59v4y5qfrxncmmtzzkfn8gngm8
repro: front-end/src/tests/blackbox/start-autonomous-execution.blackbox.tsx
status: fixed
---

## Problem

The screenshot-matched End world hunger agent persisted the exact button prompt
twice at 07:10:12.689 and 07:10:18.197 UTC on October 21. Its attention finished
at 07:10:13.149 and research agents began at 07:10:30, so the backend did receive
and act on the instruction. The screenshot at 00:10:20 PDT still showed the
unchanged waiting button. Whether its FINISHED realtime event reached that
browser remains open in `2026-10-21-start-execution-client-delivery-not-captured`.

A separate, locally reproduced defect made the action appear inert: there was
no pending or acknowledged state and errors only reached console.error. The
same button remained clickable during the HTTP request and after acceptance.
The local tests reproduce that feedback/reentry boundary; they do not claim to
reproduce the original browser's missing realtime update.

## Diagnosis

Critical path: AttentionMessage button -> AttentionMessageWrapper ->
useMessageListState.handleSendMessage -> useAgentMessaging.sendMessage ->
postAgentMessage -> POST /api/agents/:id/messages -> durable USER row ->
agentMessageService.routeUserMessage -> receive_user_response / chat handler.

The HTTP wrapper returns a Promise and rejects on failure. The message-list
callback consumed rejection with console.error and returned void, so its action
owner could neither await acceptance nor display failure. AutonomousExecutionButton
also had no request state. The contract was broken at the action-result boundary,
not in the backend transition. A hypothetical missing-auth or failed-backend
explanation conflicts with the captured USER rows and continued workflow.

The permanent blackbox suite invokes the real MessageList button, real context
messaging hook and HTTP wrapper. MSW delays the actual request boundary or returns
503. It uses only a jsdom session fixture, never a real/fabricated browser login.

Identical command before and after production changes:

`NODE_OPTIONS=--max-old-space-size=512 /home/boxes/rose/node_modules/.bin/vitest run src/tests/blackbox/start-autonomous-execution.blackbox.tsx --maxWorkers 1 --no-file-parallelism`

Run from the isolated worktree's front-end directory. RED: 2 failed, 1 passed,
9.75s. The pending case failed `expect(element).toBeDisabled()` with "Received
element is not disabled". The HTTP-failure case failed "Unable to find
role=alert". GREEN: 3 passed, 4.52s. The unchanged assertions cover disabled
pending state, one POST, acknowledgement, visible error and explicit successful
retry. The third path replays captured IN_PROGRESS and FINISHED rows and verifies
the waiting indicator and button disappear. Logs remain in the isolated worktree
as red.log and green.log. Existing message-bubble and message-list suites
passed 57/57 in 7.91s. Targeted type-aware ESLint at the coordinated 512MB
heap limit exited 134 with V8 heap exhaustion; lint/typecheck remain pending
the parent combined validation, not reported as passing.

Archive searches: `Start Autonomous Execution` and `button does nothing continue
working after your reply`, plus `autonomous button` and `continue working after
your reply`. Results were relatives, not a proven recurrence. The prior
2026-10-01 SMS pause/resume case was read in full; its backend fix is present.

Golden reference: `codex/codex-rs/tui/src/chatwidget/questions.rs:149` submits a
question answer through its normal user-message path and accepts it only if
submission succeeds. `openclaw/ui/src/pages/chat/chat-send-support.ts:299`
surfaces terminal delivery failure in the owning pane. The fix converges on
acknowledgement and visible failure at the action owner.

## Solution

Return the original send Promise from useMessageListState and preserve its type
through MessageList and MessageBubble props. The button owns idle/sending/sent
state, disables reentry while pending and after acceptance, labels only HTTP
acceptance as Request sent, and displays rejected submission errors with a
retryable enabled button. The existing FINISHED event still removes the action.
No backend, workflow, schema, autonomous prompt, or tool semantics changed.

This unifies result ownership instead of adding a second send API or retry
layer. There is no automatic retry, polling, added network request or per-agent
background state; work is constant per visible action. On 10k agents only mounted
actions hold local React state. The suite is discovered by vitest.config.ts's
blackbox include and the frontend test:coverage deploy gate. Parent owns combined
validation and deploy. No deploy was performed by this investigator.

## Human feedback

Andy required the actual button-to-backend investigation, preserving Freedom,
login, browser and 3905 preview, and prohibited speculative auth diagnoses.
The parent required the separately reproducible feedback/reentry defect to be
fixed while retaining the unresolved screenshot-session delivery gap explicitly.

## Reusable lesson

Return submission results to the initiating action so it can block reentry and show acceptance or a retryable error without depending on realtime delivery.
