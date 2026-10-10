---
id: 2026-10-09-recorder-idle-screenshot-failures-left-replay-holes-unattributed
date: 2026-10-09
title: Recorder logged nothing about 150s of failed idle screenshots, leaving a replay hole unattributable
surface: agents
component: browser-agent-recorder
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: earliest observed candidate is agents/domains/spawn_browser_agent_v3/recording.py BrowserAgentRecorder.capture on the resumed Steel session 201b22cb (every screenshot failed from 20:34:30 to 20:37:00Z); why the screenshots failed is unproven because idle failures were not recorded
symptoms:
  - Browser agent recording frame capture failed Page.screenshot: Timeout 2500ms exceeded
  - first replay frame is "browser session changed" at ts_ms 150419
  - recording is missing the steps between the auth-assistance resume and the next challenge recovery
  - Browser agent recording saved frame_count 900 source_frame_count 117
tags:
  - browser-recording
  - screenshot-replay
  - steel
  - auth-assistance
  - observability
  - capture-gap
sources:
  - agent 8b4d4592-c5da-4889-8a01-52824db125d1
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_browser_agent_recording_reports_capture_failures_and_frame_gaps
status: open
---

## Problem

In prod agent `8b4d4592`, task `e264ec23` resumed after auth assistance on
refreshed Steel session `201b22cb`. Its recording (part 2, `4efb6ec2…`) has no
frame from recorder start (20:34:30Z) until the challenge-recovery handoff to
Kernel mobile (20:37:00Z). Its first frame is `browser session changed` at
`ts_ms` 150419, so steps 51–52 (click Orders, goto `/orders`) are absent.

Worker logs show one forced-capture warning at 20:34:30.566Z
(`Page.screenshot: Timeout 2500ms exceeded`) and nothing else. Idle captures
(1200 ms budget, exponential backoff to 32 s) fail silently. The close log
reported only `frame_count=900 source_frame_count=117`. During the same window,
the session's `browser.step.phases` showed `observe_state` of 4.3–5.3 s, against
about 0.9 s after the Kernel handoff. That fits a slow Steel renderer, but it
does not prove why screenshots failed.

## Diagnosis

Unresolved. The candidate boundary is screenshot capture on the resumed Steel
page.

Known mechanism from code: per-step frames (`mark`, twice per step) are cut off
after 200 ms (`_bounded_mark_capture`). On a page whose observations took
4–5 s, every per-step frame was therefore dropped by design. That leaves only
the idle loop (1.2 s budget, exponential backoff to 32 s while failing) to
produce frames, and it also failed for 150 s.

What the retained evidence cannot separate about those idle failures:

- A slow renderer exceeded the screenshot budgets.
- `_active_page` selected a hidden or stale tab after the user's Google login.
- The refreshed session's 1920x1080 viewport stalled capture.

Why it is unprovable today: none of these failures was recorded. Cancelled
per-step captures aren't ordinary exceptions, and idle failures were only
logged for forced frames. A hole in a replay therefore looked like an idle
browser.

## Solution

Capture added (observability, not a cause fix). `BrowserAgentRecorder` now
records, in `manifest.json` and the `Browser agent recording saved` log:

- `capture_failure_count`: failed screenshots, including the 7 s close-time
  capture.
- `mark_capture_drop_count`: per-step frames dropped at 200 ms.
- `last_capture_error` (300 chars).
- `longest_frame_gap_ms` and `longest_frame_gap_start_ms`, measured from
  screenshot-capture start (or the Kernel→screenshot handoff) through close.
  The tail is measured before the optional Steel media download.

Regressions:
- `test_browser_agent_recording_reports_capture_failures_and_frame_gaps` drives
  the idle and per-step paths. It failed pre-change with
  `KeyError: 'capture_failure_count'`.
- `test_browser_agent_recording_survives_kernel_to_steel_recovery` asserts that
  Kernel-covered minutes aren't counted as a hole. It fails with gap 300000 if
  the handoff reset is removed.

Both are registered in the deploy-run `spawn-browser-agent-v3` blackbox domain.

Next occurrence: read the close log or archived manifest. Map
`longest_frame_gap_start_ms` onto the recorder's "Browser agent recording
started" time to find the affected steps, then compare `browser.step.phases`
and tab state for those steps before changing screenshot budgets.

10k-agent behavior: a few in-memory scalars per recorder and five extra log
fields at close. No per-frame logging, requests or storage growth.

## Human feedback

None recorded.

## Reusable lesson

Record best-effort capture failures and frame gaps in the artifact they degrade, so a hole in a replay can be attributed without a rerun.
