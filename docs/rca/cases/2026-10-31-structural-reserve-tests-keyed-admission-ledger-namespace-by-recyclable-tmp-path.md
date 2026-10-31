---
id: 2026-10-31-structural-reserve-tests-keyed-admission-ledger-namespace-by-recyclable-tmp-path
date: 2026-10-31
title: Structural reserve tests keyed the host-wide cleanup-admission ledger namespace by a recyclable pytest tmp_path string
surface: infra
component: cloudbench-cleanup-admission-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fleet_cleanup_releases_emergency_disk_reserve_after_pending_member_departure derived its /tmp/rose-cloudbench-cleanup-admission-<uid>/<namespace> key from sha256(str(tmp_path)) alone
symptoms:
  - "FAILED benchmarks/cloudbench_dependency_sync_test.py::test_fleet_cleanup_releases_emergency_disk_reserve_after_pending_member_departure[departed]"
  - "assert not admission.exists()"
  - "AssertionError: assert not True"
  - "where exists = PosixPath('/tmp/rose-cloudbench-cleanup-admission-1002/54625263166233425').exists"
  - "benchmark-live-results[3/6]: exit=1"
tags:
  - deploy-structural-gate
  - cloudbench
  - cleanup-admission-ledger
  - pytest-basetemp
  - flake
sources:
  - PR #1660 deploy run 20261031-200340-3743984, lane deploy-command-structural log deploy-command-structural-20261031-200417-3760208.log
  - commit f039142da (failing deploy head; fix on branch fix/cloudbench-admission-ledger-isolation)
  - memory:cleanup-admission-ledger-global-state (2026-10-27 cohort-fixture fix 07f189a5a for the same class)
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fleet_cleanup_releases_emergency_disk_reserve_after_pending_member_departure
status: fixed
---

## Problem

Deploy 12 (PR #1660, head `f039142da`) failed lane `deploy-command-structural`,
gate `benchmark-live-results[3/6]`, with the test's first precondition:

```
tmp_path = PosixPath('/var/tmp/pytest-of-boxes/pytest-2/test_fleet_cleanup_releases_em0')
>       assert not admission.exists()
E        +    where exists = PosixPath('/tmp/rose-cloudbench-cleanup-admission-1002/54625263166233425').exists
```

The PR changed no cloudbench code. Runtime evidence at failure time:

- `/tmp/rose-cloudbench-cleanup-admission-1002/54625263166233425/` existed with a
  single empty `admission.lock`, birth/mtime/ctime **2026-10-28 03:03:43 UTC** —
  three days before the failing run (20:04 UTC on 2026-10-31). No `state.json`.
- `54625263166233425 == int(sha256("/var/tmp/pytest-of-boxes/pytest-2/test_fleet_cleanup_releases_em0")[:14], 16)`,
  i.e. the key of the same test at the same tmp_path string in an earlier run.
- `/var/tmp/pytest-of-boxes` numbering had restarted: it was at `pytest-2` at
  20:04 and at `pytest-22` by 20:17 the same day (the root is recreated when it
  is removed, e.g. by basetemp garbage handling), so `pytest-2/...` recurred.
- The host-wide ledger root held **409** namespace directories accumulated since
  2026-10-28; many hold only `admission.lock`.

This refutes both initial hypotheses as stated: the entry was not a concurrent
holder (it predates the run by three days) and the release path under test was
never reached (the precondition fires before the reserve subprocess runs).

## Diagnosis

Critical path: pytest allocates `tmp_path` under the numbered basetemp → the
test computes `namespace = sha256(str(tmp_path))[:14]` → the production
`reserve_cleanup_disk_space` (its `st_dev` faked to that namespace via
`sitecustomize`) creates `/tmp/rose-cloudbench-cleanup-admission-<uid>/<namespace>/`
→ the test's `finally` removes it.

1. **Why did the precondition fail?** A directory already existed at the key.
   Evidence: the 2026-10-28 birth time and bare `admission.lock`.
2. **Why did a stale entry exist?** The ledger is deliberately persistent,
   host-wide state (see `cleanup-admission-ledger-global-state`); cleanup only
   runs in the test's `finally`, so a run killed mid-reserve (session restart,
   memory watchdog, gate timeout) leaves its entry forever. Evidence: 409
   leaked namespaces, this one without `state.json`.
