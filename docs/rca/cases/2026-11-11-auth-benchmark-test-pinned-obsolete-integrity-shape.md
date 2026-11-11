---
id: 2026-11-11-auth-benchmark-test-pinned-obsolete-integrity-shape
date: 2026-11-11
title: Hosted auth catalog regression rejected the strengthened payment integrity shape
surface: agents
component: auth_test_site_benchmark daily catalog contract
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The catalog test compared integrity to exactly three fields after the task contract added provider inventory fields
symptoms:
  - AssertionError browser-auth-guest-purchase
  - daily_catalog_covers_every_hosted_auth_branch_with_natural_prompts
tags:
  - benchmark
  - auth
  - fixture-contract
  - provider-inventory
sources:
  - commit a5085083a51997a460a39fb8dd480ddacba70a52
  - plan:.context/agentcard-stability/review1-benchmark-fixture-contracts/manifest.json
repro: Recorded auth-canonical-defaults-before.json and auth-identical-after.json command
status: open
---

## Problem

The real a508 agents coverage gate returned130 passed and2 failed domains. One failure was the hosted-auth catalog assertion, not an executed browser task. The task contracts correctly require local purchase/funding/card counts plus provider card/transfer counts and zero unlinked transfers. The test still expected an exact three-key dictionary.

## Diagnosis

The unchanged focused assertion failed locally with canonical test environment defaults on browser-auth-guest-purchase. The task catalog bytes were unchanged. Updating only the expected dictionary to all six exact fields makes the identical command pass, and the full existing auth-test-site-benchmark domain passes in8.398 seconds. Initial private missing-config and overstrict bytes-host network-guard setup failures were retained as uncredited setup errors. Archive searches for auth benchmark integrity/provider card counts and catalog dictionary inventory drift found no same-boundary case.

## Solution

The private candidate keeps purchaseCount1, walletFundingCount1 and cardCount1, and also asserts provider cardCount1, provider transferCount1 and unlinkedTransferCount0. It does not use a subset comparison or relax the production evaluator, catalog, prompt, timeout or concurrency. Independent review accepted fixture patchaf17e40fccab1dccdb2cfa20c8527c73758763d683c59c421f560a84d4db217a. Integration and full agents coverage on final source remain pending.

## Human feedback

Preserve strict criteria, original failures, billing ownership and known no-remint restrictions. No new case-specific human feedback was received.

## Reusable lesson

When a runtime contract is strengthened, update the owning test to assert the whole stronger contract rather than dropping the new invariants.

