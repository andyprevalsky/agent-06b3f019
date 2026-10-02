---
id: 2026-10-02-same-agent-cart-identity-keyed-on-model-written-line-item-text
date: 2026-10-02
title: Purchase mint keyed cart identity on model-written line-item text, so one agent's second request for the same cart minted a second card
surface: back-end
component: purchases
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/purchases/service.ts mintPurchaseCard — idempotent reuse only matched the content fingerprint, which hashes browser-model-written names, product URLs, and review text
symptoms:
  - "payment_lifecycle.integrity.purchaseCount mismatch: expected 1, got 2"
  - "agent-payment-idempotent-abandonment: FAIL"
  - "Aurora Notebook (x1)"
  - "Aurora Notebook - 1 each"
tags:
  - payments
  - purchases
  - idempotency
  - agentcard
sources:
  - PR #1357
  - agent 84a1069d-e6ea-487f-bb10-339a605079a4
  - agent 431e4ae6-e5e4-4f72-a3e1-62fe5104e728
repro: back-end/src/tests/blackbox/purchases-agent-cart-reuse.blackbox.ts
status: fixed
---

## Problem

`agent-payment-idempotent-abandonment` failed in 2 of 3 consecutive local deploy runs with "payment_lifecycle.integrity.purchaseCount mismatch: expected 1, got 2". Both browser agents of one root agent requested a card for the same three-item $43.96 cart; the second request minted a new card (different last four) instead of reusing the first, still-held card. The first agent's card stayed held, so the user carried two Stripe holds for one order.

## Diagnosis

Each request carries line items that the browser model writes. Run 1 (agent 431e4ae6) sent `Aurora Notebook` then `Aurora Notebook - 1 each`. Run 2 (agent 84a1069d) sent `Aurora Notebook`, `Aurora Notebook x1`, and `Aurora Notebook (x1)`, and product URLs both with and without `/p/`. Both runs logged distinct fingerprints for the same cart under `Browser payment payload normalized`. `normalize_payment_payload` hashes every line-item field, and mint reuse (`findMostRecentPurchaseByUserAndFingerprint`) only matched that hash. The `_canonicalize_line_item_name` regexes strip a growing list of quantity echoes (`x1`, `- x1`, `- 1 x $12.00`, merchant echoes) but can never enumerate every spelling the model produces. The deepest owned cause is that mint-time identity depended on free text, not on the cart's priced structure.

A price-only fingerprint was rejected. The lookup fingerprint also drives the user-level 24-hour auto-approve cache, so collapsing different carts that share a price would let one approval cover a different order.

## Solution

`back-end/src/domains/purchases/agentCartReuse.ts` adds a mint-only fallback. When no fingerprint row exists, `findSameAgentHeldCart` loads the same agent's HELD purchases for the same merchant and total within the 24-hour window, using the indexed `agentId` and at most 20 rows. It matches them on a price signature: currency, total, sorted fee amounts, and per-item `unitPriceCents x quantity = lineTotalCents`. `tryReuseExistingPurchase` then confirms the card is still live and unspent before handing it back. This applies only within one agent and only after that agent's approval prompt, so it never widens consent. It strictly reduces Stripe holds, and it covers every future name, URL, or review-text drift without another regex. At 10k agents it costs one indexed per-agent query per fingerprint miss on mint, with no shared state.

## Human feedback

The user directed the deploy be carried through to merge. Adding another name-regex alias was rejected during this RCA because the repo forbids string-matching classifiers.

## Reusable lesson

Never key purchase idempotency solely on model-written text; match a same-agent retry on the cart's priced structure and confirm card liveness before reuse.
