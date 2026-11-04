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
  - PR #1418
  - PR #1436
  - agent 75ea1c1e-0b2a-49f5-b6f5-6fb2a67f5346
  - agent 536786c2-3213-4ffd-99d8-8853b9908bcb
  - agent 102b1ebe-c0da-48bb-a8f8-bb3ac91cbcb4
  - agent 8b054756-bf09-43b9-ab3a-8a6c782e15e8
  - agent d60c486a-4d41-43b1-bee5-487f59ce1f2a
  - agent d3eb5e85-170b-4fcf-a7d6-dcf4f9f33fcc
  - PR #1459
  - PR #1512
  - agent dfe1f6b1-5caa-4ba6-a5fe-2c155401083e
  - agent 5b7dd06e-81d9-4bc0-88f7-e65355f75b7c
  - task agent-payment-production-abandonment
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

The unchanged lane rerun at 20:07 on HEAD `585fac704` (runtime identical;
docs and benchmark history only since `d9d8996be`) passed all four tasks.
`agent-payment-abandonment` (agent `cff60cf0-2953-4efd-9c5d-37212338bd20`)
passed in 205 seconds, with both owned-cleanup receipts clean. The stall is
intermittent on AgentCard's side, not deterministic in our reclaim path.

`/deploy` Step 6a for PR #1418 (deploy run `20261006-171736-24512`, HEAD
`db9a99795`, stack `1791321484-1169503-38469`) failed `agent-payment-abandonment`
(agent `8b054756-bf09-43b9-ab3a-8a6c782e15e8`) the same way at 21:34. The other
three lifecycle tasks passed. The same task passed in 206 seconds in this
deploy's previous 6a run at 20:44, on HEAD `f0e48ae67`. The only runtime change
between the two was the merge of `main`. That merge does not touch the reclaim,
release-observation or cleanup code.

- Transfer `owt_…ed2cc2` (card `card_89cb339d5e85f43880ff1e5a`, $43.96 mint)
  was created at 21:26:03 with 675 transferred. `close_card` succeeded and the
  first release read came at 21:26:12. The stale-lease retry requested the
  release again every two to three minutes from 21:29 to 21:40. All 36 release
  reads through 21:40:58 returned `consumed`, `released_cents=0`.
- A read-only `list_transfers` / `list_recoveries` read at about 21:39
  (`/opt/cursor/artifacts/rca_evidence/agentcard-abandonment-ledger-20261006-r2.txt`)
  shows ten other $43.96 mints on the shared cardholder between 21:19 and
  21:38. Nine had released 3721, including `owt_…e0ce9e`, which also
  transferred 675. The tenth was created at 21:38:53, under a minute before
  the read.
  Recoveries `rcv_…800dc2` (21:36) and `rcv_…515e45` (21:38) each pulled 3721.
  Our transfer released nothing.

The unchanged lane rerun at 22:00 on HEAD `e93e406e5` (runtime identical to
`db9a99795`; docs and benchmark history only) failed the same task the same way
(agent `d60c486a-4d41-43b1-bee5-487f59ce1f2a`, stack
`1791324058-1288564-59300`). The other three tasks passed again.

- Transfer `owt_…f4112b` (card `card_0d8d820f72e50b35fd394b93`, $43.96 mint,
  4396 transferred) was created at 22:08:51. `close_card` succeeded at
  22:09:00. The stale-lease retry re-closed the card at 22:11 and 22:14 and
  called `recover_funds` after each close. None of those calls created a
  recovery. All 28 release reads through 22:17:48 returned `consumed`,
  `released_cents=0`.
- A read-only ledger read at about 22:19
  (`/opt/cursor/artifacts/rca_evidence/agentcard-abandonment-ledger-20261006-r3.txt`)
  shows seven spent mints on the shared benchmark cardholder between 22:02 and
  22:17. Each released its unspent remainder (3721, 1285 or 1448 cents), and a
  later recovery pulled exactly that amount. Our transfer released nothing, and
  neither had another consumer's unused $43.96 mint (`owt_…07d222`, created at
  22:17:48) when the read was taken.
