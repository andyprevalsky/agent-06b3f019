---
id: 2026-07-13-closed-card-treated-as-spent-clobbers-inflight-reclaim
date: 2026-07-13
title: A closed-but-unspent purchase card was read as "spent", so a second cleanup pass clobbered the in-flight reclaim
surface: back-end
component: purchase-cleanup
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/purchaseCleanup.ts — `cardWasUsed = !isCardLive(details)` is true for ANY closed card
symptoms:
  - "agent-payment-abandonment e2e intermittently resolves purchase=CLEARED instead of VOIDED"
  - "transfer=consumed with releasedCents=0 after an abandoned purchase"
  - org float drains on each occurrence
  - intermittent — passes when the AgentCard release beats the 60s reclaim window
tags:
  - agentcard
  - purchase-lifecycle
  - race-condition
  - idempotency
  - stripe
sources:
  - memory:project_agentcard_lifecycle_test_infra
repro: agents/benchmarks/tasks.json — agent-payment-abandonment e2e task
status: fixed
---

## Problem

The `agent-payment-abandonment` e2e task intermittently resolved with
`purchase=CLEARED` and the company transfer left `consumed` with
`releasedCents=0`, instead of the expected `VOIDED` / reclaimed / refunded
lifecycle. Every occurrence drained the AgentCard org float (sandbox standing
float $500; prod ~$300 manual USDC-on-Base), so the failure had real money
attached. It was intermittent: when the AgentCard release completed fast (e.g.
the 02:09 run) the run passed.

## Diagnosis

Not a cache problem and not an AgentCard-side problem — a genuine Rose
concurrency bug across two cleanup passes:

1. On a slow AgentCard release, abandon pass 1 closes the (unspent) card and
   starts reclaim: wallet funding goes `RECLAIMING` and a 60s release loop runs.
2. The agent then reaches `COMPLETED`, which fires a **second, concurrent**
   `cleanupAgentPurchaseCards`.
3. That second pass sees the card pass 1 just closed. Its spent-detection was
   `cardWasUsed = !isCardLive(details)`, where `isCardLive` means
   `balanceCents > 0 && status ∈ {OPEN, ACTIVE}` — so a _closed_ card is
   indistinguishable from a _spent_ card.
4. Pass 2 therefore called `consumePurchaseWalletFunding`
   (`markWalletFundingConsumed` permits `RECLAIMING → CONSUMED`) and marked the
   purchase `CLEARED`, clobbering the reclaim pass 1 had in flight.

The deeper owned cause: "card is not live" was used as a proxy for "the money
was spent", with no check of the reclaim state machine that a concurrent pass
had already advanced. Note that `consumed` immediately after issuance is
_normal_ for `company_flow` transfers (`findCompanyTransferId` polls
`status:'consumed'` first), which is what made the wrong terminal state look
plausible.

## Solution

`back-end/src/providers/purchaseCleanup.ts` gained
`purchaseCardWasSpent(purchaseId, details)`: a not-live card counts as spent
**only if no reclaim is already recorded** — i.e. the funding is not in
`RECLAIMING` / `RECLAIMED` / `RECLAIM_FAILED`. Otherwise the pass routes to
reclaim-retry and never consumes. Applied at both call sites,
`cleanupAgentPurchaseCards` and `reconcileDissolvedPurchaseHolds`, so the
completion path and the reconciler are both safe to run concurrently or twice.
Validated with tsc clean, `purchases`/`part2`/`part3` blackbox green, and the
`agent-payment-abandonment` e2e passing 1/1 through the real harness (VOIDED /
reclaimed / refund).

## Human feedback

None recorded.

## Reusable lesson

When a cleanup path can run twice concurrently, derive "already handled" from
the persisted state machine rather than from an ambiguous external resource
state like "card is no longer live".
