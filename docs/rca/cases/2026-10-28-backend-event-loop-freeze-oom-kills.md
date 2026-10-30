---
id: 2026-10-28-backend-event-loop-freeze-oom-kills
date: 2026-10-28
title: Prod backend froze its event loop for 40-70 s while RSS climbed to 16 GiB and was OOM-killed six times; the single instance made each one a full outage
surface: back-end
component: runtime-memory
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: Unproven. In each kill the main event loop stopped (every main-thread log line ends) during an in-progress chat turn, and RSS rose from about 1 GB to 16 GiB within about 30 s with no V8 heap-limit error, which points to off-heap growth.
symptoms:
  - "oomKilled": { "memoryLimit": "16Gi" }
  - Instance srv-d3jga77diees73cgrvk0 restarted
  - 502 responseBytes=223158 for every in-flight request
  - Initial broadcast delivery rejected reason capacity
tags:
  - oom
  - render
  - event-loop
  - observability
  - single-instance
sources:
  - task S24 prod backend OOM kills
  - memory:scalability-audit-100-seats-20261024
repro: back-end/src/tests/unit/event-loop-stall-watchdog.test.ts
status: open
---

## Problem

Render OOM-killed the prod backend (`srv-d3jga77diees73cgrvk0`, `pro_max`, one
instance, 16 GiB limit) six times: 2026-09-18 20:58Z, 10-01 21:58Z, 10-14
21:45Z, 10-22 18:51Z, 10-27 04:49Z and 10-27 21:09Z. The backend runs a single
instance, so every kill is a full API outage: every in-flight request fails and
nothing is served until the process restarts.

Measured from Render request logs (statusCode label, per minute):

- 10-27 04:49Z: the event loop froze at about 04:48:35 and serving resumed at
  about 04:49:20. That is about 45 s, with 75 requests 502 and 9 client
  timeouts (499).
- 10-27 21:09Z: the loop froze at 21:08:20 and 2xx resumed at 21:09:31. That is
  about 71 s, with 83 requests 502 and 11 client timeouts. Render's
  `server_available` at 21:23:16 was the next deploy, not the recovery. The
  following 404 surge (189 at 21:11) was a semantic test polling an agent it had
  already deleted.

Both 10-27 kills came 7-10 minutes after a deploy, while the post-deploy prod
semantic run exercised the chat `web_search` lifecycle for its test user.

## Diagnosis

Shared signature across the kills with retained logs (10-14, 10-22, both 10-27):

- Memory was flat at about 1-1.7 GB, then rose to 16 GiB within one or two
  30 s metric buckets (bucket averages 4.3 G and 8.7 G) at about one CPU core.
- Main-thread logging stopped 40-70 s before each kill. Even `OPTIONS`
  preflights hung, so the loop itself was blocked.
- A chat turn was mid-flight each time: after `[ChatHandler] Executing web
searches` (10-22), at the router's after-search decision (10-27 04:48), after
  the generator finished (10-27 21:08), and mid generator stream (10-14). Same-
  millisecond bursts of stream deltas and `delivery rejected, reason: capacity`
  lines are a consequence of the stopped drain, not its cause (committed
  delivery only landed on 10-13, after the first kills).
- No `FATAL ERROR ... heap limit` line, so V8 did not hit its own heap limit.
  The growth was most likely off-heap (Buffers, native allocations).

Ruled out with local measurements:

- Benchmark Hub final uploads: a real 70 MB `test-mass-agent-run-0` bundle
  costs about +0.7 GB RSS and a 0.8 s stall. Four concurrent uploads against
  prod's 9,100-run catalog cost about +1.4 GB and a 2.3 s stall. That is real
  load, but nowhere near 16 GiB.
- Realtime broadcast backlog: replaying 40-200 stream deltas plus committed
  INSERTs showed no lag and no heap growth.
- Trace-archive run fixtures for the affected user read under 1 KB per table.

- Benchmark Hub upload floods: the 10-18 11:15-11:21Z ramp (3.4 to 6.4 GB,
  no kill) coincided with 200-450 live plus up to 450 final Hub uploads and up
  to 660 run reads per minute. The kill windows saw 0-7 uploads per minute, so
  Hub traffic explains that near miss, not the kills.
- V8 heap exhaustion: prod sets no `NODE_OPTIONS`, so the heap limit is about
  4 GB. Reaching 16 GiB without a heap-limit error requires off-heap memory.
- Logging backlog: queued stdout writes of distinct strings stay on the V8
  heap, so they would hit the heap limit first.

S31 (2026-10-28): the watchdog has seen no stall since it went live at 05:38Z,
and there was no kill. Peak instance memory was 1.81 GB. The cause is still
unreproduced. The watchdog now records what the next capture needs to
classify the growth:

- the main isolate's `process.memoryUsage()`, read from the paused frame
  (`heapUsed` against `external`/`arrayBuffers`);
- anonymous RSS (`RssAnon`);
- CPU per thread since the stall began, which tells the main thread apart from
  libuv, zlib or GC threads;
- a fresh stack and memory sample every 5 s for the whole stall, not just the
  first frame.

If the main thread is stuck inside native code and never reaches a pause
point, `capture_error: pause timed out` is reported together with high main-
thread CPU and rising `anon_mb`. That points at a native builtin such as zlib,
`JSON`/`Buffer` concat or sharp, on the main thread.

The process stops writing logs the moment the loop blocks, so no existing log
can name the code that ran. This is the owned gap: the backend had no
observation path that survives a blocked event loop.

## Solution

`providers/eventLoopStallWatchdog.ts`, started in `bootstrap.ts`. The main
thread stamps a heartbeat into a `SharedArrayBuffer`; a worker thread treats a
heartbeat older than 5 s as a stall. It then attaches to the main isolate
(`inspector.Session.connectToMainThread`), pauses it to capture the top call
frames, resumes, and writes one JSON line directly to fd 2, plus RSS every 5 s
while the stall lasts and a line when it ends. The next freeze names the code
that is running and shows the memory curve. `EVENT_LOOP_WATCHDOG_DISABLED=1`
turns it off.

Regression: `back-end/src/tests/unit/event-loop-stall-watchdog.test.ts` (backend
unit suite in `/deploy` coverage). A child process blocks its loop in a named
function while allocating Buffers. The test requires the stall record to name
that frame and report RSS, the RSS curve to continue, and the end of the stall
to be recorded. It passed five consecutive runs.

The case stays open until a watchdog record from prod identifies the code and
that cause is reproduced and fixed. Scaling to two instances (Andy's decision)
would turn a kill into a partial outage instead of a full one; it does not fix
the cause.

Scale: one idle worker thread and one 250 ms timer per process, independent of
agent count. The isolate is paused only during an existing stall.

## Human feedback

None recorded.

## Reusable lesson

A runaway that blocks the event loop also silences every log that could
explain it. Keep a watchdog thread that names the blocking code and records
memory from outside the loop.
