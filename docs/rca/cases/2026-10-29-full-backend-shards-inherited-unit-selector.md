---
id: 2026-10-29-full-backend-shards-inherited-unit-selector
date: 2026-10-29
title: Full backend coverage shards inherited a failed-only unit selector
surface: harness
component: backend-coverage
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/run-coverage-sharded.sh inherited BACKEND_UNIT_TEST_FILES at each full-shard launch
symptoms:
  - "Full merged coverage could omit unit files selected out by an inherited failed-only list."
  - "full shards inherited the failed-only unit selector"
tags:
  - coverage
  - review-stabilization
sources:
  - PR #1627 review5702909858 comment4416297279
  - commit 385c93722ffbc4f62152ff99a166fa1321ace920
repro: bash scripts/tests/backend-coverage-sharded.test.sh
status: open
---

## Problem

Full merged coverage could omit unit files selected out by an inherited failed-only list.

## Diagnosis

The unit runner filters by BACKEND_UNIT_TEST_FILES before dividing into shards. Shard completion returns raw coverage to the coordinator, bypassing the ordinary partial-run exit guard. Thus successful shard and threshold results did not prove the full inventory executed.

Archive searches used inherited selector/partial coverage and inbox stale
snapshot vocabulary. The October28 coverage-map-completeness case is related
but guards a different consumer; it does not cover this first bad boundary.

## Solution

Unset BACKEND_UNIT_TEST_FILES only in the full coordinator child environment. Keep direct diagnostic and failed-only unit selection unchanged. The existing shard owner test now exports a stale selector and asserts it is absent in both real coordinator child environments; all original failure/abort/merge checks remain.

The unchanged new owning control fails before with full shards inherited the failed-only unit selector. The entire owning shell suite passes five times after using fake shards and local fake-domain Node processes.

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
