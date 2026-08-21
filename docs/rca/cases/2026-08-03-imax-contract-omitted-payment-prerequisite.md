---
id: 2026-08-03-imax-contract-omitted-payment-prerequisite
date: 2026-08-03
title: The IMAX evaluator omitted the payment approval before purchase
surface: agents
component: benchmark-evaluator
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: commit aa960a9363 — the task expected one write lock although AMC checkout first requires payment-card approval
symptoms:
  - Expected attention kind write_lock, observed payment_approval
  - Agent status ACTIVE (expected COMPLETED)
  - a valid $95.94 AMC payment request was rejected before the purchase write lock
tags:
  - benchmark
  - imax
  - amc
  - ecommerce
  - evaluator
  - approval
sources:
  - commit aa960a9363
  - commit dd621848ae
  - plan:agents/benchmarks/runs/20260803_223558_browser-opentable-reservation,browser-instacart-grocery-order,browser-alchemy-springs-sauna,browser-hotel-booking,browser-event-ticket,browser-imax-group-tickets,minted-agent-accounts-uber.json
  - agent 9c234058-7f6c-4274-b6d5-5110beaea31b
repro: agents/tests/blackbox/benchmark.blackbox.py test_imax_poll_requires_payment_then_purchase_write_lock
status: open
---

## Problem

The exact task prompt was: “Buy 3 adult IMAX tickets for tonight at AMC
Metreon 16 in San Francisco. Choose the earliest IMAX showtime remaining tonight
(any film is fine), and select 3 available seats that are all directly adjacent
to each other in the same row. Keep each ticket under $35 before fees and add no
concessions, memberships, donations, insurance, or upgrades. If no IMAX
showtime remains tonight, fall back to the earliest remaining Dolby Cinema
showtime tonight with 3 adjacent seats. Complete the purchase so all 3 tickets
are confirmed under the account holder.”

The epoch-9 browser selected adjacent seats A9, A10, and A11 and emitted a
grounded $95.94 payment-card request. The harness classified it correctly as
`payment_approval`, but the task demanded `write_lock` as its first and only
approval. The poller rejected the legitimate prerequisite, left the agent
active, and never allowed it to reach the distinct final purchase boundary.
The same failure occurred on July 28 and August 3.

## Diagnosis

Commit `aa960a9363` introduced the task with one expected approval and one
`write_lock`. Payment-card classification already existed in `dd621848ae`.
The browser workflow intentionally requests approval before minting a one-time
card, records that boundary as payment, then guards the final purchase control
separately as a purchase write lock. Guest AMC completion therefore has an
ordered two-boundary contract: payment approval, then purchase approval.

The captured polling replay fails under the legacy contract with `Expected
attention kind write_lock, observed payment_approval`, zero resolutions, and no
responses. With only an in-memory ordered sequence of `payment_approval` then
`write_lock` and an expected count of two, the identical replay resolves both
requests and passes. The hardened replay also proves that payment alone,
reversed ordering, an extra third request, and a payment request missing its
line items all fail closed. Multi-step receipt validation is scoped to the
payment request, so the later write lock does not incorrectly need its own
`requestPaymentCard` payload. The DoorDash all-of case is related
field-semantics evidence, but its first bad boundary and one-of contract are
different, so this is not a recurrence.

## Solution

The proposed fix models the two ordered approvals, changes the exact count to
two, requires a full structured payment receipt, and validates both approval
questions independently. Each question must identify AMC Metreon 16, three
adult tickets, the date, showtime, amount, and three distinct seat
assignments in user-visible approval copy; opaque request IDs and metadata
cannot satisfy those details. It retains `COMPLETED`, the final confirmed receipt, all
seat/format/price/add-on requirements, and `no_tool_failures`. Treating the
payment request as terminal would be reward hacking and is not part of the
proposal. The task definition remains unchanged until harness-fix approval;
the exact post-change benchmark remains required for outcome proof.

## Human feedback

None recorded.

## Reusable lesson

Model every ordered safety boundary required by a completed checkout instead of treating its first approval as terminal.
