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
  - "GIT_COMMON_DIR: unbound variable"
  - "FLEET_OWNER_PID_START: unbound variable"
  - "ROOT_DIR: unbound variable"
  - test_exact_recovery_seals_actual_retained_owner_remote_evidence_paths times out
  - "unsafe stale-owner source audit mapping"
tags:
  - fixtures
  - ownership
  - recovery
sources:
  - PR #1525, October 16 mixed-shape claim fixture recurrence
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

For the October 16 recurrence, preserve the original shape assertions and real
admission guards, record subsequent failures, and do not attribute fixture
failures to the original REAL600 run.

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

## September 27 recurrence: declared audit directory was never created

The full controller gate at `605e091f` failed the retained-owner evidence test:
**1 failed, 135 passed**, with `unsafe stale-owner source audit mapping`.
The fixture wrote `audit_dir` and audit file paths into its registry, but never
created that directory or its metadata. The stricter private-source recovery
parser correctly rejected this incomplete authority before reconnecting to the
guest. Real controller initialization writes the audit before publishing its
registry. The earlier fixture repair covered shell variables but missed this
durable bootstrap state.

Archive searches were `unsafe stale-owner source audit mapping` and
`retained guest recovery fixture ownership audit root`. This is a recurrence
of the fixture-bootstrap mismatch, not evidence that production ownership
validation should be relaxed.

The unchanged focused command reproduced the failure and then passed after
creating the fixture's declared audit directory and matching owner metadata:

```bash
env TMPDIR=/private/tmp agents/venv/bin/python -m pytest -q --tb=short agents/benchmarks/cloudbench_dependency_sync_test.py -k exact_recovery_seals_actual_retained_owner_remote_evidence_paths
```

Before: **1 failed** in 0.27 seconds. After: **1 passed** in 1.16 seconds.
Logs and the hypothesis are retained under
`.context/acceptance/proof20-controller-fixture-rca/`. The test's assertions,
deadlines, recovery functions, and deploy registration are unchanged. No
benchmark definition, model, prompt, evaluator, or production code changed.
The repair supplies missing fixture data instead of adding a production
exception; it has no runtime or 10,000-agent cost.

## October 16 recurrence: mixed-shape claim omitted its Gitcommon

After the independently recorded clone-admission fixture repair, the same full
environment suite reached its mixed-shape pool replay and failed with
`GIT_COMMON_DIR: unbound variable`. The current `claim_pool_machine` checks
outgoing handoff exclusions before choosing a candidate, but the extracted
fixture had never initialized that controller root. It also omitted the current
reuse-proof path and verification helpers. These missing dependencies prevented
the intended large/small Machine selection assertions from running.

The unchanged registered command used Python 3.11.9 on PATH:

```bash
PATH="/home/boxes/rose/agents/venv/bin:$PATH" bash scripts/tests/cloudbench-env.test.sh
```

The RED receipt is
`.context/pr1525-continuation/worktree-symlink-rca/env-fixture-missing-common-red.json`
(exit 1, test SHA256
`f8ee267f3e40a33ee3b1e6bcdfb24c38e28c4310839acdaaa51f98c4b33660d8`).
The fixture now supplies a private temporary Gitcommon and extracts the actual
proof-path and proof-verification helpers. Its empty common contains no outgoing
handoff or reuse-proof record; the production guards execute with their normal
semantics. Original large/small claim assertions remain unchanged.

The full command then passed, with
`All cloud benchmark environment checks passed.` The GREEN receipt is
`env-fixture-pinned-green.json` in the same directory (exit 0, test SHA256
`ad52ba01f17b1d59f20e31763a528c580f72b2c755b338edd31e4520bced6da6`).
The stdout SHA256 is
`9b5fe4706d2180d690cc09289872155fa74693307af7cdf6781e3fd749eb7dca`;
raw stdout/stderr and the exact fixture diff are retained beside the receipts.
Only the shell test changed. No production code, timeout, assertion or native
operation changed. This is test-only dependency drift, not an original600 cause
or qualification result. Archive search for `GIT_COMMON_DIR unbound variable`
identified this existing bootstrap case, so the recurrence is appended here.
