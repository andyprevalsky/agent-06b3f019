---
id: 2026-10-26-conditional-mount-and-top-pinned-composer-snapped-agents-pane
date: 2026-10-26
title: Agents-running pane snapped open and the composer jumped for two frames
surface: front-end
component: BackgroundAgentsBanner + QueryInputLayer
classification: our-bug
problem_class: other
first_bad_boundary: BackgroundAgentsBanner rendered the panel with `{expanded && …}` (no transition), and QueryInputLayer pinned the fixed composer layer by `top`, so growth went downward until a ResizeObserver → anchor height → anchor position round trip (2 frames) moved it up
symptoms:
  - Running N agents drawer snaps open instead of animating
  - agents running pane glitch when opening
  - query box jumps when the agents-running header expands
tags:
  - animation
  - composer
  - resize-observer
  - agents-running
sources:
  - commit b52c82632
  - commit dbe8e67dc
repro: front-end/src/tests/blackbox/background-agents.blackbox.tsx ("opens and closes by animating the same mounted slot"), front-end/src/tests/blackbox/rose-chrome-cleanup.blackbox.tsx ("the floating composer is pinned by its bottom edge")
status: fixed
---

## Problem

Opening "Running N agents" snapped the pane to full height. Headless Chromium
frame samples on the merged base: slot height 0 → 288 px in one frame; the
composer layer's bottom went 776 → 1064 → 1064 → 776 px (grew 288 px below its
slot for two frames, then jumped up); closing showed 776 → 488 → 488 → 776.

## Diagnosis

The panel was mounted only while expanded, with no transition. The composer is
a body-portaled fixed layer placed at the anchor's measured `top`; the anchor's
height is copied from the layer through ResizeObserver state, and the anchor's
new position is measured on the next observation, so any growth first extended
downward and was corrected two frames later.

## Solution

The pane renders an always-present slot animating `grid-template-rows` 0fr ↔
1fr (240 ms, `motion-reduce:transition-none`); its body mounts on first open and
stays mounted, so close animates the same nodes; closed is inert/aria-hidden.
QueryInputLayer pins the layer by `bottom` (clientHeight − anchor bottom), so
growth extends upward immediately. After: slot heights 0,0,0,9,50,132,200,241,
265,279,286,288 (open) and the reverse on close; layer bottom constant 776.
One RO-driven geometry update per frame while animating; no per-agent cost.

## Human feedback

Andy: "it snaps open instead of just smoothly animating, plz fix".

## Reusable lesson

Animate disclosures on an always-mounted 0fr/1fr slot, and pin a fixed layer that mirrors a bottom-aligned slot by its bottom edge so content growth never waits on a measurement round trip.
