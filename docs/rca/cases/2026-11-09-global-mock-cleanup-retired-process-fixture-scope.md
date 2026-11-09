---
id: 2026-11-09-global-mock-cleanup-retired-process-fixture-scope
date: 2026-11-09
title: Earlier global mock cleanup retired a later fixture's process population
surface: harness
component: scripts/tests/deploy-test-cycle.test.py
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: BackendPrismaPreflightCleanup patch.stopall retired the module-level own_process_entries patch before an unreadable-process positive control
symptoms:
  - 'local cleanup: worker root process is unverifiable'
  - isolated owning method passed but its full-suite positive control failed
tags:
  - deploy
  - cleanup
  - process-isolation
sources:
  - commit 8914dd02e1f424c0345ce70752d791f8426070a6
repro: python3 scripts/tests/deploy-test-cycle.test.py BackendPrismaPreflightCleanup InterruptedLocalRecovery.test_unrelated_unreadable_host_process_refuses_production_scan_only
status: fixed
---

## Problem

The unreadable-process fixture first correctly refused the production process
population. Its subsequent synthetic-own-scope positive reconciliation also
refused, although the method passed when run alone. The original full-suite
supervisor joined all children and retained the failure without cleanup credit.

## Diagnosis

An earlier class registered `patch.stopall`, retiring the module-level process
population patch. The negative control temporarily installed the production
population, then restored production rather than the intended synthetic scope.
The second reconciliation therefore still encountered the live nondumpable
fixture process. The actual import namespace was verified; duplicate modules,
host load and a production scanner defect were not established.

Replaying the predecessor cleanup before the unchanged owning method reproduced
the failure. Running the same replay with explicit ownership of the positive
control's process patch passed. The fixture child remained alive through that
positive control; it was not stopped to conceal the unreadable condition.

## Solution

Only the positive `self.reconcile()` is now wrapped in a method-scoped patch of
the scanner's actual `process_entries` seam to `own_process_entries`. The
production negative still uses the real production population and fails closed.
Every original assertion and timeout remains. No product scanner, permission,
quiet or process-admission guard changed. Independent review cleared the exact
hunk; original failure, causal replay and quiescent supervisor receipts remain
private deploy evidence.

## Human feedback

No new human feedback. Independent agent review covered the fixture only.

## Reusable lesson

Own a fixture's process population at the control that needs it. Do not rely on
a module-wide mock surviving another fixture's global cleanup.
