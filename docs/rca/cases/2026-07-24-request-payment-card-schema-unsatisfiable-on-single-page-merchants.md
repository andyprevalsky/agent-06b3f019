---
id: 2026-07-24-request-payment-card-schema-unsatisfiable-on-single-page-merchants
date: 2026-07-24
title: `request_payment_card` demands a product-detail URL, rating and review count that single-page food merchants do not have
surface: agents
component: browser-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/schemas.py:321 RequestPaymentCardBrowserTool / PaymentLineItem:262 — per-line-item product_url, numeric rating and review_count are all required
symptoms:
  - "5 consecutive Pydantic ValidationErrors on product_url, rating, review_count"
  - "validate_product_detail_url rejects the submitted cart/checkout URL"
  - '"No rating displayed on Toast ordering page" submitted as the rating value'
tags:
  - browser-agent
  - payment-card
  - schema-contract
  - food-ordering
  - unsatisfiable
sources:
  - agent 847adea5
  - memory:project_request_payment_card_unsatisfiable_food_ordering
repro: none-recorded
status: open
---

## Problem

While ordering fish & chips on `order.toasttab.com` (prod agent `847adea5`, 2026-07-24)
the browser sub-agent could not construct a valid `request_payment_card` call at all. It
produced five consecutive Pydantic `ValidationError`s and aborted.

## Diagnosis

`RequestPaymentCardBrowserTool` (`agents/browser_tools/schemas.py:321`, with
`PaymentLineItem:262`) requires, **per line item**: a `product_url` that
`validate_product_detail_url` (`agents/utils/purchase_approval.py:131`) accepts — it
rejects cart and checkout URLs — plus a numeric `rating` and a numeric `review_count`.

Toast restaurant ordering is a **single-URL SPA**: menu, cart, and checkout share one
URL, there is no product-detail page, and there are no star ratings or review counts.
The model behaved honestly, submitting the checkout URL and the literal
"No rating displayed on Toast ordering page" — and was rejected three ways.

Reproduced locally: `model_validate` on the captured payload yields exactly three errors
(`product_url`, `rating`, `review_count`), matching prod. So the contract is not merely
strict; it is **unsatisfiable** on this whole class of merchant, and no amount of model
competence can satisfy it.

Confirmed again after the separate error-feedback fix landed: with the validation error
now visible, the model self-corrects by hunting for a product-detail page and rating that
Toast simply does not have, burning steps toward `MAX_ITERATIONS`.

## Solution

Not yet fixed. The recorded direction is to relax `product_url`, `rating` and
`review_count` to optional — or fill them from an earlier product-page observation when
one exists — so that single-page merchants are representable. Until then the model
self-corrects forever with no valid answer available.

## Human feedback

The user separated the two defects explicitly: fixing the error-feedback path was the
first, required change, and relaxing the payment-card contract is a distinct follow-up —
and neither was to be addressed by adding an escape hatch that bypasses validation.

## Reusable lesson

Before blaming the model for repeated tool-arg validation failures, check whether the
schema is satisfiable on the target site at all — single-page merchants have no
product-detail URL, rating, or review count to supply.
