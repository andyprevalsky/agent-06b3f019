---
id: 2026-11-07-history-overlay-stopped-git-repository-discovery
date: 2026-11-07
title: Private history OverlayFS stopped Git discovery at the filesystem boundary
surface: infra
component: deploy-worker-history-preparation
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: git rev-parse starts inside a private history mount and stops before reaching the original worker Git directory
symptoms:
  - "fatal: not a git repository (or any parent up to mount point)"
  - "Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set)."
  - history_ledgers_union_merged fails before checking merge attributes
tags:
  - deploy
  - overlayfs
  - git-discovery
sources:
  - PR #1716
repro: agents/tests/blackbox/span_history.blackbox.py
status: open
---

## Problem

Gate: INTRODUCED by operational preparation. The final round30 agents gate on
`ed47d406` passed 123 of 124 domains. The remaining span-history domain failed
when its unchanged union-attribute test invoked Git from the mounted history.
All 221 original baseline files were present and hash-verified, but the new
device boundary prevented upward repository discovery. The original aggregate
exit1 and UNVERIFIED outcome remain recorded.

## Diagnosis

The exact command returns exit128 in the real worker and succeeds at its root.
A tiny owned Git repository reproduces success on one device, the same failure
after mounting a private overlay, then success after binding discovery to its
existing Git directory and original worktree root. A pointer alone is an
invalid partial correction: Git reports the history directory as the root.

## Solution

An ignored operational helper records the original Git config, takes the
existing worker admission lock, verifies the terminal native supervisor and
privileged process-reference drain, and adds a history .git pointer together
with explicit local core.worktree naming the same existing worker root.
It verifies the original root, Git directory, five union attributes, all 221
baseline hashes and unchanged source/input/environment fingerprints. It creates
no second worktree and changes no test assertion or process environment.

The unchanged native span-history domain passes all fourteen checks after
actual application. The complete agents gate still requires a source-bound
rerun; this case stays open until that acceptance passes. Restoration removed
only the exact owned pointer and restored original Git config before the old
views were unmounted. No original history or failed evidence was deleted.

Approval: not applicable (no approval-gated hunk).

## Human feedback

The user required completing deployment. Independent preparation preserved
the actual failure and distinguished the owning-domain pass from full-gate
credit.

## Reusable lesson

Complete bytes and private writes do not prove repository identity across a
mount. Exercise the actual Git operations from the mounted input directory.
