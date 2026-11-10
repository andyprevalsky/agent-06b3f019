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

The first full candidate suite retained two failures from the old quick/final expectations. All 421 tests in the existing owning suite pass after the legal phase expectations are updated. Independent review then reproduced a repeat-call defect: comparing the immutable refusal source to the mutable renewed validation source rejects an identical successful command. The same owning regression now repeats both selectors in quick/final and fails before the correction, then passes after removing that mutable comparison. Exact refusal identity and strict native authority still revalidate. Full-suite confirmation, follow-up review, canonical renewal on frozen source, fresh native chat/full publisher and deployment remain pending. Raw artifacts stay private. No state reset, hand-edited cycle, invented native execution or provider action is a workaround.

## Human feedback

The user requires a completed deployment on repaired source while preserving original missing-capture outcomes, historical custody and strict source-bound publication. A NOT_INTRODUCED label does not release an assigned blocker.

## Reusable lesson

A normal refresh must expose a safe renewal boundary. Preserve prelaunch refusals as failed coverage while distinguishing them narrowly from actual native execution for launch-only authority.

## Strict normal retirement after a newer successful cohort

A later source refresh exposed a different admission gap. The latest full native cohort legitimately executes twelve eligible cases and preserves one historical financial case as SKIP with false execution completeness. Isolated successor renewal refuses its all-thirteen-complete requirement. That refusal remains correct; historical custody never becomes execution credit.

The original operation now independently satisfies the unchanged normal cleanup validator: fifteen participants and 303 authentic file bindings, versus the isolated proof's 230. Public reconciliation nevertheless selected only the latest incomplete operation, refusing both original selectors after a newer complete result. Exact same-suite public-command assertions reproduce both refusals before the repair.

The correction admits a separate normal campaign proof only for the unique already reconciled original at the existing quiescent repair boundary. It authenticates the original receipt, selector, source, owner, current checkout and every prior proof binding, then runs unchanged normal validation. The entire prior isolated entry moves to sealed history; the active normal record grants zero test credit. Admission and completion continue rechecking the archived original, including five original-only bindings. Exact replay is idempotent; changed replay or missing, duplicated or altered origin evidence refuses atomically. Latest receipts, original native failures, cleanup flags, financial custody and all clocks stay untouched. Normal retained-Hub custody remains distinct from separately verified current process retirement.

The new unchanged owning regression fails before the source fix and passes afterward. Full suite, independent review, canonical frozen-source retirement, fresh full native acceptance and deployment are tracked separately; this local result is not completed deployment proof.

Independent adversarial review found two candidate defects before freeze: saved completion/verification selected only active isolation, and the new early-return transition missed an unsealed conflicting token entry. Existing owning controls reproduce seven failures before correction. The repair now selects obligations from active entries and archived isolated origins at launch, saved verification and completion; only active isolation retains the later full-coverage restriction. Global token/key uniqueness remains mandatory at retirement and subsequent admission. Saved-verification controls bind a legal disposable plan and establish a clean baseline before corrupting the actual archived origin. Earlier candidate suite PASS and interrupted stability results do not validate these later bytes; final full-suite, five consecutive loaded runs and follow-up review are separate evidence.
