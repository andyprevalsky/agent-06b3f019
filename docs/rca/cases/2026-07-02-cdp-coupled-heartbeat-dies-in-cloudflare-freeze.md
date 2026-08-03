---
id: 2026-07-02-cdp-coupled-heartbeat-dies-in-cloudflare-freeze
date: 2026-07-02
title: Browser-agent heartbeat was coupled to CDP, so a ~90s Cloudflare renderer freeze killed the activity
surface: agents
component: browser-agent
classification: our-bug
problem_class: other
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py — the Temporal activity heartbeat was emitted from the CDP-driven loop, which the frozen renderer blocked
symptoms:
  - browser agent dies at the 120s activity heartbeat timeout
  - "~90s Cloudflare renderer freeze during a bot challenge"
  - slow or stalling prod agent with no further browser steps
tags:
  - browser-agent
  - steel
  - cloudflare
  - temporal
  - heartbeat
sources:
  - PR #681
  - memory:project_steel_cloudflare_freeze
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

This was the original "slow/stalling prod agent" report. A browser agent hitting
a Cloudflare challenge froze for roughly 90 seconds and then died at the 120s
Temporal activity heartbeat timeout, ending the run with no further browser
steps.

## Diagnosis

The Cloudflare Turnstile proof-of-work pins the renderer, so CDP stops
responding for the duration of the challenge. Because the activity's heartbeat
was emitted from the same CDP-driven loop, a frozen renderer meant _no heartbeat
was sent at all_ — the agent looked dead to Temporal even though the session was
healthy and the challenge was progressing normally. The nominal 120s budget was
not the defect; the coupling of liveness reporting to the very subsystem that
was expected to block was.

## Solution

Decoupled the heartbeat into an independent background task that continues to
report liveness while CDP is unresponsive, so the agent survives the freeze
window instead of being reaped. Landed in
`agents/domains/spawn_browser_agent_v3/handler.py` with screenshot-replay
capture made resilient to an unresponsive renderer. The same decoupling protects
every other blocking-renderer case (heavy page loads, long JS execution), not
just Cloudflare. Shipped alongside optional dedicated-IP support in
`back-end/src/providers/steel/session.ts` (gated by
`BROWSER_AGENT_STEEL_DEDICATED_IP_ENABLED`, off by default) and a new
`browser-toast-nopa-write-lock` benchmark plus a Cloudflare load-time smoke gate.

## Human feedback

None recorded.

## Reusable lesson

Liveness signals must never be emitted from the subsystem they are reporting on
— if an activity heartbeat can be blocked by the work it monitors, a legitimate
stall becomes an unrecoverable timeout.
