---
id: 2026-11-07-admin-health-tooltip-test-raced-recharts-size-measurement
date: 2026-11-07
title: Admin-health tooltip test looked up charts before Recharts painted them, so it failed under coverage load
surface: frontend
component: front-end/src/tests/blackbox/admin-health.blackbox.tsx neutral-series tooltip test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "front-end/src/tests/blackbox/admin-health.blackbox.tsx — queried .recharts-wrapper synchronously after '01 Primary Metric' appeared, before each ResponsiveContainer's post-commit size measurement re-rendered the chart"
symptoms:
  - "AssertionError: expected null not to be null"
  - "admin-health.blackbox.tsx:308 expect(chart).not.toBeNull()"
tags:
  - frontend
  - vitest
  - recharts
  - load
  - coverage
sources:
  - PR #1749 staged deploy on 8d436372f, gate frontend-coverage-blackbox (1 failed | 4343 passed)
repro: taskset -c 0 npx vitest run src/tests/blackbox/admin-health.blackbox.tsx --maxWorkers=1 (with CPU 0 saturated)
status: fixed
---

## Problem

PR #1749's sweep failed `frontend-coverage-blackbox` on one test, "neutral-series
tooltips use the theme popover tokens, so rows stay readable on dark", with
`expected null not to be null` at `admin-health.blackbox.tsx:308`. The PR changes
no front-end files; the test, its fixtures and the page match main.

## Diagnosis

The test waited for `01 Primary Metric`, then immediately looked up each chart's
`.recharts-wrapper`. Recharts' `ResponsiveContainer` renders that wrapper only
after it measures its size in a post-commit re-render. Under coverage
instrumentation with one worker on a loaded host, the lookup ran first and found
nothing. The old parent-climbing lookup could also select a different chart that
had already painted.

Running the file alone passed 6 of 6 times. Pinned to a CPU saturated by three
busy loops, it failed 1 of 3 runs with the same assertion. The date is not a
factor: the test passes on 2026-11-07.

## Solution

Each chart is now found by its own `.recharts-responsive-container`, which mounts
with the metrics data. The test still asserts that container exists, then waits
for that container's `.recharts-wrapper` before hovering. All tooltip theme
assertions are unchanged. With the fix, the file passed 5 of 5 runs under the same
contention and 5 of 5 without it.

## Human feedback

None: found and fixed inside PR #1749's deploy.

## Reusable lesson

A Recharts chart inside `ResponsiveContainer` paints after a measurement
re-render, so a test should wait for the chart element itself, not for nearby
text.
