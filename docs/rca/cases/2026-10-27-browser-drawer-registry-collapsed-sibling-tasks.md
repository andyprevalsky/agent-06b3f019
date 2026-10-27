---
id: 2026-10-27-browser-drawer-registry-collapsed-sibling-tasks
date: 2026-10-27
title: Browser drawer collapsed distinct browser tasks into one owner-agent tab
surface: front-end
component: rose-apps-browser-tabs
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: roseAppsContext.useAgentTabs rejected a registration when the same agent already owned a different browser task
symptoms:
  - multiple browser tasks show only one tab in the browser view
  - browser tabs have no smaller task name with an agent icon
  - Unable to find an accessible element with the role "tab" and name /Buy black cowboy hat/
tags:
  - browser
  - task-identity
  - frontend
  - tabs
sources:
  - agent 43082b47-f284-410a-a258-6fcd47651cce
  - plan:docs/plans/completed/rose-user-ui.md
repro: front-end/src/tests/blackbox/browser-multiple-tasks.blackbox.tsx
status: fixed
---

## Problem

The user requested multiple browser sessions in the frontend chip and browser
view, with each tab showing a smaller task name preceded by an agent icon.
The production transcript acknowledged two browser launches under one owner:
6411642c7 (`buy_black_cowboy_hat`) and call_ae34f0a2c8964f0aa71b17ee
(`buy_bandana_gun`). The browser initialization event joins its task ID to the
original spawn call; the hidden launch row supplies its backgroundPath.

The production snapshot contained only one initialized session. Independent
worker/Temporal evidence showed owner-level execution serialization, followed
by a 502 while posting the second launch's startup message. This incident does
not prove two simultaneous sessions existed in production. The user explicitly
limited the fix to frontend display and labels; execution behavior is unchanged.
The local UI reproduction supplies two valid task sessions with that captured
owner/call/path relationship to exercise the frontend contract independently.

## Diagnosis

Path: browser event transcript -> computeActiveBrowserPanels -> mounted status
bars -> browser tab registry -> selected tab -> drawer pane and composer.
The panel derivation already retains distinct logical launches and supersedes
retry task IDs for the same call. At the next boundary, useAgentTabs keyed
registrations by agentId and expressly discarded a second taskId for that
agent. focusTask replaced the first task and lost its metadata. Agent-only
selection also could not identify which sibling should portal into the drawer.
The completed UI plan specified one tab per agent; the new requirement
supersedes that restriction. No test covered two distinct tasks under one owner.

The permanent test was run unchanged against original production files and
then the fixed files:
`cd front-end && npx vitest run src/tests/blackbox/browser-multiple-tasks.blackbox.tsx -t 'keeps sibling browser tasks'`.
Before: exit 1, missing `Buy black cowboy hat` tab, 6.94 seconds.
After: exit 0, both task tabs, correct selected URL, one pane, task-specific
composer slot, metadata refresh retention, sibling removal, 6.89 seconds.
Private receipts are in `.context/multi-browser-43082b47/repro-before-final.log`
and `repro-after-final.log`. An earlier draft's trajectory-text assertion
incorrectly assumed the independent progress endpoint used inline messages;
it was replaced with the actual composer task identity and this complete
before/after pair was re-established.

Archive searches: `BrowserStatusBarCarousel browser tabs multiple`,
`multi browser task name agent chip`, `"multiple browser"`, and `"browser tabs"`.
This is a relative of 2026-07-22-browser-chips-keyed-by-task-render-twice-on-retry,
not a recurrence: its logical-call retry supersession remains unchanged.

Golden references inspected: claude-code-src/src/components/tasks/BackgroundTasksDialog.tsx:492
maps stable task.id independently of its label; codex/codex-rs/tui/src/app/agent_picker.rs:131
retains the selected thread ID across refreshed descendants. Independent review
also inspected OpenClaw session rows and Hermes session export; kimi-code is
absent locally. The repair follows stable identity with separate display labels.

Independent adversarial review returned PASS after resolving deep-link reset,
generated initialization-call ordering, and test-fixture contract findings.
It explicitly limits the verdict to frontend behavior and does not claim
concurrent runtime sessions or deployment completion.

## Solution

Register every (agentId, taskId) pair and store that full selection atomically.
Derive a surviving sibling on removal, preserving explicit selections across
owner changes and avoiding cleanup effects that race initial registration.
Focus existing tasks without replacing metadata. Fence drawer portals and
composer targets to the selected task. Consume browser deep links once so later
message updates cannot override a user's selection.

Replace overlapping carousel cards with named, horizontally scrolling task
selectors and a browser count. Drawer tabs show the current site plus a smaller
agent-icon/task-name subtitle. Resolve names from the initialization event's
original call and existing background path, independent of step delivery order.
Reserve thumbnail space so it cannot obscure selectors. Visual QA covers light,
dark and narrow layouts with long task names; mock sessions verify presentation,
not provider connectivity.

Permanent blackbox tests cover sibling selection/removal, one pane, URL and
composer identity, refresh retention, deep links and reordered task messages.
Existing carousel/control tests use the named selectors while retaining their
control assertions. Vitest's existing blackbox glob discovers these tests and
/deploy Step 4b runs that same suite under coverage.

At 10k agents this adds no queries, subscriptions, polling or broadcasts.
Registry work is limited to browser tasks already mounted/visited in this
client. Label derivation reads only the selected owner's in-memory transcript;
retry supersession and runtime session scheduling are unchanged.

## Human feedback

The user clarified: "Frontend display and labels only" when offered the choice
of also restoring simultaneous execution. Keep the current execution contract.
The requested visual details are a smaller task name below each tab with an
agent icon to its left, and correct visuals in both the chip and browser view.

## Reusable lesson

Keep browser ownership separate from task selection and preserve the full task identity through registration, rendering and composer placement.
