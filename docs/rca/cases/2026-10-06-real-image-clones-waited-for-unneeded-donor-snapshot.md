---
id: 2026-10-06-real-image-clones-waited-for-unneeded-donor-snapshot
date: 2026-10-06
title: REAL image-backed task Machines waited for an unnecessary donor snapshot restore
surface: infra
component: cloudbench-fresh-volume-bootstrap
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: clone_machine_target always requested restored donor storage despite an available dependency image and REAL-mode asset contract
symptoms:
  - one mandatory canary held the shared preflight lock while 49 controllers waited
  - successful clone commands left two 40GB volumes RESTORING
  - snapshot storage was not mountable within the provisioning deadline
tags:
  - cloudbench
  - snapshot
  - startup
  - prebuilt-image
  - source-bootstrap
sources:
  - commit 94f1aead5495e66d8a46d35f4d1e22d50bec291a
  - benchmark run campaign-20261006-083146-2580
  - fleet run 20261006-013231-16394
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_prebuilt_real_clone_avoids_snapshot_restore_with_exact_ownership
status: open
---

## Problem

The actual fifty-copy cached campaign never reached task execution. Exactly one
mandatory canary owned the shared transaction lock and 49 controllers correctly
waited. Its two clone commands returned success on their first attempt, but the
attached 40GB volumes remained RESTORING in the existing shared native inventory.
Both unchanged 600-second storage-readiness waits failed. The original campaign
ended with one failure and 49 cancellations, zero ready jobs and zero DEMO or
accepted executions. Normal exact-owner cleanup retired its resources.

This does not establish why the provider did not finish restoration. It establishes
that our REAL-mode provisioning required donor storage that the task did not need:
the verified image already supplies dependencies, source is synchronized to the
requested ref, and the canonical database fixture has a verified remote cache.

## Diagnosis

Path: accepted Fly clone with `--from-snapshot` → native volume RESTORING →
`clone_machine_target` storage-ready wait → mandatory canary fails before release.
The helper serializes one actual canary; the fifty preflight processes were not
fifty simultaneous clone operations. The recorded new Machine IDs belonged to
the nested canary, rather than any outer task controller.

Archive searches were `snapshot restore dependency` and `blank Git bootstrap`.
Related cases include the July 13 snapshot-region dependency, October 5 donor
proof ownership and September 9 exact-volume ownership cases. This boundary is
unnecessary restored state, separate from proof discovery and exact teardown.

Empty storage is not a drop-in substitute. `/app` contains the verified donor
source/dependencies but no Git metadata. The primary previously required
`/data/repo/.git`; the worker changed directory there before fetching and assumed
copied dependency trees. SIM tasks also require the retained World Model asset.
The initial private test assembly and affected extraction failures are preserved
with no acceptance credit.

## Solution

The standard boot-launched CLI selects fresh storage for effective REAL task
primaries and workers. The immutable catalog plus `--sim-on` controls eligibility.
SIM tasks keep their snapshot/World Model path. `--snapshot-volumes` retains an
explicit provider diagnostic, while generic pre-provisioned pools and legacy
startup retain their compatible snapshot path. Pool reuse remains available.

The fresh handoff initializes only an absent or empty Git checkout, authenticates
to the normal fixed origin, fetches ordinary history, and verifies the requested
ref using the existing helper and lock. Primary bootstrap precedes sanity checks
and repository context writes. Workers verify source/patch, synchronize the same
manifest-bound image dependency trees and Prisma client, then hydrate the existing
exact environment and join the primary's existing backend and task queue. Failed
dependency or Prisma synchronization cannot publish readiness.

The normal isolated database still requires the same canonical schema/PG/revision
fixture, with its existing cache validation and restore. DEMO read-only settings,
models, prompts, tasks, evaluators, results, ownership, cleanup and normal task
budgets remain unchanged. Image manifests, recipe and pinned image are unchanged;
source-only controller helpers are injected through the existing transport.

The unchanged permanent fetch control fails on old source in 0.557 seconds and
passes on the candidate in 0.659 seconds. The same clone control rejects the old
snapshot argument while preserving the snapshot-failure inverse; the candidate
passes that exact owned-ID/volume/command boundary. Fourteen new compact cases and
fourteen existing affected cases pass in 5.235 seconds. The existing registered
deploy owner selects the new controls. Native canary and fifty-task results are
still pending: no live speed improvement or successful task outcome is claimed.

At 10,000 runs, removing the repeated restored-state prerequisite avoids that
class of readiness wait for eligible REAL Machines. The logical 40GB size is not
a measurement of bytes transferred, and no fleet-scale time saving is projected
from this one failure. Private source-bound artifacts are under
`.context/fresh-volume-provisioning-20261006/`; raw provider logs remain private.

## Human feedback

The user requested a faster normal CLI for future runs, compact permanent
regressions, preserved task/cache/evaluator semantics and completion of deployment.
They prefer removing infrastructure waste over merely raising an assertion budget.

## Reusable lesson

Choose persisted state from the task's actual asset contract; an available
verified dependency image does not itself supply a Git checkout or SIM model.
