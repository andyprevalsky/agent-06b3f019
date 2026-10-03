---
id: 2026-09-09-cloud-fleet-terminal-artifacts-split-sources-of-truth
date: 2026-09-09
title: Cloud Fleet terminal archives populated run.json but left report-card.json on a separate stale live projection
surface: harness
component: cloud-fleet-terminal-aggregation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-aggregate-runs.py main wrote only _batch/run.json and llm-usage.json from the canonical terminal task list
symptoms:
  - "FAIL: terminal child outcomes absent from batch card: ['success', 'early-failure']"
  - "terminal child outcomes absent from batch card: ['success', 'benchmark-failure', 'early-failure']"
  - "_batch/run.json contains terminal tasks while _batch/report-card.json is absent or remains starting/queued"
tags:
  - cloud-fleet
  - terminal-projection
  - report-card
  - run-json
  - exit-finalization
sources:
  - plan:docs/plans/active/fleet-demo-concurrency-e2e.md
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fleet_terminal_projection_uses_two_archives_and_one_terminal_task_list
status: fixed
---

## Problem

Cloud Fleet had two independent projections of one run. The production
aggregator read each archived `cloudbench-run.json` and correctly derived
`PASSED`, `FAILED`, and missing-archive `INFRA_ERROR` tasks for `_batch/run.json`.
The dashboard card came from a separate polling loop over optional
`cloudbench-live/report-card.json` files. Once that loop stopped, normal failure,
early infrastructure failure, and signal cleanup could leave the card absent or
stuck on `starting`/`queued` even though the terminal task list was complete.

The pre-fix command was:

`agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_fleet_terminal_projection_uses_two_archives_and_one_terminal_task_list`

It exited 1 with:

`AssertionError: terminal child outcomes absent from batch card: ['success', 'benchmark-failure', 'early-failure']`

## Diagnosis

Critical path:

`requested BENCHES -> per-child terminal cloudbench-run.json archives -> cloudbench-aggregate-runs.py aggregate() terminal task list -> _batch/run.json + _batch/report-card.json -> Benchmark Hub`

The pre-fix debug trace proved `aggregate()` loaded all three requested names and
derived `success/PASSED`, `benchmark-failure/FAILED`, and
`early-failure/INFRA_ERROR`. Its final output trace then recorded
`run_exists=true`, `report_card_exists=false`, and `run_elapsed_s=null`, despite
`controller_elapsed_env=true`. The first bad boundary was therefore output
projection, not archive collection or task classification.

Step 5 hypothesis:

1. **What:** terminal outcomes existed in `_batch/run.json` but not the batch card.
2. **Where:** `scripts/cloudbench-aggregate-runs.py:main`.
3. **Why:** the terminal aggregator wrote only run/usage artifacts; a separate
   best-effort live-card loop owned `report-card.json`, and
   `scripts/run-bench-fleet:cleanup` never invoked terminal aggregation.
4. **Proof:** the unchanged owning test failed before the fix, while the debug
   trace showed the complete canonical task list followed by
   `report_card_exists=false`.
5. **Problem:** logically identical terminal state had two sources of truth and
   only the normal path finalized one of them.

Deepest-owned-cause ladder:

- The card was stale because terminal aggregation did not write it.
- Terminal aggregation did not write it because run and dashboard finalization
  were implemented as separate pipelines.
- That split remained possible because no idempotent EXIT-owned projection
  contract required both artifacts from one terminal task list.

The archive searches
`terminal child outcomes absent from batch card report-card Cloud Fleet` and
`fleet batch aggregation early infra failure wall clock` found related Fleet
terminalization cases but no case at this first-bad boundary, so this incident is
novel rather than a recurrence.

## Solution

`cloudbench-aggregate-runs.py` now derives both `_batch/run.json` and
`_batch/report-card.json` from the same ordered terminal task list and publishes
each atomically. It maps benchmark failures to `failed`, missing archives and
other infrastructure terminals to `error`, preserves failure reasons, and
records the controller's actual elapsed wall clock and exit code.

`run-bench-fleet` freezes `benches.json` at fire time, invokes one idempotent
`finalize_terminal_projection` on normal completion, and invokes it again from
the EXIT cleanup after child/provider finalization. Signal and early-failure
paths therefore produce the same two artifacts without reading optional
dashboard child files.

The unchanged pre-fix reproduction now exits 0. Focused coverage also executes a
TERM -> EXIT finalization and verifies exit 143, `INFRA_ERROR`, both artifacts,
and elapsed wall clock.

At 10,000 tasks, finalization performs one ordered pass over the manifest/child
archives and one ordered report-card projection: O(tasks) local work, one file
read per task, three atomic batch writes, no external request, polling loop,
shared lock, or per-agent fan-in.

## Human feedback

The user independently reproduced the exact production-aggregator failure and
required a general idempotent terminal projection covering normal success,
benchmark failure, early infrastructure failure, and signal/EXIT finalization.
They explicitly rejected reliance on optional dashboard child files, required
actual controller wall-clock elapsed and O(tasks) finalization, requested
consistently-run Cloud Fleet coverage plus this RCA, prohibited commit/push, and
asked that temporary instrumentation remain until parent confirmation.

## Reusable lesson

Project every terminal view from one canonical task list inside idempotent EXIT finalization; never let optional live-dashboard files become a second terminal source of truth.
