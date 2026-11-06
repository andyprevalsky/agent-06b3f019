---
id: 2026-10-28-context-menu-opening-release-selected-delete
date: 2026-10-28
title: The mouse release that opened a context menu selected Delete before its placement settled
surface: front-end
component: context-menu-item
classification: our-bug
problem_class: other
first_bad_boundary: Radix MenuItem handled the opening non-primary pointerup as an item selection while the menu still overlapped its trigger
symptoms:
  - Rename project menuitem not found
  - Delete project confirmation open after only a right-click
  - original project flow at 1280px
tags:
  - context-menu
  - pointer-events
  - project-sidebar
  - semantic
sources:
  - commit 2cccd3fb62bd0f6e1d8653aa7699e8c6a09aa1bf
  - plan: .context/deploy-fresh-20261027/rca-projects-sidebar-flow-2ccc/
repro: front-end/src/tests/blackbox/context-menu-pointer-release.blackbox.tsx
status: open
---

## Problem

The native semantic project flow failed at1280px after23.8s;390px passed.
The unchanged test's Rename-project menu visibility assertion waited15000ms,
while the screenshot and DOM showed the Delete-project confirmation. The test
had only issued its opening right-click and had never selected Delete.

## Diagnosis

Path: right-button pointerdown on Rose row -> contextmenu opens Radix menu ->
menu initially overlaps row -> same right-button pointerup targets Delete ->
Radix synthesizes click when an item had no pointerdown -> item selection ->
Delete dialog -> original Rename assertion fails.

The original native trace preserved point117.5,107.43 on row0,88.4375,235,38,
then closed-menu/open-dialog in the same click's after snapshot. A passive
native observer reproduced the failure in26.672s with the same original
assertion. It captured pointerupbutton2 on Delete at7840ms while menu rect was
2,0,236,122.09375 and Delete rect8,82.09375,224,34, followed by menu.itemSelect
at7841.6ms. The installed Radix MenuItem implementation confirms that its
pointerup handler synthesizes click when the item had no pointerdown.

Literalproject/sidebar and behavioralpointer/hover/detached archive searches
were performed. The related2026-10-26-mobile-sidebar-poll-unmounted-project-list
Solution/Humanfeedback were read. That case was a mobilepollremount; this
mobile case passes and the desktop menu positively selected Delete.

## Solution

Preserve the caller's onPointerUp callback, then prevent default for non-primary
pointer releases in the shared ContextMenuItem. Radix respects the cancellation;
primary release and keyboard selection keep their existing paths. There is
no placement workaround, timer, retry, skipped assertion or threshold change.

Exact two-file patchSHA:
f160cbfe0ee70d7e13ba0ea12cb8e427822dd80ec36e5289aeff7d608874c0b8.
ProductionfileSHA:
b94b18dc801266696906bada2d70ab2786eb49c1ecc461e42364dd12e8cc3f1f.
RegisteredtestSHA after formatting:
450ae3610b1e789fbd484c05a061c9d3dea42374ff2065197c5d0a1b2274313b.
The executed rawtestSHA was61d9e80e37e4f74d1baa7ff9dc46f49c81df5c9bcf8fe11fcb564b8a9967c617;
format-proof.json verifies identical TypeScript and emitted-JavaScript ASTs.

Identical native source-level Vitest command:
node /home/boxes/rose/node_modules/vitest/vitest.mjs run --config /home/boxes/rose/.context/deploy-fresh-20261027/rca-projects-sidebar-flow-2ccc/vitest.config.ts --maxWorkers=3
Original2FAIL3PASS4.544s; candidate5PASS2.616s. Controls require right/middle
releases not to select, primaryrelease and Enter to select exactlyonce, and
the existing caller's cancellation to remain effective.

A supporting compiled-function splice was red30.461s and green2/2 in13.745s.
It is not finalbuildacceptance. An initial Vite-source-URL overlay did not
replace the builtasset and was rejected as candidate evidence. Its failure
is retained, not counted as native fixproof.

The actual private frontend build uses the exact production file. Both
unchanged original semantic cases and unchanged helpers passed on that build
at4310:12.579s,exit0. TestbytesSHA
b17ed1e82b55b3b99953b6e08bf01792ff083e79b44960ebea22aaa15b548e04.
No observer, module replacement or assertion change was present in this
realbuild check. The native command and buildreceipt are in real-build/receipt.json
and group4-final-2cccd3fb62bd/frontend-final-coverage/preview-ready.json.

