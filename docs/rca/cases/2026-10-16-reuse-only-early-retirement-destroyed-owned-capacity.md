---
id: 2026-10-16-reuse-only-early-retirement-destroyed-owned-capacity
date: 2026-10-16
title: Reuse-only early retirement and fresh worker cleanup still destroyed owned capacity
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: early primary retirement and fresh worker cleanup entered destructive reaping before the final reusable-primary handoff
symptoms:
  - "worker could not be destroyed during scale-down"
  - "reuse-only retains Machine and Volume identity"
tags:
  - cloudbench
  - teardown
  - reuse-only
  - workers
sources:
  - PR #1525
repro: python3 scripts/tests/cloudbench-bootstrap-recovery.test.py ReuseOnlyRetirementTests BillingStopRetainTests
status: fixed
---

## Problem

The final healthy-primary pool handoff did not cover early sealed-primary
retirement, fresh worker scale-down, or residual fresh registry reaping.
Those paths still called Machine/Volume destruction even in reuse-only mode.
Borrowed workers already had an independent verified stop-and-return path.

## Diagnosis

Three identical owning branch cases against unchanged `2bb9f9e8b` produce four
assertion failures: fresh worker cleanup destroys/releases ownership, failed
capture skips physical stop, and early primary retirement reaps the allocation.
A final-callsite-only change cannot fix these earlier lifecycle boundaries.
Historical worker export requires a dead original owner and cannot be repurposed
as a live current-owner return.

## Solution

In reuse-only mode, early primary retirement and fresh worker cleanup call one
current-owned stop-and-retain entrypoint. It validates the live owner birth and
actual caller ancestry, canonical task/source provenance, the exact primary or
worker runtime owner, registry/audit MID/Volume, and current task token. It reuses
`_billing_stop_one` for the existing locks, once-only intent, exact native/config
pin, bounded guest quiescence, STOP request, observed STOPPED and immutable
ownership checks. Source bindings are rechecked throughout. No new stop loop or
provider client is introduced.

The worker path retains failure/latches when capture fails even if physical
STOP succeeds. A successful stop removes the worker only from active scheduling;
its registry, audit, runtime owner, data and Volume remain. Final collection
closes remaining active fresh workers through the same cleanup. Borrowed worker
return is unchanged. The common Machine-destroy boundary refuses reuse-only
requests, protecting paths that do not yet have a reusable handoff.

The new private stop receipt records current role/owner/task token, exact native
instance/config and source/native hashes, `stopped_only=true` and `pool_credit=0`.
It grants no historical worker identity or pool admission. Residual owned workers
remain recoverable until a separate explicit current-worker admission succeeds.
A failed stop never falls back to delete. Final cleanup explicitly refuses to
enter the registry reaper when reuse-only records remain, including native
delete routes that bypass the common Machine helper. Non-reuse legacy behavior
is retained.

Fresh worker cloning overrides the command to `sleep infinity` but does not
explicitly clear inherited environment. The worker role therefore accepts only
the exact inert command with either empty environment or source REF, task run
token and current caller barrier credential that match the validated parent
task. The full native configuration remains pinned. Two additional causal
controls reproduce the final-reaper and inherited-environment refusals before
these follow-up corrections.

## Verification

Thirteen new registered controls passed five unchanged final runs; the complete
32-case affected billing/retirement family also passed. Tests execute the actual
branch blocks and canonical stop core with only isolated provider/process seams.
They cover positive primary/worker stop, foreign worker identities, unknown live
processes, source drift, once-only dispatch, real ancestry, borrowed return,
failed evidence/STOP retention, early primary deferral and the deletion fence.
Shell syntax and diff checks passed. No native/provider operations were run.

## Human feedback

The user requires preserving Machine IDs, Volumes, data, claims, latches,
protected warm capacity and Freedom while stopping unused compute and querying
until actual STOPPED, including failure/cancellation and autoscaler cleanup.

## Reusable lesson

A reusable final teardown is insufficient if scale-down or early retirement can
still delete the same resources. Fence destructive boundaries and preserve exact
ownership through every earlier lifecycle path; admit reuse separately.
