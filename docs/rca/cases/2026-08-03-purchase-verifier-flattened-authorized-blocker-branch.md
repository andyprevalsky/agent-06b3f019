---
id: 2026-08-03-purchase-verifier-flattened-authorized-blocker-branch
date: 2026-08-03
title: The purchase verifier flattened an authorized inventory-blocker branch
surface: agents
component: response-schema-verifier
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: commit c549523c4 — the task authorized an exact-brand blocker while its flat evaluator still required checkout evidence
symptoms:
  - verifier accepted the exact Essentia blocker but rejected missing selected delivery window
  - purchase_completion_evidence was required when no purchase was permitted
  - Max iterations (50) reached after repeated blocker completion attempts
tags:
  - benchmark
  - instacart
  - verifier
  - response-schema
  - blocker
  - checkout
sources:
  - commit c549523c4b
  - commit b7081bc713
  - plan:agents/benchmarks/runs/20260803_223558_browser-opentable-reservation,browser-instacart-grocery-order,browser-alchemy-springs-sauna,browser-hotel-booking,browser-event-ticket,browser-imax-group-tickets,minted-agent-accounts-uber.json
  - agent 158e62f6-a351-4f33-b6fe-4ed2690dd881
repro: agents/tests/blackbox/llm.blackbox.py test_normalize_response_schema_preserves_authorized_exact_brand_blocker_branch
status: open
---

## Problem

The exact task prompt was: “Use Instacart to order my weekly groceries from a
single San Francisco grocery store for delivery to my saved address: one
standard package of blueberries, one standard package of strawberries, one 16
oz Cocojune yogurt (prefer plain), one standard jar of pickles, one standard
package of feta cheese, one standard jar of olives, and one 12-pack of 1 L
Essentia ionized alkaline water. Prefer inexpensive, well-rated options and keep
the item subtotal at or below $60. Do not substitute Cocojune or Essentia; if
either exact brand is unavailable, report the blocker rather than replacing it.
Allow only like-for-like substitutions for the other products. Choose the
earliest available delivery window. Complete checkout and stop at the
payment/write-lock approval if the harness requires it.”

The browser grounded that Raley's carried the required Cocojune and did not
offer the required Essentia pack. Its generated response schema nevertheless
required the ordered basket, subtotal, selected delivery window, blocker
evidence, and purchase completion evidence simultaneously. The verifier
recognized the exact blocker, then rejected completion because no delivery
window or purchase confirmation existed. Repeated attempts consumed 50 browser
steps and caused the benchmark timeout.

## Diagnosis

The task has mutually exclusive terminal branches: complete checkout when both
exact brands are available, or report the exact blocker without substitution
when either is unavailable. Its benchmark judge and generated response schema
flattened those branches into an all-of contract. The general purchase schema
normalizer then unconditionally appended `purchase_completion_evidence`, making
the authorized no-purchase branch impossible even if the model generated a
branch-neutral blocker field.

Archive search found the related DoorDash all-of attention case, but not this
response-schema boundary. The permanent reproduction uses the captured shape:
store, basket, subtotal, window, branch-neutral evidence, and final URL. Before
the fix, normalization retained every checkout-only field and appended purchase
completion evidence. The fixed schema preserves every success field and adds a
required `terminal_outcome` discriminator plus branch-neutral provider
evidence. A valid purchase must populate every success field. An authorized
blocker must provide exact provider-grounded evidence and set the inapplicable
success fields to null. Missing evidence and incomplete purchases both fail.

## Solution

Response-schema generation now teaches explicit reported blockers as alternate
terminal outcomes. The detector couples the conditional unavailability and
report instruction within the same sentence, avoiding unrelated blocker
language. Normalization retains every original success field as a key-required,
nullable branch field and adds exact outcome and evidence requirements. The
runtime validator and strict JSON schema enforce the branch rules, while the
verifier prompt requires provider-native exact-brand unavailability and forbids
weak absence claims. The blocker branch rejects every populated success field,
and tasks with an authorized blocker bypass the generic completed-child shortcut
so the semantic verifier must evaluate the branch against the full goal and
trajectory. This is not terminal relaxation: a completed-purchase claim must
still satisfy the entire original success contract.

The proposed benchmark-catalog fix makes the Instacart semantic judge equally
branch-aware: the success branch retains all seven items, single store, subtotal,
delivery, substitution, and checkout requirements; the blocker branch requires
provider-native exact-brand evidence and forbids substitution without demanding
a cart, delivery window, or purchase. The catalog change remains approval-gated,
and an exact benchmark rerun remains required for outcome proof.

## Human feedback

None recorded.

## Reusable lesson

Model prompt-authorized terminal alternatives as distinct branches instead of requiring mutually exclusive evidence together.
