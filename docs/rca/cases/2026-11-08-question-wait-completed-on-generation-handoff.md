---
id: 2026-11-08-question-wait-completed-on-generation-handoff
date: 2026-11-08
title: Cooperative deployment completed an unanswered question and caused a second send
surface: agents
component: send-message-to-user
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/send_message_to_user/handler.py emitted FINISHED and DEPLOY_INTERRUPTED during a live unanswered question without parking its original tool call
symptoms:
  - new code version deployed, retry this tool
  - why is the message to the user repeated twice on my screen
  - deploy completed an unanswered question instead of parking the original call
  - isWaitingForUser remains true on a FINISHED question
tags:
  - send-message-to-user
  - generation-handoff
  - duplicate-message
  - temporal
sources:
  - agent 6f2f4117-3ce9-4a41-88aa-d7cb36b6c571
  - commit 26f10d9a46b3424848be24230297cb55e4c1c7b3
  - commit 271d9ddbd9f0c1ea5789be0d21dd7b4f04046761
repro: agents/tests/blackbox/send_message_to_user.blackbox.py test_question_cutover_resumes_original_wait_without_republishing and agents/tests/blackbox/workflow.blackbox.py _test_question_cutover_rewaits_same_call_before_llm
status: fixed
---

## Problem

The WEB root agent asking for a Christmas-gift budget published a question at
2026-11-08T22:29:13.881Z, call 6d51ac01-8ef4-49a2-97c6-f83b637c4f52.
At22:31:04.720Z that call received a FINISHED TOOL row containing
`new code version deployed, retry this tool`, while its attention metadata
still had isWaitingForUser=true. At22:31:14.899Z a new call,
c6e2fd22-24d0-45ae-9c1a-27ec71b925b1, published the identical question.
These are distinct persisted sends, not one row duplicated by the frontend.
The production by-agent report endpoint returned report=null: no self-report.
Private API evidence is retained under .context/rca-6f2f4117; personal message
contents are intentionally excluded from this case and its fixtures.

## Diagnosis

Path: model question -> send-message handler -> published TOOL/attention row ->
cooperative worker handoff -> FINISHED retry result -> next model turn -> new
question call -> backend rows -> frontend displays both. The first incorrect
boundary is the handler completing already-published work during a live handoff.
It did not use the existing bounded pending-tool continuation mechanism.

What: the user sees the same unanswered question twice. Where: both handler
GenerationHandoffRequested catches. Why: they end the call and tell the model
to retry rather than continuing its outstanding wait. Proof: the captured
call IDs and terminal text, followed by the unchanged owning and real-Temporal
reproductions below. Problem: a cooperative continuation misclassifies an
outstanding external interaction as completed work. UI text deduplication would
hide the writes and could suppress legitimate repeated questions.

Searches included `new code version deployed retry this tool`,
`send_message_to_user duplicate deployment`, and `parked tool question wait deploy`.
The October2 cooperative-approval case and October1 browser/code continuation
case are relatives: different tools and first-bad boundaries. This question
handler never adopted their same-interaction continuation mechanism. H72's
November8 sticky-latch case is another relative, not the cause here.

Before editing the fix, the coordinator and independent investigator read
active bug work through boxes-read-threads, including Bug Fixes, browser report
runs, termination/auto-merge and Historical Benches. The termination owner
confirmed its PR1803 E2B goal/ws-server work did not own this failure. Historical
Benches confirmed H72's unread-user-message baseline fix did not handle deploy
handoffs and authorized integrating its commit271d9ddbd9. Its original
provenance, handler and real-Temporal regressions are preserved. The combined
fix additionally carries that original reply baseline across continuation
polls, so a late real reply cannot be skipped by a new context snapshot.
Folder listings did not expose folder membership; discovery used project-wide
active threads and actual full transcripts instead of claiming a complete
folder-only inventory.

## Solution

Use existing park_pending_tool/take_tool_resume to carry the original call,
reply mark, pinned inline view, SMS sent state and absolute fallback deadline.
The original chip stays open. AgentWorkflow already resumes parked calls before
its next model turn. Re-entry skips initial publication and notification, waits
for the original real reply, then finishes the same call. Both handoff catches
are unified; no string classifier, new polling, shared cache or UI workaround.
Existing refusal behavior is retained if generic parking rejects an oversized
combined checkpoint or a non-run-agent caller; this is not a claim to solve
that independently bounded fallback. The production PLAN question path uses
run-agent parking.

10k agents: constant-sized resume metadata per waiting question within the
existing256KB aggregate parking bound; existing per-workflow wake log and
signals; no new subscription, query, fan-in or per-agent polling. Existing15min
SMS fallback uses its original absolute deadline across repeated deployments.

Owning command (from agents):
`venv/bin/python scripts/run_blackbox_tests.py send-message-to-user`.
Before:27 original checks passed but the added cutover regression failed with
`deploy completed an unanswered question instead of parking the original call`.
After:28 checks pass, including two successive cutovers for WEB, immediate SMS,
after-SMS fallback, pinned view, deadline and a reply received between generations.
The test was run unchanged against H72-only handler271d9ddbd9 (RED,0.4s) and
combined handler (GREEN). Earlier pre-H72 RED/GREEN is retained separately.

The registered real-Temporal test exercises production AgentWorkflow with two
workers and a pushed generation handoff. H72-only handler produces an extra
FINISHED DEPLOY_INTERRUPTED row before any user reply (RED). Combined handler
keeps exactly one IN_PROGRESS row, migrates queues, makes no second model call
until the reply, and completes the same question on the new queue (GREEN).
Exact focused command:
`agents/venv/bin/python .context/rca-6f2f4117/workflow-repro.py`.
The scratch launcher invokes the permanent workflow.blackbox test; deploy's
agents coverage runner discovers both owning domains. Full selected deployment
gates and production rollout remain independently required; these focused
results do not substitute for them.

Golden invariants were read in OpenClaw's question-manager.ts:296-343 and
exec-approval-manager.ts:105-156 (preserve the pending interaction), Codex
core/src/session/mod.rs:3162-3197 (register request before publishing and await
the response under the same call), and Kimi askUserQuestionTool.ts:211-259
(bind session/agent/toolCallId to the interaction and await it). These support
the identity invariant, not a claim those projects implement Temporal handoff.
The fresh snapshot-scoped golden review is retained with the deploy approval
receipt; no prompt or schema text is changed.

## Human feedback

The user required reading other active Bugs and Bug Report work before editing,
matching actual evidence rather than titles, reconciling existing ownership,
and completing both RCA and deploy autonomously. The adjacent owner confirmed
its H72 repair may ship independently and that the new continuation behavior
needs its own snapshot-scoped review.

## Reusable lesson

Carry an unanswered external interaction and its original reply baseline across cooperative continuation instead of finishing it and asking the model to send it again.
