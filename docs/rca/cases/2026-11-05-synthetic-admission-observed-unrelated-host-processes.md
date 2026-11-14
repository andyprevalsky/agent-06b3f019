---
id: 2026-11-05-synthetic-admission-observed-unrelated-host-processes
date: 2026-11-05
title: Synthetic legacy admission fixture scanned unrelated host processes twice
surface: harness
component: deploy-test-cycle-legacy-startup-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: LegacyStartupIsolation.setUp captured global OS observations for synthetic dead controllers
symptoms:
  - legacy current execution unproven
  - os_record unreadable PermissionError followed by current unreadable empty
  - test_isolation_retains_debt_and_creates_new_token_binding error
tags:
  - fixture
  - process-observation
  - fail-closed
  - deploy-cycle
sources:
  - commit 21a6f8f0ee
  - commit 3d4c6c5088b10c1da23622ed91ed22ee45482f8c
repro: python3 scripts/tests/deploy-test-cycle.test.py LegacyStartupFixtureIsolation
status: open
---

## Problem

Round 16 deploy-command-structural on frozen 3d4c6c508 failed one of 211 cycle controls, with 210 passing in 54.736 seconds. At the original reconciliation the fixture's saved global observation contained PID 2333570 with PermissionError; the immediate validator rescan had no unreadable processes. The fail-closed validator correctly refused execution exclusion. The exact native log remains under the structural worker .context/deploy-worker/faa752f17a6e91f8df9f42c3edc2524e00bfd36948e4084d6c4db033d0f34f48/144064eb01cf8837a141291439ac9cc208cc6763a9f025bf72c7056614840f20.log. Canonical attempt 16 result and its hash are preserved in the isolated report. The identity, purpose and fate of PID 2333570 are unknown; a clear subsequent scan does not establish them.

## Diagnosis

Gate: INTRODUCED. The fixture and observer were introduced by 21a6f8f0ee, compared with its parent, and remain on frozen 3d4c6c508. This is not a runtime fail-open defect or a consequence of the earlier patch-extraction fixes. The critical path is synthetic receipt construction, global same-user process scan, saved evidence, second global scan, strict comparison, reconciliation failure. The synthetic fixture coupled its success to unrelated concurrent host activity instead of owning its observation boundary.

The isolated checkout starts at exact 3d4c6c508. A controlled observer produces the native unreadable-then-clear sequence and runs the ORIGINAL test unchanged. The pre-fix command python3 .context/legacy-observer-fixture/repro.py fails at the same legacy current execution unproven boundary; the identical command passes after fixture isolation. The permanent LegacyStartupFixtureIsolation regression was separately run red before the repair. The PID number in this synthetic replay is a label copied from the error, not an assertion about a historical process.

Archive searches used legacy-current-execution-unproven/PermissionError and synthetic-fixture/global-process-observer/race vocabulary. The September 11 observer-command cleanup case is a relative: process observation can see unrelated test machinery, but it does not establish this capture/rescan failure. Prior extraction fixture cases concern a different boundary. Simplification replaces only the synthetic admission fixture's ambient OS dependency; runtime observation and ownership policy remain unchanged.

## Solution

Give LegacyStartupIsolation a deterministic observation function scoped to each test's synthetic controller IDs, paths and recorded boot identity. Restore the real observer explicitly for the original known-native-owner and deleted-cwd controls. All existing assertions, negative controls and deadlines remain unchanged. Add a permanent original-test replay under controlled unrelated-host observation churn, plus a real-observer test using temporary proc-shaped files: live unreadability must remain reported, while positive absence after the controlled read error may be ignored. No retry, filtering of unreadable live processes or validator weakening is introduced.

The focused original and new observation controls pass; the complete owning suite and exact results are recorded in isolated .context/legacy-observer-fixture/report.json. The suite is already registered as deploy-test-cycle in the structural registry. No duplicate structural gate, provider call, DB action or financial action was run. Golden reference: not applicable (no approval-gated hunk). This fixture-only change has no per-agent runtime cost. Status remains open pending parent integration and required full gates.

## Human feedback

The user required an isolated checkout at the exact frozen source, no canonical/worker edits, no writes through shared history inodes, preservation of fail-closed ownership checks and original assertions/timeouts, deterministic red/green proof and full owning-suite coverage. They explicitly prohibited inferring the vanished PID's identity and starting another child or full structural run.

## Reusable lesson

Keep synthetic admission fixtures independent of ambient host processes while testing the real fail-closed observer against controlled process evidence separately.
