---
id: 2026-10-30-ios-pwa-shell-sized-by-dvh-not-visual-viewport
date: 2026-10-30
title: iOS PWA app shell sized by 100dvh, not the visual viewport — gap under the query box and the box jumping far above the keyboard
surface: front-end
component: app-wiring initViewportHeight / TerminalContent app shell
classification: our-bug
problem_class: other
first_bad_boundary: front-end/src/features/terminal/components/TerminalContent.tsx — the app shell (and TerminalMainContent) were sized by CSS 100dvh, which on iOS tracks neither the on-screen keyboard nor the full standalone screen; initViewportHeight already listened to visualViewport but only wrote --vh, which the shell never read
symptoms:
  - installed iPhone PWA shows a large empty gap under the query box (no browser search bar)
  - tapping the query box on iPhone PWA makes it jump far above the keyboard (to the top of the screen)
  - mobile trajectory / chat message text too small on phone
tags:
  - pwa
  - ios
  - visual-viewport
  - keyboard
  - query-box
  - mobile
sources:
  - task user-reported iPhone PWA screenshots 2026-10-30 (keyboard open and closed)
repro: front-end/src/tests/blackbox/app-wiring-hooks.blackbox.ts ("iOS app shell follows the visible viewport (installed PWA)"); front-end/src/tests/blackbox/rose-chrome-cleanup.blackbox.tsx (shell vars + mobile trajectory text)
status: mitigated
---

## Problem

User screenshots from the installed iPhone PWA: (1) with the keyboard closed the
query box ends ~60pt (≈ the status-bar inset) above the screen bottom, with the
chat grid also ending there — the whole shell is short; (2) with the keyboard
open the query box sits at the top of the screen, roughly one keyboard height
(~340pt) above the keyboard's accessory bar; (3) trajectory text is small on a phone.

## Diagnosis

The terminal shell and main column were `height: 100dvh`. On iOS, `dvh` follows
the layout viewport: in standalone mode with `viewport-fit=cover` and a
black-translucent status bar iOS reports that viewport short of the screen, and
the keyboard instead shrinks and pans the *visual* viewport. A shell sized by
100dvh therefore leaves a band below it with the keyboard closed and, while
typing, places the bottom-anchored composer (QueryInputLayer pins the fixed layer
to the anchor's bottom) in layout coordinates that no longer match what is
visible. `initViewportHeight` already subscribed to `visualViewport` resize/scroll
on iOS but only wrote `--vh`, which the shell never used.

Local repro (jsdom model of the iOS viewport — 430x932 screen, 873 layout height,
keyboard = visualViewport {height 560, offsetTop 300}):
`cd front-end && npx vitest run src/tests/blackbox/app-wiring-hooks.blackbox.ts`
pre-fix: 4 failed (shell geometry vars never written: received "" instead of
932px/0px, 560px/300px). Post-fix: 20/20 passed, 5 consecutive runs.

Gap: this is a model of iOS viewport behaviour; jsdom/Playwright cannot run the
real iOS keyboard. Device behaviour must be confirmed on the phone after deploy —
hence status `mitigated`, not `fixed`.

## Solution

`initViewportHeight` (iOS only) now writes `--app-height`/`--app-top`:
keyboard open (visual viewport > 150px shorter than the full height, not pinch
zoom) → the visual viewport's height and offsetTop; keyboard closed in an
installed PWA → the full screen height; Safari tab → the visual viewport height.
The terminal shell is `position: fixed` at `top: var(--app-top, 0px)` with
`height: var(--app-height, 100dvh)` (main column follows), so desktop/Android
are unchanged and the composer anchors to the visible bottom — flush on the
keyboard or the screen edge (it keeps its existing 0.5rem gap).
Trajectory text: `.rose-trajectory` (message list) bumps every Tailwind size used
by trajectory components by 2px below 768px; a test enumerates every arbitrary
`text-[Npx]` in those components so a new size cannot stay small on phones.
10k-agent behaviour: client-only CSS/viewport listeners; no per-agent cost.

## Human feedback

User asked for: trajectory font +2px on mobile only; query box flush with the
bottom in the PWA (a few px padding, gap only where a browser bar needs it);
query box flush on top of the keyboard when typing.

## Reusable lesson

On iOS, size a full-screen app shell from `visualViewport` (height + offsetTop, full screen in standalone), never from `100dvh`, or the composer will gap at the bottom and float above the keyboard.
