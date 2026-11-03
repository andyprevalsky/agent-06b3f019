---
id: 2026-10-20-kernel-replay-stop400-cause-unrecorded
date: 2026-10-20
title: Kernel replay stop HTTP 400 because teardown closed the browser session before stopping the replay
surface: agents
component: browser recording / Kernel replay finalization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/handler.py _close_browser_with_cleanup_receipt pauses/closes the Kernel session before the background FE finalizer stops the replay"
symptoms:
  - "Kernel replay stop failed; reading persisted replay anyway"
  - "400 Bad Request"
  - "POST /browsers/<id>/replays/<id>/stop 400 on every browser teardown"
tags:
  - kernel
  - browser-recording
  - replay-stop
  - observability
sources:
  - agent fad65dad-5d2c-4202-b1e4-37a4dd96101e
  - benchmark run 2023ea15-dba3-4455-bc3e-4d104d3e4d96
  - task 163eacf4-6d36-55f6-8d3f-f9b62f0d2e4e
  - task a03fa64e-cdd4-5bf0-a955-f9ab8c420681
  - agent fad65dad-5d2c-4202-b1e4-37a4dd96101e evidence .context/rca-915ab997/resume-incidental-triage.txt
  - agent ffa591f5-f218-4f38-8c06-fd8ffd98e3c5 (descend-full69-20261023 R8 r001-j0010; 44 copies)
  - fleet run 20261023-230227-25433
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_kernel_replay_is_stopped_before_the_browser_session_is_closed
status: fixed
---

## Problem

Two recording-stop requests returned HTTP 400 during the passing payment task:
04:13:13.732412 UTC for replay r9gq00sq8gaxga239pcd22bv and
04:15:05.137351 UTC for replay fon9wuhgfs8suph0951kgxoz. The recording fallback
and subsequent attached-recording publication succeeded. This is not a failed
payment task or a recording repair delivered by the receipt patch.

## Diagnosis

Original isolated worker lines 3283 and 7206 retain the stop failures; later
lines 3295/3298 and 7224/7227 record persisted replay recovery and message save.
`recording.py:1342-1399` tolerates stop failure and re-lists the same replay ID
or retains its start-time URL. A later "stopped" log does not prove HTTP stop
succeeded. The evidence publisher independently passed its recording gate.

Literal and behavioral archive searches found the recording-publication drain
case; its Solution and Human feedback were read. Its slow-publication cause is
not established here. Without error bodies and same-replay stop/session
chronology, already-stopped, duplicate cleanup, deletion, expiry and provider
failure remain unproved alternatives. No local cause reproduction was run.

### 2026-10-24 recurrence (descend-full69 R8), with the cause

Worker and backend chronology for one replay (agent ffa591f5, session
bebl4d7hcsnshxbd3bmu676d, replay i7ysfrukavs2ee7j2kpgoea3) rules out a double
stop and a wrong id. There is exactly one stop request. Backend: `Pausing
browser session` at 23:17:05.125Z, then `BROWSER_SESSION status=CLOSED` and
`POST /api/browser-session/close -> 200` at 23:17:09.247Z. Worker: `Browser
cleanup started in background` at 23:17:09.605Z, then the stop 400 at
23:17:09.6Z. Every terminal path calls `_close_browser_with_cleanup_receipt`
(pause+close) before `_schedule_browser_cleanup` runs
`_finalize_kernel_replay_for_fe`, so the stop always reaches a paused or closed
browser. The same-replay list read still returned the persisted URL, which is
why the recording survived.

Local repro: a handler-level activity run uses a fake Kernel that 400s stop once
the session is closed. On the old revision it recorded `CLOSE` before `stop
(closed)`. The fix records one stop while the session is open, then `CLOSE`, and
the recording message is still saved.

## Solution

Fixed 2026-10-24: `_close_browser_with_cleanup_receipt` first calls
`_stop_kernel_replay_before_session_close`. This stops the native replay while
the browser is open, then pauses and closes it, following the user rule to save
then tear down. `stop_kernel_replay()` is idempotent, so the FE finalizer's
later call returns the finalized URL without a second request. A stop that still
fails now logs the status code, Kernel's response body and the replay id. At
10k agents this adds no requests: the same single stop moves earlier.

Original note (2026-10-20): Not implemented; keep this cause gap OPEN. Capture provider error JSON/request
ID, stop initiator, earlier stop/delete events and browser-session lifecycle for
the same replay before choosing a fix. Preserve successful persisted recordings
and original identities. No runtime or provider-account change was made;
10k-agent impact of a future repair is unmeasured.

## Human feedback

None recorded. Standing user rule applied: save the recording, then tear down on FINISHED.

## Reusable lesson

Distinguish successful persisted recording recovery from a successful provider stop request, and capture the error body before diagnosing a stop HTTP 400.
