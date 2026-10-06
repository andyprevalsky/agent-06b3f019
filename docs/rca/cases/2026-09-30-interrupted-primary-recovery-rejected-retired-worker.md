---
id: 2026-09-30-interrupted-primary-recovery-rejected-retired-worker
date: 2026-09-30
title: Interrupted primary recovery rejected an autoscaled worker with a verified terminal capture
surface: infra
component: cloudbench-forensic-retirement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-forensic-retirement.py verify_interrupted_pool_evidence required an empty by-machine-id audit despite an exact retired worker capture
symptoms:
  - "assert not list((audit / by-machine-id).iterdir())"
  - "exact stale-owner runtime evidence is incomplete"
tags:
  - cloud-fleet
  - recovery
  - worker-evidence
sources:
  - PR #1299
  - fleet run 20260930-125939-7453
repro: scripts/tests/cloudbench-prestack-recovery.test.py
status: mitigated
---

## Problem

All ten proof73 guests acknowledged shutdown and their exact primary Machines
were stopped. Eight sealed bundles and two original interrupted captures were
preserved. Recovery then rejected the owner because the smoke task's autoscaled
worker remained in its durable audit. It had already been destroyed and its
exact terminal capture was present; no audit record was removed to bypass this.

## Diagnosis

The interrupted-primary verifier supported only never-allocated worker
attempts, while the sealed-primary verifier already validated allocated
workers using exact owner bindings, native provider inventory and the complete
terminal/log-hash capture. These are independent dimensions: a primary archive
can fail after its worker completed and was truthfully retired.

## Solution

Both paths call the same worker verifier. Interrupted primaries can retain
allocated workers only under all existing capture, root/run identity, ledger
and provider checks. Never-allocated attempts still require their exact audit
and native absence. Recovery grants zero benchmark credit. No provider state
or evidence is invented; the verification is linear in this owner's resources.

The new fixture failed before the fix at the empty-audit assertion. It passes
afterward and rejects a still-live worker, a remaining worker volume, a changed
log and a foreign primary binding. All ten offline recovery cases and 25
forensic dependency gates pass. Exact live recovery remains the final handoff
check; this is independent of benchmark acceptance.

## Human feedback

Preserve original evidence, release only exact-owned resources, and never
manufacture a successful slice to advance the ten-slice streak.

## Reusable lesson

Primary evidence completeness and worker retirement are separate contracts.
Reuse the strict worker proof instead of inferring that a failed primary had no
workers.
