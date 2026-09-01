---
id: 2026-09-01-place-pickup-order-write-lock-false-negative
date: 2026-09-01
title: DoorDash "Place Pickup Order" evaded purchase write lock and charged real money
surface: agents
component: browser_tools.write_lock.is_purchase_button
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/write_lock.py::is_purchase_button — whitespace-stripped substring "placeorder" does not match "placepickuporder"
symptoms:
  - "Place Pickup Order"
  - "Clicked <button \"Place Pickup Order\\n$20.31\">"
  - "da3196df-530e-455f-b6ea-ed6946c1d10a"
  - "WHY DID WRITE LOCK. NOT TRIGGER"
  - "spent my real money"
tags:
  - write-lock
  - purchase-button
  - false-negative
  - doordash
  - place-pickup-order
sources:
  - agent 3a7c0315-f363-4775-946b-2b02e8f4695b
  - PR #1197
repro: agents/tests/blackbox/write_lock_purchase.blackbox.py + agents/tests/fixtures/write_lock_purchase_corpus.json
status: fixed
---

## Problem

Agent `3a7c0315-f363-4775-946b-2b02e8f4695b` (`write_lock_enabled=true`, goal
"full checkout drive v2") completed a live DoorDash Blue Bottle Coffee pickup
checkout. Browser timeline shows `Clicking`/`Clicked` on
`<button "Place Pickup Order\n$20.31">` with **no** `write_lock` /
`needs_write_approval` event. Completion summary recorded
`checkout_confirmation_id=da3196df-530e-455f-b6ea-ed6946c1d10a` and final
screenshot shows "Preparing your order", total **$20.31**, Visa •9616. User
later messaged to cancel the order.

## Diagnosis

1. Runtime: write lock was on; action_type histogram has zero `write_lock`;
   irreversible click title is exactly `Place Pickup Order\n$20.31`.
2. Critical path: browser `click` → `_execute_click` → write-lock checks →
   `is_purchase_button(element_text)` → (miss) → click executes → merchant
   charges saved Visa.
3. First-bad boundary: `is_purchase_button` normalizes by stripping all
   whitespace, then substring-matches phrase `place order` → `placeorder`.
   Label `Place Pickup Order` → `placepickuporder`. `"placeorder" in
   "placepickuporder"` is **False** because fulfillment mode (`pickup` /
   `delivery`) sits between the verbs. Same miss for `Place Delivery Order`.
4. Local owning-boundary repro (WALL ~0.65s) fails on current main for the
   prod label and siblings; `Place Order` still matches (control).
5. Archive: **relative** of write-lock phrase-matching cases
   (`2026-08-10-eventim-terms-buy-now-false-purchase-write-lock` et al.) which
   were false **positives**; this is a novel false **negative** of the same
   classifier contract. Not a recurrence of a prior miss.
6. Deepest owned cause (Step 5a): purchase phrase list assumes contiguous
   `place`+`order` after whitespace collapse and does not treat fulfillment-mode
   modifiers as transparent — so any merchant label of the form
   "Place {Pickup|Delivery|…} Order" silently bypasses the irreversible gate.

Searches run: `write lock`, `spent money without asking`, `write_lock`,
`place order write lock miss false negative purchase button`,
`is_purchase_button false negative`, `purchase write lock missed checkout spent`.

## Solution

`is_purchase_button` now matches against fulfillment-collapsed forms (`&`→`and`,
pickup/delivery/shipping/… stripped) plus a small base phrase list (order and
pay, purchase now, buy it now, …) and BNPL informational exclusions. Cemented
by `agents/tests/fixtures/write_lock_purchase_corpus.json` (100 TP / 100 issue /
100 TN) and `write_lock_purchase.blackbox.py` with generative + anti-reward-hack
checks. 10k-agent: O(1) per click label; no shared state.

## Human feedback

None recorded. User reported via GitHub PR comment: write lock did not trigger
and real money was spent without asking.

## Reusable lesson

Treat fulfillment-mode words between purchase verbs (e.g. Place *Pickup*
Order) as transparent for write-lock matching — never require contiguous
`placeorder` after whitespace strip alone.
