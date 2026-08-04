---
id: 2026-07-14-global-reconcilers-cross-contaminate-concurrent-blackbox-domains
date: 2026-07-14
title: Global purchase reconcilers scanned all rows by status, so concurrent blackbox domains cross-contaminated each other
surface: back-end
component: purchase-reconcilers
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end purchase reconcilers — reconcileFailed*/reconcileStale*/reconcileDissolved*/reconcileTerminal* select by status with no owner scope
symptoms:
  - purchases.part3 blackbox flakes under domainConcurrency=4
  - Stripe refund counts differ from expectations in the purchases domain
  - test passes when run alone, fails when run alongside other domains
tags:
  - blackbox
  - test-isolation
  - purchases
  - stripe
  - concurrency
sources:
  - memory:project_agentcard_lifecycle_test_infra
repro: back-end/src/tests/blackbox/purchases.part3.blackbox.ts
status: fixed
---

## Problem

`purchases.part3` blackbox flaked when the suite ran with
`domainConcurrency=4`: expected Stripe refund counts did not match. The same
tests were green when the purchases domain ran alone.

## Diagnosis

Blackbox domains run in separate processes but share **one** Postgres database.
The purchase reconcilers — `reconcileFailed*`, `reconcileStale*`,
`reconcileDissolved*`, `reconcileTerminal*` — select rows purely by status with
no ownership filter. So a reconciler invoked by one domain's test swept up
purchase rows created by a _different_ domain running at the same moment,
performing releases/refunds the other domain did not expect and inflating its
Stripe refund counts.

The deeper owned cause: production-shaped global sweepers were being exercised
directly by tests that assume per-test row isolation, and nothing in the
reconciler API let a caller express "only my rows".

## Solution

Added an optional `PurchaseReconcileScope { userId }` parameter to the
reconcilers. Production crons keep the global, no-argument behavior; test call
sites pass `{ userId }` so each domain only reconciles its own rows. This
generalizes to any status-scan sweeper exercised from a shared-DB test suite —
scope-by-owner is the isolation seam, not test serialization.

## Human feedback

None recorded.

## Reusable lesson

When a shared-database test suite runs domains concurrently, give every
status-scanning sweeper an optional owner scope rather than assuming rows are
private to the test that created them.
