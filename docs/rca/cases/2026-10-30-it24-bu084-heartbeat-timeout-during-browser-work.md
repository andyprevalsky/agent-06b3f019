---
id: 2026-10-30-it24-bu084-heartbeat-timeout-during-browser-work
date: 2026-10-30
title: BU084 browser activity ends with an unlocalized heartbeat timeout
surface: agents
component: browser-activity-heartbeat
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Temporal reports the browser activity heartbeat timeout while the worker continues browser work; the last heartbeat send and acknowledgement are not captured
symptoms:
  - "activity Heartbeat timeout"
  - "coroutine '_ActivityWorker._heartbeat_async' was never awaited"
  - "CDP session attachment timed out"
tags:
  - polar
  - it24
  - bu084
  - heartbeat
  - temporal
sources:
  - commit 8136eb6bb1d32d98553a70ca5f98278b590bee81
  - agent c1a0f92e-2049-4798-a244-4f5b0bcb9470
  - plan:.context/r97/proof.json
repro: none-recorded
status: open
---

## Problem

Original It24 BU084r2/r002-j0014 asks for a virtual conference identified by a
former foreign minister and a MENA ministry. NativeFAILED1198.7s/progress1 and
canonicalFAILED/producerinfraFALSE are separate from the absent semantic
judge result. The fatal error is activity Heartbeat timeout. The original job
finished02:10:19.660990Z before the later campaign operational stop; it is not
classified as an induced cancellation here.

## Diagnosis

Archivefdf540efd75d8bd72e6a61659eeae3216e400e73cf1becb11926e116307b0ddc and
all seven original members match manifest
685d21eaf769f88c202fa08576083b56ed5861c49f89d60881812bba078f5c7c.
Run SHA6ef5d8796555195a61ae04fb3248d1ff7de2bbeaf5f0f9bb0bc4904926e7219c
binds source8136eb6bb1d32d98553a70ca5f98278b590bee81, patch none.

The worker records a goto action timeout at02:03:51.585152Z with stall
classification renderer error, browser ok, verdict unknown. The renderer
error is CDP session attachment timed out. This is not positive proof of
renderer blockage or whole-browser disconnection. Work subsequently continues:
model responses complete02:04:46.628291Z and02:05:02.965419Z. A
read_browser_state action starts at02:05:04.066Z; no completed observation is
recorded before the fatal heartbeat timeout.

At02:06:58.229245Z, worker38988 records Browser manager failed, an ActivityError
caused by Temporal TimeoutError: activity Heartbeat timeout. The manager's
await activity_handle frame is the delivered terminal stack; it does not
identify the activity's precise suspended await. The subsequent root failure
and paused-by-user message do not establish a user-initiated original cause.
No declared evaluator result exists.

Source8136 registers BrowserActivityHeartbeat before browser work, with a
15-second keepalive and120-second heartbeat timeout. Its daemon thread tries
the activity heartbeat, then schedules an activity-loop callback on RuntimeError
because the pinned SDK uses asyncio.create_task for asynchronous activities.
The source includes that fallback already. Original worker lines127,801 and
32233 show an unawaited _ActivityWorker._heartbeat_async coroutine warning at
the fallback scheduling line. Such a warning demonstrates the off-thread SDK
call was unsuitable; it does not demonstrate that the fallback failed to
schedule or that a heartbeat was acknowledged by Temporal.

Worker loop activity continues through the fatal interval. The largest
recorded loop-lag sample in this file is4.64s; near the terminal interval it
is at most2.79s before the timeout. These samples do not prove120seconds of
loop starvation, nor do they exhaustively prove the event loop was healthy.
The normal packet lacks the final successful heartbeat send/ack timestamps,
pump dispatch/registration history and bridge queue outcome needed to locate
the loss. No socket-close cause is substituted for this missing evidence.

After this trace, the July/September heartbeat-coupling case was read. It
explains the current thread pump and SDK loop fallback, but cannot prove that
this occurrence repeats the older missing-keepalive mechanism. The prior
BU084 codec failure is likewise not inferred from a shared task identifier;
this packet's terminal exception is a heartbeat timeout, not that codec error.

## Solution

OPEN; no safe deterministic general repair established. Do not raise the
heartbeat timeout, add retries, replace the existing pump, or treat the runtime
warning alone as a causal regression. A useful next original evidence packet
would bind the activity token's last heartbeat send, bridge acknowledgement,
registration/unregistration and loop dispatch around the timeout. No such
receipt was fabricated or collected through new calls.

The original cleanup remains positive: Tilion session
sess_c3d0eb3a097949ffb4d1f9146e2bacd7 DELETE204, root deleted and tree sealed.
No task/grade/infra flag was changed, no runtime patch or speculative test was
added, and no model/native/DB/browser replay was made. This case preserves the
original failure independently of the campaign's later transport stop.

## Human feedback

The coordinator required exact native-versus-evaluator separation and an
independent first-bad investigation, with no older BU084 family assumption.
The investigation must stop at a concrete missing-observability boundary when
an actual causal repair is not supported.

## Reusable lesson

A heartbeat timeout names a missed liveness contract, not its cause. Existing
fallback code and warning messages must be checked against actual send and
acknowledgement evidence before changing timeout or recovery policy.
