---
id: 2026-10-02-treasury-rails-unused-mint-transfer-stayed-consumed-past-deadline
date: 2026-10-02
title: treasury-rails timed out because AgentCard kept an unused card's mint transfer `consumed` for 4 minutes after close, even after its residual was recovered
surface: back-end
component: treasury-rails-blackbox
classification: third-party-failure
problem_class: other
first_bad_boundary: AgentCard sandbox org wallet — the closed card's mint transfer `owt_…` for card_0a398f4b38448e35214fd361 never left `consumed` within the 240s settle wait
symptoms:
  - 'unused mint never reclaimed after 25 attempts; transfer for card_0a398f4b38448e35214fd361: {"status":"consumed","releasedCents":0,"transferredCents":1300}'
  - 'treasury-rails blackbox FAILED: transfer for card_… ended in "consumed" — an unused card must reclaim/release, not stay consumed'
tags:
  - agentcard
  - treasury-rails
  - sandbox
  - settlement-latency
  - deploy-gate
sources:
  - PR #1341
  - PR #1416
repro: bash back-end/scripts/run-blackbox-tests.sh treasury-rails
status: mitigated
---

## Problem

`/deploy` Step 4a (deploy run `20261001-145844-51013`, HEAD `78ff3dddb`, stage
log `backend-coverage-blackbox-20261002-173142-1368612.log`) failed 1 of 170
backend blackbox domains. `treasury-rails` minted a $13.00 card from the pool,
closed it unused at about 17:35:50, and then polled for 240s. The card's mint
transfer stayed `consumed` with `released_cents: 0` on all 25 attempts.

## Diagnosis

### Evidence

- The test's own residual sweep recovered exactly $13.00 at 17:38:51, about 3
  minutes after close. In passing runs the residual comes back within about
  100s, and the transfer flips to `reclaimed` on the next poll. Here it did not
  flip in the remaining minute before the deadline.
- The 13 earlier coverage runs of this domain on this branch passed in 139–193s.
  This run took 260s, the full settle deadline.
- No AgentCard throttle or transient-unavailable result appears in the domain
  log. The host was not under pressure (`host-pressure.log`: cpu some
  avg10=0.22, 9.6 GB available).
- The isolated backend and the Step 5 stack made no AgentCard mint, close, or
  recovery calls in that window. The Step 5 stack logged only the once-a-minute
  wallet-monitor warning.
- A standalone rerun on the same HEAD passed in 147s and reclaimed on attempt 13.

### Root cause

AgentCard's settlement of a closed card's mint transfer was slower than the
240s wait allows. The residual took about 3 minutes to become recoverable, and
the transfer had still not flipped a minute after recovery.

Not ruled out: another AgentCard blackbox domain running at the same time
(`domainConcurrency=4`) could have minted on the same shared sandbox cardholder
and netted against this card's released residual. That is the
"mint against existing residual" path documented in `sweepResidualHeadroom`.
The suite writes every domain log at the end, so this run's per-domain timing
can't be recovered. This was not reproduced.

## Solution

On timeout, `waitForUnusedMintSettled` now prints AgentCard's full transfer row
for the card (`substatus`, `kind`, `failure_reason`, timestamps) and every
attempt's `recover_funds` yield. The next occurrence then shows whether the
residual was ever recovered for this card and what state AgentCard reports.
This was checked with a forced 20s deadline.

The 240s deadline is unchanged.

Still open:

- If the provider row shows `substatus` stuck after recovery, report it to
  AgentCard.
- If it shows netting against a concurrent mint, give this domain its own
  cardholder or make it exclusive with the other AgentCard minting domains.

### Recurrence on 2026-10-03

`/deploy` run `20261002-213707-2123940`, HEAD `894757474`, backend coverage
failed `treasury-rails` again with the same symptom. Failure evidence is in
`.context/test-runs/backend-coverage-failed-20261003-180703-3307025`.

- The test minted $13.00 on card `card_3fe0cde76095b38c762acbbf` (transfer
  `owt_ef9b047212c177aaca719afe`, 18:02:03Z) and closed it unused at
  18:02:06Z.
- Its sweeps recovered $14.48 at 18:02:17Z and again at 18:04:18Z, but never
  this card's $13.00. The provider row at timeout was `consumed` /
  `consumed`, `transferred_cents: 1300`, `released_cents: 0`,
  `failure_reason: null`.
- A read-only ledger check at 18:11:20Z still showed the transfer `consumed`
  with 0 released.
- The shared cardholder had two other mints in the window: 18:01:10Z
  (`transferred_cents: 0`, netted entirely against idle residual, 1448
  released) and 18:03:24Z (2123 transferred, 1448 released).
- This machine issued neither. Its Step 5 stack was stopped at 17:57Z. The
  coverage run's only live `create_card` and `close_card` were this test's,
  because the `purchases` card mints are mocked. The only other process
  running was the cloudbench suite, which uses a fake Fly API.
- On HEAD `028def96f`, an hour earlier, the same test passed in the backend
  coverage gate.

This matches the 2026-10-03 recurrence recorded in
`2026-09-03-shared-agentcard-cardholder-contention-closes-card-mid-checkout`.
There, a foreign mint also netted against residual while this test's card
stayed `consumed`, and the sweeps returned only foreign residuals ($14.48
among them). That moves the "not ruled out" netting path above from a
hypothesis to the observed pattern: the closed card stalls only while other
consumers mint on the one shared cardholder. How AgentCard attributes the
released value is not visible through the MCP.

