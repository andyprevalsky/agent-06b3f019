---
id: 2026-09-10-machine-volume-identity-frozen-across-provider-migration
date: 2026-09-10
title: Exact fleet ownership froze the Machine-to-volume association across provider migration
surface: infra
component: cloudbench-fleet-volume-ownership
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet fleet_registry_volume_for_id returned the original volume without checking the exact Machine's current mount, while recovery rejected every replacement
symptoms:
  - "exact guest shutdown configuration is unsafe"
  - "stale recorded volume would orphan the exact migrated mount"
  - "exact volume migration reconciliation failed; ownership retained"
tags:
  - fly-io
  - cloudbench
  - migration
  - volume-lifecycle
  - teardown
  - ownership
sources:
  - PR #1299
  - commit 10e8df231859970a3db513fbf39ae260d934c592
  - task exact fleet owner 4fdbf124309846c096282d3d10d9ecb9 recovery
  - fleet run 20260910-194011-30901
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

Exact cancellation recovery stopped before authenticated guest shutdown because
Machine `822717a77d2638` retained its owned clone name but mounted volume
`vol_v8ek11oloj70py1v` instead of its registered `vol_vp2611gloy18p6k4`.
Read-only exact volume evidence showed the original volume in `pending_destroy`
with no attachment, and the replacement in `created` attached to that same
Machine. The owner retained all ten Machines; eight guest shutdown receipts
already existed and two were missing. No receipt or deletion was invented to
bypass that quarantine.

The permanent pre-fix command was:

`agents/venv/bin/pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_owned_worker_volume_follows_exact_provider_migration`

It exited 1: `AssertionError: stale recorded volume would orphan the exact
migrated mount`, with actual `vol_old` versus expected `vol_new`. The fixture
replays the captured same-Machine, terminal-unattached-old-volume, and
created-attached-new-volume relationship through the actual ownership resolver.

## Diagnosis

The path is exact provider Machine/config and volume responses → durable clone
identity → guest configuration validation or provider teardown → terminal audit.
The resolver reused the recorded original volume without checking the current
mount. Guest recovery did check the mount, correctly detected disagreement, but
had no supported reconciliation. Both audit and registry writers rejected any
change to the volume ID, so retrying their existing transaction could not repair
the relationship.

The deepest owned cause is a lifecycle contract that treats the Machine-to-volume
association as immutable. The Machine identity is stable through a supported
provider operation while its attached storage identity changes. Fly documents
that migration copies the volume under a new ID while retaining the Machine ID;
its volume lifecycle documents retirement of the old migration volume. This
establishes the supported transition, not the particular host-maintenance reason
for the captured incident. The owning-boundary replay proves our invalid
identity assumption independently of that external reason.
[Machine migration](https://fly.io/docs/reference/machine-migration/),
[volume states](https://fly.io/docs/volumes/volume-states/).

Archive searches were `registered volume mismatch` and `fly migration attached
volume ownership`. The default-volume-list omission and clone-source-read
ownership cases are relatives. They establish exact terminal-volume evidence
and audit-first publication, but neither supported replacement of an attached
volume while preserving the Machine identity.

## Solution

`scripts/cloudbench-volume-migration.py` owns one reconciliation transaction:
exact identity checks → immutable old/new volume receipt → current audit update
→ registry update. It requires an explicitly terminal, unattached old volume,
one current Machine mount, and a replacement volume whose exact provider record
identifies that owned Machine as its attachment. Unknown, live, conflicting,
foreign, malformed, protected-warm-volume, and symlink identities fail closed.
The old terminal volume remains in an immutable journal; replacing the current
volume never erases the original resource obligation or calls it exactly absent.

The journal is the write-ahead authority for interrupted publication. Recovery
can repair both journal-before-audit and audit-before-registry windows without
provider rediscovery. Repeated migrations form one monotonic chain. Committed
terminal and `transfer-pending-stopped` transitions retain their existing
teardown/pool-handoff authority. Guest recovery, ordinary fresh-clone cleanup,
and failed-worker cleanup use the same resolver. Final audit publication validates
the chain and includes the receipts in the immutable run artifact. The helper is
part of the controller snapshot, so an original worktree disappearing cannot
remove recovery code.

Deleting the original volume field would lose pre-destruction cleanup authority;
overwriting it alone would lose historical terminal evidence and introduce an
unrecoverable two-file crash window. The narrow journal therefore unifies the
required current association and its prior terminal obligations rather than
adding an unverified alternate cleanup path.

The identical original reproduction now passes. Added tests cover both crash
windows, repeated migration, unsafe identities, authenticated guest configuration,
and actual registry reaping → final audit publication → registry removal. The
last integration checks that only the current volume is destroyed, both shared
and run-local audits preserve the old receipt, and the exact owner registry,
including its per-Machine lock directory, is removed. Independent review found
that the first implementation rejected `transfer-pending-stopped`; both retained
and already-unlinked registry cases were observed failing before the fix, then
passed unchanged after it. The latest focused run passed 25 tests. The full Mac
run passed 324 tests; three Linux process-state tests still require execution in
the canonical Linux environment. Other intermediate failures were repaired and
covered by the focused rerun.

A second publication-window check reproduced failure after the final audit was
sealed but before the empty registry was removed. Resume now permits a read-only
committed terminal journal under a sealed audit, while rejecting any new
migration or incomplete audit repair there. The unchanged finalization test then
passed through resume and exact registry retirement.

At 10,000 agents, ordinary fresh-clone cleanup adds bounded exact-Machine reads,
and only a changed mount needs two exact volume reads. Journal locking is per
Machine; replay scans only that Machine's migration chain during individual
cleanup. Initial owner recovery and final audit validation scan the owner's
migration receipts once. There is no app-wide provider inventory, global lock,
subscription, shared counter, or additional live benchmark stage.

The full Linux regression batch passed 387 tests, including the three process-state
cases that require Linux. Canonical recovery of the captured owner then exited 0:
its audit is `provider-teardown-verified` and the exact owner registry is absent.
An independent provider read verified all ten owned Machines terminal, all twelve
exact volumes (including the retired migration volume) terminal and unattached
or exactly absent. The migration receipt preserves the old volume's actual
`pending_destroy` observation; it does not mislabel that state as absence.

The interrupted benchmark proof remains failed. Recovering its resources does not
retroactively produce an accepted slice or alter any task outcome. The requested
ten sequential ten-task proof must start again with the separately requested
five-minute execution override.

## Human feedback

The user directed the agent to finish without permission prompts, required ten
sequential ten-task cloud slices with no infrastructure issue, and subsequently
required a temporary five-minute execution backstop for this validation while
retaining a large normal backstop. The parent stopped the active proof before
recovery. No provider mutation was performed by the independent migration worker.

## Reusable lesson

Reconcile a provider's mutable resource association through exact attachment and terminal-lifecycle evidence, preserving an immutable transition before replacing durable cleanup authority.
