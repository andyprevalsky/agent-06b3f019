---
id: 2026-11-02-pwa-fixture-timestamps-expire-against-sidebar-clock
date: 2026-11-02
title: Completed mobile PWA fixtures aged out before menu input could be dispatched
surface: front-end
component: mobile-pwa-chrome-fixtures
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: mobile-pwa-chrome.blackbox.tsx makeAgent supplied fixed October 27 timestamps to a sidebar using Date.now
symptoms:
  - Unable to find an element by [data-testid="rose-agent-row-row-1"]
  - four mobile-pwa-chrome cases fail before contextmenu or pointerDown dispatch
tags:
  - fixture
  - clock
  - pwa
  - sidebar
sources:
  - PR #1580
  - commit a3c4929f3bbd296766013a7545439b682015a6ef
  - commit 6ff4bcae6d0da979e8c6feb24c011f2698935108
  - agent https://boxes.dev/thread/thr_4ce037f2ea2b416098acacadf1979428
repro: front-end/src/tests/blackbox/mobile-pwa-chrome.blackbox.tsx
status: fixed
---

## Problem

The originating PR1580 frontend coverage run failed four of the sixteen mobile
PWA tests. All four failed looking up `rose-agent-row-row-1`, before dispatching
the menu input. The original attribution report (2026-11-02, 18:28:55 UTC start,
bounded before 18:38:55) is retained in this repair's ignored evidence directory
as `.context/mobile-pwa-fixture-repair/origin-REPORT.txt`.

Gate: **NOT_INTRODUCED**, against main `a3c4929f3` and frozen release `6ff4bcae6`.
The origin ran the same four assertions on both sources: 4 failures each,
30.35s main and 29.59s frozen. Holding ONLY Date.now at
2026-10-27T12:00:00Z made them pass (8.42s and 8.39s). Its held-clock control
ran all 16 mobile + 3 opening-release + 6 pointer-release tests: 25/25 passed
in 12.52s. These are diagnostic Vitest/jsdom results, not a production fix,
live iPhone evidence, or a successful full-coverage rerun.

This independent repair reproduced the current-clock main failure:
`cd front-end && npm exec vitest run src/tests/blackbox/mobile-pwa-chrome.blackbox.tsx`
returned 1, 4 failed / 12 passed, 27.19s. The identical command after the fixture
repair returned 0, all 18 passed including two added regressions, 9.04s.

## Diagnosis

Path: `makeAgent` fixture -> TerminalHeader/MobileAgentDrawer ->
RoseMobileAgentList -> RoseAgentGroups -> splitOldAgents/isOldAgent -> row DOM
lookup -> input dispatch. The first bad data is the fixture's fixed
`created_at` and `updated_at`, both 2026-10-27T00:00:00Z, while its status is
COMPLETED. `useNow` supplies real Date.now to the unchanged old-agent policy.
That policy intentionally hides finished rows when updated_at is more than
four days old. The row becomes old strictly after 2026-10-31T00:00:00Z.

Why the four tests fail: the row belongs behind "View 1 old agent", so the
lookup times out before any context-menu handler can execute. Why this was
possible: fixture freshness was tied to a calendar date while the consumer's
clock advanced. The deepest owned defect is that inconsistent fixture/clock
relationship. Changing the intentional four-day policy would cross into a
documented product decision and is the wrong repair layer.

Archive searches: `rose-agent-row-row-1 mobile-pwa-chrome` (no hit),
`fixture completed age four days clock` (broad, unrelated clock cases), and
`mobile PWA`. Read the original PWA geometry/layering case
`2026-10-27-pwa-overlay-geometry-and-layering-not-validated-in-standalone-viewport`.
This is a related test surface, not recurrence of its runtime geometry cause.
UI Main's actual latest handoffs report no outstanding UI deliverables; the
origin's read-only attribution lane proposed no runtime patch. No competing
repair claim was found in those handoffs.

## Solution

The local fixture derives both default timestamps once per makeAgent call from
Date.now, the same clock the sidebar consumes. Explicit timestamp overrides
still work. This removes the stale calendar constant instead of changing
runtime filtering, freezing all tests to October 27, or skipping assertions.
It repairs every caller of this fixture, including the four menu tests.

