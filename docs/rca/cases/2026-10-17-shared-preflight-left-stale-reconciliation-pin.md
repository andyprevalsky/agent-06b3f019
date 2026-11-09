---
id: 2026-10-17-shared-preflight-left-stale-reconciliation-pin
date: 2026-10-17
title: Shared preflight changed cleanup tickets but left its reconciliation pin stale
surface: infra
component: cloudbench-shared-preflight
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the reconciliation helper checks the previous cleanup-ticket source hash before loading the updated parent-preflight protocol
symptoms:
  - cleanup reconciliation dependency source changed
  - startup cohort canceled all 600 jobs with zero ready workers
tags:
  - cloudbench
  - startup
  - dependency-pins
sources:
  - commit 49b792dcc2ea983325c6a25801da6c982f29c206
  - fleet run original600-1792271666901142356
repro: python3 scripts/tests/cloudbench-cohort-reconcile.test.py
status: open
---

## Problem

Original74 reached a live controller and completed the new bulk metadata transfer. Its campaign parent then aborted before spawning the requested worker cohort. All 600 logical jobs were canceled, with zero ready workers and zero task attempts. The controller and supervisor subsequently joined and canonical cleanup verified controller deletion and workspace pending destruction.

## Diagnosis

The retained parent-failure packet is SHA256 3e92e30f678f49aa77612fdb2d408aa3a0d6fc5f60040f1bc672852241b6321f. Its infrastructure-canary log contains the exact exception at cloudbench-cohort-reconcile.py line41. The helper still requires cleanup-ticket source hash 9427517b23cb47abc5c6bcc1e45ef88a615a895c822d8e73818ae6059755f360, while the published shared-preflight change contains 24297e82a6a2188c479a70440628d015eb2e4e4378473be89b352203da7ba540.

The guard correctly rejected a protocol version it had not authorized. Packaging the shared-preflight change without updating this dependent pin was our integration error. Earlier campaign controls exercised the new parent flow, but did not exercise this real downstream reconciliation load boundary with the changed source. The failure does not establish a 600-worker concurrency or provider-capacity failure; worker execution never began.

## Solution

Retain the exact dependency guard and update it to the reviewed cleanup-ticket bytes. Exercise the real reconciliation helper through its owning fixture with the current ticket source, including the parent-canary handoff where applicable. The previous source must fail at the observed pin boundary, the corrected source must reach the intended reconciliation behavior, and unreviewed dependency bytes must remain rejected. Audit only direct pins for the changed shared-preflight files; do not replace hash checks with permissive matching.

The original failed run, source, clock, logs, cancellation counts and cleanup receipts remain unchanged. A corrected source needs a new normal run after its focused controls and source review pass.

## Human feedback

The user asked to simplify startup and explain repeated failures to reach full parallel execution. The bulk path completed, and the next failure was isolated to a shared prerequisite before worker launch. Preserve the requested task count and timing limits while testing the actual integration boundary.

## Reusable lesson

When a source-pinned dependency changes, verify its direct consumers with the real new bytes. A parent-flow fixture that substitutes the downstream helper cannot certify the helper's protocol pin.


## 2026-11-08 recurrence: changed cleanup-ticket dependency, unchanged caller pin

Status: owning regression fixed; normal combined-source validation and cloud retry remain pending.

The Google400 experiment16 stopped before task clone admission. The immutable controller reported `cleanup reconciliation dependency source changed`: `cloudbench-cohort-reconcile.py` still authenticated the baseline module SHA256 `29c2f6e4c71bf45a182f2beb59298e63f7a82e1e0bddd3956ac7d603a823c81b`, while this branch's cleanup-ticket module was `b67ac4790306e542a06b2ad607d88b9582c8173f2eecc37cdcffc3df991b4734`. The changed module adds conservative accounting for positively absent standalone legacy owners. Its direct caller's pin was not updated. This integration failure is INTRODUCED relative to bf26; the guard correctly failed closed.

The actual checked-in sibling pair reproduces the failure under the existing isolated reconciliation fixture. The identical new owning method passes after changing only the caller's static pin to the reviewed dependency. All eight owning tests pass, including the existing tamper rejection, and their supervisors are quiescent without orphan or supervisor TERM/KILL. No provider call is permitted by that fixture. The suite existed in the conditional test runner but was absent from the normal structural registry; it is now registered there. Run `python3 scripts/tests/cloudbench-cohort-reconcile.test.py` through the normal supervisor to exercise the registered owner. No dynamic self-trust, assertion, timeout or concurrency relaxation was introduced, and historical source maps are unchanged.

Original experiment16 outcomes remain nine UNVERIFIED cases, one failed controller and eight cancelled controllers, plus the five separately authorized financial SKIPs. The PG15 seed and exact native snapshot completed before this later guard failed. Nine sealed zero-allocation audits qualified supported preallocation reconciliation for launch only; two exact-owner Hub records remain preserved and their original PIDs are absent. This grants no task, financial-release or production acceptance credit. Warm-source refresh and snapshot creation were real provider operations; this was not a globally mutation-free run.

Evidence: source11fac9a37942fb472e1ef146f7099d0a6e563ba3, native campaign fd095281f30cbb4d7669ca8c9cdeef51dd31791563a1c587606b319112a438b0, owning `CohortReconciliation.test_actual_checked_in_dependency_pair_reaches_reconciliation`, and the retained native result/process records. Agent RCA and parent review identified the missing dependency coupling and registry entry. There was no incident-specific human feedback about this pin; the user's separate financial skip does not waive this failure.
