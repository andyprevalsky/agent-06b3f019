---
id: 2026-10-20-kernel-replay-stop400-cause-unrecorded
date: 2026-10-20
title: Kernel replay stop HTTP 400 recovers the recording but lacks cause evidence
surface: agents
component: browser recording / Kernel replay finalization
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: "POST /browsers/{browser_id}/replays/{replay_id}/stop returns HTTP 400; the retained exception lacks provider error body and same-replay stop chronology"
symptoms:
  - "Kernel replay stop failed; reading persisted replay anyway"
  - "400 Bad Request"
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
repro: none-recorded
status: open
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

## Solution

Not implemented; keep this cause gap OPEN. Capture provider error JSON/request
ID, stop initiator, earlier stop/delete events and browser-session lifecycle for
the same replay before choosing a fix. Preserve successful persisted recordings
and original identities. No runtime or provider-account change was made;
10k-agent impact of a future repair is unmeasured.

## Human feedback

None recorded.

## Reusable lesson

Distinguish successful persisted recording recovery from a successful provider stop request, and capture the error body before diagnosing a stop HTTP 400.
