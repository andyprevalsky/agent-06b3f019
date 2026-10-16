---
id: 2026-10-16-process-scan-swallowed-observation-deadline
date: 2026-10-16
title: Process inventory swallowed an observation deadline as an unreadable entry
surface: infra
component: cloudbench-original-volume-capture
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-original-volume-capture.py _scan_processes OSError handler
symptoms:
  - "TimeoutError not raised"
  - "original observation deadline"
  - "preliminary process scan swallowed TimeoutError"
tags:
  - cloudbench
  - process-inventory
  - timeout
sources:
  - PR #1525
  - commit 5011dff116a29f0c966d5cedbac9984e601ba513
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py OriginalVolumeProcessScanTests
status: fixed
---

## Problem

During PR #1525 continuation, finite review of the prepared read-only guest
collector found that its preliminary process scan could swallow the one-shot
observation alarm. The copied scan originated in the canonical volume-capture
helper. This is a locally reproduced source defect; it is not a claim that this
boundary caused either original REAL600 infrastructure failure.

The registered command `python3 scripts/tests/cloudbench-bootstrap-recovery.test.py
OriginalVolumeProcessScanTests -v` failed with `TimeoutError not raised` against
helper SHA256 `9468496cc13d9580fdd2e73576d083a29c958f7b861eecae945e72993bfc3c04`.
The same command and unchanged test SHA256
`6882ce021bf66e4ac47d0348072252c79bed696533cee75de25de644dfb2beb9`
passed against the two-line fix. Raw receipts remain in the continuation's
private `scan-timer-rca` evidence directory. A subsequent full suite exposed
separate fixture failures, repaired without runtime changes. The existing full
bootstrap-recovery suite passed all 104 tests in 40.993 seconds under the
activated Python 3.11.9 environment. Independent source review accepted the
causal fix; original REAL600 outcome verification remains separate.

## Diagnosis

The critical path is observation deadline, process cmdline read, broad OSError
handler, then scan result. Python's TimeoutError subclasses OSError, so the
handler treated the deadline as a transient unreadable process and continued.
If a caller implements its absolute deadline with a one-shot alarm, that alarm
has already fired; continuing loses the intended control boundary.

The regression supplies one inert process, a cmdline read that raises the exact
TimeoutError object, and a later forbidden process. Before the fix, the scan
continued instead of propagating that object. Ordinary OSError,
PermissionError and FileNotFoundError retain their previous handling and the
later forbidden-process evidence. The defect is exception classification,
not an insufficient timeout or insufficient capacity.

Archive searches used `TimeoutError OSError swallowed` and `process scan
deadline`, plus literal `_scan_processes` searches. No existing case described
this boundary. Searches of the local Claude Code, OpenClaw, Hermes and Codex
references found no directly equivalent Python process-inventory alarm handler;
those searches do not establish a reference implementation for this mechanism.

## Solution

Rethrow TimeoutError before the existing OSError continuation. Keep the ordinary
unreadable-process policy and all native ownership/cleanup checks unchanged.
The existing bootstrap-recovery suite owns both the regression and its ordinary
error control; its existing deploy registration discovers the new tests.

This adds no retries, timers, shared state, provider operations or work per
process. At 10,000 agents it retains the same bounded per-scan traversal and
terminates on the deadline instead of continuing. The separately prepared
collector contains the corresponding guard, but its private controls alone are
not permanent regression coverage. Neither source correction supplies native
admission or original benchmark outcome proof.

## Human feedback

The user required RCA for every error, including recovered errors, identical
registered RED-to-GREEN verification, preservation of data and Freedom, and
rerunning the unchanged REAL600 experiment until qualified. Deployment remains
with the original parent; this continuation must not deploy.

## Reusable lesson

Propagate deadline exceptions before broader filesystem-error handlers so a failed observation cannot silently outlive its owner.
