---
id: 2026-10-30-terminal-speed-merge-fixture-preference-contract
date: 2026-10-30
title: Merged terminal speed test assumed an obsolete default and reversed the preference setter arguments
surface: front-end
component: terminal-fast-mode.blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: front-end/src/tests/blackbox/terminal-fast-mode.blackbox.ts newly merged query-box test assumed an unset preference was ultrafast and called setUltraPreferred(userId, false)
symptoms:
  - "expected speed ultrafast but received fast"
  - "sends the query-box speed (standard, fast or ultrafast) so agents start at that native speed"
tags:
  - speed
  - merge
  - fixture
sources:
  - PR #1634 merge of main c37a33c463 into 60fd7539f
repro: front-end/src/tests/blackbox/terminal-fast-mode.blackbox.ts
status: open
---

## Problem

The combined-source query-box speed test failed at its first request: expected
`ultrafast`, received `fast`. Eight other tests in the same owning file passed.
Original evidence is retained under
`/project/rose-speed-comparison-20261028/merge-efd-preview/root-terminal-speed-tests.log`.
This was exposed by the merge-resolution candidate, not a production incident.

## Diagnosis

The path is test preference setup -> `useUltraPreferred` ->
`speedLevelOf` -> create-agent `speed` request -> captured assertion.
The existing `agentSpeed.ts` contract says an unset preference is Fast and
requires an explicit Ultrafast selection. The added test imported from main
assumed an older default. The merge candidate also adapted its setter with
arguments in reverse order: the real signature is
`setUltraPreferred(value: boolean, userId?: string | null)`.
Both errors are in test setup; existing runtime speed selection and the
separate three-speed test were correct.

Two archive searches used `speed ultrafast preference fixture` and
`setUltraPreferred parameter test`. The closest relative was
`2026-10-28-codex-fast-mode-routed-through-demo-cache-proxy`; that runtime
routing defect is distinct from this merged fixture's setup error.

## Solution

The added test explicitly selects Ultrafast before mounting the hook, then
selects Fast using the typed setter's correct argument order. The standard,
fast and ultrafast request assertions remain. No production defaults, bounds,
or assertions were relaxed. The same command from `front-end`:

`npx vitest run src/tests/blackbox/terminal-fast-mode.blackbox.ts --maxWorkers=1`

failed before (1 failed, 8 passed, 1.24s) and passed after (9 passed, 1.24s).
The full file remains discovered by normal frontend coverage. Combined-source
full coverage is still pending; status stays open until that gate completes.

A scoped lint check also identified an unnecessary `userId` callback dependency
introduced by the automatic merge. It was removed; no callback body changed.
Both frontend and backend TypeScript checks passed. Golden reference: not
applicable (no approval-gated hunk). At 10,000 agents, this test-only correction
adds no runtime work, requests, state or storage.

## Human feedback

None recorded for this fixture correction. Preserve the user's explicit
model/speed requirements and do not change defaults to satisfy a stale test.

## Reusable lesson

When combining preference tests, initialize the requested preference through the current typed setter instead of assuming a different branch's default.
