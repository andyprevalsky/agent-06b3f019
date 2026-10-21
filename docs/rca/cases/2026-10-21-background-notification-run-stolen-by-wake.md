---
id: 2026-10-21-background-notification-run-stolen-by-wake
date: 2026-10-21
title: A background wake stole the completing run's notification identity
surface: harness
component: background-agent-completion
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/background_agents.py _finish_background_task reread the mutable task map after awaiting a tree update
symptoms:
  - First completion notification labelled backgroundRun 2
  - Actual second completion emitted no notification
  - background-agent-message-smoke failed inside deploy smoke
tags:
  - background-agents
  - agent-messaging
  - notifications
  - race
sources:
  - benchmark run 33c07792-4992-446b-bfe2-f2b3f9875181
  - agent 2582f068-d298-45b3-a242-e7d86324c9c1
  - task call_xxgJWwwAFhDj3TbVaGgGi8nM
repro: agents/tests/blackbox/background_agents.blackbox.py test_background_completion_notification_keeps_its_run_when_woken_during_tree_update
status: fixed
---

## Problem

The second complete local deploy smoke returned 10/11 fresh tasks passed. The
new `background-agent-message-smoke` failed at 112.7 seconds. Its root did
forward the user feedback to the same explore task, and that task ran again and
returned the required marker. The failure was genuine: it did not receive one
terminal notification for each run.

At 20:18:07.935 UTC, the first explore run finished. The user feedback was
persisted at 20:18:07.868, the first completion notification at 20:18:08.290,
and the send result at 20:18:08.411 reported `woke: true`. The notification
already carried `backgroundRun: 2`, despite containing the first run's answer.
The second explore run then made new web-fetch progress and finished at
20:18:15.609, but no second `agentNotification` row appeared. The root's final
answer included the marker. These observations are preserved in the original
run JSON, worker log and `.context/a2a/background-message-failed-full-smoke-transcript-20261021.json`.

## Diagnosis

The critical path is first-run activity completion → owner task state change →
tree-state update → first notification write, racing with inbox delivery →
finished-task wake → second-run state. `_finish_background_task` moved its
record to the finished map, then awaited `_update_tree_state()`. During that
await, `_wake_background_task` installed run 2 under the same task ID. The
completing coroutine then called `_background_run(task_id)`, which read the
new mutable run-2 record. It wrote the first notification with run-2 metadata
and the run-2 idempotency key. The real second completion found that key in
`_background_notified` and suppressed its own notification.

Archive searches for `background agent completion notification wrong run id
wake` and `second notification missing after finished task message resume`
found the [October 20 unread-message case](2026-10-20-explore-final-answer-accepted-over-unread-message.md).
That case concerns an explore finishing over an unread inbox row; this run's
second explore task did consume the message. The mutable notification identity
race is a new boundary. The repository's RCA process feedback was also read.
The biometrics cost path remains a separate open observation.

## Reproduction and repair

The new owning blackbox launches a real background task, makes its first
completion's tree update wake the same finished task, and then finishes run 2.
Before the repair it failed with exactly one notification, labelled run 2 and
containing run 1's answer. After the repair the identical test passed with two
notifications, labelled runs 1 and 2, with their respective answers. The
repair captures the completing run from its own record before the await, so
the later notification uses the run that actually completed.

The smoke evaluator had a separate observation error: it treated the first
notification, which can be persisted between the inbox write and send result,
as the end of all progress. Its resume branch now requires a verified wake, a
distinct run-2 notification and progress after the inbox. The original failed
transcript still fails the corrected check because it truly lacks that second
notification; the evaluator did not turn the old failure into a pass.

The background-agent and benchmark blackbox domains passed. The focused
workflow and evaluator tests passed five consecutive unchanged runs. The
unchanged `background-agent-message-smoke` passed a post-repair isolated CLI
run `1792614510-422489-12529` in 56 seconds with clean owned-stack cleanup.
The complete local deploy-smoke selector passed: the 11-task batch returned
11/11, including the repaired message smoke, and the separate mass-agent
batch returned 1/1. Both isolated stacks published durable run bundles and
completed owned-resource cleanup. The heavy matched anti-regression campaign
remains subject to the user's review checkpoint.
