---
id: 2026-10-16-unstaged-worker-claim-retained
date: 2026-10-16
title: A pre-stage token failure retained an unlaunched worker claim
surface: infra
component: cloudbench-worker-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Worker claim existed before token resolution failed but successful-return recovery required a stage and runtime that never existed
symptoms:
  - "Existing worker admission is unresolved; ownership retained"
  - "resolve_fly_token failed (exit 127)"
tags:
  - cloudbench
  - worker
  - recovery
sources:
  - PR #1525
  - fleet run 20261016-175139-10334
repro: sudo -n python3 scripts/tests/cloudbench-unstaged-worker-recovery.test.py
status: open
---

## Problem

Run 20261016-175139-10334 assigned fixed worker 86549d6aed9358, then token resolution failed in the flat script snapshot before stage_worker ran. The snapshot lacked scripts/lib; the source resolver fix is separate. The assignment and exact claim existed, but the attempt contained only an empty redirected verified file. No stage intent or worker launch occurred, and the current claim was the canonical five-field cleanup-unconfirmed successor.

## Diagnosis

A normal successful worker return requires a completed stage and runtime capture, so it cannot truthfully recover this case.

## Solution

The explicit --recover-unstaged-worker OWNER command releases only this fixed worker after the original owner and autoscaler have exited, a failed lifecycle is durable, the original assignment and rich claim digest are verified, no staging or runtime artifact exists, and the unchanged fixed-native validator accepts a fresh STOPPED pair and attached Volume.

The recovery archives the exact original bytes and fresh observations before removing the current claim under its shared per-MID mutex and the canonical recovery mutex. Its terminal receipt is RECOVERED_NOT_LAUNCHED with runtime_success false and zero task credit. It does not write a successful worker return, change the original pool proof/state, clear primary latches, release primary claims, or revise the run result.

Validation: registered owning tests exercise actual fixed-worker publication and pool validation, both claim forms, live-owner/autoscaler refusals, stage/runtime/foreign-claim/native/Volume negatives, archive-failure retention, and canonical CLI dispatch. Saved actual 19-file packet remains nonterminal and cannot authorize live recovery. Root must capture the final lifecycle and owner joins before execution.

The outer `run-bench` maintenance parser must also forward this exact flag. Its initial omission produced exit 2 before any fleet recovery; a saved full outer-CLI RED and five unchanged forwarding/argument-guard controls cover the one-line registration correction.

## Human feedback

None recorded.

## Reusable lesson

Recover a never-launched assignment from its own immutable pre-stage evidence instead of fabricating successful runtime evidence.
