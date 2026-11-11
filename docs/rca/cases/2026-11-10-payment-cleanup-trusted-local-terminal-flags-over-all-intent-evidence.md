---
id: 2026-11-10-payment-cleanup-trusted-local-terminal-flags-over-all-intent-evidence
date: 2026-11-10
title: Native payment cleanup accepted local terminal flags without observing every persisted Stripe intent
surface: harness
component: test-payment-lifecycle-custody
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: pending_root_payments accepted FAILED with no funding as terminal while the lifecycle observed only the latest purchase PI
symptoms:
  - all persisted same-agent intents need external custody proof
  - Expected mock to have been awaited once. Awaited 0 times.
  - two purchases and Stripe intents but only the final paid PI has archived external status
  - initial setup purchase FAILED with card and funding absent
tags:
  - stripe
  - agentcard
  - payment-cleanup
  - lifecycle
  - financial-custody
  - coverage-gap
sources:
  - agent 72dd42a4-6d27-4937-9a1b-de4f71a537f6
  - commit ec6c24c530ddbb04e1e49672dbda809a8f7a5f18
  - plan:.context/agentcard-e2e/all-intents-custody-20261110/receipt.json
  - plan:.context/agentcard-e2e/all-intents-custody-20261110/independent-review-e7e6ba4136c9619b.json
  - plan:.context/agentcard-stability/combined-observer-report-application.json
  - plan:.context/agentcard-stability/combined-observer-report-public-checks.json
  - plan:.context/agentcard-e2e/all-intents-custody-20261110/public-validation-20261110_231710-e5b2db06/results.json
repro: agents/benchmarks/cloud_batch_cleanup_test.py::test_terminal_failed_setup_intent_requires_external_custody; back-end/src/tests/blackbox/test-payment-stripe-custody.cases.ts via existing test-payment.part2.blackbox.ts
status: fixed
---

## Problem

The native `agent-payment-setup-resume` result recorded two purchases and two
Stripe intents. Its final purchase was correctly `CLEARED` with funding
`CONSUMED`; the initial unminted setup purchase was locally `FAILED`, with no
card or funding row. The latest-purchase lifecycle DTO exposed external Stripe
state only for the final paid intent. The native payment-cleanup receipt listed
the initial PI, but accepted its local terminal flag without independently
observing external exposure or refund completion.

The concrete initial PI was `pi_3Ua6CZJyWRw3Eb951cAbheFm`, purchase
`9df9771d-2e58-43b5-9d55-e75a909c72b2`, under the exact root above. An authorized
operator read on November 10 at 05:02:57 UTC proved `livemode=false`,
`status=canceled`, amount4396, received0 and capturable0, with exact
purchase/user/agent metadata. It performed one PI GET, no refund-list GET and no
write. **The actual PI had no residual exposure. No compensation defect, money
leak, duplicate funding or escaped unpaid obligation is established.**

Evidence: canonical `20261110_040033_5a6ae959-2492-45ea-9688-f48f0f303f1a_agent-payment-setup-resume.json`
(SHA256 `8cf66a164ff3a58dfbb6747d4cbe9f67f65763e754bc9d88e71f587a1be8d632`),
`postfix-round01-setup-extra-pi-archive-gap.json`, and
`postfix-round01-setup-initial-pi-readonly.json` under the existing stability
proof directory. The separate exact read supplied missing financial custody
proof for that run; it did not change its original assertions, source or grade.

## Diagnosis

The observed path is exact-tree `PurchaseSpend` rows ->
`cloud_batch_cleanup.pending_root_payments` -> native finalization receipt.
The terminal predicate accepts `FAILED` with funding absent or reclaimed.
`_finalize_owned_root_payments` then returned the local ledger without a Stripe
observation when no row was pending. The SQL receipt had PI IDs and financial
statuses but no external PI state or immutable billing customer/mode evidence.
Meanwhile `getTestPaymentLifecycle` retrieved/refund-listed only the latest
purchase PI; provider search contributed an all-agent ID count, not per-intent
custody assertions. Count2 plus localFAILED was therefore insufficient proof.

