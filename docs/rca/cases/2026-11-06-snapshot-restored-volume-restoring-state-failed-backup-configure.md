---
id: 2026-11-06-snapshot-restored-volume-restoring-state-failed-backup-configure
date: 2026-11-06
title: Snapshot-restored disposable Volumes failed provisioning because backup configuration required state created while Fly reported restoring for minutes
surface: infra
component: cloudbench-disposable-volume
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: scripts/cloudbench-disposable-volume.py configure inspect() required `state == created` on its first exact GET inside a 60 s deadline, while a snapshot-forked Volume reports `restoring`
symptoms:
  - "ValueError: Volume identity/state changed"
  - "❌ new disposable Volume backup setting was not verified; retaining exact ownership for teardown"
  - "provisioning failed (no machine) — skipping"
tags:
  - cloudbench
  - fly
  - volumes
  - snapshots
  - disposable-lifecycle
  - descend
sources:
  - benchmark run campaign-20261106-095011-2029870
  - fleet run 20261106-101956-2994291
  - task browser-auth-signup-fails-purchase-assistance
repro: scripts/tests/cloudbench-disposable-volume.test.py::Backup::test_snapshot_restore_waits_for_created_before_backup_update
status: fixed
---

## Problem

`/descend` batch 1 epoch 3 (campaign `campaign-20261106-095011-2029870`)
provisioned REAL primaries from snapshot `vs_pRyp2eZ65NwhqMYJLogB` with
`--snapshot-volumes`. Two of about 19 provisions (`r001-j0020.log:440-470`,
`r002-j0024.log:~585-603`) failed before any Machine was handed to a task.
`cloudbench-disposable-volume.py configure` → `inspect()` raised
`ValueError: Volume identity/state changed`, and the fleet printed `❌ new
disposable Volume backup setting was not verified; retaining exact ownership for
teardown`.

## Diagnosis

1. The clone receipt (`primary.log:1`) shows `mode=snapshot` and Volume
   `vol_4m3d6n3q9poqkp6v` `outcome=created`. The fleet's storage gate
   (`MOUNTABLE_VOLUME_STATES = {"created"}`) had also seen it `created`.
2. A live read-only listing of `navi-whisper-lux-bench` at 10:36Z showed two
   snapshot-forked 40 GB `cloudbench_data` Volumes in state `restoring` with
   `attached_machine_id: null`. Fly's flyctl binary also contains the
   `restoring` state name.
3. Polling those two Volumes every 20 s: `restoring` → `created` took 6.8
   minutes (created 10:36:46, `created` at 10:43:38) and 8.4 minutes (10:36:59 →
   10:45:22).
4. `configure` (`inspect()`, `scripts/cloudbench-disposable-volume.py`)
   required `state == created` on its first exact GET, under a fixed 60 s
   deadline. A snapshot restore that entered `restoring` after the storage gate
   therefore failed at once. Only fresh Volumes reliably satisfy that. This is
   the first-bad boundary.

## Solution

- Only for an explicit snapshot restore (`--snapshot-restored`), `inspect()`
  now treats `restoring` as a transition. It re-reads the exact Volume every
  `RESTORE_POLL_SECONDS=15` until it is `created`, bounded by
  `RESTORE_WAIT_SECONDS=900` (about 1.8× the slowest observed restore). The
  overall deadline is extended by the same amount, and only for snapshot
  restores.
- Unchanged:
  - The Volume ID is checked on every read.
  - `restoring` on a fresh Volume, and any other state, still fail closed
    immediately.
  - Mount, attachment, ownership and the idempotent backup-update rules are as
    before.
  - A restore that never settles fails without a verified receipt, and the fleet
    tears it down through exact ownership.
- The two existing suites, `cloudbench-disposable-volume.test.py` and its CLI
  test, are now registered in the deploy structural gates. Before this change
  only `scripts/test.sh` ran them.
- 10k-agent behaviour: at most 2 reads per 15 s per restoring Volume, for at most
  15 minutes, and only on the snapshot path.

## Human feedback

None recorded.

## Reusable lesson

Provider resources created from snapshots go through asynchronous restore
states. Gate them on the provider's own transition, with a bounded wait, instead
of assuming the fresh-resource state.
