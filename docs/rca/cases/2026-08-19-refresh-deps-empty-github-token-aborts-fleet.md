---
id: 2026-08-19-refresh-deps-empty-github-token-aborts-fleet
date: 2026-08-19
title: Fleet --refresh-deps aborted every task because warm-box git-sync used empty GITHUB_TOKEN
surface: infra
component: cloudbench-refresh-deps
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud --refresh-deps SYNC_CMD — optional box-side $GITHUB_TOKEN left AUTH_HDR empty, then `git fetch origin <feature-sha>` prompted for a username
symptoms:
  - "fatal: could not read Username for 'https://github.com': No such device or address"
  - "exact remote checkout failed"
  - "central dep refresh failed; refusing to provision task machines"
  - "git-syncing /data/repo →"
  - "healing warm snapshot (dep trees)"
tags:
  - cloudbench
  - refresh-deps
  - github-token
  - fleet
  - fetch-ref
sources:
  - PR #1001
  - commit 33c2d9d4f997f3a2db66c32c7bdc4b802eb16ef5
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_refresh_deps_git_sync_uses_controller_fetch_ref
status: fixed
---

## Problem

`scripts/run-bench` for the six AgentCard lifecycle tasks detached a fleet
(`20260819-185516-12113`) and never provisioned a task machine. The controller
started the shared warm source (`683e47df5094d8`), then `--refresh-deps` ran
`git fetch origin 33c2d9d4f…` over HTTPS. Git printed
`fatal: could not read Username for 'https://github.com': No such device or address`,
the controller logged `exact remote checkout failed` and
`central dep refresh failed; refusing to provision task machines`, and every
task stayed `starting` / `healing warm snapshot (dep trees)`.

## Diagnosis

Two contracts disagreed.

Guest drivers already fetch private SHAs through `scripts/cloudbench-fetch-ref.sh`
plus controller `CLOUDBENCH_GITHUB_TOKEN_B64` and fail closed when that token is
missing. `--refresh-deps` and `--refresh-wmh` instead built an optional
`AUTH_HDR` from box-side `$GITHUB_TOKEN`. The warm-box ssh login shell had no
token, so `AUTH_HDR` was empty and `git fetch` tried an interactive GitHub
username prompt.

`cloudbench_fetchable_ref` made that fetch necessary. It treated any `origin/*`
containment as guest-fetchable, so a SHA that existed only on the pushed
feature branch (`origin/cursor/…`) was sent to the warm box instead of
`origin/main` plus a workspace patch.

Archive searches (`exact remote checkout failed`, `could not read Username`,
`cloudbench refresh-deps warm snapshot`) found relatives (SSH readiness
fail-open, Auto-RCA `gh auth setup-git`) but not this empty-token maintenance
path. Novel relative of the 2026-07-15 dubious-ownership refresh-deps abort.

## Solution

`--refresh-deps` and `--refresh-wmh` now call `warm_source_fetch_ref`, which
uploads `cloudbench-fetch-ref.sh`, injects the controller GitHub token, and
fails closed when the token is missing. `cloudbench_fetchable_ref` only treats
`origin/main` ancestors as guest-fetchable; feature-only SHAs fall back to the
`origin/main` ancestor plus the workspace patch.

Cemented by
`test_refresh_deps_git_sync_uses_controller_fetch_ref` and the
`cloudbench_fetchable_ref` feature-branch case in
`scripts/tests/cloudbench-env.test.sh`.

## Human feedback

None recorded.

## Reusable lesson

Warm-box maintenance git-sync must use the same controller-token fetch-ref
helper as guest drivers — never an optional box-side `$GITHUB_TOKEN` that
silently becomes an HTTPS username prompt.
