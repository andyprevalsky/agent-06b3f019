---
id: 2026-11-11-pending-nonfinancial-rca-blocked-custody-source-refresh
date: 2026-11-11
title: Pending nonfinancial RCA blocked historical financial custody source renewal
surface: harness
component: deploy-test-historical-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: historical custody build rejects every nonempty pending list
symptoms:
  - "historical custody: active/unknown coordinator"
  - completed semantic failure prevents preserving financial no-retry custody on a new source
tags:
  - deploy
  - custody
  - source-binding
  - evidence
sources:
  - PR #1915
  - plan: .context/rca-playwright/pending-custody-refresh/v2/packet.json
repro: scripts/tests/deploy-test-cycle.test.py::Cycle.test_historical_custody_refresh_preserves_quiescent_nonfinancial_pending
status: fixed
---

## Problem

The normal source-renewal command refused after the semantic worker had finished
with native FAIL, complete cleanup and unchanged source. Its pending RCA remained
UNKNOWN. The deploy also carried an original sandbox AgentCard release stall
under no-retry custody. Preparing preservation of that same financial obligation
failed with "historical custody: active/unknown coordinator".

## Diagnosis

The build function rejected any nonempty pending list in addition to its real
cancellation, retained-owner, running-work and resume guards. The cycle's
source-renewal transition already preserves pending failures and returns to
TRIAGE after quick checks. Treating an unresolved diagnosis as a live producer
made those contracts incompatible. Clearing the pending failure, manufacturing
a financial failure or resetting the cycle would lose evidence.

The registered owning regression fails against the original implementation.
Private replay of the actual state reproduces the refusal; all original failure,
attempt, grade and financial rows remain intact. This diagnosis does not resolve
the separate realtime timeouts or establish global absence of compute sessions.

## Solution

Permit renewal with pending RCA only for completed, source-bound failures in
quick checks or the semantic stack. Revalidate the original worker recipe and
isolation root, exact typed terminal failure values, successful recorded cleanup,
unchanged source and absence of a retained producer. Bind adapter and receipt
hashes into the preservation proof, alongside its original-state and new-source
bindings. Reject unknown categories, cloud producers, financial pending failures,
duplicate identities, malformed evidence and contradictory terminal records.
Keep all original pending failures, attempts, native grades and UNKNOWN diagnoses.

The permanent regression was observed RED before applying the implementation.
Independent correction review verifies refusal of the original unsafe controls
and acceptance of the valid recipe-bound case. Financial custody validators and
zero-credit semantics remain unchanged. Required source-bound gates and actual
production verification remain separate obligations.

## Human feedback

The user requires the assigned repair through completed deployment and prohibits
new paid AgentCard actions. This correction preserves the existing no-retry
obligation and unresolved failures rather than asking to weaken those limits.

## Reusable lesson

Separate unresolved diagnosis from producer liveness. Source renewal may preserve
a complete failed result without granting a waiver, readiness or financial credit.
