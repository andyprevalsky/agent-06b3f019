---
id: 2026-10-18-controller-export-snapshot-raced-ext4-delayed-allocation-writeback
date: 2026-10-18
title: Controller export snapshot raced ext4 delayed-allocation writeback and retained disposable controllers
surface: infra
component: cloudbench-controller-export
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-controller-export.py:export (single unflushed strict snapshot compared allocated_bytes)
symptoms:
  - controller originals changed during export
  - GATE_EXPORT_PENDING machine=<id>; host retained, no release credit
  - "gate.pending.json PENDING_EXTERNAL_OWNER_LIVE export_verified false"
  - unknown normal export workload
tags:
  - cloudbench
  - controller-export
  - ext4
  - disposable-controller
sources:
  - benchmark run original600-1792319287448456235 (run600c shards 00/14/15/17/19, source a252045f5)
  - commit ab51294e8 (branch fix/controller-export-quiescence)
repro: scripts/tests/cloudbench-disposable-hub-finalize.test.py (QuiescingOriginalsExport) and scripts/tests/cloudbench-resume-controller-export.test.py (runner-owner, remote pending/retry)
status: fixed
---

## Problem

In run600c (600 copies over 20 disposable controllers), 5 of 20 controllers
(shards 00, 14, 15, 17, 19) wrote `/tmp/gate/controller-host-custody/pending.json`
`{"reason": "controller originals changed during export"}`. Their gates printed
`GATE_EXPORT_PENDING` and their runners idled with `gate.pending.json`
`PENDING_EXTERNAL_OWNER_LIVE`. The 256 GB workspace volume and the performance-8x
controller stayed allocated. The supported recovery tool refused the run with
`unknown normal export workload`, because it only accepted the run77 commit c9d4817.

## Diagnosis

- A read-only scan of shard-00 found no source file with an mtime or ctime in the
  export window (11:21:10–11:22:47Z). The only post-11:21:02 change was the custody
  directory itself. So the mismatch came from a field that a write did not stamp.
- `file_state` compares `allocated_bytes` (st_blocks). Some job logs were appended
  during the 30 s before export. On shard-00 and shard-14 these logs have 5 extents
  plus one 4 KiB extent-tree block (from `filefrag` and `st_blocks` minus the
  rounded size).
- ext4 delayed allocation maps the final append only at writeback, after
  dirty_expire (3000 cs). When that writeback makes a file cross from 4 to 5
  extents, ext4 allocates an extent block. st_blocks grows by 4096, while mtime,
  ctime, size and content stay the same. A local ext4 reproduction (6.1 kernel)
  showed this on 30 of 30 files, with mtime and ctime unchanged.
- The failing exports retired the Hub at 11:21:00–11:21:29, within one writeback
  window of the campaign's last appends. The 13 that succeeded started later or had
  no crossing file.
- `export()` took one unflushed snapshot and raised on any drift, with no flush,
  no repeat and no record of which path changed. The runner has no supported retry.
  It only consumes `export/disposable-export.verified.json`. The resume tool
  hard-coded c9d4817 and its host topology, and it asserted a writer-shaped
  pending that carried `record_sha256`.

## Solution

- `export()` calls `os.sync()` before every strict snapshot. If drift or a late
  writer appears, it discards the temporary archive and runs a fresh complete
  snapshot, at most 3 attempts with a 10 s settle. Each attempt keeps the same
  strict before/after equality and writer checks. A live writer still returns
  `live controller writers`, and persistent drift still fails closed. The pending
  file now names the changed paths and fields.
- The resume tool binds to the run's own config `source_ref`/`source_files`, its
  live `cloudbench-original600-runner.py --config <cfg> --config-sha256 <sha>
  --output <run>` owner, and the runner's own `gate.pending.json`. It accepts
  inline `gzip-base64` remote files and the collector's exception-shaped pending.
  It flushes and repeats only the refused-snapshot race with the run's original
  collector, and bounds each download by the authorized window.
- `cloudbench-unused-reservations.py` accepts the reviewed new collector hash.
  Its exclusion semantics are unchanged.
- At 10k agents: the work is per controller, with one sync and up to 3 snapshots.
  No shared resource is involved.

## Human feedback

None recorded.

## Reusable lesson

A strict byte/metadata snapshot that includes st_blocks must flush pending writeback
first, and must retry a fresh snapshot only while no writer is live. Delayed
allocation changes st_blocks with no mtime/ctime change.