- In the same window, three closed, unused $13 mints on a different,
  lightly used cardholder (`owt_…1fff43`, `owt_…f0bde2` and `owt_…9f3607`)
  were each reclaimed in full. These match the treasury-rails proof's mints,
  which `selectTreasuryRailCardholder` now steers away from the shared
  benchmark cardholder. So AgentCard does release unused cards in this window;
  the stall is confined to the busy shared cardholder. This supports the
  exclusive-cardholder remedy below.

### Recurrence on 2026-10-07

`/deploy` Step 6a for PR #1417 (deploy run `20261007-023453-343760`, HEAD
`e2b20fa1a`, stack `1791396285-2126832-43519`) failed
`agent-payment-abandonment` (agent `7effdfe9-3999-493b-86b3-e5c9e3ba3b5f`)
the same way. The other three tasks passed. The same lane passed 4/4 earlier in
this deploy on HEAD `731627b37`; the runtime change since then is the merge of
`main` and the zero-grace teardown floor, neither of which touches reclaim or
release observation.

- Transfer `owt_…a52e` (card `card_aec0bd2ceaea33cfb4e17c36`, $43.96 mint,
  4396 transferred). `close_card` succeeded at 18:15:34 and `recover_funds` ran
  after each of the first five release reads. The stale-lease retry requested
  the release again every two to three minutes from 18:18 to 18:43. All 65
  release reads through 18:43:52 returned `consumed`, `released_cents=0`.
- The benchmark's owned payment drain then timed out after 180 seconds. The
  runner recorded `failed_retained` and kept the stack and database as recovery
  authority, which correctly withheld cleanup credit. That retained stack also
  held the Step 6b latency ratchet, a separate harness bug fixed in
  `2026-10-07-retained-recovery-stack-held-latency-ratchet`.

`/deploy` Step 6a for PR #1363 (deploy run `20261005-172101-47407`, HEAD
`4a14f9783`, stack `1791405163-92172-18662`) failed `agent-payment-abandonment`
(agent `cba71b08-839b-4ab6-ab05-b82d3cedc21b`) the same way. The other three
lifecycle tasks passed, and the same four-task lane passed in this deploy on
2026-10-06 with 4396 released. The branch does not touch the mint, cleanup or
reclaim code.

- Transfer `owt_…d6d22` (card `card_d7608e33491511fdeec32b5d`, $43.96 mint, 4396
  transferred) was created at 20:48:29. `close_card` succeeded at 20:48:38. The
  card was never charged. Six release reads through 20:49:40 and seven
  stale-lease retries from 20:51:01 to 21:08:00 all returned `consumed`,
  `released_cents=0`: 48 reads over 20.5 minutes, with no provider error, retry
  or throttle and no recovery created.
- No read-only provider ledger read was taken, so this run cannot say whether
  another consumer was on the shared cardholder. No other AgentCard lane was
  running on this host.
- The stack was stopped at 21:09:24 because the host disk was nearly full. The
  purchase was last seen `HELD` with funding `RECLAIMING`; nothing is retrying
  the release now, and its Stripe test-mode hold was not refunded by our
  reconciler.

`/deploy` Step 6a for PR #1436 (stabilization run `20261007-220502-355180`,
HEAD `8f63c272e`, stack `1791413203-595722-63139`) failed
`agent-payment-abandonment` (agent `d3eb5e85-170b-4fcf-a7d6-dcf4f9f33fcc`)
the same way after 538s. The other three lifecycle tasks passed. The same
task passed earlier the same day in this deploy's Phase 1 6a run.

- Transfer `owt_f46e484168f57370a4cda9c6` (card `card_5b1c41fe5dee8907e092e155`,
  $43.96 mint, 4396 transferred) stayed `consumed` with `releasedCents: 0`.
  The card was `CLOSED` with balance 0. Purchase stayed `HELD` and funding
  stayed `RECLAIMING` through the 420s reconciliation wait and a later
  post-timeout lifecycle read.
