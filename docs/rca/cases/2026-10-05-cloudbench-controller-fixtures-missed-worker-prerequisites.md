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

## Human feedback

The user requires quick tests cemented in deploy, without a massive additional
verification workload, and wants ordinary CLI operation to remain reliable.

## Reusable lesson

Keep controlled worker inputs aligned with the current native prerequisites and assert the intended lifecycle branch rather than the first matching source token.
