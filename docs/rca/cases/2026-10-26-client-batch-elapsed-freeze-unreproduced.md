---
id: 2026-10-26-client-batch-elapsed-freeze-unreproduced
date: 2026-10-26
title: Rose Desktop running tool-batch elapsed reportedly froze at 36.7s; the captured message flow does not reproduce it
surface: front-end
component: trajectory-work-group
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: unproven — front-end/src/features/terminal-component-group/components/useBatchElapsed.ts (client interval) is the only producer of the number; the captured message flow keeps it ticking
symptoms:
  - tool batch time estimates r stuck
  - Exploring ⟳ 36.7s stops updating
  - trajectory-batch-elapsed frozen while running
  - running trajectory work group elapsed not advancing
tags:
  - rose-desktop
  - trajectory-work-group
  - elapsed-timer
  - explore
sources:
  - agent 447576b9-f5e5-4f81-b883-865e5dad5fa9 (prod, 2026-10-26 15:55–16:08Z)
  - commit 8cc1d49f9 (introduced useBatchElapsed and the static ring)
  - commit 5e25aaa3a (ring spins; second-explore ordering regression)
repro: front-end/src/tests/blackbox/trajectory-work-batch.blackbox.tsx (ring animate-spin fails pre-fix; the clock-freeze itself has no repro)
status: open
---

## Problem

Andy reviewed the deployed Rose Desktop UI and reported "tool batch time
estimates r stuck", with a running work row reading `☁ Exploring … ⟳ 36.7s`.
The number is NOT a JEV estimate (JEV is undeployed and sidebar-only); it is
the client batch clock `useBatchElapsed(group.startedAt, running)`, a 100 ms
`setInterval` showing `now - startedAt` while the group is `running`. The
deployed bundle (`/assets/index-JGyy19mr.js`, fetched 2026-10-26) contains the
same code as origin/main.

## Diagnosis

Read-only prod rows for agent 447576b9 (explores bb6ae76b/f13b318f started
15:56:23.323Z): the batch lead is the first `Exploring` row, so 36.6–36.7s is
exactly when the first explore's FINAL_ANSWER `agent_notification` USER row
arrived (15:56:59.939Z), immediately after its FINISHED row (15:56:58.976Z).

Replaying all 69 captured rows (15:56:19–15:57:20Z) in arrival order through
the real `MessageList` pipeline (Rose Desktop provider, agent ACTIVE, fake
timers advanced to each row's timestamp; with and without a live explore
stream bubble and the thinking indicator) keeps one running group
`initial:bb6ae76b`, and the elapsed advances through 35.7s → 36.6s → 44.6s →
1m 05s. No React duplicate-key warning appears. The notification row is
filtered by `useFilteredMessages` and closes nothing.

The interval can only stop while the row still shows the running layout if the
component is not re-rendering (timers throttled/frozen by a hidden or occluded
window, a saturated main thread, or an orphaned DOM node). None of these was
captured, so the first-bad boundary is unproven. The static `LoaderCircle`
(no spin) beside the clock is the only non-moving element by design.

## Solution

Follow-up (same day): `git log -S tool-batch-progress-ring` shows the ring was
added in 8cc1d49f9 as a plain activity loader; no client-side batch estimate
exists (JEV estimates are per-agent, sidebar-only and undeployed), so it cannot
be driven by an ETA without new backend data. It was the only one of 74
`LoaderCircle`/`Loader2` uses without `animate-spin`, so the live row's only
progress glyph never moved next to the ticking clock. Commit 5e25aaa3a spins
it; the batch blackbox fails on the pre-fix class. A second hypothesis (the
first explore's FINISHED + FINAL_ANSWER while a second explore keeps running)
was cemented as a regression and passes on base: the clock goes 36.7s → 41.7s
and the batch stays running, so that ordering does not freeze it.

None shipped for a frozen clock itself. Missing capture: the client never records whether
the open transcript's batch clock is ticking (visibility state, last tick time,
mount/unmount of the row). The next occurrence needs a screen recording or a
browser performance trace of the open agent view, plus the agent id and wall
time, to replay against the same rows.

## Human feedback

None recorded.

## Reusable lesson

Replay the exact captured rows through the real MessageList with fake timers
before blaming the batch clock; if it still ticks, capture browser visibility
and main-thread state instead of changing the timer.
