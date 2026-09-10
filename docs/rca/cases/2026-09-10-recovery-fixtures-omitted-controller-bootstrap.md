---
id: 2026-09-10-recovery-fixtures-omitted-controller-bootstrap
date: 2026-09-10
title: Extracted recovery fixtures omitted controller birth identity and repository root
surface: harness
component: cloudbench-lifecycle-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Extracted Bash recovery functions execute under nounset without their controller bootstrap variables
symptoms:
  - "FLEET_OWNER_PID_START: unbound variable"
  - "ROOT_DIR: unbound variable"
  - test_exact_recovery_seals_actual_retained_owner_remote_evidence_paths times out
tags:
  - fixtures
  - ownership
  - recovery
sources:
  - PR #1299
  - commit 50e6a8196a27cf84023c4c08493547bc133976c9
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

The existing lifecycle suite failed two exact-recovery tests with
`FLEET_OWNER_PID_START: unbound variable` on both macOS and Linux. A third
retained-owner evidence test reached receipt recovery, then timed out.
Capturing that subprocess's stderr exposed `ROOT_DIR: unbound variable`;
its fake proxy sleep retained the captured pipe after Bash aborted.

Archive searches: `FLEET_OWNER_PID_START unbound variable` and
`lifecycle regression fixture owner identity`. Ownership cases were relevant
context, but none described this missing fixture bootstrap. This is a new
test-environment mismatch, not a recurrence of provider teardown failure.

## Diagnosis

The tests extract real functions from `run-bench-fleet` into short Bash
programs using `set -uo pipefail`. Production controller startup initializes
its PID birth identity and repository root. These fixture programs omitted
that state, so the real recovery lock and guest-recovery helper resolution
failed before the asserted recovery behavior could be tested.

The focused verification command was:

```bash
agents/venv/bin/python -m pytest -q --tb=short agents/benchmarks/cloudbench_dependency_sync_test.py -k 'exact_recovery_routes_quarantined_owner_to_guest_recovery_before_reapers or pre_fix_guest_runner_receipt_authorizes_exact_reaper or exact_recovery_seals_actual_retained_owner_remote_evidence_paths'
```

The full pre-fix suite reproduced these same three failures. A direct call to
the retained-owner test with a resolved temporary path captured the hidden
`ROOT_DIR` error. After fixture initialization was restored, the command
above passed **3 tests**, with all original assertions and deadlines intact.
The complete lifecycle and task-selection suite then passed **311 tests** in
a Linux container with an init process, executable temporary storage, Python
available to sanitized subprocess paths, and writable repository/agents
`.context` directories. Read-only artifact directories and macOS's missing
Linux process facilities were setup failures, not additional code defects.

## Solution

Initialize `FLEET_OWNER_PID_START` from the fixture Bash process in the two
programs that acquire recovery locks. Supply the actual repository `ROOT_DIR`
for the recovery helper programs. No production code, cleanup authorization,
provider receipt, timeout, or assertion changed.

The three cases are also added to the existing `/deploy` Step 4cb focused
selection, which previously omitted them. `scripts/test.sh` already runs the
full lifecycle suite for cloudbench changes. Fixture ownership state now
matches the real controller. There is no production resource or
10k-agent cost impact. Linux-only process tests still require real `/proc`
and `setsid`; running them on macOS is a separate platform mismatch.

Full Linux suite commands, before and after (the latter changes only traceback
formatting):

```bash
agents/venv/bin/python -m pytest -q -o cache_dir=/tmp/pytest-cache agents/benchmarks/cloudbench_dependency_sync_test.py agents/benchmarks/run_benchmark_task_selection_test.py
agents/venv/bin/python -m pytest -q --tb=short -o cache_dir=/tmp/pytest-cache agents/benchmarks/cloudbench_dependency_sync_test.py agents/benchmarks/run_benchmark_task_selection_test.py
```

Local evidence: `.context/acceptance/lifecycle-tests.log`,
`.context/acceptance/linux-lifecycle-ready-tests.log`, and
`.context/acceptance/recovery-fixtures-fixed-tests.log`.

## Human feedback

The user requested completion of the existing PR and explicitly instructed
that work continue without repeated permission questions.

## Reusable lesson

When testing extracted shell functions, reproduce the controller bootstrap
state as well as the provider fixture; nounset failures can otherwise hide the
behavior being asserted and strand fixture children holding output pipes.


## Additional fixture bootstrap mismatch

The full multi-workstream fixture also supplied `fake-token`, below the current
controller token-shape minimum. Replacing it with the still-inert
`fake-offline-fleet-token` restores the fixture's credential bootstrap contract;
no real token is used. The full Linux shell suite passed through scenario 16.

Full agents coverage also exposed two compute-refresh fixtures that mocked the
credential sync but left the subsequently added local database discovery live.
They attempted `psql` on the Linux test host. The fixtures now explicitly model
no local credential overlay and an inactive optional cost gate; their funded
fallback and sync-argument assertions are unchanged. Coverage's dump artifact
directory is writable in the container, matching normal repository setup.
