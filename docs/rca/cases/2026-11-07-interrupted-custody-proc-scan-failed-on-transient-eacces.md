---
id: 2026-11-07-interrupted-custody-proc-scan-failed-on-transient-eacces
date: 2026-11-07
title: The interrupted-custody namespace scan failed on the first EACCES from a briefly unreadable /proc/<pid>/fd
surface: harness
component: deploy-interrupted-cleanup
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/deploy_test_interrupted_cleanup.py namespace_quiet iterated every same-user /proc/<pid>/fd and caught only FileNotFoundError/ProcessLookupError, so a process mid-exec raised PermissionError out of the custody proof
symptoms:
  - "Permission denied: '/proc/832418/fd'"
  - "interrupted custody proof refused: [Errno 13] Permission denied"
  - "worker ownership remains; reconcile exact cleanup before recovery: smoke"
tags:
  - deploy
  - interrupted
  - custody
  - proc-scan
  - flaky
sources:
  - PR #1723 staged deploy sweep 3, deploy-command-structural, source 0d7de94dcece9ffd58482e9e7bc8ceddba89e2ea
  - commit ec1b265e79 (introduced namespace_quiet on main, 2026-11-06)
repro: python3 -B scripts/tests/deploy-test-plan.test.py InterruptedCustody
status: fixed
---

## Problem

Gate: NOT_INTRODUCED. While reproducing the sweep-3 `deploy-test-plan` failure (the fixed Hub port, see
`2026-11-07-custody-fixture-claimed-live-hub-port`), a 40-run loop of the InterruptedCustody tests with the port
collision removed still failed 7 times on the loaded devbox. Six raised
`interrupted custody proof refused: [Errno 13] Permission denied: '/proc/<pid>/fd'`; one surfaced as
`worker ownership remains; reconcile exact cleanup before recovery: smoke`, because `still_bound` swallows the same
error and returns False.

## Diagnosis

`namespace_quiet` walks `/proc`, skips other users' processes, then reads `cmdline`, `cwd` and every `fd` of each
same-user process to prove nothing still holds the old namespace. A process in the middle of `exec` is briefly
unreadable even to its owner. The loop caught only `FileNotFoundError` and `ProcessLookupError`, so one transient
EACCES aborted the whole custody proof. This is the class already recorded for the controller-export writer scan
(memory `export-helper-proc-scan-permission-flake`, fixed in `cloudbench-controller-export.py` by bounded
re-observation) appearing again in a new copy of the same loop.

Archive search: `Permission denied /proc fd interrupted custody` and `proc scan EACCES re-observe` found the
controller-export fix only through memory, not as a case; this case records the pattern.

## Solution

The per-process observation moved into `consumer_quiet`. `namespace_quiet` re-observes an unreadable process up to
`OBSERVATION_ATTEMPTS` (5) times, 0.2 s apart, skips a process that has exited, and still fails closed while the
process stays unreadable and alive. A new test in `scripts/tests/deploy-test-plan.test.py` pins both branches (recovers
after four unreadable observations; refuses after five). Before: 7 of 40 runs failed. After: 40 of 40 and 15 of 15
InterruptedCustody runs passed on the same host, and the full file passes. It runs in the `deploy-command-structural`
gate.

10k agents: a bounded 5 x 0.2 s retry per unreadable process in a launch-time safety check. Nothing scales with agent
count.

## Human feedback

None recorded.

## Reusable lesson

Every `/proc/<pid>` scan must re-observe a briefly unreadable process and fail closed only while it stays unreadable
and alive, never on the first EACCES.
