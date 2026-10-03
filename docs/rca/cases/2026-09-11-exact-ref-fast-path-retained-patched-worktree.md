---
id: 2026-09-11-exact-ref-fast-path-retained-patched-worktree
date: 2026-09-11
title: Exact-ref fast path retained the warm snapshot workspace patch
surface: infra
component: cloudbench-git-source-normalization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench-fetch-ref.sh treated a matching HEAD as proof that the tracked worktree matched the base commit
symptoms:
  - "already-at c5ea2229255378b25536386b557dd746c791501c"
  - "FATAL: could not apply uploaded local workspace patch"
  - "every isolated stack failed before the start barrier"
  - "run artifact tasks must be a list"
tags:
  - cloudbench
  - workspace-patch
  - git
  - warm-snapshot
sources:
  - PR #1299
  - fleet run 20260911-015210-16629
  - fleet run 20260911-020118-37743
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fetch_ref_restores_dirty_exact_sha_before_patch_replay
status: open
---

## Problem

On e42b11d6e, central dependency maintenance successfully applied the branch
patch, rebuilt dependencies, verified the exact ref and both fingerprints,
stopped the warm source, and published snapshot vs_a56XkOMV2e9h80PZ66x.
Its required two-Machine infrastructure canary then failed before either stack
reached the start barrier. Neither the canary nor the blocked polar-bu-034 retry
executed any agent. This contributes zero accepted slices.

Both captured driver logs report already-at c5ea2229255, then fail to apply the
uploaded patch across tracked source files. The downstream invalid result-artifact
message is a consequence of that startup failure, not the first bad boundary.
Private evidence is under `.context/fleet/runs/20260911-020118-37743/` and
`.context/acceptance/polar-worker-exit-retry2-live.log`. Canonical teardown sealed
both owned Machines and volumes and retired the exact recovery registry.

## Diagnosis

The warm snapshot intentionally holds dependency trees built from the branch
workspace. Applying its source patch leaves Git HEAD at the fetchable base SHA.
The shared fetch helper compared only HEAD and exited early when it matched,
leaving modified tracked files in place. Boot and driver git-sync therefore
accepted the already-patched tree as a clean base and tried to apply the same
patch again. A commit ID and its mutable worktree are separate state.

The old fast path avoids a previously expensive full-tree reset when HEAD
already matches. That performance optimization was too broad: it skipped
normalization even when tracked files were dirty. The owning defect predates the
warm-refresh fix, which made the missing case observable by correctly preserving
branch source in the dependency snapshot.

A real-Git regression runs the actual fetch helper at the exact SHA with clean,
unstaged, staged, mixed, index-only, and already-patched snapshot worktrees. In the initial five-case reproduction,
the clean control passes and all four dirty cases fail because tracked changes
survive. The snapshot case then runs the canonical patch preparation and replay.
The mixed case covers deletion, rename, staged addition, glob characters, and a
newline in a path. Independent review then reproduced an index-only case: stage
changed content and restore the working file to its base contents. Comparing
only HEAD to working files misses the dirty index. The sixth regression failed
before the additional cached-diff path collection; the evidence is
`fetch-exact-index-before.log`. The fixture prohibits network fetch, compaction, full checkout,
and full reset; it verifies that env files, installed dependencies, and unrelated
untracked files survive unchanged. Logs are `fetch-exact-dirty-before.log` and
`fetch-exact-dirty-after.log` under `.context/acceptance/`.

Archive searches covered already-at, patch does not apply, exact SHA skips reset,
and full-tree reset. The related warm-maintenance and boot-payload cases address
different boundaries; neither established a clean worktree for this fast path.

## Solution

Under the existing Git maintenance lock, enumerate tracked differences from the
matching base in both working files and index, with NUL-delimited paths and
rename detection disabled. Restore
only those paths, in both index and worktree, from the exact base. Literal
pathspecs preserve unusual filenames. Verify both tracked tree and index before
reporting success. Clean worktrees still perform no restore or network work.
Untracked files are left to the existing incoming-patch preparation policy,
which removes only files the incoming patch declares as newly created.

The path-list temporary is owned by this invocation and removed on every exit;
when Git runs as the app user, that user receives access to the temporary.
No timeout, recording bound, provider ceiling, dependency guard, or cleanup
criterion changed. Normal backstop remains 7200 seconds and validation is 300.

All six cases pass locally and are registered in the benchmark blackbox and
deploy controller gate. The maintenance fixture now invokes the actual fetch
helper instead of substituting a hard reset, so it no longer invents a clean-tree
contract the implementation has not proved. Linux passes 49 fetch/patch/refresh
cases and the shell fetch/locking suite. Independent provider reads confirm both
failed-canary Machines and volumes terminal, with their registry removed.
The full Linux benchmark blackbox passes. Independent follow-up review reran
all thirteen source/maintenance cases and approved the index-only correction.
The exact live Polar retry and ten consecutive slices remain pending.

## Human feedback

Finish without repeated permission requests. Keep a 120-minute normal backstop,
use five minutes temporarily for this validation, and count only ten consecutive
sequential cloud slices with zero infrastructure errors, exact teardown, and
durable evidence. Explain deploy benchmark selection and a global cap of twenty
after completing the work.

## Reusable lesson

Verify the tracked worktree as well as the commit ID before declaring an exact-source checkout ready for patch replay.
