---
id: 2026-11-10-isolated-renewal-rejected-normal-source-refresh
date: 2026-11-10
title: Isolated cleanup renewal rejected a normal source-refresh boundary
surface: harness
component: staged-deploy-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: renewal dispatch excluded quiescent quick and final boundaries produced by normal refresh
symptoms:
  - "native cleanup: next source/inventory binding"
  - "native cleanup: failed successor execution"
tags:
  - deploy
  - cleanup
  - custody
sources:
  - PR #1905
  - commit 510c9c2a3545df270a7d1e24619b67e0a00e8785
repro: python3 scripts/tests/deploy-test-cycle.test.py
status: open
---

## Problem

After a required main synchronization, normal source refresh reached quick then final. The original isolated-operation proof could renew only at repair phases. Its valid original request token fell through to interrupted-operation reconciliation. The subsequent native smoke launch refused before creating a request or starting its adapter. All thirteen cases stayed UNVERIFIED; this was not thirteen executed task failures.

## Diagnosis

Read-only reproduction on authenticated state and the original 230-file proof established the phase-policy mismatch. The latest complete twelve-task successor and cleanup remained authentic. The newer exact six-field coordinator refusal then hid that successor from renewal. Source 8b and 510 shared this narrow defect: Gate: NOT_INTRODUCED for that comparison. The assigned deployment still owns the repair. A separate original-occurrence path could overwrite an existing isolated registration without successor validation; a permanent negative control proves that bypass and its correction.

This is related to the historical selection-metadata renewal case, but current and latest native successor gate contracts match. No historical contract witness or source rollback is needed.

## Solution

Identify an existing isolated original operation before interrupted/initial registration. Route changed proof/source or original-token renewal through the same strict renewal validator. Permit quick and final only with ready=false, no running worker, absence of live_failures and clear cancellation.

Only renewal may inspect the immediate complete executed predecessor of the exact known six-field source-binding refusal emitted before native request creation. Require exact reason, status, complete flag, all-current-check UNVERIFIED inventory, typed source equal to its attempt, supported terminal attempt phase and no interruption/staleness. Never skip repeated refusals, unknown setup failures or a newer native attempt. Keep the refusal as the latest coverage result.

Retain every original proof, receipt, request, native result, ownership, environment, contract, evidence hash, cleanup, chronology and exclusion check. Only validation_source may change in the original proof. Preserve false cleanup and credit flags, historical financial custody, original task grades and clocks. Renewal grants future launch authority only.

## Verification and limits

Three added regressions in the existing owning suite fail against the authenticated source510 module (two errors and one failure), with identical test assertions. They pass on the correction: normal READY refresh through quick/final; exact unexecuted refusal with strict negative controls; original-occurrence bypass rejection. Old phase negatives are changed to quiescent positives because those are the legitimate refresh boundaries being repaired. Active workers, live_failures presence, ready, cancellation, unsupported phases and all native tamper guards still reject atomically. No task assertion or native publisher check is relaxed.

The first full candidate suite retained two failures from the old quick/final expectations. All 421 tests in the existing owning suite pass after the legal phase expectations are updated. Independent adversarial review, canonical renewal on frozen source, fresh native chat/full publisher and deployment remain pending. Raw artifacts stay private. No state reset, hand-edited cycle, invented native execution or provider action is a workaround.

## Human feedback

The user requires a completed deployment on repaired source while preserving original missing-capture outcomes, historical custody and strict source-bound publication. A NOT_INTRODUCED label does not release an assigned blocker.

## Reusable lesson

A normal refresh must expose a safe renewal boundary. Preserve prelaunch refusals as failed coverage while distinguishing them narrowly from actual native execution for launch-only authority.
