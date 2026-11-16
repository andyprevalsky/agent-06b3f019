---
id: 2026-11-16-ratchet-red-direct-merge-cleanup-admission-sleeps
date: 2026-11-16
title: Direct merge to main added fixed sleeps to cleanup-admission-parallel and turned the sleep ratchet red for every deploy
surface: harness
component: deploy-structural-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: commit 35faef1c1e added fixed time.sleep synchronization to scripts/tests/cloudbench-cleanup-admission-parallel.test.py and reached main via /push-style direct merge commit 605e194a2a, a path that never runs deploy-command-structural (test-sleep-ratchet)
symptoms:
  - "scripts/tests/cloudbench-cleanup-admission-parallel.test.py: 6 fixed literal sleeps, baseline 3 (lines 155, 204, 226, 343, 345, 363)"
  - "FAIL: test files added fixed literal sleeps used as synchronization"
  - deploy-command-structural fails in suite test-sleep-ratchet
tags:
  - deploy
  - synchronization
  - main-red
  - sleep-ratchet
sources:
  - commit 35faef1c1e
  - commit 605e194a2a
  - commit 291a20af54
repro: python3 scripts/tests/condition-waits.test.py RatchetCase.test_current_tree_passes
status: fixed
---

## Problem

On origin/main 530b71fe93, the /deploy gate deploy-command-structural failed in
suite test-sleep-ratchet for every PR (#2288, #2289, #2285, #2282, #2262 among
others). `python3 scripts/tests/condition-waits.test.py RatchetCase.test_current_tree_passes`
exits 1: `scripts/tests/cloudbench-cleanup-admission-parallel.test.py: 6 fixed
literal sleeps, baseline 3 (lines 155, 204, 226, 343, 345, 363)`.

## Diagnosis

- 35faef1c1e (2026-11-16 05:46Z, "wait for teardown disk reserve instead of
  failing as INFRA") added three capacity-wait tests that synchronized with
  fixed sleeps: an 8 s poll loop for the `consumed` marker, then two
  `time.sleep(2.5)` calls before asserting that the controller was still
  waiting. The file's baseline stayed at 3 (the three pre-existing sleeps:
  the `wait_entries` and `allocated-*` poll loops and a `time.sleep(.15)`
  no-overspend window).
- The commit reached main without a PR: bc3e7db882 (05:49:26Z) merged
  origin/main into `fix/cleanup-reserve-capacity-wait`, then direct merge
  commit 605e194a2a (05:49:54Z, the `/push` Step 3 `merge: …` template, with
  Andy as committer rather than GitHub) landed it on main's first-parent
  line. The ratchet runs only as the `test-sleep-ratchet` gate in
  `scripts/run-deploy-structural-gates.py`. No GitHub workflow runs it, and
  `/push` Step 2 never runs it for any kind of change, so nothing checked the
  count going from 3 to 6. Every later PR deploy's deploy-command-structural
  then failed on main's tree (reported for #2288, #2289, #2285, #2282 and
  #2262).
- Contributing: the test file is not registered in any /deploy lane
  (`select_affected_tests.py --lanes-for` reports NOT RUN), so the
  `--stability` selector also skips it. Only the ratchet's whole-tree scan
  sees it.

## Solution

All six sleeps now wait on observable conditions through
`scripts/lib/condition_wait.wait_until`. Assertions and timeouts are unchanged.
The file's baseline entry was removed (3 to 0):

- The poll loops became `wait_until` calls with the same 4 s / 8 s timeouts.
- No-overspend window: the fixture's child `sitecustomize` records each
  `retry_pause` backoff. The test waits until the third allocator has
  re-evaluated against pending liability twice, or refused, while both peers
  hold the allocation barrier. It then asserts that there are still exactly two
  allocations. This is stronger than a 150 ms window.
- Capacity waiters: controller stderr goes to a per-process file, and the test
  waits for two `⏳` retry lines, or an exit, before asserting that the
  controller is still waiting. A mutation that makes shortage `return 1`
  instead of waiting fails both tests in 0.5 s.

The fix is test-only and has no runtime or 10k-agent effect.

Not changed (follow-up): registering this file in a /deploy lane, and making
`/push` run `scripts/check_test_sleeps.py` (the structural ratchet).

## Verification

- Before: the repro command exits 1 with the symptom above. After (291a20af54):
  exit 0, `test sleep ratchet OK`.
- The changed file passed 5 consecutive runs (17 tests each, about 13 s) with
  4 CPU busy loops on 8 cores.

- A fresh sub-agent, given only the symptom, independently confirmed the
  first bad boundary (35faef1c1e) and the `/push` direct-merge path.

## Human feedback

None recorded. The coordinator directed the fix: convert the sleeps to
condition waits, do not raise the baseline, and do not weaken assertions or
timeouts.

## Reusable lesson

A test change merged to main outside a PR/deploy skips the sleep ratchet; wait
on the controller's own observable progress (a log line, a recorded backoff, a
marker file), never on elapsed time, and run `scripts/check_test_sleeps.py`
before any `/push` direct merge.
