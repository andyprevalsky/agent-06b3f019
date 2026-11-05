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


## Retained sandbox liability and one-run overdue acknowledgement — 2026-10-15

The first fresh backend coverage gate on b5475e5be1f98e48e709298c0afcd2ea2e550ce7 failed treasury-rails while272unitfiles and198/199 blackbox domains passed. No new card was minted by that run: the gate stopped at the earlier-mint admission check. Exact local append-only ledger provenance links card_5d774c38cd66074889db0840 and transfer owt_d01a446802e08aa22f2dd904 to this task's earlier a5aaa8fc3b50bbb3b8a2bd024315fb0dbc5ca027 backend-verification run1792014135-1122715-26840. Mint1300c was created2026-10-14T21:48:05.589Z. That original native log retained21 settle observations ending21:52:14.396Z with the exact sandbox transfer consumed and released_cents0, then recorded it pending under the existing24h rule. This is positive prior custody, not authority inferred from an arbitrary missing row.

At2026-10-15T22:01:07.931Z, the unchanged current checker returned overdue, "not listed (could be consumed)", provider row null. Current exact transfer state is UNKNOWN; absence does not prove consumed, reclaimed or financial loss. The existing provider list contract has no offset/cursor or exact transfer detail exposed in the repository. A read-only call through the actual org runtime at22:07:01.938Z verified sandbox mode and exact owned get_card: CLOSED, balanceCents0. No mint/close/recover or foreign asset mutation was performed during this read-only investigation.

checkPendingUnusedMints automatically appended resolved with verdict OVERDUE and detail "not listed (could be consumed)". That is acknowledgement of the failed check, NOT repayment. No manual ledger write, deletion, reset or skip flag was applied. The permanent treasury-rails-pending-mints domain passed on this source and explicitly asserts that overdue verdicts fail one run and disappear from later open checks while foreign-credential entries stay untouched. Therefore a later ordinary TestLoop follows the existing admission contract; it is not a code repair, consumed-release exception, financial waiver or proof the1300sandbox cents returned. Preserve both ledger events, original failed gate and the1300c unverified sandbox return exposure in the deployment report. No real-dollar loss is asserted. Case remains open and production rollout remains independently gated.

Evidence: deployment preview `.context/final-b547/treasury-custody-proof.json`, `treasury-native-owned-card.json`, and failed coverage archive `.context/test-runs/backend-coverage-failed-20261015-220330-298660/`. The original owned receipt remains `/home/boxes/rose-backend-verification/back-end/coverage/blackbox-run/treasury-rails.log`. Archive searches used "earlier mint still not listed reclaim deadline" and "treasury rails pending mints consumed card"; the existing consumed-stall case is a historical relative/continuation, while the current projection has an explicit observation gap and is not misreported as a newly proven consumed stall.

## October 16 overdue observation during reusable cutover qualification

The backend coverage run on
`8171b24d0f934b38a5b932f836b8726f40b07a96` failed before creating a new treasury
mint. The earlier `card_c04e65b7f4cc375dfbf9a0eb`, minted October 15 at
18:35:22.233 UTC, was 24.4 hours old and absent from the observed provider pages.
The provider row was null; this does not prove either consumption or recovery.
The original failure remains in
`.context/lantern-deploy-preflight/.context/test-runs/backend-coverage-failed-20261016-190204-816376/`.

The existing `checkPendingUnusedMints` policy records every non-waiting verdict
before the caller reports a failed run. Its normal ledger writer recorded this
overdue outcome at 18:59:19.996 UTC. That terminal test-ledger entry is not a
refund, successful financial cleanup, or a manual gate override. No ledger row
was edited to remove the failure. A separate earlier mint,
`card_d3f0c6a6b4aaaebc920d8e8b`, was still pending within its original deadline.
Later test runs must retain these financial limitations even when the one-time
overdue assertion no longer repeats. No provider or treasury policy changed.


## October 17 exact owned sandbox transfer overdue — retained failure

Fresh backend coverage on source 2a798afc5f2d3147e27af5ea488baa5d600cc48d returned EXIT1: 298 unit files passed; 199 of 200 blackbox domains passed. Treasury failed before minting a new card. The exact earlier transfer remained consumed with released_cents=0, amount 1300 sandbox cents and captured livemode=false at the 24.4-hour check. A different 13.1-hour entry remained waiting. The successful aggregate $37.21 pre-sweep does not credit this transfer.

