---
id: 2026-07-14-transient-volume-not-found-treated-as-fatal-clone-failure
date: 2026-07-14
title: Transient Fly "volume not found" on clone was treated as fatal and failed the whole fleet gate
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: other
first_bad_boundary: clone_machine_target in run-bench-fleet — retried only Fly API throttles, so "failed to launch VM: volume not found" was fatal on first attempt
symptoms:
  - "failed to launch VM: volume not found"
  - synchronized-start barrier stuck at N-1/N stacks and the gate fails
  - 28-task daily fleet iteration scored 0/28 without ever reaching execution
tags:
  - cloudbench
  - fly-io
  - retry
  - race-condition
  - fleet-barrier
sources:
  - commit ebd1dabad
  - commit f13bf3788
  - memory:project_cloudbench_teardown_clone_retry_fixes
  - memory:project_daily_suite_concurrent_iteration
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

A 28-task daily cloud-benchmark iteration scored 0/28 and never reached
execution. With an empty machine pool the fleet cloned 28 fresh boxes from
snapshot `vs_ZPnK…` in `iad`; roughly 1 in 4 clones hit
`failed to launch VM: volume not found`. The second clone failure tripped the
controller's cleanup trap, which SIGTERM'd all children (exit 143) and tore the
fleet down before the synchronized-start barrier. The same defect left the
pre-deploy fleet barrier short one stack (N-1/N) and failed that gate too.

## Diagnosis

`clone_machine_target` ran `flyctl machine clone` exactly once and only retried
Fly API throttle errors. `failed to launch VM: volume not found` is transient —
it is the snapshot-backed volume not yet being ready in-region — but it did not
match the retry regex, so it was classified fatal. Two fatal clone results were
enough to trip the controller cleanup trap and abort the batch. The deeper owned
cause is a retry classifier keyed to one known-transient error string rather
than to the class of transient provisioning races, combined with a controller
that treated per-box provisioning failure as batch-fatal.

## Solution

Added bounded retry-with-backoff for the transient launch/volume errors:
`volume not found|failed to launch vm` joined the backoff-retry regex
(`CLOUDBENCH_CLONE_MAX_ATTEMPTS=3`, `CLOUDBENCH_CLONE_RETRY_SECONDS=8`), with a
fresh machine name per attempt and the names-ledger reaping any machine that did
materialize (commits ebd1dabad, f13bf3788). Cemented by
`test_clone_retries_transient_volume_not_found` and
`test_clone_gives_up_after_max_attempts`, with the identity test pinned to
`MAX_ATTEMPTS=1`. Later work made the barrier tolerant of infra failures so a
single unrecoverable box no longer aborts the batch.

## Human feedback

The human's framing was that infra flake must not be laundered into benchmark
failure: this was classified as pure infra, not a benchmark/harness regression,
and no prompt or task definition was allowed to change.

## Reusable lesson

Classify cloud provisioning errors by transience and retry the whole class with
backoff and a fresh resource name — and never let one box's provisioning failure
be batch-fatal.
