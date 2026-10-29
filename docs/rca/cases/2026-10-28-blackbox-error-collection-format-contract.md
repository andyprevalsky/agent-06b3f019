---
id: 2026-10-28-blackbox-error-collection-format-contract
date: 2026-10-28
title: Typed diagnostic formatter changed the blackbox error collection contract
surface: harness
component: blackbox-result
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: BlackboxResult.record_result stores the typed display detail in errors where the existing ownership check expects the exception message
symptoms:
  - "AssertionError: native wait finished before the judge progressed"
  - "benchmark FAIL with empty aggregate message after 314.6s"
tags:
  - benchmark
  - blackbox
  - diagnostics
sources:
  - PR #1627
  - commit 11ba1f13b2cefc9b6a818263ac2b7700c4af9e73
  - commit d7f06d576
repro: agents/tests/blackbox/benchmark.blackbox.py::test_benchmark_native_checks_overlap_judges_without_losing_ownership
status: open
---

## Problem

Frozen agents coverage benchmark domain failed after 314.6 seconds. The original
benchmark.log lines 197-203 and 234 identify the existing ownership assertion at
line 25118. Other payment, timeout and cache error strings are negative controls;
they are not this failure. The nested benchmark/results.json preserves the failed
domain with an empty summary message. No benchmark task outcome is claimed here.

## Diagnosis

The path is native control exception -> deferred BlackboxResult.record ->
record_result -> errors collection -> ownership assertion -> boolean domain
return -> empty summary message. Commit d7f06d576 changed the collection value
from 'native_failure: owned native failure' to
'native_failure: RuntimeError: owned native failure'. The assertion therefore
fails despite the native failure being retained. Local unchanged owning check
fails at the same line in 0.183s, exit 1. A temporary helper restores the message
contract and the identical command passes in 15.561s, exit 0, including all
subsequent admission, cancellation, drain and process-ownership assertions.

Archive searches were 'native wait finished before the judge progressed' and
'benchmark native checks overlap ownership'. The September 30 benchmark judge
scheduling case and October 14 mocked ownership executor case are relatives,
not evidence of this cause. This incident is a distinct formatting regression.
The earlier scheduling fix is not reverted. No provider or model is involved.

## Solution

Proposed, not applied: retain centralized recording, typed console detail and
traceback output; store str(error) in errors when nonempty and fall back to the
exception type for an empty message. One line changes in _test_utils.py. Delete
or unify the collection/display representations would alter the existing
contract or lose diagnostic detail; selecting the proper representation at the
shared recorder preserves every consumer. Assertions and budgets are unchanged.
Golden reference: not applicable (no approval-gated hunk).

Exact command for both sides:
/home/boxes/rose/.claude/worktrees/agent-a0f677519b4ea0db3/agents/venv/bin/python /var/tmp/deploy-1627/resumed-benchmark-rca/repro.py /var/tmp/deploy-1627/resumed-benchmark-rca/_test_utils.py

The same temporary helper pathname held the original bytes before and candidate
bytes after. The benchmark test itself was imported from frozen source without
edits. The existing workflow test
 test_blackbox_result_preserves_empty_exceptions_and_tracebacks also passes in
0.003s, exit 0, preserving sync/async empty errors and deferred causal tracebacks.
The original benchmark full domain and full coverage have not been rerun; parent
owns source application and full rerun. Status remains open until that gate.

Permanent coverage is already registered: benchmark run_all_tests line 26034
calls the owning test; workflow run_all_tests line 12493 calls
blackbox_result_empty_exception_diagnostics. scripts/run-coverage.sh invokes
run_coverage_blackbox_parallel.py, which discovers these domains and runs
scripts/run_blackbox_tests.py under coverage. /deploy Step 4g invokes that script.
Only these two existing checks were executed locally, not their complete suites.

## Human feedback

User required read-only frozen source, temporary candidates only, unchanged
assertions/budgets, no dependencies, providers, environment or full-coverage
changes, and parent-only application/deployment. All were preserved. Native
turn_context confirms gpt-6.1-sol with low effort; speed is absent and remains
unconfirmed (parent reported selecting ultrafast fallback).

## Reusable lesson

Preserve the error collection contract when enriching diagnostic display text.

## Integration application

Reviewed correction applied by the sole deploy source owner after the frozen interim checks ended on 2026-10-28. Original failed/interrupted receipts remain unchanged. Five unchanged owning verifications and the full final deploy gates are required before closure; status remains open until verified.
