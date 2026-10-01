---
id: 2026-09-28-isolated-system-pg-cleanup-called-dead-docker
date: 2026-09-28
title: Isolated benchmark cleanup called Docker after a system Postgres startup failure
surface: harness
component: local-benchmark-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/local.py _stop_owned_db_from_stack_identity
symptoms:
  - "docker rm -f victoria-db-edmonton-bench-1790617093-57650-45866"
  - "smoke runner hung during cleanup after missing canonical base fixture"
tags:
  - benchmark
  - system-postgres
  - docker
  - cleanup
sources:
  - commit 81b4e16639
  - PR #1312
  - benchmark run 1790643794-90995-33148
repro: agents/tests/blackbox/benchmark.blackbox.py
status: fixed
---

## Problem

The local predeploy smoke batch used `ROSE_USE_SYSTEM_PG=true`. Its isolated
stack failed early because the current schema's canonical seed object had not
yet been published. During rollback, the runner issued `docker rm -f` for a
container it never created; Docker Desktop's dead engine left cleanup hung for
over a minute. The batch could not promptly report the real seed fixture error.

The same path recurred when the September 29 exact `spawn-sub-agents` rerun
aborted before service startup because the host had only 116 MiB free. Cleanup
called `docker rm -f victoria-db-foundry-fallback-bench-1790643794-90995-33148`
despite `ROSE_USE_SYSTEM_PG=true`; the Docker CLI hung for over 90 seconds.
After that CLI was terminated, the subsequent `docker volume rm` also hung.
The run directory contains only an empty `services.log`, so this was cleanup
of resources the run had never created.

## Diagnosis

Archive searches for `docker rm isolated benchmark system postgres cleanup
hangs` and `canonical base fixture unavailable new schema token smoke local`
found prior cache-key and Docker-probe cases at different boundaries. The path
here was a pre-manifest `run.sh` failure → `stop_services` →
`_stop_owned_db_from_stack_identity` → unconditional Docker removal. The
runner had already selected system Postgres, and `run.sh` itself dropped its
isolated system database on the seed failure. No Docker resource existed.

The failing local run in `.context/benchmarks/1790617093-57650-45866/`
showed `docker rm -f victoria-db-edmonton-bench-1790617093-57650-45866`
after the seed error. The focused command is
`PYTHONPATH=agents agents/venv/bin/python -m pytest -q agents/tests/unit/test_local_benchmark_system_pg_cleanup.py`.
Before the fix, the default-parent-env case failed with two Docker calls;
after the fix it reports `2 passed`. This catches the deeper path where
`start_services` adds `ROSE_USE_SYSTEM_PG=true` to the child only, leaving the
parent environment unset. The full unchanged smoke batch was rerun after the
canonical base fixture was published; its isolated stack reached running and
executed all six first-batch tasks, with task failures under separate RCAs.

The owning-boundary regression is
`PYTHONPATH=agents:agents/tests/blackbox agents/venv/bin/python agents/tests/blackbox/benchmark_local_cleanup.blackbox.py`.
With the buggy Docker cleanup temporarily restored, that unchanged command
exited 1 because `stop_services` invoked `docker rm` and `docker volume rm`
despite the missing parent flag. With the fix restored, it exited 0 and
reported `pre_manifest_system_postgres_skips_docker`. The test is included in
the agent blackbox coverage gate.

`stop_services` calls this pre-manifest identity cleanup from one place. Its
manifest cleanup already checks `use_system_postgres`, so no other Docker
cleanup path was implicated. The exact stopped manifest for the rerun confirms
the system database was owned and cleaned by `run.sh`.

Commit `129c9c084` removed the prior guard, its owning blackbox, and this
case file while narrowing a Foundry PR. Archive searches for `docker rm
isolated benchmark system postgres cleanup hangs` and `pre manifest benchmark
Docker daemon unresponsive system postgres` identify this incident as a
recurrence at the same first-bad boundary.

Two tests in the existing benchmark blackbox suite reproduced the current
bug. `test_local_system_postgres_pre_manifest_cleanup_skips_docker` failed
pre-fix with two unexpected Docker calls, then passed unchanged after the
fix. `test_local_pre_manifest_docker_cleanup_has_timeout` failed pre-fix with
`subprocess.TimeoutExpired`, then passed unchanged after the fix. Both were
run directly with `PYTHONPATH=.:tests/blackbox venv/bin/python -c` from
`agents/`, using `runpy.run_path('tests/blackbox/benchmark.blackbox.py')` to
invoke each named function. The existing Docker-owned cleanup test also
passed unchanged.

## Solution

Return before Docker cleanup for isolated POSIX stacks, whose startup always
forces system Postgres, including when the parent environment omits the flag.
Windows respects an explicitly selected system Postgres mode. This prevents a
dead Docker socket from hiding the actual startup failure and leaves system DB
cleanup to `run.sh`'s owning trap.

For the recurrence, `ServiceStack` records the Postgres mode chosen before
startup and carries it into rollback, so a missing manifest cannot make the
parent guess ownership from a workspace name. Both pre-manifest and
manifest-owned Docker removals now have a five-second subprocess timeout;
timeout and missing binary leave teardown bounded. The exact benchmark rerun
passed after this change: `ROSE_USE_SYSTEM_PG=true scripts/run-bench --local
spawn-sub-agents` finished 1/1 in 305 seconds on isolated stack
`.context/benchmarks/1790644161-9133-51113`. The prior aborted run's
controller exited after its hung Docker cleanup children were terminated;
`scripts/list-services.sh` showed no services from that run before restart.

## Human feedback

None recorded.

## Reusable lesson

Use the startup's selected resource mode during rollback rather than inferring
container ownership from an isolated workspace name.