All recorded test runner PIDs exited and were joined. Sharedstack/preview
ownership remained with root/ph7az. No provider, financial or database actions
were performed by the isolated tests. Historical childbirths were not
independently sampled; do not claim that missing evidence.

The full33 native semantic cases then passed on the same private built source
in115.625s (20:41:16.435808 to20:43:12.060692 UTC), exit0, four requested
workers and zero remaining recorded child identities. Its receipt is
.context/deploy-fresh-20261027/group4-final-2cccd3fb62bd/frontend-final-coverage/full-ui/receipt.json,
binding source manifest a29be8c30453b4c5983d80fb3f8fd7e81285f3bb8250370cc386804d9e41710e
and preview receipt4a8f967e2987536b7842cfb65fc103b46b35d6b623cadb3b6fa6649410f91064.

This draft remains open for root application, full affected frontend coverage
acceptance and archive validation.
The original fullG4failure remains recorded. No production or Mac claim.

## Recurrence: an earlier release timer cleared a later opening press

On source `440d5beb35c1482e709accc2e4a214dbb5274f85`, the fresh full frontend
native run passed 4,016 tests and failed the existing mouse-button-2 opening
release case. Its owner 28271 exited 1 and was joined; that failed aggregate is
retained. This is distinct from the original menu-placement failure above.

The historical broad non-primary guard above was superseded when upstream main
introduced coordinate-scoped opening-press tracking, preserving intentional
right-button drag selection. That merged implementation stored the current
press globally but an earlier release's zero-delay callback cleared it
unconditionally. If another contextmenu event installed a new press before
that callback ran, the old callback removed the newer press's protection.

The corrective runtime patch captures the press object and clears the shared
slot only when it still contains that same object. Capture-phase handling,
once-only listener, zero-delay scheduling, four-pixel slop, caller cancellation,
keyboard selection and intentional moved-right-drag behavior are unchanged.
The permanent registered test rapidly closes/reopens, flushes the prior
release timer, requires the new opening release to remain unselected, and then
requires a subsequent primary click to select normally.

Exact formatted patch SHA:
`3e8d6cb7504c375958241ee79300dd3d0f61d5e1a427f6588b146b5721269ace`.
Runtime SHA:
`3df9f01e31ac0fb412d06ad3d2640cce2de866395ea1a44be00d026439d50743`.
Registered test SHA:
`203dc2d7b25293c8620c1f248add12cdea74447f7d6d460e31719ce7ceaa6a73`.

Identical native command in the original and candidate private directories:
`node /home/boxes/rose/node_modules/vitest/vitest.mjs run --config vitest.config.ts --maxWorkers=1 --reporter=verbose`.
The formatted original passed seven and failed two cases in 12.576s; the
candidate passed all nine in 11.135s. The existing button-2 failure and new
rapid-reopen control both failed on the original. All seven existing local
expect-call ASTs and the complete three-case upstream opening/drag fixture
were preserved. Both owners were joined and all four known owner PIDs from
the formatted and earlier unformatted pairs are absent. There was no separate
complete descendant birth census. No provider, model, DB or service calls
were used by these isolated native tests.

Independent review was GROUNDED for that exact patch, report SHA
`ad7634d7f26c07cf4e3b8f3ed45e689bad5c96d6bdba191c03b5f3b972a98a25`.
Root applied the two-file correction in
`7947dcf36a4b6382de7d879cdc73d292e9f5c81f`. Fresh full frontend owner 77314 completed with native/outer exit 0: all
247 files and 4,018 tests passed. Coverage was statements 85.37%, branches
79.24%, functions 86.08%, and lines 87.71%, with unchanged thresholds.
Real Group 4 UI acceptance on the merged source has not started. This case stays open
until that final-source acceptance and archive validation complete. Evidence:
`.context/deploy-fresh-20261027/rca-context-menu-stale-release-440d/`.

The coordinator requested this bounded recurrence investigation, preserved
existing assertions and drag semantics, and retained sole canonical editing
and native deployment ownership. Those instructions are coordination, not
additional direct human feedback. The Human feedback section below remains
unchanged.

## Design constraints

The coordinator required original15s/60s clocks, case behavior and all
assertions; rejected fixture weakening or unproved load explanations; and
required a real frontend build after supporting compiledcode experiments.
The shared guard must preserve caller cancellation, primary and keyboard
selection. Root alone applies canonical changes and owns deployment.

## Human feedback

No additional direct human feedback was recorded for this incident.

## Reusable lesson

Opening a context menu with a secondary pointer button must not let that
same release select whichever item temporarily overlaps the pointer.
Guard selection by the input's meaning while preserving the intended
primary-pointer and keyboard paths.
