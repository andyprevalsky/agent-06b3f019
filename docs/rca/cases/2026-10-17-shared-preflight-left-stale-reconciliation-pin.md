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
