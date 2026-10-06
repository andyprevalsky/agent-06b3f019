---
id: 2026-10-02-agentcard-abandonment-closed-card-transfer-never-released
date: 2026-10-02
title: agent-payment-abandonment timed out because AgentCard never released a closed, unused card's mint transfer while other consumers minted on the same shared sandbox cardholder
surface: back-end
component: agentcard-purchase-reclaim
classification: third-party-failure
problem_class: other
first_bad_boundary: AgentCard sandbox org wallet — transfer `owt_…8ce5` for card_cb91b224db24a8dd6f1448c0 stayed `consumed` with `released_cents: 0` for over 21 minutes after the card closed with balance 0
symptoms:
  - "Payment lifecycle did not reach the expected terminal state before timeout: payment_lifecycle.purchase.status mismatch: expected 'VOIDED', got 'HELD'"
  - "Cleanup could not reclaim wallet funding; leaving Stripe hold in place … error=AgentCard company transfer release is still pending"
tags:
  - agentcard
  - sandbox
  - shared-cardholder
  - settlement-latency
  - deploy-gate
sources:
  - PR #1341
  - PR #1401
  - PR #1416
  - agent 75ea1c1e-0b2a-49f5-b6f5-6fb2a67f5346
  - agent 536786c2-3213-4ffd-99d8-8853b9908bcb
  - agent 102b1ebe-c0da-48bb-a8f8-bb3ac91cbcb4
  - task agent-payment-abandonment
repro: bash scripts/run-bench --local agent-payment-abandonment (provider-dependent); AgentCard list_transfers / list_recoveries read in /opt/cursor/artifacts/rca_evidence/agentcard-abandonment-ledger.txt
status: open
---

## Problem

`/deploy` Step 6a (deploy run `20261002-191915-1586598`, HEAD `4fc6f4e37`)
failed 1 of 4 AgentCard lifecycle tasks. `agent-payment-abandonment` (agent
`75ea1c1e-0b2a-49f5-b6f5-6fb2a67f5346`) completed its purchase flow normally.
The benchmark then abandoned the purchase. The purchase stayed `HELD`, its
wallet funding stayed `RECLAIMING`, and the 420s reconciliation wait timed out.
The other three tasks in the lane passed.

## Diagnosis

### Evidence

- The isolated stack's backend log shows cleanup closing the unused card at
  20:43:51 and then reading the transfer six times over the next minute. Every
  read returned `status=consumed transferred_cents=4396 released_cents=0`.
  The stale-lease retry (`failed_company_transfer_release_retry`) then re-read
  it at 20:46, 20:49 and 20:52, with the same result each time.
- At 21:04, 21 minutes after the close, the lifecycle endpoint reported:
  - `agentCard: CLOSED, balanceCents 0`;
  - `orgTransfer: consumed, transferredCents 4396, releasedCents 0`.
- In the two passing runs earlier the same day (stacks
  `1790965250-1562043-51886` and `1790965250-1561792-64005`), the same reads
  flipped to `reclaimed` with `released_cents: 4396` about 2 minutes after
  close.
- AgentCard's own ledger for the org (read-only `list_transfers` /
  `list_recoveries`, saved in the evidence file) shows 24 mints and 15
  completed recoveries on the shared benchmark sandbox cardholder between 20:30
  and 21:04. This VM's two lanes created about five of those mints. The rest came
  from other consumers of the same org and cardholder.
- At 20:44:39, 48s after our close, another consumer's mint (`…f961`) moved
  `transferred_cents: 0`: it was funded entirely from the cardholder's existing
  headroom. `fund-recovery.ts` documents this netting behavior.
- This branch does not touch the reclaim, release-observation, or cleanup code.
  Its only AgentCard change lifts structured throttle results into a typed 429.
  None of the release reads here were throttled.

### Root cause

AgentCard did not record the release of a closed, unused card's mint transfer.
Our reclaim correctly refuses to refund the Stripe charge until AgentCard
confirms that release, so the purchase stays `HELD` and the benchmark times out.
The `treasury-rails` occurrence earlier the same day is the same provider
behavior on a $13 mint.

Not proven: whether the netting mint that drew on the cardholder's headroom
48s after our close consumed our released value before AgentCard attributed
it to our transfer. The benchmark cardholder is a single KYC-verified sandbox
cardholder shared by every machine that runs payment benchmarks, and
`resolveBenchmarkCardholderId` deliberately never creates a new one. A
deterministic repro would require exclusive use of that cardholder.

## Solution

