---
id: 2026-07-25-unmocked-stripe-search-produced-a-false-pass-via-substring
date: 2026-07-25
title: An unmocked Stripe search in a blackbox hit the real API with a placeholder key, and its error message substring-matched as a pass
surface: back-end
component: purchases-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "test-payment lifecycle blackboxes — searchStripeHolds was left unmocked, so stripe.paymentIntents.search() ran against the harness placeholder key"
symptoms:
  - '"Invalid API Key provided" returned from stripe.paymentIntents.search()'
  - spurious payment-lifecycle blackbox failures under the capture harness
  - 'a false PASS because "Invalid API Key provided" contains the substring "id"'
tags:
  - blackbox
  - stripe
  - hermeticity
  - false-pass
  - substring-assertion
sources:
  - PR #871
  - memory:project_temporal_cutover_first_prod_deploy
repro: none-recorded
status: fixed
---

## Problem

The test-payment lifecycle blackboxes left `searchStripeHolds` unmocked, so
`stripe.paymentIntents.search()` executed for real using the harness placeholder key
(`blackbox-auto-rca-env.sh` forces `STRIPE_SECRET_KEY=sk_test_blackbox_capture_only`).
That produced spurious failures — and worse, a false PASS: the error string
`"Invalid API Key provided"` contains the substring `"id"`, which an assertion
looking for an id accepted.

## Diagnosis

Two independent defects compounded. First, a hermeticity hole: one code path in an
otherwise-stubbed suite still reached a third-party API, so results depended on
ambient credentials. Second, a substring assertion on an opaque identifier accepted
error text as evidence of success — the check could not distinguish "an id" from "any
string containing those two characters", so the suite reported green while the code
path had never worked.

## Solution

Fixed on main with hermeticity stubs so the payment-lifecycle blackboxes no longer
call Stripe with the placeholder key.

## Human feedback

None recorded.

## Reusable lesson

Close every third-party call in a blackbox suite, and never assert an identifier by
substring — an error message that happens to contain the substring turns a broken path
into a green test.
