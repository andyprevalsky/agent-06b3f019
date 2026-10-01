---
id: 2026-09-30-watchdog-fixture-omitted-sealed-artifact
date: 2026-09-30
title: Watchdog collection fixture acknowledged a sealed capture without creating its run artifact
surface: harness
component: cloud-controller-terminal-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: test_watchdog_collects_cancelled_artifact_after_bounded_shutdown stubbed cloudbench_collect_runtime_evidence as a successful no-op
symptoms:
  - "sealed runtime result is unavailable -- infrastructure failure"
  - "runtime-evidence/run.json: No such file or directory"
tags:
  - watchdog
  - sealed-artifact
  - fixture
  - cancellation
sources:
  - PR #1299
  - commit f10d13fdb42507028fcab0a1550f06ea474bd37b
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_watchdog_collects_cancelled_artifact_after_bounded_shutdown
status: fixed
---

## Problem

The focused controller gate passed 286 cases but failed its watchdog collection
fixture with exit 70. The real selection block now reads the verified sealed
file, while this older fixture claimed capture success without publishing it.
No live task, resource or provider call was involved.

## Diagnosis

Shutdown creates the original cancellation result, the terminal collector drains
the driver log, and the runtime collector must publish its verified run artifact
before selection. The fixture's successful no-op omitted that last obligation.
This is a relative of `2026-09-30-cloud-terminal-json-selected-lossy-progress-stream`:
the production fix removed the redundant progress result, but the old fixture
still modeled that transport as authority.

Archive searches were `sealed runtime result is unavailable watchdog` and
`cancelled artifact collector terminal log fixture`. The owning unchanged
pytest case failed before fixture repair and passed afterward with the same
shutdown/order/CANCELLED/false assertions. Command:
`source agents/venv/bin/activate; python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k test_watchdog_collects_cancelled_artifact_after_bounded_shutdown`.

## Solution

The fixture's collector publishes the synthetic sealed result created by shutdown.
The progress log deliberately carries a conflicting PASSED/true decoy, so the
unchanged assertions also reject a regression to progress-text selection. The
adjacent real HTTP/hash/owner capture fixture still exercises actual sealing;
this narrow shutdown-order fixture does not pretend to replace it.

The watchdog and four sealed-source controls passed together. The recurring
`benchmark` blackbox terminal-evidence gate now explicitly selects this case,
retaining its existing 60-second aggregate budget. No production source, task,
query credit, evaluator, evidence or teardown rule changed. At 10,000 agents
this fixture repair adds zero runtime work.

## Human feedback

The user required complete durable evidence and prohibited granting proof credit
for interrupted or recovered diagnostics. This synthetic fixture grants no
benchmark acceptance credit.

## Reusable lesson

Make a successful artifact-collector fixture publish the same owner-bound output contract its real caller consumes.
