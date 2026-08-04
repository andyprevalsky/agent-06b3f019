---
id: 2026-07-28-remote-cdp-roundtrip-inside-click-hold
date: 2026-07-28
title: A remote-browser round trip between mousedown and mouseup turned every click into a ~600ms long-press, scored as a programmatic submit
surface: agents
component: browser-agent
classification: our-bug
problem_class: other
first_bad_boundary: click_at_coords — the release-drift mouse.move was dispatched BETWEEN down() and up()
symptoms:
  - "browser-biometrics-webdecoy failing FCaptcha 0.183 > ratchet 0.163"
  - '"Form submitted programmatically" bot signal at detection.go:1061'
  - score byte-identical across five runs whose mouse behaviour differed wildly
tags:
  - browser-agent
  - anti-detect
  - fcaptcha
  - cdp
  - latency
sources:
  - commit 0996a2277
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::click_press_has_no_round_trip_inside_hold
status: fixed
---

## Problem

`browser-biometrics-webdecoy` failed with FCaptcha score 0.183 against a ratchet
of 0.163, failing since 2026-07-26 (predating the branch). The score was
byte-identical across five runs whose mouse behaviour differed wildly — the first
clue that it was never behavioural.

## Diagnosis

Reproduced 0.182960 to 5 decimal places against FCaptcha's own Go scorer over the
captured request payload. The entire gap over the ratchet was ONE binary rule:
`detection.go:1061` "Form submitted programmatically" → bot 0.8 × 0.85 = 0.68 ×
weight 0.13 = **+0.0884**.

`client/fcaptcha.js:1077-1092` classifies a submit as `programmatic_click` unless a
mousedown exists within `RECENT_GESTURE_MS = 500`. Ours was 628ms.
`click_at_coords` dispatched the release-drift `mouse.move` BETWEEN `down()` and
`up()`. Every mouse call is a round trip to a REMOTE browser, so that network
latency landed **inside the press**: we sampled an ~85ms human dwell and emitted
621.5ms. This made every product click a ~600ms long-press, not just this
benchmark.

## Solution

Drift **after** mouseup. Motor noise is preserved (the last move is not the down
position, so the click is not pixel-perfect) while the press stays inside the
sampled distribution. Score 0.18296 → 0.09456; the exact unchanged benchmark
passes. The ratchet was deliberately left at 0.163 — no threshold relaxation.
Repro `click_press_has_no_round_trip_inside_hold` fails before and passes after
with the assertion unchanged; outcome gate
`scripts/run-bench --local browser-biometrics-webdecoy` → 1/1 passed at 0.09456.

Enabling evidence that came out of the same RCA: `BrowserNetworkRecorder` now
captures bounded request bodies. Every FCaptcha signal lives in the request and
`/api/score` returns a bare number — without that capture the RCA would have
shipped the wrong (proof-of-work) answer.

## Human feedback

None recorded.

## Reusable lesson

When synthesizing human input timing against a REMOTE browser, never let a
round-trip sit inside a sampled interval — emit intermediate motion outside the
press, or the transport latency becomes the behavioural signal.
