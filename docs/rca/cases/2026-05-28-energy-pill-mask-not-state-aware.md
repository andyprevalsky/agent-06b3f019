---
id: 2026-05-28-energy-pill-mask-not-state-aware
date: 2026-05-28
title: Background energy-pill SVG mask only cleared the query input, so pills showed through the taller landing controls
surface: front-end
component: terminal-background
classification: our-bug
problem_class: other
first_bad_boundary: the background energy mask was a fixed cutout sized to the query input, with no dependence on `selectedAgentId`
symptoms:
  - grid energy pills visible through the landing screen controls
  - energy pills bleed around the Popular Goals row above the query input
  - clipping correct in agent-selected chat state but wrong on the no-agent landing screen
tags:
  - front-end
  - svg-mask
  - landing
  - z-index
  - visual-regression
sources:
  - PR #645
repro: front-end/src/tests/blackbox/terminal.blackbox.tsx
status: fixed
---

## Problem

On the landing screen (no agent selected), the animated grid "energy pills" were
visible through the terminal controls instead of being clipped behind them. In the
agent-selected chat state the clipping looked correct, which made it read like a
z-index or stacking-context bug.

## Diagnosis

Z-index and DOM order were already correct: the pills sat below terminal content.
The actual defect was the SVG mask used to punch the pills out — it cleared only
the query-input area. The landing screen renders additional controls above the
input (notably the Popular Goals row), so the mask left transparent space around
that row through which the pills remained visible. The mask geometry was written
against one layout state and silently became wrong when a second, taller state was
introduced; nothing tied the cutout to which state was rendered.

## Solution

Made the mask state-aware via `selectedAgentId`: the landing state clips the full
height of the taller no-agent controls (including Popular Goals), while the
agent-selected chat state keeps the existing smaller query-input mask. Added
regression coverage for the landing mask clearance so a future control added above
the input fails a test instead of leaking pills
(`front-end/src/tests/blackbox/terminal.blackbox.tsx`, 23/23 passing).

## Human feedback

None recorded.

## Reusable lesson

When a visual artifact appears in one UI state but not another, suspect a
hard-coded mask/cutout geometry rather than stacking order — clip regions must be
derived from the state actually rendered.
