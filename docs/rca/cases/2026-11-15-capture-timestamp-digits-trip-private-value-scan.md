---
id: 2026-11-15-capture-timestamp-digits-trip-private-value-scan
date: 2026-11-15
title: A wall-clock capture timestamp containing the CVV fixture digits failed the browser private-value scan test
surface: agents
component: browser-dom-service-tests
classification: test-bug
problem_class: other
first_bad_boundary: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_browser_observation_and_action_history_keep_private_values_out_after_resume scanned str(observed), including the unpinned screenshot_context.captured_at = time.time() float, for the CVV fixture "739"
symptoms:
  - "browser_observation_and_action_history_keep_private_values_out_after_resume: AssertionError"
  - "assert all(secret not in str(observed) for secret in all_values)"
  - "FAIL        agents-blackbox:spawn-browser-agent-v3 2/5"
tags:
  - flaky-test
  - wall-clock
  - private-values
  - new-test-stability
sources:
  - PR #2065
  - commit 8e8c2fee07
  - commit 2209d9df6a
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_observation_and_action_history_keep_private_values_out_after_resume
status: fixed
---

## Problem

PR #2065's deploy new-test-stability gate (head 0d3c0c8325, 2026-11-15) reran the whole `agents-blackbox:spawn-browser-agent-v3` unit 5 times under 8× CPU load. It recorded 2/5 passes, and run 3 failed only `browser_observation_and_action_history_keep_private_values_out_after_resume` at `assert all(secret not in str(observed) for secret in all_values)`. The unit was selected because PR #2065 changed module-level fixtures in the same file. The failing test and its code under test (`agents/browser_tools/dom_service.py`, byte-identical to origin/main) are not touched by that PR.

## Diagnosis

`DOMService.get_browser_state` returns `screenshot_context.captured_at = time.time()`, which is harness metadata rather than page text. The test's private fixtures include the CVV `739`, and the assertion scans the whole `str(observed)`. Whenever the wall-clock float contains `739`, the test fails, at roughly 1–2% per run. Under the stability gate's five whole-unit runs that becomes a gate-level flake. No private value leaked: the only match is the timestamp's digits.

Deterministic repro with `dom_service.time.time` patched, via the exported origin/main 6239b9c421 tree and `/var/tmp/repair-0abef87d/fix2/clock_repro.py`:
- `1794702131.7391`: FAIL (AssertionError)
- `1794702131.1234`: PASS
- Unpatched on main: 0/60 failures.

Both inputs predate the branch: `screenshot_context` came from 8e8c2fee07 and the test from 2209d9df6a. The failure was not introduced by PR #2065. It stays blocking, because an UNVERIFIED stability result cannot be parked for post-merge repair.

Archive searches: `keep_private_values_out_after_resume AssertionError`, `timestamp digits secret scan flaky`. No prior case; novel.

## Solution

The test now pins `dom_service.time.time` to `1_700_000_000.0` (no secret digits) while it observes, and the privacy assertion is unchanged. The identical clock repro now passes at `1794702131.7391`, and 30/30 consecutive unpatched runs pass. No product code changed. This is test-only, so 10k-agent behaviour is unaffected.

## Human feedback

None recorded.

## Reusable lesson

Pin wall-clock values in tests that scan a whole serialized payload for short numeric secrets.
