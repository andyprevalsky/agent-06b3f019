---
id: 2026-08-18-live-place-order-disabled-without-merchant-pan
date: 2026-08-18
title: Live /test_payment Place order stayed disabled unless merchant form PAN filled, so fleet clicks never called checkout-session
surface: front-end
component: test-payment-page
classification: our-bug
problem_class: other
first_bad_boundary: TestPaymentPage liveCardReady — required card.number ≥4 digits before enabling Place order on hosted-Checkout path
symptoms:
  - agent-payment-production-purchase Timeout after 903s
  - purchase status HELD walletFunding FUNDED agentCard balanceCents 100
  - Render logs show zero POST /api/test-payment/checkout-session in Place-order window
  - Browser timeline only Typed into input #card-name then Clicked Place order repeatedly
  - Task Incomplete - Max Steps Reached / Agent status ACTIVE
tags:
  - test-payment
  - place-order
  - checkout-session
  - production-purchase
  - hosted-checkout
sources:
  - agent bc7e1dc0-b405-4f20-975b-e15173cb832e
repro: front-end/src/tests/blackbox/test-payment-confirmation.blackbox.tsx (live Place order enabled without merchant PAN; checkout called without last4)
status: open
---

## Problem

Fleet `agent-payment-production-purchase` after recording FNF fix (`e54042309`) timed out
(~903s) with agent `bc7e1dc0…` still ACTIVE. Payment lifecycle stayed **HELD** /
FUNDED / AgentCard balance 100. Browser messages show many Place order clicks, long
waits, challenge recovery, then Max Steps — but **no** navigation to
`checkout.stripe.com` completing payment.

Prod Render logs for the Place-order window (`23:10–23:35Z`) contained **zero**
`POST /api/test-payment/checkout-session` hits for this agent. Message timeline
shows only `Typing into <input #card-name>` (never `#card-number`) before each
Place order click.

## Diagnosis

Critical path: mint HELD → Place order → `checkout-session` → `window.location.assign(Stripe URL)`
→ fill Stripe form → settle CLEARED.

Live FE gated Place order on `card.number` having ≥4 digits (`liveCardReady`) so
checkout-session would always receive `cardLast4` for HELD disambiguation. Hosted
Checkout does **not** charge on the merchant form — Stripe's page does. The
benchmark prompt says mint card, click Place order, then complete Stripe.

Browser agent filled only `#card-name` with a secret ref, left `#card-number`
empty, and CDP-clicked the **disabled** button. Disabled buttons do not fire the
React `onClick`, so checkout-session never ran. Agent burned the 50-step budget
waiting / re-clicking / recovering challenges.

Sibling: leftover global HELD $1 rows made last4 `getDetails` scans slow when
checkout did run in earlier fleets; addressed separately via `close-held-reuse`
preflight + parallel last4 proofs.

## Solution

1. Enable live Place order without a merchant-form PAN; send optional `cardLast4`
   only when the number field has ≥4 digits.
2. Put card number first + note that merchant PAN is optional for live redirect.
3. Cement FE blackbox: enabled without PAN; checkout called with `undefined` last4;
   last4 sent when number filled.
4. Land `close-held-reuse` preflight for production-purchase so amount-only match
   can succeed when last4 is omitted.
5. Parallelize checkout last4 `getCardLast4` across HELD candidates.

## Human feedback

User standing auth `alowed` to keep tanking production-purchase to CLEARED.

## Reusable lesson

Do not disable the only control that starts a hosted-Checkout redirect behind a
merchant-form field the payment path does not need — agents will click the
disabled control forever and never hit the API.
