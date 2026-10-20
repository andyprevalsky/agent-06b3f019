---
id: 2026-10-20-native-stop-fixture-request-count-intermittent
date: 2026-10-20
title: Bounded native-stop fixture intermittently sent two requests while asserting three
surface: agents
component: cloudbench native-stop regression fixture
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: "test_guest_shutdown_child_confirmation_native_stop_is_bounded_exact_and_verified[stop-always-fails] observed two fake stop calls before its unchanged six-second shared deadline; it asserted three"
symptoms:
  - "AssertionError: assert 2 == 3"
  - "benchmark-live-results structural gate failed with 1099 passed and one failed"
tags:
  - benchmark
  - deploy
  - fixture
  - deadline
  - native-stop
sources:
  - deploy run 20261020-013350-3832649 resumed A3
  - source 5bd3a3d44 merge of approved browser repair and main 33d096476
  - .context/rca-915ab997/A3-native-stop-diagnosis.txt
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_guest_shutdown_child_confirmation_native_stop_is_bounded_exact_and_verified
status: open
---

## Problem

The resumed browser deploy's Group 3 structural run failed the
`stop-always-fails` parameter. The selected benchmark-live-results gate reported
1 failed, 1099 passed and 4 skipped in 787.34 seconds. No runtime change was
made to the native-stop implementation or test. This is a local fake-provider
fixture failure, not a new production native-stop incident.

## Diagnosis

The original fixture's retained fake call log contains two exact
`machine stop deadbeef000001 -a bench-app` calls. Its receipt reports
`stop_requests=2`, `verified=false`, `verified_state=started`, requested epoch
1792531614 and verified epoch1792531619. The fixture's total phase budget is
six seconds, each provider call is bounded by two seconds, and the enclosing
wall bound is fourteen seconds. The failed assertion required three requests;
identity, failed outcome and retained ownership checks did not fail.

The implementation shares one absolute deadline across ownership preparation
and verification, then spaces bounded retry requests. The original run did not
capture per-operation scheduling/timing, so it does not prove whether process
startup, host scheduling, deadline granularity or another operation consumed
the missing attempt's interval. Host-load attribution remains a hypothesis.

Literal archive search used the exact test name and returned no prior case.
Behavior search used `native shutdown retry deadline request count`. The full
Solution and Human feedback of the related
`2026-10-12-group-term-killed-guest-shutdown-proxy-before-delivery` case were read.
That case repaired transport/cancellation ownership defects and established this
fixture; it does not establish the cause of this intermittent count mismatch.

## Reproduction and verification

Original command: `python3 scripts/run-deploy-structural-gates.py`, on the
merged source above with concurrent qualified Group 3 suites. Original complete
log is retained in the existing deploy run. The failed fixture's receipt and
fake call log are copied under `.context/rca-915ab997/A3-native-stop-failed-fixture`.

From the isolated deploy checkout's `agents` directory, the exact parameter:

```bash
./venv/bin/python -m pytest -q 'benchmarks/cloudbench_dependency_sync_test.py::test_guest_shutdown_child_confirmation_native_stop_is_bounded_exact_and_verified[stop-always-fails]'
```

passed unchanged in 5.88 seconds. This does not reproduce the original miss and
is not a causal fix proof. The unchanged full failed gate is being rechecked;
its result remains separate from the original failure. Existing permanent test
coverage is retained. No bounds, assertions, retries, source or schemas changed.

## Solution

Unresolved. Retain the failure and exact ownership receipt; do not label a
passing isolated rerun as a repair. A future recurrence needs per-phase timings
and actual attempt instants before changing the implementation or fixture.
No native Fly resource, original browser or production agent was mutated by
these tests.

## Human feedback

The active assignment requires preserving original failed proof, narrowing
failed gates promptly, and keeping timeout bounds and assertions unchanged.
No human feedback establishing a cause or approving a native-stop change was
recorded.

## Reusable lesson

A maximum retry count inside a shared deadline is distinct from proof that all
attempts ran. Preserve both the actual request count and the original deadline
before attributing an intermittent fixture failure to scheduling.
