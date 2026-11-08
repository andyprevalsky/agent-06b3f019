---
id: 2026-11-08-production-payment-admission-omitted-billing-mode
date: 2026-11-08
title: Production payment admission accepted test-mode billing before allocating a live AgentCard
surface: cross
component: production-payment-admission
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: credits.getUsageSummary omitted persisted billing mode and the native production payment preflight admitted tier/credit without requiring live Stripe billing
symptoms:
  - "payment_lifecycle.stripeHold.livemode must be true for a production lifecycle"
  - "stripeHold.livemode=false and orgTransfer.livemode=true"
tags:
  - stripe
  - agentcard
  - admission
  - production-payment
sources:
  - PR #1770
  - commit 5066feea73da4a966aa7655ccbc40ea8c26529a8
  - agent a00ba17e-7ca0-4d39-b8b5-30e093be74f9
  - plan:.context/production-mixed-mode-evidence/evidence/native-run.json
repro: agents/tests/blackbox/production_payment_admission.blackbox.py and back-end/src/tests/blackbox/credits-billing-mode.blackbox.ts
status: open
---

## Problem

The original production abandonment task ended ERROR, native exit 1, passed
false. Its failure_evidence.benchmark_state.payment_lifecycle explicitly records
a test Stripe hold and live AgentCard transfer. The top-level payment_lifecycle
is null; it must not replace the preserved failure snapshot. The live transfer
last showed 100 cents transferred and zero released, card CLOSED with zero
balance, purchase HELD, funding RECLAIMING and no Stripe refund. Agent deletion
and cleanup_failures=0 do not prove financial recovery. Current finances remain
UNVERIFIED. No report_bug call was present in the preserved native log payload.

## Diagnosis

Gate: NOT_INTRODUCED by PR1770 versus first parent
211db9ec92a3a4fdbc7593ec977a23551cc34134, as established by the handed-off source
closure. This assigned repair remains owned independently of attribution.

The path is persisted Subscription -> credits usage response -> production
runner admission -> root creation -> PurchaseSpend snapshot -> Stripe authorize
and live AgentCard funding -> lifecycle validator. repoOpen snapshots
subscription.stripeLivemode, defaulting to false; chargeAuthorize selects the
Stripe client from that immutable purchase mode; lifecycle preserves native hold
mode. None of those downstream facts establish which writer changed user107.
The --live provisioner explicitly writes true. No Subscription row or writer
audit was captured, so why-user107-testmode remains OPEN.

The first proven admission violation is earlier: the API omitted mode and the
preflight checked only tier and remaining credit, even continuing on HTTP errors.
An otherwise funded test-mode identity consequently reached allocation. Local
native run_single_task plus a fake HTTP provider reproduced that exact boundary;
the fixture aborts every write before allocating a root. Missing mode, null,
string and numeric substitutes share the same missing invariant. The fix adds
no credential inference and does not change any persisted billing data.

Two archive searches used the exact lifecycle error and "production payment
identity test mode live allocation admission". The July21 inherited sandbox
fixture and October17 positive-provenance fixture cases are relatives, with
different first-bad boundaries. Their solutions and human feedback were read.
This is neither the old org-token defect nor either 4396-cent release stall.

## Solution

credits.getUsageSummary now derives tier and stripeLivemode from the same
Subscription read, returning null when absent. This replaces the existing tier
read rather than adding a query or cache. Production payment preflight requires
literal true and fails closed on non-200 responses before any root or fixture
write. Generic tasks and sandbox payment setup retain their native paths.
Deleting billing-mode state would break purchase ownership; unifying the API's
existing subscription read plus its admission predicate is the narrow repair.
At 10k agents this remains constant indexed work per usage request, with no new
query, polling, shared lock, subscription or provider request.

Before/after commands (logs and unchanged test hashes retained privately):
`cd agents && venv/bin/python scripts/run_blackbox_tests.py production-payment-admission`
failed 2/5 before and passed 5/5 after. Test-mode and missing-mode reached the
allocation POST before; all-live and sandbox controls remained admissible.
`bash back-end/scripts/run-blackbox-tests.sh credits-billing-mode` failed before
because usage.stripeLivemode was absent, then passed against real isolated
Prisma rows and the real HTTP route for absent, false, true and changed-false
subscriptions. Both suites are discovered by their canonical blackbox runners.
The affected-source graph and normal deploy lanes must include them.

Golden reference: not applicable (no approval-gated hunk). The exact original
production payment task is expressly forbidden from being rerun; local causal
proof must not be called production task outcome proof. Deployment and allowed
production verification remain pending at this case's creation.

### Independent adversarial review and resolution

The independent reviewer confirmed native boundaries and source attribution and
raised two P2 findings. The original review remains retained privately.

First, Prettier changed final backend test bytes after its initial paired proof.
The final formatted file was replayed against an isolated copy of the baseline
credits service and the current service: exit1 then exit0 with identical SHA256
51b9cacd148c5cf727419d09b0550a0e93afe9d4e94fc5305b6be9faa6d8a16b.
Original logs and the original hash manifest remain intact.

Second, preflight alone did not enforce the later purchase snapshot. The owning
purchases-stripe-snapshot blackbox was extended before that repair. With real
local Prisma and canonical Stripe SDK clients directed only to loopback, a false
production purchase was issued on the old code (missing expected rejection),
while the all-live control passed. The identical test passes after a guard at
resolveAndIssuePurchaseCard, before Stripe, admin or card issuance, requires the
persisted production identity's purchase mode to be literal true. The guard also
covers resumed purchases through that boundary. Generic sandbox identities remain
permitted. A live snapshot stays live after Subscription switches to false;
the all-live control issues exactly one fake card and every captured Stripe
request uses the live fixture account. No added query or lock is needed. Existing
financial cleanup paths and known allocations were not executed or changed.

A follow-up review found a fresh rejected purchase was left PENDING_APPROVAL.
The unchanged owning test reproduced that state leak, then passed after fresh
pre-provider rejection marks the row FAILED. The same receipt can subsequently
mint through the public service with valid local live billing; resumed financial
work preserves its existing state. This adds no provider operation.

Changes before snapshot creation are rejected; changes afterward cannot alter
immutable purchase ownership. This does not assert an incident race, identify
the historical writer or claim production recovery. Credits GET can grant its
existing invite allowance; zero runner allocation writes is not a claim that
this API makes no database writes.

During this repair's deployment, the unpublished stabilization commit was refused
by cloud source admission before any fleet handle or task allocation. All 13
native cases remain UNVERIFIED. Publishing the source fixes that operational
cause. A narrow typed cleanup proof binds the exact historical dispatch sources,
refusal logs, empty run namespace, joined relay/inventory processes and native
publication acknowledgment before permitting another launch. Its unchanged
regression fails on the previous validator and passes with seven rejection
controls; it grants neither task nor financial cleanup credit. This does not
waive or rerun either protected historical payment case.

## Human feedback

The user assigned this distinct admission defect through its own deploy on an
independent Bugs devbox, prohibited recursive repair delegation, production
payment reruns and mint/reissue of all three known allocations, and required
unchanged local blackbox fail/pass plus all-live and sandbox controls. Preserve
the native ERROR/exit1 and unknown identity writer. No production Subscription,
Stripe-key or cardholder changes are authorized as a workaround. The two
historical sandbox duties each retain their last 4396 cents unreleased and
current UNVERIFIED status, independently of the new live 100-cent duty.

## Reusable lesson

Require authoritative persisted billing mode at production payment admission before allocating any execution or financial resource.
