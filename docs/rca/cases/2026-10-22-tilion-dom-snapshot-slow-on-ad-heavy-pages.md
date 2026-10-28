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
  - "Received duplicate response for request"
tags:
  - tilion
  - dom-snapshot
  - cdp-mux
  - emulation
  - observe-state
sources:
  - agent c98fd018-e8e6-4a93-a3f8-7ec65924b611
repro: live A/B on one Tilion session and page load (emulation toggled on/off per get_browser_state call, dailymail.co.uk home); probe kept by lane A1 outside the repo
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

## Human feedback

None recorded.

## Reusable lesson

Toggle the suspected mechanism on the same live page load before blaming it; the page's own load varies more than most fixes.
