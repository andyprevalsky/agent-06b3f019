---
id: 2026-11-03-browser-drawer-history-controls-unwired
date: 2026-11-03
title: Browser drawer history controls were rendered without navigation handlers
surface: cross
component: browser-drawer-navigation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: BrowserAppDrawer BrowserChrome rendered Back and Forward without onClick
symptoms:
  - the back button doesn't work on the browser ui
  - Back is disabled despite an active browser session
tags:
  - browser
  - history
  - navigation
  - tilion
sources:
  - agent c05212f7-0e00-4539-8904-2b5192c1e0c6
repro: front-end/src/tests/blackbox/browser-navigation.blackbox.tsx
status: fixed
---

## Problem

The user reported that Back did not work in the Browser drawer. BrowserChrome
rendered Back and Forward without callbacks; NavButton disables any button
without a callback. The pre-fix blackbox run failed two of three tests,
including the enabled-button assertion, in 11.52 seconds.

## Diagnosis

The first bad boundary is the drawer chrome, before any provider request.
There was no browser-history API behind those controls. A live-view iframe is
not the remote page's history, so navigating the iframe would not repair this.
Tilion also permits one driving CDP connection: opening another connection
while the worker holds the session is not a valid navigation implementation.
Archive search found related navigation cases but no prior instance of this
unwired-control defect.

## Solution

Wire Back and Forward to the selected task's remote history, after taking
control. Keep existing Reload behavior. Show failures and allow retry. Scope
late responses to their task and current page. The backend uses a session-bound
command consumed through the worker's existing CDP connection; Root and a paused authentication session with a verified worker-disconnect
receipt can drive their idle sessions directly. Requests are user initiated; no fleet-wide polling
is added. Real Chromium history, paused authentication, stale ownership, and frontend
regressions pass locally. Full deployment validation is tracked in the PR.

## Human feedback

The user explicitly requested the browser fix be deployed, followed by
restarting cancellation of both subscriptions and stopping the old agent.
Preserve saved browser data.

## Reusable lesson

Test browser chrome through its remote-session navigation boundary, including ownership and single-client providers.
