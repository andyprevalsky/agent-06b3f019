---
id: 2026-09-29-purchase-noun-markers-classified-offer-as-buy
date: 2026-09-29
title: Offer-message schema required order_confirmation_id because a post-hoc classifier mutated the model schema
surface: agents
component: response-schema-generator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: helpers/llm.py _normalize_response_schema_for_goal — a keyword classifier injected purchase-proof fields after the model chose the schema
symptoms:
  - To populate order_confirmation_id, the agent needs a verifiable tool result showing an actual purchase
  - No tool result shows a purchase or supplies an order, receipt, or purchase-confirmation number
  - Verifier score: 50%
  - response_schema contains order_confirmation_id for a Send Aman offer goal
  - Source Order Id
tags:
  - response-schema
  - verifier
  - offer-message
  - order-confirmation-id
  - schema-normalizer
sources:
  - agent 2929bc93-8a53-45fb-a4af-30c482b03bbe
  - PR #1324
repro: agents/tests/blackbox/llm.blackbox.py test_set_response_schema_activity_persists_model_fields_for_offer_goal
status: fixed
---

## Problem

Agent `2929bc93-8a53-45fb-a4af-30c482b03bbe` (title `Aman Offer Message`) was
asked to send Aman an 80% offer for items over $10. It sent the iMessage via
`message_person`. The verifier then rejected completion at 50%:

```
The message_person tool result confirms an iMessage sent to Aman (+17134712306)
and provides the complete sent message, so recipient and message_body are
grounded. No tool result shows a purchase or supplies an order, receipt, or
purchase-confirmation number. ... To populate order_confirmation_id, the agent
needs a verifiable tool result showing an actual purchase
```

The stored schema was `{recipient, message_body, order_confirmation_id}` (all
required). The agent spawned explore + browser to hunt Amazon order IDs. The
user paused that session.

The plan itself said: "The user's request is an offer to Aman, not authorization
to place a new purchase."

## Diagnosis

Archive searches (relative, not recurrence):

- `order_confirmation_id required` →
  `2026-08-03-generic-purchase-schema-required-provider-order-id` (real DoorDash
  purchase required a labeled ID). Same subsystem, different cause.
- `response_schema required confirmation` → hotel payment-boundary relatives
  that added another skip on the same classifier.

Critical path:

1. Mac-app create stored the full catalog plus
   `-> Send Aman all items over 10$...` as `Agent.goal`.
2. Python startup `set_response_schema_activity([fast_cache_goal], include_title=True)`
   used that persisted row.
3. The model produced a send-offer schema (`recipient`, `message_body`).
4. `_normalize_response_schema_for_goal` / `_is_purchase_goal` then injected
   required `order_confirmation_id` because catalog labels contained
   `"purchase"` and `"order"`.
5. Verifier demanded purchase proof the send-offer goal never produced.

Step 5a:

- Why 1: schema required `order_confirmation_id`.
- Why 2: a post-hoc normalizer added it after the model chose the fields.
- Why 3: the harness kept a second source of truth (keyword classifier) on top
  of schema generation.
- Why 4 would be "schema generation was designed to need a safety net" — that
  is the rejected layer. Stop at Why 3: delete the classifier.

An earlier pass on this RCA tightened the regex and added strip logic. That
was the wrong depth: it kept the second source of truth.

## Solution

Deleted `_normalize_response_schema_for_goal`, `_is_purchase_goal`, and the
confirmation inject/strip helpers. `set_response_schema_activity` persists
exactly the fields the model emitted.

10k-agent behavior: one schema-generation LLM call per agent, no extra
per-goal regex mutation, no shared state.

## Human feedback

Do not add a purchase-intent classifier on top of schema generation. The
model determines the schema. Tightening the keyword regex is still the
rejected layer.

## Reusable lesson

Persist the model-generated response schema; do not mutate it with keyword
classifiers.
