---
id: 2026-11-04-structural-fixtures-inherited-source-and-host-assumptions
date: 2026-11-04
title: Structural fixtures assumed an ambient merge base and synthetic host capacity
surface: harness
component: deploy-test-fixtures
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Private metadata and admission fixtures consumed undeclared real checkout and host inputs
symptoms:
  - "factory metadata source omitted lanes when origin/main was absent"
  - "synthetic smoke4150MB refused by actual2848MB budget while big lane passed"
tags:
  - structural-gate
  - fixture-isolation
  - source-telemetry
  - memory-admission
sources:
  - PR #1662
  - commit 4a2aae4bd4274a1d3a140063fb6d2b5543b8a31b
repro: Existing factory detail and exclusive-lane deferral owning controls via saved targeted.py
status: open
---

## Problem

The original4a2 structural gate reported two independent fixture-input failures.
`test_stage_runner_records_detail_reuse_and_publishes_it` assumed that source
telemetry always contains lanes. `check_exclusive_lane_defers_behind_stack_lane`
expected a passed synthetic6000MB attempt while the actual host limited it to
2848MB. These are relatives of the archived inherited-reuse-policy fixture
case, with different first-bad inputs; no prior incident is retroactively closed.

## Diagnosis

The prepared structural checkout had HEAD but no `refs/remotes/origin/main`.
The real metadata collector correctly omitted merge-base-dependent fields;
the test incorrectly required them from that ambient checkout. Its unchanged
owning control failed with missing lanes in0.915s. The fixture now uses its own
committed checkout and explicit origin/main; the same control passes0.725s,
preserving publishing/reuse assertions and additionally binding base==HEAD.

The admission control declared synthetic smoke4150MB and budget6000MB but read
real host resources. Replaying the captured2848MB headroom through the real
admission core reproduces the failure in1.952s: smoke is correctly refused,
while big resizes to2 workers and passes. An explicit fixture-host observation
through the real native CLI passes all original deferral/resize/never-fit
assertions in4.871s. Original commands,6000MB budget and120s subprocess guard
remain unchanged. This is not a production admission relaxation or permission
to serialize normal independent gates.

## Solution

Reviewed test-only patch SHA256
`46cb88cdc20f48fe6ea14efbd588852b12b01994f38352f66f557f99a7dc9a3c`
changes the two existing registered owning test files. Both controls were
RED/GREEN under native Python3.11.9. Before admission evidence is a captured
host replay at the core; after evidence uses the real CLI with a synthetic
host. No full structural suite was repeated by this investigator. Original
native failures remain unchanged; full gate acceptance remains parent-owned.
Evidence: `/var/tmp/pr1662-4a2-structural-fixtures/report.json`, SHA256
`cefc22b43c55a58ed005bb876a983e2e592593222b2f82ea8dea04f277c938ab`.

## Human feedback

The user requires independent gates to run concurrently. Fixture assumptions
must be repaired without global scheduling edges, capacity increases, relaxed
assertions or deadline bumps. No new analysis or test was run for this record.

## Reusable lesson

Private fixture inputs must be explicit; unknown ambient source metadata and
real admission refusals must remain truthful.
