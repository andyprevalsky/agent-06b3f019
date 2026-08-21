---
id: 2026-08-18-browser-recording-mark-file-not-found
date: 2026-08-18
title: Browser recording mark raised FileNotFoundError and aborted Place-order after checkout click succeeded
surface: agents
component: spawn_browser_agent_v3-recording
classification: our-bug
problem_class: other
first_bad_boundary: BrowserAgentRecorder.capture — write_bytes to frames/ without mkdir/soft-fail so a wiped /tmp scratch aborts the agent
symptoms:
  - Task Failed browser_error_type FileNotFoundError
  - browser_error_message No such file or directory .../rose-browser-agent-recordings/.../frames/frame_XXXXX.jpg
  - Place order click FINISHED then Browser automation failed
  - purchaseSpend stayed HELD (df0e02ef...) on agent-payment-production-purchase
  - No BrowserChallengeRecovery logs in the failure window (never reached Stripe recovery)
tags:
  - browser-recording
  - steel
  - production-purchase
  - file-not-found
sources:
  - agent b276d6e7-a9bd-4155-833e-764a99ae4c0f
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_agent_recording_mark_survives_wiped_frames_dir
status: open
---

## Problem

After Steel city-drop (#983) and preferSteel skip-kernel_direct (#985),
`agent-payment-production-purchase` still failed. Agent minted the $1 card,
filled the form, clicked Place order (FINISHED), then immediately
`Task Failed` / `Browser automation failed`. Purchase remained HELD.

## Diagnosis

Seven browser tasks on agent `b276d6e7-…` failed with the same metadata:

- `browser_error_type`: `FileNotFoundError`
- `browser_error_message`: `[Errno 2] No such file or directory: '/tmp/rose-browser-agent-recordings/<agent>/<task>/frames/frame_0001N.jpg'`
- `browser_last_action`: `click` / `input_text`
- `browser_current_url`: still `test_payment` (Stripe challenge recovery never started)

Local repro: create `BrowserAgentRecorder`, capture once, `shutil.rmtree(output_dir)`,
then `await mark(...)` → identical `FileNotFoundError` on `frame_path.write_bytes`.

Critical path: successful Place-order `execute_action` → save FINISHED →
`await browser_recorder.mark(...)` (finish phase) → `capture()` →
`write_bytes` with missing parent dir → exception escapes the action try/except
→ outer handler → Task Failed.

Recording is diagnostic-only; the agent contract already says provider transitions
must not break on recording failures, but `capture()` only soft-failed screenshot
errors — not frame writes after a mid-run scratch wipe (prod
`BROWSER_AGENT_RECORDINGS_CLEANUP_LOCAL` / `/tmp` loss).

## Solution

1. `capture()` recreates `frames_dir` before write and soft-fails `OSError`.
2. `mark()` suppresses unexpected capture escapes so Place order cannot abort.
3. Cemented by `test_browser_agent_recording_mark_survives_wiped_frames_dir`.

10k-agent behavior: O(1) mkdir/write per frame; no shared fan-in; failures stay
local warnings.

## Human feedback

User `alowed` standing authorization to keep driving purchase green after #985.

## Reusable lesson

Best-effort recording paths must soft-fail every filesystem step (mkdir + write),
not only the screenshot call — a missing scratch dir must never fail the tool.
