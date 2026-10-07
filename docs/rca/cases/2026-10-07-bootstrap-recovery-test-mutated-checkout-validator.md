---
id: 2026-10-07-bootstrap-recovery-test-mutated-checkout-validator
date: 2026-10-07
title: Bootstrap recovery test rewrote the checkout's provenance validator while concurrent deploy gates read it
surface: harness
component: cloudbench-bootstrap-recovery-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/cloudbench-bootstrap-recovery.test.py test_adjacent_provenance_validator_must_match_the_bound_ref ROOT/cloudbench_execution_provenance.py write_bytes
symptoms:
  - "ValueError: local provenance validator differs from bound source"
  - "test_exact_recovery_consumes_runtime_receipt_failed_startup_archive[unconfirmed-cleanup]"
  - benchmark-live-results failed intermittently in the parallel deploy structural runner
tags:
  - test-isolation
  - shared-checkout
  - parallel-gates
  - deploy-structural-gates
sources:
  - PR #1417
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py
status: fixed
---

## Problem

`python3 scripts/run-deploy-structural-gates.py` runs eight suites at once.
One run failed `benchmark-live-results` in
`test_exact_recovery_consumes_runtime_receipt_failed_startup_archive[unconfirmed-cleanup]`
with "local provenance validator differs from bound source", although that
suite passes on its own and the checkout's validator matched the bound ref.

## Diagnosis

`test_adjacent_provenance_validator_must_match_the_bound_ref` in the
bootstrap recovery suite proved the mismatch check by appending a comment to
the real `scripts/cloudbench_execution_provenance.py` and restoring it in a
`finally` block. While that file was modified, the concurrently running
recovery path in `benchmark-live-results` compared the same checkout file
against the bound git blob and correctly rejected it. The failing gate was
reporting a real mismatch that another test had written into the shared
working tree.

## Solution

The test now copies `cloudbench-prestack-recovery.py` and a mutated
`cloudbench_execution_provenance.py` into its private temporary directory and
loads the recovery module from there, so the adjacent-validator lookup reads
the private copy. The checkout file is never written. The suite passes with
the checkout unchanged before and after. A negative control without the
mutation fails with "ValueError not raised", so the test still proves the
check. No production code changed.

## Human feedback

None recorded.

## Reusable lesson

Tests that run under a parallel gate runner must mutate private copies, never checked-in files that other suites read.
