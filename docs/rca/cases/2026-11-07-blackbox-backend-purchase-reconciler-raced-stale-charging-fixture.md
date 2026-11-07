---
id: 2026-11-07-blackbox-backend-purchase-reconciler-raced-stale-charging-fixture
date: 2026-11-07
title: The blackbox backend's minute purchase reconciler compensated a purchases test's stale CHARGING fixture mid-assertion
surface: back-end
component: back-end/scripts/blackbox-auto-rca-env.sh (isolated blackbox backend environment)
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "back-end/scripts/blackbox-auto-rca-env.sh — the isolated test backend kept the unscoped minute 'reconcile purchase holds' cron enabled against the database the in-process purchase blackboxes write stale CHARGING fixtures to"
symptoms:
  - "FAIL request recovery leaves an interrupted issued card to the cron compensator"
  - "Transferred interrupted issued card to funding compensation"
  - "purchase_funding_abandoned_reconciliation"
tags:
  - backend
  - purchases
  - cron
  - blackbox
  - race
sources:
  - PR #1749 staged deploy final phase on d12d9a9ba, gate backend-coverage-blackbox (purchases.part5 11/12; server-shard2.log cron tick 09:44:00.743)
repro: bash scripts/run-blackbox-tests.sh purchases.part5 (with the case straddling a minute boundary, or the cron's unscoped sweep invoked between fixture setup and the mint)
status: fixed
---

## Problem

PR #1749's final sweep failed `backend-coverage-blackbox` on one case,
"request recovery leaves an interrupted issued card to the cron compensator"
(`purchases.part5`, 11/12). The assertion that failed had no message. The PR
changes no purchases code, and earlier sweeps passed this domain.

## Diagnosis

The coverage gate's own backend server runs the "reconcile purchase holds" cron
every minute against the same database the purchases blackboxes use. It is off
only when `DISABLE_PURCHASE_HOLD_RECONCILE=1` is set, and neither launcher set it.
`reconcileStaleChargingPurchases()` is not scoped to a user.

`server-shard2.log` shows a cron tick at 09:44:00.743. At 09:44:00.756 it logs
"Transferred interrupted issued card to funding compensation" for card
`card_stale_893c5a42…`, the test's fixture, within the same millisecond as the
test's lookup. The row was already FUNDING_ABANDONED, so the mint returned 409
with `purchase_funding_abandoned_reconciliation` instead of
`purchase_funding_reconciliation_in_progress`.

Reproduced twice. Invoking the unscoped sweep between fixture setup and the mint
failed the same way. A local backend with the cron on, with the case straddling a
minute boundary, also failed the same way. Unaligned, the window is about 13 ms
per minute.

## Solution

`back-end/scripts/blackbox-auto-rca-env.sh`, which both launchers load before
the backend boots, exports `DISABLE_PURCHASE_HOLD_RECONCILE=1`. This follows the
existing rule that contract-test backends do not run unrelated background jobs.
Tests still call each reconciler directly with a user scope. The existing
`coverage-script.test.ts` check, which requires each variable to be exported
exactly once, now includes it. Assertions and timeouts are unchanged. With the
fix, the boundary repro passes, and `purchases.part5` passed five consecutive
runs.

## Human feedback

None: found and fixed inside PR #1749's deploy.

## Reusable lesson

A shared test backend must not run unscoped background sweeps over tables that
in-process tests seed with fixtures.