Positive custody is the retained bb7c462a92445b6595c9e5b5544b665c42c90f0f coverage log: the exact card was minted for $13, closed successfully, observed consumed after 24 settlement attempts, then recorded pending. Its canonical coverage receipt returned 0 with unchanged source. The later c9c08 log is an observation, not the original mint. The checker, pending-ledger owner and settlement predicate are byte-identical between bb7 and 2a.

The operator-directed 24-hour deadline uses the transfer's provider created_at (2026-10-16T21:37:03.223Z), not journal recordedAt (21:41:16.801Z), card expiry or a provider SLA. No retained historical HTTP Date proves historical clock accuracy; no clock-cause attribution or deadline waiver follows. Existing human feedback permitting about a day remains binding.

Nine offline controls exercised the unchanged captured-row predicate and actual pending-check caller against a temporary ledger: overdue failure, waiting, provider-time basis, exact reclaim, partial reclaim, foreign identity, foreign organization, unrelated pool credit and truncated-page uncertainty. The shared ledger was never edited. Setup import/formatter failures were retained separately from the successful offline owner reproduction.

One authorized read-only canonical get_card completed in one HTTP 200 attempt. Exact card and recorded owner matched; status was CLOSED and balance_cents was 0. The getter omitted livemode, so current mode is UNKNOWN; historical transfer mode was false. Its expiry field was 10/28, a printed card expiry, not a reclamation deadline. The response Date was October 17 22:11:11 GMT; that current edge observation does not establish historical clock behavior. No close, recover, mint, purchase or financial mutation occurred. Closed/zero balance does not prove the transfer returned.

The existing ledger owner automatically acknowledged the overdue failed observation before the outer assertion. This is intentional one-run failure acknowledgement, NOT repayment. Shared-ledger SHA256 remained 00fe6102dafbd4350bc7105f404144d64bbbe83a2e622364a7c258f6c76145f9 before and after investigation. The 1300 sandbox cents remain an unverified return exposure; no real-dollar loss is asserted. No checker or policy fix is justified. A later ordinary TestLoop PASS cannot establish financial recovery or erase this failed gate.

Private evidence: `.context/auth-deploy/repair-next-primary/treasury-rails-2a798-rca/` contains hash-bound final-checkpoint.json, the redacted failure window, nine-control offline proof (28f398946d5af2ca80c7fa0f38d9598a06a222aa7b7b2ccdd9ad8423712f3452), one-read intent and safe projection (f2b098f8e8549cc24c984643ef3a6ecb229023e650f5a36ea84fb192563f9310). No raw journal, payment credentials or full card response was copied into this archive. Two exact-source searches and this case's Solution/Human feedback were read before choosing recurrence rather than a duplicate case.


## October 27 overdue sandbox observation — acknowledgement is not repayment

Combined coverage on `62cf2b1d2cddd627736beb7dbad0ce3094af5d2a` failed
before a new treasury mint. The local pending journal identifies
`card_8f528f7a78972d4c9fc1d499`, transfer `owt_67c15bc4e75ae8d1c53f4155`,
and 1300 sandbox cents, minted October 26 at 19:57:28.600 UTC. The October 27
20:35 check found no matching provider transfer and reported it overdue at
24.6 hours. Its current state is UNKNOWN; missing rows prove neither
consumption, recovery nor financial loss.

The unchanged journal owner automatically appended its normal overdue
acknowledgement at 20:35:11.489 UTC before the failed assertion. No agent
edited the journal, set a skip flag, or changed the deadline. The existing
contract deliberately reports an overdue entry once, so a subsequent ordinary
TestLoop independently required by the SDK repair follows that contract.
It does not establish a refund, financial cleanup or a repaired provider.
Retain the failed gate and the 1300 sandbox-cent unverified-return exposure.

The earlier aggregate backend run passed treasury, but its original
card-specific mint/CLOSED/settlement payload was not recovered. The journal
provides recorded identity, not a newly observed close. No provider mutation
or read was performed during this reconciliation. Private evidence is under
`.context/deploy-fresh-20261027/batch8-treasury/`; the failed native artifact is
`.context/test-runs/backend-coverage-failed-20261027-203940-1417183/`.


## October 28 one-run overdue notification on an earlier sandbox mint

On unchanged source `48ccad7bb3e56a889d9294e46f57448991d3145a`, the
backend recovery command passed Kernel parity and all 326 unit files but
reported treasury-rails as its sole failing domain (233 siblings passed).
The exact pending journal entry binds card `card_74d6c21643a4620b9a4b6a91`
and transfer `owt_6dff8c4ea0096d0983af3f6a`, 1300 sandbox cents, minted
October 27 at 01:25:26.163 UTC. At October 28 01:33:14.912 UTC, the normal
checker found no matching transfer row after 24.1 hours, appended its ordinary
resolved/overdue acknowledgement, and then reported the failed check.

