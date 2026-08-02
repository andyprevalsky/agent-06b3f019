---
id: 2026-07-23-refund-attempted-on-uncaptured-manual-capture-hold
date: 2026-07-23
title: Purchase cleanup refunded every PaymentIntent, but Stripe requires cancel for an uncaptured manual-capture hold
surface: back-end
component: stripe-purchase-cleanup
classification: our-bug
problem_class: other
first_bad_boundary: back-end purchase cleanup — it issued one reversal operation (refund) without branching on the PaymentIntent's actual Stripe state
symptoms:
  - AgentCard cleanup fails to reverse a purchase PaymentIntent
  - refund attempted on an uncaptured manual-capture hold
  - purchase reclaim leaves an authorization hold outstanding
tags:
  - stripe
  - payment-intent
  - manual-capture
  - purchase-cleanup
  - agentcard
sources:
  - PR #866
repro: back-end/src/tests/blackbox/purchases.reclaim-cancel.blackbox.ts
status: fixed
---

## Problem

When the AgentCard lifecycle timed out and cleanup ran, the reversal step tried to
refund the purchase PaymentIntent. For an uncaptured manual-capture hold Stripe
rejects that: the correct reversal is canceling the PaymentIntent, not refunding
it. The hold therefore stayed outstanding after a "cleanup" that reported having
handled it.

## Diagnosis

Cleanup treated "reverse this purchase" as a single operation and always chose
refund, but a purchase PaymentIntent can legitimately be in several states by the
time cleanup runs: an uncaptured manual-capture authorization, a captured charge,
or already-canceled/no-charge. Only the captured case is refundable. The deeper
owned cause is a compensating action written against one assumed state of an
external resource instead of reading that resource's actual state first — so the
compensation is correct only for the happy-path timing and silently wrong for the
timeout path, which is exactly when it is needed. This surfaced together with the
AgentCard mint timeout in the same run: the timeout produced the cleanup, and the
cleanup then failed on the state it had never modeled.

## Solution

Purchase reversal now branches on the live Stripe state: cancel uncaptured
manual-capture holds, refund captured charges, and noop on already-canceled or
no-charge states. Landed in the back-end Stripe/purchase-cleanup providers with a
blackbox case pinning the uncaptured reclaim-cancel path, which also prevents the
sibling failure of double-reversing an already-canceled intent.

## Human feedback

None recorded.

## Reusable lesson

Read the external resource's actual state before running a compensating action —
one hard-coded reversal verb (always refund, always delete, always cancel) is
wrong for at least one state you will only hit on the failure path.
