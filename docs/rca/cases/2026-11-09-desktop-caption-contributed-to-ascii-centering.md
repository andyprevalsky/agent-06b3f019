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


## 2026-11-10 semantic fixture follow-up (full native gate pending)

Source b8655088c4d90dd884e22786ca33f5c2bfb02cd7. Native round16 traces and the
unchanged local desktop Playwright unit pass the first 1440x900 ASCII assertion,
then fail at the second 768x813 navigation: `pre[data-ascii-layer="frame"]` is
absent and Browse is selected. Recorded OTP request and response bodies establish
successful real dev login as +15555550123. A local read-only storage/DOM probe
confirms that login persists app-user and reload intentionally selects Browse.
This is a related fixture-contract defect, not a recurrence of caption geometry.
The first-bad owned boundary is the semantic test navigating a second time without
establishing the empty-chat surface it asserts against.

The generalized fixture uses the existing injected-session/dev-login helpers; move the pointer outside
the sidebar, hover the existing rail at its established test position, then click
Home's Create Super Agent button. All original assertions, viewports, 15s expect
and poll budgets, 180s test timeout, one retry and four configured workers remain
unchanged. Before: 1 failed including retry, 47.70s runner wall. After: 1 passed
on first attempt, 8.4s test / 10.12s runner wall. Plain Home-row hover and rail
hover without leaving first stalled; both candidates were interrupted and saved.
The final fixture preserves all original source bytes except inserted setup.
Agent count remained 0; a separate route probe recorded zero agent-creation POSTs
and demonstrated another reload still opens Browse. No runtime route, storage,
token, assertion, provider data, deadline or concurrency change was made.

Repro: direct Playwright mobile-layout.spec.ts selection with --grep
'desktop opening ASCII stays centered on the large grid tile$' --workers=4
--retries=1 --trace=on, on the native scripts/run.sh --benchmark isolated stack.
Evidence: .context/assigned-pr1885-failures/ascii-fixture-repro/REPORT.md.
The generalized existing unit also passes in both real development-login and
legitimate injected-session modes, with Agent count 0 before and after. Native
stack cleanup is joined, owned ports are closed and the isolated database is
removed. Independent review found no blocking source-contract issue; it does
not claim fresh per-navigation auth-security coverage. Canonical full-gate
acceptance and deployment remain pending. User feedback: preserve browser-review routing, original assertions,
canonical source and all resource ownership; bounded clone-only investigation.
