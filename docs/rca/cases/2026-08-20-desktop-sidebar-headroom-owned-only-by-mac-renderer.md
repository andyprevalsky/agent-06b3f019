---
id: 2026-08-20-desktop-sidebar-headroom-owned-only-by-mac-renderer
date: 2026-08-20
title: Desktop sidebar delegated required top headroom to the Mac renderer
surface: cross
component: app-sidebar-layout
classification: our-bug
problem_class: other
first_bad_boundary: front-end AppSidebar buildSidebarStyle omitted the desktop headroom invariant
symptoms:
  - still has no top padding
  - New Agent collides with the mac-app top bar stuff
  - New Agent is only 0.25rem below the top edge on desktop
tags:
  - sidebar
  - desktop
  - electron
  - layout
  - padding
sources:
  - agent 01a02183-1eff-7681-bb12-6c58b0aa4a32
repro: front-end/src/tests/blackbox/app-sidebar.blackbox.tsx
status: fixed
---

## Problem

The user reported that the New Agent button still had no visible top padding
and supplied a screenshot in which the button sat immediately below the top
edge. The pre-fix working-tree snapshot was:

```text
AppSidebar.tsx: pt-[var(--rose-sidebar-top-offset,0.25rem)]
mac-app/ui/main.tsx: :root { --rose-sidebar-top-offset: 3rem; }
```

That left every ordinary desktop renderer with a 0.25rem fallback even though
a source-string test claimed the Mac override existed. Recording both lines
here preserves the transient artifact after the split implementation was
replaced by the shared fix.

The permanent owning-boundary style-contract test was changed first to require
`paddingTop: 3rem` on the rendered sidebar element. It does not claim to model
native titlebar collision geometry. Before the production fix,
`cd front-end && npx vitest run src/tests/blackbox/app-sidebar.blackbox.tsx`
failed 1 test and passed 22, reporting `expected paddingTop: 3rem`.

## Diagnosis

The visible chain was `desktop renderer -> shared AppSidebar -> renderer-local
CSS variable -> New Agent position`. The screenshot proved the final symptom;
the pre-fix style-contract test proved that the shared sidebar did not emit
3rem of headroom; source inspection then showed that the only 3rem value lived
in the Mac entry point while the shared fallback was 0.25rem.

The first-bad boundary was `buildSidebarStyle` in `AppSidebar.tsx`: a required
desktop layout invariant was absent from the component that renders on every
desktop surface. The deepest owned cause was split ownership of one visual
contract. A platform entry point was allowed to correct shared layout, and the
test asserted class/source strings instead of the rendered style, so web and
Electron could diverge while the suite remained green. Archive searches for
the exact padding symptom and sidebar/titlebar terms found the related mobile
safe-area case but no desktop case with this boundary, so this is novel rather
than a recurrence.

## Solution

Make `AppSidebar` the single owner of desktop headroom. `buildSidebarStyle` now
sets `paddingTop: '3rem'` unconditionally for the desktop-only aside, and the
Mac-only custom property was removed. The blackbox test renders the component
and asserts the effective inline style, so both browser desktop and Electron
are protected by the same check. The identical focused command now passes all
23 tests.

The change is one constant style property per sidebar render. Its behavior and
cost are independent of the number of agents, including 10,000-agent lists.

## Human feedback

The user rejected the first Mac-only offset because the screenshot still had no
visible top padding. They required the New Agent button to clear the Mac title
bar and retain headroom on ordinary desktop too.

## Reusable lesson

A layout invariant shared by multiple renderers must be owned and behaviorally tested in the shared component, not supplied by a platform-only override.
