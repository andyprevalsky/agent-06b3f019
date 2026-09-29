---
id: 2026-09-29-purchase-noun-markers-classified-offer-as-buy
date: 2026-09-29
title: Offer-message schema required order_confirmation_id because purchase-intent matched catalog nouns
surface: agents
component: response-schema-generator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: helpers/llm.py _normalize_response_schema_for_goal — purchase-proof fields were not derived from user-imperative acquire-intent
symptoms:
  - To populate order_confirmation_id, the agent needs a verifiable tool result showing an actual purchase
  - No tool result shows a purchase or supplies an order, receipt, or purchase-confirmation number
  - Verifier score: 50%
  - response_schema contains order_confirmation_id for a Send Aman offer goal
  - Source Order Id
tags:
  - response-schema
  - verifier
  - purchase-intent
  - offer-message
  - order-confirmation-id
sources:
  - agent 2929bc93-8a53-45fb-a4af-30c482b03bbe
repro: agents/tests/blackbox/llm.blackbox.py test_normalize_response_schema_does_not_require_confirmation_for_offer_message_goal
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
  purchase required a labeled ID; `purchase_completion_evidence` is gone from
  current code). Same subsystem, different cause: that case was a true purchase
  with the wrong proof shape. `purchase_completion_evidence` would still have
  failed this iMessage.
- `response_schema required confirmation` → hotel payment-boundary relatives
  that added a skip, not a classifier fix.

Critical path:

1. Mac-app create stored the full 17,622-char catalog plus
   `-> Send Aman all items over 10$...` as `Agent.goal`.
2. Python startup `set_response_schema_activity([fast_cache_goal], include_title=True)`
   used that persisted row. Title `Aman Offer Message` proves the Python path
   (TS `setResponseSchema` does not generate titles).
3. `_is_purchase_goal` substring-matched bare `"purchase"` and `"order"` against
   catalog labels `Purchase Price Usd` / `Source Order Id`.
4. `_normalize_response_schema_for_goal` injected required
   `order_confirmation_id` (and/or the shopping prompt caused the LLM to emit
   the same field — pre-normalize Rose payload was not captured).
5. Verifier demanded purchase proof the send-offer goal never produced.

Step 5a:

- Why 1: schema required `order_confirmation_id`.
- Why 2: normalizer kept/injected it because purchase-intent was true or the
  LLM emitted it.
- Why 3: intent used bare noun markers over the whole goal blob.
- Why 4: purchase-proof contracts were not derived from user-imperative
  acquire-intent, so incidental catalog nouns (or the shopping prompt) could
  impose them on a send/offer goal.
- Why 5 would be "the schema system was designed to force purchase proof" — a
  documented decision for actual buy goals. Stop at Why 4.

Step 5b (not a prompt edit): next-deeper class tried was "never auto-inject
schema fields via keyword heuristics." That fails to be coherent because real
`Buy me a beanie` goals still need confirmation when the LLM under-specifies.
The coherent class is: derive acquire-intent from the user imperative, and do
not keep purchase-proof fields when that intent is absent.

Local repro (pre-fix, identical captured-goal command):

```
is_purchase_goal: True
matching_markers: ['purchase', 'order']
normalized_fields: ['recipient', 'message_body', 'order_confirmation_id']
AssertionError: FAIL: offer/message goal must not require order_confirmation_id
```

Post-fix, the same command (including when `order_confirmation_id` is already
in the generated schema) returns `{recipient, message_body}`.

## Solution

`_is_purchase_goal` matches only imperative acquire phrases (`buy/purchase/order`
+ `me/a/the/...`, `place an order`, `complete checkout`).
`_normalize_response_schema_for_goal` injects confirmation only for acquire-intent
or an explicit confirmation/receipt request, and strips confirmation-identifier
fields otherwise so an LLM over-applying the shopping prompt cannot keep them.

Siblings also prevented: lookup/status goals whose payload mentions `Source Order
Id` or `purchase status`; send goals that mention past orders but do not ask for
a confirmation identifier.

10k-agent behavior: O(1) regex + field filter per schema generation. No shared
state, no per-user fan-in.

Schema generation now logs `generated_fields` vs `normalized_fields` so the next
incident can tell LLM emit from normalizer inject.

## Human feedback

None recorded.

## Reusable lesson

Do not impose purchase-proof schema fields unless the user-imperative asks to
acquire an item or explicitly requests a confirmation identifier — catalog nouns
are not buy-intent.
