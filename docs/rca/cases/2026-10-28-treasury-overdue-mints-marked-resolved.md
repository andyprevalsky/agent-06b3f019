---
id: 2026-10-28-treasury-overdue-mints-marked-resolved
title: Treasury deferred mint checks forgot unreclaimed obligations after one failing run
date: 2026-10-28
surface: back-end
component: treasury-rails
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: checkPendingUnusedMints wrote resolved events without settlement evidence
symptoms:
  - Overdue mints disappear from subsequent checks without reclaim proof
  - "a lost mint fails one run, not every run after it"
tags:
  - treasury
  - reclaim
  - ledger
sources:
  - PR #1634
repro: npx tsx src/tests/blackbox/treasury-rails-pending-mints.blackbox.ts
status: fixed
---

## Problem

The treasury live gate reported missing reclaim proof for three old $13 mints.
The append-only ledger nevertheless recorded those failures as resolved. A later
run would omit them, allowing the gate to pass without proving the funds returned.
Five earlier mints had the same historical non-settlement records.

## Diagnosis

`checkPendingUnusedMints` appended a `resolved` event for every verdict except
`waiting`. `readOpenPendingMints` removed entries for all such events, including
`overdue`, `failed`, and `unobservable`. The provider had not supplied settlement
proof. The first incorrect boundary was converting an observation into closure
of the obligation.

The unchanged strengthened regression command is:
`cd back-end && npx tsx src/tests/blackbox/treasury-rails-pending-mints.blackbox.ts`.
Before the fix it failed: expected `card_lost` to remain overdue on the next
check; actual checks were empty. After the fix it passed, also checking that
historical non-settlement receipts remain open and a later actual full reclaim
closes the obligation. Logs are retained at
`/var/tmp/rose-treasury-ledger-before.log` and
`/var/tmp/rose-treasury-ledger-after.log` on the investigating machine.

## Solution

Only a `settled` verdict closes the pending obligation. Historical non-settlement
receipts remain intact but no longer suppress rechecking their original entries.
An unobservable reclaim fails the live gate rather than issuing a warning and
silently passing. No ledger lines or provider funds were deleted or modified.

## Validation and remaining issue

The ledger regression passes. This fixes false-green reporting; it does not prove
that the original funds have been reclaimed. Provider reconciliation remains a
separate live release gate, and no threshold or deadline was loosened.

## Archive search

Searched `pingproxy unexpected status 403` and
`proxy duplicates cache concurrent treasury mint unresolved`. Existing cases
were leads only; the local ledger regression established this defect.

## Human feedback

User requested fixing all remaining issues and including them in the deployment PR.

## Reusable lesson

A failed observation is not proof that a financial obligation has settled. Keep
unresolved obligations visible across runs and accept only identity-matched reclaim proof.
