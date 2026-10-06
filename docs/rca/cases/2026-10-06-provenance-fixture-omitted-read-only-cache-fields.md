---
id: 2026-10-06-provenance-fixture-omitted-read-only-cache-fields
date: 2026-10-06
title: Immutable snapshot fixture expected an older cache policy receipt
surface: harness
component: cloudbench-provenance-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the existing immutable snapshot test compared its receipt with a dictionary that omitted two already emitted read-only cache fields
symptoms:
  - the real provenance producer emitted five expected configuration values
  - the fixture still required exact equality with only three values
tags:
  - cloudbench
  - provenance
  - cache
  - fixture
sources:
  - commit cb9fb73b9c58f84ebde0561ae75e4211185df7d1
  - plan:.context/git-startup-reuse-audit/owning-controls.log
  - plan:.context/git-startup-reuse-audit/root-provenance-red.private.log
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_execution_provenance_binds_immutable_snapshot_not_mutable_checkout
status: fixed
---

## Problem

The independent Git bootstrap audit ran the existing immutable snapshot control.
The real producer emitted the three timing/region assignments and the two
already required read-only demo cache policy values. Exact dictionary equality
still expected only the first three fields. The owner and a second independent
invocation both failed at that unchanged assertion; the second took 0.30 seconds.
No provider, model or benchmark task ran in this reproduction.

## Diagnosis

Archive search found
`2026-10-05-fleet-cache-policy-provenance-schema-drift`, which owns the earlier
producer/schema repair and explains why these fields are valid. The present
failure is its existing fixture's stale expected receipt, rather than a reason
to remove either runtime field or permit unknown fields.

## Solution

Add `benchmark_demo_cache_read_only=1` and
`fast_mode_cache_disable_write_through=1` to the exact expected dictionary. Keep
all five values explicit and retain the immutable snapshot mutation rejection.
The normal compact deploy control now selects this existing quick behavioral
test. Runtime configuration, schema validation and cache behavior remain
unchanged. The unchanged owner passed after the expectation repair. Independent
review repeated it green in 1.51 seconds and confirmed exact five-field equality;
the existing sensitive/unknown-field rejection remains intact.

## Human feedback

Relevant quick controls belong in the ordinary deploy process. Fix the precise
expectation rather than weakening the contract or creating a large new suite.

## Reusable lesson

When a strict receipt producer gains required operational fields, update all
existing exact behavioral expectations and keep them in the owning deploy gate.
