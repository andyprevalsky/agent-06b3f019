---
id: 2026-09-11-stale-purchase-cleanup-marked-failed-before-reversal
date: 2026-09-11
title: Stale purchase cleanup wrote terminal FAILED after an unsuccessful Stripe reversal
surface: back-end
component: stale-purchase-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: reconcileStaleChargingPurchases swallowed cancellation errors before writing FAILED
symptoms:
  - Failed to cancel Stripe hold for stale CHARGING purchase
  - an unconfirmed Stripe reversal cannot become terminal FAILED
  - terminal purchase state can retain an unreleased authorization
tags:
  - purchase
  - stripe
  - refund
  - cleanup
  - terminal-state
sources:
  - PR #1299
repro: back-end/src/tests/blackbox/purchases-stale-reversal.blackbox.ts
status: fixed
---

## Problem

An independent review of the interrupted-payment finalizer found that its
terminal database predicate depended on a false terminal writer: stale CHARGING
cleanup caught a Stripe cancellation error and then unconditionally changed the
purchase to FAILED. A no-card, no-funding purchase could retain an authorization
while looking safe to remove. This was a controlled source/test finding, not an
observed outcome of the interrupted benchmark's successful captured payment.

## Diagnosis

Critical path: stale CHARGING query → successful/no-op funding reclaim →
`cancelAuthorizedHold` → caught cancellation failure → unconditional FAILED.
The failure catch logged a warning but lost the distinction between an attempted
reversal and a confirmed reversal. It also assumed every payment was uncaptured,
although the canonical reversal helper already handles captured charges.

The reviewer's isolated producer replay reproduced FAILED on cancellation error
and showed the finalizer accepting it. The permanent blackbox then exercised the
real reconciler and database with the existing fake Stripe boundary. Before the
fix, the unsuccessful cancellation case expected REFUND_FAILED and got FAILED;
the captured-payment case expected one refund and observed a cancellation. A
successful uncaptured cancellation control passed. Exact evidence is
`payment-finalizer-repro/backend-stale-reversal-red.log` under
`.context/acceptance/group4-temporal-rate-limit-rca/`.

Archive search `stale CHARGING cancel Stripe hold FAILED refund` found the July 23
case about refunding uncaptured holds. That case supplied the existing canonical
state-aware reversal helper. This finding is the separate false-terminal writer:
its catch continued after failure, so merely choosing the correct operation did
not preserve the database's terminal-state contract.

## Solution

The stale reconciler now uses `reversePurchasePaymentIntent` after funding
reclamation. Its small `purchaseStaleReversal` helper reports REFUNDED for a
confirmed captured-payment reversal, FAILED after confirmed cancellation or a
canonical no-charge result, and REFUND_FAILED when reversal throws. The existing
failed-refund reconciler retries the same purchase and idempotency key. The helper
keeps the existing cleanup module within its line limit; the cleanup selection
and funding reclamation sequence are unchanged.

The unchanged permanent regression passed all three cases after repair and again
through the canonical discovered runner, including recovery of REFUND_FAILED to
FAILED after a later successful cancellation. Evidence is
`backend-stale-reversal-green.log` and
`backend-final-owning-v2/purchases-stale-reversal.log` in the same private directory. All
five selected owning purchase domains passed. Independent review reproduced the
original false-terminal result and approved the repair and case precision. The parent separately owns the
canonical Stripe refund-status acknowledgement repair and the full deployment
validation loop.

At 10,000 runs this changes only the existing stale cleanup path. It uses one
canonical reversal and the existing retry state, with no extra inventory scan,
new retry loop or larger timeout. A transient provider failure stays visible to
the finalizer, which must retain recovery state until compensation completes.

## Human feedback

None recorded for this specific defect.

## Reusable lesson

Write a terminal cleanup state only after the compensating operation confirms completion, and preserve a retryable state on ambiguity or failure.
