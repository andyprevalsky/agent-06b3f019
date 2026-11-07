---
id: 2026-11-07-local-gate-slots-parked-test-suite-ledger-rows
date: 2026-11-07
title: Every local deploy gate slot got BENCHMARK_HISTORY_PARK_DIR, so ledger tests parked fixture rows and failed
surface: harness
component: deploy-gates-local-executor
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/deploy_gates.py local_slot (PARK_ENV injected for every gate)
symptoms:
  - "❌ attempt_ledger_records_run_id_and_outcome_class: FileNotFoundError: [Errno 2] No such file or directory: '/var/tmp/tmp.../attempts.jsonl'"
  - "❌ history_ledgers_union_merged: AssertionError: ['agents/benchmarks/history/span_durations.jsonl', ...]"
  - 'Agents blackbox: 123 passed, 2 failed (benchmark, span-history) under scripts/deploy gates --executor local'
  - "fixture rows (task 't', 'first', 'second') in .context/deploy-ledger-park/attempts.jsonl"
tags:
  - deploy-gates
  - benchmark-history
  - park-dir
  - test-isolation
sources:
  - PR #1762
  - commit 84c6e07d0
repro: scripts/tests/deploy-gates.test.py (Inventory.test_only_benchmark_gates_park_history_rows)
status: fixed
---

## Problem

In PR #1762's `scripts/deploy gates --executor local` cycle on ac0421d93,
agents-coverage-blackbox failed two domains, `benchmark` and `span-history`. Their ledger
tests found no rows in their own temporary ledgers (`attempts: []`, FileNotFoundError on the
temp `attempts.jsonl`, rollover and union assertions failing). The coordinator's
`.context/deploy-ledger-park` ended up holding fixture rows for tasks `t`, `first` and
`second`. `scripts/deploy finish` / `ledger --apply-parked` would have published those
rows to main's benchmark history. The same suites passed in local clone workers (cycle 1)
and on Blacksmith, because neither environment had the variable.

## Diagnosis

Commit 84c6e07d0 made `local_slot` set `BENCHMARK_HISTORY_PARK_DIR` for every local gate, so
that worker benchmark rows would be published. `timeout_history._write_target` and
`span_history._parked_history_file` redirect every write, including a test's explicit
temporary ledger, into the park directory whenever the variable is set. The agents
ledger tests do not clear the ambient variable.

Repro: `BENCHMARK_HISTORY_PARK_DIR=/var/tmp/park-probe python scripts/run_blackbox_tests.py
span-history` fails the same five cases, and without the variable it passes. In deploy-v2,
smoke and AgentCard run on the cloud fleet, so no local test-suite gate records real
benchmark history.

## Solution

`local_slot` now injects the park directory only for `PARK_GATES` (smoke and
agentcard-lifecycle), the gates that run real benchmark tasks. Test-suite gates keep their
own ledgers. The deploy-gates regression asserts that test-suite slots carry no park
directory and a benchmark slot still does; it fails on HEAD~1. The polluted park
directory was moved out of the publish path and kept as evidence
(`.context/bams-rca/polluted-deploy-ledger-park-20261107`, archived with the PR1762
closeout). Nothing changes at 10k agents; this is deploy tooling.

## Human feedback

None recorded.

## Reusable lesson

Inject a redirecting environment variable such as a ledger park directory only into the processes whose output it is meant to capture, never into test suites that own their fixtures.
