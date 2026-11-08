---
id: 2026-11-08-send-message-to-user-question-wait-read-sticky-message-latch
date: 2026-11-08
title: send_message_to_user questions waited on the sticky _has_new_messages latch, so a message read before the question (or any agent event) "answered" it
surface: agents
component: send-message-to-user
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/send_message_to_user/handler.py SendMessageToUserManager.execute_tool — the question's wait_condition read workflow_instance._has_new_messages, a boolean latch that receive_user_response, agent messages, background notifications, aborts and response-schema admission all set and nothing in the run loop clears, instead of the per-event wake log with the LLM context-snapshot baseline (helpers/wait_wake.py) that wait_for uses
symptoms:
  - "User response received" right after "Attn: User" with no user reply
  - "User responded within timeout, no SMS needed" in the same millisecond as "Non-SMS goal, waiting for response with SMS fallback timeout"
  - Received user response (length=0)
  - "the tool is echoing the user's question back to me instead of providing a real reply"
  - agent asks the same send_message_to_user question twice
tags:
  - send-message-to-user
  - question
  - wait-wake
  - temporal-signal
  - receive-user-response
  - false-completion
  - attachments
sources:
  - agent 1ead79ec-bb9f-402e-bda8-6f4ac538ad96
  - fleet run 20261108-020323-2085136
  - benchmark run campaign-20261108-014912-1783796 job r003-j0011 (descend epoch22 build-boxing-payment r3, cluster H-72; found by H-69 on rca/h-69-20261108 @ aa34445e74)
  - commit 72889c4389 (code under test)
repro: agents/tests/blackbox/workflow.blackbox.py::_test_question_ignores_user_message_read_before_it (+ _test_question_ignores_agent_message_while_open, agents/tests/blackbox/send_message_to_user.blackbox.py::test_handler_question_reply_baseline_is_the_context_snapshot)
status: fixed
---

## Problem

