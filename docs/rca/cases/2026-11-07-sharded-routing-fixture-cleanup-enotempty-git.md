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
