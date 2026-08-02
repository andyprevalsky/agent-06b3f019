---
id: 2026-07-14-machine-destroy-leaves-forked-volume-behind
date: 2026-07-14
title: `machine destroy` never destroys the forked volume, leaking 42×20GB of billed storage in one day
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: other
first_bad_boundary: reap_machine in run-bench-fleet — destroyed the machine without resolving and destroying the volume forked from the warm snapshot
symptoms:
  - 42 unattached 20GB cloudbench_data volumes billed in a single day
  - Fly volumes accumulate after every fleet teardown even when all machines are gone
tags:
  - cloudbench
  - fly-io
  - resource-leak
  - cost
  - teardown
sources:
  - commit 87ddfd3b9
  - memory:project_daily_suite_concurrent_iteration
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

Cloud-benchmark teardown looked clean — machines were gone — but storage kept
billing. In one day of 28-wide fleet iterations, 42 volumes of 20GB each were
leaked and billed as unattached `cloudbench_data` volumes.

## Diagnosis

Each fleet clone forks a volume from the warm snapshot. `flyctl machine destroy`
destroys only the machine; the forked volume survives as an unattached volume.
The fleet's `reap_machine` path never resolved the machine's volume before
destroying it, so after teardown there was no handle left that pointed at the
volume — the leak was invisible from the machine list, which is the surface the
controller and the operator both watched. The deeper owned cause: teardown
enumerated one resource type (machines) while provisioning created two
(machines + forked volumes), so cleanup could never be complete by construction.

## Solution

`reap_machine` now resolves the machine's volume _before_ destroying the machine
and reaps the volume afterwards; additionally, fleet start sweeps aged unattached
`cloudbench_data` volumes with a 1-hour grace period and warm-volume protection
(commit 87ddfd3b9). Cemented in
`agents/benchmarks/cloudbench_dependency_sync_test.py`. Proven in the iteration-7
run: teardown reaped ~30 machines with zero volume leaks.

## Human feedback

None recorded.

## Reusable lesson

Teardown must enumerate every resource type provisioning creates — if a clone
forks a volume, reaping the machine is only half the cleanup, and add a
grace-period sweep so past leaks self-heal.
