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
The earlier investigation found about 560 loose objects against a gc threshold near 6,900 and treated automatic
GC as ruled out; that count did not identify the writer or establish the lifetime of all automatic maintenance. One real
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

## Recurrence and fixture ownership guard

A subsequent Blacksmith run using Git 2.55.0 failed at the same fixture removal boundary: 89 tests in 63.827 seconds,
one error, with the enclosing result UNVERIFIED and `complete=false`. The assertions of
`RunBenchShardedRouting.test_full_runs_last_three_pass_cloud_tasks_at_k2_all_at_once` had completed. Its native notes
showed `.git/objects/info/packs` with mtime/ctime ages of 0.003 seconds. The later scan found no process naming the
fixture. The writer remains **UNIDENTIFIED**; a later empty scan cannot identify the process that wrote earlier.
Native worker cleanup succeeding does not turn this fixture-removal error into a pass.

The fixture now appends `gc.autoDetach=false` and `maintenance.autoDetach=false` to its command-scoped Git environment,
preserving inherited `GIT_CONFIG_COUNT` entries and removing repository-location environment overrides so a disposable
fixture cannot write through an inherited Git directory, worktree, index or object directory. Its Git commands and
`run-bench` children share that environment.
Automatic maintenance stays enabled with its normal policy; when triggered it must finish before the owning Git
command returns. No persisted repository/global Git configuration, removal errors, cleanup retries, routing
assertions, concurrency, or existing deadlines are changed. Git 2.55 documents the separate maintenance detach
control and its fallback to the GC control; older Git uses `gc.autoDetach`.

The regression `test_git_auto_maintenance_stays_owned_until_its_native_work_finishes` uses real Git in a disposable
repository. It forces maintenance with `gc.auto=1` and ages only its own unreachable fixture objects so Git invokes
its native recent-objects hook under the ordinary prune grace period. The hook holds a FIFO barrier. The test checks
native process ancestry while work is held, releases the barrier, and drains the exact GC process and any proven
Git maintenance ancestors with pidfds before removing the fixture. Injected readiness and owner-wait failures exercise
the same release/drain path; raced-exit and foreign-hook controls verify that ESRCH does not skip later handles and
that the initial hook must belong to the fixture. Unknown ownership fails and retains the control directory rather
than deleting it. The
existing `pidfd_interpreter.py` route re-executes Linux CI tests under a capable interpreter when the uv Python lacks
the API; the decisive regression does not skip on Linux for a missing Python binding. A deliberate detached positive control proves
that native maintenance can outlive its commit. The same ownership assertion fails with the old helper and passes
with the foreground guard. The separate inherited-config test confirms unrelated entries and the auto-GC threshold
survive unchanged. These are synthetic forced-maintenance controls, not a reconstruction of the historical writer.

The exact regression command is:

```bash
python3 scripts/tests/original600-portable-operator.test.py RunBenchShardedRouting.test_git_auto_maintenance_stays_owned_until_its_native_work_finishes
```

Before the helper change it failed with `AssertionError: False != True : fixture helper let native auto-maintenance
outlive its commit`. The identical test passed after the helper change. This local ownership proof ran on Git 2.43.0;
it is not an execution of the historical Git 2.55.0 failure.

The original routing test and its assertions, host-config isolation test, and cleanup-error propagation test remain
unchanged. Their current-source validation is distinct from the historical 89-test failure. This is a general fixture
ownership repair, **not a claim to have fixed or identified the historical root cause**. This RCA stays OPEN, and the
original error and UNVERIFIED result remain evidence.

Current-source local verification: the full file passed **91 tests in 97.999 seconds** with
`agents/venv/bin/python scripts/tests/original600-portable-operator.test.py`. The actual uv Python 3.11.9 lacked pidfds
and re-executed under `/usr/bin/python3`; the decisive regression ran, rather than skipped. The tested source SHA256
was `7c856abf5847905b98f9a7db33745e858765e503b1f21627970ac142752a9840`. This is a current local pass on Git 2.43.0,
not a replacement for the historical Blacksmith 89-test error or proof of its cause.

Upstream semantics: [maintenance configuration](https://raw.githubusercontent.com/git/git/v2.55.0/Documentation/config/maintenance.adoc)
and [GC configuration](https://raw.githubusercontent.com/git/git/v2.55.0/Documentation/config/gc.adoc).

## Human feedback

None.

## Reusable lesson

Make test-fixture repositories independent of host git configuration, never use `ignore_cleanup_errors` to hide a
cleanup race, and make cleanup failures self-describing so a single CI occurrence is diagnosable.
