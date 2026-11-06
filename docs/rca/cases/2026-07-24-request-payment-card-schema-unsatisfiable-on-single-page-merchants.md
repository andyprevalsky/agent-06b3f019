---
id: 2026-07-24-request-payment-card-schema-unsatisfiable-on-single-page-merchants
date: 2026-07-24
title: `request_payment_card` demands a product-detail URL, rating and review count that single-page food merchants do not have
surface: agents
component: browser-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: LLM-visible product_url contract (PaymentLineItem / WriteLockPurchaseItem field descriptions in agents/browser_tools/schemas.py, request_payment_card + generate_write_lock_notification text in agents/providers/rose/browser_use.py, Purchase Approval Context + write-lock example notes in spawn_browser_agent_v3/handler.py) demands a canonical product-detail page that the validator (agents/utils/purchase_approval.py, well-formed URL on a visited host since 2026-07-28) does not require and that modal/single-page merchants do not have
symptoms:
  - "5 consecutive Pydantic ValidationErrors on product_url, rating, review_count"
  - "validate_product_detail_url rejects the submitted cart/checkout URL"
  - "I need a genuine product URL for the item in question"
  - "the site modal doesn't change the URL"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
tags:
  - browser-agent
  - payment-card
  - schema-contract
  - food-ordering
  - unsatisfiable
  - modal-menu
  - prompt-validator-drift
sources:
  - agent 847adea5
  - memory:project_request_payment_card_unsatisfiable_food_ordering
  - commit 503891cedc
  - agent 7d569891-5083-4a3d-8d0b-1ce80c3cb4c0
  - plan:descend H-38 (descend-failed-neverrun-20261106, batch 3 epoch 1)
repro: agents/tests/blackbox/request_payment_card.blackbox.py::test_modal_menu_item_without_its_own_page_is_satisfiable_and_the_contract_teaches_it
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

### 2026-11-06 recurrence (H-38): enforcement was relaxed, the LLM-visible contract was not

`browser-blue-bottle-challenge-recovery` r1 (agent `7d569891`, campaign
`campaign-20261106-185145-1109152`) timed out at 1200 s with no payment approval and
zero cart actions. On `sf-classic.order.online` the shakerato opens as a modal over the
store menu: the item has no page of its own. The browser agent's own reasoning (archived
`browser_use_step_*` dumps) shows it spent ~19 min (19:19–19:38 UTC) "reverse-engineering
script modules" and network bodies for "a genuine product URL", hit one 15 s evaluate
timeout (`renderer_main_thread_blocked`), and never added the item to the cart. It never
called `request_payment_card`, so no validator ran.

Every LLM-visible surface it saw still said "Canonical product-detail page URL ... must
link to the product itself" (tool field), "Every item MUST include its canonical
product-detail URL" (tool description) and "collect every item's canonical product-detail
URL ... A purchase approval is blocked if any item lacks these fields" (system prompt).
But commit `503891cedc` (2026-07-28, Andy: keep only "ensure it's a real url") had already
reduced enforcement to a well-formed absolute URL, and `50bfd527f1` added only a
visited-host check. The store URL the item was selected on is therefore accepted. The
earlier fix relaxed the validator but left the model being told the old, unsatisfiable
rule, so the self-correction loop recorded above moved from post-call retries to
pre-call hunting.

Classification: Prompting Inconsistency (LLM-visible contract stricter than, and
inconsistent with, the enforced contract). Step 5b: the instance (modal item) climbs to
"required approval-evidence fields must name the truthful value available when the ideal
does not exist" (rating/review_count already teach `0 stars`/`0 reviews`; product_url
did not). The next-deeper class, "LLM-visible requirement text must be generated from
the validator", is not coherent: a host/well-formedness check cannot express which page
a person should be sent to, so the guidance must remain prose, kept in one shared
constant beside the validator.

## Solution

2026-11-06 (H-38, branch `rca/h-38-20261106`, pending approval): one shared
`PRODUCT_URL_GUIDANCE` in `agents/utils/purchase_approval.py` states the enforced
contract: use the item's own product page when it has one, otherwise the URL of the page
where it was selected, without searching for a URL the site does not have and without
substituting a cart/checkout URL when the item is shown elsewhere. Every LLM-visible
product_url statement (Pydantic field descriptions, Rose browser-use tool definitions,
Purchase Approval Context and the write-lock purchase example) uses it. The validator is
unchanged: non-URLs and unvisited hosts remain rejected. Regression:
`test_modal_menu_item_without_its_own_page_is_satisfiable_and_the_contract_teaches_it`
(red on `3271548804`, green on the fix). Outcome proof on the exact benchmark is still
pending. Earlier note: The recorded direction is to relax `product_url`, `rating` and
`review_count` to optional — or fill them from an earlier product-page observation when
one exists — so that single-page merchants are representable. Until then the model
self-corrects forever with no valid answer available.

## Human feedback

The user separated the two defects explicitly: fixing the error-feedback path was the
first, required change, and relaxing the payment-card contract is a distinct follow-up —
and neither was to be addressed by adding an escape hatch that bypasses validation.

## Reusable lesson

When a validator is relaxed, update every LLM-visible statement of that contract in the same change, and before blaming the model for hunting or repeated tool-arg failures, check whether the contract it was shown is satisfiable on the target site (single-page and modal merchants have no product-detail URL).
