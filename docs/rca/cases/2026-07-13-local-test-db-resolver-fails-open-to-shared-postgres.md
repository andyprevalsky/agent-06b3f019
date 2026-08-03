---
id: 2026-07-13-local-test-db-resolver-fails-open-to-shared-postgres
date: 2026-07-13
title: Local test DB selection keyed on mutable display identity and failed open to a shared, connection-exhausted Postgres
surface: harness
component: test-db-resolver
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: local blackbox/coverage DB resolver — worktree identity came from a mutable display name and an unresolved lookup fell through to a shared Postgres
symptoms:
  - blackbox/coverage runs connect to another worktree's database
  - local test run fails with Postgres connection exhaustion
  - test DB selection changes when the workspace display name is renamed
tags:
  - blackbox
  - coverage
  - postgres
  - worktree-isolation
  - fail-open
  - test-harness
sources:
  - PR #764
repro: none-recorded
status: fixed
---

## Problem

Local blackbox and coverage runs could bind to the wrong database. Test DB
ownership was derived from a mutable display identity, so renaming a workspace
changed which DB a run picked up; and when the lookup did not resolve, the resolver
fell through to a shared Postgres instance whose connections were already
exhausted, so the run failed for an unrelated reason.

## Diagnosis

Two defects in one resolver. First, the key: worktree-to-DB mapping was based on a
mutable display name rather than a stable per-worktree identity, so the mapping was
not invariant over the workspace's lifetime. Second, the failure mode: an
unresolved lookup **failed open** onto a shared, connection-exhausted Postgres
instead of failing closed. Fail-open is the deeper problem — it converts a
diagnosable configuration error into a confusing connection-exhaustion failure and
lets one worktree's tests touch another worktree's data.

## Solution

Local blackbox/coverage database selection is now stable per worktree and fails
closed: if the correct database cannot be resolved, the run errors instead of
silently attaching to a shared instance. The pre-fix repro of the resolver was
saved and confirmed to fail before the change, with the identical post-fix command
passing.

## Human feedback

The same PR codified the RCA requirement that a fix ship with a saved pre-fix repro
that fails and the exact same command passing post-fix — which is how this resolver
change was validated.

## Reusable lesson

Resource selection in a test harness must key on immutable identity and fail
closed — a fail-open fallback to a shared resource turns a config error into a
cross-worktree data hazard.
