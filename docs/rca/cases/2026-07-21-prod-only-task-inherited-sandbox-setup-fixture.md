---
id: 2026-07-21-prod-only-task-inherited-sandbox-setup-fixture
date: 2026-07-21
title: The production AgentCard lifecycle task inherited the sandbox setup fixture, pairing a live credential with a sandbox cardholder
surface: harness
component: benchmark-fixtures
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the production lifecycle task definition — it inherited `expected_payment_lifecycle`, so the runner seeded the sandbox setup fixture before creating the agent
symptoms:
  - "Cardholder not found" from the live AgentCard readiness check
  - production AgentCard lifecycle benchmark fails at preflight
  - "transfer completed with livemode=false" on a production gate
tags:
  - agentcard
  - benchmark-fixtures
  - stripe
  - livemode
  - sandbox-vs-prod
sources:
  - PR #838
repro: registered benchmark blackbox regression for the production fixture policy
status: fixed
---

## Problem

The production-only AgentCard lifecycle benchmark failed its live readiness check
with `Cardholder not found`. Worse, in the cases where that preflight _did_
succeed, it succeeded under sandbox credentials and the resulting transfer came
back `livemode=false` — meaning the production gate was passing without ever
exercising production.

## Diagnosis

The production lifecycle task inherited `expected_payment_lifecycle`, so the
runner ran the benchmark **setup fixture** before creating the agent. Render then
paired a live AgentCard organization credential with the old sandbox cardholder
ID, and the live readiness check correctly reported `Cardholder not found`. The
readiness check was right; the fixture was wrong. The deepest owned cause is that
synthetic setup seeding was inherited by default, so a task whose entire purpose is
to exercise the normally persisted live integration was silently handed a
substitute sandbox environment — a fixture/environment mismatch that could either
fail loudly (cardholder mismatch) or, more dangerously, pass falsely
(`livemode=false`).

## Solution

Production-only lifecycle tasks now skip synthetic setup seeding entirely and
exercise the normally persisted live integration; local lifecycle and one-time
setup/resume behavior is unchanged. A registered blackbox regression pins the
production fixture policy — the focused pre-fix regression reproduced the failure
and the full benchmark domain passed post-fix.

## Human feedback

The project owner explicitly waived the repository's Claude fallback review for
this PR because that account could not add more credits. The production benchmark
was deliberately **not** rerun: the user-bound live AgentCard cardholder was still
KYC `pending`, so the Render cardholder binding was corrected and the verification
session resumed instead — rerunning before KYC verification would be unsafe and
could not pass.

## Reusable lesson

A production-only benchmark must never inherit synthetic setup seeding — mixed
live credentials with sandbox fixture IDs either fail at preflight or pass with
`livemode=false`, which is worse.

## October 15 local draft: Stripe purchase mode ownership (open)

A new production-gate observation exposed a related mode-integrity boundary,
not a recurrence of the original inherited AgentCard setup fixture. The parent
confirmed the exact allocation's PaymentIntent/customer are native Stripe
livemode=false while the owned AgentCard transfer is livemode=true. The global
billing test key is deliberate and must remain. Subscription.stripeLivemode
already distinguishes live checkout ownership, but purchase Stripe operations
still use the legacy singleton and PurchaseSpend has no immutable mode snapshot.
Lifecycle output also omits native Stripe livemode, so the current production
expected result cannot reject the mixed-mode observation. The independent
AgentCard consumed/released0 release stall remains unchanged; no refund/release
safety gate may be bypassed because of this mode defect.

The isolated detached worktree is `.context/pr1520-stripe-mode-draft`, pinned to
6ef22cc55811444f1524fb9faf22f6e97600410e. A normally auto-discovered owning
`purchases-stripe-mode.blackbox.ts` executes the real saved-customer helper and
canonical Stripe SDK/client selection against a loopback-only HTTP fixture.
Synthetic keys and mode-owned customer IDs produce native-shaped resource_missing
when the actual SDK Authorization mode is wrong. There are no mocked desired
helper returns, database writes, real provider requests or financial mutations.

Run from that worktree root:
`node --import tsx back-end/src/tests/blackbox/purchases-stripe-mode.blackbox.ts`.
The identical final test body fails on the original helper (test customer passes,
live customer resource_missing; exit1) and passes on the local helper draft
accepting livemode and selecting getStripeClientForLivemode (both pass; exit0).
Evidence is `.context/stripe-mode-proof/customer-before.log`, `customer-after.log`,
exit receipts and result.json inside the isolated worktree. Earlier fixture
Bearer-header iteration is excluded from this final paired causal proof.

