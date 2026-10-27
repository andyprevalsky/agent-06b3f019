---
id: 2026-10-26-in-place-panel-trapped-under-portaled-composer-layer
date: 2026-10-26
title: Project settings drawer and Rose toolset popover painted under the portaled query box (z-[100])
surface: front-end
component: rose-desktop-stacking (LeftPanelShell, RoseToolSetChip, QueryInputLayer)
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: LeftPanelShell rendered in place inside TerminalContent's `h-screen flex z-[4]` flex item (its own stacking context) while QueryInputLayer portals the composer to document.body at z-[100]; RoseToolSetChip overrode ui/popover's z-[220] with z-50
symptoms:
  - query box drawn over the Project settings drawer
  - composer (wrench, sparkle, Enter any goal, rose-flash picker) covers project settings
  - Built-in tools available to all Rose agents popover under the Running 1 agent header
  - toolset popover hidden behind agents-running banner
  - Biz health panel opens a third of the screen under the query box
tags:
  - z-index
  - stacking-context
  - portal
  - rose-desktop
  - composer
sources:
  - commit a70049483
  - commit 8ceb1008c
  - commit d80ff1e4c
repro: front-end/src/tests/blackbox/rose-chrome-cleanup.blackbox.tsx ("Rose Desktop stacking order and composer continuity"), front-end/src/tests/blackbox/rose-sidebar.blackbox.tsx ("Biz health covers the query box full width like Browser")
status: fixed
---

## Problem

In the deployed Rose Desktop UI the floating query box painted over the
left-bar Project settings drawer, and the composer's Rose toolset popover
painted under the "Running 1 agent" header attached to the composer. Biz health
opened as a 560px side panel beneath the query box. The rendered-DOM repro
(outermost z-indexed ancestor of each element) failed on b3679ea7b with
`expected 4 to be greater than 100` (drawer) and `expected 50 to be greater than
100` (popover).

## Diagnosis

QueryInputLayer portals the composer (and its attached agents-running banner)
to document.body at z-[100] so it escapes app panels. LeftPanelShell was
rendered in place inside the main row `div.h-screen.flex.z-[4]`; a flex item
with a z-index forms a stacking context, so its own z-[65] competed at root
level as 4. RoseToolSetChip passed `z-50` to PopoverContent, and tailwind-merge
replaced ui/popover's z-[220], so the portaled popover sat at 50 under the
composer layer. Z values were ad hoc per file, with no shared order, and the
"which panels cover the composer" list was duplicated in RoseAppIcons and
RoseAppPanels (Integrations only).

## Solution

`front-end/src/lib/roseLayers.ts` defines one root scale: appPanel 66 < appIcons
90 < composer 100 < leftPanel 101 < coverPanel 102 < coverIcons 103 < popover 220.
LeftPanelShell portals to body at leftPanel (an app opened while project
settings stays open covers it; review follow-up) and its width ends left of the
top-right icon row; the toolset and test-prompt popovers keep the
popover tier; AppDrawerShell, RoseAppIcons, QueryInputLayer and ui/popover use
the tokens; `coversComposer()` (browser, integrations, health) is the single
list. Biz health uses the full-width variant. No data flow or per-agent cost
changes (pure layout).

## Human feedback

Andy asked for the drawer and toolset to stack above the composer and for Biz
health to show over the query box at full width like Browser.

## Reusable lesson

Compare stacking by the outermost z-indexed ancestor: a fixed panel left inside an in-flow z-indexed flex row can never cover a body-portaled layer, so portal it and take its z from the shared scale.
