---
id: 2026-11-11-iphone-apple-svg-framing
date: 2026-11-11
title: iPhone Apple artwork used an off-center SVG viewBox
surface: front-end
component: IPhoneConnectionSection
classification: our-bug
problem_class: other
first_bad_boundary: IPhoneConnectionSection AppleIcon viewBox origin
symptoms:
  - iPhone Apple icon off center inside its integration tile
  - iphone-apple-icon artwork shifted right and up
tags:
  - svg
  - icon-alignment
sources:
  - commit 06edeba6cb
repro: Chromium SVGGraphicsElement.getBBox compared with SVGSVGElement.viewBox.baseVal on the production AppleIcon path
status: fixed
---

## Problem

The screenshot shows the Apple logo shifted right within the white iPhone integration tile. Archive searches for `iphone apple icon` and `svg off center` did not identify an earlier case covering this geometry.

## Diagnosis

The rendering path is AppleIcon SVG artwork → SVG viewBox → centered DropdownIconFrame. A local headless Chromium measurement of the unchanged production path returned bounds x=6.432955, y=0, width=16.167048, height=22. With the original `0 0 24 24` viewBox, the artwork center was displaced +2.516479 SVG units horizontally and -1 vertically. An assertion requiring absolute displacement below 0.1 failed with exit 1. The wrapper centers the SVG element; the incorrect coordinate framing displaced its visible artwork. This is an asset geometry defect, with no service or runtime-state dependency.

## Solution

Change only the SVG viewBox origin to `2.5 -1`, retaining its 24×24 size and the original artwork. The identical Chromium bounds assertion passed with exit 0: horizontal displacement 0.016479 units, vertical displacement 0. This fixes the owning artwork definition for every connection state without adding wrapper offsets or changing shared icon styling. No additional state, branching or per-agent work is introduced. Golden reference: not applicable (no approval-gated hunk).

The local reproduction loads the production SVG path and viewBox into Chromium and compares `path.getBBox()` center to `svg.viewBox.baseVal` center. Local before/after evidence is in `.context/iphone-icon-centering/check.cjs`; existing iPhone integration behavior remains covered by `front-end/src/tests/blackbox/integrations-iphone.blackbox.tsx`. No permanent test was added for this reversible visual adjustment.

## Human feedback

The user requested a quick icon-centering fix followed by `/push`.

## Reusable lesson

Center SVG artwork by its visible path bounds inside the viewBox before adjusting a shared layout wrapper.
