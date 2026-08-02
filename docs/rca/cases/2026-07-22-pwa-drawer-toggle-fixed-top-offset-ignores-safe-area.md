---
id: 2026-07-22-pwa-drawer-toggle-fixed-top-offset-ignores-safe-area
date: 2026-07-22
title: The mobile agents/notifications drawer toggle used a fixed top offset, so the iOS PWA notch overlapped it
surface: front-end
component: mobile-agent-drawer
classification: our-bug
problem_class: other
first_bad_boundary: the drawer toggle's top offset was a fixed value instead of including `env(safe-area-inset-top)`
symptoms:
  - the notch overlaps the agents/notifications toggle in the installed PWA
  - mobile drawer toggle is partly unreachable at the top of the screen
tags:
  - pwa
  - mobile
  - safe-area-inset
  - ios
  - layout
sources:
  - PR #854
repro: none-recorded
status: fixed
---

## Problem

In the installed PWA on a notched device, the device notch overlapped the mobile
agents/notifications drawer toggle, obscuring the control.

## Diagnosis

The toggle positioned itself with a fixed top offset rather than one derived from
`env(safe-area-inset-top)`. In a browser tab the surrounding chrome absorbs the
inset, so the fixed offset looks correct; in standalone PWA display mode the app
owns the full viewport including the unsafe area, and any hardcoded top offset
lands under the notch. The class of defect is a viewport assumption that only
holds in one display mode.

## Solution

The toggle's offset now includes the safe-area inset, matching the pattern
already used by the terminal header and the mobile drawer surface
(`pt-[var(--safe-area-inset-top)]`, where `--safe-area-inset-top` is defined as
`env(safe-area-inset-top, 0px)` in `front-end/src/index.css`). The PR does not
name a dedicated regression test for this item.

## Human feedback

None recorded.

## Reusable lesson

Any fixed top/bottom offset on a mobile surface must be expressed against the
safe-area inset variables — a layout that is correct in a browser tab can still
be unreachable in standalone PWA mode.
