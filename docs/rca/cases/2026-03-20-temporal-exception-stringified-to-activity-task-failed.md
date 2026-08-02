---
id: 2026-03-20-temporal-exception-stringified-to-activity-task-failed
date: 2026-03-20
title: Planner errors were surfaced as `str(e)` on a Temporal wrapper, hiding every real cause behind "Activity task failed"
surface: agents
component: set-plan
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: agents/tools/set_plan.py — the error handler used `str(e)` on the Temporal exception instead of `extract_error_message()`
symptoms:
  - planner failure message reads only "Activity task failed"
  - no root cause visible in the plan-tool error text
  - planner errors indistinguishable from one another in the message stream
tags:
  - temporal
  - error-handling
  - observability
  - planner
  - set-plan
sources:
  - PR #233
repro: none-recorded
status: fixed
---

## Problem

When the planner activity failed, the message written back to the agent said
only `Activity task failed`. Every distinct planner failure — bad schema,
provider error, validation error — collapsed to that one string, so no
diagnosis was possible from the transcript.

## Diagnosis

Temporal wraps activity failures in its own exception type; the underlying cause
lives in the exception's `cause` chain, not in its `__str__`. `set_plan.py`
formatted the error with plain `str(e)`, which renders only the outermost
Temporal wrapper. The information was never lost inside Temporal — it was
discarded at our own formatting boundary, which is why the failure looked
opaque even though the worker had the real error in hand.

## Solution

`set_plan.py` now formats errors with the shared `extract_error_message()`
helper, which unwraps the Temporal exception chain to the real cause before
yielding the error event. This applies to every planner failure mode at once and
is the pattern any other Temporal-activity error surface should use.

## Human feedback

None recorded.

## Reusable lesson

Never render a Temporal (or any wrapped) exception with `str(e)` — unwrap the
cause chain, or every distinct failure reports as the same generic wrapper text.
