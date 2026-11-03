---
id: 2026-10-27-worker-queue-child-error-capture-gap
date: 2026-10-27
title: Worker queue unit child failures lost their exit and stderr evidence
surface: back-end
component: worker-deployment-queue-unit
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: Original execFile errors at the two initial queue CLI probes are retained only as messages; internal child cause remains unproven
symptoms:
  - FAIL worker-deployment-queue.test.ts (39252ms)
  - parent idle admission, interrupted wait and actual owned child lease loss
  - parent resumes FIFO predecessors and exit75 wait without failure or duplicate completed execution
sources:
  - commit 807dedd8ff0495d9f89699d1f1ed50be2d8e46a0
  - plan:.context/worker-deployment-queue-rca-20261027/REPORT.md
  - plan:.context/deploy-fresh-20261027/backend-batch5.log
tags:
  - worker-deployment
  - child-process
  - evidence-gap
repro: none-recorded
status: open
---

## Problem

The full native unit phase recorded two queue CLI execFile errors. The retained
helper records Error.message only, losing the child exit/signal/stdout/stderr.
The first --if-idle probe and first --allow-abort predecessor probe failed;
ordinary FIFO/atomic/retirement cases and final stale-owner case passed.

## Diagnosis

The initial native CLI probe is the observed failing boundary, but its internal
cause is not retained. Both original probes use5000ms bounds. Two isolated
V8-enabled owning native executions passed10/10 with assertions unchanged;
these are not failing reproductions or repairs. The host's full concurrency
conditions were not reproduced. Historical timeout/load speculation is not a
diagnosis. Prior archive cases guided inspection but did not establish a cause.

## Solution

No fix is proposed. Retain optional source-scoped scratch diagnostics for the
next occurrence: structured child exit/error metadata and process/module/first
stdout timing, with original execution outcomes and timeouts preserved.
The report gives exact commands, hashes, limits and owned cleanup.

## Human feedback

None recorded for this failure. The unchanged acceptance and evidence requirements come from repository guidance and coordinator instructions.

## Reusable lesson

Retain structured child-process error and timing evidence before assigning a queue test failure to its runtime policy or deadline.