On timeout, `_wait_for_expected_payment_lifecycle` now appends the last state
of the provider rows it waited on (`_payment_lifecycle_settlement_state`): wallet
funding status, the AgentCard card's status and balance, and the card's org
transfer id, card id, status, transferred and released cents. A stuck provider
release now reads as
`agentCard={"status": "CLOSED", "balanceCents": 0}, orgTransfer={…, "status": "consumed", …, "releasedCents": 0}`
instead of a bare `HELD` mismatch. PR #1401 landed the same diagnostic on main
independently; the merge kept main's function and added the card row. This is
pinned by the benchmark blackbox case
`abandonment_timeout_names_unreleased_agentcard_transfer`.

The 420s reconciliation deadline and the task's expected lifecycle are
unchanged.

### Recurrence on 2026-10-03

`/deploy` Step 6 smoke (deploy run `20261002-213707-2123940`, HEAD
`b695d03aa`) failed `agent-payment-abandonment` (agent
`536786c2-3213-4ffd-99d8-8853b9908bcb`) the same way. Step 6a's run of the same
task on the same HEAD passed.

- Transfer `owt_…15ffb1` (card `card_c7034bd976487fb861b5620e`, $43.96 mint,
  2798 transferred) was created at 03:36:21. `close_card` returned `CLOSED` at
  03:36:29 with no throttle or retry. AgentCard still reported it `consumed`
  with `released_cents: 0` at 16:04, 12.5 hours later. `get_card` reports
  `CLOSED, $0.00 remaining`.
- The passing 6a run had the same timing: transfer `owt_…0e51c1` was closed 9s
  after its mint, and AgentCard released 4396 within about 2.5 minutes.
- This occurrence rules out the netting variant above. Another consumer's
  $13 mint on the shared cardholder at 03:37:01, 32s after our close,
  transferred its full 1300, and the next recovery (03:39:58) pulled exactly
  that 1300. Our card's 4396 never returned as headroom, so AgentCard released
  nothing at all rather than releasing value that a netting mint then consumed.
- PR #1401's deploy hit the same stall (agent `22d0b761`, transfer
  `owt_…2312920`). All four HELD/no-release failures of the two abandonment
  tasks fall between 2026-10-02 20:31Z and 2026-10-03 03:37Z, under heavy
  concurrent use of the shared sandbox cardholder. The attempts ledger has none
  in about 200 runs from 2026-09-20 until then.

### Recurrence on 2026-10-06

`/deploy` Step 6a for PR #1416 (deploy run `20261006-025038-30459`, HEAD
`d9d8996be`, stack `1791314763-1931596-30657`) failed `agent-payment-abandonment`
(agent `102b1ebe-c0da-48bb-a8f8-bb3ac91cbcb4`) the same way. The other three
lifecycle tasks in the lane passed, and the same task passed in this deploy's
previous 6a run at 18:24 on HEAD `89a09930a`.

- Transfer `owt_…6bfce1` (card `card_f…8f8a92`, $43.96 mint, 4396
  transferred) was created at 19:34:10. `close_card` succeeded at 19:34:18. The
  stale-lease retry re-closed the card at 19:37, 19:40 and 19:42 and called
  `recover_funds` each time. All 24 release reads through 19:43:22 returned
  `consumed`, `released_cents=0`.
- In the passing 18:24 run, the transfer also read `consumed` with 0 released
  for the first minute. The 18:27 stale retry then read `reclaimed` with 4396
  released, about 2 minutes 15 seconds after close.
- A read-only `list_transfers` / `list_recoveries` read at about 19:46
  (`/opt/cursor/artifacts/rca_evidence/agentcard-abandonment-ledger-20261006.txt`)
  shows eight mints on the shared sandbox cardholder between 19:21 and 19:38.
  Four were spent $43.96 mints, each with 3721 released, and one was a spent
  $19.60 mint with 1285 released. Another
  consumer's $13 mint at 19:38:18, four minutes after our close, was reclaimed
  in full, and recovery `rcv_c0…f1dc97` pulled exactly 1300 at 19:40:55. Our
  4396 was never released or recovered.

This repeats the 2026-10-03 shape: AgentCard released nothing for the closed,
unused card while the same cardholder's later mints settled normally.

Still open:

- Report the stuck transfers (`owt_…8ce5`, card `card_cb91b224db24a8dd6f1448c0`;
  `owt_…6bfce1`, card `card_f…8f8a92`) to AgentCard with the ledger reads.
- If AgentCard confirms that netting suppresses the release, give each payment
  benchmark run an exclusive sandbox cardholder, or serialize payment benchmarks
  across machines on the shared one.

## Human feedback

None recorded.

## Reusable lesson

When a benchmark waits on a third-party ledger, its failure has to print that
ledger's rows next to ours. "Expected VOIDED, got HELD" points at our
reconciler. The provider rows show the card closed and the provider never
releasing it.
