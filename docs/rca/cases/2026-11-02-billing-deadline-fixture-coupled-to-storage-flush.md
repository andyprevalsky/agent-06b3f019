---
id: 2026-11-02-billing-deadline-fixture-coupled-to-storage-flush
date: 2026-11-02
title: Billing guest deadline fixture coupled dispatch to filesystem flush latency
surface: harness
component: cloudbench-bootstrap-recovery-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: real durability flushes consumed the short deadline fixture margin before the integer guest timeout was computed
symptoms:
  - "AssertionError: [] is not true : actual guest dispatch must be reached"
  - "insufficient guest deadline remaining"
  - "test_metadata_publication_does_not_extend_real_blocking_guest_deadline"
tags:
  - cloudbench
  - billing-stop
  - fsync
  - real-timer
  - deploy-structural-gates
sources:
  - commit 79edd36b9a0231f74cfd0b492f10c13b9008e686
  - commit 72a8bd7bf7e3a92b5717d13d617c2954bf453fca
  - agent thr_edb51868b4634dc5ba02d1176d0d1bcc
repro: python3 scripts/tests/cloudbench-bootstrap-recovery.test.py BillingStopRetainTests
status: fixed
---

## Problem

The unchanged three-worker deploy structural command failed the metadata/guest
wall-clock test at source 79edd36: 99 tests, one failure, three native skips,
106.910 seconds. On current main 72a8 the same unchanged command reproduced
that exact assertion: 99 tests, one failure, three native skips, 95.056 seconds.
PENDING and no STOP POST passed; guest dispatch was never reached.

## Diagnosis

The path is caller timer -> local custody/locks -> durable owner/intent
publication -> native Machine/Volume GETs -> guest timeout conversion -> guest
transport. The fixture gives the entire call 1.5 seconds, deliberately spends
0.25 seconds publishing metadata and requires an integer guest timeout of one.
The production helper correctly refuses dispatch once less than one whole
second remains. Therefore all other preparation must fit within approximately
0.25 seconds. Including unbounded host disk writeback inside that margin made
this deadline-accounting test depend on unrelated storage service time.

A controlled replay ran the original test unchanged against the real helper,
files, locks and publication. A wrapper performed each real fsync and then
slept 40 ms. It reproduced the exact empty-dispatch assertion in 0.850 seconds:
14 sync calls, both native GETs, PENDING, no POST, and the retained private
refusal `insufficient guest deadline remaining`. The same replay passes with
the test repair and reaches the real alarm inside the blocking guest.

This establishes the fixture coupling, not the trigger of either native
occurrence. Neither native occurrence recorded its returned refusal or phase
clocks, so neither is retrospectively attributed to fsync or host load. Ten
unchanged focused runs also passed before the repair. Arbitrary scheduler
pauses can still affect real-time assertions.

Archive searches used the literal dispatch assertion, retained-owner billing
and metadata/guest-deadline terms, and filesystem/fsync/fixture terms. The
configured billing-stop and large-catalog host-guard cases are relatives;
no existing case established this dispatch boundary. Compared source 79edd36
and baseline 9152 have identical owning dependency bytes (NOT_INTRODUCED).
That attribution did not waive this assigned repair.

## Solution

Isolate fsync service latency only inside this one short deadline test. Keep
the actual helper, writes, exclusive renames, file locks, 0.25-second metadata
delay, real ITIMER_REAL, three-second blocking guest, original 1.5-second
caller budget, less-than-1.62-second elapsed assertion, integer timeout [1],
PENDING and no-STOP assertions unchanged. No production code, timeout policy,
financial state or credential changes are involved.

Strengthen the existing durable final-pair test separately: call real fsync
and real exclusive rename; require each temporary receipt file's inode to
have been synchronized before rename and its directory synchronized after
that rename. Verify all three pre-guest publications before actual dispatch
and every final private receipt afterward. Preserve every existing byte,
mode, hash, custody and native-state assertion.

This deletes an unrelated latency dependency instead of adding a production
fallback or relaxing a bound. Golden reference: not applicable (no
approval-gated hunk). At 10,000 agents runtime behavior and resource usage are
unchanged; the additional observation is confined to the offline fixture.

## Verification

The same injected-real-sync replay fails before and passes after the fixture
repair. Restoring the stale nested timer fails the unchanged elapsed bound
at 1.752124 seconds. Removing publication file fsync fails before the first
owner-snapshot rename. These inverse controls establish that deadline
accounting and actual durability remain independently guarded.

The owning test is registered in the unchanged deploy structural registry,
including its two-shard selection. Both owning tests passed five consecutive unchanged runs and the full
26-test billing family passed. Final structural and deployment receipts are
retained by the repair's deploy owner; native skips are not passes.

## Human feedback

The user required preservation of all original assertions, wall-clock and
guest-timeout bounds, the original failure and unknowns, financial facts,
Freedom and protected instructions. Attribution never released this assigned
repair. No credential, quota or top-up mutation was authorized.

## Reusable lesson

Isolate unrelated storage latency in short real-time deadline fixtures and separately verify actual publication durability in the same owning suite.
