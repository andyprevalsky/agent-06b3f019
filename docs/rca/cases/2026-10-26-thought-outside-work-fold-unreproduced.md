---
id: 2026-10-26-thought-outside-work-fold-unreproduced
date: 2026-10-26
title: Thoughts reportedly render standalone in the old style instead of inside the Working fold; no captured root-transcript state reproduces it
surface: front-end
component: trajectory-work-group
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: unproven — groupTrajectoryWork (trajectoryWorkGroups.ts) folds every thought shape found in the captured rows; the reported view/state was not captured
symptoms:
  - sometimes thoughts displays like before, instead of within the Working fold
  - Thought card outside Worked for group
  - thinking row standalone in Rose Desktop transcript
tags:
  - rose-desktop
  - trajectory-work-group
  - thought
sources:
  - prod rows, user 1f85ff25, 9 root agents created 2026-10-23..26 (incl. 447576b9, d324c2f0, e0799843, 0932e0ec, be86886f)
repro: none — every captured prefix folds every thought (see Diagnosis)
status: open
---

## Problem

Andy (2026-10-26): "sometimes thoughts displays like before, instead of within
the Working fold". No screenshot, agent id or pane was attached.

## Diagnosis

Read-only prod rows for Andy's 9 root agents from the last 3 days (1,359
messages) were replayed through the real `MessageList` (Rose Desktop provider)
at EVERY prefix (live arrival) and at the final state. A thought counted as
standalone when it rendered outside `trajectory-work-group`: ASSISTANT text
(shapes seen: `streamId`, `tool_calls`, `codex_reasoning_items`), `thought`
tool rows, and spawn_agent "Explore agent thinking" rows, plus any rendered
"Thought" card. Result: 0 standalone thoughts. The only ASSISTANT rows
outside a group are the code agent's `display` chart rows, which are meant to
stay visible. Insert vs timestamp skew was > 50 ms for 0 rows, so realtime
arrival order equals refetch order.

Paths not covered by the captured rows: live streaming bubbles/tools (the root
renders only the in-group placeholders), and other views. The browser task pane
and sub-agent panes are deliberately uncompressed
(`browser-trajectory-unfolded.blackbox.tsx`), so their thoughts render as
individual Thought cards. In the code agent view, `CodeSessionMessages`
WorkSlot shows the running turn's latest activity (often a full Thought card)
under "Working"; that is inside the slot by construction.

## Solution

None shipped. Next occurrence: capture the agent id, wall time and which pane
(main transcript, browser pane, sub-agent expansion, code agent view), ideally
a screenshot, and replay those rows with the scratch harness approach above.

## Human feedback

None recorded.

## Reusable lesson

Replay every prefix of the reported run through the real MessageList before
changing the fold classifier; if nothing escapes, ask which pane showed it.
