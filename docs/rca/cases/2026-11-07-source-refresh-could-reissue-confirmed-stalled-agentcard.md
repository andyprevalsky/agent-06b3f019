---
id: 2026-11-07-source-refresh-could-reissue-confirmed-stalled-agentcard
date: 2026-11-07
title: Source refresh revoked a confirmed AgentCard warning without a read-only renewal route
surface: harness
component: deploy-resource-warning-renewal
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: refresh correctly invalidated changed-input resource qualifications but exposed no typed renewal route compatible with the standing prohibition on minting another card after a confirmed release stall
symptoms:
  - confirmed AgentCard stall moved to superseded_resource_warnings after main integration
  - the next full smoke request included the already-stalled case again
  - original CLI rejected the renewal action
tags:
  - deploy
  - agentcard
  - resource-warning
  - source-binding
sources:
  - PR #1770
  - commit cc38c3cf0b634c01f224ead532112366d0fbfa93 original complete native smoke
  - commit ea97f366b94ebe4ceb402d45bb1448b9887374de forced main integration
repro: python3 scripts/tests/deploy-test-cycle.test.py Cycle.test_changed_source_agentcard_renewal_cli_keeps_failure_and_runs_peers
status: fixed
---

## Problem

The first complete smoke sweep recorded 12 PASS and one native SKIPPED AgentCard
abandonment task. Independent RCA verified the exact standing release-stall
predicate: a closed zero-balance sandbox card, consumed transfer with zero
released cents, HELD purchase and RECLAIMING funding. The sandbox transfer
remained unreleased by $43.96; no financial release or refund was claimed.
The supported coordinator qualified that complete native row as a warning.

Main then advanced while checks ran, requiring a source integration. Refresh
revoked the old input-bound warning, as designed, but the only subsequent path
would execute the same case and mint another card. That conflicts with the
standing instruction to stop retrying after a confirmed release stall. No
existing changed-input renewal command was available.

## Diagnosis

This is a qualification lifecycle gap, distinct from the external provider's
unreleased transfer. The Oct 2 AgentCard release-stall case is a relative and
recurrence for the vendor state, not this missing source-renewal boundary.
Archive searches used AgentCard warning changed source renewal and source
resource qualification renewal; an exact search for resource-warning renewal
and superseded_resource_warnings found no existing case for this boundary.

A read-only replay on a copy of the real cycle changed one active warning to
zero while preserving its original native row in history. The original full
request would include the stalled case and its peer. Running the identical
new owning regression against the frozen original coordinator failed with
argparse SystemExit 2 because the supported renewal action did not exist.

## Solution

Add a narrow typed renewal for an already confirmed sandbox AgentCard release
stall. It binds the immutable original complete FAIL/native SKIPPED row,
source and file hash to the current source, plan, inputs, environment and
producer hash. It verifies that the exact task, transitive local assertion
helpers and payment implementation remain unchanged.

A separate producer uses existing organization authentication and only the
read-only get_card and list_transfers tools. It captures fresh allowlisted
metadata for the original card and transfer, with no card details or unrelated
records. The renewed qualification requires the same closed zero-balance
sandbox card and consumed, wholly transferred, zero-released transfer. Missing,
ambiguous, live, released or changed data refuses. The observation must follow
binding preparation and be fresh at admission.

The coordinator appends only a current-input exclusion and its renewal proof.
It preserves the old native row, financial snapshot, warning and failure
history, and grants no new execution, PASS, refund or cleanup credit. All
remaining checks execute under their original contracts and deadlines.
Same-input carry remains unchanged; compute quotas and assertion failures
cannot use this path. No real cycle or provider state was modified by the
implementation or independent review.

## Verification

The unchanged owning regression fails on the frozen original CLI and passes
on the repaired coordinator. Its mocked request then excludes only the
confirmed case while the peer executes, and the original native bytes and
failure history remain identical. The full coordinator suite passes 197 tests;
the read-only producer passes four tests covering its exact tool whitelist,
shared deadline, redaction and unsafe resource controls. Contract controls
reject changed task, payment code, predicate dependencies and cleanup helpers.
Independent read-only review found no blocking correctness objection.

The first fresh vendor read exposed an incorrect helper assumption: get_card
omits livemode, while the exact linked transfer supplies it. The unchanged new
regressions failed on that producer/schema and passed after preserving absent
card mode as absent. Explicit live or malformed card modes still refuse, and
the transfer must independently prove sandbox mode. A target-only read verified
the original consumed transfer remains 4396 cents transferred and zero released;
that diagnostic does not replace the required frozen-source proof.

Actual source-bound vendor reconfirmation and the new combined-source full
sweep are separate required deployment steps; these tests do not claim either
has executed or that the sandbox transfer was released.

## Human feedback

The user requested completing RCA and deployment autonomously. No new
permission to retry the stalled card or waive tests was given.

## Reusable lesson

Provide a typed fresh-observation renewal for a still-confirmed resource exclusion when source refresh must preserve a no-retry boundary.

## Later provider history-window boundary

After a forced main integration, fresh reads returned the same CLOSED zero-balance
card and a full 100-row consumed-transfer page without the original transfer.
The provider integration documents that the transfer list has no pagination or
card filter. An earlier organization-token rejection was intermittent: later
reads succeeded with the unchanged credential. A proposed credential-exception
path was reverted; it is not the basis for this renewal.

A full page of distinct records dated after the original native failure ended
can now preserve the original no-retry warning with a separate bounded-visibility
observation. It does not establish the current transfer state. The fresh exact
card must still be CLOSED with zero balance, and all original-native, unchanged
payment/task/assertion contract, source/input/environment, producer and freshness
guards remain. Partial, old, duplicate, malformed or mixed pages fail closed.
Only the original already-stalled case is excluded; every peer executes. The
original FAIL/SKIPPED and last-confirmed $43.96 sandbox obligation remain open,
with current financial state UNVERIFIED and no PASS, refund or release credit.
No card, transfer, reclaim or credential is created or changed.

## Changed payment implementation recurrence

The later main integration changed payment implementation, correctly invalidating
legacy warning renewal. A second original native FAILED auth/timeout task also
had a confirmed sandbox release stall. Neither event permits minting another
card for those exact tasks. Historical no-retry custody now preserves both
native outcomes, their original financial snapshots and the independent pending
auth repair packet while binding two explicit omissions to the new source.
Current behavior and financial state remain UNVERIFIED. The unchanged catalog
is required; payment/assertion equivalence is not claimed. Remaining checks run
normally, and missing custody blocks before cloud admission. The regression
`Cycle.test_historical_stall_cannot_refresh_into_new_card_request_without_proof`
fails on the old refresh (no refusal), then passes with the typed guard. The
provider release stall and auth failure retain their own RCA status.
