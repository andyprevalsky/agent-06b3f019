---
id: 2026-08-22-bot-or-not-shell-strips-click-coordinates
date: 2026-08-22
title: Bot or Not captcha shell indexes strip click_coordinates so the browser LLM cannot engage the slider
surface: agents
component: providers/rose/browser_use.filter_browser_use_actions_for_state
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/browser_use.py::filter_browser_use_actions_for_state — removes click_coordinates whenever any [index] exists, including #app-captcha-pwa shell nodes with no slider index
symptoms:
  - "no interactive solve control is available"
  - "#app-captcha-pwa"
  - "Show us your human side"
  - "Bot or Not?"
  - click_coordinates missing from browser_use tools
tags:
  - browser-use
  - captcha
  - hotels-com
  - bot-or-not
  - click-coordinates
sources:
  - agent 3c824ea4-7aee-4e9d-a17e-d285b6fc4983
  - PR #1032
  - commit 3a3b88a49
repro: agents/tests/blackbox/rose_browser_use.blackbox.py::test_filter_keeps_click_coordinates_on_bot_or_not_captcha_shell
status: fixed
---

## Problem

On `browser-hotel-booking` agent `3c824ea4-7aee-4e9d-a17e-d285b6fc4983`, step 9
hit Hotels.com `Bot or Not?` (`#app-captcha-pwa`, copy "Show us your human
side..."). The recording shows a visible slider; the model never dragged it and
called `recover_from_challenge` with reason **"no interactive solve control is
available."** Dump: zero images in messages; tools list has `screenshot` but
**not** `click_coordinates`; indexed DOM is only shell `[div]`/`[a]`/`[span]`.

Archive searches (`click_coordinates filtered indexed targets captcha`,
`include_screenshot browser_use captcha`, `Bot or Not`): relative to Expedia
classifier / soft-block cases; **novel** for shell-index + coords filter + no
screenshot.

## Diagnosis

Critical path: DOM snapshot → `filter_browser_use_actions_for_state` → tool list
→ LLM observes text-only challenge → `recover_from_challenge`.

1. Captcha PWA mounts shell nodes that **are** indexed (`[3545]<div
   id=app-captcha-pwa>`, `[3582]<a>`, `[3594]<span>`) but the slider is not an
   indexed control.
2. `filter_browser_use_actions_for_state` strips `click_coordinates` whenever
   `state_has_indexed_dom_targets` is true — so the only pixel-path action is
   removed exactly when the page looks "indexed" but the real widget is not.
3. Browser loop captures state with `include_screenshot=False`; screenshots
   appear in the LLM context only after a prior `screenshot` tool call. The
   model never called `screenshot` (0/18 steps had images).
4. Prompt already says try the slider then recover, and mentions screenshot for
   iframe CAPTCHAs — but also "Only interact with elements that have a numeric
   [index]" and advertises `click_coordinates` rules while the tool is absent.
5. The model's "no interactive solve control" claim is **true given its
   observation+tool set**, not a free-standing model-intelligence failure.

Local repro (0.58s): Bot-or-Not shell `dom_tree` → filter drops
`click_coordinates` → assert `click_coordinates in out` fails.

## Solution

Removed the indexed-DOM strip in
`filter_browser_use_actions_for_state` — it is now a pass-through so
`click_coordinates` stays available whenever the allowlist includes it
(including Bot or Not shells with `#app-captcha-pwa` indexes).

Also extended the `screenshot` tool description to tell the model that captcha
DOM shells are often misleading and to screenshot before
`recover_from_challenge`, then use `click_coordinates`. Dump replay on step 9
of agent `3c824ea4`: baseline 3/3 `recover_from_challenge`; coords-only 2/3
recover + 1/3 screenshot; screenshot-desc (± coords) 3/3 `screenshot`.

10k-agent: O(1) per step; no shared fan-in. Screenshot bytes only when the
model opts in (or a later auto-include change).

## Human feedback

User rejected keeping a conditional "coords stay available on challenge pages"
shape — the indexed-DOM strip should be removed altogether ("sounds hella
retarded"). Asked to iterate on the specific LLM divergence (coords alone vs
screenshot tool desc) rather than theorize.

## Reusable lesson

Never hide `click_coordinates` because the DOM has indexes — captcha shells
index empty wrappers; prefer tool-description guidance over stripping the tool.
