---
id: 2026-10-16-coverage-failure-cleanup-deleted-raw-v8
date: 2026-10-16
title: Failed backend coverage cleanup deleted healthy suites raw V8 measurements
surface: harness
component: backend-coverage-cleanup
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: run-coverage.sh EXIT cleanup unconditionally removed coverage/tmp after a failed test phase without archiving raw V8 inputs
symptoms:
  - "Coverage for statements (34.57%) does not meet global threshold (88%)"
  - "Only browser retry coverage remained after 283 unit files and 198 blackbox domains passed"
tags:
  - coverage
  - cleanup
  - evidence
sources:
  - task .context/rca-time-grounding/coverage-report-recovery.log
  - task .context/rca-time-grounding/deploy-coverage-final.log
  - task .context/coverage-report-rca/retention-unit-before.log
  - task .context/coverage-report-rca/retention-unit-after.log
repro: cd back-end && node --import tsx src/tests/unit/coverage-failure-evidence.test.ts
status: fixed
---

## Problem

A complete backend run passed 283 unit files and 198 of 199 blackbox domains.
The remaining live Steel profile was externally UPLOADING. That provider failure
is separate from this instrumentation defect: the unchanged focused browser
retry passed, but reporting afterward yielded 34.57% statements, 69.95% branches,
and 37.28% functions. These percentages measured only the focused retry.

## Diagnosis

Path: completed suites -> raw V8 files -> failed test-phase exit -> EXIT cleanup
-> focused retry -> c8 report. Failure preservation copied logs before exiting;
cleanup subsequently reaped owned processes and unconditionally deleted all raw
coverage. The original full-run measurements were lost. The remaining directory
had 16 JSON files, all from the later browser retry, with no unit-test script
entries. c8 reporting an immutable copy reproduced the exact percentages.

Archive searches used `c8 coverage source maps` and `coverage collection low
coverage`. Existing startup, timeout and ownership cases are relatives, not this
first bad boundary. The deletion also reproduced with the actual extracted
cleanup function. The final owning evidence test failed against unchanged HEAD
with `completed archival must report its recovery path` and passed after the
fix, using the same assertions.
No source-map corruption or baseline coverage regression is established.

## Solution

After the existing owned-process reaping and guardian disarming, archive raw V8
inputs on any unsuccessful exit. Reuse the existing failure evidence directory,
or create a per-run failure directory if an earlier failure did not create one.
Copy the contents, including hidden files, into an explicitly incomplete staging
directory, and publish `raw-v8` only after the copy succeeds. Refuse an existing
archive so it cannot be overwritten or nested. Delete working data only after
successful publication. On archival failure, report and retain the working
inputs; startup refuses to discard any unrecovered raw inputs on the next run. Successful cleanup, reservation release, original exit status,
thresholds, exclusions, test assertions, runtime behavior and budgets are unchanged.

The existing coverage-failure-evidence unit extracts the actual launcher cleanup,
starts an owned child that flushes on TERM, and executes its EXIT trap. It checks
failure archival including late-flushed data and fallback directory creation,
success cleanup, directory-creation
failure, a genuinely partial copy that never becomes a published archive,
existing-archive protection, preservation through the next invocation, exit status,
guardian disarming and reservation release. No database or paid provider is used.
The original full-run data cannot be recovered: a new complete collection remains
necessary to establish aggregate coverage after this correction.

## Human feedback

Preserve healthy test verdicts during an external provider outage. Never report a
focused retry's raw coverage as the complete run, weaken thresholds, or rerun
healthy suites before identifying the instrumentation boundary.

## Reusable lesson

Coverage inputs are failure evidence. Preserve them after process shutdown has
flushed all writers, and fail visibly without deleting the source if archival fails.
