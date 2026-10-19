---
id: 2026-10-16-subprocess-alarm-discarded-private-output
date: 2026-10-16
title: Subprocess alarm discarded captured private output
surface: harness
component: cloudbench-original-volume-capture
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run_bounded terminated and reaped an interrupted child without retaining captured stdout and stderr on the original exception
symptoms:
  - SFTP alarm left no saved subprocess stdout or stderr
  - TimeoutError retained its traceback but lacked captured byte streams
tags:
  - cloudbench
  - subprocess
  - diagnostic-retention
sources:
  - PR #1525
  - task observations-5ee33b5b689f5275/844543c2221368/operator.stderr.private.txt
repro: python3 scripts/tests/cloudbench-bootstrap-recovery.test.py BoundedProcessOutputTests
status: fixed
---

## Problem

The existing primary observation of Machine `844543c2221368` hit its30-second
SFTP upload alarm after source start and stage acknowledgment. Its total elapsed
time was35.5138 seconds. The alarm message said `phase180s`, although the nested
call timer had selected30 seconds. The saved traceback ended in
`subprocess.communicate` → `selector.poll` → the caller's alarm handler.
The observer writes SFTP stdout/stderr only after the helper returns, so neither
stream was available in its ordinary result files after the exception.

The separate Machine `846453a2692338` hit its20-second snapshot-list GET limit
before start. Its20.4086-second failure was wrapped as `CaptureFailure` by
`Fly.api`, whose `OSError` handler also catches `TimeoutError`. These incidents
do not establish a network, authentication, or provider root cause. Both original
PENDING receipts were retained and root separately verified stopped custody.

## Diagnosis

The proven defect here is output retention, not the cause of either timeout.
`run_bounded` already terminated/reaped on `BaseException`, but rethrew before
exposing bytes accumulated by `communicate`. Its ordinary timeout branch already
returned output with status142; an outer alarm took the other branch.

Archive searches `SFTP TimeoutError partial stdout stderr` and
`subprocess communicate signal output lost` found related SFTP transport and
lost-error-detail cases, but no matching interrupted-subprocess retention fix.
The prior SFTP retry case addresses another boundary and does not authorize a
retry or a timeout increase in this transaction.

The registered `BoundedProcessOutputTests` starts a real local child, waits for
its ready marker after writing binary stdout/stderr, then raises the original
`TimeoutError` from an actual SIGALRM. Before the fix, both alarm controls failed
because the rethrown exception had no `stdout` attribute. The normal-completion
and ordinary subprocess-timeout controls already passed.

## Solution

After the existing termination/reap, retrieve already captured byte streams with
zero additional wait and attach them as `stdout` and `stderr` to the same exception.
If pipe handles remain open, the zero-wait `TimeoutExpired` result carries the
accumulated bytes; close the local handles and rethrow the original exception.
The helper prints neither stream. This does not promise bytes that had not yet
been captured or change the original timeout, retry, or cleanup policy.

The caller can persist these attributes privately. Existing callers do not yet
write them automatically; active hash-bound packages are not rewritten by this
change. `Fly.api` exception wrapping is unchanged and remains a separate
diagnostic-propagation question.

## Validation

Owning command, run from the isolated f091-based worktree:

```sh
python3 scripts/tests/cloudbench-bootstrap-recovery.test.py BoundedProcessOutputTests
```

Four controls passed five consecutive unchanged runs: exact private binary
streams on alarm, empty streams on alarm, ordinary successful tuple return, and
the unchanged status142 subprocess-timeout return. Alarm controls verify the
same exception object, reaped child, no printing, and no extra drain wait.
All other top-level production AST, including the historical guest functions
and `Fly` class, remained identical. Registration is through the existing
`cloudbench-bootstrap-recovery` structural gate. No provider or guest call ran.

## Human feedback

Root requested only a narrow isolated diagnostic-retention fix, with no changes
to active packages, timeouts, retries, or provider operation. Underlying transport
causes and REAL600 qualification remain open.

## Reusable lesson

Preserve diagnostics across both subprocess timeout and caller-interruption
paths. Attach private captured bytes to the original exception without printing
them or introducing another wait after the deadline. A retention fix does not
establish the reason the interrupted operation was slow.
