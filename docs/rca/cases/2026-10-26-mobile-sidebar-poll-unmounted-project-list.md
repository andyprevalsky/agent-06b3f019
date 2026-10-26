---
id: 2026-10-26-mobile-sidebar-poll-unmounted-project-list
date: 2026-10-26
title: Every mobile agent poll swapped the drawer's project list for a spinner, dropping inline project inputs and open project menus
surface: front-end
component: rose-mobile-agent-list
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal-component-group/components/rose-sidebar/RoseMobileAgentList.tsx — rendered the spinner for any isLoading, but useAgentList sets isLoading on every background poll
symptoms:
  - prod semantic projects-sidebar-flow.spec.ts › original project flow at 390px fails on CI
  - "locator.fill: Timeout 15000ms exceeded waiting for getByRole('textbox', { name: 'New project name' })"
  - "locator.click on rose-project-menu › Delete project: element was detached from the DOM"
  - mobile drawer briefly shows a spinner on each agent poll
tags:
  - front-end
  - mobile
  - sidebar
  - projects
  - flaky-gate
  - scale-100-seats
sources:
  - Production Semantic Frontend Gate runs 40385944860 (7c173ec12), 40399452972 (7395d9110)
  - lane S11 of the 100-seat readiness audit (follow-up #1 from S5)
repro: front-end/src/tests/blackbox/projects-sidebar-flow.blackbox.tsx
status: fixed
---

## Problem

The production semantic gate failed `projects-sidebar-flow.spec.ts › original
project flow at 390px` on three of the four CI runs that included it
(8f4d06b09 failed on other specs; b3980ab16 passed; 7c173ec12, 0d1baa382 and
7395d9110 failed). Two failure points were seen:

- After Escape cancelled one inline "+ New project" input, the second click
  opened nothing; `fill('Website')` timed out. The CI page snapshot shows the
  drawer with the "+ New project" button and no input.
- The right-click project menu's "Delete project" item detached from the DOM
  mid-click.

`front-end/src` is byte-identical between the green (b3980ab16) and red
(7c173ec12) SHAs, so this is not a commit regression. It is a timing-dependent
product bug, introduced with the mobile project list on 2026-10-21 (614800d4e).
It shows on the slower CI runner and was green on a fast local machine.

## Diagnosis

Critical path: `useAgentList` poll → `isLoadingAgents` → `MobileAgentDrawer` →
`RoseMobileAgentList` → `RoseAgentGroups` → `NewProjectRow` / `RoseProjectRow`.

- `useAgentList.loadAgents` sets `isLoadingAgents = true` for every request,
  including the `AGENT_POLL_INTERVAL_MS` background polls.
- `RoseMobileAgentList` rendered `props.isLoading || props.isSearching ?
  <spinner> : <RoseAgentGroups/>`. Each poll unmounted the whole group list and
  mounted a fresh one, resetting `NewProjectRow.isEditing` and closing any open
  Radix context menu.
- The desktop `SidebarAgentList` already showed the spinner only for
  `isLoadingAgents && agents.length === 0`. The mobile Rose list never adopted
  that rule.

Instrumented repro (focus and removal listeners on the prod build, 8× CDP CPU
throttle): `REMOVED DIV[rose-agent-groups] from DIV[rose-mobile-agent-list]`
appeared immediately after the second input gained focus, followed by the
input's `focusout`.

## Fix

`RoseMobileAgentList` shows the spinner only when there is nothing to show yet:

- for the first agent load, before any load has settled and while there are
  no agents; or
- for a search that has no rows.

Background polls keep the groups mounted. The "first load settled" guard also
covers accounts with no agents, which would otherwise still lose the input on
every poll.

## Verification

- Regression (vitest blackbox, run by `/deploy` front-end tests):
  `front-end/src/tests/blackbox/projects-sidebar-flow.blackbox.tsx`. It has two
  new cases: the list, inline input and project menu survive an
  `isLoading=true` refresh; and the input survives refreshes for a zero-agent
  account. Both fail on origin/main (spinner replaces the list) and pass with
  the fix, five consecutive runs.
- End to end: the unchanged spec at 390px, with 8× CDP CPU throttling.
  - Prod (unfixed): 8/8 failed.
  - Local production build of unfixed origin/main: 2/6 failed.
  - Local production build with the fix: 6/6 passed, then 24/24 across both
    widths.

## Scale (10k agents)

The fix removes work: a poll no longer tears down and rebuilds the mobile
project/agent subtree. It adds one boolean of state per mounted list, and no
requests, subscriptions or per-agent cost.

## Problem class

A loading flag that means "a request is in flight" was used as "there is
nothing to render". Polled data must keep showing the last good state, so an
in-flight refresh must not unmount interactive UI.
