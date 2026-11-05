---
id: 2026-11-03-hosted-checkout-zip-observation-unresolved
date: 2026-11-03
title: Hosted subscription Checkout failed its ZIP-field observation before submit
surface: harness
component: subscription-checkout
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: The hosted Checkout ZIP locator loop failed; historical DOM and locator exception are not captured, so whole-check causality is unproven
symptoms:
  - Subscription Checkout failed: Stripe Checkout ZIP field was not available
  - Expected paid Stripe test Checkout and local webhook delivery
  - No browser agent trajectory was recorded
tags:
  - payment
  - stripe
  - checkout
  - locator
sources:
  - PR #1662
  - commit e00b6411735bbb92ea7b92a4e3d767be5c8b6317
  - commit 8d5d11b7aabf2de8c0edf57a67d10ce9e0dd953c
  - fleet run 20261103-053121-95317
  - agent 81fac171-dfc9-4922-8a69-68b24bfb4f76
repro: agents/venv/bin/python -m pytest -q agents/tests/unit/test_new_user_payment_benchmark.py
status: open
---

## Problem

The original native agent-payment-new-user-journey benchmark failed after40.3s
against unchanged1200s and500c task limits. It observed one subscription gate
and resolved none. Its first failure was the hosted Stripe Checkout ZIP-field
error; paid-session/webhook and browser-trajectory assertions followed. The
payment snapshot records no purchase, card or transfer. The reported usage
counter is0, while native worker logs positively record a preparatory response
schema Rose/Cerebras call; do not claim zero actual model calls.

## Diagnosis

Whole-check Gate: UNKNOWN comparing actual main and merge-base e00b6411735bbb92ea7b92a4e3d767be5c8b6317
to frozen8d5d11b7aabf2de8c0edf57a67d10ce9e0dd953c. Conditional helper mechanism
Gate: NOT_INTRODUCED. Both immutable complete_test_subscription_checkout and
_fill_checkout_field bodies reproduce the same nominal30s generic ZIP error under a
controlled missing-field page. The error precedes submit and local webhook.
Their positive modeled page/session/webhook control completes on both revisions.
These are helper controls, not a historical page or full-task counterfactual.

The helper requires billingPostalCode or autocomplete postal-code, scans all
frames, catches locator/count/visibility/fill exceptions and continues until
its nominal30s deadline (individual awaited locator work can overrun it). Thus its generic error cannot distinguish absent, invisible or unfillable
input from a frame/context failure. The saved native record and runtime manifest
contain no hosted Checkout DOM, selected country, field inventory or underlying
locator exception. Billing/task/helper source and the owning _poll_agent AST
are unchanged; outer archive/poll concurrency changed. Actual presentation,
configuration and timing causality remain unresolved. No mail failure, provider
outage, exhausted credit or actor intelligence failure is established.

## Solution

Preserve the original FAILED result and UNKNOWN whole-check attribution. Do not
skip ZIP, weaken paid Stripe/session/webhook assertions, or change task budgets.
Obtain any already-saved failure-page/frame/input and locator-error evidence; if
none exists, the minimum next observation repair belongs at this helper's failure
boundary for the next parent-authorized unchanged execution. Choose a selector,
country or required-field repair only after that evidence. No checkout behavior
fix has been proved; the parent owns the observation repair and actual native
verification, with the historical failure still open.

Cleanup is separate: native lifecycle is verified with controller exit1 and
matching canonical/local audit4f40f50ca583fe892e242beb9ddcad601b62d2f0ad55bf17d924bbbf8e09d275.
Guest cleanup is acknowledged and the root tree is deleted/sealed. Exact Machine
185d745c9e4748 and volumevol_vjy28owe0xz35ypv are destroyed-provider-retained,
not proven absent; exact viewer99479 remains retained under its native owner.
Those facts do not alter the benchmark verdict.

## Current observation and integrated diagnostics

A bounded probe loaded the same already-open sandbox Checkout session, after
validating test mode and benchmark-user identity. It currently shows US selected
and one visible billingPostalCode input; the original primary selector matches.
No field value was entered and no payment or webhook was submitted. This does
not reproduce the historical post-fill page and does not justify a country or
selector change.

The helper now records per-selector-index probe, match, visibility and fill
attempt counters plus the last exception class from operations it already
performs. Only its final failure appends this bounded JSON. No new browser probe
or await, URL, selector literal, input value or exception message is emitted.
Its existing await order, nominal30s deadline,500ms sleeps and5000ms fills are
unchanged. The existing registered unit file fails its three diagnostic controls
before the patch and passes8/8 afterward; success still returns after one fill.
These controls prove the observation repair, not a historical cause or a native
payment pass. The parent retains the assigned blocking failure until its actual
required command runs successfully.

## Human feedback

No new human feedback was recorded for this occurrence. Parent coordination
requested bounded diagnosis, preserved payment assertions and budgets, and
rejected a country-setting guess after the same-session probe. This is agent
coordination, not user authorization or an attribution waiver.

## Reusable lesson

Capture the failing hosted-field state and locator exception before attributing a generic form-observation timeout or selecting its repair.
