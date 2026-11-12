---
id: 2026-11-12-recovery-guard-fd-inherited-by-flyctl-daemon-and-capture-refused-clone-services
date: 2026-11-12
title: Exact-owner recovery could not finish because a flyctl daemon kept the recovery guard and capture refused the services every clone inherits
surface: infra
component: cloudbench-exact-owner-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet acquire_registry_recovery_lock (guard fd inherited by every child) and scripts/cloudbench-original-volume-capture.py validate_original_config (services refused by default)
symptoms:
  - "exact-owner recovery guard is held; retry after it exits"
  - "unsupported Machine config: services is set"
  - "flyctl agent run holds .git/cloudbench-fleet-recovery-locks/<token>"
  - "original-volume runtime archive required"
tags:
  - cloudbench
  - exact-owner-recovery
  - flock
  - fd-inheritance
  - flyctl-agent
  - original-volume-capture
sources:
  - PR #1972 smoke owner a4b2999b567546a7a243098c27dce3c7 (Machine 80d21ef63524d8, vol_458d62q5wpe59dj4)
  - PR #1788 owner a8a15138 (Machine 862ee7ce413508)
repro: scripts/tests/cloudbench-recovery-guard-inheritance.test.py; agents/benchmarks/cloudbench_dependency_sync_test.py::test_failed_fleet_forensic_original_volume_preflight_is_read_only[services-False]
status: fixed
---

## Problem

PR #1972 smoke task `agent-payment-idempotent-abandonment` left a retained
fleet owner. `run-bench --recover-stale-owner a4b2999b…` stopped the guest and
printed "original-volume runtime archive required". The capture helper then
refused twice: first "exact-owner recovery guard is held; retry after it exits"
although no recoverer was alive (`/proc/*/fd` showed a `flyctl agent run`
daemon holding `.git/cloudbench-fleet-recovery-locks/<token>`), then
"unsupported Machine config: services is set". The same services refusal
stranded PR #1788 owner a8a15138. No supported path could finish recovery.

## Diagnosis

1. `acquire_registry_recovery_lock` opens the guard with
   `exec {REGISTRY_RECOVERY_GUARD_FD}< guard` and flocks that open file
   description. Bash cannot mark it close-on-exec, so every child inherits it.
   A `flyctl` call during recovery forked its long-lived `flyctl agent` daemon,
   which kept the flock after the recoverer released and exited. Repro: the new
   test drives the real acquire/release functions with a daemonizing fake
   `flyctl`; on main the guard stays held (FAIL), after the fix it is free.
2. Every fleet clone inherits the donor's network `services`. The capture
   helper already knew how to isolate them for the inert boot and restore the
   exact original (`inert_variant`, `stop_and_restore`, covered by tests), but
   only behind an opt-in `--isolate-services` flag. The recovery hint and the
   refusal never named that flag, so the default capture refused every clone.
   Repro: the preflight test with services and no flag returned exit 3 with
   the exact refusal on main.

## Solution

- `run-bench-fleet` defines a `flyctl` wrapper that closes
  `REGISTRY_RECOVERY_GUARD_FD` for every flyctl spawn. Python helpers that
  verify the guard still receive it via `--guard-fd`; the recoverer's own lock
  still fences concurrent captures (both asserted).
- The capture admits well-formed `services` by default: removed only for the
  inert boot, restored byte-exact, recorded as `services_isolated` in the
  zero-credit provenance. Malformed services and other startup mechanisms stay
  refused. `--isolate-services` is accepted as a compatibility no-op.
- Regressions: `cloudbench-recovery-guard-inheritance` structural gate, and the
  existing permanent original-volume capture controls now cover both flag modes.
- 10k-agent behavior: per-owner, per-recovery only; no shared state added.

## Human feedback

None recorded.

## Reusable lesson

A lock held on a Bash fd is inherited by every child, so any daemonizing child
(flyctl agent, ssh master) must be spawned with that fd closed; and a safety
mode required for every real input must be the default, not an opt-in flag
that the recovery hint never mentions.
