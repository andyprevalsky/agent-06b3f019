---
id: 2026-11-07-peer-refreshed-snapshot-compares-coarse-file-mtime-to-fine-clock
date: 2026-11-07
title: test_refresh_deps_applies_exact_workspace_before_rebuild[peer_refreshed] failed about 1 run in 100 because a file's integer mtime can precede a clock second read just before it was written
surface: harness
component: cloudbench-refresh-deps
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-bench-cloud peer_refreshed_snapshot required int(mtime of the warm-deps state file) >= the integer `date +%s` read before the lock, but Linux stamps file times from the coarse kernel clock, which can lag a preceding clock read by up to one tick
symptoms:
  - "AssertionError: assert 'reusing snapshot snap-peer' in '═══ run-bench-cloud --refresh-deps (ref ...)'"
  - "FAILED agents/benchmarks/cloudbench_dependency_sync_test.py::test_refresh_deps_applies_exact_workspace_before_rebuild[peer_refreshed]"
  - "FACTORY_TEST_FAILURE {\"failing\": [\"benchmark\"]} (agents-coverage-blackbox)"
tags:
  - cloudbench
  - refresh-deps
  - flaky
  - timestamp
  - coarse-clock
sources:
  - PR #1747 deploy round 4 (source 02eb65acf1), gate agents-coverage-blackbox on a Blacksmith VM; passed in rounds 2, 3 and 5 and in 6 of 6 local reruns
repro: python3 -c "write a file 40000 times and compare int(os.stat().st_mtime) with int(time.time()) read just before; 345 of 40000 pairs had the mtime second earlier"
status: open
---

## Problem

One test of the benchmark domain failed in one of five rounds of PR #1747 and passed on the identical code in the others. The scenario simulates a peer controller that refreshed the same manifests while this request waited for the app-environment lock. `peer_refreshed_snapshot` accepts the peer's state file only if `int(st_mtime) >= since`, where `since` is `date +%s` read before the lock.

## Diagnosis

Gate: NOT_INTRODUCED (`scripts/run-bench-cloud` and the test are byte-identical to main). File timestamps come from the kernel's coarse clock, which is updated once per tick, so a file written right after a fine-grained clock read can carry a mtime one second earlier when the read fell in the last tick before a second boundary. Measured on this devbox (kernel 6.1): 345 of 40,000 write/stat pairs, 0.86%. The check therefore misses a real peer refresh about once per hundred refreshes (production: one redundant refresh and snapshot, harmless; the unit test: a hard failure).

## Solution

Not done in PR #1747 (any source change reruns every gate); proposed fix:

Compare against `since - 1` (one second covers the coarse-clock lag), keep the exact-manifest and exact-ref checks that carry the real proof, and add a deterministic regression: set the state file's mtime to `since - 1` with `os.utime` (accepted) and `since - 2` (refused).

10k-agent behavior: not agent-scaled; one comparison per refresh request.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Never compare a file's mtime with a clock value read just before writing it without a one-tick tolerance; file times and the clock come from different resolutions.
