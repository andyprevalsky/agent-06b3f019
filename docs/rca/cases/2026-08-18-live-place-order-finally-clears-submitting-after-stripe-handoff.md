---
id: 2026-08-18-live-place-order-finally-clears-submitting-after-stripe-handoff
date: 2026-08-18
title: Live Place order finally cleared submitting after location handoff so Steel stayed on /test_payment and agents never completed Stripe pay
surface: front-end
component: test-payment-page
classification: our-bug
problem_class: other
first_bad_boundary: TestPaymentPage Place order onClick finally — setSubmitting(false) after window.location.assign to hosted Checkout
symptoms:
  - agent-payment-production-purchase Timeout after 903s purchase HELD
  - Browser reached checkout.stripe.com/g/pay/cs_live_* then returned to /test_payment
  - Repeated Place order + challenge recovery + navigate api.stripe.com/healthcheck
  - Never filled Stripe Checkout card fields / Pay
tags:
  - test-payment
  - stripe-checkout
  - place-order
  - steel
  - production-purchase
sources:
  - agent 4a2ff6aa-fd5d-4d6d-bbad-f3e09380281a
  - fleet run 20260818-235000-804185
  - PR #987 (prior fix — Place order without merchant PAN)
repro: front-end/src/tests/blackbox/test-payment-confirmation.blackbox.tsx (keeps Place order submitting and exposes Stripe continue link after handoff)
status: open
---

## Problem

After PR #987 made live Place order call `checkout-session` without a merchant PAN,
fleet agent `4a2ff6aa…` created a `cs_live_*` session and briefly reached
`checkout.stripe.com`, then returned to `/test_payment`, re-clicked Place order,
entered CAPTCHA/challenge recovery, navigated to `api.stripe.com/healthcheck`,
and timed out with purchase still **HELD**.

## Diagnosis

Place order `try` called `window.location.assign(url)` then `return`, but `finally`
always ran `setSubmitting(false)`. On Steel sessions the SPA often remained on
`/test_payment` after assign (agent later manually navigated using the URL from
network). Clearing submitting re-enabled Place order, so the agent treated the
merchant page as still the task surface instead of completing Stripe Checkout.

Sibling: challenge recovery burned remaining budget after the agent left Stripe.

## Solution

1. On live handoff, set `location.href` and skip `setSubmitting(false)` in finally.
2. Persist the hosted Checkout URL in state and render a visible
   `Continue to Stripe Checkout` link (`data-testid=test-payment-hosted-checkout-link`)
   as a clickable fallback when the SPA stays put.
3. Cement FE blackbox for submitting-disabled + continue link href.

## Human feedback

User standing auth `alowed` to keep tanking production-purchase to CLEARED.

## Reusable lesson

Never clear in-flight UI state in `finally` after initiating a full-page navigation
handoff — if the navigation is delayed or ignored by the browser automation host,
re-enabling the trigger control strands the agent on the wrong page.