- The unchanged-lane rerun at 23:33 on the same HEAD passed all four tasks
  (Hub `4144392b-bff3-4d67-97ac-8be2e00c0237`). Abandonment (agent
  `490787fb-fea5-4f08-9700-8ac6835ef966`) passed in 213s after
  `Abandoned issued payment card and reconciled funding`.

### Recurrence on 2026-10-11 (live production org)

`/deploy` Step 13c for PR #1459 (deploy run `20261009-214158-1894878`, merge
`75be7489d`) failed `agent-payment-production-abandonment` (agent
`5b7dd06e-81d9-4bc0-88f7-e65355f75b7c`) the same way after 562s. This is the
first occurrence on the live production AgentCard org rather than the shared
sandbox cardholder.

- The agent completed at 21:07:05Z. Transfer `owt_…6234e` (card
  `card_…b131`, $1.00 mint, 100 transferred, `livemode: true`) stayed
  `consumed` with `releasedCents: 0` while the card read `CLOSED`, balance 0.
  The purchase stayed `HELD` and funding `RECLAIMING`. The Stripe charge was
  captured (100 received) with no refund yet.
- Prod logs show the stale-lease retry requesting the release again every three
  to four minutes (`Recording AgentCard company-wallet funding release
  request`, then `Failed to retry purchase funding reclaim`). The transfer was
  still `consumed` / 0 released at 22:18:25Z, 71 minutes after close.
- The unchanged rerun (agent `15ed2603-3eb1-4572-a860-f9229e735ac3`) passed:
  its transfer read `reclaimed` with 100 released inside the 420s wait, and
  the purchase reached `VOIDED` with the refund. A second attempt in between
  died before allocating anything, on a benchmark Hub registration read
  timeout.

Still open:

- Report the stuck transfers (`owt_…8ce5`, card `card_cb91b224db24a8dd6f1448c0`;
  `owt_…6bfce1`, card `card_f…8f8a92`; `owt_…ed2cc2`, card
  `card_89cb339d5e85f43880ff1e5a`; `owt_…f4112b`, card
  `card_0d8d820f72e50b35fd394b93`; `owt_…a52e`, card
  `card_aec0bd2ceaea33cfb4e17c36`; `owt_…d6d22`, card
  `card_d7608e33491511fdeec32b5d`; `owt_f46e484168f57370a4cda9c6`, card
  `card_5b1c41fe5dee8907e092e155`; live-org `owt_…6234e`, card
  `card_…b131`) to AgentCard with the ledger reads.
- Confirm the live-org $1 purchase from 2026-10-11 (agent `5b7dd06e`) reaches
  `VOIDED` with its Stripe refund once AgentCard records the release.
- If AgentCard confirms that netting suppresses the release, give each payment
  benchmark run an exclusive sandbox cardholder, or serialize payment benchmarks
  across machines on the shared one.


### Qualification defense: require the declared sandbox task

PR #1503 also requires the catalog task to be non-production, tagged
`agentcard-lifecycle-sandbox`, and explicitly expect `orgTransfer.livemode=false`.
A globally leaked flag or malformed false-live response cannot authorize a
production-only or unregistered task. This guard covers the reconciliation
deadline classifier, task exception, owned payment cleanup, and CI skip
acceptance. Four new permanent public-boundary controls fail on the prior
source and pass with the guard; all 18 existing policy/recovery controls remain
unchanged and pass. The same task catalog, timeouts, and LIVE oracle are intact.

## Human feedback

None recorded.

## Reusable lesson

When a benchmark waits on a third-party ledger, its failure has to print that
ledger's rows next to ours. "Expected VOIDED, got HELD" points at our
reconciler. The provider rows show the card closed and the provider never
releasing it.

## Retained original financial gate, October 6

The earlier failed local AgentCard gate retains its exact isolated database and
services while the existing reconciler owns financial cleanup. A fresh native,
read-only database observation at02:10:23UTC found the root deleted, the purchase
HELD and funding RECLAIMING for4396cents, with no persisted funding error. This
is not financial release or a successful gate.

