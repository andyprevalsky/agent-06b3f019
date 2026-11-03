---
id: 2026-10-29-db-runner-test-allowed-missing-shard-suffix
date: 2026-10-29
title: Database runner contract test allowed a missing coverage shard suffix
surface: harness
component: backend-db-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/local-db-container.test.sh used an optional SHARD_DB_SUFFIX in its coverage-runner assertion
symptoms:
  - "The DB contract test passed even when a temporary coverage runner lost its required shard suffix."
  - "owning regression accepted unscoped coverage shard DB name"
tags:
  - coverage
  - review-stabilization
sources:
  - PR #1627 review5702909858 comment4416297262
  - commit 385c93722ffbc4f62152ff99a166fa1321ace920
repro: bash back-end/scripts/local-db-container.test.sh
status: open
---

## Problem

The DB contract test passed even when a temporary coverage runner lost its required shard suffix.

## Diagnosis

One optional regex served two different contracts: the blackbox runner uses WORKSPACE_HINT, while the coverage runner uses WORKSPACE_HINT plus SHARD_DB_SUFFIX. Making the suffix optional let the coverage invariant regress without a failing test.

Archive searches used inherited selector/partial coverage and inbox stale
snapshot vocabulary. The October28 coverage-map-completeness case is related
but guards a different consumer; it does not cover this first bad boundary.

## Solution

Check each existing runner against its exact expected workspace hint. No production DB behavior changes. Run the unchanged owning test both on normal source and a temporary mutation removing the suffix from the coverage runner; docker and psql remain the owner test local stubs.

Before, normal and suffix-stripped copies both pass, so the mutation harness fails. After, normal passes and the suffix-stripped copy fails; this pairing passes five times. This demonstrates a fixture gap, not a reproduced production database incident.

The exact source-bound temporary candidate/report, commands and sealed logs
are under `/var/tmp/deploy-1627/review385c-runtime/`. Combined candidate SHA256:
`f1d4e045cf2c52d5a9d74fddac31ce9c7bf1b9cffedd45af912bf463c4ef18b0`.
No source application or live/full-gate passing outcome is claimed. Parent
conditional technical approval and offline proof do not replace integration
validation; this case remains OPEN until the owner completes it.

## Human feedback

Preserve full inventory, thresholds, budgets and original failure evidence;
prepare only temporary candidates while the sole source owner runs frozen
checks. Keep Freedom unchanged. Direct diagnostics remain supported and must
not masquerade as full coverage evidence.

## Reusable lesson

Give each full-gate boundary an explicit complete-inventory contract and test
its negative case at the actual owning command.
