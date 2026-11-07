---
id: 2026-11-07-native-stop-last-tick-test-ignored-post-send-deadline-exhaustion
date: 2026-11-07
title: Native-stop last-tick test required verification after a successful send even when the production clock had already refused the status read
surface: infra
component: agents/benchmarks/cloudbench_dependency_sync_test.py native stop last budget tick
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "agents/benchmarks/cloudbench_dependency_sync_test.py test_guest_shutdown_child_confirmation_native_stop_success_is_verified_in_last_budget_tick — accepted deadline exhaustion only when no stop was sent"
symptoms:
  - "reads started, not verified stopped, after 2 native stop request(s); retaining ownership for exact-owner recovery"
  - "FAILED benchmarks/cloudbench_dependency_sync_test.py::test_guest_shutdown_child_confirmation_native_stop_success_is_verified_in_last_budget_tick[True]"
tags:
  - cloudbench
  - deploy
  - timing
  - load
sources:
  - PR #1749 staged deploy, gate deploy-command-structural (benchmark-live-results shard 4/6) on 8d436372f
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_guest_shutdown_child_confirmation_native_stop_success_is_verified_in_last_budget_tick[True] under CPU contention
status: fixed
---

## Problem

In PR #1749's deploy, `deploy-command-structural` failed on
`test_guest_shutdown_child_confirmation_native_stop_success_is_verified_in_last_budget_tick[True]`:
"reads started, not verified stopped, after 2 native stop request(s); retaining
ownership", and the test then failed `assert 1 == 0`.

## Diagnosis

The test runs the production stop/verify in the last second of a real
6-second `SECONDS` deadline. It already accepts the case where no stop is sent
because the clock refused. Under load the stop was sent at `seconds=5`, and at
`seconds=6` the trace shows `fleet_native_stop_call_budget: return 1`: the
production clock refused the post-stop status read and ownership was retained.
That is the documented "exhausted native time must retain ownership" outcome,
but the test treated it as a failure. With 24 busy loops on the 8-core box the
unchanged test failed 5 of 8 runs. The PR's runtime diff does not touch this
path.

## Solution

When the machine would reach `stopped` but the run exits non-zero, the test
requires `_native_stop_last_tick_exhausted(trace, deadline)`, an unverified
receipt and "retaining ownership". Otherwise it still requires a verified stop.
Under the same contention: 0 of 8 failures.

## Human feedback

None: found and fixed inside PR #1749's deploy.

## Reusable lesson

A real-clock deadline test must accept every outcome the production contract
allows at that deadline, each proved from the clock trace.
