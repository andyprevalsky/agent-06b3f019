---
id: 2026-08-10-eventim-payment-fields-empty-page-truth
date: 2026-08-10
title: Eventim Billing/Payment fields missing for LLM because page shell never mounts them
surface: agents
component: spawn-browser-agent-v3
classification: external
problem_class: other
first_bad_boundary: Eventim guest checkout page — Billing Address / Payment Details render headers only (0 inputs/selects/iframes in those sections)
symptoms:
  - Browser LLM sees Billing Address / Payment Details headers with no card or address fields
  - Agent evaluate reports inputs:0, selects:0, iframes:0 under those section titles
  - Screenshot tool images show the same blank white shells
tags:
  - browser-agent
  - eventim
  - payment-card
  - empty-shell
  - stripe
sources:
  - agent 5d59430b-8c5c-4b93-98ab-da7b77a46af7 (FAIL)
  - agent 7f91554e-9cc5-4ea2-bf29-1dc75578511f (PASS)
  - agent ce52f350-ec60-417a-89d1-ecef08a391ea (post-H-03 FAIL)
  - run agents/benchmarks/runs/20260810_205819_browser-1015-eventim-request-card.json
  - run agents/benchmarks/runs/20260810_073019_browser-1015-eventim-request-card.json
  - run agents/benchmarks/runs/20260810_215512_browser-1015-eventim-request-card.json
status: closed
---

## Problem

After H-01 recovery scoring fix, Eventim checkout still showed Billing Address /
Payment Details as empty headers. Question: why did those fields not appear for
the LLM — observation pipeline gap, or page truth?

## Diagnosis (evidence)

1. **DOM / evaluate (FAIL):** section probe returned
   `Billing Address {inputs:0, selects:0, iframes:0}` and
   `Payment Details {inputs:0, selects:0, iframes:0}`. Interactive `dom_tree`
   only had the header text labels plus an anonymous page-level iframe (Rokt),
   not card/country inputs.

2. **Screenshot reached the LLM (FAIL):** `screenshot` tool returned
   `screenshot_attached:true`; LLM dump step 20 includes a user multimodal
   message with the viewport image. That image shows blank white under both
   headers — same emptiness as the DOM.

3. **Recording frames (FAIL + PASS):** mid-checkout frames for both agents show
   the same empty Billing / Payment shells under the headers.

4. **PASS had the same empty shell:** pass agent
   `7f91554e-9cc5-4ea2-bf29-1dc75578511f` also observed collapsed/empty Billing
   and Payment sections, then called `request_payment_card` anyway and passed.

5. **API symptoms are shared, not FAIL-unique:**
   - `OrderDetails.connectedStripeAccount` is `null` on both PASS and FAIL.
   - `customer-api.eventim.us/api/WhiteLabel` returns 404 on both.
   - `js.stripe.com/v3` has occasional `ERR_BLOCKED_BY_ORB` on both, while most
     Stripe/`elements-inner` requests still return 200 on both.

6. **Ruled out as primary cause of emptiness:**
   - Cross-origin iframe DOM blindness: sections contain **zero** iframes; this
     is not “fields exist inside Stripe iframes that DOM cannot see.”
   - Missing auto-vision (`get_browser_state(include_screenshot=False)`):
     explicit screenshot tool still delivered the empty shell to the model.

Cluster: **External Dependency Failure** (Eventim checkout mounts an empty
payment/billing shell). Not a Broken Tool in our DOM/screenshot path for this
symptom. Distinct from H-02 (agent deferred `request_payment_card` despite
knowing it was the payment step).

## Solution

No harness fix for “make Eventim fields appear.” Empty shells are page truth on
both passing and failing runs; the payment-card request must not wait for
Country/Stripe inputs to mount.

## Human feedback

Andy asked to RCA why fields were not appearing for the LLM (after rejecting an
empty-shell nudge).