3. **Why did a new run collide with it?** The key is derived from the tmp_path
   string alone, and pytest basetemp numbering restarts whenever the basetemp
   root is recreated, so the same string recurs. Evidence: `pytest-2` on
   2026-10-28 and again on 2026-10-31.
4. **Deepest owned cause:** three tests in
   `agents/benchmarks/cloudbench_dependency_sync_test.py` (lines ~26454, ~32962,
   ~33075) still keyed the namespace by tmp_path only, although the repo had
   already fixed this class for the cohort fixture (`07f189a5a`, 2026-10-27:
   `sha256(f"{work}:{pid}:{time_ns}")`) and the barrier test (`os.urandom(5)`).
   This is a recurrence of that class in the sibling tests the earlier fix did
   not cover; no archive case existed for it (memory note only).

Local reproduction (production ledger API, no hand-made files), on the buggy
revision from `agents/` with the venv:

```
python /var/tmp/rca-admission/holder.py <basetemp> <holder> <agents>   # runs the real
  reserve_cleanup_disk_space with st_dev faked to sha256("<basetemp>/test_fleet_cleanup_releases_em0")
python -m pytest benchmarks/cloudbench_dependency_sync_test.py -p no:cacheprovider -q \
  --basetemp=<basetemp> -k "test_fleet_cleanup_releases_emergency_disk_reserve_after_pending_member_departure and departed"
```

Pre-fix: `FAILED ...[departed]` at line 33077, `assert not admission.exists()`,
`PosixPath('/tmp/rose-cloudbench-cleanup-admission-1002/71836563977797327')` —
the identical assertion and mechanism as the deploy failure.

## Solution

Test-side fix, mirroring the accepted cohort-fixture pattern, in
`agents/benchmarks/cloudbench_dependency_sync_test.py`:

- All three reserve tests now key the ledger namespace per run:
  `sha256(f"{tmp_path}:{os.getpid()}:{time.time_ns()}")[:14]`, so a leftover or
  concurrent entry at a recycled tmp_path string can never match.
- `test_fleet_cleanup_releases_emergency_disk_reserve_after_pending_member_departure`
  now plants a leftover at the legacy `sha256(str(tmp_path))` key (a bare
  `admission.lock`, exactly the artifact observed) and asserts the run accounts
  in its own namespace and neither blocks on nor consumes the stale entry; the
  planted entry is removed in `finally`. The original precondition is unchanged.

Post-fix, the identical repro command: `1 passed`. Module selection
`-k cleanup_releases_emergency_disk_reserve`: `19 passed, 1 skipped`. The gate's
own invocation `DEPLOY_GATE_SHARD=3/6 python3 scripts/tests/benchmark-live-results.test.py`
passes the admission test (its one failure in a lean worktree,
`local_lifecycle_test.py::test_local_launchers_preserve_inherited_proxy_configuration`,
was the worktree lacking `agents/.env`/`back-end/.env` and passed once they were
linked).

Siblings prevented: the two other tmp_path-keyed reserve tests in this module.
Not changed: production ledger paths, assertions, timeouts; no entries in the
host-wide root were glob-deleted (only the repro's exact namespace). 10k-agent
behaviour: none — test-only change.

Open: the host-wide ledger still accumulates leaked namespaces whenever a test
process is killed before its `finally`/`atexit` cleanup (409 dirs on this host).
A production-honoured `CLOUDBENCH_CLEANUP_ADMISSION_ROOT` override (the
`CLOUDBENCH_<X>_ROOT` convention) pointing every test at `tmp_path` would remove
tests from the host-wide root entirely; it touches three production sites
(`scripts/run-bench-fleet` reserve, `scripts/cloudbench-cleanup-tickets.py:global_root`,
`scripts/cloudbench-controller-export.py:record_temp_roots`) and six test files.

## Human feedback

None recorded.

## Reusable lesson

Never key persistent host-wide state (the cleanup-admission ledger) by a pytest tmp_path string: basetemp numbering restarts when its root is recreated, so derive test namespaces per run (pid + time_ns or urandom) and treat a precondition failure on a days-old ledger entry as a recycled key, not as a concurrent holder or a release bug.
