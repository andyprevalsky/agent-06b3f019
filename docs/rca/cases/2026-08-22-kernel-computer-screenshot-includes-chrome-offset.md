---
id: 2026-08-22-kernel-computer-screenshot-includes-chrome-offset
date: 2026-08-22
title: Kernel computer screenshot includes window chrome so screenshot-picked drag/click coords miss by ~87px
surface: agents
component: spawn-browser-agent-v3-screenshot
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_actions.py::_execute_screenshot — crops Steel computer screenshots to viewport coords but returns Kernel captures uncropped (full window chrome included)
symptoms:
  - "Dragged from (531,387) to (752,387)"
  - "Kernel screenshot must match CSS viewport for coordinate tools"
  - Viewport: 1280x713
  - "Bot or Not?"
  - "Slide right to secure your access"
tags:
  - kernel
  - screenshot
  - chrome-offset
  - drag
  - click-coordinates
  - bot-or-not
  - hotels-com
  - calibration
sources:
  - agent fcb37373-a88a-4a74-bb76-a290be2be1f1
  - commit fbf75d590
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_execute_screenshot_kernel_crops_chrome_to_css_viewport
status: fixed
---

## Problem

On hotels.com Bot or Not, browser agent `fcb37373` correctly called `screenshot`
then `drag` with `start=(531,387)` / `end=(752,387)`. The tool reported success
("Dragged from…"), but the Kernel replay shows the slider thumb never moved —
the help text under the slider was highlighted instead (text selection).

Runtime evidence:

- DOM state: `Viewport: 1280x713`
- Attached screenshot bytes: **1280×800** (full computer window)
- Chrome height = `800 - 713 = 87` (matches Steel's `STEEL_VIEWPORT_CROP_Y`)
- Pixel at screenshot `(531,387)` is the dark thumb `(70,73,76)`; CDP y=`387`
  without crop maps to screenshot y=`474` which is light page text `(249,249,249)`
- Steel path already crops computer screenshots; Kernel path returned raw bytes

## Diagnosis

Critical path: Kernel `computer.captureScreenshot` →
`_execute_screenshot` → LLM reads image → `drag`/`click_coordinates` → CDP
`Input.dispatchMouseEvent` in CSS viewport space.

Binary search:

1. Model coords are correct **on the image it saw** (thumb is at y=387 in the
   1280×800 capture).
2. CDP events use those numbers as CSS viewport coords.
3. CSS viewport is 1280×713; the image includes ~87px of browser chrome above
   the page.
4. First-bad boundary: `_execute_screenshot` only cropped when
   `provider == "steel"`; Kernel images stayed chrome-inclusive while the tool
   contract says "Coordinates in this image match click_coordinates."

Archive: novel relative of `2026-08-22-bot-or-not-shell-strips-click-coordinates`
(tool exposure fixed; coordinate space still wrong). Not a recurrence of the
Steel crop itself — Steel was fixed; Kernel never got the same contract.

## Solution

`_execute_screenshot` now crops non-Steel computer screenshots to the live CSS
viewport (`window.innerWidth` × `window.innerHeight` via CDP), removing top
window chrome so screenshot pixels match click/drag coordinates. Steel keeps its
fixed crop. Cemented by
`test_execute_screenshot_kernel_crops_chrome_to_css_viewport`.

10k-agent: one crop per screenshot tool call, O(1) image work, no shared state.

## Human feedback

User observed the replay "highlighted the text underneath" and called it a
calibration issue; directed `/rca`. Approved
`kernel-screenshot-chrome-crop-82ccc` and asked for a new hotel-bench recording
after the fix.

## Reusable lesson

Computer-window screenshots must be cropped to the CSS viewport before the LLM
picks click/drag coordinates — provider parity with Steel's crop is mandatory for Kernel.
