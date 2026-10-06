---
id: 2026-09-09-boot-config-reservation-ignored-fleet-width
date: 2026-09-09
title: Boot-config capacity reservations ignored each fleet's actual width
surface: infra
component: cloudbench-capacity-admission
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-bench-fleet enforce_app_capacity_guard used the provider-wide boot-config concurrency limit as every fleet's replacement count
symptoms:
  - "❌ Machine-count capacity admission denied: 19 app Machines"
  - "+ 36 slots reserved by live workstreams"
  - "+ this run's 1 fresh primaries (0 from stopped pool)"
  - "+ 4 boot-config replacement slots = 60"
  - "> benchmark-app Machine ceiling 56."
tags:
  - cloudbench
  - fleet
  - capacity
  - admission
  - concurrency
  - boot-config
sources:
  - commit 9ae3456c19d52c8c363472d42f107e16f0c1f563
  - fleet run 20260909-195021-262335
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

Three independent one-task Polar Fleet controllers failed physical-Machine
admission before provisioning. One controller observed 19 provider-visible app
Machines, 36 slots held by concurrent workstreams, one fresh primary, and four
boot-config replacement slots, projecting 60 against the unchanged 56-Machine
allocation.

The local owning-boundary command
`agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_single_task_capacity_reservations_scale_with_actual_fleet_width`
replayed ten simultaneous one-task controllers from the same 19-Machine
snapshot. Before the fix, exactly seven admitted and three failed. Runtime
instrumentation showed every width-one controller computing
`requestedMachines=1`, `freshMachines=1`, `replacementSlots=4`, and
`reservationMachineSlots=5`.

## Diagnosis

Critical path: campaign fans out ten one-task Fleet controllers → each controller
classifies the same provider inventory → `enforce_app_capacity_guard` computes
its durable reservation → the fcntl admission transaction sums sibling
reservations → later controllers exceed the app allocation and abort.

The first bad boundary assigned
`CLOUDBENCH_BOOT_CONFIG_MAX_IN_FLIGHT` directly to `replacement_slots`. That
setting is the provider-wide upper bound for concurrent config mutations, not
the number of replacement Machines one arbitrary fleet can create. A one-task
fleet can run at most one boot-config update, so reserving four inflated each
controller from two physical slots to five. Ten sibling controllers amplified
the mismatch while the serialized ledger correctly enforced the wrong totals.

The pool path was not causal: instrumentation recorded zero available pool
Machines and one correctly classified fresh primary. The general problem is a
concurrency inefficiency caused by conflating a global scheduler bound with
per-workstream cardinality.

## Solution

`enforce_app_capacity_guard` now derives replacement capacity as
`min(CLOUDBENCH_BOOT_CONFIG_MAX_IN_FLIGHT, requested_machines)`. Wide fleets
still reserve all four possible simultaneous replacements, the Machine ceiling
and update concurrency are unchanged, and pool provisioning still reserves
zero because it skips the post-clone config phase.

The unchanged reproduction passes all ten controllers. Post-fix instrumentation
records `replacementSlots=1` and `reservationMachineSlots=2` for every one-task
fleet. The complete Cloud Benchmark Lifecycle and hermetic multi-workstream
gates pass without launching a paid benchmark.

At 10,000 agents this remains O(1) arithmetic per Fleet admission. Reserved
replacement slots are bounded by the actual fleet width and the existing
provider mutation limit; no per-agent query, poller, channel, or shared row was
added.

## Human feedback

The user required two distinct RCAs, no ceiling/concurrency/timeout increase, no
weakened admission, actual-fleet-width accounting, permanent coverage in the
existing Cloud Benchmark lifecycle and multi-workstream gates, no paid
benchmarks, and no interaction with any live Fleet.

## Reusable lesson

Cap every workstream's reservation by both the global concurrency limit and the workstream's actual cardinality.
