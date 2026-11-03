---
id: 2026-11-03-deploy-refresh-after-completed-focused-gates
date: 2026-11-03
title: Hourly source sync could not rebind a completed focused validation phase
surface: harness
component: deploy-test-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: refresh refused the quiescent failed-gates phase after a completed focused sweep
symptoms:
  - source refresh only at the repair boundary
  - source/plan changed; refresh after RCA before running
tags:
  - deploy
  - source-refresh
  - lifecycle
sources:
  - PR #1662
  - commit 2c1acbc4ea40fbc9c8167ebb17c12df518bf32a9
  - commit b23cc68ccd2c6c08cbb50a0c909844cfacec5e6c
repro: python3 scripts/tests/deploy-test-cycle.test.py Cycle.test_failed_gate_boundary_refresh_keeps_history_and_revalidates_new_source
status: fixed
---

## Problem

After the focused native sweep completed and its only remaining compute-judge
skip was qualified, the cycle correctly advanced to `failed-gates`. A normal
hourly main sync then changed source at this quiescent boundary. The next run
refused the stale source, but the refresh command also refused this phase.
There was no supported transition that preserved the existing ledger.

## Diagnosis

The refresh phase allowlist omitted `failed-gates`. `resume` requires an
interrupted cycle, `focus` requires a focused-plan boundary, and `init` refuses
an existing state directory. A synthetic failure, reset, or manual phase edit
would bypass the recorded lifecycle rather than repair the missing transition.
The registered regression exercised the actual refresh CLI: the old command
returned2 where the legitimate source rebind required0.

## Solution

Admit `failed-gates` to the existing refresh allowlist. The unchanged exclusive
state-directory lock prevents refresh during a running coordinator. Pending
occurrences, removed gates/checks, stale source and contract changes still
refuse. The same refresh invalidates affected results and qualifications,
preserves original failures, attempts, round and repair gates, clears the old
focused plan and requires quick, focused, full failed-gate, quick and full final
validation before readiness. No result or cleanup owner receives credit.

The owning suite passes81 tests, including the fail-first CLI transition,
exclusive-lock refusal, immutable history, full later inventories, current
source bindings and atomic pending/dropped-inventory refusals. This repairs the
source-rebind command; it does not claim that the later native deployment gates
or production verification have passed.

## Human feedback

Standing instructions require hourly main synchronization at safe boundaries
and autonomous completion. No new approval was requested. The parent required
the existing supported path to be checked first, prohibited ledger resets and
invented failures, and retained the normal validation sequence.

## Reusable lesson

A coordinator that rejects stale source must also expose a safe source-rebind
transition at each legitimate completed-phase boundary. Reuse its lock and
invalidation rules instead of manufacturing a failure to reach an allowlist.
