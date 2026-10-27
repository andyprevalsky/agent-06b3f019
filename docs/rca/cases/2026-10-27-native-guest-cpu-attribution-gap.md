---
id: 2026-10-27-native-guest-cpu-attribution-gap
date: 2026-10-27
title: Native guest diagnostics CPU assertion failed without burner ownership or raw tick provenance
surface: harness
component: cloudbench-guest-diagnostics
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Unknown upstream of native burner top8 CPU assertion; original burner PID and raw tick inputs were not retained
symptoms:
  - "assert burned and max(row['cpu_pct'] for row in burned) >= 50"
  - "test_runtime_collector_rechecks_terminal_seal_and_bounds_transport_reads[guest-diagnostics]"
tags:
  - cloudbench
  - guest-diagnostics
  - cpu-attribution
sources:
  - commit 807dedd8ff0495d9f89699d1f1ed50be2d8e46a0
  - task deploy-native-guest-cpu-assertion
repro: Owning native pytest case runs healthy locally; no causal red reproduced
status: open
---

## Problem

The original native owning assertion failed with two top8 sample payloads. Python PID3616732 showed42.1/47.3 percent, but the log does not bind that PID to the fixture burner.

## Diagnosis

OPEN. Sampler measures tick delta / HZ / monotonic elapsed. Original raw inputs and burner ownership are absent. Two local executions with diagnostic capture passed. Neither CPU allocation, readiness nor arithmetic failure has been proven. See `.context/cpu-sampler-rca-20261027/REPORT.md` and its exact native receipts. Archive CPU cases are related, not a proven recurrence.

## Solution

No runtime repair. Optional exact observer proposal preserves all50 assertion ASTs and deadlines while retaining PID/ticks/elapsed and pre-cleanup payload. The author observer native validation passed1test in1.66s. The applied bounded diagnostic additionally caps retained tick records at128 with a dropped count and registers its exit writer only when enabled; each burner gets a private PID-named subdirectory to avoid overwriting concurrent native invocations. The applied bounded observer passed the unchanged owning native pytest once in2.160s; this validates capture compatibility, not a repair. Fresh full acceptance is pending. Observer overhead remains unmeasured; causal-red and identical-command repair-green gates remain open.

## Human feedback

None recorded for this failure. The unchanged acceptance and evidence requirements come from repository guidance and coordinator instructions.

## Reusable lesson

Retain the owned burner identity and raw tick-denominator inputs before temporary fixture cleanup before attributing a CPU assertion failure.
