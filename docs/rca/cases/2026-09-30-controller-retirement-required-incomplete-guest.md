---
id: 2026-09-30-controller-retirement-required-incomplete-guest
date: 2026-09-30
title: Failed controller retirement rejected an archive containing only sealed guests
surface: infra
component: cloudbench-forensic-retirement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: verify_interrupted_pool_evidence required incomplete_tasks greater than zero although the archive builder permits all sealed guests
symptoms:
  - "assert incomplete > 0"
  - "exact stale-owner runtime evidence is incomplete"
tags:
  - cloud-fleet
  - recovery
  - sealed-evidence
sources:
  - PR #1299
  - fleet run 20260930-160157-22814
repro: agents/benchmarks/cloudbench_runtime_retention_test.py
status: mitigated
---

## Problem

Proof78 was canceled after a terminal task had zero live model completions.
All ten guests acknowledged cleanup and their pool Machines were stopped.
Recovery preserved all ten sealed bundles in a 48,715,076-byte archive with zero
proof credit, then failed at `assert incomplete > 0`, retaining all ten claims.

## Diagnosis

The controller collector was interrupted, independently of guest completion.
The canonical archive builder accepted the ten sealed captures and reported
`incomplete: 0`; the verifier accepted their owner, hash and stopped-Machine
bindings before rejecting the count. Controller failure and guest completeness
are independent facts. The deepest owned defect is a disagreement between the
archive producer and consumer, not missing guest work or an evaluator failure.

Archive searches `incomplete forensic sealed` and `pool owner archive retirement
interrupted` found related evidence-retention and retired-worker cases. This is
a different rejection boundary, not recurrence of their fixed checks.

The owning production recovery function reproduced this exact assertion using
the real archive builder and ten sealed guest fixtures. Command:
`agents/venv/bin/python3 -m pytest -q agents/benchmarks/cloudbench_runtime_retention_test.py -k all_sealed`.
Before the fix: one failed, six passed in 1.15 seconds; the positive case failed
at the same verifier line. Afterward the unchanged command passed all seven
cases in 1.17 seconds. This is causal retirement proof, not benchmark credit.

## Solution

Delete the redundant requirement that a failed controller must have an
incomplete guest. Retain its failed lifecycle, zero-credit manifest, complete
task set, exact guest/worker ownership, native stop/volume bindings and archive
hash checks. No benchmark result is synthesized or reclassified.

The regression rejects a live Machine, foreign volume, foreign owner, altered
archive, nonzero credit and successful-controller lifecycle. It lives in the
runtime-retention module already invoked by the registered terminal-evidence
blackbox gate. Dedicated CPU, zero-spend admission and live-cache contract tests
are also explicitly registered in `run_all_tests`, which the recurring runner
calls; defining a function alone did not register those three gates.

Verification remains linear in this owner's archived bytes/resources with the
existing file and task bounds. It adds no runtime agent polling or shared hot
path at 10,000 agents. Exact live recovery is pending; the ten-slice acceptance
remains zero and cannot be granted by forensic retirement.

## Human feedback

Repair infrastructure only, preserve task/evaluator behavior, require three
successful live model queries per bench, and never grant an interrupted slice
credit. Continue autonomously and cement fixes in recurring tests.

## Reusable lesson

Keep controller failure and guest evidence completeness independent when
verifying exact-owner zero-credit retirement.
