---
id: 2026-08-18-test-payment-checkout-amount-only-held-match
date: 2026-08-18
title: Hosted /test_payment checkout-session treated global HELD totalCents as purchase identity and 409'd
surface: back-end
component: test-payment-checkout
classification: our-bug
problem_class: other
first_bad_boundary: createTestPaymentCheckoutSession — required candidates.length === 1 from unscoped findHeldPurchasesByTotal(amount) before any card identity
symptoms:
  - Multiple held Rose purchases match this checkout total; refusing an ambiguous charge
  - POST /api/test-payment/checkout-session 409
  - agent-payment-production-purchase Timeout after 904s
  - purchase status HELD walletFunding FUNDED agentCard balanceCents 100
  - checkout_session settle count 0
tags:
  - test-payment
  - checkout-session
  - agentcard
  - held-purchase
  - ambiguous-charge
  - production-purchase
sources:
  - agent bc64fd0a-2b0f-41a7-b7c2-22a35aede942
  - commit 687e03d26fafec6f6a250b0a3df7f9150ac35fa2
repro: back-end/src/tests/blackbox/test-payment.merchant-key.blackbox.ts (checkout-session disambiguates multiple HELD same-total purchases by card last4)
status: mitigated
---

## Problem

Fleet `agent-payment-production-purchase` on prod timed out (~904s) with agent
`bc64fd0a-2b0f-41a7-b7c2-22a35aede942` still ACTIVE. Payment lifecycle showed
purchase `69d66c59…` **HELD**, walletFunding **FUNDED**, AgentCard OPEN with
`balanceCents: 100`, and zero `checkout_session` settles. Browser messages show
repeated Place order → `POST /api/test-payment/checkout-session` → **409**
`Multiple held Rose purchases match this checkout total; refusing an ambiguous charge`.

Prod DB at diagnosis time had **exactly two** HELD `totalCents=100` carded rows
for the same benchmark user, different agents: `69d66c59…` (`bc64fd0a…`) and
`b4761a40…` (`1be69cd4…`).

Sibling (non-causal for the terminal 409): early `Browser challenge recovery failed`
on `checkout.stripe.com` burned time before the card-ready Place order loop.

## Diagnosis

Critical path: mint HELD purchase → Place order → `createTestPaymentCheckoutSession`
→ `findHeldPurchasesByTotal(totalCents)` → Stripe Checkout URL → pay → settle.

`findHeldPurchasesByTotal` selects globally by `{ totalCents, status:HELD, cardId
not null }` with no agent/user scope. `createTestPaymentCheckoutSession` required
`candidates.length === 1` and otherwise 409'd. The $1.00 lifecycle probe reuses
the same total across runs, so leftover HELD rows from prior agents make Place
order fail for everyone.

Sandbox settle already walks amount candidates and matches the charged **PAN**.
Hosted session create happens *before* Stripe collects a card and had no
equivalent identity — amount-as-identity.

Relative: `2026-07-14-global-reconcilers-cross-contaminate-concurrent-blackbox-domains`
(global purchaseSpend status scans without owner scope). Exact 409 string: novel.

Deepest owned cause: hosted checkout used cart total as the sole correlation key
for binding a Stripe session to a Rose purchase.

## Solution

Causal fix (mitigated until prod fleet outcome re-verified; task is
`production_only`):

1. `createTestPaymentCheckoutSession` accepts optional `cardLast4`. When present,
   filter amount candidates by proving each card's last4 (same identity class as
   sandbox PAN match). Fail closed on zero/multiple matches; never bind a lone
   stale hold when last4 mismatches.
2. Live FE Place order stays disabled until the one-time card last4 is filled, and
   sends that last4 on checkout-session.
3. Cemented in `test-payment.merchant-key` blackbox + FE confirmation blackbox.

10k-agent behavior: correlation cost is O(candidates≤10) last4 lookups only when
the amount scan is non-unique or last4 is supplied — no per-user fan-in channel.

Outcome gap: exact `scripts/run-bench --local agent-payment-production-purchase`
is refused (`production_only`). Claiming the benchmark green still needs a
`--prod` / fleet rerun after this ships to Render + Vercel.

## Human feedback

User asked to follow `/rca` on the production-purchase failure after AgentCard
CLI update. Prior thread clarified Kernel managed proxy blacklists (not Rose
denylist) and asked what still needs fixing.

## Reusable lesson

Never bind a money-moving checkout to "the unique HELD purchase at this amount"
across agents — require a card/purchase identity the way sandbox settle requires a PAN.