Product rollback already awaits the canonical `reversePurchasePaymentIntent`
before recording failure, and records reversal errors separately. That intended
product invariant and its existing tests do not independently verify every
external PI during a native E2E. The deepest demonstrated owned cause is an
incomplete observation/finalization contract, not a bad compensation write.

The same final registered test bytes reproduced the gap against original source:
the lifecycle case failed `undefined !== 2`; the real default native finalizer
case failed because its injected external reader was awaited0 times instead of1.
The corrected candidate made both unchanged cases pass; shared-source
verification is recorded below. Node evidence is in
`list-sealed-runs.json`: original source RED and corrected candidate five focused
unit passes. Python evidence is `python-final-before.log` and
`python-sealed-injected.log`: the original case RED, then93 injected cases PASS
with one real-Postgres case outside the no-DB scope. These are causal/proxy tests,
not five native E2E executions or proof that a product compensation leak existed.

Duplicate search used both literal boundaries (`pending_root_payments`,
`cloud_payment_cleanup`, `stripeCustody`) and behavioral terms (failed initial
PaymentIntent, all-intent custody/verification, archive gap). No same-cause case
was found. `2026-07-25-marker-cleanup-enumerated-via-eventually-consistent-visibility`
was read as a relative of the private development finding below, not a recurrence
of this Stripe observation gap. Its bounded visibility retry is not imported.
Archive searches during integration also used `stripeCustody paidPurchasesCleaned`
and `FAILED no funding external Stripe custody`. The related
`2026-09-11-stale-purchase-cleanup-marked-failed-before-reversal` repairs a false
terminal product writer; this case concerns independent external observation,
not recurrence of that compensation defect.

## Solution

**Applied after native source release; status OPEN pending final-source native
E2E custody proof.** The exact twelve-file patch
`e7e6ba4136c9619b08cd3f3362adbed2b3b163b2ae90c4adc455e4946711de61`
was applied by the parent at 23:15 UTC on November 10. It retains the observer
implementation from reviewed seal
`cadffd8c8dda8af3fae35a865135ed5ac9bab11ccfe175e4e88dee336a8a8c4f`
and includes the reviewed owning-fixture compatibility correction. The patch
adds an opt-in observation to the existing authorized lifecycle endpoint. It
binds every persisted PI to stored purchase/user/agent/customer/mode/amount and
native metadata, verifies zero capturable exposure, and requires full successful
refund evidence for received funds on compensated purchases. Paid observations
preserve the genuine captured chain and reject pending or returned funds.

Inventory uses complete paginated PaymentIntent LIST per known immutable
customer/mode, with exact agent/user filtering and strict identity/cursor checks.
It verifies persisted IDs plus unexpected matching IDs within those known
customer/mode sets; it makes no account-wide or unknown-customer absence claim.
Native finalization joins the observations to every exact sealed-tree persisted
PI and preserves compact verified evidence in the existing receipt. Normal DTO
calls without the opt-in, access controls, charge/compensation operations and
AgentCard release-stall handling remain unchanged. No financial writes or new
paid CI suite are added.

The regressions cover canceled zero-exposure and fully refunded initial PIs;
active/captured-unrefunded FAILED intents; pending/partial/foreign refunds;
mode/customer/user/agent/purchase/amount mismatches; missing/extra inventory;
malformed/paginated lists; unrelated same-customer agents; and mixed historical
billing snapshots. They are wired into existing lifecycle unit/blackbox and
native cleanup suites, now applied in shared source. The native cleanup suite
already runs the registered regression; no new paid CI gate is introduced.

### Private development finding, not an escaped incident

