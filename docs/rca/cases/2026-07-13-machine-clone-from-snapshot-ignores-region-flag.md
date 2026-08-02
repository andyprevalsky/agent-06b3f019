---
id: 2026-07-13-machine-clone-from-snapshot-ignores-region-flag
date: 2026-07-13
title: `fly machine clone --from-snapshot` restores the volume in the snapshot's origin region, so `--region iad` was ignored and every clone died on `ord` capacity
surface: infra
component: cloudbench-fleet
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: fly machine clone --from-snapshot — volume is restored in the snapshot's origin region regardless of --region
symptoms:
  - "failed to create volume: no capacity available in ord"
  - every fleet clone dies during provisioning even with --region iad
  - run-predeploy-cloud smoke gate never dispatches
tags:
  - fly-io
  - cloudbench-fleet
  - volume-snapshot
  - region
  - capacity
sources:
  - memory:project_cloud_smoke_infra_blockers_jul2026
repro: none-recorded
status: mitigated
---

## Problem

During the biz-health-waitlist `/deploy` (2026-07-13) the
`scripts/run-predeploy-cloud` smoke gate could not provision any machines: every
`machine clone` failed with
`failed to create volume: no capacity available in ord`, even though the clone
was requested with `--region iad`.

## Diagnosis

Fly's `machine clone --from-snapshot` restores the forked volume in the
**snapshot's origin region**, not the region passed on the command line — volume
snapshots are region-scoped, so `--region iad` was silently ignored and the fork
was attempted in `ord`. When `ord` is out of capacity, every clone in the fleet
dies at volume creation.

The situation was aggravated by contention on the same shared Fly app: a
concurrent workspace (`minsk`) was running a 27-task fleet into
`navi-whisper-lux-bench` at the same time, consuming the capacity that remained.

## Solution

The clone region must match the warm box's region because snapshots are
region-scoped — passing a different `--region` does nothing. There is no code fix
that makes `ord` have capacity; the mitigation is to treat the warm box's region
as the fleet's region and to avoid running concurrent large fleets into the same
shared app.

To validate `run-bench-fleet` changes without depending on the cloud path at all,
use the deterministic suites: `agents/benchmarks/cloudbench_dependency_sync_test.py`
(35 tests covering the pool ledger, clone identity, and recovery lock) and
`scripts/tests/cloudbench-env.test.sh`.

## Human feedback

None recorded.

## Reusable lesson

Treat volume snapshots as region-pinned: a clone's region is dictated by the
snapshot, so `--region` on `machine clone --from-snapshot` cannot move it.
