---
id: 2026-11-02-billing-deadline-fixture-coupled-to-storage-flush
date: 2026-11-02
title: Billing guest deadline fixture coupled dispatch and post-deadline diagnostics to filesystem latency
surface: harness
component: cloudbench-bootstrap-recovery-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: real durability flushes consumed the short deadline fixture margin before the integer guest timeout was computed; recurrence - the post-alarm failure.original.private.txt create in _billing_stop_one ran inside the timed window with no clock bounding it
symptoms:
  - "AssertionError: [] is not true : actual guest dispatch must be reached"
  - "insufficient guest deadline remaining"
  - "test_metadata_publication_does_not_extend_real_blocking_guest_deadline"
  - "AssertionError: 2.532839588999991 not less than 1.62 : metadata publication was added back to whole-call deadline"
  - "not less than 1.62 : metadata publication was added back to whole-call deadline"
tags:
  - cloudbench
  - billing-stop
  - fsync
  - post-deadline
  - mkstemp
  - real-timer
  - deploy-structural-gates
sources:
  - commit 79edd36b9a0231f74cfd0b492f10c13b9008e686
  - commit 72a8bd7bf7e3a92b5717d13d617c2954bf453fca
  - agent thr_edb51868b4634dc5ba02d1176d0d1bcc
  - PR #1967 gate round 3 deploy occurrence d2ae5979abb44f298a9f22fd46f36b2e (failed source f8ca329701607c1008663604a5758f5baffae1ff)
  - commit a2d48bbf18bc676c7df062ef7ab75cd24e2507cb (repair base, branch fix/billing-metadata-deadline-flake)
repro: python3 scripts/tests/cloudbench-bootstrap-recovery.test.py BillingStopRetainTests
status: fixed
---

## Problem

The unchanged three-worker deploy structural command failed the metadata/guest
wall-clock test at source 79edd36: 99 tests, one failure, three native skips,
106.910 seconds. On current main 72a8 the same unchanged command reproduced
that exact assertion: 99 tests, one failure, three native skips, 95.056 seconds.
PENDING and no STOP POST passed; guest dispatch was never reached.

Recurrence (2026-11-15). PR #1967 gate round 3 (deploy occurrence
d2ae5979, failed source f8ca3297, Blacksmith runner, shard 2-of-2) failed the
same test's other wall-clock assertion: `2.532839588999991 not less than 1.62 :
metadata publication was added back to whole-call deadline` (105 tests, one
failure, four native skips). Guest dispatch was reached and the result was
PENDING. The unit passed its single same-source rerun (FLAKY). PR #1967 changed
only GitHub token resolution (NOT_INTRODUCED); this attribution did not release
the assigned repair.

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

Recurrence diagnosis. The alarm bounds everything before it, so the native
1.03 s excess happened after the 1.5 s alarm fired. Path after expiry: the
nested `_billing_stop_one` alarm interrupts the blocking guest; its except
block publishes `failure.original.private.txt` (mkstemp create, write, the
patched fsync, renameat2, directory open); its finally restores the caller
timer to 1 µs, the outer whole-call handler raises, and the call returns. The
nested timer replaced the one-shot outer timer and has already fired, so no
clock bounds that diagnostic. A phase-timing harness, which observes without
changing behavior, wrapped setitimer, SIGALRM handlers, publish_bytes, mkstemp,
rename_noreplace and fsync_directory. Under local CPU plus ext4 writeback and
small-file churn stress, the unchanged test failed with the exact assertion at
1.6745 s and 1.633 s. In both, all of the excess was inside the post-alarm
diagnostic `mkstemp` (174 ms, 132 ms), while the pre-guest publications stayed
inside the clock. An interleaved A/B under identical stress failed 6/120 on
the unchanged fixture: five of this elapsed assertion and one of the 11-02
dispatch assertion. Injecting a 1.03 s stall after the real mkstemp of only
that diagnostic reproduced the native value exactly: `2.5311371919960948 not
less than 1.62`.

The 1.62 s bound exists to catch a nested timer re-armed with the full
duration (~1.75 s). The post-deadline diagnostic is deliberate production
behavior: the fleet caller also writes a durable pending receipt after its own
deadline. Its storage service time is unrelated to that regression, but it sat
inside the 0.12 s slack. The native runner left no phase clocks, so the
Blacksmith stall is attributed only to a post-alarm stall consistent with the
measured namespace-operation latency. Journal waits are an inference: no wchan
or jbd2 samples exist. Production behavior is correct and unchanged.

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

Recurrence solution. In this one deadline test, the fixture records the
post-deadline `failure.original.private.txt` publication and performs it with
the real `publish_bytes` immediately after `elapsed` is measured. It then
asserts that production requested exactly that one post-deadline publication
and that its published content is `billing absolute deadline`. These are
unchanged: the 1.5 s caller alarm, the 0.25 s owner-snapshot delay, the 3 s
blocking guest, the < 1.62 s elapsed bound, integer guest timeout [1], PENDING,
no STOP POST, dispatch, and the fsync isolation. Production code is unchanged.
Golden reference: not applicable (no approval-gated hunk). At 10,000 agents,
runtime behavior and resources are unchanged.

Separate finding, not fixed here: when the outer alarm fires right after
`_billing_stop_one`'s finally re-arms the caller timer, `os.close(lock)` is
skipped. The per-Machine claim lock fd then stays open until the short-lived
caller process exits. The current-idle stop path has the same
restore-then-close ordering. This is recorded as a follow-up.

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

Recurrence verification on the repair branch. The injected 1.03 s
post-deadline stall failed before the fix (`2.531 not less than 1.62`) and
passes after it. The stale nested timer (`setitimer(duration)`) still fails the
unchanged bound at 1.7529 s on the new fixture. Removing the production
diagnostic publication fails the new assertion (`[] !=
['failure.original.private.txt']`). Under identical stress, the interleaved A/B
went 6/120 failures (base) to 0/120 (fixed). Five consecutive unchanged
focused runs passed. The full owning suite passed: 211 tests, OK, 7 native
skips. Arbitrary scheduler pauses longer than about 0.25 s before dispatch can
still fail the dispatch assertion; that was not observed in the 120 fixed
stress runs.

## Human feedback

The user required preservation of all original assertions, wall-clock and
guest-timeout bounds, the original failure and unknowns, financial facts,
Freedom and protected instructions. Attribution never released this assigned
repair. No credential, quota or top-up mutation was authorized.

Recurrence (2026-11-15): the repair goal required preserving the assertion, the
1.5 s alarm, the 0.25 s delay, the 3 s guest and every margin, and forbade
waiving or re-delegating the assigned test.

## Reusable lesson

Isolate unrelated storage latency in short real-time deadline fixtures, including post-deadline diagnostic writes that no clock bounds, and separately verify actual publication durability in the same owning suite.
