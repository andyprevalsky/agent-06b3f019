---
id: 2026-11-08-benchmark-auto-reply-lacked-question-identity
date: 2026-11-08
title: Benchmark auto-replies to distinct questions were identical provenance-free USER rows, so no_duplicate_messages failed the harness's own run
surface: harness
component: benchmark-poll-auto-reply
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py _poll_agent send_message_to_user auto-reply — posted the same canned USER text with no question identity per waiting row, while agents/benchmarks/context_validator.py _check_no_duplicate_messages treats same scope+role+text+metadata as a dual-write
symptoms:
  - "Context validation error: [no_duplicate_messages] Duplicate USER message at index 27 (first at 22): 'Please do not ask me anymore questions. I trust your judgment, intuition, and ab...'"
  - "Duplicate USER message at index"
  - "Please do not ask me anymore questions"
  - benchmark FAILED at 480 s with agent status ACTIVE and 6,720 s of a 7,200 s budget left
  - harness auto-reply posted twice
tags:
  - benchmark-harness
  - auto-reply
  - send-message-to-user
  - context-validator
  - no-duplicate-messages
  - idempotency
  - false-failure
sources:
  - agent 1ead79ec-bb9f-402e-bda8-6f4ac538ad96
  - fleet run 20261108-020323-2085136
  - benchmark run campaign-20261108-014912-1783796 job r003-j0011 (descend epoch22 build-boxing-payment r3, cluster H-69)
  - commit 72889c4389 (code under test)
repro: agents/tests/blackbox/benchmark.blackbox.py::test_auto_reply_to_two_distinct_questions_is_not_a_duplicate_message (+ test_auto_reply_answers_each_question_once_when_its_wait_is_re_emitted)
status: fixed
---

## Problem

Descend epoch22 `build-boxing-payment` r3 (agent `1ead79ec`, start_phase plan,
is_chat_mode false) failed at 480.1 s of its 7,200 s budget with the agent still
ACTIVE. The first failure reason was
`Context validation error: [no_duplicate_messages] Duplicate USER message at index 27 (first at 22): 'Please do not ask me anymore questions…'`.
The poll loop treats every error-severity context violation as an instant
FAIL (`run_benchmark.py` "Validate context well-formedness"), so the run was
ended by the harness's own message, not by the agent.

Runtime evidence (run.json messages): the root called `send_message_to_user`
twice with distinct toolCallIds — `ccdb255d…` at 02:21:55.786 ("What discount
should the Boxing and Muay Thai code apply…") and `9484ec27…` at 02:22:00.630
("Please specify the discount amount…"). The harness posted its canned reply
once per question (rows 22 at 02:22:00.015 and 27 at 02:22:05.205). Both
replies were byte-identical USER rows with `metadata: null`.

## Diagnosis

The parent's hypothesis (a planner deadline or Temporal activity retry
re-triggered the auto-reply) was tested and rejected: there were two distinct
questions, each answered once. The harness's per-row dedupe
(`replied_waiting_msgs`) worked.

Causal chain:
1. The auto-reply in `_poll_agent` posts the same canned text for every
   waiting `send_message_to_user` row and carries no identity of the question
   it answers.
2. `_check_no_duplicate_messages` fingerprints scope + role + text[:500] +
   metadata. The rule is documented as detecting dual-write failures. Two
   replies to two questions therefore had identical fingerprints.
3. The poll loop's fail-fast on context errors turned that collision into an
   immediate FAIL, with 6,720 s of budget left.

Why this was possible (Step 5a): the harness and the validator disagree on what
counts as one message. The harness writes semantically different messages
(answers to different questions) that look identical, and the validator can
only identify a message by its content. This is a harness-contract
inconsistency, not agent behavior. Any agent that asks twice under
is_chat_mode=false is failed by the harness's injected rows.

Sibling in the same producer: the reply was keyed by row id, but a question's
waiting state can be persisted on more than one row for one toolCallId. For
example, the deploy-handoff "Waiting for reply" row keeps
`isWaitingForUser=True`. The harness would then post a second canned reply to
the same question, which leaves a stray user message for the next wait to
consume.

Separate, upstream cause of the agent asking twice (not fixed here; reported as
an independent cluster). The first `send_message_to_user` returned
"User response received" after 213 ms ("User responded to send_message_to_user
request" at 02:21:55.908) with no user reply. The `receive_user_response`
signal at 02:14:12 ("Received user response (length=0)", the attachment post)
had set `workflow_instance._has_new_messages = True`, and nothing cleared it
before the question. The handler's
`wait_condition(lambda: _has_new_messages)` therefore returned immediately. The
agent saw no answer ("the tool is echoing the user's question back") and asked
again. The run's first-bad event remains the planner's 220 s deadline (no
compute leases, Foundry stall; H-24/E-02).

Archive searches: "no_duplicate_messages Duplicate USER message Please do not
ask me anymore questions auto-reply", "send_message_to_user returns immediately
stale _has_new_messages user response received without reply", and a grep for
`no_duplicate_messages` and the canned text in `docs/rca/cases/`. No prior case
matched, so this is novel.

Local repro (red, pre-fix at 72889c4389):
`python /var/tmp/rca-h69/run_h69.py <worktree>` runs the two blackbox
functions through the real `_poll_agent` against a scripted backend that stores
the harness's posts. Output:
`[no_duplicate_messages] Duplicate USER message at index 5 (first at 2): 'Please do not ask me anymore questions…'`.
Both tests FAIL with the same validator string as the incident.

## Solution

`agents/benchmarks/run_benchmark.py`:
- `post_message` accepts optional `metadata`, which is forwarded in the POST
  body. Existing positional callers are unchanged.
- The auto-reply is keyed by the question (`toolCallId`, falling back to the row
  id). It posts the unchanged canned text with
  `metadata.benchmarkAutoReply = {toolCallId, questionMessageId}`.

Replies to distinct questions are now distinct rows. A double-persisted copy of
one reply still collides and is still a `no_duplicate_messages` error; the test
asserts this. Re-emitted waiting rows for one question get exactly one reply.
The validator, task definition, canned text and timeouts are unchanged. The
backend accepts arbitrary USER metadata (`postMessageSchema.metadata`).
`benchmarkAutoReply` is not a signal-suppressing key (`isAgentAuthoredRow`) or
an idempotent kind, so delivery to the workflow is unchanged.

10k-agent behavior: one in-memory set entry and one POST per question per
polled run. No new queries, channels or shared state.

Golden reference: not applicable (no approval-gated hunk; benchmark harness
code only).

Post-fix: the identical command passes both tests, 5 of 5 consecutive runs.
The tests are registered in `benchmark.blackbox.py` `run_all_tests`, which the
deploy agents blackbox and coverage gate runs.

Outcome gate: the exact benchmark was not rerun locally for this RCA. The
duplicate needs the nondeterministic double question, and the same run also
fails on the independent planner-deadline cluster (H-24/E-02). Treat the
outcome as pending the next descend epoch rerun.

## Human feedback

None recorded.

## Reusable lesson

Give every harness-injected message the identity of the event it answers, so a content-based duplicate check can tell two answers to two questions from one answer written twice.
