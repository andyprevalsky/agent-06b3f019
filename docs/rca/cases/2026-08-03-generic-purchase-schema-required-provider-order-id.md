---
id: 2026-08-03-generic-purchase-schema-required-provider-order-id
date: 2026-08-03
title: Generic purchase schemas required an order identifier even when the provider exposed only a native completion status
surface: agents
component: response-schema-generator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: response-schema generation — the generic purchase rule narrowed valid completion proof to a labeled order or receipt identifier
symptoms:
  - DoorDash order was placed but verifier rejected the result because no explicitly labeled confirmation ID was visible
  - parent agent opened a second browser session to search for an identifier the user did not request
  - purchase output schema contains doordash_order_confirmation_id for a generic Complete checkout goal
tags:
  - browser-agent
  - ecommerce
  - response-schema
  - provider-contract
  - verifier
sources:
  - agent 43ffeb05-a5e4-4073-9293-0c1c2870ee77
repro: agents/tests/blackbox/llm.blackbox.py test_normalize_response_schema_for_generic_purchase_accepts_provider_native_completion_evidence
status: fixed
---

## Problem

The DoorDash benchmark asked the agent to buy one constrained cable and complete
checkout. The browser placed the order and reached DoorDash's native
"Shopping in progress" state, but the generated parent schema required
`doordash_order_confirmation_id`. The browser verifier scored the result 0.5
because no explicitly labeled identifier was visible, and the parent opened a
second browser session to search for one.

## Diagnosis

The first bad boundary was the response-schema contract, not model reasoning.
The schema system prompt said every generic shopping goal must require an order,
confirmation, or receipt identifier, and deterministic normalization added an
`order_confirmation_id` when the generated schema omitted one. That rule
conflated proof that a purchase completed with one optional representation of
that proof. Providers may expose an explicit completion or status page without
displaying a labeled identifier, so a valid native terminal state became
unrepresentable. The agent then pursued the impossible required field and
violated the benchmark's one-browser-session contract.

## Solution

Generic purchase schemas now require `purchase_completion_evidence`, which the
verifier may populate from a labeled order, confirmation, or receipt identifier
when one is displayed, or from an explicit provider-native confirmation/status
page. Identifier-shaped generated fields are replaced for generic purchase
goals. If the user explicitly asks for an order, confirmation, or receipt
identifier, normalization still preserves or adds that strict field. The exact
DoorDash goal and generated schema are pinned in the blackbox regression.

## Human feedback

None recorded.

## Reusable lesson

Represent provider completion as a semantic terminal state unless the user explicitly requires one provider-specific identifier.
