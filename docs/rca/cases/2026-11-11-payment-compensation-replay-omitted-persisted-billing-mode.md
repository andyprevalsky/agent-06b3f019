---
id: 2026-11-11-payment-compensation-replay-omitted-persisted-billing-mode
date: 2026-11-11
title: Abandoned purchase compensation omitted the persisted billing mode
surface: back-end
component: purchaseFundingCompensation ensureIssuedCardIsRecorded
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The exact-key compensation mint request omitted expectedLivemode required by the v2 provider
symptoms:
  - compensation must preserve persisted purchase mode
  - FUNDING_ABANDONED persists after a terminal mint result
tags:
  - agentcard
  - compensation
  - billing-mode
  - regression
sources:
  - commit a5085083a51997a460a39fb8dd480ddacba70a52
  - plan:.context/agentcard-stability/review1-compensation-mode/manifest.json
repro: Existing assertIssuedLedgerCleanup abandoned-unissued-test command, recorded before.json and after-identical.json
status: open
---

## Problem

CodeRabbit found an unchanged call site made invalid by the stricter v2 mint contract. Abandoned purchases without a recorded card replay their original purchase key to observe the issuance outcome. That call omitted the immutable Stripe mode, so the v2 provider refuses it before reconciliation can proceed. No actual provider leak or repeated financial recovery was inferred from the review.

## Diagnosis

The actual default compensation orchestrator was run with persistence, card and Stripe boundaries injected by the existing registered issued-ledger test. The identical new case failed with expected false/actual undefined, leaving FUNDING_ABANDONED and no reversal. After the one-argument fix it reached the existing terminal-mint compensation branch and wrote FAILED with one mocked reversal. Test and live mode cases pin the original amount, purchase key and company-flow source. Archive searches for expectedLivemode compensation and abandoned funding replay found the August16 terminal-error classification case as a relative, not the same missing-request-field boundary.

## Solution

The private candidate forwards purchase.stripeLivemode as expectedLivemode. It changes no provider choice, keys, retry timing, reclaim policy or mode fallback. All25 registered issued-ledger scenarios pass with real network denied; backend TypeScript, touched-file lint and formatting pass. Independent review accepted exact patch95114af3587344302d79462afad90f8705ca52d3525e1dfe1be6328191d5956f. Final deployed-source validation remains pending; shared integration and owning checks are recorded below; no live payment, reclaim, native benchmark or production outcome is claimed.

## Human feedback

Preserve strict criteria, original failures, billing ownership and known no-remint restrictions. No new case-specific human feedback was received.

## Reusable lesson

A stricter provider input contract must be carried through recovery and compensation callers using the original persisted intent, not reconstructed from current account state.


## Shared-source validation

Applied in commit08e06669220cd78b2dc25872a92c0e8de80b160e. The actual shared default compensation/issued-ledger suite passes all27 cases, including the two adjacent fail-closed retry controls. The full v2 domain, real default last4 unit and full backend TypeScript check also pass. Receipt: `.context/agentcard-stability/review1-backend-public-20261111T044004Z-0e363f7c/receipt.json` SHA25627a97d494d8e07ed1ce2555d7c7b6349d60c6ee63634c5a63dbc60b87d4d395f. These are mocked owning boundaries, not live compensation or native E2E proof.

The case remains OPEN for the remaining deployment/native verification and final evidence-preservation scope. Original failing/private artifacts are retained; no skipped or unexecuted test is converted to PASS.
