---
id: 2026-10-28-it11-bu052-navigation-await-unresolved
date: 2026-10-28
title: It11 BU052 navigation awaits stall while the drive-time requirement remains unmet
surface: harness
component: browser-navigation
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Navigation waits time out with responsive post-timeout CDP probes; the underlying await and a safe repair remain unproven
symptoms:
  - open_new_tab and goto report unknown timeout source
  - Verifier rejects the 15-minute drive qualification
  - Browser activity ends at its existing deadline
sources:
  - commit 66eb9ccc4e39237bdd99b08f697180c7097a39bd
  - agent 05307823-efdc-44b9-b78d-9c66cf70b7bd
tags:
  - r27
  - it11
  - polar-bu-052
repro: none-recorded; original navigation chronology and verifier evidence only
status: open
---

## Problem

Status OPEN; no repair proposed. Source66eb9ccc4e39237bdd99b08f697180c7097a39bd,
root05307823-efdc-44b9-b78d-9c66cf70b7bd, taskff55d19f-7ef8-5660-a133-e0fa6ea1b6bd.
Original archive116ca04471d71d9716415a12fd113bdd5b10418976c3f9d23aa06ac064dffd0c
(129013437 bytes), normal manifestdf308c3a63d9fc217bd6377967f2fe653e891f780319e25ad7d8536a0bd73e7d;
run87eae232411855ceb2c67316f13aeae01b3376863efc2ffe8430016b484d01dd,
workere54c51553eb65783ccf2c293100b51b426fda9ca6aea7d378888105830a7b0f0.
All normal members verified. Original FAILED/infraFALSE and clocks unchanged.

The task requires a shelter within a15-minute drive of Easton Town Center,
a foster program and three dogs under six with profile links. This is not R24's
pre-dispatch schema error: this run executes many actual browser actions.

## Diagnosis

Observed source-bound chronology:
- open_new_tab begins20:37:06.660Z at iteration37. It fails after recovery
 20:42:54.151Z. Probe20:42:47.899053Z reports renderer/browser responsive
 (5755ms/76ms), not frozen. Timeout source is recorded unknown.
- Intermediate verifier at20:49:07.815Z rejects completion: shelter/profile
 evidence exists, but candidate drive is21min at current/4:30PM conditions and
 17min at8PM. It returns score50% and explicitly says task incomplete. No
 evidence-loss assertion: original583169-byte verifier request is retained,
 SHA82a3508eb0955b4f4b131f372a5ed745d8e177b02fd55b05edcbd25c594c2506;
 it includes the15-minute goal and conflicting17/21-minute observations.
- Further site/map navigation continues. Final goto starts21:05:26.042Z,
 requesting a Google Maps directions URL while current page is Bing Maps.
- Probe21:11:08.940262Z reports renderer/browser responsive (7127ms/9ms).
 Recovery brings page front and presses Escape; timeout error21:11:15.338Z
 remains unknown-source. Current page still Bing, displaying16/19/20min routes.
 This does not prove navigation was never attempted or identify the blocked
 request; it identifies the observed page and unresolved awaited operation.
- read_browser_state at21:12:21.027Z follows recovery. Outer50min activity
 timeout follows21:12:33.743916Z, root fails21:12:35.581686Z. Last iteration
 telemetry is78/100. browser_action_step102 is a distinct history counter,
 not proof that the100-iteration cap was breached or caused the failure.
- Cancellation then records Agent paused by user and provider session cleanup
 HTTP500. This message follows the deadline; it is not evidence of a user
 initiating the original failure. Fleet native teardown receipt remains a
 separate resource-release proof from browser-session cleanup status.

Owning paths: service_actions.py4099+ prepares credentials, dispatches
NavigateToUrlEvent, awaits event and event_result, then navigation readiness.
handler.py12155+ bounds actions, classifies timeouts and invokes generic
recovery. Unknown source is selected when the caught TimeoutError does not
carry an explicit evaluate deadline and the action task is not cancelled; it
cannot distinguish every upstream await from the event log alone. config.py58+
derives50minutes for100steps; outermanager13685+ owns that deadline.

Archive searches inspected prior Tilion keyboard/input-pipeline case and
Steel session-lifetime mismatch. Their Solution/Human feedback were read.
This run's goto/open-tab await is not a demonstrated Input-event overlap, and
its current provider is Tilion, not a proven Steel lifetime violation. Neither
case establishes recurrence or authorizes a timeout/provider/retry change.

First observed transport problems are two unknown-source navigation waits;
first demonstrated task constraint deficit is the drive-time mismatch retained
in the verifier input. How much either caused ultimate failure is not isolated.
## Solution

A repair requires exact await-level causal evidence (credential prep, event
ack/result or readiness), followed by an unchanged owning replay. The current
packet does not establish that granularity or a safe general repair. Increasing
limits, forcing a qualifying shelter, or treating nearby distances as15minutes
would change behavior without proof. No speculative tests or runtime candidate.
No newcalls/provider/DB/browser/model/images; tokensUNMETERED.


## Human feedback

Parent required original15-minute criterion preserved, no timeout/provider/model
patch, no inference from the responsive probe to a specific original await.
BU055 rebind and BU059 finalization are separate investigations.

## Reusable lesson

A post-timeout responsive renderer does not identify which earlier navigation
await stalled. Preserve the unfulfilled task constraint alongside the transport
symptom rather than treating a deadline change as task completion.
