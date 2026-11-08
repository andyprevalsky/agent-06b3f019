---
id: 2026-11-07-sharded-routing-fixture-cleanup-enotempty-git
date: 2026-11-07
title: RunBenchShardedRouting fixture cleanup failed with ENOTEMPTY on .git because the fixture commit started Git 2.47+'s detached auto-maintenance repack
surface: harness
component: original600-portable-operator-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: RunBenchShardedRouting.checkout() committed ~580 loose objects with Git's default auto-maintenance enabled, so Git 2.55 setsid-detached a geometric repack whose in-process prune-packed and update-server-info recreated .git/objects/info/packs during shutil.rmtree
symptoms:
  - "OSError: [Errno 39] Directory not empty: '.git'"
  - "ERROR: test_full_runs_last_three_pass_cloud_tasks_at_k2_all_at_once (__main__.RunBenchShardedRouting"
  - "fixture cleanup of /tmp/tmpxwd72jlx failed: OSError(39, 'Directory not empty')"
  - "repo/.git/objects/info/packs mode 100600 size 1 mtime 0.005"
  - "git maintenance run --auto --quiet --detach"
tags:
  - deploy-command-structural
  - blacksmith
  - tempfile-cleanup
  - git-fixture
  - host-git-config
  - git-auto-maintenance
  - detached-writer
sources:
  - PR #1751 deploy gate deploy-command-structural at source 202a1bbddc (two consecutive Blacksmith attempts, same error)
  - commit 6596956652
  - PR #1760 deploy gate deploy-command-structural at source 6e347fb7f9 attempt 2 (archive devbox-closeout-private/pr1760-cdb8ce58/20261108-core.tar.gz.aesgcm)
repro: PATH=<git 2.55>/bin:$PATH python3 scripts/tests/original600-portable-operator.test.py RunBenchShardedRouting.test_fixture_repository_is_built_independently_of_the_hosts_git_configuration
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

## Earlier PR 1770 recurrence and fixture ownership guard

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
original error and UNVERIFIED result remain evidence. This describes the evidence available before the later Git 2.55 causal proof below; the later section supersedes the earlier OPEN diagnosis.

Current-source local verification: the full file passed **91 tests in 97.999 seconds** with
`agents/venv/bin/python scripts/tests/original600-portable-operator.test.py`. The actual uv Python 3.11.9 lacked pidfds
and re-executed under `/usr/bin/python3`; the decisive regression ran, rather than skipped. The tested source SHA256
was `7c856abf5847905b98f9a7db33745e858765e503b1f21627970ac142752a9840`. This is a current local pass on Git 2.43.0,
not a replacement for the historical Blacksmith 89-test error or proof of its cause.

Upstream semantics: [maintenance configuration](https://raw.githubusercontent.com/git/git/v2.55.0/Documentation/config/maintenance.adoc)
and [GC configuration](https://raw.githubusercontent.com/git/git/v2.55.0/Documentation/config/gc.adoc).

### Recurrence 2026-11-08 (PR #1760, source 6e347fb7f9) and causal proof

The error returned on the PR #1760 deploy, attempt 2. The new cleanup notes reported:
- `.git` mtime 0.005 s.
- The only entries left under `.git` were `objects/`, `objects/info/` and `objects/info/packs` (size 1, an empty pack
  list), all 0.005 s old.
- `fake-fleet`, written right after the fixture commit, was 0.353 s old.
- `live processes naming the fixture: none`.
- `host git: git version 2.55.0`.

Git writes `objects/info/packs` only in `update_server_info` (`server-info.c`, which also creates the leading
directories). `git repack` calls it last, after its in-process `prune_packed_objects` (`builtin/repack.c`).

The 2026-11-07 diagnosis ruled out auto-gc using the local Git 2.43 threshold (`gc.auto` about 6,700). That premise does
not hold on the VM:
- Since Git 2.47, `git commit` runs `run_auto_maintenance` → `prepare_auto_maintenance` (`run-command.c`), which starts
  `git maintenance run --auto --quiet --detach`. That process calls `setsid`, so nothing the test waits on owns it.
- The default unscheduled strategy is `geometric` (`builtin/gc.c`). Its trigger,
  `too_many_loose_objects(100)`, rounds the limit up to 256 and estimates the loose count as (files in
  `objects/17/`) × 256. It therefore fires when 2 or more objects fall in shard `17/`.
- The fixture's `scripts/` tree and copied members put 2 objects in that shard at every relevant source: 202a1bbddc
  (failed twice), 826c8cf8b8 and 9c6d9c3622 (passed), 27f76e593b (passed) and 6e347fb7f9 (failed once, passed
  otherwise). The repack therefore starts on every gate run. Whether a run fails is purely the race between that
  repack and the test body.
- `maintenance.auto=false` returns before any child is spawned.

Natural timing, with Git 2.55.0 built locally (`make NO_RUST=1`), no shim and no strace, on the old fixture:
- The detached repack finished 1.4 to 2.1 s after the commit.
- Test bodies after the commit lasted 1.5 s (`test_narrow_runs_keep_the_fleet_path_and_refuse_a_sharded_dry_run`,
  maintenance still alive at cleanup), 1.8 to 2.3 s (`test_full_runs_last_three_pass_cloud_tasks_at_k2_all_at_once`),
  and 2.8 to 7.3 s (the other `checkout()` tests).
- On the CI VM, the `fake-fleet` age puts the failing body at about 0.35 s.

Every `checkout()` test is exposed. Only the shortest bodies lose the race, and they lose it only when the repack's
final phase (prune plus `update_server_info`) lands inside `rmtree`. If the repack is still running earlier steps, those
fail against the deleted objects and leave nothing behind.

Repro, unchanged tests, natural: running the two shortest tests 25 times on the old fixture failed 2 times. One was
`OSError: [Errno 39] Directory not empty: '.git'` and the other `'repo'`, both in `test_narrow…`. The fixed fixture
passed 25 of 25.

Repro, widened window: a `GIT_EXEC_PATH` shim holds only the detached cruft `pack-objects` exit until cleanup begins.
With it, `test_full…` failed 4 of 5 runs with the gate's exact leftover set (`objects/info/packs`, size 1, nothing else
under `.git`, no live process). The fixed fixture passed 10 of 10, because maintenance is never spawned. `strace -f`
showed the chain: commit, then `maintenance run --auto --quiet --detach`, then `setsid`, then
`repack -d -l --cruft --write-midx`.

Fix (test-only): `disable_auto_maintenance()` sets `maintenance.auto=false` and `gc.auto=0` in the repository's own
config right after every fixture `git init` in this file. That covers `checkout()`, the supervisor-handoff fixture and
the manifest-eligibility fixture. Every Git write then completes inside a command the test waits on, on any Git version
and in any environment. The setting cannot live in the environment, because `cloudbench-env.sh` overrides
`GIT_CONFIG_COUNT` for its children.

Regression: the existing `test_fixture_repository_is_built_independently_of_the_hosts_git_configuration` now records
`GIT_TRACE2_EVENT` through fixture setup and a later commit, and asserts that no `maintenance`/`gc` child starts. Git
spawns that child on every commit whenever auto-maintenance is enabled, so the check is deterministic. It failed on the
old fixture under Git 2.43 and 2.55, and passes with the fix under both.

Repro scripts and logs are preserved privately with the deploy closeout archive.

## Human feedback

None.

## Reusable lesson

Disable Git auto-maintenance in every test-fixture repository that commits, because Git 2.47+ detaches it past the waited command; rule out tool behaviour using the CI host's version, not the local one.
