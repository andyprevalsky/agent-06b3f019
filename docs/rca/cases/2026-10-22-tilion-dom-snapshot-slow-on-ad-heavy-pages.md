---
id: 2026-10-22-tilion-dom-snapshot-slow-on-ad-heavy-pages
date: 2026-10-22
title: browser-use DOM snapshots take 16-30 s+ on ad-heavy pages through Tilion; the CDP mux emulation fan-out is not the cause
surface: agents
component: browser-dom-snapshot-tilion
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: browser-use DOMWatchdog.on_BrowserStateRequestEvent CDP calls (DOM.getDocument, Page.getFrameTree, DOMSnapshot.captureSnapshot, Accessibility.getFullAXTree) answered slowly by Tilion's Chrome on pages with dozens of churning ad iframes; whether Tilion or the page is responsible is unproven
symptoms:
  - DOMWatchdog.on_BrowserStateRequestEvent running long
  - "CDP requests failed or timed out: snapshot, dom_tree, device_pixel_ratio"
  - "[CdpMux] Emulation.setLocaleOverride not applied ... Another locale override is already in effect"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
  - "browser.step.phases observe_state 26501"
tags:
  - tilion
  - dom-snapshot
  - cdp-mux
  - emulation
  - observe-state
  - kernel
  - hotels-com
sources:
  - agent c98fd018-e8e6-4a93-a3f8-7ec65924b611
  - agent 50ec6c94-041a-44e9-b24e-4c6728d56635 (descend epoch 18 browser-hotel-booking r1, source 2556bdb2a4, H-61)
  - commit 1151a43e89 (DOM build sub-phase timing in browser.step.phases)
repro: live A/B on one Tilion session and page load (emulation toggled on/off per get_browser_state call, dailymail.co.uk home); probe kept by lane A1 outside the repo. H-61 capture regression: agents/tests/blackbox/browser_step_timing.blackbox.py::test_dom_build_sub_phase_timing_reaches_step_phases
status: open
---

## Problem

Lane F's tinypng rerun (integration 717e90225) spent 47-135 s in observe_state per
step, with DOMWatchdog running-long warnings, 1839 `[CdpMux]` emulation lines for
1653 unique targets in 10 minutes (1567 `setLocaleOverride ... already in effect`,
89 `no reply: TimeoutError`) and `Received duplicate response for request 819`.

## Diagnosis

Live, Tilion direct egress, dailymail.co.uk home (22-54 frames, constant ad target churn):

- Mux with and without emulation, toggled per call on the same session and page load:
  emulation on 5.1/30.0/30.0/30.0 s, off 30.0/30.0/30.0/30.0 s (browser-use's 30 s
  DOMWatchdog cap). Emulation does not explain the slowness.
- Instrumented mux: held-target waits at the head of a client outbox max 0.01 s; outbox
  waits max 0.38 s, so no head-of-line blocking in the mux. Upstream (Chrome) latency up
  to 14.5 s for DOM.getDocument / Page.getFrameTree / DOMSnapshot.captureSnapshot with
  emulation off.
- `Received duplicate response for request N` also appears with a direct cdp_use client
  and no mux, so the mux id remap is not involved.
- Emulation still lands on new targets (main page, cross-origin iframe and new page all
  Europe/London).

So hypotheses (a) mux head-of-line, (b) held targets stalling the snapshot and (c) id
remap are refuted. The remaining cause is slow answers from Tilion's Chrome on this
page class. Not done: the same page on Kernel, to decide whether Tilion or the page is
responsible.

## Solution

None yet. Next discriminator: the same A/B on Kernel (and a direct client that never had
Playwright attached). Hygiene for lane B, not a fix: stop sending
Emulation.setLocaleOverride once a target answers "Another locale override is already in
effect" (Tilion's persona owns locale), which removes most of the failing emulation
traffic.

## Recurrence 2026-11-07 (H-61, Kernel, hotels.com checkout)

`browser-hotel-booking` epoch-18 copy r1 (agent 50ec6c94, source 2556bdb2a4) failed
"Timeout after 1129s (task timeout=1125s) ... Expected payment_approval attention
request ... but none was triggered"; copy r2 (fe372460) passed in 876 s.

- The triage reading "never called request_payment_card / slow checkout verification"
  is wrong. r1 issued `request_payment_card` at 19:10:17; the PAUSE arrived at
  19:10:35 while that action's own browser-state read was still inside
  `DOMWatchdog.on_BrowserStateRequestEvent` (>15 s warning 19:10:33). r2's request
  returned in 3 s ("Payment card requested ($375.42)").
- Both copies reached checkout ~12.6 min after start and used similar step counts
  (r1 9 checkout steps, r2 ~8) and LLM time (238 s vs 299 s; per-call 3-18 s). H-49
  saved-method text, pay-at-hotel, H-38 line-item validation and write-locks were not
  involved: the model chose a one-time card and the request never reached validation.
- The differentiator is `browser.step.phases.observe_state`: r1 452 s total vs r2 66 s.
  On r1's post-recovery `kernel_mobile` session it grew from ~1 s (18:56-18:58) to
  5-15 s on the property page and a flat ~26.5 s on every checkout read, although the
  checkout had only 695 elements; clicks and `evaluate` on the same page returned in
  under 2 s. r2's Kernel residential and Steel sessions read the same pages in 0.4-3 s.
  The read_browser_state that hit "Page changed during credential preparation" ran two
  26 s builds (53 s). No "CDP request ... timed out" warning fired, so Rose's 10+2 s
  `_get_all_trees` budget never expired; which part of the build stalled
  (get_all_trees, cross-origin iframe recursion in construct_enhanced_tree, or
  serialization) was not captured, because browser-use only debug-logs its
  per-build `timing_info`.
- Fix shipped for the capture gap: `record_browser_use_dom_build_timing()` keeps that
  breakdown on the session, `DOMService.last_dom_build_timing_ms` exposes it per state
  read (cleared when a read builds no DOM) and the handler adds
  `observe_dom_timing_ms` to `browser.step.phases`. Regression
  `test_dom_build_sub_phase_timing_reaches_step_phases` failed on 4c9636f84d
  (ImportError: no capture) and passes after the fix (5/5), with the whole
  browser_step_timing suite green (32/32).
- Still open: the cause of the slow builds. Live Kernel mobile-proxy sessions on
  hotels.com cannot be recreated without a paid browser/benchmark run; the next
  occurrence will show which sub-phase stalls. The exact-benchmark outcome proof was
  not run (no benchmarks in this assignment).

## Human feedback

None recorded.

## Reusable lesson

Attribute a slow observe to its DOM-build sub-phase (`observe_dom_timing_ms`) and toggle the suspected mechanism on the same live page load before blaming it.
