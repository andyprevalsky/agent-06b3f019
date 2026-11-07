---
id: 2026-11-07-worker-evidence-capture-lost-a-passing-run-to-one-failed-transport-read
date: 2026-11-07
title: A scaled-down autoscaler worker lost its runtime evidence to one failed flyctl transport read and failed an otherwise passing mass-agent smoke member
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: cloudbench_capture_worker_runtime_evidence in scripts/run-bench-fleet ran `fly ssh console` and `fly ssh sftp get` exactly once; a transient `Post https://api.fly.io/graphql: EOF` made it report the evidence as lost, and the worker was destroyed right after
symptoms:
  - "worker 85d32da42dd168 runtime evidence was not preserved"
  - "mandatory autoscaler failed during the run: worker 85d32da42dd168 could not be destroyed during scale-down"
  - test-mass-agent-run-0 REAL PASS in the fleet summary but controller exit 1, which left all 9 smoke cases UNVERIFIED and an unreconcilable receipt
tags:
  - cloudbench
  - autoscaler
  - runtime-evidence
  - smoke
sources:
  - PR #1744
repro: scripts/tests/cloudbench-env.test.sh runs the extracted capture function against a stubbed provider (transport recovering on the third read passes, an unreachable worker fails closed after four reads, a verification failure is not retried); red on the old function, green on the new one. The provider error itself was recorded in capture.log of the failed run.
status: fixed
---

## Problem

In the second staged smoke on this branch, eight members passed and recorded evidence, and test-mass-agent-run-0 passed its task. Its
controller still exited 1 because the autoscaler's scale-down of a freshly created worker could not preserve that worker's runtime
evidence, which the fleet treats as a failed run even though the worker is destroyed anyway under disposable reap. The same symptom
was recorded on the PR #1693 deploy. Gate: NOT_INTRODUCED for the changed product code.

## Diagnosis

The run's capture.log shows the first read failing with a Fly GraphQL EOF while building the ssh tunnel and a later pass finding the
machine already destroyed. The capture helper made one attempt, so a seconds-long API error was enough to lose the evidence of a
healthy run. The run.json of a completed mass-agent run is also over the cycle's 64 MB proof limit, so the failure cannot be reconciled
afterwards.

## Solution

The capture transport (console command and archive download) is attempted up to four times with 10, 20 and 30 s pauses before the
evidence is declared lost; a verification failure is a verdict on the bytes and is not retried, and an unreachable worker still fails
closed. A stubbed-provider regression covers all three outcomes.

## Human feedback

None; found by the staged deploy cycle of PR #1744.

## Reusable lesson

Any step that must read from a machine before it is destroyed needs a bounded transport retry, because the destroy makes the loss
permanent.
