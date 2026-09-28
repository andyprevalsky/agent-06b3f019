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
repro: agents/tests/blackbox/benchmark_local_cleanup.blackbox.py
status: fixed
---

## Problem

The local predeploy smoke batch used `ROSE_USE_SYSTEM_PG=true`. Its isolated
stack failed early because the current schema's canonical seed object had not
yet been published. During rollback, the runner issued `docker rm -f` for a
container it never created; Docker Desktop's dead engine left cleanup hung for
over a minute. The batch could not promptly report the real seed fixture error.

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

## Solution

Return before Docker cleanup for isolated POSIX stacks, whose startup always
forces system Postgres, including when the parent environment omits the flag.
Windows respects an explicitly selected system Postgres mode. This prevents a
dead Docker socket from hiding the actual startup failure and leaves system DB
cleanup to `run.sh`'s owning trap.

## Human feedback

None recorded.

## Reusable lesson

Use the startup's selected resource mode during rollback rather than inferring
container ownership from an isolated workspace name.
