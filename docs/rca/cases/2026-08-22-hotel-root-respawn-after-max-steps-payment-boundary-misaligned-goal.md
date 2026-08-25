---
id: 2026-08-22-hotel-root-respawn-after-max-steps-payment-boundary-misaligned-goal
date: 2026-08-22
title: Hotel root respawned browser after max-steps; goal/schema demanded booking confirmation
surface: harness
component: benchmarks/run_benchmark.py create_agent goal + helpers/llm.py response-schema normalization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Root execute loop expanded spawn_browser_agent goal with "Complete the booking" + confirmation output_schema while browser-hotel-booking success_on_payment_card_request expects payment-card boundary only; first browser hit Max Steps on hotels.com Reserve loop, then root issued a second spawn_browser_agent
symptoms:
  - "spawn_browser_agent exceeded its exact root call limit during execution: expected 1, got 2"
  - "Task Incomplete - Max Steps Reached"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
  - "Browser agent call_X1PQOH3Squ3J7lnx38IG4sFE recorded 0 trajectory step(s)"
tags:
  - browser-hotel-booking
  - double-spawn
  - max-steps
  - payment-boundary
  - expected-tool-counts
sources:
  - agent aba4c297-090f-40d1-816b-f0b69c107b32
  - commit 05c2a73ec
repro: cd agents && python -m pytest benchmarks/benchmark_tasks_policy_test.py::test_browser_hotel_booking_prompt_requires_single_browser_agent -q && cd tests/blackbox && python benchmark.blackbox.py (hotel_payment_boundary_goal_suffix, hotel_double_spawn_run_artifact_tool_count)
status: mitigated
---

# RCA: payment-boundary misaligned spawn goal → max steps → double spawn_browser_agent

## Problem

`browser-hotel-booking` run `aba4c297-…` (932s) failed:
`spawn_browser_agent exceeded exact root call limit: expected 1, got 2`; no
`payment_approval`. First browser (`88477e29-…`) burned 60 steps on Hotel
Kabuki property page (Reserve click loop). Root respawned a second browser with
0 trajectory steps.

Root spawn goal (from run JSON) included "Complete the booking", "Use AgentCard
… to complete purchase", and `output_schema` fields
`hotel_booking_confirmation_id`, `booking_completed`, `total_paid`, etc. — while
the harness contract is `success_on_payment_card_request` (stop at
`request_payment_card`, never complete charge).

## Diagnosis

Archive searches (relative, not same fix):
- `spawn_browser_agent exceeded exact root call limit` →
  `2026-08-22-browser-event-ticket-seatmap-max-steps-double-spawn` (seat-map
  stall; do not raise expected_tool_counts to 2).
- `double spawn browser max steps` → same relative case.

Critical path: catalog prompt (book stay, guest checkout) → root expands spawn
goal toward purchase completion + confirmation schema → browser chases
confirmation instead of payment-card request → max steps on Reserve → root
retries second browser → exact tool-count fail.

Owning-boundary repro (pre-fix): replay
`agents/benchmarks/runs/20260822_182420_browser-hotel-booking.json` through
`_root_exact_tool_count_exceeded` → `expected 1, got 2`.

Contrast: run `7269f478-…` reached `request_payment_card` with one browser but
failed merchant/rating validation (separate fixes on branch).

## Solution

1. `utils/payment_boundary_goal.py`: harness-only operational suffix appended
   in `create_agent` when `success_on_payment_card_request` (single browser, no
   retry, no completion/confirmation instructions).
2. `helpers/llm.py`: skip auto-injecting `order_confirmation_id` into spawn
   schemas when goal carries the payment-boundary marker.
3. `tasks.json` hotel prompt prefix: "Use exactly one browser agent …"

Did **not** relax `expected_tool_counts.spawn_browser_agent` to 2.

Outcome gate: `scripts/run-bench --local browser-hotel-booking` pending on fixed
revision (live ~15m).

## Human feedback

None recorded. Prior turn: remove payment-boundary phrasing from catalog prompt
(success is harness-side); operational single-browser constraints are harness
injection + prompt prefix only, not evaluator/payment-success definition in
prompt.

## Reusable lesson

When `expected_tool_counts` fails on a second `spawn_browser_agent` on a
`success_on_payment_card_request` bench, check whether the root spawn goal/schema
still demands purchase completion — align harness goal injection before blaming
browser max-steps alone.
