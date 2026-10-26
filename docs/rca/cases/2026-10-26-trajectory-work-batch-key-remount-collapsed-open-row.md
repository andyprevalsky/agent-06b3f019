---
id: 2026-10-26-trajectory-work-batch-key-remount-collapsed-open-row
date: 2026-10-26
title: Running work batch could not be expanded, and its identity-derived React key would remount (collapse) an opened row
surface: front-end
component: trajectory-work-group
classification: our-bug
problem_class: uncaptured-user-preference
first_bad_boundary: front-end/src/features/terminal-component-group/components/TrajectoryWorkGroup.tsx (running button disabled, history gated on !running) and trajectoryWorkGroups.ts groupKey (key from the first activity's identity)
symptoms:
  - while working i can't expand to see the work it has done
  - trajectory work group button disabled while running
  - trajectory-work-history missing while running
  - opened work row collapses when the thought finishes
tags:
  - rose-desktop
  - trajectory-work-group
  - react-key
sources:
  - commit 15858fd5d
  - commit 47721c2f1
  - commit 86ab0dccd
  - commit c76d45300 (boundary-anchored key, review finding)
  - commit 2594374ad (leaf clock, review finding)
repro: front-end/src/tests/blackbox/trajectory-work-compression.blackbox.tsx
status: fixed
---

## Problem

Andy (UI review, 2026-10-26): while the agent works, the batch row cannot be
expanded to see the work done so far. The running header was a `disabled`
button and the ordered history mounted only after the batch compressed.

## Diagnosis

`TrajectoryWorkGroup` set `disabled={running}`, `aria-expanded={!running &&
expanded}`, rendered history only when `!running && expanded`, and reset
`expanded` whenever `running` became true. That was the earlier deliberate
contract ("history is unavailable until compressed"), now superseded by Andy.

Making the row expandable exposed a second defect: the React key was
`${turn}:${toolCallId ?? first activity id}`. A live `streaming:thinking`
placeholder that leads a batch is replaced by its persisted thought (new id)
or, when the model streamed no text, by its tool-call row. The key changed,
the row remounted, and a user-opened batch collapsed. Both cases fail on the
pre-fix key in the regression test. An interim per-turn ordinal key fixed that
but, as adversarial review showed, moved an open state onto a different batch
when an earlier batch in the turn split (late boundary), merged or vanished;
two regressions reproduce that on the ordinal key. Review also measured the
open running batch re-rendering every history row on each 100 ms clock tick.

## Solution

The row is always a toggle; expanded history lists completed and in-progress
activities, appends while open, and the same instance keeps the expand state
and history node through completion. Each batch is keyed by
`${turn}:${message_id of the boundary row before it}` ('start' after a USER
row), so placeholder replacement and changes to other batches leave it alone.
The clock is a leaf (`BatchElapsed`), so an open batch's history rows do not
re-render on each tick (render-count assertion). Cost per open
transcript is unchanged: one 100 ms clock for the single running batch, and
history renders only for an expanded row; nothing scales with agent count.

## Human feedback

Andy asked for the running batch to be expandable (supersedes the earlier
"history only after compression" contract).

## Reusable lesson

Key a live, collapsible row by the stable boundary that precedes it, never by
its own first (possibly ephemeral) item or by its ordinal among siblings.