Two permanent tests render the real drawer at 2040-01-01 and 2099-07-01 with
ONLY Date.now mocked and real timers. The default completed fixture and the
exactly-four-days-old row must be visible; the four-days-plus-one-millisecond
row must stay hidden until "View 1 old agent" is clicked. Sign-in uses the same
test clock so auth expiry cannot substitute for the targeted row failure.

The identical command before and after the fixture repair:
`cd front-end && node ../node_modules/vitest/vitest.mjs run src/tests/blackbox/mobile-pwa-chrome.blackbox.tsx -t 'keeps fresh fixtures visible'`.
Before: exit 1, both regressions fail at the fresh-row lookup, 15.16s.
After: exit 0, both pass, 5.41s. The other 16 tests were unselected by the
command; none was disabled. An earlier diagnostic used npm exec without `--`,
so npm consumed `-t` and ran all 18, and its first future-clock fixture did not
refresh sign-in. That invalid diagnostic is retained as `before-future.log`;
it is not the causal proof. The corrected regression above was executed red
before changing the timestamp producer.

Vitest's existing include pattern discovers this blackbox; `/deploy` Step 4b
runs it via `npm run test:coverage`. The existing five old-agent blackboxes
own the broader selected/pinned/running/paused exceptions. Verification and
cleanup receipts are retained under `.context/mobile-pwa-fixture-repair/`.
With only the frozen release's context-menu implementation and its exact six
pointer-release tests overlaid on main, the identical four-file command ran
all 18 mobile + 3 opening-release + 6 pointer-release + 5 old-agent cases.
Before the fixture fix: exit 1, 6 failed / 26 passed, 37.01s (the original four
plus the two new future-date regressions). After: exit 0, 32/32 passed, 8.36s.
This is a documented source overlay, not a claim to rerun the complete release
tree. The helper restored main's runtime file and removed the temporary
release test in a finally block, preserving logs, source hashes and full diffs.
The two new regressions passed five consecutive runs with identical test bytes
(10/10 case executions). All 16 original test bodies were also compared by
TypeScript AST extraction and remained byte-for-byte identical.

Historical verification on base `a3c4929f3` plus the repair: `cd front-end && npm run test:coverage`
returned 0, including TypeScript checking and all configured coverage thresholds,
with 4,043 tests passing across 249 files,
from 2026-11-02T18:44:56.298972Z to 18:49:00.516250Z (244.21s process wall time).
Coverage: statements 85.33%, branches 79.37%, functions 86.11%, lines 87.68%.
Targeted ESLint and Prettier passed. The archive validated with 1,315 cases.
The bounded independent adversarial review passed without blocking findings;
its original receipt correctly said full coverage was pending at review time.
This later verification adds that result without rewriting the review receipt.

This case's fixed status describes the local fixture repair, not a deployment.
PR1580's original failures and held-clock diagnostics retain their native
outcomes. No new deploy, merge, cutover or live-iPhone verification was performed.
Golden reference: not applicable (no approval-gated hunk).
10k-agent behavior: production code is byte-for-byte unchanged; no requests,
subscriptions, per-agent timers or runtime cost are added.

## Human feedback

The user requested an independent NOT_INTRODUCED repair on its own devbox and
branch, preserving original outcomes/clocks/bounds and all mobile/release
requirements. PR1580 proceeds independently and does not wait for this work. The corrected
replacement contract requires preserving PR1664, integrating main containing
PR1580 and PR1674, passing the original four-worker coverage invocation, and
completing this repair's own deploy through production verification and cleanup.
The earlier draft-only endpoint is superseded.
Do not change the originating devbox, start a competing release/cutover, enable
Rose account-agent flags, alter Freedom, hide failures with skips, or change
the real four-day old-agent behavior. The origin report corrected an initial
24-hour/created_at suggestion to the evidenced four-day/updated_at rule.

## Reusable lesson

Derive freshness-sensitive fixture timestamps from the consumer's test clock and verify both fresh visibility and the unchanged expiry boundary at multiple dates.
