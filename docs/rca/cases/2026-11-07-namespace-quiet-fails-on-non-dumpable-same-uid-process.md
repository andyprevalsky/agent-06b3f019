---
id: 2026-11-07-namespace-quiet-fails-on-non-dumpable-same-uid-process
date: 2026-11-07
title: Interrupted-custody namespace scan raised PermissionError on a non-dumpable same-uid process and refused every cloud reconcile on the host
surface: infra
component: scripts/deploy_test_interrupted_cleanup.py namespace_quiet
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/deploy_test_interrupted_cleanup.py namespace_quiet — handled only FileNotFoundError/ProcessLookupError when reading /proc/<pid>/cwd and fd of processes owned by the current uid"
symptoms:
  - "PermissionError: [Errno 13] Permission denied: '/proc/1339354/fd'"
  - "interrupted custody proof refused: [Errno 13] Permission denied"
  - "AssertionError: Lists differ: ['smoke'] != []"
tags:
  - deploy
  - staged-cycle
  - proc
  - permissions
  - custody
sources:
  - PR #1749 final sweep on f407e0738, gate deploy-command-structural (deploy-test-plan, InterruptedCustody)
repro: scripts/tests/deploy-test-plan.test.py NamespaceQuietUninspectableProcess
status: fixed
---

## Problem

PR #1749's final sweep failed `deploy-command-structural`. In
`deploy-test-plan`, `test_policy_renewal_rechecks_evidence_allocations_consumers_and_contract`
raised `PermissionError: [Errno 13] Permission denied: '/proc/1339354/fd'`, and
`test_historical_policy_drift_renews_without_changing_original_bindings`
found the smoke owner still retained. Both came from the same refused reconcile.

## Diagnosis

`namespace_quiet` inspects every `/proc/<pid>` whose directory is owned by the
current uid. A same-uid process that is non-dumpable (a setuid exec, or
`PR_SET_DUMPABLE=0`) keeps a user-owned `/proc/<pid>` and a readable `cmdline`,
but its `cwd` and `fd` links become root-protected. The scan caught only
FileNotFoundError/ProcessLookupError, so one such process anywhere on the host
refused the reconcile. Reproduced deterministically: 30 processes that drop
dumpability once, plus one toggling it, made the cloud custody tests error on
`/proc/<pid>/cwd`, `fd` and `fd/N`. The PR diff touched nothing under `scripts/`.

## Solution

The argv check runs first and still applies. When `cwd`/`fd` raise
PermissionError, the process is treated as uninspectable, like another user's
process, which the scan already skips. Regression
`NamespaceQuietUninspectableProcess`: a hidden-cwd process no longer fails the
scan, and a hidden process naming the namespace in its argv is still a
consumer. Both error on the old code. The full suite passes 44/44 with the same
non-dumpable processes present.

## Human feedback

None: found and fixed inside PR #1749's deploy.

## Reusable lesson

A host-wide `/proc` scan must expect same-uid entries it cannot inspect, not
only entries that vanish.
