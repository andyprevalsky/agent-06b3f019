---
id: 2026-11-09-desktop-caption-contributed-to-ascii-centering
date: 2026-11-09
title: Desktop opening caption displaced the ASCII art from the grid center
surface: front-end
component: ChatScrollArea
classification: our-bug
problem_class: other
first_bad_boundary: ChatScrollArea desktop flex-centered wrapper included the in-flow opening caption
symptoms:
  - main ascii animation is off center on the homepage
  - only off on desktop view
  - ASCII vertically centered on large tile
tags:
  - ascii
  - desktop
  - layout
sources:
  - commit d319c16c43606b87c6e905acdcffc1289f85da22
repro: front-end/src/tests/blackbox/opening-layout.blackbox.tsx
status: fixed
---

## Problem

The homepage animation sat above the large background tile's center on desktop.
Production Chromium at 1280x813 measured the art center at y=300.31 versus the
tile center at 325.2. Local Chromium at 1440x900 measured y=332 versus 360.
No agent execution or agent self-report was involved; this is homepage layout.

## Diagnosis

Path: viewport dimensions → background grid center (height × 0.4) →
ChatScrollArea full-height desktop loader → centered art/caption stack → pre.
Horizontal centering was correct (720 at width 1440). The desktop loader's
100dvh height and 20vh bottom margin centered the entire stack at 40% viewport
height, but the in-flow caption contributed 32px height plus 24px gap. The art
therefore sat (32+24)/2 = 28px above that center. Mobile already absolutely
positions the art and caption separately and did not share the failure.
The deepest owned cause is coupling decorative text dimensions to the art's
position; no API, frame-data, or font change is needed.

Archive searches: `ASCII desktop center` and `homepage animation alignment`.
Returned cases were unrelated (sidebar headroom, overlay geometry, composer
animation); no matching ASCII/caption cause was found. This is a novel case.

## Solution

Remove desktop caption participation in flex sizing: position it absolutely
below the art, horizontally centered, with a desktop-only relative containing
block. Keep mobile containing blocks and transforms unchanged. This also keeps
the art stable when the caption is absent or changes height. This deletes the
layout dependency rather than introducing JS measurements or pixel nudges;
there is no per-agent cost or additional listener at 10k agents.
Golden reference: not applicable (no approval-gated hunk).

The permanent opening-layout blackbox checks desktop caption isolation and
existing terminal tests continue checking the mobile transform. It is discovered by vitest.config.ts
and `npm run test:coverage`, the normal frontend deploy gate.
Command: `cd front-end && npx vitest run src/tests/blackbox/opening-layout.blackbox.tsx`.
Before: failed because the stack lacked a positioned containing block and the
caption was in flow. The final test scopes that containing block to md+; that final version was
replayed unchanged against both original and fixed component source.
A local Chromium layout repro (`node .context/ascii-centering/local-layout.cjs`)
failed with `AssertionError: ASCII vertically centered on large tile`, measured
[720,332], then passed unchanged with [720,360] after the fix. Scratch logs and
private screenshots are under `.context/ascii-centering/`.

The real CSS geometry regression is also preserved in the existing
`front-end/tests-e2e/mobile-layout.spec.ts` suite, checking 1440x900 and
768x813, through the normal Playwright semantic runner. Additional local
checks passed at 1280x813, 1920x1080, 768x900, 767x813, 390x844 and 390x667.
Both phone widths and the 767px boundary retained a static parent and the
existing art center at 40% viewport height minus 40px.
Full frontend gate: 322 files / 4,709 tests passed. Coverage: statements 87.38%,
branches 81.78%, functions 87.70%, lines 89.63%. Typecheck and changed-file ESLint
also passed. Independent managed RCA review confirmed the cause; its requests
for an unchanged final before/after test, permanent browser geometry coverage,
and additional breakpoint coverage were addressed.

## Human feedback

The user clarified: "its only off on desktop view doe". Preserve mobile layout.
The user explicitly requested `/rca` then `/push`.

## Reusable lesson

Center the art independently of adjacent caption dimensions, using breakpoint-scoped containing blocks to preserve mobile positioning.


## Recurrence — November 10, signed-in horizontal alignment

User: "its still off center, fix, validate, then /push", with a dark-mode
screenshot showing art right of the large tile. The earlier signed-out vertical
proof was valid but incomplete coverage of signed-in layouts.

Runtime evidence from the deploy coordinator and our independent local real
Terminal render agrees: at 1440x900 with the signed-in RoseDesktop 64px rail,
art center was [752,360], tile center [720,360]. The background SVG owns
viewport-centered geometry, whereas TerminalMainContent adds sidebar padding
to its chat column. The absolute opening loader inherited that inset, moving
its center by half the rail width. This is a separate horizontal boundary
missed by the original reproduction; retain the original vertical fix/proof.

Our unchanged local command `node .context/ascii-centering/horizontal.cjs`
failed before with `art horizontally centered in tile`, then passed at
art=[720,360], tile=[720,360], padding=64px. This renders the actual app with a
synthetic local signed-in session; it proves layout, not authentication.
The permanent opening-layout blackbox extension failed before because md:fixed
was absent. The owning fix adds md:fixed to the opening loader so its desktop
containing block agrees with the grid, independent of sidebar width; mobile
remains absolute. No pixel compensation or duplicated sidebar state is added.
The existing desktop Playwright regression now injects the supplied semantic
session and measures against the actual SVG tile rather than a second formula.

Archive searches: `ASCII desktop center` and `sidebar viewport horizontal offset`.
This is a recurrence of the reported visual symptom with a newly proven
horizontal cause, recorded here to preserve the prior evidence and its gap.

Final recurrence validation: full frontend coverage passed 324 files,
4,718 tests passed / one skipped, thresholds met (87.38% statements,
81.78% branches, 87.70% functions, 89.63% lines). Changed-file ESLint passed.
The final strengthened blackbox explicitly renders a signed-in account and
asserts the sidebar-inset main before asserting the viewport-anchored loader.
That exact final file failed on original source and passed on the fix.
The exact final signed-in browser test failed with measured error 32px on
original source and passed after restoring the fix, with the 2px bound unchanged.
Commands: `cd front-end && npx vitest run src/tests/blackbox/opening-layout.blackbox.tsx`
and `FRONTEND_URL=http://127.0.0.1:4102 SEMANTIC_SESSION=<local-layout-fixture>
npx playwright test tests-e2e/mobile-layout.spec.ts -g 'desktop opening ASCII'`.
The synthetic session is only a local layout fixture, never an auth validity claim.

Independent managed review found no blocking implementation objection or
ancestor containing-block trap. Existing pointer-events-none, z18 loader,
z20 messages, dimming and transcript tests remain intact; no claim of a new
end-to-end chat screenshot is made. The 24-case local geometry matrix passed
six sizes, two rail offsets, and both themes, including the 767/768px boundary.
