---
id: 2026-11-08-relay-startup-fixture-pid-replace-broke-frame-length
date: 2026-11-08
title: Relay startup-evidence test replaced a PID inside a length-prefixed Fly agent frame, so a different-length test PID refused on framing instead of identity
surface: harness
component: deploy-native-cleanup
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/deploy-test-cycle.test.py RelayStartupEvidence.test_original_fly_logs_allow_only_absent_same_boot_startup_agent built its foreign-PID mutations with prior.replace(str(pid), str(os.getpid())), which also rewrote the JSON payload of the length-prefixed PING frame without re-encoding its length
symptoms:
  - "AssertionError: \"bootstrap|PING|shutdown\" does not match \"native cleanup proof refused: native cleanup: startup native frame length\""
  - "ValueError: native cleanup: startup native frame length"
  - "FAIL: test_original_fly_logs_allow_only_absent_same_boot_startup_agent (__main__.RelayStartupEvidence"
tags:
  - deploy-test-cycle
  - native-cleanup
  - fly-agent-logs
  - pid-digit-length
  - flaky-fixture
sources:
  - PR #1762 repair devbox (2026-11-08), found during the five consecutive deploy-test-cycle runs for the InterruptedLocalRecovery hermetic-scan fix; run 4 of 5 failed, runs 1-3 and 5 passed on the same bytes
repro: python3 scripts/tests/deploy-test-cycle.test.py RelayStartupEvidence.test_original_fly_logs_allow_only_absent_same_boot_startup_agent, with os.getpid patched to a PID of a different digit count (one more digit than the real one)
status: fixed
---

## Problem

One of five consecutive full `deploy-test-cycle` runs (189 tests, unchanged bytes) failed:

```
AssertionError: "bootstrap|PING|shutdown" does not match "native cleanup proof refused: native cleanup: startup native frame length"
```

The other four passed. The test expects a native Fly agent log that names another PID to be refused at the identity
boundary (`bootstrap binding`, `PING identity` or `shutdown chain`). It was refused one step earlier, at frame length.

## Diagnosis

The fixture writes a Fly agent log whose PING line is a length-prefixed frame: `#1 -> (N) "<2-byte little-endian length><payload>"`,
where the payload is `ok {"PID": <pid>, ...}`. `logged_startup_agent` in `scripts/deploy_test_native_cleanup.py` checks
`len(raw) == N` and `int.from_bytes(raw[:2]) == len(raw) - 2` before it compares identities. The mutation
`prior.replace(str(pid), str(os.getpid()))` rewrote the PID inside the payload but not N or the 2-byte prefix. When the fixture agent's PID
and the test process PID have the same digit count the frame stays valid, and the test reaches the identity refusal it asserts. When they
differ, the frame-length refusal fires first. PIDs drift across the 5/6/7-digit boundaries as a long host session runs, so the outcome
depended on the PID numbering at the time. The final `PID present` mutation had the same defect.

Repro: with `os.getpid` patched to the real PID with a digit appended, the unchanged test fails with the identical assertion message.
The validator is correct: a frame whose length does not match must be refused. The defect is the fixture's mutation.

## Solution

The test builds both native logs with `native_logs(logged_pid)`, which re-encodes the PING frame length and prefix for whichever PID it
writes. The two foreign-PID mutations call it with `os.getpid()` instead of doing a text replace. Assertions and expected reasons are
unchanged. Verified: the real PID passes; a live PID with one more digit (the max live PID, 7 digits vs 6) now passes where it failed before;
and `deploy-test-cycle` passed five consecutive full runs afterwards. Not agent-scaled (test fixture only).

## Human feedback

None recorded.

## Reusable lesson

Rebuild a length-prefixed or checksummed fixture record from its fields for every mutation, never by text-replacing a value inside it, because a replacement of a different length breaks the frame before the check under test runs.
