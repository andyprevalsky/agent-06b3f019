---
id: 2026-09-04-purchase-clear-raced-wallet-reclaim
date: 2026-09-04
title: Purchase clearing raced wallet reclaim across two database rows
surface: back-end
component: purchase-wallet-funding
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/domains/purchases/repo.ts:markHeldPurchaseClearedIfNoReclaim
symptoms:
  - purchase can be CLEARED while wallet funding is RECLAIMING
  - failed reclaim can coexist with merchant-cleared purchase state
  - relation check and funding claim each pass from different snapshots
tags:
  - purchase
  - wallet-funding
  - reclaim
  - advisory-lock
  - race
sources:
  - PR #1261
repro: back-end/src/tests/unit/purchase-wallet-funding.test.ts purchase clearing/reclaim serialization cases
status: fixed
---

## Problem

Purchase clearing checked the related funding row while updating
`PurchaseSpend`; reclaim independently compared-and-set `PurchaseWalletFunding`.
Each statement was atomic only on its own row, so both could pass and commit an
impossible `CLEARED` plus `RECLAIMING` or `RECLAIM_FAILED` combination.

## Diagnosis

Archive search found the related closed-card reclaim incident but not this
cross-row interleaving. The deepest cause was treating two individually atomic
statements as one state transition without a shared serialization owner.

## Solution

Both transitions now acquire the same transaction-scoped advisory lock keyed by
purchase ID. The reclaim CAS also rejects an already-cleared purchase, so either
ordering has a reciprocal guard. Deterministic database tests hold the shared
lock to force each ordering and assert that no impossible state commits.

## Human feedback

The user required every review-discovered correctness gap to be cemented before deployment.

## Reusable lesson

When one invariant spans rows, serialize every competing transition on one shared key and keep reciprocal state predicates as defense in depth.
