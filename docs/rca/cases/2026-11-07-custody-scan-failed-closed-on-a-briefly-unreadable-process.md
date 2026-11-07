---
id: 2026-11-07-custody-scan-failed-closed-on-a-briefly-unreadable-process
date: 2026-11-07
title: The interrupted-custody scan treated a same-uid process that was briefly unreadable under /proc as retained ownership
surface: harness
component: deploy-test-cycle
classification: test-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: scripts/deploy_test_interrupted_cleanup.py namespace_quiet read /proc/<pid>/fd of every same-uid process once and only skipped a vanished process; a process changing credentials refuses that read for a moment and the PermissionError was turned into "ownership remains" by still_bound
symptoms:
  - "ValueError: worker ownership remains; reconcile exact cleanup before recovery: smoke"
  - "interrupted custody proof refused: [Errno 13] Permission denied: '/proc/3026149/fd'"
  - deploy-command-structural failed one suite, deploy-test-plan InterruptedCustody (cloud=True)
tags:
  - deploy-test-cycle
  - custody
  - proc-scan
sources:
  - PR #1744
repro: scripts/tests/deploy-test-plan.test.py InterruptedCustody.test_custody_scan_reobserves_a_process_that_is_briefly_unreadable (red against the old validator, green after); the live flake was reproduced 1 run in 12 of the unchanged InterruptedCustody class under host load
status: fixed
---

## Problem

One suite of the structural gate failed during the first staged cycle on this branch while nine cloud controllers and five gates ran.
The files involved are byte-identical to main and the class passed 11 of 11 in isolation, so the failure is NOT_INTRODUCED.

## Diagnosis

A 12-run loop of the unchanged class under the same load produced one failure with the underlying error,
`[Errno 13] Permission denied: '/proc/<pid>/fd'`, raised by the per-process scan. `still_bound` catches OSError and returns False,
which is how the same read failure surfaces as "worker ownership remains" at the later boundary check. A transient read failure is not
evidence about the namespace.

## Solution

`observe_process` re-reads an unreadable process up to five times 0.2 s apart, skips it once it has exited and still fails closed
while it stays unreadable and alive, the same shape as the export helper's writer scan. The regression stubs the process and
asserts all three outcomes.

## Human feedback

None; found by the staged deploy cycle of PR #1744.

## Reusable lesson

A bounded re-observation belongs inside the observer; swallowing OSError further up turns a failed read into a verdict.
