---
id: 2026-09-11-purchase-admission-did-not-share-agent-deletion-fence
date: 2026-09-11
title: Purchase creation and funding resume did not share the agent deletion fence
surface: back-end
component: purchase-agent-admission
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: createPendingPurchaseWithLock and claimFundingPendingPurchase admitted work without the agent generation lock
symptoms:
  - purchase admission completed before the sealing transaction committed
  - deleted agent can mint a new purchase card
  - funding retry proceeds after agent deletion
tags:
  - purchase
  - agent-deletion
  - advisory-lock
  - funding-resume
sources:
  - PR #1299
  - agent d7f92bfb-574d-43a2-a26c-4edfae6fa16d
repro: back-end/src/tests/blackbox/purchases-admission.blackbox.ts
status: fixed
---

## Problem

Controlled database tests demonstrated that purchase creation and funding retry
could proceed while the owning agent's deletion transaction held its generation
lock. An already deleted agent and an agent belonging to a different user also
reached the fake payment providers. Missing agents failed at a foreign-key
constraint instead of the explicit admission boundary.

This gap was found while hardening cleanup after an interrupted local payment
benchmark. The retained Temporal history for the source root shows mint activity
35 starting at 03:22:24.666Z and completing HELD at 03:22:31.540Z on September 12
UTC, after the parent interrupted its controller at 03:22:26.120Z. That incident
proves late completion and a missing finalizer barrier; it does **not** establish
that this live mint was first admitted after a committed deletion seal. The
admission race described here was proven separately against the real database.

## Diagnosis

Critical path: `mintPurchaseCard` → existing purchase lookup → either first-open
or funding-resume claim → provider I/O. Agent deletion uses
`lockAgentWorkflowGeneration`, but first-open held only a user/cart lock and
resume used an independent purchase CAS. Neither operation checked an undeleted
agent owned by the requesting user while holding the deletion lock. A cleanup
query returning no purchases therefore could not exclude later admission.

The permanent test holds an actual uncommitted agent deletion transaction and
observes PostgreSQL blocking PIDs. Before repair, create and resume finish before
that transaction commits. After repair, both wait behind its exact generation
lock and reject the committed seal. A reciprocal control admits a purchase first,
pauses at fake provider I/O, commits the seal, and then completes the already
visible CHARGING row to HELD. This proves that cleanup must still compensate
previously admitted work; holding a database lock across provider latency is not
the repair.

Archive searches included `purchase deleted agent late mint generation admission`
and `stale CHARGING cancel Stripe hold FAILED refund`. The September 4
purchase-clear/wallet-reclaim race is a related shared-transition-lock pattern,
but it serializes different rows and does not fence agent deletion. Purchase
history on other branches already had agent-scoped fingerprint reuse and funding
resume; neither supplied this generation fence. Completed purchase lifecycle,
admin bypass, and AgentCard integration plans were consulted before editing.

Evidence is retained privately under
`.context/acceptance/group4-temporal-rate-limit-rca/payment-finalizer-repro/`.
The first draft's funding fixture used a transient provider that completed on its
second call; that one failure was a fixture mistake and is excluded. The final
permanent test uses the existing resumable funding provider and was rerun
unchanged over an ignored HEAD source snapshot: nine failures and two positive
controls in `backend-admission-final-red-v3.log`. That eleven-case test passed through the canonical discovered runner in
`backend-final-owning-v2/purchases-admission.log`; the final twelve-case suite
adds the independently discovered ownership interleaving below.

## Solution

Acquire the existing agent generation lock inside the short first-open and
funding-claim transactions, verify exact user ownership and `deletedAt=null`, and
reject unavailable agents with `purchase_agent_unavailable` before provider work.
The public mint entry also rejects stale explicit-agent callers before returning
reusable card details. Funding retries with a legacy null-agent purchase assign
both purchase and funding ownership to the verified requesting agent before
provider I/O, making accepted work discoverable by exact tree cleanup. Standalone
user purchases without an agent remain supported.

The exported direct repository creator, currently used only by its unit test,
also shares the same admission transaction. Its added race failed before this
sibling correction (`backend-direct-admission-red.log`) and passes afterward.
Independent adversarial review approved the shared-lock repair and causal proof.

The test covers sealed, missing and wrong-user agents, all three real lock races,
sealed funding retries, legacy attribution, wrong-owner claims, standalone
purchases and pre-seal accepted work. The canonical owning runner passed all five
selected domains: admission, stale reversal, reclaim-cancel, purchase part 2 and
refund completion.
The parent owns the subsequent full validation loop and live cloud proof; these
tests do not certify the 10-by-10 fleet acceptance criterion.

At 10,000 runs the repair adds only per-agent transactions and indexed ownership
reads to purchase admission. It adds no fleet-wide inventory or provider call,
and no lock survives the transaction into provider I/O. Previously admitted
CHARGING/PENDING work still requires the finalizer's bounded reconciliation and
terminal payment receipt before database removal. PENDING_APPROVAL is a short
pre-provider stage of the mint RPC; workflow approval happens before that RPC.
A crash can still strand this row, so the finalizer must fail closed and retain
the database if its existing reconciliation deadline expires.

### Final review: preserve ownership across a funding requeue

The independent reviewer identified and then reproduced one stale-read edge in
legacy adoption. Caller B reads a null-agent purchase and waits for its agent's
generation lock. Caller A claims the row, attributes it to A, and uses the actual
resumable-failure setter to return it to FUNDING_PENDING. B's stale claim
previously matched only status/card/id, so it could overwrite purchase ownership
with B while the funding row still belonged to A. This was a controlled database
interleaving, not a claim about the interrupted live payment.

The final permanent blackbox observes B's exact PostgreSQL blocker, then drives
A's claim and requeue. Before correction it failed with `stale null-agent snapshot
cannot authorize another provider retry` while eleven other cases passed
(`backend-stale-resume-ownership-red.log`). The purchase CAS now also matches the
agent ID observed before waiting. A changed owner makes B's claim return null,
leaving both rows owned by A and FUNDING_PENDING. The unchanged twelve-case suite
passes in `backend-final-owning-v3/purchases-admission.log`. No additional lock,
provider call or retry is introduced.

## Human feedback

The user required completing the existing work without repeated permission
questions and verifying cleanup as part of the sequential cloud acceptance run.

## Reusable lesson

Serialize new resource admission with its owner's deletion seal, then reconcile work that was durably admitted before the seal.