This is the existing deliberate one-run reporting contract described above;
no checker, deadline, credential scope, journal entry or skip flag was changed.
The return remains UNKNOWN, not repaid, refunded or proven consumed. This
1300 sandbox-cent exposure is separate from the October 27 1300-cent entry and
from the payment-abandonment 4396-cent warning. Neither a later normal gate
PASS nor a journal `resolved` event establishes financial recovery.

The original failed native artifact is
`.context/test-runs/backend-coverage-failed-20261028-013814-2220742/`.
Exact event projections and the source-contract review are preserved under
`.context/deploy-fresh-20261027/batch11-treasury/`. No new provider request was
made during reconciliation; original card-specific closure evidence was not
newly recovered. The existing 24-hour rule and one-run acknowledgement remain
in force. The pipeline's next ordinary canonical coverage attempt preserves
this original failure and the unrecovered sandbox liability.


## November 4 PR1662 earlier-mint warning under the permanent treasury instruction

Source b9a1f743152e29cb6626ed33fdce88d24a919ba1 backend full validation retained treasury-rails FAIL, with240PASS/2FAIL/1UNVERIFIED across243cases. Treasury failed at the earlier-mint admission check before this invocation minted a new card. Thirteen recorded October31 mints were75.8–99.1hours old and absent from the captured transfer-page projection; the native verdict was “not listed (could be consumed)”, provider row null. Missing rows prove neither present consumption nor financial return.

The append-only journal at /home/boxes/.cache/rose-labs/treasury-rails-pending-mints.jsonl binds each card to its recorded transfer, holder,1300c amount and original mint time. Its native checker automatically appended thirteen overdue acknowledgements at2026-11-04T03:31:57.047Z, lines58–70 following pending rows29–57. This is the existing one-run notification bookkeeping, not repayment. All16900recorded mint cents remain unverified return exposure; no real-dollar loss is asserted, and individual historical transfer mode/close receipts were not newly recovered. Native pre-check residual sweeps confer no credit on any of these exact transfers.

Affected cards: card_2a139dab08528d39f3c2a391, card_33a0dee6a92e0e07d903f6f6, card_fc846e1e6c54b9955a7f993a, card_4ef94461d53876f0d90665fd, card_59f246fcc30359c8a895822d, card_1e437c5aaac7710329a813a3, card_bb650feb1af920e737c72b8b, card_e4fb203b72e16e0b7215d0ce, card_8e64ec413b3b3d89eb731248, card_94790b99f3289e2e4eef222d, card_aeca5bfdec6dbe366d25b506, card_b0184b3c3d27f1dc93ca32c3, card_1952f1712764d1bb1a1026e9. Exact transfer/holder/time projections and SHA-bound native request/result/receipt/log/journal evidence are in /var/tmp/pr1662-b9-treasury-overdue-readonly/report.json. The journal SHA stayed394725a7a6c2fa23ecd3e4c91289fb0b8c13bb076c23621d15ae942c175d76a2 during investigation. No journal edit, provider call, recovery, financial mutation or retry was performed by the RCA lane.

Gate: UNKNOWN for original source/provider attribution. The owning treasury checker, journal owner and settle predicate are byte unchanged from6f3f53201faac3a3e70de099e7c211cee6770fad tob9; that parity does not establish the cause of missing historical observations. Two searches used “earlier mint still not listed reclaim deadline” and “treasury rails pending mints consumed card”; this is a continuation of this case's recorded earlier-mint observation gap, not a newly proven service outage.

Controlling authority is .claude/commands/deploy.md270–280: the standing user instruction ofOctober29 makes treasury test failures permanently SKIPPED with a final warning and never deployment-blocking. Preserve this originalFAIL and every obligation; this instruction does not turn it intoPASS or require fabricated NOT_INTRODUCED/provider-outage attribution. Independent non-treasury failures in the same cohort remain blocking.

The existing report/coordinator omitted a typed path for that permanent instruction. A private narrow integration records only this completed native treasury check as a warning under the exact policy; registered original-source RED becomes GREEN, with7focused controls and16existing policy controls passing. Existing source-refresh renewals retain the original nativeFAIL and exact prior qualification instead of rerunning treasury to manufacture another failure. No canonical application, state, financial or receipt bytes were changed. Integration and native validation remain parent-owned; this append does not close the underlying financial observation gap.
