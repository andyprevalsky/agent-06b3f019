---
id: 2026-09-27-wmh-final-evidence-fetch-lost-last-good-snapshot
date: 2026-09-27
title: Final-only WMH evidence collection discarded earlier successful snapshots
surface: harness
component: benchmark-reporting
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: agents/benchmarks/run_benchmark.py _report_snapshot and final result save did not retain last known-good WMH usage or retrieval audit
symptoms:
  - "world_model_retrieval_audit=null after a run with visible WHM calls"
  - "report card WHM usage resets from $0.2039 to unavailable"
  - "final run JSON loses input_tokens=124308 output_tokens=29501"
tags:
  - world-model
  - observability
  - retrieval-audit
  - benchmark
sources:
  - agent 28aaeabe-bdf2-4587-9aab-5bcbb23b4908
  - fleet run 20260927-225511-659576
repro: agents/benchmarks/run_benchmark_wmh_cost_test.py::test_wmh_evidence_snapshot_retains_last_success_after_sidecar_stops
status: open
---

## Problem

Live report cards measured cumulative WHM usage rising to at least $0.2039,
124,308 input tokens, and 29,501 output tokens. After the 80-child fanout, the
WHM sidecar became unreachable and later cards rendered usage as unavailable.
The final run JSON stored `world_model_retrieval_audit: null`, even though the
WHM had produced multiple predictions earlier in the run.

## Diagnosis

`_report_snapshot` fetched `/rose_usage` anew on every tick and used `None`
immediately on a failed fetch; it did not retain a prior successful response.
Retrieval evidence was fetched only once in the final `finally` block. If the
sidecar was already unavailable at teardown, the sole audit fetch returned
`None`, erasing the evidence needed to inspect prediction grounding. The owned
cause was treating an ephemeral sidecar endpoint as durable final storage.

## Solution

`_WMHEvidenceSnapshot` retains the last successful usage response and captures a
retrieval-audit snapshot whenever the cumulative WMH call count advances. Final
save refreshes best-effort but falls back to the retained audit. It stores one
latest snapshot rather than accumulating copies, so memory is bounded by the
audit payload for one run; agent count does not multiply storage.

The owning repro previously failed because `_WMHEvidenceSnapshot` did not
exist. It now proves a successful snapshot survives a subsequent unreachable
sidecar. The exact benchmark rerun remains approval-gated, so the case stays
open until final artifacts demonstrate the retained evidence end to end.

## Human feedback

The user required the WHM prediction to be evaluated against pulled historical
runs and required important run statistics before approving another loop.

## Reusable lesson

Persist the last known-good simulator evidence during the run; never rely on a teardown-time fetch from an ephemeral sidecar.
