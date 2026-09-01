---
id: 2026-08-29-blue-bottle-abandoned-ferry-orderable-as-unavailable
date: 2026-08-29
title: Blue Bottle browser abandoned Ferry ordering after a short DoorDash store-list miss, then completed as a structured failure with empty cart
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: other
first_bad_boundary: browser agent attempt_completion after concluding Ferry Building was not orderable from a partial order.online store list — while sibling k=5 trials ordered Ferry successfully on the same stack
symptoms:
  - Expected payment_approval attention request (to ignore) but none was triggered
  - Failure — checkout was not reached
  - items in cart: 0
  - Progress: 100%
  - The Ferry might not offer online ordering at all
tags:
  - blue-bottle
  - ferry-building
  - payment-approval
  - attempt-completion
  - store-finder
sources:
  - fleet run 670cb9b0-5781-4c46-a4e8-9b93c3910842
  - agent f153afee-867c-4b83-a09a-6ff4f2b94925
  - PR #1069
repro: pending — needs owning-boundary repro; outcome seen on unchanged scripts/run-bench --local browser-blue-bottle-challenge-recovery
status: open
---

## Problem

Post kill-switch k=5 trial `f153afee` (393s, COMPLETED, approvals_triggered=0) found the
Ferry Building cafe page, left order.online after Ferry was absent from a ~23-store list,
returned structured failure (`order_total_usd=0`, `payment_card_requested=false`), and both
browser + root verifiers scored Progress 100% / Task Complete. Static contract correctly
failed: no `payment_approval`.

Sibling trials on the same run ordered Ferry successfully (`1cba6647` pass; `25a909af`
reached payment with Ferry grounding).

## Diagnosis

Archive searches: `Expected payment_approval attention request but none was triggered`,
`browser timeout no payment_approval cookie_bundle guest`. Hits are relatives (Momence
auth_assistance, evaluate timeouts) — **novel** for “Ferry marked unavailable then
schema-complete failure exit” under guest kill-switch.

Critical path: spawn_browser → LOCAL CAFE PICKUP → store finder click Ferry → leave to
bluebottlecoffee.com cafe detail → empty cart → attempt_completion with failure schema →
root completes → harness fails expected payment_approval.

First observed wrong decision: assistant concluded Ferry was not orderable from one store
list sample despite live_targets and siblings proving it is. Verifier 100% on a filled
failure schema is consistent with schema-presence scoring, not a false bench pass.

Hard gate: no isolated owning-boundary repro yet that forces this abandon path without a
full live bench. Kept **open** (not model-intelligence — Step 3a replay unmet).

## Solution

**Proposed (needs evidence + approval):** Strengthen store-selection recovery when the goal
names a specific cafe that is briefly missing from order.online results (retry search /
scroll / use live_targets URL) before attempt_completion; optionally refuse Progress 100%
when required payment boundary fields are false and the task expects payment_approval.

Do not bump the 1200s timeout. Do not weaken expected_approval_count.

## Human feedback

User asked for k=5 + `/rca` of failing runs after the kill-switch fix.

## Reusable lesson

A sibling pass on the same k=5 proves the merchant path was live — treat “location
unavailable” completions as suspect until the agent exhausted the catalog live_targets URL
and repeated store search, not one partial store list.
