---
id: 2026-11-07-hub-pipeline-cleanup-left-abandoned-queue-rows
date: 2026-11-07
title: Hub pipeline failed-leg cleanup left queued requests for later stub pollers
surface: harness
component: benchmarks-hub-pipeline-cleanup
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cleanup deletes a dashboard but leaves its queued request in the scope shared by every leg
symptoms:
  - FAIL: retryable lease contention became a terminal failed dispatch
  - abandoned queued request remains claimable after cleanup
  - STUCK at stage "foreign artifact rejected" — no progress within 30s
tags:
  - hub-pipeline
  - cleanup
  - queue-isolation
sources:
  - PR #1716
  - commit ed47d406bb5b17de8a4c5a291878edece7c64d61
  - commit 1c0a5e56c2ddeddf20802f337aaa8bf183a86e3f
  - commit 39bcd257dc6e1d731008b46e9611ee7f1a5f1723
repro: back-end/src/tests/blackbox/benchmarks-hub-pipeline.blackbox.ts (scratch candidate only)
status: open
---

## Problem

After the original happy leg timed out, later pollers ran the wrong requests.
The happy request's retained runner log contains the failure stub's output;
the failure request contains the later capacity stub's intentional exit75.
The snapshot leg completed the foreign leg's request while waiting on its own
different ID. See the report's exact request timeline and native artifacts.

## Diagnosis

Gate: NOT_INTRODUCED for this secondary defect. Cleanup, shared scope and
oldest-first poller selection are byte-identical across prior1c0a, main39 and
candidate. The same request remains queued after cleanup in an executed local
real-service/Prisma control. Adding an assertion to the existing owning test
produces8 passes and1 failure. Cancelling only that queued request before
dashboard deletion makes the same assertion pass with all8 original checks.
This proves cascade causality, not the original first claim timeout's cause.

## Solution

Scratch-only candidate cancels the abandoned request through the existing
queued-only API before deleting its dashboard. It reuses existing ownership
semantics and adds one leg to the existing discovered blackbox domain. RED and
GREEN preserve original test deadlines and assertions. No canonical apply,
merge, deployment or full coverage outcome occurred. Golden reference: not
applicable; no prompt or production behavior is changed. The primary failure
and complete gate remain open/UNKNOWN, so no waiver or delegate is authorized.

## Human feedback

User required source/dependencies/Git refs read-only, scratch patch and
registered regression with causal RED/GREEN when indicated, and preservation
of original and failed controls. No subdelegation was allowed.

## Reusable lesson

Cancel abandoned queue entries before removing their dashboards so later test producers cannot execute another leg's work.
