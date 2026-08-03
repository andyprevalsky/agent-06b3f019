---
id: 2026-07-13-killed-run-cannot-return-pool-claim-leaving-machines-orphaned
date: 2026-07-13
title: A killed fleet run could not return its pool claim, so machines stayed `started` and the next run reported an empty pool
surface: harness
component: cloudbench-fleet
classification: our-bug
problem_class: other
first_bad_boundary: pool claim ledger — a claim is released only by the claiming run's normal exit, so a killed run leaks it
symptoms:
  - "pool empty" at fleet start despite provisioned machines existing
  - machines left in Fly state 'started' with no owning run
  - next run falls back to a fresh clone and pays the ~400s volume fork
tags:
  - cloudbench-fleet
  - resource-leak
  - claim-ledger
  - fly-io
sources:
  - memory:project_cloudbench_per_bench_fleet_autoscale
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

Fleet runs intermittently reported an empty machine pool and fell back to
provisioning a fresh clone — paying the ~400s volume fork that the pool exists
specifically to avoid — even though provisioned machines were sitting in Fly in
state `started`.

## Diagnosis

The pool of stopped clones (`--provision-pool N`) is allocated through a claim
ledger: a run claims a machine, starts it, and returns the claim on exit. Release
was tied exclusively to the claiming run's normal exit path, so a **killed** run
(SIGKILL, crash, or an operator stopping it) could never return its claim. The
machine was left `started` with no live owner, permanently unclaimable by anyone
else, and the pool drained one machine per killed run until it read as empty.

The general shape: an ownership claim whose only release path is the owner's
cooperative shutdown is a guaranteed leak under abnormal termination.

## Solution

`reconcile_pool` now runs at fleet start and reclaims orphaned-`started` machines,
so a killed run's leaked claim is recovered by the next fleet instead of
permanently draining the pool. Covered by
`agents/benchmarks/cloudbench_dependency_sync_test.py`, which includes pool-ledger
and recovery-lock tests.

## Human feedback

None recorded.

## Reusable lesson

Any resource claim must have a reconciler that reclaims it from a dead owner —
release-on-clean-exit alone leaks the resource on every kill.
