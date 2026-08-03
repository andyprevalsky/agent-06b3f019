---
id: 2026-07-03-browser-session-state-survives-task-completion
date: 2026-07-03
title: browser-use session and recorder buffers outlived task completion, tripping the smoke memory ratchet
surface: agents
component: browser-agent
classification: our-bug
problem_class: other
first_bad_boundary: the browser-agent disconnect path never stopped the browser-use DOM session, so CDP/event-bus/watchdog state and per-run recorder buffers were retained after the task finished
symptoms:
  - smoke memory ratchet trips after concurrent browser agents
  - worker RSS keeps growing across browser-agent runs
  - duplicated base64 screenshot frames held in memory during inline recording export
tags:
  - browser-agent
  - memory-leak
  - browser-use
  - recorder
  - smoke-benchmarks
sources:
  - PR #685
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

The smoke suite's memory ratchet started tripping after concurrent browser agents
ran. Memory attributable to a browser task was still held after the task had
completed, so RSS climbed with each run rather than returning to baseline. After
the fix the same gate reported worker RSS +123.1 MB against the 256 MB cap with
`playwright_drivers=0` on a 6/6 smoke pass.

## Diagnosis

Two retention paths kept per-run state alive past completion:

1. On disconnect the browser-use DOM session was never stopped, so its CDP
   connection, event bus, and watchdog state stayed referenced even though the
   remote Steel browser was intentionally left running. "Disconnect" released the
   remote resource but not the local object graph.
2. The dev recorder and network recorder kept per-run buffers after
   persistence/shutdown, and the recorder additionally expanded sparse
   screenshots into video-rate playback frames before inline upload — duplicating
   every base64 frame in memory purely to build the export.

Neither is visible in a single-agent run; the ratchet only fires once several
browser agents overlap, which is why the symptom surfaced as a flaky memory gate
rather than as a leak report.

## Solution

Stop the browser-use DOM session on disconnect so CDP/event-bus/watchdog state is
released without killing the remote Steel browser, and clear browser action,
recorder, network-recorder, and per-run buffers after persistence/shutdown. The
inline dev-recording export now embeds source frames once instead of expanding
them into playback frames, making the export memory-neutral. This removes the
whole class of "resource released remotely but retained locally" leaks in the
browser path, which is what made the leak scale with concurrent agents.

## Human feedback

None recorded.

## Reusable lesson

A memory ratchet that only trips under concurrency usually means per-run state is
freed remotely but still referenced locally — treat "disconnect" as an obligation
to tear down the local session object graph and every per-run buffer, and never
materialize an expanded copy of captured frames just to export them.
