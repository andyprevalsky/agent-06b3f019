---
id: 2026-11-03-hosted-checkout-zip-observation-unresolved
date: 2026-11-03
title: Hosted subscription Checkout lost its ZIP field when Stripe geolocated the fleet guest outside the US
surface: harness
component: subscription-checkout
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: complete_test_subscription_checkout filled ZIP without pinning the billing country, so Stripe's IP-geolocated eurozone default rendered no postal-code input
symptoms:
  - Subscription Checkout failed: Stripe Checkout ZIP field was not available
  - 'selector_diagnostics=[{"probes":728,"matched_probes":0,"visible_probes":0,"fill_attempts":0,"last_exception_type":null}'
  - Expected paid Stripe test Checkout and local webhook delivery
  - No browser agent trajectory was recorded
  - 'presentment_details: {"presentment_currency": "eur"} on an unpaid benchmark Checkout session'
tags:
  - payment
  - stripe
  - checkout
  - locator
  - geolocation
  - adaptive-pricing
sources:
  - PR #1662
  - commit e00b6411735bbb92ea7b92a4e3d767be5c8b6317
  - commit 8d5d11b7aabf2de8c0edf57a67d10ce9e0dd953c
  - fleet run 20261103-053121-95317
  - agent 81fac171-dfc9-4922-8a69-68b24bfb4f76
  - fleet run 20261108-042041-2844813
  - agent cec09378-439c-45ad-ae5f-db374688d08b
  - commit 617bb467fd75e3770d686e17aab9e519bded0f37
repro: agents/venv/bin/python -m pytest -q agents/tests/unit/test_new_user_payment_benchmark.py
status: fixed
---

## Problem

The native agent-payment-new-user-journey benchmark intermittently failed at the
hosted Stripe Checkout ZIP step, about 40s into the run and well inside its
unchanged 1200s and 500c limits. Paid-session/webhook and browser-trajectory
assertions followed from that first failure. Four cloud-fleet occurrences are
in the Benchmark Hub: 2026-10-07, 11-03, 11-06 and 11-08 (deploy of PR #1784).
The newest one carried the probe counters: 728 probes per selector and zero
matches. The field was never in any frame, while card, expiry, CVC and
cardholder name had filled seconds earlier.

## Diagnosis

Stripe Checkout picks the default billing country from its own IP geolocation.
That geolocation arrives in the `geocoding.country_code` of
`/v1/payment_pages/<session>/init`. Adaptive Pricing is enabled on these
sessions, so a eurozone geolocation also presents the session in EUR. For a
non-US country the hosted form shows a country dropdown with no
`billingPostalCode` input. We confirmed this for NL, DE, FR, IE, GB, CA, JP, AE
and HK. The helper filled ZIP but never set the country, so it timed out.

Evidence:
- All benchmark subscription sessions in the sandbox since 2026-10-01: 963
  presented in USD completed paid; all 6 presented in EUR stayed unpaid. The 4
  ZIP failures match 4 of those EUR sessions minute for minute, for example
  `cs_test_b1lSnYNA…` at 04:30:51Z on 11-08 (presentment 2800 eur,
  payment_method_types card/link only).
- Live local repro on main 617bb467f: the real unchanged helper ran on a real
  sandbox session, and only the `/init` geocoding was rewritten to NL. It failed
  with byte-identical diagnostics (`probes:728, matched_probes:0` on both
  selectors). The unmodified-geocoding control completed paid with the webhook
  delivered.
- The actual failed production session (still open, EUR-sticky) gave the same
  result: with NL geocoding the unchanged helper failed identically, and the
  fixed helper completed it paid.
- Ruled out: browser locale/timezone (UTC/en-US defaults to US), and
  datacenter/residential proxy IPs (Stripe kept US for them). A 400-run
  soak from a US IP had zero misses. The failure only occurs when Stripe
  geolocates the guest's Fly egress IP to the eurozone.

## Solution

Before the ZIP fill, `complete_test_subscription_checkout` now selects
billing country US, the country of the 4242 test card and ZIP 94105 it enters
(`_select_billing_country`). It does nothing when US is already selected or no
country control is rendered. The ZIP fill, paid-session, webhook and
browser-trajectory assertions are unchanged, as are the task definition,
timeouts and limits. With the fix, sessions geolocated to NL, DE, FR and IE and
the US control all completed paid with the webhook delivered.

Regression:
`test_hosted_checkout_pays_when_stripe_geolocates_the_guest_outside_the_us` in
the registered agents-pytest unit file models the geolocated default (ZIP input
only for US). It fails on 617bb467f with the same ZIP error and passes with the
fix, including the US path.

## Human feedback

None recorded. The earlier rejection of a country change was agent
coordination, made because no evidence existed then. The session-presentment
correlation and the geocoding repro now supply that evidence.

## Reusable lesson

Pin every geolocation-defaulted field (country, currency, locale) in a third-party hosted form that a fleet in variable regions automates.