Exact purchase-bound backend logs retained498 observations of `status=consumed`
through00:32:03UTC. The next204 observations reported `status=undefined` beginning
00:34:05UTC. That is a visibility gap, not evidence of provider release. Archive
searches covered `list_transfers status undefined limit100` and `closed card
funding RECLAIMING release pending`; the latter identified this open case.

Fresh read-only capability discovery at02:12:54UTC exposed26 tools and confirmed
that the transfer reader accepts only `status` and `limit` (maximum100), with
no exact transfer-ID tool or pagination. Five bounded status-page reads at
02:13:17–02:13:19UTC found the exact original transfer on the consumed page.
Its card identity matched the retained purchase, amount and transferred value
were4396cents, and released value was0. Thus losing the record from the
unfiltered first100 results did not establish closure; the provider transfer
was still visibly unreleased. Only scalar results are reported. Full responses,
identifiers, database receipts and logs remain private and uncommitted.

No refund, card mutation, provider recovery mutation or production source edit
was made for this observation. The original gate remains failed and its owned
stack remains available to the existing reconciler. The normal terminal wallet
state and exact native resource release are still pending. There is no new
causal reproduction or completed fix here; this is updated runtime evidence in
the existing open case, independent of the five-run DAILY50 acceptance streak.

### Recurrence on 2026-10-11 (PR #1450 deploy, sandbox)

The local AgentCard lifecycle lane for PR #1450 (HEAD `9d9a65e56`, stack
`1791759656-942305-17040`) failed `agent-payment-abandonment` (agent
`80ed40fe-fd84-428c-ade3-8abdd010c820`) the same way. The other three tasks
passed.

- Transfer `owt_db04af54fa18afa2ef9df8aa` (card `card_3d520c1c49a3f8dfc71e8f4c`,
  $43.96 mint, 4396 transferred) was created at 23:15:43. `close_card`
  succeeded at 23:15:51. `recover_funds` ran after each of the first five
  release reads and recovered nothing. All 27 release reads returned
  `consumed`, `released_cents=0`.
- Two earlier lane runs of this deploy failed identically: transfers
  `owt_cf95ac0648d93fa0688885a2` (created 06:12:29) and
  `owt_ddb33aaa7b5a900245228f2c` (created 07:47:28). A read-only
  `list_transfers` at about 23:45 still showed all three as `consumed` with
  `released_cents: 0`, 17.5 hours after the first one.
- Across the nine local abandonment runs on this box from 2026-10-09 to
  2026-10-11, six passed. In those runs AgentCard reported `reclaimed` about 2
  minutes 15 seconds to 2 minutes 50 seconds after the close, when a stale-lease
  retry's `recover_funds` pulled 4396. Create-to-close timing was about 6s in
  every passing and failing run, so close timing does not distinguish them.
- The failed run's retained stack kept re-reading the transfer, which spends
  the org-wide MCP request budget, and could not make progress. It was
  stopped with the owner-verified `local.stop_services` path. The sandbox
  Stripe hold remains in test mode.

The lane reruns unchanged on the post-main-sync HEAD.

## Deploy warn-skip (2026-10-12)

The `sms-supervisor-native-tools` deploy hit the same stall twice. On
transfer `owt_ff135698c18b095f3a40a249` (card `card_b2e87905c62c34ba8abff4d4`,
4396 transferred), agent `44c46dff-69fa-4fa8-9e9f-9f591e92bd31` stayed `HELD` /
`RECLAIMING` with `consumed`, `releasedCents=0`. At the user's request, `/deploy`
Step 6a now sets `BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL=1`. With that flag,
`run_benchmark.py` reports this exact sandbox state as a loud SKIP and does
not fail the lane:

- the purchase is `HELD`;
- funding is `RECLAIMING`;
- the card is `CLOSED`;
- the card's own test-mode transfer is `consumed` with nothing released.

Its owned cleanup records a warning instead of an error, so the isolated stack
is released.

Any other lifecycle, a live transfer, or a different card still fails. Without
the flag, the runner is unchanged. The skip leaves the Stripe test charge
captured, and this case stays open until AgentCard releases closed-card
transfers. The regressions live in the agents `benchmark` blackbox domain
(`abandonment_timeout_classifies_sandbox_release_stall`,
`owned_payment_release_stall_warn_skip`,
`ci_permits_only_opt_in_agentcard_release_skip`).

