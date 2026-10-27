---
id: 2026-10-26-archived-dialog-grid-item-min-width-auto-and-light-only-row-fill
date: 2026-10-26
title: Archived dialog rows painted past the dialog and were unreadable in dark mode
surface: front-end
component: terminal-component-group/ArchivedAgentsDialog + AgentListItem
classification: our-bug
problem_class: other
first_bad_boundary: ArchivedAgentsDialog list wrapper (a DialogContent grid item with default min-width:auto) and AgentListItem's light-only bg-navi-white-dark row fill
symptoms:
  - Archived dialog hovered row extends past the dialog's right edge to the window edge
  - long archived agent title renders as a light pill outside the Archived panel
  - Archived dialog hovered/selected row near-white background with light text in dark mode
  - '"Restoring brings an agent back to the sidebar. It does not resume the run." dialog row overflow'
tags:
  - css-grid
  - min-width-auto
  - truncate
  - dark-mode
  - archived-agents
sources:
  - commit bbe669f2b
  - commit af20ff849
repro: front-end/src/tests/blackbox/app-sidebar-rows.blackbox.tsx ("keeps a long archived title inside the dialog, ellipsized, with its full goal on hover"; "leaves rows unfilled at rest, colouring only on hover or selection")
status: fixed
---

## Problem

In the Archived dialog, an agent whose fallback title is a long raw goal made
its hovered row a light pill running far past the dialog's right edge. In
Rose Desktop dark mode the same hovered row was a near-white fill under
near-white text. Headless Chromium on the base revision (1280x800, one
230-character goal plus 30 short rows) measured the row's right edge at
2028px against the dialog content edge at 872px (row width 1607px; viewport
1631px). The dark hover fill was rgb(229,229,229) under text rgb(236,236,232).
The list scrolled vertically (scrollHeight 1004 > clientHeight 480), and its
viewport began below the header (top 190 >= header bottom 174), so the
partially visible top row came from the scroll position, not header overlap.

## Diagnosis

`DialogContent` is a CSS grid with an implicit `auto` column track. The list
wrapper (`max-h-[60vh] flex flex-col`) is a grid item with the default
`min-width: auto`, which resolves to its min-content width. The row title is
`truncate` (nowrap), so that min-content width is the full goal on one line.
The track therefore grew to about 1607px and every row's `w-full`, plus the
ScrollArea, followed it past the 512px dialog. The h3's own `min-w-0 truncate`
could not take effect because its ancestors were never constrained. In the
sidebar, rows sit in a fixed-width aside, which hid the same latent dependency.

Dark mode: `AgentListItem` hard-coded `bg-navi-white-dark` (#e5e5e5, no
dark variant) for hover, selected and the trailing action overlay. Under
html.dark the dialog's inherited foreground is #ecece8.

## Solution

`ArchivedAgentsDialog` adds `min-w-0` to the list's grid item, pinning it to
the dialog content box. `AgentListItem` adds `min-w-0` to the row's flex line,
and a shared `ROW_FILL` keeps the light `bg-navi-white-dark` while adding the
theme `accent` token in dark mode (`dark:bg-accent` / `dark:hover:bg-accent`,
#383835). Its action overlay, action-button hover and icons receive dark variants. Light mode is
unchanged. Post-fix Chromium measured the row's right edge at 859px against
872px; the viewport scrollWidth equals clientWidth at 462px. The title ellipsizes and
retains `title=<full goal>`; dark hover is rgb(56,56,53) under rgb(236,236,232).
The fix uses static class strings and has no effect on scaling with agent count.

## Human feedback

Andy (item 31): "make sure archived doesn't display items outside of view, and
that it looks readable in dark mode". He also asked that the full title remain
available, that no visual wrappers be added, and that the existing theme tokens be used.

## Reusable lesson

Give every flex or grid item that contains truncated text `min-w-0` on each
auto-sized ancestor up to the fixed-width container, and give every fixed
light fill a `dark:` theme-token override.