The first private candidate `3d41bdd665c55d5156a0f006121319cb031ba495d97c95e1bdeaeba829d93822`
used Stripe Search to prove fresh inventory completeness. Independent review
caught the SDK's explicit read-after-write consistency warning. An isolated
stale-search fixture made that candidate reject healthy exact PI observations;
Search also could not prove absence of a fresh unexpected intent. The candidate
was never approved/applied or used by a native run. Its patch, receipt, manifest
and RED remain preserved as superseded development evidence. The corrected
candidate's same tests pass with customer-scoped LIST despite stale Search.
Existing latest-summary Search behavior is unchanged and supplies no new custody
absence authority.

Independent and parent CODE_ONLY review accepted the exact seal; application
waited until the failed postfix round05 had retired all owned resources and
released source. The e7e6 reseal changes only the owning PostgreSQL fixture from
cadffd: it supplies the three columns read by the unchanged canonical purchase
query (`userId`, `stripeLivemode`, `stripeCustomerId`). The earlier missing-column
failure is retained as fixture evidence, not a product compensation failure.

Private DB-backed validation recorded 94 native cleanup cases PASS, backend
service 20/20, part2 blackbox 9/9 and lifecycle-transfer PASS. Earlier no-DB attempts
and the 93-case injected run remain distinct evidence; neither is relabeled as
real PostgreSQL coverage.

Shared-source validation subsequently finished at 23:18:14 UTC. The public receipt
records unchanged source hashes, service 20/20, part2 blackbox 9/9,
lifecycle-transfer PASS and 94 native cleanup cases PASS, with zero external
financial/provider calls. The schema setup exited0; the exact system test DB,
disposable PostgreSQL server and temporary root were verified absent afterward.
The parent's shared backend `tsc --noEmit` also passed. Recorded commands include:

```bash
cd back-end
node --require /home/boxes/rose/.context/agentcard-e2e/all-intents-custody-20261110/deny-network.cjs --import tsx src/tests/unit/test-payment-service.test.ts
node --require /home/boxes/rose/.context/agentcard-e2e/all-intents-custody-20261110/deny-network.cjs --import tsx src/tests/blackbox/test-payment.part2.blackbox.ts
node --require /home/boxes/rose/.context/agentcard-e2e/all-intents-custody-20261110/deny-network.cjs --import tsx src/tests/unit/test-payment-lifecycle-transfer.test.ts
cd ../agents
/home/boxes/rose/agents/venv/bin/python /home/boxes/rose/.context/agentcard-e2e/all-intents-custody-20261110/public-validation-20261110_231710-e5b2db06/run-realpg.py full
```

The runner and receipt retain the isolated DB/environment bindings; these are
historical verification commands, not instructions to reuse a retired fixture.
No additional app test, DB, network or benchmark ran to integrate this archive.

The original unchanged setup/resume task now has actual native automatic
custody proof on c61c2b5f325e92bf8a4c0d8afaf9aaf7545f32b7: both persisted
intents were observed, the initial intent canceled with no received or
capturable funds, and the final intent paid correctly. The complete eleven-task
regression PASSED with all twelve persisted intents independently joined by
the native validator, zero operator GETs, eleven original verified recordings
and twenty-two token-bound clean receipts. Parent audit verified all105 sealed
artifact hashes; final packet SHA256 is
1112d777b56e8bc9776f1fa1c78b6ec99bd26b8479f808abd0c40766571d876f.
This closes the automated observation gap. It does not establish an earlier
product compensation bug or deployment/production success. The historical
54PASS/1FAIL remains unchanged.

## Human feedback

The user requires reliable repeated E2Es and coverage of payment requirements.
The parent explicitly constrained this repair to automated observation and
custody verification: no inferred compensation defect, no financial retry or
write, no broad customer/account sweeps, no weaker assertions/timeouts, no new
paid CI and no edit of the frozen proof source. The actual canceled PI and
original native results must remain distinct from the coverage gap. Parent
review deferred application until source release. Exact e7e6 application and
public DB-backed checks and actual native all-intent custody proof are now
recorded; production verification remains separate.

## Reusable lesson

Verify every persisted financial obligation against its exact native ownership and billing snapshots before treating local terminal flags or aggregate counts as complete external custody proof.
