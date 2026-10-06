---
id: 2026-09-10-macos-live-view-module-case-collision
date: 2026-09-10
title: Case-insensitive resolution loaded live-view geometry instead of the React component
surface: front-end
component: browser-live-view-frame
classification: our-bug
problem_class: other
first_bad_boundary: Vite resolves the extensionless LiveViewFrame import to liveViewFrame.ts on case-insensitive macOS storage
symptoms:
  - "does not provide an export named 'LiveViewFrame'"
  - blank frontend on a fresh macOS clone
  - LiveViewFrame.tsx and liveViewFrame.ts
tags:
  - macos
  - vite
  - module-resolution
sources:
  - PR #1299
  - commit 50e6a8196a27cf84023c4c08493547bc133976c9
repro: front-end/src/tests/blackbox/browser-live-view-frame.blackbox.tsx
status: fixed
---

## Problem

The freshly installed PR branch served HTTP 200 at `http://localhost:32002`,
but Chrome rendered an empty page. Its console reported:

```text
SyntaxError: The requested module '/src/features/terminal-component-group/components/browser-status-bar/liveViewFrame.ts' does not provide an export named 'LiveViewFrame'
```

The served `BrowserAgentChip.tsx` module imported `LiveViewFrame` from
`liveViewFrame.ts`, although the source requested `./browser-status-bar/LiveViewFrame`.

Archive searches: `liveViewFrame does not provide export LiveViewFrame`,
`Vite blank page type import`, and `case insensitive ts tsx module resolution`.
This is a relative of `2026-09-08-fe-live-view-shows-steel-window-chrome`:
that change introduced the two modules, but its rendering defect and this
module-resolution defect have different first-bad boundaries.

## Diagnosis

The import was a real React component import, not a TypeScript-only type.
The directory contained both `LiveViewFrame.tsx` (component) and
`liveViewFrame.ts` (geometry). On the Mac's case-insensitive filesystem,
Vite's extension search found the `.ts` helper before the `.tsx` component.
The helper exports geometry functions but no `LiveViewFrame`, so module
linking failed before React mounted. The deepest owned cause is ambiguous
module basenames, not service health or browser-provider state.

Local reproduction, run from `front-end/` using Node 22.13.0:

```bash
npx vitest run src/tests/blackbox/browser-live-view-frame.blackbox.ts src/tests/blackbox/browser-live-view-frame.blackbox.tsx
```

Before the fix this exited 1: **3 failed, 10 passed**. The full-screen, inline,
and direct component cases failed with `Element type is invalid` and
`got: undefined`. The browser console and served import identify why that
component export was undefined. After the rename, the identical command
exited 0: **2 files, 13 tests passed**. Restarting Vite cleared
its cached resolution; the served import then targeted `LiveViewFrame.tsx`,
and Chrome's accessibility tree showed the Rose home screen, sidebar, account
control, and agent composer.

## Solution

Rename the geometry module to `liveViewGeometry.ts` and update all six helper
imports, including the existing geometry and component blackboxes. The
component keeps its existing public name. The same unambiguous path serves
thumbnails, cursor overlays, inline frames, full-screen frames, and recordings.
There are no rendering, provider-session, viewport, or per-agent cost changes.
The blackboxes are discovered by `front-end/vitest.config.ts` and run under
`/deploy` Step 4b coverage. This resolution regression is caught on a
case-insensitive macOS checkout; the same DOM tests alone do not expose it
on a case-sensitive Linux filesystem.

Local evidence: `.context/acceptance/live-view-repro.log`,
`.context/acceptance/live-view-exact-fixed-tests.log`, and the Chrome UI check.

## Human feedback

The user requested a working fresh clone, completion of PR #1299, persistent
setup context for future agents, and no repeated permission requests.

## Reusable lesson

Give an extensionless-imported component and its helper distinct basenames
across case-insensitive filesystems; HTTP health does not prove the UI mounted.
