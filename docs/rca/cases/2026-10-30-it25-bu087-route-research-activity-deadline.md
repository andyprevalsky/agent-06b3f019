---
id: 2026-10-30-it25-bu087-route-research-activity-deadline
date: 2026-10-30
title: BU087 reaches the activity deadline while validating a route
surface: agents
component: browser-activity-lifecycle
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: The browser activity reaches its original StartToClose deadline during continued research; a recovered socket close and a different stale target do not establish the terminal cause
symptoms:
  - "activity StartToClose timeout"
  - "WebSocket reconnected after 5.8s (attempt 1)"
  - "Session silent for 1144s"
tags:
  - polar
  - bu087
  - it25
  - deadline
  - cdp
sources:
  - commit 3dc00896d3b8dcc0b3666c9c8493507ee96c7809
  - agent 89b2c502-17f9-47f0-a972-125ac1845924
  - plan:.context/r103/proof.json
repro: none-recorded
status: open
---

## Problem

Original It25 BU087r1/r001-j0007 asks for the specialty shop matching a Mexico
walking-distance clue and a California market's2023 floral event. It ends
nativeFAILED3007.8s/progress1, canonicalFAILED/producerinfraFALSE, with no
semantic judge result. The fatal error is an activity StartToClose timeout.
This is distinct from the earlier BU087 completed-answer/C3 case.

## Diagnosis

Archivee8ccfde339678048e771ef2ef141a153fcea9a070b97798b3f66f73b7814cb99 and
all seven original member hashes/sizes match manifest
3265a106c50651afa1d281a8921902df378c544dabed0b79a75f8bae6ee2fbd9.
Run23d9585708a72417906726fbb92e2fa2aaba1338754efc89a7977637f50c827f
binds source3dc00896d3b8dcc0b3666c9c8493507ee96c7809/patchnone.

The activity started at02:53:35.468522Z. Original worker18758 records upstream
CDP close code1006 at03:21:00.339397Z. Contrary to an unrecovered-close diagnosis,
worker18919 explicitly records successful reconnection after5.8s on attempt1
at03:21:16.076079Z. Browser work continues for roughly22minutes. The close
initiator and the extent to which that episode delayed research remain
unproved; code1006 alone does not assign a vendor or local cause.

The actor continues checking the Northgate market event and routes to El Moro.
At03:41:39.432Z its reasoning says the2023 event is confirmed and the remaining
route is around7.7km in OSM Valhalla, perhaps differing from the requested7.8km.
That is an unresolved research choice, not an accepted completion. It next
uses different coordinates and requests another Valhalla route.

The last successful required observation at03:43:16.205Z shows the active
OpenStreetMap Valhalla walking route with coordinates19.433648,-99.209947 to
19.431311,-99.141212, tab3101. Worker26730 records the completed state-read
phase at03:43:18.076198Z. The later warning at26756 concerns targetF45F17D0C66A,
a different GraphHopper route with coordinates19.433599,-99.209702 to
19.431265,-99.14119. It reports23 pending calls and1144seconds silence, while
another session replied8seconds earlier. This stale session warning does not
prove the observed active page was unavailable.

Worker26752 starts requestb34aaed7e7ee at03:43:31.350790Z. No completed response
for that request is captured before worker26761 reports the Temporal
StartToClose timeout at03:43:35.511121Z, about3000.043seconds after activity
start. The manager's await activity_handle is the terminal stack. No original
browser fatal stack or accepted final answer identifies a smaller broken
runtime boundary. The later paused-by-user message is not evidence that a
human initiated the deadline.

Archive searches covered StartToClose route research and stale CDP targets
after reconnection. The CDP latency evidence-gap case and the R49 disconnect
case's Solution/Human feedback were read. R49 involved failed reconnection and
a later-proven backend handoff; this packet explicitly records reconnection
success. Neither its fix nor the old BU087 C3 case is automatically this cause.

## Solution

OPEN; no deterministic general runtime repair established. Preserve the
original3000-second activity limit and all grades. Raising limits, forcing
completion on an approximate route, or replacing a session from a stale-target
warning would not prove a causal repair. A useful further original trace would
bind outstanding calls to the active target and explain their contribution to
the critical path, rather than treating every stale session as active work.
No new provider/model/DB/guest call, replay, capture or speculative test was made.

Final normal cleanup records exact Tilion session
sess_0351ec1bcdc84558a7bcbff285a0a2f2 DELETE204, root deleted and tree sealed.
The recovered transport episode was reported promptly with its contrary
reconnection evidence; this worker made no operational stop or infrastructure
reclassification. Task outcome remains failed and root-cause investigation OPEN.

## Human feedback

The coordinator required urgent positive transport evidence together with
contrary evidence, exact active-target versus stale-target identity, and no
family inference or stop decision from a generic failure label.

## Reusable lesson

A recovered socket closure and a long-silent background target can coexist with
successful active-page work. Attribute the terminal deadline using the actual
critical path and identity, not the loudest preceding transport warning.
