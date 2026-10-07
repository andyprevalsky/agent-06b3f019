---
id: 2026-10-07-large-catalog-retirement-fixture-host-guard-too-tight
date: 2026-10-07
title: Large-catalog sealed-primary retirement fixture used a 10-second host guard for 10,000 fsynced ordinals
surface: harness
component: cloudbench-dependency-sync-test
classification: test-bug
problem_class: timeout-too-aggressive
first_bad_boundary: agents/benchmarks/cloudbench_dependency_sync_test.py test_sealed_primary_retirement_keeps_every_unsealed_scope_owned communicate(timeout=10)
symptoms:
  - "test_sealed_primary_retirement_keeps_every_unsealed_scope_owned[large-catalog]"
  - "subprocess.TimeoutExpired: Command '['bash', '-c'"
  - timed out after 10 seconds
tags:
  - fsync
  - linux
  - host-guard
  - fleet-retirement-index
  - deploy-structural-gates
sources:
  - PR #1417
  - commit 13b6ae1e11977264650be66d4b9040618a639a8b
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

On a Linux ext4 cloud clone, the `large-catalog` case of
`test_sealed_primary_retirement_keeps_every_unsealed_scope_owned` raised
`TimeoutExpired` after 10 seconds. The other 21 parametrizations passed. The
same case passes on faster local disks, so it first surfaced when a Linux host
ran the merged `main` source.

## Diagnosis

The case builds a 10,000-task catalog, and `fleet_retirement_index init` in
`scripts/run-bench-fleet` publishes one durable ordinal per task: each write
fsyncs the file and its parent directory. A local probe on the same disk
measured about 2.3 ms per entry with both fsyncs, which is roughly 23 seconds
for 10,000. Fsyncing each file but the directory only once still cost about 1 ms
per entry. Writing every file first and fsyncing in a second pass cost the same,
because delayed allocation makes each fsync perform its own writeback and journal
commit. The one-time initialization therefore exceeded the fixture's 10-second
`communicate` limit, while the asserted properties held: one catalog read,
10,000 ordinals, and exact retirement. The `late-native` cases in the same
function already used `FIXTURE_HOST_GUARD_SECONDS`.

## Solution

Every case in the function now uses the existing generous fixture host guard.
The case's behavioral assertions are unchanged, and all 22 parametrizations
pass on the Linux host in 35 seconds. Production durability is unchanged. A
10,000-task fleet pays about 25 seconds once at index initialization, which is
small next to fleet execution. The index stays bounded by catalog size, with no
per-agent polling or shared hot-path contention.

## Human feedback

None recorded.

## Reusable lesson

When a fixture subprocess performs intentionally durable per-item I/O at scale, bound it with the generous host guard and assert the scale properties, not a host-speed deadline.
