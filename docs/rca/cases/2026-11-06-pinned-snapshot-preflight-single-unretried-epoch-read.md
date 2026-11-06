---
id: 2026-11-06-pinned-snapshot-preflight-single-unretried-epoch-read
date: 2026-11-06
title: Pinned-snapshot fleets refused because the preflight read the snapshot epoch from one unretried Fly listing that was still hydrating
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet CLOUDBENCH_SNAPSHOT_ID branch skipped the retried snapshot capture, so warm_deps_preflight called snapshot_created_epoch with a single live `FLY volume snapshots list`
symptoms:
  - "❌ warm snapshot freshness could not be verified; refusing maintenance"
  - "snapshot epoch exact snapshot absent"
  - "📌 pinned snapshot (CLOUDBENCH_SNAPSHOT_ID)"
tags:
  - cloudbench
  - fly
  - snapshots
  - provider-reads
  - descend
sources:
  - benchmark run campaign-20261106-094207-1884289
  - task planner-memory-blue-bottle-off
  - task browser-agent
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_pinned_snapshot_preflight_uses_the_retried_inventory_capture
status: fixed
---

## Problem

`/descend` batch 1 epoch 2 (campaign `campaign-20261106-094207-1884289`)
pinned `CLOUDBENCH_SNAPSHOT_ID=vs_pRyp2eZ65NwhqMYJLogB` and used
`--snapshot-volumes`, the workaround for the warm-image mismatch in
`2026-11-06-fresh-real-primaries-admitted-against-unproven-warm-image`. Of 17
concurrent one-task fleets, 7 refused before allocation with
`❌ warm snapshot freshness could not be verified; refusing maintenance` (for
example `r001-j0003.log:222-224`). The other 10 forked from the same snapshot
without trouble.

## Diagnosis

1. The unpinned branch reads `FLY volume snapshots list` up to six times. A
   failed or malformed read is not treated as absence, and a valid list that is
   still hydrating is retried until a usable snapshot appears.
2. The pinned branch only assigned `SNAP_ID` and left `SNAPSHOTS_JSON` empty, so
   `warm_deps_preflight` fell back to `snapshot_created_epoch "$SNAP_ID"`. That
   performs a single live listing.
3. With 17 controllers reading at once, Fly briefly returned valid lists
   without the pinned snapshot. The single read reported `snapshot epoch exact
   snapshot absent`, and the preflight refused. This is the first-bad boundary.
   The same fault was already handled in the unpinned path.

## Solution

- The retry loop is now one function, `capture_warm_snapshot_inventory`, used by
  both branches. With a required (pinned) snapshot ID it retries until that
  exact snapshot is listed complete, and refuses with an explicit
  provider-or-pin message after six reads.
- `warm_deps_preflight` reads the epoch from the captured inventory whenever one
  exists, rather than only after hydration, so it no longer issues a second
  unretried read.
- 10k-agent behaviour: the number of reads per fleet launch is unchanged; only
  the pinned branch adds the same bounded retry.

## Human feedback

None recorded.

## Reusable lesson

Every code path that reads the same provider listing must share one retried
capture. A one-off live re-read reintroduces the flake the shared path already
fixed.
