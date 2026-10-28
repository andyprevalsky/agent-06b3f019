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