### Recurrence on 2026-10-12 (PR #1472 deploy, sandbox)

The local AgentCard lifecycle lane for PR #1472 (deploy run
`20261012-183520-3245684`, HEAD `5b3d1bed3`, stack `1791832677-4117771-72325`)
failed `agent-payment-abandonment` (agent
`9a0d0586-cd83-4a64-a5a1-f30bee192082`) the same way after 583s. The other
three tasks passed. The branch changes chat routing, tunnel-log handling and
cloudbench recovery classification; it does not touch mint, cleanup or reclaim.

- Transfer `owt_d0a7890d3b2bc32b8b3767d7` (card
  `card_110723c941f30359b9f47586`, $43.96 mint, 4396 transferred).
  `create_card` succeeded at 19:30:59 and `close_card` at 19:31:05.
  `recover_funds` ran after each of the first five release reads. The
  stale-lease retry (`failed_company_transfer_release_retry`) requested the
  release again 13 times through 20:06. All 80 release reads through 20:08:05
  returned `consumed`, `released_cents=0`.
- From 19:48 the retained stack's reconciler logged `Purchase funding reclaim is
  already owned; skipping duplicate card close` every one to two minutes, with
  no progress.
- The retained stack was stopped at about 20:08 with the owner-verified
  `local.stop_services` path (`state=clean`, no birth mismatch). The sandbox
  Stripe hold remains in test mode.

The unchanged lane rerun at 20:09 on the same HEAD passed all four tasks.
`agent-payment-abandonment` (agent `0b475599-c482-4d55-a988-2e43de5710ac`) passed in 208s.


### Recurrence on 2026-10-13 during PR1503 qualification

Candidate `aad5e7b83fae43bfc24ceac3c33479ca3d10eb27` ran the unchanged four-task sandbox gate. Hub `4389f88d-4c08-470e-88de-ec92bc818421` produced three PASSED tasks and abandonment ERROR on agent `c8a9e779-ec5f-452d-9b75-739259a23fe2` (542.3s). Card `card_2ea23060a394ab41697f7239` closed with zero balance, but transfer `owt_fd6500e9322cc31892ceee6e` remained consumed/released0 for the4396c mint. Purchase `bc6ff9d2-cdc6-4b6c-bfb1-cf1fe971e0c4` stayedHELD and fundingRECLAIMING; Stripe test-mode refund remained absent.

The first release read was12:39:16.711UTC. Real release-observation passes executed at12:39:16,12:42:00,12:44:34,12:46:43,12:49:01 and12:51:45. Close acknowledgements returnedCLOSED before those passes. The exact transfer still returnedconsumed/released0 at12:56:50. Other recoveries on that cardholder yielded1448c,10488c and1448c; those aggregate amounts cannot be attributed to this transfer and cannot satisfy its refund or benchmark assertion. No investigator recoveryPOST, new mint, increased deadline or weakened assertion was performed.

The benchmark now resumes eligible owned reconciliation and demonstrably reaches the provider boundary. Therefore this occurrence is not only the earlier GET-only busy-cron failure. The demonstrated bad boundary is lack of release on the exact provider transfer despite closed-card acknowledgements and actual observation passes. A release-clock reset by repeated closure and exclusive attribution to shared-cardholder netting remain unproven. The native failure and retained cleanup authority remain open. The harness's separate deadline-diagnostic repair preserves this state in errors; it does not establish provider recovery.


### Standing approved sandbox warning policy recovered on October13

The user explicitly instructed on October12: "make this test skippable w a warnging for all future agents then finish" (NEDS Tamy thread, user turn85 at22:14:25UTC). Original commit244a961d25558d4df563636ef3f8cc74d7894b89 implemented `BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL=1`, but that implementation was preserved in PR1473 without reaching main. The Google RCA follow-up therefore ran without the approved exception and initially treated its absence as a new approval boundary. The existing standing instruction supersedes that interpretation; no repeated confirmation is required.

The restored deploy-scoped flag reports the exact sandbox release stall as `SKIPPED` with a loud warning, neverPASS. It requires purchaseHELD, fundingRECLAIMING, a CLOSEDcard with zero balance, matching nonempty card/transfer card IDs, and a test-mode transfer stillconsumed with released0. The common predicate additionally rejects missing/boolean balance and foreign-card state; both legacy and owned-timer boundaries are covered while preserving existing deadlines. Genuine read failures, cancellation, live transfers and unrelated cleanup errors remain strict. Owned cleanup may record this sandbox failure as a warning after fresh exact-owner reads; the test capture/refund remains explicitly unresolved. Production LIVE abandonment/refund requirements remain unchanged.

Six permanent owning controls cover CI skip admission, exact native stall classification, owned cleanup warning, identity/balance guards, both timeout owners with flagON/OFF, and read-error/cancellation rejection. Against the original4db runtime 0/6passed; with the restored policy all6pass, alongside12unchanged payment controls. No timeout, task definition, prompt, model or payment success oracle changed. The original4389native run's3PASSED/1ERROR and original failed cleanup receipt remain historical evidence; an explicit waiver does not retroactively make that attempt pass.

### October 14 integration duplicate-test repair

Main integration preserved later original copies of four test/helper definitions
that shadowed main's strengthened sandbox fixture and opt-in controls. Five exact
owning cases failed offline on the integrated test module, while the unchanged
main runtime and main test module passed. Removing only those redundant copies
and three duplicate registrations restores all ten selected positive/negative
controls without changing any runtime guard, assertion, deadline or catalog.
The main definitions and the branch SMS scoring case remain intact; exact
original source, warning commit ancestry and lossless preservation snapshots
remain unchanged. This repair supplies no historical failed run or live lane
acceptance credit.

### Recurrence on 2026-10-14 during PR #1512 production verification

The unchanged production-only `agent-payment-production-abandonment` task ran
against merged source `1d77217cbe8136029400cc794cd7386039024c19`, benchmark run
`4752fbb8-2469-46b2-a702-f7f26a70dadd`, fixture agent
`dfe1f6b1-5caa-4ba6-a5fe-2c155401083e`. It captured exactly 100 cents and left
merchant checkout unsubmitted. The original stock task returned `ERROR` after
580.9 seconds when its unchanged reconciliation window expired: purchase
`HELD`, funding `RECLAIMING`, card `CLOSED` with balance zero, and the exact live
organization transfer consumed with transferred=100/released=0. The controller
also failed final cleanup and exited 1; its observed join receipt is
2026-10-14 21:04:39 UTC. This failed verdict is preserved independently of any
later financial recovery.

Purchase-scoped production logs retained three genuine release-observation
passes beginning at 20:49:17, 20:52:23, and 20:54:33 UTC. All 18 observations
through 20:55:37 matched the exact provider transfer (masked suffix `…1922`)
and returned consumed/transferred=100/released=0. These are actual provider
reads after exact-ID matching, rather than a stale stored snapshot or an
omitted filtered-list result. Each pass ended in typed release-pending. The
underlying reason for nonrelease remains unproved; the prior live recurrence
is relative evidence, and no outage, throttling, shared-cardholder netting, or
repeated-close clock-reset explanation is established for this attempt.

After joining the original controller and preserving its exit/run receipts,
a separate owner began bounded idempotent reconciliation of the same
purchase/card/transfer/Stripe identities using the unchanged stock cleanup
and validation functions. No new mint or merchant purchase is used to close
this allocation. Its terminal reclaim/refund receipt remains pending at this
archive checkpoint; the strict production gate is incomplete. No vendor
message was sent. A concrete vendor-report draft and the sanitized provider
timeline remain private under `.context/production/agentcard/`, alongside the
original failure, controller exit receipt, and any separate recovery receipts.
The case remains open.


### Recurrence on 2026-10-15 during PR #1520 production verification

Merged source `6ef22cc55811444f1524fb9faf22f6e97600410e` ran the unchanged
production-only abandonment task as benchmark run
`d0b6dbf8-0637-4130-a651-0cb42a7d7d79`, root
`a1e098ad-02a5-49d6-9b9e-bf8a8163ba6a`. The task failed after581seconds:
purchaseHELD, walletFundingRECLAIMING, cardCLOSED with zero balance, exact LIVE
organization transfer consumed/transferred100/released0. The original controller
also failed final cleanup, preserved the native failed verdict and run bundle,
and joined exit1; its saved run timestamp is05:26:23UTC. No sandbox warning
exception applies to a live transfer.

Five owned backend release-observation passes began05:10:32,05:13:47,05:15:57,
05:18:00 and05:20:54UTC. All30 exact-transfer observations through05:21:56
returned consumed/100/0. A native read at05:22:08 independently matched the exact
closed card and unreleased live transfer. These executed observation passes
separate this occurrence from the GET-only/global-reconciliation bug. The
underlying cause remains unproved: this does not establish merchant capture,
shared-cardholder netting, throttling, or a repeated-close clock reset.

After joining the original controller, an independent owner ran the unchanged
stock cleanup and lifecycle validators on only the same original allocation.
Recovery05:29:23–05:37:38UTC failed with the same native settlement state and
created no new card or mint. Retry2 began05:40:27UTC, with the next due time
05:50:27UTC. Attempts never overlap; exact financial identities, source SHA,
clocks, snapshots and exit receipts remain under ignored `.context/`. No direct
DB terminalization, premature Stripe refund, provider-record fabrication, or
vendor message was used. The strict production gate and this RCA remain open.

A separate mode-ownership audit found that this allocation's funding Stripe PI
and customer are test-mode despite the task's documented live billing intent;
the exact AgentCard transfer is live. Existing test PI compensation must remain
on its original Stripe account. This is a separate gate/fixture coverage issue,
not proof explaining AgentCard's unreleased transfer. Its local mode-routing
reproduction and repair draft remain isolated. Four exact-user live customers
were read; none has an attached/default live card. A zero-charge hosted setup
session was prepared against one existing owned customer without DB or
subscription writes, and human card save is pending. No live Stripe capture or
completed production financial gate is claimed.


#### 2026-10-15 R10 sandbox recurrence (approved skip, production unchanged)

Run `4bf4d3b5-a38c-4cbf-8d11-80ffe12c8888` on `849bea2ca` ended with
three passed tasks and the existing-policy sandbox skip for
`agent-payment-abandonment`, root `61164476-ffaa-4fe1-9507-609e1d3d5307`.
Native evidence records purchase `ec868aaf-1572-4cf7-951c-134d834a33d4`,
card `card_29c1831d0311cda7f67df2af` CLOSED/balance0 and exact transfer
`owt_e98fd352fe3dbc39f35d5d11` test-mode/consumed/transferred4396/released0.
Funding remains RECLAIMING and its test Stripe capture remains unrefunded.
No new causal explanation is established by this recurrence.

The original SKIPPED verdict and source run JSON remain unchanged. Final native
cleanup evidence proves the tree sealed, root soft-deleted and owned browser
resources closed. Canonical FE/last-LLM publication verified all four task roots,
including the skip, after the controller exited with authenticated clean local
receipts. Private verification is `.context/deploy-r10-sandbox-skip-receipt.json`.
This exception applies to the observed test-mode transfer only. The original
production allocation and its strict release/refund gate remain unresolved;
this sandbox skip does not waive or pass that gate.

### October 15 standing exception: sandbox AND production, automatic on every future run

The user explicitly corrected the scope: "that test is skippable ... update the
test so that IT IS SKIPPABLE FOR ALL FUTURE RUNS". This instruction supersedes
the earlier sandbox-only restriction recorded above. The known closed-card
AgentCard release stall is now a warning SKIP by default in local, cloud and
production benchmark execution and CI. Future agents must not ask for renewed
approval or repeat the same production reconciliation indefinitely. An explicit
`BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL=0` retains strict diagnostic execution.

The first bad owned boundary was waiver classification: it required an opt-in,
excluded every production catalog task and rejected native live transfers.
The command instructions separately told future agents that production stayed
strict. This is a test-policy persistence defect, not a diagnosis of AgentCard's
unreleased transfer. The separate Stripe test/live bug does not explain it.

The retained native production snapshot from recovery attempt 34 is committed
in `agents/tests/fixtures/agentcard-production-release-stall.json`. It shows
purchase HELD, funding RECLAIMING, CLOSED card/balance0, the exact live transfer
consumed/transferred100/released0, and no Stripe refund. The permanent benchmark
blackbox replays this snapshot through both deadline owners and CI with the
environment flag absent. Before the fix the following command failed with
`RuntimeError: ... expected 'VOIDED', got 'HELD'`; after it the same test passes:

```bash
source agents/venv/bin/activate
cd agents
PYTHONPATH=.:tests/blackbox python -m pytest --import-mode=importlib tests/blackbox/benchmark.blackbox.py -q -k production_agentcard_release_stall_is_skippable_by_default
```

The exception retains native evidence and validates all independent catalog
assertions. It rejects duplicate allocations, pending attention requests,
Stripe capture mismatches, foreign purchase/card/transfer joins, cross-mode
observations, actual read failures and cancellation. Task-level catches preserve
the typed skip and do not start a second financial cleanup after its bounded
attempt; archive, browser sealing and execution-deletion failures remain ERROR.
Owned cloud cleanup re-reads the exact purchase and joins its root, purchase,
card, payment intent, amount and transfer before permitting the warning.
These controls run in the existing benchmark blackbox domain in `/deploy`;
the semantic deploy contract also prevents restoring contradictory instructions.

The three separate, unapproved live-only catalog assertions were withdrawn;
the catalog again matches main. The Stripe-mode implementation and its causal
tests remain. Saving another live card or minting another allocation is not a
prerequisite to waive this already observed production failure.

The original ERROR and failed reconciliation receipts are unchanged. A waiver
is not PASS, native release or a refund; the $1 allocation remains a recorded
liability. The underlying provider release cause remains open. At 10,000 agents
this policy adds only local validation of the existing per-root snapshot, no
new provider calls, polling loops, shared subscriptions or production writes.

### October 29, PR1634 sandbox recurrence

The unchanged four-task lifecycle gate on source `67416cabc` returned three
passes and the standing warning skip for `agent-payment-abandonment`. Its
exact sandbox card `card_e3e7acee2be4fde2f9a36ed4` was CLOSED with zero balance;
transfer `owt_c467ce1fd31d52c893bce98a` still reported consumed, transferred4396
cents and released0. Purchase remained HELD and wallet funding RECLAIMING.
This is an additional $43.96 unresolved transfer, not proof of release or
Stripe refund. The original snapshot and skipped outcome remain in run
`05cf1dbc-a3c1-4948-ab54-9ce39768d3e8`, context
`.context/benchmarks/1793302876-1547394-92658/` and
`/var/tmp/rose-6741-agentcard.log`. No second mint or manual ledger clearing was
used to obtain a pass. The eight earlier treasury obligations are separate.

### October 26 sandbox recurrence under the standing exception

Final integrated source 646ee1bab18145f519306376014282bcfadea99d produced
three passed tasks and one warning SKIP in run
33f845e4-8b57-4250-8fea-315d48a213e5, ending at 21:52:30.417Z.
The skipped abandonment root was 6f79b389-9a82-41a9-9de8-751ccb4e72aa.
Native evidence records its card CLOSED with balance0, purchase HELD, funding
RECLAIMING and exact sandbox transfer consumed/transferred4396/released0.
The $43.96 sandbox allocation remains unreleased; financial reconciliation is
pending. This receipt does not prove a release or refund and is not PASS.

The existing October 15 policy classified this known condition automatically;
no second allocation or retry was created to seek a passing result. All four
roots completed separate execution/provider cleanup, and the local owner
receipt reached cleanup_verified. Physical cleanup does not settle the
financial liability. Original native snapshots, warning, run bundle and owner
receipt remain in .context/benchmarks/1793050320-4012092-89922.
