---
id: 2026-11-15-cohort-successor-saw-exiting-winner-as-live
date: 2026-11-15
title: A cohort reconciliation successor refused recovery because the killed winner released its flock before becoming a zombie
surface: harness
component: cloudbench-cohort-reconcile
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "scripts/cloudbench-cohort-reconcile.py:retired — accepted only state 'Z'; do_exit() releases the winner's flock in its file teardown before exit_notify() makes it a zombie, so a successor that just acquired the lock read the dead winner as 'R' and raised 'live reconciliation winner lost lock'"
symptoms:
  - "actual full scanner did not reach fixture metadata boundary"
  - "live reconciliation winner lost lock"
  - "test_dead_winner_without_completion_is_recovered_by_successor"
tags:
  - cloudbench
  - flock
  - process-exit
  - zombie
  - pf-exiting
  - load-sensitive
  - flake
sources:
  - PR #2258
  - commit 2d99b77abfd3ae2f23fbcb16e48ef9c3d41a702d
  - PR #2104
  - commit 31641a67091091fa3920a6049773281b827fd2aa
repro: scripts/tests/cloudbench-cohort-reconcile.test.py
status: fixed
---

## Problem

In PR #2104's `new-test-stability` gate, `test_dead_winner_without_completion_is_recovered_by_successor`
failed once under load with `actual full scanner did not reach fixture metadata
boundary`: the successor never began its own scan after the winner was
SIGKILLed. The original run log was not available to this repair; an 80-run
CPU-load repro of that test (8 concurrent, 8 hogs) passed 80/80.

## Diagnosis

1. The successor's `cloudbench-cohort-reconcile.py acquire` blocks in
   `flock(LOCK_EX)` on the cohort lock. When it wakes it finds the winner's
   lease and accepts takeover only if `retired()` reports the winner dead.
2. `retired()` accepted only `/proc/<pid>/stat` state `Z`. The kernel's
   `do_exit()` sets `PF_EXITING`, then closes files; the deferred `__fput`
   drops the flock. Only later does `exit_notify()` make the task a zombie. In
   that window the lock is free, but the winner still reads `R`.
3. Measured, by killing a bash flock holder and reading its stat as soon as the
   lock was acquired: at idle 300/300 were `Z`. With 24 CPU hogs, 10/300 were
   `('R', PF_EXITING)` with no extra fds, and 94/100 with 1000 extra fds. With a
   256 MB unlinked tmpfs file released after the lock, 20/20 were
   `('R', PF_EXITING)` even at idle.
4. Seeing `R`, the helper raised `live reconciliation winner lost lock`. The
   successor exited before reaching registry metadata, which is the reported
   `wait_entered` failure.

Proof: the new `test_dead_winner_observed_mid_exit_is_recovered_by_successor`
holds that window open: the winner holds a 512 MB unlinked tmpfs file, and the
test stops it, retires its scan children, then SIGKILLs it, so the winner is
the last lock holder. On main it failed 10/10 with `actual full scanner did not
reach fixture metadata boundary`; on the fix it passes.

## Solution

`retired()` also treats a task whose stat flags carry `PF_EXITING` (0x4) as
retired. The flag is set at `do_exit()` entry and never cleared, an exiting
task never runs user code again, and the caller's held flock proves the task
released the lock. The final birth comparison, repeated after the state read, now treats a
changed or missing birth as retired (the winner was reaped in between). Only
the same process is judged by its state (CodeRabbit finding on PR #2258;
regression `test_winner_reaped_after_the_state_read_is_retired`, which fails on
the first fix). The macOS `ps` path is unchanged. The regression's negative control rewrites the lease to a live process
with no terminal receipt and asserts the successor is still refused with
`live reconciliation winner lost lock`, without rescanning. 10k agents: one
extra integer parse per takeover.

Shipped in PR #2258 (merged 2d99b77abf, 2026-11-16); all 17 deploy gates passed on 8277c90e7e and production semantics passed (verified by descendant 530b71fe93).

## Human feedback

None recorded.

## Reusable lesson

A process that released a lock by dying may not be a zombie yet; when liveness is read after acquiring its lock, treat PF_EXITING as dead.
