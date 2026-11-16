---
id: 2026-11-06-fresh-real-primaries-admitted-against-unproven-warm-image
date: 2026-11-06
title: Fleets admitted fresh REAL primaries against another owner's warm image, so every guest FATALed in dep_sync after the snapshot-only preflight passed
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet warm_deps_preflight proved only the donor snapshot, while fresh REAL primaries boot the donor's current image and copy deps from its baked /app (scripts/cloudbench-sync-deps.sh node fingerprint check)
symptoms:
  - "[cloudbench] FATAL: warm image/volume JavaScript dependencies do not match the checked-out ref"
  - "infra canary preflight FAILED (exit=1) — refusing capability fleet (INFRA)"
  - "every isolated stack failed before the start barrier"
tags:
  - cloudbench
  - fly
  - dependencies
  - warm-image
  - fresh-volumes
  - descend
sources:
  - benchmark run campaign-20261106-091756-1412999
  - fleet run 20261106-091846-1434693
  - task planner-memory-blue-bottle-off
  - task browser-agent
  - task browser-auth-saved-password-retry
  - task browser-doordash-food-plan-grocery-cart-reauth
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fresh_real_primaries_require_an_image_dependency_proof
status: fixed
---

## Problem

`/descend` batch 1 (run `descend-failed-neverrun-20261106`, campaign
`campaign-20261106-091756-1412999`, main `f881520867`) ran 60 one-task fleets.
The campaign's infra canary (`browser-auth-saved-password-retry`,
`browser-doordash-food-plan-grocery-cart-reauth`) and the first capability jobs
(`planner-memory-blue-bottle-off`, `browser-agent`) all lost their guests about
eight minutes after admission. Each guest's `cloudbench-driver.log` (fleet run
`20261106-091846-1434693`) shows `STEP dep_sync` followed by `FATAL: warm
image/volume JavaScript dependencies do not match the checked-out ref`. The
controller had printed `using recorded proven snapshot: vs_pRyp2eZ65NwhqMYJLogB`
and `warm snapshot dep trees match the current ref (fast bring-up)` first.

## Diagnosis

1. REAL tasks default to fresh volumes (`FRESH_VOLUMES` defaults to 1;
   `primary_clone_storage_mode` returns `fresh` for `real`).
2. A fresh primary is cloned from the donor and boots the donor's current image,
   with an empty volume. `cloudbench-sync-deps.sh` finds no installed marker and
   compares the checkout's node fingerprint with the image's baked `/app`.
3. Another owner had run `--setup` from a branch with different JavaScript
   manifests at 08:51Z, activating `cloudbench-warm-20261106-085142-2305504` on
   the shared donor `683e47df5094d8`. Main's node fingerprint (`df9fc67a8004…`)
   matched the completed snapshot `vs_pRyp2eZ65NwhqMYJLogB`, not that image.
4. `warm_deps_preflight` proves the snapshot only. Nothing recorded which
   manifests an activated image was built from, so no controller check could
   see the mismatch before allocation. This is the first-bad boundary.

The 2026-07-15 case
(`2026-07-15-warm-image-baked-deps-fingerprint-mismatch-fatals-before-start-barrier`)
treated the same symptom operationally by rebuilding the image. That cannot
hold on a donor shared by several branches: each `--setup` flips the image for
everyone else.

## Solution

- `run-bench-cloud --setup` now publishes donor metadata
  `rose_cloudbench_image_deps = "<image-ref> <node-fp> <python-fp>"` after it
  builds and activates an image, computed from the same build context with the
  same fingerprint functions the guest uses. A prebuilt `WARM_IMAGE_REF` of
  unknown provenance publishes nothing.
- `run-bench-fleet` runs `fresh_image_deps_admission` right after
  `warm_deps_preflight`. Fresh REAL primaries are kept only when the donor's
  current image carries a proof for exactly that image and this checkout's
  fingerprints. Otherwise REAL primaries restore the snapshot the preflight just
  proved. An explicit fresh-only request (`--fresh-volumes`, fresh target region
  or unique-zone placement) is refused before allocation instead.
- Shared helpers live in `scripts/lib/cloudbench-env.sh`:
  `cloudbench_publish_machine_metadata`, `cloudbench_publish_warm_image_deps` and
  `cloudbench_warm_image_deps_match`.
- Residual race: the donor image can still change between this check and the
  clone. Closing it fully would need image-pinned clones.
- 10k-agent behaviour: one inventory lookup per fleet launch, with no per-agent
  work.

## Human feedback

None recorded.

## Reusable lesson

A preflight must prove the artifact the guest actually consumes. When storage
modes take dependencies from different sources, bind each source to the
checkout's fingerprints before admitting that mode.
