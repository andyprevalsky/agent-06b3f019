---
id: 2026-10-30-ios-pwa-shell-sized-by-dvh-not-visual-viewport
date: 2026-10-30
title: iOS PWA app shell and floating query box not placed in the visual viewport — box jumping to the top over the chat while typing, then clipped at the bottom after the keyboard closes
surface: front-end
component: app-wiring initViewportHeight / TerminalContent app shell / QueryInputLayer
classification: our-bug
problem_class: other
first_bad_boundary: front-end/src/features/terminal-component-group/components/query-input/QueryInputLayer.tsx placed the body-portaled fixed composer at documentElement.clientHeight - anchorRect.bottom, mixing client coordinates (which follow the iOS keyboard's panned visual viewport) with fixed coordinates (which keep the layout viewport); app-wiring setAppShellGeometry sized the standalone shell to screen.height although iOS paints nothing below its short post-keyboard viewport (2026-10-30 boundary: TerminalContent sized by 100dvh)
symptoms:
  - installed iPhone PWA shows a large empty gap under the query box (no browser search bar)
  - tapping the query box on iPhone PWA makes it jump far above the keyboard (to the top of the screen)
  - after the keyboard closes the query box bottom row (attach, rose-flash chip, send) is cut off by a flat band at the screen bottom
  - "expected { left: 8, bottom: 234 } to deeply equal { left: 8, bottom: 569 }"
tags:
  - pwa
  - ios
  - visual-viewport
  - keyboard
  - query-box
  - mobile
sources:
  - task user-reported iPhone PWA screenshots 2026-10-30 (keyboard open and closed)
  - task user-reported iPhone PWA screenshots 2026-11-04 6:27 PM PST (recurrence, keyboard open and closed)
  - task user-reported iPhone PWA screenshot 2026-11-05 1:51 PM PST (cold landing, 62pt band under the shell)
  - task Amplitude "iOS Viewport Geometry" events 2026-11-05 (standalone: inner/client/visual height 894, screen 956)
repro: front-end/src/tests/blackbox/rose-chrome-cleanup.blackbox.tsx ("makes iOS give the installed PWA the full screen"); front-end/src/tests/blackbox/query-input-layer.blackbox.tsx ("keeps the composer on its slot while the iOS keyboard pans the visible viewport"); front-end/src/tests/blackbox/app-wiring-hooks.blackbox.ts ("never extends past the visible viewport when iOS leaves it short after the keyboard closes"); front-end/src/tests/blackbox/rose-chrome-cleanup.blackbox.tsx (shell vars + mobile trajectory text)
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
the keyboard instead shrinks and pans the _visual_ viewport. A shell sized by
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

**Recurrence 2026-11-04 (iPhone 440x956pt PWA, 62pt status-bar inset).** Both
symptoms came back. Screenshot geometry: (1) keyboard open — the chat column
ends at the keyboard accessory bar (shell placed correctly by `--app-top`) and
its composer slot (~391–569pt) is empty, while the composer is drawn at
~55–234pt: exactly one visual-viewport pan (~335pt) too high. The fixed header
(top-0, not on `--app-top`) is off-screen above, confirming fixed boxes kept the
layout viewport while the visible region panned. QueryInputLayer placed its
body-portaled fixed layer at `clientHeight - anchorRect.bottom`; the anchor's
client rect follows the panned visible region but the fixed `bottom` resolves
against the layout viewport, so the error equals the pan. The 10-30 fix moved
the shell but never tested the composer under a pan. (2) Keyboard closed — page
painting stops at exactly 894pt (956 − 62) with a flat #272725 band below, but
the composer is laid out to ~948pt: the 10-30 fix forced the standalone shell to
`screen.height`, assuming the short viewport was still paintable. It is not
(iOS 26 standalone leaves the viewport short after keyboard dismissal; Apple
forum 800125/799216, WebKit 297779), so the composer's toolbar row was clipped.
The 10-30 "gap under the query box" was most likely this same unpaintable band,
so the earlier fix converted a gap into clipping.

Local repro (jsdom model of the measured geometry: 956pt layout viewport, 335pt
pan, slot 391–569pt; post-keyboard viewport 894):
`cd front-end && npx vitest run src/tests/blackbox/query-input-layer.blackbox.tsx src/tests/blackbox/app-wiring-hooks.blackbox.ts`
pre-fix: 2 failed — `expected { left: 8, bottom: 234 } to deeply equal { left: 8, bottom: 569 }`
(the screenshot's 234pt) and `expected { height: '956px', top: '0px' } to deeply
equal { height: '894px', top: '0px' }`. Post-fix: 27/27 passed; the 8 suites that
render the composer pass 122/122.

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

Recurrence fix (2026-11-04): (a) QueryInputLayer portals a `pointer-events-none
fixed inset-0` frame (composer z) and positions the composer absolutely inside it
at `frameRect.bottom - anchorRect.bottom` / `anchorRect.left - frameRect.left`.
Both rects share one coordinate space, so the offset is exact however the
browser maps client to fixed coordinates; `clientHeight` is no longer read.
(b) `setAppShellGeometry` deletes the standalone/screen-height and keyboard
threshold branches: the shell is always the visual viewport (height +
offsetTop), and pinch zoom keeps the layout viewport. The shell can no longer
extend into area iOS does not paint. Remaining device-side limit: if iOS keeps
its short post-keyboard viewport, the box sits on that boundary with iOS's band
below it instead of being cut off (clip -> gap; still `mitigated`). The 10-30
at-rest fixture (873 of 932) is kept and now asserts that trade-off explicitly.
(c) Observability: `initViewportHeight` emits one `iOS Viewport Geometry`
Amplitude event per keyboard transition (shell height/top, innerHeight,
clientHeight, visualViewport height/offsetTop/scale, screen height, standalone),
so the next on-device report carries the real numbers. Adversarial review
(managed thread ph77hhtq, 2026-11-05) found no regressions; its open points were
that the device's post-keyboard innerHeight/visualViewport values and whether
the band is canvas or WKWebView under-page are unmeasured — exactly what (c)
captures. Golden reference: not applicable (no
approval-gated hunk).

**Recurrence 2026-11-05 (cold launch, no keyboard).** The landing page of the
installed PWA again ended 62pt above the screen bottom. The telemetry added on
11-04 settled the open question: every standalone event reports innerHeight,
documentElement.clientHeight and visualViewport.height = 894 with screen 956,
on first load as well as after the keyboard; Safari tabs report their real
viewport. So the short viewport is not a post-keyboard state: iOS 26 gives an
installed `viewport-fit=cover` + `black-translucent` page a viewport short by
the status-bar inset whenever the document is no taller than that viewport
(WebKit 301108), and WebKit stops drawing at the short edge — which is why the
10-30 screen-height shell was clipped and the 11-04 visual-viewport shell left a
band. `html.rose-app-shell` pins html/body to `height: 100%`, so the document
was always exactly the short viewport. Fix: `@media (display-mode: standalone)
{ html { min-height: min(100lvh, calc(100% + env(safe-area-inset-top, 0px))) } }`
— a document one inset taller makes iOS hand back the full screen, the cap at
100lvh keeps it from scrolling, and a zero inset leaves every other surface
unchanged; the visual-viewport shell then measures 956. Same mechanism and
simulator measurement (812 → 874 on iPhone 17 Pro) as frappe-ui #1284/#1289.
Repro limit: jsdom/Chromium cannot reproduce the iOS 26 short viewport, so the
structural test pins the rule and the shell vars; device confirmation comes
from the same Amplitude event (standalone visual_height should read 956).

## Human feedback

User asked for: trajectory font +2px on mobile only; query box flush with the
bottom in the PWA (a few px padding, gap only where a browser bar needs it);
query box flush on top of the keyboard when typing.

2026-11-04: user reported both query-box positions broken again ("2 mobile
issues w the querybox location at different steps") and asked for /rca, a local
replication, then /deploy.

## Reusable lesson

On iOS, size the shell from `visualViewport` (height + offsetTop, never screen.height or 100dvh) and place anything portaled out of it by the difference of two client rects, never by mixing client rects with `clientHeight`/fixed coordinates. When an installed PWA's viewport is short of the screen, no shell size can paint into the missing band: make the document taller (standalone html min-height) so iOS returns the full viewport, and instrument the device numbers before the second guess.
