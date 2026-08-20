---
id: 2026-08-20-return-write-lock-notification-demands-unsatisfiable-purchase-details
date: 2026-08-20
title: Return write-lock notification fork demanded unsatisfiable purchase details
surface: agents
component: write-lock-notification
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py::_write_lock_notification_prompt — return confirmations gated as purchase were instructed to emit trigger_type=purchase with rating/product_url that return-only trajectories lack
symptoms:
  - "purchase details are required for a purchase approval"
  - PurchaseApprovalNotificationRetryableError
  - "spawn_browser_agent expected 1, got 2"
tags:
  - browser-agent
  - write-lock
  - returns
  - amazon
  - schema-contract
sources:
  - agent 28e6e1a6-dafd-4b8b-a908-0d72ae408359
  - run agents/benchmarks/runs/20260820_205641_browser-amazon-return.json
  - relative 2026-08-03-return-confirmation-absent-from-write-lock-phrases
  - relative 2026-07-24-request-payment-card-schema-unsatisfiable-on-single-page-merchants
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_return_write_lock_notification_rejects_purchase_without_details_and_accepts_generic_write
status: resolved
---

## Problem

`browser-amazon-return` reached Amazon's Confirm your return control and correctly
triggered a purchase-gated write lock. The notification fork then called
`generate_write_lock_notification` with `trigger_type=purchase` but without a
`purchase` object. Schema validation raised `purchase details are required for a
purchase approval`, which became `PurchaseApprovalNotificationRetryableError`,
failed the browser session, and caused the root agent to spawn a second browser
(`spawn_browser_agent` 2 vs expected 1).

## Diagnosis

Archive searches: `"purchase details are required for a purchase approval"`,
`write_lock return PurchaseApprovalNotificationRetryableError`,
`return-confirmation-absent-from-write-lock-phrases`. Relative to the Aug 3
return phrase classifier (returns correctly share the purchase gate) and the
open Jul 24 unsatisfiable purchase-field contract. Novel at the notification
fork boundary.

Critical path: return click → `is_purchase_button` → `approval_type=purchase` →
`_generate_write_lock_notification` → fork prompt (purchase-only guidance) →
model omits inventable rating/product_url → `validate_browser_tool_args` rejects
→ session abort. Return-only trajectory never visited a PDP, so the purchase
item contract is unsatisfiable. Fork dumps are missing because validation fails
before `dump_llm_context` in `complete_browser_use`.

## Solution

1. Detect return-like write locks (`Confirm your return`, `/spr/returns`, …) and
   instruct the fork to use `trigger_type=generic_write` with refund/drop-off/
   payment-method payload instead of unsatisfiable purchase fields.
2. Retry the fork once on `BrowserToolArgsValidationError` with validation
   feedback (mirrors the main browser loop).
3. Cement prompt routing, schema red/green, and retry behavior in
   `spawn_browser_agent_v3.blackbox.py`.

10k-agent: O(1) extra fork call only on schema rejection; no shared fan-in.

## Human feedback

None recorded.

## Reusable lesson

When an irreversible gate reuses the purchase write-lock channel for non-buy
actions (returns, cancellations), the notification schema and fork prompt must
remain satisfiable on that page class — do not demand product-detail ratings or
PDP URLs the trajectory never observed.
