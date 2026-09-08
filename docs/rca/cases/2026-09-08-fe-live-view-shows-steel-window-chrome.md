---
id: 2026-09-08-fe-live-view-shows-steel-window-chrome
date: 2026-09-08
title: FE live view showed the Steel 1288x891 computer window including toolbar so page content looked off-center
surface: front-end
component: browser-live-view-frame
classification: our-bug
problem_class: other
first_bad_boundary: front-end LiveViewFrame / BrowserIframe — framed the Steel player as the full 1288x891 computer window instead of cropping to the 1280x800 content viewport
symptoms:
  - "browser content is always seemingly out of view"
  - "offcenter in my view like there is content hanging outside the window"
  - connect.steel.dev/v1/sessions
  - "1288x891"
tags:
  - browser
  - live-view
  - steel
  - chrome-offset
  - letterbox
  - antibot
sources:
  - agent 3b2a912a-0248-478a-a4b9-0693a4983d75
repro: front-end/src/tests/blackbox/browser-live-view-frame.blackbox.ts
status: fixed
---

## Problem

Andy watching agent `3b2a912a-0248-478a-a4b9-0693a4983d75` (DHL waybill) reported the browser live view always looked off-center, as if page content hung outside the window.

Runtime evidence from `GET /api/agents/3b2a912a-0248-478a-a4b9-0693a4983d75`:

- Steel sessions streamed `https://connect.steel.dev/v1/sessions/.../player?interactive=false`
- Steel player config is `inputCoordinateSpace = { width: 1288, height: 891 }` and contain-fits that canvas into the iframe
- Session create sizes the computer window at 1288x891 so the CSS content viewport stays 1280x800 (4px side borders + 91px toolbar)
- Kernel JWT on the same agent carried `viewportWidth: 1280, viewportHeight: 800`; that live URL 404'd by the time of this RCA
- The Steel player already contain-fits; a 16:9 leftover pane letterboxes that window, it does not overflow it. The visible defect is chrome-in-stream: the toolbar sits in the frame and the page sits low / cropped.

Archive searches: `browser content offcenter out of view hanging outside the window` and `steel chrome live view 1288x891 toolbar crop viewport`. Relative of `2026-08-22-kernel-computer-screenshot-includes-chrome-offset` (chrome vs content space on screenshots). Not a recurrence — that case cropped Kernel screenshots for click coords; this one is the FE player showing Steel window chrome.

## Diagnosis

Critical path: Steel session window (1288x891) → Steel player canvas → FE iframe → user view.

Binary search:

1. Remote page layout is for the 1280x800 content viewport. Fingerprint still does not spoof `innerWidth`/`innerHeight`. Data is correct here.
2. Steel player streams the full computer window, including toolbar. That is intentional for antibot (window size ≠ content size).
3. First-bad boundary: FE framed that window 1:1 (or as 16:9 / 1440x900), so the user saw chrome plus a shifted page — "content hanging outside the window."

Step 5a:

- Why 1: the visible clip included y=0..91 toolbar pixels that are not page content.
- Why 2: live-view, thumbnail, and HTML recording each treated 1288x891 as the display aspect; only the cursor overlay already subtracted chrome.
- Why 3: there was no FE display contract that "show the content viewport; keep the remote window size for fingerprint." Stop here. Do not change Steel `dimensions: {1288,891}` or fingerprint injection (user: do not break antibot).

## Solution

`liveViewFrame` letterboxes the 1280x800 content viewport and, for Steel URLs only, sizes the iframe to 1288x891 and translates it by (-4, -91) inside an overflow-hidden clip. Kernel has no chrome crop. Cursor overlay maps onto the content box (no second chrome offset). HTML recordings use the same crop. Fingerprint injection and session create dimensions are unchanged. Desktop no longer calls `/viewport`.

Siblings also prevented: 1440x900 expanded thumbnail; 16:9 inline clip of a chrome-inclusive stream; cursor sitting on the toolbar after the crop.

10k-agent: CSS-only crop, one iframe per viewed task. Deleted per-agent `POST /viewport` on desktop fullscreen resize.

## Human feedback

Fix without breaking any anti-antibot behaviors. Do not spoof inner viewport dimensions or change Steel 1288x891 / Kernel 1280x800 session create size to paper over the FE frame.

## Reusable lesson

Crop Steel live-view and recordings to the 1280x800 content viewport in the FE — never show window chrome, and never resize the remote session to the leftover pane.
