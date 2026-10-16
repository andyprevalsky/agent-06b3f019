---
id: 2026-10-16-private-dependency-overlay-cache-blocks-reuse-cleanup
date: 2026-10-16
title: Private dependency overlay backing files blocked the next checkout cleanup
surface: harness
component: cloudbench dependency overlay and git-sync boundary
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: application-user git clean traversed the root-private dependency overlay namespace created by the prior run
symptoms:
  - "could not open directory '.cloudbench-deps-overlays/': Permission denied"
  - "failed to remove .cloudbench-deps-overlays/: Directory not empty"
  - "FATAL: could not remove stale untracked worktree files"
tags:
  - dependency-overlay
  - pool-reuse
  - git-clean
sources:
  - PR #1525
  - commit 307500bde96ec874b79d635ee282696299557e34
  - agent root experiment 52; retained v41-command-79b30368e248cc65/response.json
repro: python3 scripts/tests/cloudbench-bootstrap-recovery.test.py DependencyOverlayCleanTests
status: open
---

## Problem

Both experiment 52 children verified the requested 570830 source twice, then failed at the following worktree cleanup. Each retained driver log is 1,219 bytes and contains the private overlay directory permission failure. The result artifacts were absent because startup stopped before the benchmark. Root subsequently confirmed both exact Machines stopped. The failed outcome and held claims are preserved.

## Diagnosis

The dependency producer creates `.cloudbench-deps-overlays` in the checkout, owned by root with mode0700. Its per-tree records bind the donor and checkout paths and hold upper/work directories for the writable dependency mounts. On reuse, the existing driver invokes `git clean -ffd` as the application user. This namespace is not ignored by the requested task commit. Git cannot traverse it and exits nonzero even though the exact source checkout succeeded. The first-use producer and next-use cleaner disagreed about ownership of private dependency state.

The registered reproduction calls the actual overlay producer with only the mount syscall replaced, then executes the actual driver cleanup block as UID1001 in a disposable Git checkout. Old source fails with the same permission and directory-not-empty messages. The corrected sequence preserves all backing bytes and ownership while removing unrelated stale files, including a nested lookalike directory. No provider or guest operations occur in these controls.

## Solution

Before cleanup, the existing dependency helper can validate this one reserved namespace without mounting, unmounting, deleting or changing ownership. Validation requires a physical root-owned mode0700 base and state directories, exactly known dependency targets, exact root-owned mode0600 single-link owner records bound to the donor and checkout, physical upper/work directories, and no tracked collision. Unknown, linked, mismatched or permissive state refuses cleanup.

Only after this validation does the driver pass an anchored exclusion for the root overlay namespace to the same application-user `git clean -ffd`. Other untracked files remain subject to cleanup. With no cache, the original command behavior is retained. The dependency synchronizer continues to validate fingerprints and manage the overlays later through its unchanged lifecycle. This does not exempt arbitrary caches or task output, or weaken source, native, claim, mount or environment guards.

## Human feedback

Root requested an owning first-use dependency-overlay to next-cleanup regression, no blanket git-clean waiver, preserved mounts/environment/workspace, and no native calls in the repair lane. The exact task/ref, deadlines and prior failed packets remain unchanged.

## Reusable lesson

Private helper state inside a reusable checkout needs an explicit validated ownership boundary before an application-user cleaner traverses it.
