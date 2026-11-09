---
id: 2026-11-09-prepared-replacement-liveness-custody
date: 2026-11-09
title: Liveness sealed durable replacement intent before execution acceptance
surface: back-end
component: workflow-liveness-reconciler
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: workflowLivenessReconciler reconcileWorkflowLiveness/sealAgent interpreted NOT_FOUND for a reserved replacement as execution death
symptoms:
  - candidate_bootstrap_durable_ready
  - became stale before start acceptance and was terminated
  - cold_workflow_uses_no_resources_while_waiting
  - fresh_history_has_no_patch_or_nondeterminism
tags:
  - temporal
  - liveness
  - replacement
sources:
  - PR #1859
  - commit 4e28dab648a66e70f513979cb11b59e614866424
  - commit 8be5624557a91278114ee7e523c2381e4aad61b5
  - task production-workflow-migration run ebd845cc-1a9e-4d9f-aa73-c5fd14870e03
repro: back-end/src/tests/blackbox/agents-liveness-reconcile.cases.ts
status: open
---

## Problem

Original production validation retained 42 PASS / 3 FAIL of 45, including fixture_cleanup PASS, on its original 2026-11-09T01:17:31Z–02:05:42Z clock. The bootstrap failure prevented pausedHandle assignment; the two subsequent assertions were cascades. Private native logs and findings were copied with SHA256 hashes before editing on a separate Bugs devbox.

## Diagnosis

Path: durable replacement claim and snapshot → quiet candidate discovery → Temporal describe NOT_FOUND → terminal DB CAS → later native start → stale acceptance cleanup. Retained Render evidence at 01:23:07.464Z identifies the exact reserved generation sealed from STARTING_UP. Actual start began at 02:03:33.911Z; the worker read FAILED and bootstrap acknowledgement returned 409. startAndReady resets its deadline to Date.now()+120000, so the cause is custody rather than the original deadline.

Gate: NOT_INTRODUCED relative to PR1859 and baseline above, based on retained source-object equality and real-function replay on both revisions. This repair remains assigned. Searches for the raw stale-acceptance error and prepared replacement/liveness/STARTING_UP/NOT_FOUND found related liveness and chain-ownership cases, without this precise prepared-intent boundary. This is a relative, not an established recurrence.

A real isolated Postgres/backend owning-suite run (`ROSE_USE_SYSTEM_PG=true bash back-end/scripts/run-blackbox-tests.sh agents`) failed before the production edit: 328 passed, 2 failed, 330 total. Both new failures were the expected prepared NOT_FOUND preservation and concurrent exact start acceptance assertions. The same cases passed after the fix. The final expanded owning suite passed 334/334 in72.235 seconds; chain and claim CAS regressions each failed independently on original source and passed unchanged after the fix. Native pending-start caller suite passed12/12. Original production acceptance remains pending. The focused driver imports these exact checked-in cases and real production functions, using local DB and simulated Temporal descriptions. This causal proof does not substitute for production acceptance.

Problem class: durable intent and execution were conflated by an observer that did not participate in custody. Deeper boundary: persisted identity/acceptance distinguishes those phases already; no new lifecycle or timer is needed. No LLM call is implicated. The validator is synthetic and has no root-agent bug report.

## Solution

Retain exact planned token ownership on NOT_FOUND until the first execution receipt exists. Continue sealing real closed executions, including failed/terminated pre-bootstrap workflows and accepted chains that disappear. Fence the final existing locked terminal CAS with the observed first-run receipt and claim token, preserving native admission-journal checks. No snapshot refresh, deadline change, new execution credit, cleanup waiver or assertion weakening.

Unify liveness with existing durable custody rather than adding another lease or start journal. The query also uses a process-local constant-memory tuple-keyset cursor with a fixed quiet cutoff per sweep. Each tick reads one existing-size page; protected, running and inconclusive rows cannot indefinitely occupy the first batch. A new fairness regression failed before this correction and passed in the full suite. Batch, concurrency, quiet threshold, timers and snapshots are unchanged. At10k agents traversal remains bounded per tick, with no per-agent shared hot-path contention; restarts begin a new sweep. Independent RCA review confirmed the mechanism; approval-boundary golden review is GROUNDED for production diff SHA256 8f9e21cf1e3d54d4a9a411f09f49dad703f564009bcb2c153802cdbd23946eda by reviewer ph715w8nj8zfddv6h4cbm4cav58hwezf (Codex identity fencing and keyset traversal, OpenClaw token restoration, Kimi matching-request cleanup). Production outcomes will be recorded only after source-bound validation. Automatic resumption of every abandoned prepared claim is not established: this remains a recovery gap, not authority for liveness to cancel durable intent.

## Human feedback

The user requires unchanged original production assertions and native outcomes/clocks, no timeout or quiet-threshold increases, exact generation/chain ownership, preserved no-loss snapshots and pending-start protections, separate Bugs placement, and full deploy/production/cleanup/scorecard completion. An in-memory replay alone is insufficient.

## Reusable lesson

Distinguish durable planned intent from an accepted execution before treating absence as death, and fence delayed terminal writes to the immutable ownership observed.
