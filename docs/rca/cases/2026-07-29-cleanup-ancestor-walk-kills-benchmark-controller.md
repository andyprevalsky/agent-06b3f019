---
id: 2026-07-29-cleanup-ancestor-walk-kills-benchmark-controller
date: 2026-07-29
title: kill-services.sh walked UPWARD from a matched run.sh child and SIGTERM'd the benchmark controller that owned it
surface: infra
component: kill-services
classification: our-bug
problem_class: other
first_bad_boundary: add_pid_with_tree_and_ancestors — escalates from a matched run.sh child to its same-worktree ancestors
symptoms:
  - 'stage exit 143, "Received signal 15" on an in-flight run-predeploy-local smoke run'
  - a Step 5 stack startup sweep kills a benchmark controller
  - leaked Fly machines and volumes after a cleanup sweep
tags:
  - cleanup
  - benchmark
  - signals
  - process-tree
  - deploy
sources:
  - commit 8363b11a8
  - commit 0099c4e3bfa1
repro: scripts/tests/kill-services.test.sh
status: fixed
---

## Problem

`kill-services.sh` killed a benchmark controller from the outside. Hit for real
during a deploy: the Step 5 stack's startup sweep killed an in-flight
`run-predeploy-local` smoke run — stage exit 143, "Received signal 15". Benchmark
controllers own Fly machines, volumes and isolated stacks and reap them through
their own signal traps, so killing one from outside leaks paid infrastructure
(CLAUDE.md rule 27).

## Diagnosis

`run-predeploy-local` starts an ISOLATED `scripts/run.sh` as a child. That child
matches the run.sh root pattern the sweep looks for, and
`add_pid_with_tree_and_ancestors` then walks UPWARD through same-worktree
ancestors — escalating from "stop a stray service" to "SIGTERM the benchmark
controller that owns it". The kill set is assembled from both directions, so a
single guard is insufficient: `pid_tree` walks DOWN and never consults
`is_protected_process`.

This is also why `/deploy`'s Group 4 cannot actually run the smoke suite and the
Step 5 stack concurrently in one worktree.

### Recurrence on 2026-08-03

The identical failure recurred while deploying commit `0099c4e3bfa1`: an
unchanged `scripts/run-predeploy-local` smoke run exited 143 immediately after
the shared Step 5 stack was torn down. The permanent controller-survival test
failed on that revision with `benchmark controller (run-predeploy-local) was
killed unexpectedly`.

The deeper recurrence cause was delivery, not a new process-tree path. Commit
`8363b11a8` contained the two required guards, but it existed only on an
unmerged remote branch and was never an ancestor of `origin/main`. This RCA case
nonetheless landed on `main` with `status: fixed`, so the archive claimed a
guardrail the deployed code did not contain. Searches for both the literal
`Received signal 15` symptom and the behavioral `cleanup benchmark controller`
description found this case; comparing its cited fix commit with `origin/main`
exposed the missing delivery boundary.

## Solution

Two guards, matching the two directions the pid set is built from:
`is_protected_process` now refuses benchmark controllers, which also halts the
ancestor walk before it reaches one; and a final backstop filters the assembled
kill list. Cemented in `scripts/tests/kill-services.test.sh`: a stand-in controller
with an isolated `run.sh` child must survive a sweep — verified failing on the buggy
revision ("benchmark controller was killed unexpectedly") and passing after.

For the recurrence, the missing guards and regression test were applied directly
to the active deployment branch rather than relying on the orphaned commit. The
same checked-in test was again observed failing before the guard and passing after
it. A case must not be marked fixed merely because a fix commit exists somewhere;
the fix must be reachable from the target branch.

## Human feedback

None recorded.

## Reusable lesson

A cleanup sweep must never escalate upward from a matched child — protect
resource-owning controllers explicitly and filter the final kill list, since tree
walks in both directions can reach them. RCA closure also has a delivery
invariant: verify the cited fix is an ancestor of the branch being declared fixed.