This proves the customer routing mechanism only. It does not prove full purchase
snapshot persistence, authorization/capture/refund routing, migration, corrected
production catalog acceptance or a successful live task. The broader local
proposal and exact unapplied schema/migration/provisioning/catalog diffs are
`.context/stripe-mode-proof/proposal.txt` and `proposed-contracts.patch` there;
`initial-customer-fix.patch` is the executed narrow fix plus owning regression.
A complete draft must bind new purchase ownership once from persisted
Subscription.stripeLivemode, preserve legacy false snapshots and route all
retrieval/compensation by the purchase snapshot after later subscription changes.
Native hold/refund mode must be exposed and production expectations require true.

The schema/migration and benchmark contract remain approval-sensitive proposals.
No migration, provisioning helper, deployment or production-key change was run.
Parent owns unchanged-source recovery session53043 and production semantics run
38685810164. This subcase remains open and incomplete pending the full local
snapshot implementation, owning mode-switch/cleanup tests, parent review and
any explicitly authorized deployment/financial acceptance run. The user
requested the concrete local draft while forbidding production financial writes;
that authorization is not a claim that a partial patch is deployable.

### Same isolated draft: first implementation batch and contract stop

The next local batch adds immutable purchase mode/customer/subscription snapshots,
mode-selected authorize/capture/reverse helpers, primary cleanup propagation,
live fixture persistence and native hold-mode exposure. The owning real-Prisma
plus real-SDK loopback test fails on baseline runtime and passes12/12 on the draft
with an unchanged test body and the same local additive schema. Records are
isolated in victoria_pr1520_stripe_draft and cleaned up; parent generated Prisma
packages/client are untouched. This is not a live financial outcome.

Implementation stopped at an explicit architecture/contract choice as requested:
native Stripe Refund has no livemode property. Lifecycle cannot truthfully expose
that as native evidence. Parent must choose linked PaymentIntent mode with strict
refund.payment_intent binding (recommended), or retrieve the linked native Charge
and verify its mode/linkage. No expected/subscription boolean may be substituted.
The fake direct refund field was removed before handoff. Lifecycle contract tests,
remaining stale/funding compensation snapshot call sites and static compatibility
remain incomplete. The first-batch patch is deliberately labelled incomplete and
must not be applied/deployed as a finished fix. No original allocation or provider
release/refund guard was changed, no external financial calls occurred, and no
schema/prompt bytes in LLM-visible tool definitions were changed.

### Completed local-only draft: purchase-owned Stripe account and verified refund provenance

Parent authorized completing the isolated draft and selected linked PaymentIntent
provenance: Stripe Refund has no native livemode. New PurchaseSpend rows snapshot
Subscription mode, customer and subscription IDs; legacy rows default false.
Authorize, capture, ambiguous reads, cancellation, refund, stale reversal,
unpersisted-intent recovery and funding compensation use that purchase mode after
Subscription changes. Legacy no-PI retries fail closed on an account-mode switch.
No resource-missing retry crosses accounts. Dissolved-hold reads also use the
selected purchase mode and preserve existing reclaim/consumption guards.

Lifecycle reports the native hold livemode. Refund paymentIntentLivemode is
explicitly derived only after every returned refund's native payment_intent
(string or expanded ID) matches the retrieved hold and purchase PI. Missing or
mismatched linkage fails closed; no Refund.livemode is invented and no extra
Charge request is added. Injected lifecycle callbacks remain lazy; default live
callbacks still require configured live credentials. Production catalog oracle
fields now require live hold and verified refund PI mode, with prompt fields
unchanged.

The additive migration and generated Prisma client were applied only to the new
loopback victoria_pr1520_stripe_draft database, with both DB variables explicit.
Generated client, .prisma and prisma package realpaths stay inside the detached
worktree; shared parent generated dependencies are untouched. Same-test causal
logs in .context/stripe-mode-proof show original source exit1 versus draft exit0:
29/29 real-Prisma/real-SDK loopback controls pass after; the separate actual SDK
customer-selection reproduction also fails before and passes after. Lifecycle
service unit tests pass20/20 using a synthetic test key (the initial run without
it failed three pre-existing Stripe-construction checks); transfer tests pass.
Nine selected-customer controls use eight native SDK loopback GET requests.

