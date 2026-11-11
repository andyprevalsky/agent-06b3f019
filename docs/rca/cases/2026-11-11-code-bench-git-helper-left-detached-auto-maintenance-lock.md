---
id: 2026-11-11-code-bench-git-helper-left-detached-auto-maintenance-lock
date: 2026-11-11
title: code_bench archive walk hit a vanished objects/maintenance.lock because its git helper let Git newer than 2.51 detach auto-maintenance holding the lock
surface: agents
component: code-bench
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/benchmarks/code_bench.py _git ran commit/fetch with Git's default auto-maintenance, so Git newer than 2.51 (verified 2.56.1) daemonized `maintenance run --auto --detach` that owns objects/maintenance.lock after the command returned, and write_deterministic_tar_gz listed the lock before the daemon deleted it
symptoms:
  - "FileNotFoundError: [Errno 2] No such file or directory: '/tmp/pytest-of-runner/pytest-14/test_commit_fixture_rewritten_0/commit-locally-no-push/repo/.git/objects/maintenance.lock'"
  - "test_commit_fixture_rewritten_history_fails"
  - "repo/.git/objects/maintenance.lock"
  - "git maintenance run --auto --quiet --detach"
tags:
  - code-bench
  - git-fixture
  - git-auto-maintenance
  - detached-writer
  - flaky
  - agents-coverage-blackbox
sources:
  - PR #1915 deploy gate agents-coverage-blackbox at source 9905809a46e392997e834801a3c7adce87267a10 (FLAKY occurrence be7609ba9f2a48879ca405c3ba6a49a3)
  - commit 72186aa4dc98bb4c519b745f8482af747030936c (PR #1915 merge that added the quarantine marker)
repro: agents/benchmarks/code_bench_test.py::test_git_helper_never_starts_auto_maintenance
status: fixed
---

## Problem

`agents/benchmarks/code_bench_test.py::test_commit_fixture_rewritten_history_fails` failed once on a Blacksmith
runner inside the agents-coverage-blackbox benchmark domain and passed its rerun (FLAKY). The error was
`FileNotFoundError` on `.../commit-locally-no-push/repo/.git/objects/maintenance.lock`, raised by
`tarfile.add` inside `write_deterministic_tar_gz` while the test archived its workspace for grading. PR #1915
quarantined it as NOT_INTRODUCED.

## Diagnosis

1. The test commits through `code_bench._git` immediately before archiving (`_commit_all` then `_grade`).
2. `_git` ran git with default config. Since Git 2.47, commit and fetch start
   `git maintenance run --auto --quiet --detach` (confirmed with `GIT_TRACE2` on a locally built Git 2.51.0).
3. `maintenance_run_tasks` takes `objects/maintenance.lock`, then `daemonize()`s. In Git 2.51 the exiting parent's
   atexit handler still removed the lock (strace: parent `unlink` = 0, daemon `unlink` = ENOENT), so no race. Git
   2.56.1's `daemonize()` calls `reassign_tempfile_ownership(parent, child)` (`setup.c`), so the detached daemon owns
   the lock and deletes it after `git commit` has returned.
4. `write_deterministic_tar_gz` walks the whole tree first, then stats every path. When the daemon deletes the lock
   between the walk and `tar.add`, `lstat` raises the observed `FileNotFoundError`.

Repro on unchanged main (`72186aa4d`) with Git 2.56.1 built locally (`make NO_RUST=1`), calling the unquarantined test
body 25 times in each of 24 parallel workers: ~340 of 600 runs failed with the exact `maintenance.lock`
`FileNotFoundError`. With Git 2.43 (synchronous maintenance) and 2.51 the same harness passed every run, which is why
it never reproduced locally on the stock devbox git. After the fix the identical harness passed 600 of 600 under Git
2.56.1.

Deepest owned cause: the code-bench git helper, which builds fixture archives in production attachments, the test
workspaces and grader checks, did not pin auto-maintenance off, so a background writer could mutate a repo after the
helper returned. Relative of `2026-11-07-sharded-routing-fixture-cleanup-enotempty-git`, which fixed the same class only inside `original600-portable-operator.test.py`.

## Solution

`code_bench._git` now passes `-c maintenance.auto=false -c gc.auto=0` on every invocation (`_GIT_FIXED_CONFIG`), so no
git command it runs can leave a background writer. Command-line config does not change repo bytes, so fixture archives
and `base_sha` stay identical (`test_fixture_archive_is_deterministic` passes). This also protects
`build_fixture_archive` (commit + fetch then archive) used to materialize production `code-bench/<id>.tar.gz`
attachments. The grader's read-only `merge-base` call never runs maintenance.

Regression `test_git_helper_never_starts_auto_maintenance` records `GIT_TRACE2_EVENT` through a `_git` commit and
fetch and asserts no `maintenance`/`gc` child starts. It failed on the old helper under Git 2.43 and 2.56.1 and passes
with the fix under both. The quarantine marker on `test_commit_fixture_rewritten_history_fails` was removed; the test
body, assertions and timeouts are unchanged.

10k-agent behavior: no change in per-agent resources; one fewer short-lived git process per commit/fetch.

## Human feedback

None recorded.

## Reusable lesson

Pin `maintenance.auto=false` and `gc.auto=0` on every git helper that commits or fetches and then reads the repo, because Git newer than 2.51 hands the maintenance lock to a detached daemon that keeps writing after the command returns.
