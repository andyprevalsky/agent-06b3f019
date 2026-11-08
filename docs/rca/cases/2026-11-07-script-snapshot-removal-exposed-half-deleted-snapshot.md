---
id: 2026-11-07-script-snapshot-removal-exposed-half-deleted-snapshot
date: 2026-11-07
title: Script snapshot removal deleted the helper before its directory, so a peer's cleanup saw a half-deleted snapshot
surface: infra
component: cloudbench-script-snapshot
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/cloudbench-script-snapshot.py removal (shutil.rmtree on the live snapshot path)
symptoms:
  - "python3: can't open file '.../cloudbench-scripts.<hash>/cloudbench-script-snapshot.py': [Errno 2] No such file or directory"
  - 'FATAL: could not remove the exact owned script snapshot'
  - 'FAILED benchmarks/cloudbench_monitor_test.py::test_fleet_monitor_detached_launch_retains_actual_controller_exit[wait] (and [detach]) assert 1 == 7'
tags:
  - cloudbench
  - script-snapshot
  - race
  - deploy-structural
sources:
  - PR #1762
repro: agents/benchmarks/cloudbench_monitor_test.py (test_script_snapshot_removal_never_exposes_a_partly_deleted_snapshot)
status: fixed
---

## Problem

The deploy-command-structural gate for PR #1762 failed twice in a row on Blacksmith
8-vCPU runners, at c4ae7fa2d. The failure was in `benchmark-live-results`:
`cloudbench_monitor_test.py::test_fleet_monitor_detached_launch_retains_actual_controller_exit`,
first the `[wait]` variant and then `[detach]`. The launcher printed `python3: can't open file
.../cloudbench-script-snapshot.py` and `FATAL: could not remove the exact owned script snapshot`.
The same test passed 20/20 on the devbox, and the gate passed on Blacksmith at 6427f84e1.

## Diagnosis

The launcher runs `cloudbench-script-snapshot.py` from inside the snapshot it owns, both for
the handoff poll and for its EXIT cleanup. The claimant fleet in the test exits straight after
claiming, and its own cleanup removed the snapshot with `shutil.rmtree(path)`. rmtree unlinks
the files, helper included, before the directory itself. If the launcher's cleanup started in
that window, the helper was already missing while the directory still existed. The bash
guard `[ -e "$CLOUDBENCH_SCRIPT_SNAPSHOT" ] || return 0` then treated this as a real failure.
The existing `VANISH_BEFORE_CLEANUP` hook already documents this non-atomic in-place
deletion, but production removal still used it.

Repro: the new test records `snapshot.exists()` whenever deletion begins. On HEAD~1,
`_remove_unadopted_snapshot` deletes while the path is still visible; with the fix the path is
gone first. The Blacksmith failures are timing-dependent and could not be forced
deterministically on the devbox; the mechanism repro is the deterministic check.

## Solution

Every removal path (`cleanup`, `check_armed`, `cancel_claim`, `recover_create` and
`_remove_unadopted_snapshot`) now goes through `_remove_snapshot`. It renames the snapshot to a
private `.<name>.removing-<pid>` tombstone in the same temp root, which is one atomic step for
observers, and then deletes the tombstone. A peer now sees either the complete snapshot or
nothing, and the existing `absent` handling applies. A waiter blocked on the lock still holds
the renamed inode's lock file; its marker read fails, and it reports `absent` as before.
Nothing changes per agent at 10k agents; this only affects controller-local temporary files.

## Human feedback

None recorded.

## Reusable lesson

Remove a directory that peers inspect or execute from by renaming it away first, never by deleting it in place.
