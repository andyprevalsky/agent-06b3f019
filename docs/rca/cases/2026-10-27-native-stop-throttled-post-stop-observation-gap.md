---
id: 2026-10-27-native-stop-throttled-post-stop-observation-gap
date: 2026-10-27
title: Throttled native stop ended without a final status observation
surface: harness
component: native-stop-positive-fixture
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: after the second native stop the fake becomes stopped but the receipt retains started; per-call timing and deadline position are unrecorded
symptoms:
  - "test_guest_shutdown_child_confirmation_native_stop_is_bounded_exact_and_verified[throttled]"
  - "Machine deadbeef000001 still reads started after 2 stop requests"
  - "assert 1 == 0"
tags:
  - native-stop
  - deadline
  - post-stop-verification
  - throttled
  - observation-gap
sources:
  - commit 88864ecde0a1d45bbf32cb1ab6c42ed10f9dde94
  - agent 01a17947-78f9-7ee2-b6b1-b01b12172923 deploy 20261027-010544-539506 batch7
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_guest_shutdown_child_confirmation_native_stop_is_bounded_exact_and_verified[throttled]
status: open
---

## Problem

Batch7 command verification failed the positive throttled native-stop case at
the expected-returncode0 assertion. Actual returncode1 reported two stop requests
without verified STOPPED and retained ownership. The independent elapsed<14s
assertion passed. The native selection reported1117passed/1failed/4skipped with
1238deselected; the complete command exited1 after962.6s.

## Diagnosis

The exact original pytest-194/conf25 fixture and eight siblings were rescued.
Its fake Machine state became stopped at18:15:42.802537Z, while the receipt at
18:15:43.138539Z retained verified=false/state=started. The call log ends with the
second stop and no later status read. This establishes missing final observation,
but not whether the wrapper returned before its native deadline: original
per-operation/FIFO/nativeSECONDS timings were absent. The earlier October20
request-count/integer-clock case fails a different assertion and is not adopted
as this cause.

## Solution

No source patch or deadline change is proposed. One unchanged pinned native
case passed in2.59s (native2.3615s, two stops, nativeSECONDS3), preserving6/2/14/30s,
cap3, exact IDs/volume/ownership and verification assertions. This is a passing
baseline, not a repair. A bounded metadata-only next-occurrence observer is
prepared but not activated. Private evidence and original-boundary receipt:
.context/deploy-fresh-20261027/rca-native-stop-batch7/.

## Human feedback

None recorded for this incident. The snapshot-scoped approval and unchanged
behavior requirements above come from repository/coordinator instructions, not
new user feedback.

## Reusable lesson

Retain native call return and deadline timing before deciding why a final stop observation was skipped.
