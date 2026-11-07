---
id: 2026-11-07-sharded-routing-fixture-cleanup-enotempty-git
date: 2026-11-07
title: RunBenchShardedRouting fixture cleanup failed with ENOTEMPTY on .git on a Blacksmith VM while an unidentified writer created a top-level .git entry
surface: harness
component: original600-portable-operator-test
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: an unidentified creator of a top-level .git entry during shutil.rmtree of the sharded-routing fixture repository on the Blacksmith VM; the host never showed it
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
repro: python3 scripts/tests/original600-portable-operator.test.py RunBenchShardedRouting
status: open
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

## Human feedback

None.

## Reusable lesson

Make test-fixture repositories independent of host git configuration, never use `ignore_cleanup_errors` to hide a
cleanup race, and make cleanup failures self-describing so a single CI occurrence is diagnosable.
