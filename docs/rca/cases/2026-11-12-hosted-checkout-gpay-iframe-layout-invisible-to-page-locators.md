---
id: 2026-11-12-hosted-checkout-gpay-iframe-layout-invisible-to-page-locators
date: 2026-11-12
title: Subscription Checkout driver timed out on Stripe's /g/pay/ hosted layout because its Card, Link and Subscribe locators searched only the top page
surface: harness
component: subscription-checkout
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: complete_test_subscription_checkout clicked page.get_by_text("Card") (top frame only), but /g/pay/ renders the whole Payment Element inside one js.stripe.com iframe
symptoms:
  - 'Subscription Checkout failed: Locator.click: Timeout 10000ms exceeded.'
  - waiting for get_by_text("Card", exact=True).last
  - agents/benchmarks/subscription_checkout.py:119
  - checkout.stripe.com/g/pay/cs_test_
  - Expected paid Stripe test Checkout and local webhook delivery
tags:
  - payment
  - stripe
  - checkout
  - locator
  - iframe
  - smoke
sources:
  - PR #1975 smoke sessions cs_test_b0apCawrJt0fmd4V (19:20Z) and cs_test_b0UsGwJ7Fam0zs1a (19:47Z)
  - PR #1981 smoke run 20261112-192546-4064416, agent 4098b04d-ca7f-4f34-ba58-8b083e4cec30, session cs_test_b0IjS1OUlZE2Ydwn
  - PR #1982 smoke pass on 1db20748922c (/c/pay/)
  - commit 351cb6a2e
repro: agents/tests/unit/test_new_user_payment_benchmark.py::test_hosted_checkout_pays_in_every_real_checkout_layout
status: fixed
---

## Problem

On 2026-11-12 the `agent-payment-new-user-journey` smoke failed about 22 seconds
into the run, before any agent work began. It failed on PR #1975 twice and on
PR #1981 once, with `Locator.click: Timeout 10000ms exceeded … waiting for
get_by_text("Card", exact=True).last` at `subscription_checkout.py:119`. None of
those PRs touched payment code. A same-source rerun of PR #1981 passed, and so
did PR #1982 and an origin/main run. All three failing sessions were opened at
`checkout.stripe.com/g/pay/…`. Every passing session was opened at `/c/pay/…`.
The backend creates every session the same way (`createSubscriptionCheckoutSession`).

## Diagnosis

Stripe serves one hosted Checkout session in either of two layouts, chosen per
session. `/c/pay/` renders the payment-method accordion, the card form and
Subscribe in the top document. `/g/pay/` renders the whole Payment Element in a
single `js.stripe.com/v3/elements-inner-…` iframe. That covers the Card radio,
the `number/expiry/cvc/name` inputs, the `country` select, `postalCode`,
`linkOptIn` and Subscribe (`data-testid="payment-form-submit-button"`). The top
frame holds only the promotion-code input, and an hCaptcha frame carries its
own `button[type=submit]`. The driver already filled fields across frames. Its
Card click, Link opt-out (`enableStripePass`) and Subscribe lookup searched only
the top page, and its ZIP/country selectors did not include the `/g/pay/` names.

Evidence:
- Loading the actual failed session `cs_test_b0IjS1OUlZE2Ydwn` at `/g/pay/`
  gave `get_by_text("Card", exact=True)` count 0 in the top frame and 1 in the
  `elements-inner-habanero` frame. The screenshot shows the Card radio visibly
  rendered. The DOM inventory of the failing variant before and after the Card
  click is in `.context/stripe-card-rca/captures/`.
- Live repro: the unchanged main driver ran against a freshly minted real
  sandbox session opened at `/g/pay/`. It failed with the byte-identical smoke
  error in 13.4 s. It failed the same way on a card-only `/g/pay/` session.
- The same unchanged driver paid `/c/pay/` sessions. That explains the
  pass/fail split on identical source.
- Card-only sessions show a "Card" heading with the card form already open, on
  both paths.

## Solution

`agents/benchmarks/subscription_checkout.py` now does the following across every
frame:
- It selects the card method, or skips the selection when the card number
  field is already visible.
- It opts out of Link through either `enableStripePass` or `linkOptIn`. It
  checks this again before submit and polls until the box is unchecked.
- It pins the billing country through `billingCountry` or `country`.
- It fills ZIP through `billingPostalCode`/`postalCode` (`postal-code` or
  `billing postal-code`).
- It clicks the Checkout's own Subscribe test ID, so it never clicks hCaptcha's
  submit button.

Payment verification is unchanged. Stripe must report the session `complete`,
`paid`, with a subscription and a customer, before the signed webhook replay.
With the fixed driver, live runs paid 6 of 6 real sandbox sessions across
`/c/pay/`, `/g/pay/` and card-only on both paths.

The regression is `test_hosted_checkout_pays_in_every_real_checkout_layout`. It
encodes the captured DOM contract of both layouts and of card-only on each path,
under US and NL geolocation, and it fails at line 119 on the old driver. It runs
in the `agents-pytest` deploy lane through `scripts/run-coverage.sh` → `tests/unit`.
This is a benchmark-only driver, with one browser per benchmark run and no effect
on production or at 10k agents.

## Human feedback

Andy required the shipped driver to handle every real layout robustly. Payment
must still complete and be verified with Stripe. The unchanged task must pass
locally three times in a row.

## Reusable lesson

When a third-party hosted page drives a benchmark, locate every control across all frames and capture each layout variant the vendor serves; a page-level locator passes only the variant that happens to render in the top document.
