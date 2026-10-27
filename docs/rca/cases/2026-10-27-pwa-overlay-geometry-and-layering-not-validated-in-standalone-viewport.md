---
id: 2026-10-27-pwa-overlay-geometry-and-layering-not-validated-in-standalone-viewport
date: 2026-10-27
title: Mobile PWA chrome used desktop geometry and an inverted modal layer, so header, settings, bell, drawer, toasts and Rename broke on an iPhone
surface: front-end
component: terminal-mobile-chrome
classification: our-bug
problem_class: other
first_bad_boundary: front-end overlay surfaces declared desktop-only geometry (transparent pointer-events-none header, panels right-anchored to mid-screen triggers, fixed top-4/top-20/top-0 offsets, no bottom inset) and ui/dialog z 200/201 sat below ui/sheet z 210/211
symptoms:
  - top bar has fade
  - opening agents can't be closed cuz no back button
  - agent settings panel opens weird / off-screen left on iPhone PWA
  - long-press agent row menu and Rename dialog invisible under the mobile drawer
  - drawer close X, toasts and Logout inside the status bar / home indicator
tags:
  - pwa
  - mobile
  - ios
  - safe-area-inset
  - z-index
  - layout
  - recurrence
sources:
  - commit 75b2a9c00
  - PR #854
  - commit b6ad551fc
repro: front-end/src/tests/blackbox/mobile-pwa-chrome.blackbox.tsx
status: fixed
---

## Problem

The user reported, on an iPhone Pro Max with Rose installed as a PWA: "top bar
has fade, opening agents can't be closed cuz no back button, the agent settings
panel opens weird, etc etc".

Related case 2026-07-22-pwa-drawer-toggle-fixed-top-offset-ignores-safe-area
(PR #854) fixed one instance of this class without a regression test. Commit
b6ad551fc raised the Sheet (210/211) above the Dialog (200/201). Base revision
75b2a9c00; fix on branch fix/mobile-pwa-chrome.

Further symptoms seen: chat text under the header icons and the status bar;
Agent Settings rect x=-226; bell popover off-screen left; sub-agent breadcrumb
overlapping the header (top-20).

Runtime evidence came from a Playwright Chromium emulation of the installed PWA
(430x932 CSS px, DPR 3, `navigator.standalone`, `display-mode: standalone`,
CDP `Emulation.setSafeAreaInsetsOverride` top 59 / bottom 34) against the local
stack with the dev account's real agents, plus a delegated investigator thread
using the same harness:

- The Rose mobile header was a transparent `pointer-events-none` row: scrolled
  chat text rendered under the hamburger/bell/app icons and the status bar.
- With an agent open the header had only hamburger, bell + apps and the Rose
  icon: no Back control, and an installed PWA has no browser back.
- Agent Settings (query-box nub gear at x 142-154, y 730): dialog rect
  `[-226, 36, 387, 686]` (later `[-221, -107, …]` on another agent) with
  `background-color: transparent` over the chat.
- Bell popover: card right-aligned to the bell at x≈220, so it hung off the
  left edge; its backdrop inherited the header's `pointer-events-none`, so it
  could not be dismissed by tapping outside.
- Agents drawer: Sheet close X at `top-4` (y≈16) inside the 59px status bar;
  Logout row bottom at y=920, inside the home-indicator zone (898-932).
- Long-press row menu: `RoseAgentRowMenu` forced `z-[200]` under the Sheet's
  `z-[211]` (`elementFromPoint` hit the Sheet overlay), and Radix anchored it
  at the finger, so a 345px menu pressed mid-row sat at x=-113.
- Rename from that menu: the dialog (`z-[201]`) rendered under the still-open
  Sheet (`z-[211]`), invisible.
- Toasts: Radix viewport `fixed top-0 p-4`, toast at y=16 over the status bar.
- `SubAgentBreadcrumb` at `top-20` (80px) inside the 115px mobile header.

## Diagnosis

Critical path: Terminal layout → mobile chrome / overlay primitives → CSS
geometry and stacking → what the user sees in standalone mode.

Each surface was designed and checked on desktop or in a Safari tab, where the
browser chrome absorbs the safe areas and triggers sit at the right edge.
In standalone mode the page owns the whole screen, the status bar is drawn over
it (`black-translucent`), and phone triggers sit mid-screen, so:

1. Fixed offsets (`top-4`, `top-20`, `top-0`, no bottom padding) land under the
   status bar or home indicator.
2. Panels anchored to a trigger's right edge (`useModalPosition`,
   attention `ModalWrapper`) or to the touch point (Radix context menu) overflow
   the left edge when the trigger is mid-screen.
3. A transparent header lets content and the status bar compete.
4. Stacking was ordered by component type (Dialog 200/201 < Sheet 210/211,
   menu override 200) instead of by open order, so anything opened from the
   mobile drawer (row menu, Rename) rendered under it. b6ad551fc raised the
   Sheet above the Dialog to keep a Sheet opened inside a Dialog on top, which
   inverted the drawer → Rename case.

