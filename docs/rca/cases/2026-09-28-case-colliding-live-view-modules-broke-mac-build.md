---
id: 2026-09-28-case-colliding-live-view-modules-broke-mac-build
date: 2026-09-28
title: Case-colliding live-view modules broke the macOS Vite build
surface: front-end
component: browser-live-view
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: front-end/src/features/terminal-component-group/components/browser-status-bar/LiveViewFrame.tsx filename
symptoms:
  - "LiveViewFrame is not exported by liveViewFrame.ts"
  - "local deploy stack exited before backend startup during bundled frontend build"
tags:
  - frontend
  - macos
  - vite
  - browser-live-view
sources:
  - commit 63e7f7bec2
  - PR #1312
repro: front-end Vite production build
status: fixed
---

## Problem

The local deploy stack's production Vite build failed after transforming 4,364
modules. Rollup reported that `LiveViewFrame` was not exported by
`browser-status-bar/liveViewFrame.ts`, although the component importer requested
`browser-status-bar/LiveViewFrame` and the component itself existed as
`LiveViewFrame.tsx`. Backend and worker startup never began.

## Diagnosis

Archive searches for `LiveViewFrame is not exported liveViewFrame macos case
insensitive vite` and `Rollup resolves ts before tsx case collision` found no
prior case at this boundary. The import path was
`BrowserAgentChip.tsx` → `./browser-status-bar/LiveViewFrame` → Vite resolution
on a case-insensitive Mac filesystem. `LiveViewFrame.tsx` and
`liveViewFrame.ts` differed only by case and extension. The resolver selected
the `.ts` geometry helper first, which correctly had no component export.

The exact production build failed locally with the quoted Rollup error. After
renaming the component file to `BrowserLiveViewFrame.tsx` and updating its
four imports, the same `npx vite build --outDir dist --emptyOutDir` path built
4,337 modules and exited zero. The existing browser live-view blackbox still
imports the component through its new unambiguous path. The command was run
from `front-end/`; before the fix it exited with `LiveViewFrame is not exported
by .../liveViewFrame.ts`, and after the fix it completed. The checked-in
`src/tests/blackbox/source-module-casefold.blackbox.ts` detects this ambiguity
on either case-sensitive or case-insensitive filesystems. With the old
`LiveViewFrame.tsx` restored from `HEAD`, the unchanged command
`cd front-end && npx vitest run src/tests/blackbox/source-module-casefold.blackbox.ts`
failed with `LiveViewFrame.tsx ↔ liveViewFrame.ts` (one failed test). After the
old file was removed again, the same command passed (one test). The current
source-module test therefore preserves the exact basename collision as a
blackbox regression.

The impact scan covered the three production imports of this component and
all sibling `.ts`/`.tsx` source basenames under `front-end/src`. No source
collisions remain. The two `browser-live-view-frame.blackbox` test entry files share a
basename but are selected by explicit test extensions and are excluded from
source-module imports. The next deeper layer, the geometry helper, exported
its documented functions correctly; only the filesystem/toolchain resolution
of the component path was wrong.

## Solution

Give the component a distinct basename and leave the `liveViewFrame.ts`
geometry helper intact. The component API, live-view behavior, and helper
exports are unchanged. The bundled frontend build remains a deploy gate on
the Mac workspace where the collision occurred.

## Human feedback

None recorded.

## Reusable lesson

Give TS and TSX source modules in one directory distinct basenames under case
folding when building on both Linux and macOS.
