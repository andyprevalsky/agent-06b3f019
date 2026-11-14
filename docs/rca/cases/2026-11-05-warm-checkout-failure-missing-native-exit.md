---
id: 2026-11-05-warm-checkout-failure-missing-native-exit
date: 2026-11-05
title: Warm checkout failure omitted native exit and duration
surface: harness
component: cloudbench-warm-checkout
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: warm_source_fetch_ref reports one generic checkout failure without the captured ssh exit code or elapsed time
symptoms:
  - "ssh shell: session forcibly closed; the remote process may still be running"
  - "exact remote checkout failed (ssh_exec timed out or remote error; bound=240s)"
tags:
  - cloudbench
  - warm
  - ssh
  - diagnostic
sources:
  - commit 3d4c6c5088b10c1da23622ed91ed22ee45482f8c
  - agent ph74ebnstpp2yzn24y8xhn60d58h7wfd
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_warm_checkout_failure_preserves_native_exit_and_logs_duration
status: open
---

## Problem

Round16 r001-j0008 reports forced SSH closure during warm checkout. The log's
240-second bound does not reveal whether the captured native exit was 124 or
another error. This obscures the first causal boundary and cannot justify a
retry or timeout increase. The original application checks remain UNVERIFIED.

## Diagnosis

Native r001-j0008.log lines289 and294 show a recovered stopped-state transition
and later forced SSH closure. Lines295-301 show checkout failure and normal
maintenance cleanup. A sibling completed the same base fetch, rebuilt the deps,
published a snapshot and allocated a two-machine canary; no zero-allocation
claim applies to this campaign. Native buffered app logs retained guest shutdowns
at08:04:09 and08:08:42 UTC, but no calling API identity. The historical events
endpoint returned only three later events. Bounded version-history retrieval
could not reach the incident, so current08:40 state is not incident evidence.
The underlying sender/SSH cause remains unresolved.

## Solution

Diagnostic only: at the existing nonzero exit branch emit the already captured
native status, machine ID, elapsed shell seconds and unchanged bound. Retain the
same return code, cleanup, one checkout invocation and every existing timeout.
No new retry or fallback is added. Fault injection verifies status0/1/124/255,
one checkout call, unchanged240-second argument and no credential disclosure.
This mitigates future observability only; it does not fix or pass the failed gate.
The sibling existing auth/source-binding tests also remain unchanged and pass.
Golden reference: not applicable (no approval-gated hunk).

## Human feedback

The parent required bounded read-only historical investigation and explicitly
forbade treating a diagnostic as a cause fix, cleanup authority or gate PASS.
No lifecycle operation, financial action, canonical edit or campaign retry was
authorized. Existing missing-provenance reconciliation still blocks this owner.

## Reusable lesson

Log a captured native status and duration at its failure boundary without changing the operation's semantics or inferring the cause from its configured timeout.
