---
id: 2026-09-04-purchase-clear-raced-wallet-reclaim
date: 2026-09-04
title: Purchase clearing raced wallet reclaim across two database rows
surface: back-end
component: purchase-wallet-funding
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/domains/purchases/repo.ts:markHeldPurchaseClearedIfNoReclaim
symptoms:
  - purchase can be CLEARED while wallet funding is RECLAIMING
  - failed reclaim can coexist with merchant-cleared purchase state
  - relation check and funding claim each pass from different snapshots
tags:
  - purchase
  - wallet-funding
  - reclaim
  - advisory-lock
  - race
sources:
  - PR #1261
repro: back-end/src/tests/unit/purchase-wallet-funding.test.ts purchase clearing/reclaim serialization cases
status: fixed
---

## Problem

Purchase clearing checked the related funding row while updating
`PurchaseSpend`; reclaim independently compared-and-set `PurchaseWalletFunding`.
Each statement was atomic only on its own row, so both could pass and commit an
impossible `CLEARED` plus `RECLAIMING` or `RECLAIM_FAILED` combination.

## Diagnosis

Archive search found the related closed-card reclaim incident but not this
cross-row interleaving. The deepest cause was treating two individually atomic
statements as one state transition without a shared serialization owner.

## Solution

Every transition into `RECLAIMING`—initial claim, direct mark, and stale-lease
retry—and the competing clear transition now acquires the same
transaction-scoped advisory lock keyed by purchase ID. Every reclaim CAS also
rejects an already-cleared purchase, so either ordering has a reciprocal guard.
Deterministic database tests hold the shared lock to force each ordering and
invoke all three reclaim entry points after `CLEARED`, asserting that no
impossible state commits.

## Human feedback

The user required every review-discovered correctness gap to be cemented before deployment.

## Reusable lesson

When one invariant spans rows, serialize every competing transition on one shared key and keep reciprocal state predicates as defense in depth.

## Recurrence: unavailable company card left funding unresolved (2026-10-01)

Status: FIXED for the financial state transition, with an unchanged owning
reproduction, permanent coverage, independent review, required backend gates,
and a new execution of the originally failing task. The fresh four-task gate
was interrupted by a separate owned model deadline and earns zero aggregate
credit. Its two unfinished tasks remain separate validation work. The September
serialization fix remains intact.

### Runtime boundary and archive searches

On the reviewed source, the required native four-task payment gate ended after
1,255.647 seconds. Three tasks evaluated PASSED with complete archives, exact
provider receipts and terminal payment ledgers. The idempotent-abandonment task
finished execution in 298.1 seconds, then failed infrastructure finalization:
one purchase was CLEARED while its company funding was still FUNDED. The
unchanged 180-second financial cleanup bound expired. All four roots were
SQL-sealed, all four archives existed, and all five recorded browser sessions
had provider cleanup receipts. The original gate remains rejected with zero
proof credit. Its original SQL inconsistency and forensic records were preserved
before exact external financial recovery and retirement of its owned stack.

Exact retained runtime evidence connects that purchase's card to the reuse
liveness warning for the typed `card_closed` response. A fresh exact provider
read confirmed a closed, zero-balance card and a captured sandbox billing charge
without a refund. Neither observation proves merchant spending. No fresh exact
transfer lookup or cause for the external closure is claimed.

Two archive searches covered CLEARED/FUNDED and the clearing helper, then
unavailable-card/financial-cleanup behavior. They found this serialization case,
[the shared-card closure incident](2026-09-03-shared-agentcard-cardholder-contention-closes-card-mid-checkout.md),
and [the closed-card reclaim incident](2026-07-13-closed-card-treated-as-spent-clobbers-inflight-reclaim.md).
Those cases already distinguish card closure from merchant settlement and exact
transfer release. Private run, SQL, provider and scoped log captures are retained
under the acceptance evidence directory; raw records and credentials are not
archived in source control.

### Owned cause and scoped repair

The unavailable-card helper could mark HELD as CLEARED without retiring its
FUNDED company transfer. Canonical agent cleanup then skipped that purchase
because it selects HELD rows, and reciprocal reclaim guards correctly refused
an already-cleared purchase. An adjacent cleanup entry point also treated a
closed FUNDED card as merchant-spent. Generic provider read errors were flattened
into the same unavailable-card signal and could clear a purchase.

