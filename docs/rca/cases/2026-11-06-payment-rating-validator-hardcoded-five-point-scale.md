---
id: 2026-11-06-payment-rating-validator-hardcoded-five-point-scale
date: 2026-11-06
title: request_payment_card rejected hotels.com's truthful "9.2 out of 10" rating because the rating validator only accepted a 0-5 score
surface: agents
component: purchase-approval-validation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/utils/purchase_approval.py validate_product_rating — _RATING_RE/0<=score<=5 assumed every merchant rates out of 5 stars, so PaymentLineItem.rating (browser_tools/schemas.py) rejected the verbatim page rating "9.2 out of 10"
symptoms:
  - "line_items.0.rating: Value error, rating must include a numeric product score from 0 to 5"
  - "Browser tool args rejected (request_payment_card); feeding validation error back to model"
  - "Your `request_payment_card` tool call was rejected because its arguments failed validation"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
  - "browser-hotel-booking hotels.com 9.2 out of 10 rating rejected; browser agent reported failure instead of requesting the card"
tags:
  - browser-agent
  - payment-card
  - purchase-approval
  - schema-contract
  - rating-scale
  - hotels
sources:
  - agent 3e9daf89-9a8f-4a2b-b129-790054538b4a
  - fleet run 20261106-133017-1022145 (campaign-20261106-125707-4128298 job r001-j0020, source a17dbe5aec)
  - task browser-hotel-booking
  - commit d1cdf63c0f (introduced the 0-5 rule, 2026-07-10)
repro: agents/tests/blackbox/request_payment_card.blackbox.py::test_rating_keeps_the_merchant_scale_shown_on_the_page
status: open
---

## Problem

`browser-hotel-booking` (descend batch 2, job r001-j0020, agent `3e9daf89`) reached the
hotels.com guest checkout for Hotel Kabuki and called `request_payment_card` at browser
step 40 (13:58:36Z). The call was rejected before execution:
`- line_items.0.rating: Value error, rating must include a numeric product score from 0 to 5`.
The captured params (verifier dump, action-history step 63) show
`'rating': '9.2 out of 10'`, and the checkout/property DOM shows exactly
`9.2 out of 10 Wonderful ... 1,000 reviews`. The browser agent then reported the failure
(its reasoning: "I need to stop after a request failure"), no `payment_approval` attention
was created, and the root finished 6 s past the 1125 s task timeout.

## Diagnosis

Critical path: page DOM -> browser model tool call -> `validate_browser_tool_args`
(`browser_tools/schemas.py`) -> `RequestPaymentCardBrowserTool.PaymentLineItem.rating`
-> `utils/purchase_approval.validate_product_rating` -> (rejected) -> tool-result
feedback -> no card request -> no approval.

- The data was correct at the model: the submitted rating is verbatim page text.
- It first went wrong at `validate_product_rating`: `_RATING_RE` took `9.2` and the
  `0 <= score <= 5` check rejected it. Local repro of the exact captured params through
  `validate_browser_tool_args` raises the identical production message.
- Why possible: the 0-5 rule (commit d1cdf63c0f, July 2026) encoded one merchant
  convention (Amazon-style stars) as a universal invariant. No consumer needs it: the
  backend stores `rating` as a free string, the approval UI renders
  `Reviews: {rating} · {reviewCount}`, and SMS renders `Rating: {rating}`.
- Why the agent stopped: the tool contract forbids a made-up number and the page shows a
  rating, so no truthful value satisfied the validator (rescaling to 4.6 stars or passing
  "0 stars" would both misstate the page); the root's goal also said "If ... the
  payment-card request fails, report the precise failure". Stopping was the honest
  response to an unsatisfiable contract, not a separate defect.
- Relative of 2026-07-24-request-payment-card-schema-unsatisfiable-on-single-page-merchants
  (same class: payment-card receipt contract unsatisfiable for a class of merchants);
  this is a different field/cause, not a recurrence of that case's product_url issue.

## Solution

Candidate on branch `rca/h-22-20261106` (approval pending for the LLM-visible error
text; outcome proof pending): `validate_product_rating` parses a score plus the scale the
page shows (`/N`, `out of N`, `of N`, `%`), requires `0 <= score <= scale`, and
normalizes deterministically — five-point ratings keep `"<score> stars"` (existing
fingerprints and fixtures unchanged), other scales become `"<score>/<scale>"` or
`"<score>%"`. A score with an explicit scale is preferred over an unrelated bare number.
Bare scores above 5 and scores above their scale are still rejected, with an error that
names the expected form ("'4.8 stars' or '9.2 out of 10'"). Placeholder and review-count
rejection are unchanged. Tool descriptions are unchanged (they already say "rating shown on
the product page"), so browser tool bytes and the phone-off golden hashes are stable.
Sibling failures prevented: 10-point hotel/booking sites (Booking.com, Expedia,
hotels.com), 100-point/percent ratings (Metacritic, Tomatometer, seller feedback), and the
`generate_write_lock_notification` purchase item, which shares the validator.
10k-agent behavior: pure in-process string validation per tool call; no I/O, shared
state, or per-agent growth.

Golden reference: claude-code-src/src/services/tools/toolExecution.ts:615-675 with
src/utils/toolErrors.ts:66 (invalid input returned as an is_error tool_result naming the
parameter and expected shape); codex/codex-rs/core/src/tools/handlers/mod.rs:86-92
(parse failure returned to the model with the expected-field detail);
hermes-agent/tools/arg_coercion.py:1-7,20 (schema-guided conservative normalization of
equivalent representations, keeping originals when ambiguous); openclaw
src/agents/agent-tool-definition-adapter.ts:606-610 (ToolInputError message returned as
a tool error). The fix converges: accept and unambiguously normalize the truthful value,
and make the remaining rejection state the expected form.

## Human feedback

None recorded.

## Reusable lesson

Validate that a receipt field is real and internally consistent, never that it matches
one merchant's display convention; carry the source's scale or unit with the value.
