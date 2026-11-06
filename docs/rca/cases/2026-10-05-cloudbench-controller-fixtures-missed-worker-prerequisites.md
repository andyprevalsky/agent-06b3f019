---
id: 2026-10-05-cloudbench-controller-fixtures-missed-worker-prerequisites
date: 2026-10-05
title: Controller fixtures omitted current worker prerequisites and asserted obsolete ordering
surface: harness
component: cloudbench-controller-regressions
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: cloudbench_dependency_sync_test.py extracted worker fixture omitted exact-volume snapshot and inert-clone inventory facts
symptoms:
  - "machine_volume_size_gb: command not found"
  - "inventory_machine_field: command not found"
  - "ValueError: substring not found"
tags:
  - cloudbench
  - fixture
  - worker
  - admission
sources:
  - commit 813bdbfe28077fe904e960b614be686083dce846
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_autoscaled_worker_uses_authenticated_fetch_ref_helper
status: fixed
---

## Problem

The complete existing controller module exposed three repeatable fixture failures:
an authenticated worker never reached readiness because its extracted-function
fixture omitted current native prerequisites; two ordering assertions referred to
an obsolete terminal-demand rejection and the first reservation release rather
than the successful clone handoff. A fourth status-server startup observation
failed once under the full gate and passed both targeted reruns unchanged.
No runtime deadline was changed to conceal that observation.

## Diagnosis

The worker fixture called the real provisioner while supplying no exact mounted
volume size or matching snapshot, and no native inert-CMD inventory observation.
The actual helper now requires those facts before staging. Another assertion
selected the legitimate cancellation-release branch that precedes allocation,
although its intent was to establish successful allocation before handoff.
The terminal assertion demanded a historical future-capacity failure string;
completed tasks now warn about unused future demand while admitted incomplete
workers remain a real failure.

Archive searches: `autoscaler fixture machine_volume_size_gb` and
`worker capacity terminal fixture stale assertion`. Relatives read were the
October 4 inert-worker replacement-slot case and August 3 missing-terminal
fixture scheduler case. The first boundary here is controlled fixture inputs
and obsolete source assertions, rather than actual provider behavior.

## Solution

Supply the existing exact-size snapshot and inert native observation in the
worker fixture. Compare the actual clone call against successful reservation
handoff, preserving the cancellation path. Keep the terminal ordering assertion
on admitted incomplete-worker rejection before process acceptance, with its
existing subprocess positive and inverse controls unchanged. Independent review
approved these corrections and the bare `run-bench` changed-file filter that
selects the existing controller gate. No production code or timeouts changed
for these fixture repairs; fleet concurrency is unaffected.

The unchanged owning subset reported three failures and one passing control,
then four passes in 1.43 seconds. The complete module subsequently passed
645 cases with three explicit skips in 334.99 seconds under Node 22.13.0; its
private output is `cli-cache-final-suite.private.log`. Private artifacts:
`.context/benchmarks/cli-cache-existing-gates.private.log` and
`cli-cache-existing-gates-green.private.log`. From the activated agents venv:

```sh
python -m pytest -q benchmarks/cloudbench_dependency_sync_test.py -k 'autoscaled_worker_uses_authenticated_fetch_ref_helper or autoscaler_stops_cleanly_when_its_benchmark_child_finishes or autoscaler_worker_clones_take_a_serialized_machine_slot or (boot_terminal_runtime_evidence_collects_complete_logs and hash)'
```

## October 7 reserve handoff fixture correction

The final source at `51535cebb96a4a1ab86b16ba264da110fc2399c2`
passed 351 compact controls and failed one reserve control at
`cleanup.index("cloudbench_terminate_and_wait")`: the actual cleanup now uses
the stronger complete-tree drain. All earlier physical allocation, sparse-file,
storage-fault and neighboring-file assertions passed. This was a fixture
interface mismatch, not a demonstrated runtime ordering or disk failure.

Archive searches used `substring not found cloudbench_terminate_and_wait cleanup
reserve` and `reserve release final native drain teardown helper test`.
The September 27 reserve-allocation case is a relative; this occurrence repeats
the present case's source-token assumption after a native cleanup refactor.
Its solution and human feedback require testing the intended handoff rather
than a helper spelling.

The unchanged owning pytest selection failed in 1.839 seconds. The corrected
existing test keeps every physical/fault assertion and executes the extracted
real finalizer with its real 1 MiB reserve and release functions. Controlled
native-drain, forensic-capture and provider-retirement consumers reject a
still-present reserve before doing work. All three handoffs were observed and
the test passed in 2.904 seconds. A private controlled inverse moves only the
original release call after the first native drain; the same corrected test
fails at its actual handoff assertion in 1.896 seconds. No provider calls are
made. Both pytest leaders and their supervisor process groups were reaped.

The command is the existing pytest entrypoint selecting
`test_fleet_cleanup_releases_emergency_disk_reserve_before_provider_teardown`.
Private owner/log/source receipts are retained under
`.context/fresh-basic-claude-final50-20261006/deploy/c4-cycle3-composition.private/reserve-handoff-fixture-repair.private/`.
Production cleanup, resource ownership, physical floors, task outcomes and
budgets are unchanged. This proves the fixture handoff, not cloud performance,
benchmark acceptance, final native release or production deployment.

## Human feedback

The user requires quick tests cemented in deploy, without a massive additional
verification workload, and wants ordinary CLI operation to remain reliable.

## Reusable lesson

Keep controlled worker inputs aligned with the current native prerequisites and assert the intended lifecycle branch rather than the first matching source token.


## 2026-11-04 extracted worker fixture dependency recurrence

The b9 controller selected-pytest owner recorded1FAIL/517PASS. The failing
`test_autoscaled_worker_failure_publishes_durable_failure_marker` timed out10s
in upload-and-reap-failure; captured stderr first showed unbound
WMH_MODEL_NAME/WMH_EXECUTION_POLICY and missing
fleet_current_disposable_registry. The extracted fixture omitted their actual
production initializer/helper. This proves missing fixture prerequisites,
not that those warnings caused the original10s timeout.

The existing owning test gains two strict missing-dependency assertions. It
fails before on the exact captured diagnostics in5.09s, then passes all eight
original modes in6.68s after extracting the real WMH defaults and registry
predicate into the explicit ordinary test-app fixture. Every original assert,
10s bound, provider-failure sentinel and retained-worker cleanup expectation
is preserved. Production helpers are byte-identical. A missing worker source
file in the first lean private export was copied unchanged for the final
source-order assertion; that setup error is separately retained.

Private evidence: `/var/tmp/pr1662-b9-worker-dependency-fixture/report.json`;
fixture-only patch SHA256
`29a4c47fc19cf3d8ad5cab1f53c098b9147148e7026c0d10020cc516ec6d96ea`.
The dependency-error RED/GREEN does not reproduce or close the full-cohort
10s timeout and grants no full-controller/benchmark PASS. Parent owns the
unchanged affected gate rerun; no deadline/concurrency relaxation was proposed.
