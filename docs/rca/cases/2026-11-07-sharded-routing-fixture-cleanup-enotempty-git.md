---
id: 2026-11-07-sharded-routing-fixture-cleanup-enotempty-git
date: 2026-11-07
title: RunBenchShardedRouting fixture cleanup failed with ENOTEMPTY on .git because git 2.55 detached geometric auto-maintenance rewrote objects/info/packs during removal
surface: harness
component: original600-portable-operator-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: hermetic_git_env kept Git defaults, and Git >= 2.54 defaults to geometric auto-maintenance that the fixture commit (~580 loose objects) triggers and detaches; its repack recreates .git/objects/info/packs while shutil.rmtree removes .git
symptoms:
  - "OSError: [Errno 39] Directory not empty: '.git'"
  - "ERROR: test_full_runs_last_three_pass_cloud_tasks_at_k2_all_at_once (__main__.RunBenchShardedRouting"
  - "original600-portable-operator exit=1 duration=62.5s"
tags:
  - deploy-command-structural
  - blacksmith
  - tempfile-cleanup
  - git-fixture
  - host-git-config
sources:
  - PR #1751 deploy gate deploy-command-structural at source 202a1bbddc (two consecutive Blacksmith attempts, same error)
  - commit 6596956652
  - PR #1775 deploy gate deploy-command-structural at source c109a7819a (third occurrence, host git 2.55.0)
repro: python3 scripts/tests/original600-portable-operator.test.py HermeticGitEnv RunBenchShardedRouting (the regression reads the effective maintenance.auto/gc.auto; red on the old hermetic_git_env)
status: fixed
---

## Problem

The Blacksmith gate `deploy-command-structural` for PR #1751 failed twice in a row at source 202a1bbddc. One suite,
`scripts/tests/original600-portable-operator.test.py`, errored in
`RunBenchShardedRouting.test_full_runs_last_three_pass_cloud_tasks_at_k2_all_at_once`. Its assertions passed; the error
came from fixture cleanup: `tempfile.TemporaryDirectory().__exit__` -> `shutil.rmtree` -> `OSError: [Errno 39]
Directory not empty: '.git'`. The same gate passed on the same VM type at 826c8cf8b8 and 9c6d9c3622, and the test passes
locally in about one second.

## Diagnosis

`rmtree` lists `.git`, deletes every entry and then fails on `rmdir('.git')`, so something created a top-level entry
after the listing. The code the failing test executes is byte-identical between the last passing and the first failing
source (test file, `scripts/run-bench`, `scripts/lib/cloudbench-env.sh`, `cloudbench-full-selection.py`, the
`agents/benchmarks` modules the fixture copies); `cp -a scripts` copies four more tracked files, all new tests and
fixtures. Local tracing (strace -f, 122 execs, all gone before the test ends), 30 serial and 20 CPU-throttled
(`CPUQuota=100%`) repetitions, forced `gc.auto=1`, IO and fsync pressure and the 4-suite concurrent layout all passed.
The fixture has about 560 loose objects against a gc threshold near 6,900, so auto-gc is ruled out. One real
inconsistency exists: the fixture's `git init/add/commit/rev-parse/update-ref` calls inherited the host's system and
global git configuration, while the fixture's `run-bench` calls set `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1`.
The VM's system config carries git-lfs filters (`filter.lfs.required=true`). The writer was never observed.

## Solution

Commit 6596956652 (test-only): the fixture's git calls now use the same isolated configuration as the CLI calls
(regression `test_fixture_repository_is_built_independently_of_the_hosts_git_configuration`, which fails on the old
behaviour because a host `core.hookspath` leaked in), and `checkout()` removes its directory through
`fixture_directory()`, which on a failed removal re-raises the original `OSError` with notes naming the remaining
entries (type, size, age), live processes whose cwd, open files or argv name the fixture, and a credential-free summary
of the git configuration sources (regression `test_a_failed_fixture_removal_names_the_blocking_entry_and_its_writer`).
The next gate run at 27f76e593b passed the suite. The root cause stays unproven: the hardening is the one
inconsistency found, not a demonstrated cause; if the error returns, the new notes name the writer.

## Follow-up (PR #1775, 2026-11-08)

The third occurrence printed the new notes: the only remaining entry was a freshly recreated
`repo/.git/objects/info/packs` (size 1, about 5 ms old), no live process named the fixture, and the host git was 2.55.0.
Git 2.54 made geometric auto-maintenance the default; its trigger is about 256 loose objects (the fixture has about 580,
so the earlier 6,900-object gc analysis no longer applies) and it detaches by default. The background
`git repack -d -l --cruft --write-midx` ends with `update_server_info()`, which recreates `objects/info/packs`. Reproduced
locally with git 2.55.0 built from source plus a hook that delays the repack until cleanup starts: 3/3 FAIL on both
c109a7819a and main cdb8ce580 with the CI signature, 3/3 pass with `maintenance.auto=false`. The devbox git 2.43 runs the
old foreground gc, which is why earlier local tracing never saw a writer.

Fix: `hermetic_git_env()` appends `maintenance.auto=false` and `gc.auto=0` through `GIT_CONFIG_COUNT` (keeping inherited
entries), so neither the fixture nor the run-bench calls it wraps ever start detached maintenance. Regression
`HermeticGitEnv.test_fixture_git_never_runs_detached_auto_maintenance` reads the effective values (fails on the old
function) and checks inherited entries survive.

## Human feedback

None.

## Reusable lesson

Make test-fixture repositories independent of host git configuration, never use `ignore_cleanup_errors` to hide a
cleanup race, and make cleanup failures self-describing so a single CI occurrence is diagnosable.
