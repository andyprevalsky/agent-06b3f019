---
id: 2026-11-11-phone-catalog-guard-rejected-authorized-deploy-quarantine
date: 2026-11-11
title: Phone catalog golden guard rejected the exact user-authorized mass deploy marker
surface: agents
component: benchmarks-phone-daily-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: phone_daily_test.test_existing_catalog_rows_unchanged compared authorized deploy-only metadata against an unchanged golden row
symptoms:
  - phone_daily_existing_catalog_rows_unchanged: AssertionError
  - assert current[:len(old)] == old
tags:
  - catalog-golden
  - deploy-quarantine
  - integration-regression
sources:
  - PR #1881
  - commit 0bfc5c0f021c6b5d2bfef079a26ba7a86ac24380
  - commit 0cd91e38c150a0b0ae23c1c68737934a2de9b818
  - plan:.context/deploy-pipeline/attempts/36/focused/new-test-stability
repro: agents/benchmarks/phone_daily_test.py::test_existing_catalog_rows_unchanged
status: open
---

## Problem

The actual benchmark blackbox run1 failed after 418.94 seconds in Actions
42931323824 on source 0bfc. Its log line 1000 records
`phone_daily_existing_catalog_rows_unchanged: AssertionError`. The native
stability plan has 32 units, 30 PASS and 2 FAIL. Its adapter remains UNVERIFIED,
complete=false, cleanup_complete=true; the separate controller timeout remains
blocking. The judge_failure/native_failure/unexecuted_native entries are
intentional reporter negative controls, not the new catalog failure.

## Diagnosis

Gate: INTRODUCED by the integrated catalog metadata change. Comparing all 215
golden rows at 5f9a8d94a9f584a8b16ead9be263827f84feac48 with current rows after
the pre-existing validated quarantine normalization finds exactly one differing
field: test-mass-agent-run-0.deploy_quarantine. EAA to 0bfc adds only that field
to these catalog/test paths; the guard is unchanged. The value records the
explicit user-directed indefinite deploy exclusion. A valid authorized input
was rejected because the golden test only normalized the separate quarantine
field. The earlier 2026-11-08 baseline-insertion incident is a relative, not
this cause: no rows shifted and no baseline refresh is needed.

## Solution

External candidate, not integrated or native-validated: require exactly the
existing user-authorized reason on exactly test-mass-agent-run-0, remove only
that field from a deep copy for comparison, reject deploy markers elsewhere,
and retain the exact original golden-prefix assertion and existing validated
quarantine handling. The original guard is RED; the candidate focused tests
pass five unchanged runs, all 46 owning phone tests pass, and 15 selector
neighbors pass. Ten negative mutations reject missing/changed authorization,
other/appended task markers, prompt, timeout, evaluator, added/removed fields
and reordered rows. The actual benchmark wrapper executes the new parameterized
controls through its existing pytest registration. No task definition, golden
pin, evaluator, deadline, prompt or concurrency changes. Full original native
32-unit, five-repeat/eight-load plan remains required; local tests grant no
aggregate PASS or waiver. At 10000 tasks the guard remains linear with one
bounded deep copy per catalog, with no provider calls.

## Human feedback

The user required preserving every executable catalog property and allowing
only the explicitly authorized mass deploy marker; no broad assertion disable
or relaxation is authorized. Current paid smoke is owned by the parent/operator.

## Reusable lesson

Normalize only an exactly authorized non-executable metadata delta, then compare every remaining golden property unchanged.