Why 2 (deepest owned): none of these surfaces has a test of the standalone
mobile geometry. The 2026-07-22 case fixed one fixed top offset in PR #854 but
landed no regression, so the same class recurred on every new overlay. This is a
recurrence of that case's class, widened by the layering inversion.

Repro (pre-fix, base 75b2a9c00), `cd front-end && npx vitest run
src/tests/blackbox/mobile-pwa-chrome.blackbox.tsx`:
`Tests 7 failed | 1 passed (8)`. Examples: `expected 'pointer-events-none fixed
inset-0 t…' to match /(^|\s)bg-background(\s|$)/`; settings left edge
`expected -233 to be greater than or equal to 8`; `expected 'absolute top-12
right-0 z-50 …' to contain 'max-md:fixed'`; `expected 'absolute right-4 top-4 …'
to contain 'var(--safe-area-inset-top)'`; `expected 'absolute top-20 left-0 …'
to contain 'top-[calc(var(--mobile-terminal-header-height)'`. Round 2 on the
partially fixed tree: drawer bottom inset, `expected 200 to be greater than 211`
for the row menu, toast `pt-[calc(1rem+var(--safe-area-inset-top))]`, long-press
anchor `expected [] to deeply equal [ [ 8, 300 ] ]`, Rename `expected 201 to be
greater than or equal to 211`.

Golden reference: `openclaw/ui/src/styles/base.css:350-353` defines safe-area
variables; `openclaw/ui/src/styles/layout.mobile.css:55` positions mobile chrome
at `calc(8px + var(--safe-area-top))`; `openclaw/ui/src/styles/components.css:1247-1252`
drops toasts below `safe-area-top + header`; `openclaw/ui/src/styles/sidebar-menus.css:396`
caps menus to the canvas minus the top inset; `hermes-agent/web/src/App.tsx:777`
pads the bottom by `env(safe-area-inset-bottom)`. The fix converges on the same
rule: every edge offset is expressed against the safe-area variables and
floating panels are bounded by the viewport minus the header.

## Solution

On branch fix/mobile-pwa-chrome:

- `TerminalHeader` Rose mobile bar: opaque `bg-background` (exactly the app
  background, no glass, gradient or border), takes its own taps, and shows a
  Back chevron while an agent is open (sub-agent → parent via
  `selectedAgentParentId`, root → home); the Rose icon hides below 360px while
  Back shows so the row still fits 320px.
- `useModalPosition`: pure `computeModalPosition` clamps the panel inside an
  8px viewport gutter, sets its width to `min(420, vw - 16)` and caps its height
  below `--mobile-terminal-header-height`; `AgentSettingsDialog` is opaque below md.
- Attention `ModalWrapper`: below md the card is fixed, inset 8px, below the
  mobile header, scrolling within the remaining height.
- `ui/sheet` close X: 40px target at `top: 0.5rem + safe-area-inset-top` for
  top/left/right sheets; `MobileAgentDrawer` pads top and bottom insets and
  leaves room for the X in the tab row.
- `ui/context-menu` trigger: touch/pen long-press opens the menu from the
  trigger's left edge at the touch height (mouse right-click unchanged); this
  covers agent and project rows.
- One modal layer: `ui/dialog` and `ui/sheet` overlay and content are all
  `z-[210]`, so the last-opened surface (portals mount in open order) is on top
  — a Sheet inside a Dialog (tests-e2e/overlay-layers) and Rename from the
  drawer both work. `RoseAgentRowMenu` uses the shared menu layer `z-[220]`.
- `ui/toast` viewport: top padding includes the safe-area inset.
- `SubAgentBreadcrumb`: below the mobile header on phones, `md:top-20` on desktop.

Regression: `front-end/src/tests/blackbox/mobile-pwa-chrome.blackbox.tsx`
(13 tests, Step 4b front-end coverage / blackbox runner). Sibling failures
prevented: every Dialog opened from any Sheet, every context menu on touch,
every toast, every full-height Sheet close button. 10k-agent behavior: pure
CSS/geometry plus one prop from already-loaded agent detail; no new
subscriptions, requests or per-agent work.

Not covered: Sonner toasts (`ui/sonner.tsx`, not triggerable live; Sonner
applies its own safe-area offset), `SystemMessagesPanel` (`absolute top-4`),
`BrowserFullscreenOverlays` bottom offsets and `PhoneOverlay` (not reachable in
the emulated session); the wrench toolset popover reaches the right edge with
no gutter (marginal).

## Human feedback

User framing: "Go and test mobile view especially when it's rendered on a
iPhone max in a pwa … top bar has fade, opening agents can't be closed cuz no
back button, the agent settings panel opens weird, etc etc. /rca each issue u
find, then /deploy". No corrections recorded yet.

## Reusable lesson

Validate every overlay in the installed-PWA viewport (430x932, 59/34px safe
areas, mid-screen triggers) and order modal layers by open order, never by
component type.
