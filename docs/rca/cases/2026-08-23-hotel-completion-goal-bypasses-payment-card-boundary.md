---
id: 2026-08-23-hotel-completion-goal-bypasses-payment-card-boundary
date: 2026-08-23
title: Hotel completion-oriented root spawn goal bypasses payment-card boundary
surface: harness
component: benchmarks/run_benchmark.py _benchmark_goal_for_task hotel exemption + helpers/llm.py _normalize_response_schema_for_goal
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Root execute loop rewrote spawn_browser_agent goal to "Complete the purchase, including submitting payment" with booking_completed/confirmation output_schema while browser-hotel-booking contract requires success_on_payment_card_request (payment_approval only); browser never reached checkout (0 request_payment_card), root pivoted to phone-call write_lock
symptoms:
  - "Expected attention kind payment_approval, observed write_lock"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
  - "approvals_triggered: 0"
  - "Complete the purchase, including submitting payment"
  - "Make a phone call to +1 (800) 246-8357"
tags:
  - browser-hotel-booking
  - payment-boundary
  - write-lock
  - payment-approval
  - spawn-goal-drift
  - request-payment-card
sources:
  - agent e6a95458-93fc-4cfc-9e5f-e830d636338c
  - commit 605a4bdc1
  - fleet run 20260822_212328_browser-hotel-booking
repro: cd agents/tests/blackbox && python benchmark.blackbox.py hotel_e6a95458_no_payment_card_boundary
status: fixed
---

# RCA: completion-oriented spawn goal bypasses payment-card boundary

## Problem

`browser-hotel-booking` run `e6a95458-…` (852s, 165 msgs) failed:

```
Expected attention kind payment_approval, observed write_lock | Expected payment_approval attention request (to ignore) but none was triggered
```

`approvals_triggered: 0`. The run JSON contains **zero** `request_payment_card` tool calls.

The harness root goal (catalog prompt) correctly omits completion instructions, but the
root's first `spawn_agent(type=browser)` call rewrote the browser goal to include
**"Complete the purchase, including submitting payment"** and an `output_schema` with
`booking_completed`, `confirmation_id`, etc. The browser sub-agent stalled on the
Hotel Kabuki property page ($406/night > $400 cap, CAPTCHA, Reserve clicks never
advanced to checkout). The root then spawned explore agents for Hotels.com customer
service and ended on a **phone-call `write_lock`** (`request_user_approval` to
`+1 (800) 246-8357`), not `payment_approval`.

**User hypothesis tested:** "Completing booking is fine because we'll hit
`request_payment_card`." **Disproved on this run:** completion-oriented steering
never produced a payment-card request; the trajectory escaped the browser entirely.

FE: https://www.roselabs.ai/?agent-id=e6a95458-93fc-4cfc-9e5f-e830d636338c

## Diagnosis

Archive searches (relative, not verdict):

- `browser-hotel-booking write_lock payment_approval request_payment_card` →
  `2026-08-22-hotel-root-respawn-after-max-steps-payment-boundary-misaligned-goal`
  (same payment-boundary / spawn-goal drift class; that run double-spawned instead of
  phone pivot).
- `hotel root respawn payment boundary misaligned goal` → same relative case.

Critical path:

1. `tasks.json` catalog prompt: book stay, guest checkout, under $400 — no payment-boundary marker.
2. `_benchmark_goal_for_task` **exempts** `browser-hotel-booking` from
   `payment_boundary_operational_suffix()` injection (commit removing ops constraints).
3. Root LLM expands spawn goal toward purchase completion + confirmation schema
   (`_is_purchase_goal(spawn_goal)` true → `_normalize_response_schema_for_goal` can
   inject `order_confirmation_id`; model also emitted `booking_completed`).
4. Browser chases confirmation, not `request_payment_card`; stalls at property page.
5. Root abandons browser path → explore web_search for CS phone → `write_lock` phone call.
6. Harness polls for `payment_approval` (`approval_handling: ignore`); `write_lock` is
   rejected as wrong kind → `approvals_triggered` stays 0.

Contrast: run `343eaf0a` reached `payment_approval` ($343.61) when the browser got
to checkout — but failed the semantic judge on guest-checkout state. That run still
had payment-card boundary behavior; this run never reached it.

Owning-boundary repro (pre-fix):

```bash
cd agents/tests/blackbox && python benchmark.blackbox.py hotel_e6a95458_no_payment_card_boundary
```

Asserts: harness goal has no completion language; spawn goal does; 0
`request_payment_card`; phone `write_lock` present; `evaluate_task` fails with the
recorded failure_reason.

## Solution

**Implemented:**

1. Removed the `browser-hotel-booking` exemption in `_benchmark_goal_for_task` so
   `payment_boundary_operational_suffix()` is appended again (harness-only; catalog
   prompt unchanged).
2. Kept `_normalize_response_schema_for_goal` payment-boundary guard tied to the marker.

Outcome gate after fix: `scripts/run-bench --local browser-hotel-booking` must reach
`payment_approval` (not `write_lock`, not phone pivot).

## Human feedback

User (2026-08-23): "completing booking is fine, cuz then we will hit
request_payment_card" — tested and disproved on `e6a95458`. Prior turn: remove
operational constraints from catalog prompt; harness injection was the intended
split. Do not re-add completion language to `tasks.json` prompt.

## Reusable lesson

On `success_on_payment_card_request` benches, a root spawn goal that says "complete
the purchase" does not guarantee `request_payment_card` — it steers the browser toward
confirmation/charge and enables phone/write_lock escape hatches when checkout stalls.