Descend epoch22 `build-boxing-payment` r3 (root `1ead79ec`, PLAN phase, WEB
source). The benchmark posted the goal, then six PDF attachments as an empty
USER message: seven USER rows with `textLength=0` at 02:14:12.314–.323 and one
`Received user response (length=0)` signal at 02:14:12.378 (worker.log line 50).
Seven minutes later (after a 220 s planner deadline), the root's first
`send_message_to_user` question `ccdb255d` ("What discount should the Boxing and
Muay Thai code apply…") was posted at 02:21:55.786. Worker log, same span:
`Non-SMS goal, waiting for response with SMS fallback timeout` 02:21:55.908192,
`User responded within timeout, no SMS needed` 02:21:55.908401, `User responded
to send_message_to_user request` 02:21:55.908506; the dispatch took 213 ms. The
FINISHED row "User response received" was written at 02:21:55.936; no USER reply
existed (the harness auto-reply came at 02:22:00.015). The model saw
`User response received: <its own question>` and reasoned "the tool is echoing
the user's question back to me instead of providing a real reply", then asked
again (`9484ec27`, 02:22:00.630). That second question also returned at once
(223 ms), consuming the reply to the first. In production, a user's question can
"complete" with no answer.

## Diagnosis

Path: user/benchmark POST message (+attachments) → backend `routeUserMessage` →
`receive_user_response("")` (plain string) → workflow sets
`_has_new_messages = True` and records a `user_message` wake → run loop polls
(`_poll_messages` → `note_context_snapshot`) and the model reads the rows →
LLM turn calls `send_message_to_user(is_question=True)` → handler parks on
`wait_condition(lambda: _has_new_messages)` (15 min SMS fallback, then step 5)
→ FINISHED "User response received" → model context.

Flag lifecycle (code at 72889c4389): set by `receive_user_response` (legacy
plain path and `_record_response_schema_feedback`, which also runs for
request-id attention responses), `_admit_durable_response_schema_feedback` (polled
USER rows), `_accept_agent_message_signal` (agent messages), background
notification paths, and `_abort_run`; restored across continue_as_new. Cleared
only by `_wait_for_messages` (the paused-loop wait), by request_user_signup and
by the question handler itself after its wait. In a normal running loop nothing
clears it, so one user message at any earlier time leaves it True until the next
question, which then returns immediately. The question's predicate therefore
meant "anything happened since the last question/pause", not "the user replied".

Binary search: the signal and row were correct data (a real user post). The
model context was correct (it had read the attachment rows). The first bad point
is the handler's predicate: it read a run-global latch instead of an event that
post-dates what the model saw.

Why 1: the question returned because `_has_new_messages` was already True.
Why 2: the latch is sticky and kind-agnostic; every producer sets it and the
running loop never consumes it. Why 3: the workflow already has the correct
primitive for "an event the model has not seen" — the bounded wake log with the
context-snapshot baseline (`helpers/wait_wake.py`, used by `wait_for`) — but the
question wait predated it and was never moved onto it, so two waits for the same
user-message event used different contracts. Why 4 would be "replace the latch
everywhere" (pause loop, signup, continuation state): a broader refactor of
consumers that are not user-reply waits; stop at Why 3.

Siblings the same fix removes (both proven red at 72889c4389): an agent message
(`receive_agent_message`) while a question is open returned "User response
received" with no reply; background-agent notifications and aborts set the same
latch. The truthful tool result is unchanged text; what was untruthful was
emitting it without a reply.

Archive searches: `"send_message_to_user User response received returned
immediately without reply _has_new_messages"`, `"question wait returns instantly
stale flag user message signal before question asked again"`, and greps for
`_has_new_messages|receive_user_response` and `wait_baseline|wake_mark` in
`docs/rca/cases/`. Relatives only: 2026-11-07 browser OTP row routed as owner
user input (H-62, backend routing gate; unchanged here, it still decides which
rows produce a `user_message` wake) and 2026-10-01 SMS reply left the agent
paused (`receive_user_response` sets the flag but never resumes; unchanged).
Novel boundary.

Local repro (red, 72889c4389 + the new tests only):
`agents/venv/bin/python /var/tmp/rca-h72/run_h72.py /home/boxes/rca-H-72` runs
the two registered workflow.blackbox functions in a real Temporal time-skipping
`WorkflowEnvironment` with the suite's mock activities and scripted LLM. The
root starts with `start_signal=receive_user_response("")` (before the first
poll), the scripted PLAN turn asks one question, then the test settles 1 s
(queries + wall clock; workflow timers do not advance) before replying. Output:
`FAIL wf_question_ignores_user_message_read_before_it: send_message_to_user
returned ['User response received'] with no reply: the pre-question
user-message signal satisfied the question's wait` and `FAIL
wf_question_ignores_agent_message_while_open: … an agent message satisfied the
question's wait` (RESULT 0/2). The control without a pre-question signal stayed
open until the agent message, isolating the signal as the cause.

## Solution

`agents/domains/send_message_to_user/handler.py`: at the start of
`execute_tool`, read `reply_mark = wait_baseline(workflow_instance)` (the context
snapshot of the poll feeding the asking LLM turn). Both question waits (the
15 min SMS-fallback wait and the indefinite wait) use
`first_wake(wi, reply_mark, {"user_message"}) is not None`. The handler no
longer reads or clears `_has_new_messages`. A user message the model already
read never answers; one sent while the model was deciding to ask answers at
once (same contract as `wait_for`); agent messages, notifications and aborts do
not answer (a kill still ends the step through the existing interrupt path,
and only depth-0 roots block on questions, which kill_agent cannot target).
Model-visible text is unchanged ("Attn: User" / "User response received" /
question text); no prompt, schema or Zod change.

Post-fix: the identical command prints `PASS` for both tests, 5/5 consecutive
runs. Registered in `_run_all_workflow_tests` (full `workflow` domain: 337
passed, 179.6 s) and the handler contract test in `send_message_to_user`
`run_all_tests` (5/5). Both run in the deploy agents blackbox / coverage gate.

Temporal determinism: the predicate reads only workflow state (wake sequence
ints); no wall clock, randomness or new activities. The handler is on the
replay surface (`scripts/agent_workflow_surface_hash.py --list`), so the change
rolls a new worker generation and old histories are not replayed by this code.

10k-agent behavior: per check, a scan of at most 50 in-memory wake events of one
agent; no new state, queries, signals, channels or locks. It removes the extra
LLM turn and duplicate question per false completion.

Golden reference: not applicable (no approval-gated hunk). For context,
claude-code-src/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:155-241
builds its result only from the answers its own permission dialog collected;
binding the answer to events after the asking turn converges on that.

Outcome gate: the exact `build-boxing-payment` benchmark was not rerun locally.
The run's first-bad event remains the independent planner deadline (H-24/E-02),
so the benchmark outcome is pending the next descend epoch.

Residual: `_has_new_messages` is still set by every producer and read by the
paused-loop wait and `request_user_signup` (not in either phase tool list); the
signup wait has the same stale-latch shape. A poll run from a signal handler
during the asking LLM turn (`_receive_rejection_schema_feedback`) can move the
snapshot past an unread reply, as for `wait_for`.

## Human feedback

None recorded.

## Reusable lesson

A wait for "the user replied" must compare against the event log as of what the model last read, never a run-global boolean that unrelated producers set and nothing clears.
