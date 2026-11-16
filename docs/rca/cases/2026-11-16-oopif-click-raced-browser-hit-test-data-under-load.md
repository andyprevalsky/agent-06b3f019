---
id: 2026-11-16-oopif-click-raced-browser-hit-test-data-under-load
date: 2026-11-16
title: Cross-origin iframe coordinate test clicked before Chromium published the OOPIF's hit-test data, so under load the click hit the top page's <iframe> or a stale frame point
surface: agents
component: browser-dom-coordinates
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_dom_service_cross_origin_iframe_coordinates_include_frame_offset dispatched page.mouse.click right after page load / the cross-process scrollIntoViewIfNeeded, before the browser's OOPIF hit-test data reflected the frame's layout"
symptoms:
  - "assert await frame.locator(\"#email\").input_value() == \"a@roselabs.ai\""
  - "assert await frame.locator(\"#pay\").get_attribute(\"data-clicked\") == \"1\", coords"
  - "AssertionError: (826, 543)"
  - dom_service_cross_origin_iframe_coordinates_include_frame_offset flaked in new-test-stability under load
tags:
  - browser
  - iframe
  - oopif
  - flaky
  - load
  - timing
sources:
  - PR #2129 deploy new-test-stability / agents coverage (failed once, passed on rerun)
  - PR #2257 (merge 224a7c8c20), which added the test
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_dom_service_cross_origin_iframe_coordinates_include_frame_offset
status: fixed
---

## Problem

The regression test for case
2026-11-15-iframe-element-coordinates-missed-frame-offset flaked in PR #2129's
deploy new-test-stability lane: it failed once and passed on rerun. That lane
ran 8 concurrent lanes plus busy-loop load workers. Locally, 16 parallel copies
with 16 busy loops on an 8-CPU devbox (with concurrent repo-wide grep I/O)
failed 4/64. Three failures were at the email `input_value() == "a@roselabs.ai"`
check. One was at Pay `data-clicked == "1"` with coords (826, 543). In every
failure the coordinates `get_click_coordinates` computed were correct (Pay's
top-level box after the 319 px scroll is y 523..563).

## Diagnosis

1. A probe served the same pages and logged `pointermove`/`mousedown`/`click`
   in both documents. It clicked the known-correct points immediately after
   `goto` and after the frame-session `DOM.scrollIntoViewIfNeeded`, with
   16 parallel copies and 16 busy loops. It missed 70 of 160 clicks. Every
   email miss logged `mousedown:IFRAME click:IFRAME` in the TOP document and
   nothing in the frame. Every Pay miss logged `mousedown:BODY` inside the
   frame (a stale point) while top `scrollY` was already 319.
2. Why: Chromium routes mouse input to an out-of-process iframe from
   browser-side hit-test data. That data is published only when the OOPIF's
   next compositor frame is activated. The load event and the CDP scroll
   response both arrive before that frame, so a click dispatched in the gap
   goes to the parent's `<iframe>` element, or uses the pre-scroll transform.
   Under CPU/I/O starvation the gap stretches past the slack the test's
   intervening CDP calls usually provide.
3. Product path: `DOMService` returns correct coordinates. The humanizer moves
   along a multi-step path for hundreds of ms on pages loaded long before, so
   this gap is a test-timing artifact, not the prod b4466499 symptom.

## Solution

Before each click, the test now waits on a condition: it installs a
`pointermove` listener on the target and moves the pointer to the computed
coordinates until the OOPIF target itself receives that move. Then it clicks.
The wait is deadline-bounded (30 s) and fails with a message naming the
coordinates. Wrong coordinates still fail, so assertions are unweakened.
Same-load proof: the boundary probe went from 70/160 misses to 0/160, and the
test went from 4/64 failures to 0/160 (64 under CPU load plus 96 under CPU+I/O
load). Test-only change, so 10k-agent behavior is unchanged.

## Human feedback

None recorded.

## Reusable lesson

A synthetic click into an OOPIF right after load or scroll can race Chromium's
browser-side hit-test data, so wait for the target to receive a pointer event
at the same coordinates before asserting on the click.
