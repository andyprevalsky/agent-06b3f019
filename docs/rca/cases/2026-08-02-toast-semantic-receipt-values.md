---
id: 2026-08-02-toast-semantic-receipt-values
date: 2026-08-02
title: Toast reached the correct card boundary but literal merchant parsing rejected semantically valid receipts
surface: agents
component: benchmark-payment-receipt-evaluator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/tasks.json browser-toast-nopa-write-lock expected_payment_receipt — semantic merchant and menu-item identity were encoded as static literal values
symptoms:
  - "merchant mismatch: expected Nopa Fish (Toast - order.toasttab.com), got Nopa Fish (Toast)"
  - "merchant mismatch: expected Nopa Fish (Toast - order.toasttab.com), got Nopa Fish"
  - "Expected validated payment-card request but none was observed"
tags:
  - browser-agent
  - request-payment-card
  - semantic-evaluator
  - toast
sources:
  - agent b366ae52-d080-489f-b735-07869ad9c3a8
  - agent 468fd928-2ca0-4e88-8a7b-dc26aa291530
  - agent 20521b60-f2b6-485e-92a4-3a5555fc9db4
repro: agents/tests/blackbox/benchmark.blackbox.py::test_toast_semantic_receipt_values_are_decided_by_llm_judge
status: open
---

## Problem

Two independent live runs navigated the official Nopa Fish Toast checkout,
selected one rocky fish sandwich, and stopped at the unanswered $23.94
`request_payment_card` boundary. No card was issued, no approval was answered,
and no real order was placed. The harness nevertheless failed both runs before
its LLM evaluator: one receipt said `Nopa Fish (Toast)` and the other said
`Nopa Fish`, while the static contract required the composite literal
`Nopa Fish (Toast - order.toasttab.com)`.

## Diagnosis

The first bad boundary was the Toast task's `expected_payment_receipt`. It put
merchant display-label meaning and the live menu item's name into deterministic
receipt matching. The shared validator then parsed connector syntax with regular
expressions and token equality even though the production payment tool had
already validated the request payload and the benchmark had a semantic judge.

The task already uses declared evaluators, including a single-turn LLM judge
that receives grounded tool and benchmark-state evidence. The attention-request
state retains the complete payment receipt, so no new model call or evidence
channel is required; the semantic check was simply placed at the wrong layer.

## Solution

The task no longer declares a second static receipt evaluator. Its minimal
deterministic boundary is only that the browser produced one unresolved
`payment_approval`; the production `request_payment_card` tool owns payload
typing. A required single-turn LLM evaluator judges the complete browser, tool,
and payment-request evidence for Nopa Fish at the Ferry Building, official Toast
checkout, exactly one rocky fish sandwich, and no entered card or placed order.
A different business, platform, item, quantity, or completion state fails
semantically.

The global payment-card schema and merchant-label instructions are unchanged.
This avoids both duplicate validation and teaching agents an evaluator-specific
string.

## Human feedback

None recorded. A later authorized exact live rerun (2026-08-03) did not
reproduce the old false negative or reach semantic evaluation — the root routed
to DoorDash / Uber Eats instead (see case
`2026-08-04-toast-task-never-named-the-ordering-surface`).

## Human feedback

None recorded.

## Reusable lesson

Do not duplicate a production tool's schema validation in a task-specific
benchmark gate. Keep only the state transition needed by the task, then use a
semantic judge for the real-world outcome when multiple literal strings can
express the same visible evidence.