Provisioning now accepts explicit --stripe-customer-id only with --live, validates
nondeleted native live customer ID plus exact userId/fixture metadata before any
DB write, then reuses it without customer search or creation. No-flag behavior
remains unchanged. The provisioning helper was not executed. Existing test PI
history, financial release/refund guards and the original allocation are intact.

This supersedes the incomplete first-batch stop above. It remains a LOCAL draft:
normal parent review/gates, migration approval/application and any separately
authorized production acceptance remain outstanding. No production DB writes,
provider calls, paid benchmarks, commits, pushes or deployment occurred here.

## October 17: stale hermetic fixtures after Stripe provenance enforcement

The normal agents coverage run at `c9ff323c3633` exposed six benchmark blackbox
callbacks whose positive fixtures omitted the native hold mode or linked-refund
PaymentIntent mode required by `e1cce5103`. Three controls also treated the
retained mixed-mode allocation above as a valid live release-stall example.
The runtime correctly rejected those inputs. This is related test-fixture
drift, not evidence that the original allocation acquired live provenance.

The same registered callbacks failed on the original test setup and passed with
explicitly synthetic live response fixtures. The historical JSON remains
byte-identical and now supplies a fail-closed control. Independent corruption
controls start with an otherwise valid fixture and reject missing, false,
numeric and string hold modes. Existing financial, cancellation, deadline,
foreign-ownership and native-retirement assertions remain unchanged.

The same coverage run exposed a separate fixture lifecycle mismatch: the fleet
publication control executed the complete publisher heredoc after `201226d3c`
made its owner loop persistent. Publication succeeded, but the subprocess could
never finish within its unchanged 30-second guard. The control now invokes the
actual `aggregate_tick` once and retains its publication, deduplication,
failure, teardown and release assertions. Production loop behavior is unchanged.

Paired owning evidence records seven failures before and seven passes after,
plus 16 neighboring controls passing. All 5,652 original assertions remain;
one historical rejection assertion was added. The private causal packet is
`c12-benchmark-fixture-rca-local1745`, manifest SHA256
`6bc3bb41093f511ccd345e8344f0d5c698dd79d9aa08a7998e7d19a1c812f0c6`.
These are hermetic fixture proofs. Full deploy coverage requalification remains
required; no live financial result, refund, release or fundraiser success is
established by this repair.

## October 17: remaining Hub fixtures entered the persistent owner loop

Two additional `hub_upload_test.py` consumers still executed the complete
aggregator heredoc after `201226d3c`. The stable timestamp control hung in its
`aggregate` parameter, and the six-parameter terminal-startup control used the
same unbounded entry. Actual C12 structural evidence identified the former
callback and its Bash/Python descendants; ROOT preserved the interrupted gate
as a failure. A successful publication did not terminate this owner loop.

Both fixtures now invoke the real `aggregate_tick`
once, retaining the full production function and imports. It does not change
the controller's persistent loop. Both fixture subprocess callers now use
owned sessions and the existing `FIXTURE_HOST_GUARD_SECONDS`, joining their
created process group on interruption. All 106 original assertions across
29 test functions and every parameter decorator have identical ASTs. The
50-task fleet, phases, clocks, outcomes and publication assertions remain.

With real fixture loopback HTTP and external networking denied, separate safe
outer guards observed the aggregate parameter and the terminal-startup
function hang. Each new local process tree was retired; no guest process was
signalled by the worker. The candidate passed all three timestamp producer
parameters, all six terminal-startup parameters and the complete 37-test
`hub_upload_test.py` file. The neighboring finite fleet-publication callback
also passed. This is test-fixture lifecycle proof, not production publication,
provider acceptance, a completed deploy or a newly qualified source revision.

Full callback commands, source hashes, original assertion parity, local guard
limits and retained harness diagnostics are in the private
`rca-c12-hub-aggregate-fixture-01a136f6` packet. ROOT owns source application and
normal full-gate requalification; the original C12 interruption remains FAIL.

Independent review also identified an exited direct leader retaining an owned child
with open pipes. A new registered real-subprocess regression reproduced the old
cleanup hang under a four-second outer guard. The correction kills the
exact owned group even after leader exit and bounds drain with the existing
30-second fixture constant; the same regression and complete 37-test file pass.
The canonical 600-second fixture guard and production loop remain unchanged.