Still no timeout, assertion or benchmark change. Accepting pool or residual
movement would reopen the foreign-residual false pass. The prevention remains
a dedicated mint-capable sandbox cardholder for this gate, which needs an
operator to provision. The gate was rerun on the same HEAD without code
changes.

### 2026-10-04: a missed reclaim is judged a day after the mint

Read-only provider checks at 14:38–14:41Z:

- Transfer `owt_ef9b047212c177aaca719afe` was still `consumed` with $0.00
  released, 20.6 hours after its card closed unused.
- Card `card_d9109871658de3d93171a63b` (the 2026-10-03 03:47Z failure) was in
  neither list. The `consumed` page reached back only 33 hours, but the
  `reclaimed` page reached back 41 hours, so it had not been reclaimed after
  35 hours.
- Of the 53 $13.00 treasury mints still visible, 52 were `reclaimed`.

A missed reclaim is rare, and both observed ones lasted far beyond any test
wait. The operator directed that the test assume recovery can take about a
day, without the test itself waiting that long.

- When the in-run wait ends with the card's transfer still `consumed`,
  `pending` or `funded`, the test records the card in
  `~/.cache/rose-labs/treasury-rails-pending-mints.jsonl` and passes. A short
  reclaim, a `failed` transfer or a missing transfer still fails the run.
- Each later run on that machine, after its pre-mint sweep, re-reads the open
  entries from the five `list_transfers` status pages, one read each however
  many entries are open. A transfer still unreleased 24 hours after its mint
  fails that run with the provider row. A full reclaim resolves it.
- Every verdict except "still waiting" is appended to the ledger, so a lost
  mint fails one run, not every run after it. An entry that has aged out of
  the reclaimed page is reported `UNVERIFIED` and dropped instead.
- The 240-second in-run wait is unchanged.

The ledger lives outside the worktree, so a later run from any worktree on
the same machine checks it, including after a merged worktree is deleted.
Runs on other machines do not see it.

Verification:

- `src/tests/unit/unused-mint-settle.test.ts` and
  `src/tests/blackbox/treasury-rails-pending-mints.blackbox.ts` cover the
  verdicts and the ledger, including the two observed stalls.
- A live run seeded with both stalled cards failed before minting on
  `card_d910…` (35.2 hours, "could be consumed") and kept `card_3fe0…`
  (20.9 hours) waiting. The next run did not report `card_d910…` again and
  passed.
- A run with the wait forced to 5 seconds recorded `card_6e3e9d0879a2c5ea5d22ac62`
  and passed. The next run's sweep recovered its $13.00, and a check about
  5 minutes after its mint found it `reclaimed` in full.
- That next run also stalled on its own card, `card_01c6aabfe93b113e8c84f4b6`:
  it stayed `consumed` through 24 attempts while the sweeps returned $13.00
  and $37.21. The old test would have failed. The new one recorded it.

This stays open. If stalls keep outlasting a day, the deferred check fails a
day later instead of in the run. The org MCP exposes `create_cardholder`, and
sandbox KYC and payment-method setup are documented as instant, so a
dedicated cardholder may not need an operator after all. That is untested.
Adding one changes the shared org, and callers that pick `cardholders[0]`
(newest first), including this test, would start using it.

### 2026-10-06: the reclaim proof moves off the payment-benchmark cardholder

`/deploy` Step 4a on PR #1416 (commit `db6426820`, 04:46Z) failed
`treasury-rails` the same way. The unused $13.00 card's transfer stayed
`consumed` with `released_cents: 0` through 27 attempts, while the test's own
sweep recovered $37.21 from the same cardholder.

- The sandbox org has two cardholders. Payment benchmarks in every workspace
  mint on the KYC-verified one, resolved by `resolveBenchmarkCardholderId`.
  This test took the first cardholder with no OPEN card, which was that same
  holder.
- $37.21 is the $43.96 payment-lifecycle card minus `test_charge`'s simulated
  $6.75: another workspace's lifecycle residual. The 2026-10-04 stall on
  `card_01c6aabfe93b113e8c84f4b6` also returned $37.21.
- A sandbox-only simulator ran that 4396-cent lifecycle (mint, `test_charge`,
  close, recover) on the verified holder 20 seconds after the treasury card
  closed. The unchanged test then failed the same way after 25 attempts.
- Control: the same run pointed at the other cardholder (KYC pending;
  `company_flow` mints still succeed) passed, reclaiming $13.00 on attempt 17.
  That cardholder's recent transfers were all 1300-cent treasury mints, every
  one reclaimed in full.

`selectTreasuryRailCardholder` now checks every other idle cardholder before
the payment-benchmark one. It falls back to the shared cardholder only when
that is the sole idle choice, and it never picks a cardholder with an OPEN
card. With the simulator still running a foreign lifecycle on the verified
holder, the fixed test reclaimed $13.00 on attempt 15.
`treasury-rails-cardholder.blackbox.ts` covers the order, the fallback and
OPEN-card exclusion as a backend blackbox domain. The deferred day-long ledger
check and the 240-second wait are unchanged. The change is test-only.

Status is `mitigated`: runs that fall back to the shared cardholder can still
contend, and the first 2026-10-02 stall had no observed foreign mint.

## Human feedback

2026-10-04: assume recovery can take about a day, and update the test for
that without making it take forever.

## Reusable lesson

A test that waits on a shared third-party ledger needs to log the provider's
own record of the object it waits on. A summary of a few fields cannot tell a
slow provider from a concurrent consumer.
