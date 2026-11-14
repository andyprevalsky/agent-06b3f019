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

## R114 — It27 BU091 two original deadline failures (2026-10-30)

These are separately observed deadline episodes, not proof that the earlier
BU087 route-research incident shares an underlying cause. Both executed
98c8668b47b5e9b2fd2b807c2f083f2e46a04733/patchnone and asked for the first and
last names of the gunner who first spotted enemy aircraft during a WWII raid
by two aircraft named for the same US state. Both generated the requested
required `gunner_first_name` and `gunner_last_name` fields. No captured verifier
invocation or declared semantic judge was found in either full original worker
log; this does not establish that no uncaptured work occurred.

For r1/r001-j0001, root2367e1c0-983a-4d33-9f3f-c9057943dacf, archive
557f408d45d51b3b663e1397da6c8c811880fc838339432f7745a923bf88bacb and all seven
original members match manifest
16db3a8430bc5a99faa3402a9cc5fa949a5d1c9aaff2754fc92e22af32ca8c54.
Run4d930f869610f7756f7704d10b10a3e529ea13274c4683a0d9ab6bf2bd7ffea0 and
worker945da0f1fe53962b31d4d2e6eb83cfa9da2f90cb96a9c03f0dd0e5d00b208069
record nativeFAILED3007.6s/progress1/producerinfraFALSE. Worker83286 records the
manager's ActivityError/StartToClose timeout at07:38:54.297277Z. A socket close
around07:35:30 is followed by explicit successful reconnect at07:35:32.356011Z
(after2.3s), so it is not evidence of an unrecovered whole-browser connection.
The last persisted action is read_browser_state at iteration64/actionstep117;
original raw browser dumps extend only through step41. Action count is not a
model-turn count, and the dump boundary is a capture limit.

For r2/r002-j0011, rootd071a167-178c-460d-9511-7d426928598f, archive
6a69d5a06e0161a2f127f2ae3a9f78a5bdefd5603b2ab7de3d472746eddc3758 and all seven
original members match manifest
da36d96a1d783864db3dc9bcbd37cd850c0f0614f7846205ff4bf791624eb128.
Run2a901b4e75747aed82c173c224e53c399f76d972510b16b32f996456fe0a5252 and
worker7ced6f82c07563386a646268fc0f5c463bb397153742ff024973df16ac6ff07a
record nativeFAILED3029.7s/progress1/producerinfraFALSE. Worker61201 records
StartToClose at07:38:58.769929Z. The last captured actor request is step68,
evaluating document.body.innerText during continued searches for the aircraft,
Texas and its gunner. No captured accepted completion or smaller fatal native
operation establishes why the original deadline was reached.

The two archive searches covered StartToClose/BU091 and deadline/completion;
this case's Solution and Human feedback were read. Keep the original deadline,
all failed grades and the independent cleanup receipts. R1's exact session
sess_993d7048ba4e4f1698e9eabdebf41307 and r2's
sess_c3d0eb1deb5e400fba44d726c9796db8 each have normal DELETE204/root sealing
with no cleanup error. No operational infrastructure promotion, timeout change,
model replay or speculative runtime repair was made. The missing proof is the
critical-path contribution of waits/research and uncaptured terminal context,
not merely the existence of a deadline or a recovered socket warning.
