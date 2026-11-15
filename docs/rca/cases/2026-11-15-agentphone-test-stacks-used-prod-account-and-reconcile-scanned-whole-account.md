---
id: 2026-11-15-agentphone-test-stacks-used-prod-account-and-reconcile-scanned-whole-account
date: 2026-11-15
title: Test stacks provisioned on the prod AgentPhone account, and uncertain-create reconciliation scanned the whole account
surface: back-end
component: agentphone-provisioning
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/blackbox-phone-env.sh let the isolated backend inherit back-end/.env AGENTPHONE_API_KEY (prod); back-end/src/providers/agentPhone.ts:findAgentByMarker walked the newest-first agent list with no lower bound
symptoms:
  - "AgentPhone agent creation is uncertain; reconciliation failed: AgentPhone reconciliation exceeded the 10000-agent scan bound"
  - "AgentPhone number creation failed: HTTP 409 {\"detail\":\"Number limit reached (50/50). Contact us for more.\"}"
  - "Number limit reached (50/50). Contact us for more."
  - browser-provider-live gate /init 500 on AgentPhone provisioning
tags:
  - agentphone
  - provisioning
  - reconciliation
  - scan-bound
  - test-isolation
  - production-account
sources:
  - PR #2023 gate (thread ph737139114cwdz355mzrgya098j4tmk), 2026-11-15 02:11:37Z and 02:13:37Z
repro: back-end/src/tests/blackbox/agentphone-recovery-scan-bound.blackbox.ts
status: open
---

## Problem

PR #2023's `browser-provider-live` gate (`back-end/scripts/run-blackbox-tests.sh
browser-provider`, `BROWSER_PROVIDER_LIVE=1`) hit
`POST /v1/numbers` HTTP 409 `Number limit reached (50/50)` at 02:11:37Z and then
`/init` 500 `AgentPhone agent creation is uncertain; reconciliation failed:
AgentPhone reconciliation exceeded the 10000-agent scan bound` at 02:13:37Z.

The isolated backend's AGENTPHONE_API_KEY (sha256 prefix 698cc1223bb1) is the
key on Render prod. Read-only evidence on 2026-11-15: the prod AgentPhone
account holds 12,530 agents and 50/50 active numbers, all created between
2026-06-23 and 2026-08-27. None has a provisioning marker. Only 2 are referenced
by prod `AgentIdentity` rows, and prod `AgentPhoneMessage` has 0 rows. So test
and dev stacks filled the account that real users share; any new real-user
number gets 409 and the user continues email-only.

## Diagnosis

1. `back-end/scripts/blackbox-phone-env.sh` (sourced by `run-blackbox-tests.sh`
   and `run-coverage.sh`) left AGENTPHONE_API_KEY alone, so
   `loadDotenvWithCallerOverrides` filled it from `back-end/.env` and the
   isolated backend provisioned on the prod account. Nothing in the provider
   refused a live, non-test account from a test stack. Proof: the gate's key
   hash equals Render's. The repro case `blackbox runner env never inherits the
   production AgentPhone key` returned the prod value before the fix.
2. Agent creation can have an uncertain outcome (an abort, or an HTTP
   408/409/429/5xx). `findAgentByMarker` then pages `GET /agents` from offset 0
   until it finds the marker or proves absence, with a 10,000-agent fail-closed
   bound. The list is newest-first by `createdAt`, so every agent past the ones
   created during the attempt is older than the attempt and cannot be its
   agent. The scan still read 100 pages and failed. Every later recovery claim
   ran the same unbounded scan, so that user's phone provisioning failed closed
   for good. Repro: the case `uncertain agent create on a 12k-agent account
   reconciles without an account scan` failed with the gate's exact string.
3. Why was this possible? The lease recorded no time bound for the uncertain
   attempt (recovery markers were stamped at release time and replaced on each
   retry), and test isolation relied on each test overriding the key itself.

## Solution

- `blackbox-phone-env.sh` exports `AGENTPHONE_API_KEY="${AGENTPHONE_TEST_API_KEY:-}"`,
  so isolated blackbox and coverage stacks never inherit the prod key. A dedicated
  test account is opt-in; without one, phone provisioning is skipped.
- `isTestStackUsingNonTestAccount()` (`agentPhoneClient.ts`): when
  `BLACKBOX_TEST_CAPTURE_OUTBOUND=1` and the base URL is the live API, any key
  other than AGENTPHONE_TEST_API_KEY throws an actionable
  `AgentPhoneProvisioningError` before a lease or request is made. Mock base
  URLs and benchmark fakes are unaffected.
- Every lease marker now carries the chain's lower bound:
  `<prefix><lease start>:<uuid>:since:<uncertainSince>`. A fresh claim uses its own
  start. A recovery claim, or a claim that takes over a crashed one, inherits the
  marker's `since`. Legacy markers without `since`, and a stored agent id with no
  marker, are bounded by `AgentIdentity.createdAt`, because no agent carrying that
  user's provisioning marker can predate the lease row.
- `findAgentByMarker` stops at the first agent created before
  `uncertainSince - 5 min` (5 min absorbs clock skew). It dedupes agents repeated
  across pages, which happens when agents are created mid-scan. A page that is
  not newest-first fails closed. Agents without `createdAt` keep the old bounded
  behavior.
- Independent review (step 7) agreed with both first-bad boundaries. It found
  four defects in the first draft: a crashed recovery claim lost the bound;
  legacy markers carried the release time; `since=0` left users stuck; agents
  created mid-scan caused false "not newest-first" failures. All four are fixed.
  A mutation that drops the carried bound fails the new crash-chain and legacy
  cases, 2 of 16.
- Open gaps: offset paging can still skip the marker agent when agents are
  deleted mid-scan (this was already true on main). Benchmark `run.sh` stacks
  still load the prod key for inbound reads, which are read-only; provisioning
  there is faked.

10k-agent behavior: the uncertain-create and recovery lookups read only the agents
created since the uncertain attempt (one page in practice), independent of account
size. The 10k bound remains a fail-closed backstop. Prod on 2026-11-15 had 5 legacy recovery markers, all on identities created on or after 2026-09-04; almost every account agent predates that.

## Human feedback

Andy (via coordinator, 2026-11-15): do not release or delete any AgentPhone number
or agent; contacting AgentPhone about the cap is Andy's action.

## Reusable lesson

A test stack must never inherit a production provider credential from `.env`; blank it in the shared test env and refuse live non-test accounts at the provider. Bound any reconcile scan by the uncertain attempt's start time on a time-ordered list.
