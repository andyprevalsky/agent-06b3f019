---
id: 2026-11-11-gpu-fixture-timer-preceded-measurement
date: 2026-11-11
title: The blocking GPU fixture used page-load time instead of the measured window
surface: harness
component: back-end/src/tests/fixtures/user-ui/blocking/root/slots/blocking/index.html
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The fixture armed its one GPU readback at 2200ms after load although host settlement and tracing startup determine when sampling actually begins
symptoms:
  - "blocking readback fails long-task"
  - "only phase=load tasks were captured"
tags:
  - fixture-race
  - measurement
  - gpu
sources:
  - PR #1915
  - commit 46493c841a6c96d1298605ad2038af4101881298
  - plan: GitHub run42970181793 and immutable units-probe.log
  - plan: .context/rca-playwright/merged-46493/fps-repair/manifest.json
repro: Existing rose-ui-cli-browser.test.ts blocking GPU subtest with a controlled five-second tracing-start delay, plus its registered delayed-measurement fixture regression
status: mitigated
---

## Problem

The normal full backend gate recorded 257 passing cases and one FPS failure.
The browser CLI file passed five of six subtests. Its blocking GPU control failed
the unchanged long-task assertion with only load-phase tasks of 85, 1416, 412
and 212 milliseconds. Native exit one, complete evidence and positive cleanup
remain on record; GitHub transport success does not replace this failure.

## Diagnosis

The fixture scheduled one asynchronous draw/readPixels operation 2200ms after
page load. The CLI instead waits for the preview host to settle, waits its
existing settle interval and starts Chromium tracing before beginning the
sampling window. Page-load time therefore does not identify measurement time.

The original CI capture does not contain readback-start/probe-start timing or
the browser/GPU identity. The historical occurrence and SDK source attribution
remain UNKNOWN. An earlier complete 0cb gate passed this same FPS case, and
fourteen relevant source paths match; those facts alone do not establish cause.

A controlled legal five-second tracing-start delay executes the mechanism:
the unchanged original subtest fails on the old fixture with load-only
57/1082ms tasks. With the correction, that same assertion passes and the CLI
correctly exits one for only the intended long-task violation: steady 1032.3ms,
CPU 0.4ms and page wait 1029.2ms, with no warnings. These local controls use
recorded Playwright 1.64/HeadlessChrome 156; they are not the missing original
native timeline and do not produce a NOT_INTRODUCED waiver.

## Solution

The test fixture observes the CLI's existing in-frame probe.sampling flag
before performing its original one-off operation. A short timer observation
loop ends when actual sampling starts. The original async continuation,
shader, draw geometry and readPixels input remain byte-identical. No product
CLI, public API, thresholds, assertions, test deadlines or concurrency changed.

## Validation

The registered regression in the existing browser-test file executes the actual
fixture script with a controllable browser event queue. Measurement can begin
arbitrarily later than the former timer: no readback occurs beforehand, one
occurs after sampling begins, and later windows never duplicate it. Identical
test bytes fail before the fixture correction and pass after it, including
the parent's permanent tests-first execution.

All six prior whole test bodies and the original async GPU body retain their
hashes. The controlled real-browser before/after proof preserves the unchanged
original assertion. Root owns this additional blocking repair inline; the
native UNKNOWN record is not waived or delegated. Normal full FPS/backend and
all selected source-bound gates must validate the final commit.

## Outcome

Local contract and controlled-browser checks pass. Final native validation is
pending; this case does not claim production acceptance or resolve the assigned
SDK rollout.

## Human feedback

No new human diagnosis or approval was used for this fixture correction. The
standing deployment instruction requires the original failure to remain visible
and the assigned SDK repair to reach verified production acceptance.

## Reusable lesson

Bind measurement fixtures to the actual sampling boundary, and validate new RCA
records against the archive schema before freezing source.
