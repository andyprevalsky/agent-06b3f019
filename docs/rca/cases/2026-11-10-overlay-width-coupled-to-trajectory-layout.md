---
id: 2026-11-10-overlay-width-coupled-to-trajectory-layout
date: 2026-11-10
title: Pinning or resizing sidebar shifted the main trajectory and header
surface: front-end
component: terminal-layout
classification: our-bug
problem_class: uncaptured-user-preference
first_bad_boundary: TerminalMainContent padding and TerminalContent header left followed dynamic rose-bar-offset
symptoms:
  - drawer shifting the main trajectory
  - sidebar should have no effect on the main trajectory
  - pinned sidebar narrows chat
  - md:pl-[var(--rose-bar-offset,64px)]
tags:
  - sidebar
  - layout
  - overlay
  - trajectory
sources:
  - commit 7fb7d7d91069e4461dd9365ad40b289ce99b7265
  - commit 11828d4eac7f2faa410da8a4afb25b48e2477a8f
repro: front-end/src/tests/blackbox/rose-sidebar-resize.blackbox.tsx
status: fixed
---

## Problem

During the coding-row actions task, the user supplied a screenshot of the
expanded left sidebar and said the drawer should have no effect on the main
trajectory. Previously pinning or dragging the bar changed the content inset
from 64px to the expanded width, moving and narrowing the trajectory. The
header also centered itself relative to the changing sidebar width.

The screenshot additionally showed Loading AI Network and Loading agent details.
No execution/agent ID or request trace was supplied; this case establishes the
layout shift, not a causal explanation or fix for that loading state.

## Diagnosis

Path: sidebar drag/pin/restore state -> published --rose-bar-offset -> main
padding and header left -> primary content reflow. The first bad contract is
in the consuming layout components: a sidebar overlay's changing width should
not control the primary trajectory geometry. The same variable legitimately
positions adjacent full-screen app panels, so globally freezing it would change
unrelated behavior.

What: main content/header move with sidebar width. Where: TerminalMainContent
and TerminalContent ContentAreaHeaderFrame. Why: overlay and primary layout
shared the sidebar's dynamic width. Proof: six permanent owning blackbox tests
failed on the dynamic main/header classes when given the user's fixed-layout
contract. Existing tests explicitly encoded the former push behavior; this is
a clarified preference, not an unproven network root cause.

Executed before and after:
`cd front-end && npx vitest run src/tests/blackbox/rose-sidebar-resize.blackbox.tsx src/tests/blackbox/rose-mobile-header.blackbox.tsx`.
The before run failed 6 tests (31 passed) in 10.40s; the identical command
passed all 37 unchanged tests after the fix in 9.41s. The exact assertions check
fixed main and header inset through hover, active drag, pinning, collapse,
viewport resize and saved pinned-state restoration.

Archive searches: `sidebar pinned trajectory shifts` and
`rose-bar-offset main content`. There are related sidebar headroom and chrome
geometry cases, but no matching proven recurrence of this layout preference.

## Solution

Keep main content and header inset at the 64px rail for Rose Desktop. Sidebar
expansion, pinning and resize overlay the trajectory and cannot change its
horizontal geometry. Preserve dynamic sidebar offsets for adjacent app panel
anchors, zero sidebar inset on shared benchmark layouts, and stock/mobile
layout behavior. Tests cover those negative controls alongside the new policy.

At 10k agents this is constant CSS layout independent of agent count. It adds
no requests, polling, subscriptions or per-agent work, and removes a dependency
that caused trajectory layout to change on each sidebar drag frame.

## Human feedback

The user said: "i think its due to the drawer shifting the main traject, it
should have no effect" and supplied the expanded-sidebar screenshot. This
explicitly supersedes the previous behavior that a pinned bar pushes content.

## Reusable lesson

Keep overlay chrome geometry independent from the main trajectory layout while retaining separate anchors for adjacent panels.


## Final combined validation — November 10

Source: commit 7fb7d7d91069e4461dd9365ad40b289ce99b7265. Full frontend coverage passed 324 files,
4,732 tests passed and one skipped; line coverage 89.69%, branch coverage
81.87%. Full backend failed-first sharded coverage passed all 253 selected
blackbox domains and all 391 unit files (including the separately scheduled
browser-performance probe), with line/statement coverage 90.26%, functions
93.13% and branches 82.95%. Configured thresholds passed; backend teardown
checks also passed. The coverage runner intentionally excludes the separate
live credential-health domain. No production rollout or live account probe
is implied by these local validation results.

Commands: `cd front-end && npm run test:coverage`;
`cd back-end && bash scripts/run-coverage-sharded.sh --failed-first 2 && bash ../scripts/tests/blackbox-backend-teardown.test.sh`.
