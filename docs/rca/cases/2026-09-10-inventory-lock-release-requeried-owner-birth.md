---
id: 2026-09-10-inventory-lock-release-requeried-owner-birth
date: 2026-09-10
title: Inventory refresh release replaced its sealed owner birth with a fallible second read
surface: infra
component: cloudbench-inventory-refresh
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet inventory_refresh_lock_release compared the lock to a second ps birth read instead of the identity sealed at acquisition
symptoms:
  - "timed out waiting for the serialized inventory refresh"
  - "snapshot storage was not mountable within the provisioning deadline; retaining ownership"
  - mandatory N=2 infra canary failed both benches before launch
  - machines-refresh.lock remained owned by a dead publisher after teardown
tags:
  - cloudbench
  - fleet
  - inventory
  - lock
  - process-identity
sources:
  - commit fe99d86f6
  - commit 6e95c1e6e
  - fleet run capability-stability-20260910105116-2670724
repro: agents/benchmarks/cloudbench_dependency_sync_test.py test_inventory_release_uses_sealed_owner_birth_identity
status: fixed
---

## Problem

Capability proof `capability-stability-20260910105116-2670724` started the
mandatory two-task infra canary, but neither task reached launch. The shared
inventory last published at 10:52:40 UTC. A new
`machines-refresh.lock` appeared at 10:52:47 with PID 2671994, birth
`Thu Sep 10 10:52:00 2026`, and a unique token, then survived its owner.
Four waiters each exhausted the serialized refresh bound. Both exact clones
remained in storage restore until provisioning expired and were subsequently
destroyed with `destroyed-verified-absent` ownership receipts.

The permanent pre-fix command was:

`agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_inventory_release_uses_sealed_owner_birth_identity`.

Its injected first `ps` read returned `sealed-birth`, its release read returned
`drifted-birth`, and the unchanged assertion failed because the lock remained.

## Diagnosis

Critical path: keyed inventory refresh acquisition → immutable lock publication
with host/PID/birth/token → provider inventory refresh → release re-queries
the owner birth → release rejects its own lock → every later clone and
autoscaler refresh waits on that live-looking record → storage readiness cannot
observe progress → infra canary fails before launch.

What: an exact owner could not release its own refresh lock. Where:
`inventory_refresh_lock_release` in `scripts/run-bench-fleet`. Why: acquisition
persisted one PID birth, but release discarded that in-memory identity and made
a second formatted `ps` read authoritative. Proof: the lock metadata and
timestamps above match the four timeout lines, and the deterministic regression
changes only the second birth read. Post-fix NDJSON records show the current
formatted read as `drifted-birth` while the lock and sealed acquisition birth
remain `sealed-birth`; host and token match and release succeeds.

The deepest owned cause is a lifecycle-contract inconsistency: a keyed lock had
two owner identities, one sealed when ownership began and one reconstructed
when ownership ended. The timeout and restoring-volume failures were downstream
effects, not timeout-policy defects.

## Solution

Acquisition now retains the exact owner PID and birth beside the unique lock
token. Release requires the current numeric owner, retained PID, lock PID,
retained birth, lock birth, host, and token to agree, then removes only that
keyed lock. A diagnostic `ps` read can no longer replace the sealed capability.
Stale-owner recovery and cross-host refusal remain unchanged.

The unchanged regression passes, and the complete dependency-sync,
cloudbench-environment, authenticated status-service, fleet canary,
stability-proof, and multi-workstream lifecycle suites pass. At 10,000 agents,
the change remains O(1) per refresh acquisition: one keyed lock and three
process-local scalars, with no global scan, shared fan-in, per-agent poller, or
additional provider call.

## Human feedback

The user required evidence from the exact lock metadata and failed proof,
an unchanged failing-before/passing-after regression, no timeout, benchmark,
prompt, criterion, or concurrency changes, and keyed bounded behavior that
preserves other workstreams at 10,000 agents.

## Reusable lesson

Release a keyed lifecycle lock with the immutable owner identity sealed at acquisition; never reconstruct ownership at teardown.
