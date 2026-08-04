---
id: 2026-08-04-mark-complete-notified-after-completed-status
date: 2026-08-04
title: Root mark_complete published COMPLETED before archiving the completion SMS receipt
surface: agents
component: agent-workflow-mark-complete
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_workflow.py::_mark_complete — mark_finished/COMPLETED ran before notify_sms_event_activity archived provider/sms/notify/completion-*.json.gz.enc
symptoms:
  - "Observed 0 completion SMS events; expected exactly 1"
  - "Declared evaluator blue_bottle_completion_delivery failed"
  - "provider/sms/notify/completion-"
tags:
  - completion-sms
  - mark-complete
  - benchmark-evaluator
  - race
  - blue-bottle
sources:
  - agent 630a2293-254b-4587-8354-cb79815333ec
repro: agents/tests/blackbox/workflow.blackbox.py::test_workflow_mark_complete_notifies_before_terminal_status
status: fixed
---

## Problem

Fleet run of `browser-blue-bottle-challenge-recovery` (agent
`630a2293-254b-4587-8354-cb79815333ec`) failed declared evaluator
`blue_bottle_completion_delivery` with `Observed 0 completion SMS events;
expected exactly 1`. The agent otherwise completed: browser reached the Blue
Bottle payment boundary, `completion_summary` finished with structured outputs,
and status became `COMPLETED`.

Re-reading the R2 trace archive after the run showed the receipt already
existed at
`provider/sms/notify/completion-630a2293-254b-4587-8354-cb79815333ec.json.gz.enc`
(`created_at_ms` ≈ 50s after the final summary message). Hydrating that receipt
into the same static checks now returns pass — the evaluator was correct; the
receipt was simply not durable yet when grading ran.

## Diagnosis

Critical path:

`attempt_completion` → `_mark_complete` → post `completion_summary` FINISHED →
`mark_finished` / broadcast `COMPLETED` → (later) `notify_sms_event_activity` →
archive `provider/sms/notify/completion-*.json.gz.enc` → benchmark sees
`COMPLETED` and hydrates archive paths → static `completion_sms_event` check.

`_mark_complete` already documented that `COMPLETED` is a safe point for
pollers/evaluators to read the final summary, and correctly posted the summary
before terminal status. It did **not** include the root completion-SMS archive
receipt in that safe-point contract. Declared evaluators call
`_hydrate_completion_sms_events` as soon as scoring starts after `COMPLETED`,
so notifying afterward races the grade.

Archive searches (`Observed 0 completion SMS`, `completion SMS archive`,
`blue_bottle_completion_delivery`) found relatives around SMS/completion
coupling (e.g. `2026-07-13-completion-coupled-to-sms-delivery`) but not this
COMPLETED-before-notify ordering race — novel instance of an incomplete
terminal-status contract.

## Solution

In `_mark_complete`, run root `notify_sms_event_activity` after the finished
completion summary message and **before** `mark_finished` / `COMPLETED`
broadcast. Cemented by
`test_workflow_mark_complete_notifies_before_terminal_status` (and an ordering
assertion on `test_workflow_mark_complete_no_parent_no_signal`).

At 10k agents this is still one notify per root completion (unchanged fan-out);
it only moves the side effect earlier so terminal status remains a trustworthy
safe point for archive-backed evaluators.

## Human feedback

None recorded.

## Reusable lesson

Never publish COMPLETED until every durable side effect declared evaluators
read at COMPLETED — including completion-SMS archive receipts — has already
landed.