The repair admits clearing a company-funded held purchase only after canonical
settlement has recorded CONSUMED funding. A closed unresolved company card stays
HELD and nonreusable; the existing cart admission guard prevents another charge.
Canonical cleanup now sends unresolved funding through its existing exact
close/reclaim path, then reverses billing only after release. Typed closed-card
classification is shared; unknown read errors propagate without clearing or
minting. Existing reclaim ownership and confirmed merchant settlement remain
unchanged. The dormant helper with the superseded inference was removed, and
liveness documentation now describes reuse rather than settlement.

### Unchanged owning reproduction and permanent coverage

An isolated real-Postgres reproduction calls the actual lookup, mint, canonical
agent cleanup and merchant-settlement owners with exact provider fakes. Original
source returned RED in 13.321 seconds: three failed financial invariants and one
passing authoritative-settlement control, with zero fixture errors. The
identical fixture, SHA256
`5bb654601c451a38124b6453964607e981c7c40fa0a6d0dc737910561a285f58`,
returned GREEN 4/4 in 8.837 seconds after the production repair.

The same scenarios are permanent in the existing purchases part-3 blackbox:
closed-card lookup preserves HELD/FUNDED and prevents a second mint; cleanup
waits for the exact card/transfer release before one refund; an unknown read
cannot clear or charge again; and authoritative merchant settlement remains
CLEARED/CONSUMED without a refund. Existing release-pending and competing-owner
controls remain. That full owning domain passed in 8.610 seconds; existing
transition-race controls passed in 3.312 seconds. Their previously impossible
CLEARED/FUNDED fixtures now use the actual canonical merchant-settlement owner,
while every reciprocal reclaim rejection assertion remains.

The affected dissolved-hold entry point also had an unchanged owning RED: a
readable CLOSED/FUNDED card followed by typed `card_closed` during close stranded
the already-claimed reclaim. Delegating that one call to the existing
`closeCardForReclaim` returned the same fixture GREEN. Its permanent control
requires the exact card and transfer release before terminal reclaim. Legacy
closed-card fixtures now explicitly establish the existing interrupted
HELD/CONSUMED projection through canonical funding consumption before testing
their original cleanup assertions; closure alone no longer supplies settlement
evidence. Shared fixture helpers moved unchanged into the existing testkit to
retain the original 600-line lint limit.

### Independent review and actual post-fix outcome

Independent review verified the identical four-scenario reproduction, transition
controls, exact dissolved-hold RED/GREEN, all four original failed fixture
contexts, and byte/AST preservation of the moved helpers and unrelated tests.
The final required backend gate passed 172/172 blackbox domains and 220/220 unit
tests in 411.360 seconds. Actual coverage was 89.20% lines/statements, 91.06%
functions and 80.07% branches; full static checks passed in 51.974 seconds.
Earlier failed coverage receipts remain failed and retained.

On these unchanged reviewed production bytes, the originally failing
idempotent-abandonment task genuinely evaluated PASSED after 303.5 seconds.
Its financial ledger contains a settled CLEARED/CONSUMED purchase and an unused
VOIDED/RECLAIMED purchase, with complete durable evidence and exact provider
cleanup. Setup-resume also evaluated PASSED after 178.5 seconds. During the next
test-shop task, an owned `rose.complete.failed` from a 90-second structured
response deadline invalidated execution. The benchmark launcher was cancelled
before its stack; abandonment never started. The interrupted four-task gate
ended after 801.568 seconds and retains zero acceptance credit. The separate
[model-deadline case](2026-09-30-schema-wall-deadline-without-provider-evidence.md)
owns that unresolved infrastructure outcome; this case does not claim a
four-task gate pass.

Fresh exact SQL verification after cancellation confirmed all three allocated
roots deleted and sealed, zero pending financial obligations, and terminal
payment states. All four recorded provider sessions returned 404 on exact
revalidation. A validated 35,610,693-byte owned database snapshot and all original
context files were preserved before exact native stack retirement. The stack's
token/PID/birth-bound cleanup receipt is clean, its original service processes
and owned database/container volume are absent, and the failed benchmark
receipt and original run bytes remain unchanged.

The earlier CLEARED/FUNDED obligation was recovered separately through its exact
recorded provider release followed by one full sandbox billing refund, with
independent receipt review. Its incorrect SQL state was preserved rather than
relabelled, and its original gate still earns zero credit. These outcomes prove
the financial repair and exact operator recovery; they do not reconstruct a
missing original receipt or credit an interrupted gate. Prompts, models,
evaluators, task definitions, score verdicts and normal backstops were not
changed. A genuine task FAILURE remains acceptable with valid infrastructure
evidence and teardown.
