---
id: 2026-10-28-cutover-retirement-waves
date: 2026-10-28
title: Old worker bank retirement omitted serving health between admitted waves
surface: infra
component: worker-pool-cutover
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: DRAINING submitted every managed old Machine after one serving-bank health check
symptoms:
  - Serving bank loses health during old-bank retirement but all eight old workers still stop
  - "remaining old workers"
tags:
  - cutover
  - retirement
  - health
  - concurrency
sources:
  - PR #1627
  - commit da889f4ecc65ce8c1ba92120d0c9301847a02467
repro: python3 scripts/tests/worker-pool-cutover.test.py WorkerPoolCutoverTests.test_serving_health_loss_between_retirement_waves_retains_remaining_bank
status: open
---

## Problem

The parallel retirement change checked new serving-bank health once, then admitted all managed old Machines. A serving failure during that batch left no later retirement decision at which remaining old capacity could be retained.

## Diagnosis

The real cutover state machine was exercised with existing isolated native/ledger fixtures. Health drops when four old workers retire. The unchanged new assertion fails on da889f4 because all eight old IDs are retired. Temporary candidate passes: only IDs100–103 retire, DRAINING remains pending, no ledger release occurs. New test AST hash6dd332116135c92ae70623ee05becfa7b0a3e4bb645cf06aa0a5701f7a998a0b matches both sides. Artifacts:/var/tmp/deploy-1627/resumed-cutover-waves-rca.

## Solution

Candidate retains eight-wide preparation and the existing joined per-Machine retirement/lease function, admitting retirement in groups of four with fresh serving-bank health before each wave. Every admitted wave joins before another starts. Per-Machine native identity, queue retirement certificate, ownership, budgets, ledger publication and final health remain unchanged. Simplification is to reuse the current joined helper per bounded slice; no new retry or recovery subsystem.

## Verification

Before owning new test exits1; after identical test exits0. Entire40-test suite passed five unchanged temporary runs, plus one socket-denied run with no network attempts. Existing prepare barrier remains8; retire barrier4 spans two waves. Existing pending/hard failure controls now share first wave and assert no second-wave stops. Full deployment and native cutover remain unverified for this candidate; keep OPEN until sole owner integrates and completes required gates. Registered via workflow-deployment-migration.test.sh in the full structural registry.

## Human feedback

Preserve native leases, ownership, all budgets and complete final gates. Use temporary candidate files while another source owner holds the frozen sweep. No integration edits or native operations in this investigation.

## Reusable lesson

Parallel retirement must retain a fresh serving-health admission boundary between bounded groups; a final health check cannot restore capacity already retired.

## Integration application

Approved correction applied after all frozen da889f4ec lanes became terminal on 2026-10-28. The prior deployment remains review-unstable with Kernel403 failure. Integrated owning repetitions and the fresh full deploy remain required; no case is closed by temporary proof.
