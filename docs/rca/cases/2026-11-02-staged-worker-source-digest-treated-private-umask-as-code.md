---
id: 2026-11-02-staged-worker-source-digest-treated-private-umask-as-code
date: 2026-11-02
title: Staged worker source digest rejected identical private clones under umask 0077
surface: harness
component: deploy-test-cycle-source
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/deploy_test_cycle.py source hashed full POSIX permission bits instead of Git source modes
symptoms:
  - "prepared checkout differs from the frozen source"
  - "Same commit and file bytes but source 0644/0755 and clone 0600/0700"
tags:
  - deploy
  - isolated-workers
  - umask
  - source-provenance
sources:
  - PR #1662
  - commit 9de8ece5ca45a7036cacd8efcfd4ccce3e1edac4
  - agent ph79y59z4c9fzf7smas449zz518heama
repro: scripts/tests/deploy-test-worker.test.py Worker.test_private_umask_preserves_source_but_executable_changes_do_not
status: open
---

## Problem

Three real isolated worker preparations on the same frozen revision failed the
versioned prepare-checkout comparison before running any gate. Worker B found
11406 permission-only differences and no content differences: the private
shell umask created 0600/0700 files from Git's 0644/0755 source files.
The runtime symptom was `prepared checkout differs from the frozen source`.
No application gate result is inferred from preparation.

## Diagnosis

Gate: INTRODUCED. The new source() implementation bound all 0777 permission
bits. Git preserves file type and the owner executable bit, not group/other
read permissions produced by the caller's umask. Critical path: frozen Git
commit -> clone under 0077 -> identical files with private permissions -> full
mode digest differs -> prepare-checkout refusal. The first bad boundary is the
source identity, not Git cloning or the intentional private umask.

Archive searches: `prepared checkout differs from the frozen source` and
`umask file mode clone fingerprint`. The 2026-10-28 private-fixture-inherited-
umask case is related, but its private artifact reader was intentional; here
source identity incorrectly included host-local permission policy. This is a
new boundary rather than a recurrence of that fixture fix.

The permanent reproduction makes real committed plain/executable files, clones
through prepare_checkout under 0077, and requires equal source and gate-input
fingerprints. It also removes the owner executable bit and requires both
fingerprints to change. Exact command:

    python3 scripts/tests/deploy-test-worker.test.py Worker.test_private_umask_preserves_source_but_executable_changes_do_not

Before: exit1, ValueError at prepare_checkout, 1 test/1 error in0.094s.
After: exit0, same test OK in0.094s. Raw logs are retained in the originating
run's .context/preparation/umask-before.log and umask-after.log. Full owning
worker suite:26 tests OK in1.790s. No assertions were weakened.

## Solution

One source_mode() function now preserves file type plus owner executable mode
for both source and gate-input fingerprints. Contents, paths, links and commit
identity remain bound. No protected file permissions, private umasks, fixture
budgets, provider settings or gate outcomes need changing. The fix removes the
extra host-local identity rather than adding a fallback around a failed check.
Golden reference: not applicable, no prompt/agent-behavior approval hunk.
The deployment's independent review and final actual worker validation remain
pending; this record stays open until those proofs are accepted.

## Human feedback

The user requires all independent gates to run in parallel on isolated workers
and requires the deploy to continue through repair and production verification.
Keep Freedom and its protected instructions unchanged.

## Reusable lesson

Bind checkout provenance to Git source identity while preserving private
permissions created by each worker's umask.
