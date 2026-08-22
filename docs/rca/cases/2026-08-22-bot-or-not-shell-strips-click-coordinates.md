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
status: open
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

Pending approval. Intended generalizable fix:

1. Keep `click_coordinates` when the snapshot looks challenged (reuse
   captcha/`app-captcha-pwa` / Bot-or-Not signals) even if shell indices exist.
2. Auto-include a viewport screenshot on challenged pages (or after challenge
   detection) so the model can see the slider without an extra turn.
3. Prompt/tool-desc: require `screenshot` (or visual self-solve) before
   `recover_from_challenge` when a challenge page is visible — alone is
   insufficient without (1).

10k-agent: O(1) per browser step filter + occasional screenshot bytes on
challenge pages only; no shared fan-in.

## Human feedback

User asked why the LLM thought there was no solve control, whether we need to
tell it to screenshot, and for `/rca` on non-engagement. Diagnosis-ready;
awaiting fix approval.

## Reusable lesson

Never strip `click_coordinates` solely because shell `[index]` nodes exist on a
challenge page — captcha widgets are often unindexed; keep coords and attach a
screenshot or the model will honestly report "no interactive solve control."
