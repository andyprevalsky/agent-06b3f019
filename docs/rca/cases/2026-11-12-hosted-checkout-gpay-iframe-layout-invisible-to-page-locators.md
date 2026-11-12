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
those PRs touched payment code, and the driver and backend session code were
last changed on 11-08. A same-source rerun of PR #1981 passed, as did PR #1982
and an origin/main run on PR #1975's box.

The owners' cloudbench driver logs show the Checkout URL each run received.
PR #1981 run 20261112-192546-4064416 got
`checkout.stripe.com/g/pay/cs_test_b0IjS1OUlZE2Ydwn…`. PR #1975 got
`/g/pay/cs_test_b0apCawrJt0fmd4V…` and `/g/pay/cs_test_b0UsGwJ7Fam0zs1a…`.
Every passing run received `/c/pay/…`. The backend creates every session the
same way (`createSubscriptionCheckoutSession`, API `2025-02-24.acacia`).

## Diagnosis

The hosted layout follows the URL path that Stripe returned in `session.url`,
and one session renders either layout depending on the path it is opened at.
`/c/pay/` renders the payment-method accordion, the card form and Subscribe
(`hosted-payment-submit-button`) in the top document. `/g/pay/` renders the
whole Payment Element in a single `js.stripe.com/v3/elements-inner-…` iframe.
That covers the Card radio, the `number/expiry/cvc/name` inputs, the `country`
select, `postalCode`, `linkOptIn` and Subscribe
(`data-testid="payment-form-submit-button"`). The top frame holds only the
promotion-code input, and an hCaptcha frame carries its own
`button[type=submit]`. The driver already filled fields across frames. Its Card
click, Link opt-out (`enableStripePass`) and Subscribe lookup searched only the
top page, and its ZIP/country selectors did not include the `/g/pay/` names.

Evidence (receipts in `.context/stripe-card-rca/` on the RCA box):
- Loading the actual failed session `cs_test_b0IjS1OUlZE2Ydwn` at its smoke
  `/g/pay/` path gave `get_by_text("Card", exact=True)` count 0 in the top frame
  and 1 in the `elements-inner-habanero` frame. The screenshot shows the Card
  radio visibly rendered. The per-frame DOM inventory before and after the Card
  click is in `captures/gpay_walk_{before,after}.json`. The same three failed
  sessions opened at the `/c/pay/` URL that the retrieve API returns today
  render the `/c/pay/` layout (`captures/open_*`).
- Live repro (`live-receipts.jsonl`): the repro rewrites the path of a freshly
  minted sandbox session to `/g/pay/`, because Stripe cannot be made to issue
  `/g/pay/`. On that session the unchanged main driver failed with the
  byte-identical smoke error in 13.2 s. On a `/c/pay/` session it paid.
- `fidelity_probe.json` covers both paths, with and without card-only
  (`payment_method_types=[card]`). Card-only sessions show a "Card" heading
  with the card form already open. The Link box has a `label[for]` in both
  layouts (`enableStripePass` and `payment-linkOptInInput`).
- Open unknown: what makes Stripe return `/g/pay/`. 12 of 12 fresh mints
  (account-default and `2025-02-24.acacia`) returned `/c/pay/`. The same
  backend code got both paths within minutes, so it is a Stripe-side choice
  made per session. The driver no longer depends on it.

The unchanged task could not be made to fail on the old driver locally, because
the served path cannot be controlled. The direct-driver live repro above is the
substitute. The task log now records the served layout (`layout=/g/pay/`) on
both the start and completion lines.

This is the second hosted-Checkout variant the driver did not model, after
`2026-11-03-hosted-checkout-zip-observation-unresolved` (an IP-geolocated
country with no ZIP). The missing guardrail was a list of the page variants
Stripe serves, each with its DOM contract. The regression below is that list.

## Solution

`agents/benchmarks/subscription_checkout.py` now handles both layouts:
- It finds the frame where the card form is visible, clicking the Card choice
  in whichever frame shows it only when the form is not already open. It clicks
  once and retries every 5 s.
- It does Link opt-out (`enableStripePass` or `linkOptIn`, via its
  `label[for]`), billing country (`billingCountry` or `country`) and Subscribe
  (either layout's test ID) in that frame only. It never scans the hCaptcha
  frame and never falls back to the top page. It waits up to 30 s for Subscribe
  and otherwise fails loudly.
- It fills ZIP through `billingPostalCode`/`postalCode`.
- It records `checkout_layout` and `link_opted_out` in the result.

Payment verification is unchanged. Stripe must report the session `complete`,
`paid`, with a subscription and a customer, before the signed webhook replay.
In `live-receipts.jsonl`, the fixed driver paid `/c/pay/`, `/g/pay/` and
card-only sessions on both paths, each verified with Stripe and the webhook
delivered.

The regression is `test_hosted_checkout_pays_in_every_real_checkout_layout`. It
encodes the captured DOM contract of `/c/pay/`, `/g/pay/` and card-only on each
path, under US and NL geolocation. On the pre-fix driver, the four `g-pay`
cases fail at the original `:119` Card click. The `c-pay` controls complete
payment and the webhook, and fail only on the new `checkout_layout` field. It
runs in the `agents-pytest` deploy lane through `scripts/run-coverage.sh` →
`tests/unit`. This is a benchmark-only driver, with one browser per benchmark
run and no effect on production or at 10k agents.

## Human feedback

Andy required the shipped driver to handle every real layout robustly. Payment
must still complete and be verified with Stripe. The unchanged task must pass
locally three times in a row.

## Reusable lesson

When a third-party hosted page drives a benchmark, locate every control across all frames and capture each layout variant the vendor serves; a page-level locator passes only the variant that happens to render in the top document.
