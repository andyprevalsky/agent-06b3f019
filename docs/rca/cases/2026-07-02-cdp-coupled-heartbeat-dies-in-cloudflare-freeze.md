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
  - "activity Heartbeat timeout"
  - "Browser automation failed"
  - concurrent browser agents die in the same second
tags:
  - browser-agent
  - steel
  - cloudflare
  - temporal
  - heartbeat
  - event-loop-starvation
sources:
  - PR #681
  - memory:project_steel_cloudflare_freeze
  - agent 37b7bb31-8db5-4c7e-806d-d31b7891106f
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_activity_heartbeat_survives_event_loop_block
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

## Recurrence: 2026-09-09

Agent `37b7bb31-8db5-4c7e-806d-d31b7891106f` spawned 3 then 6 concurrent
Replicate/ChatGPT browsers. Each wave died in the same second with
`activity Heartbeat timeout` (03:35:16, 03:41:07, 03:43:53) after 121s–7min
of useful work — gotos and `read_browser_state` were still finishing. The
2026-07-02 asyncio keepalive was still on the browser event loop. That is
the owned incomplete guardrail: liveness still shared the loop it
monitors. Same-second deaths across mixed-age activities are also
consistent with worker death or Temporal disconnect; ClickHouse/Fly logs
were unreachable from this environment, so those siblings stay unexcluded.
The local repro proves the asyncio keepalive is silent while the loop is
blocked (`time.sleep`); the thread pump keeps beating. Timeout was not
raised.

Local repro (asyncio keepalive silent during `time.sleep`; thread pump
keeps beating):

```bash
cd agents && source venv/bin/activate
PYTHONPATH=".:tests/blackbox" python -c "
import asyncio, importlib.util
from pathlib import Path
p=Path('tests/blackbox/spawn_browser_agent_v3.blackbox.py')
spec=importlib.util.spec_from_file_location('bb', p)
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
async def main():
    await m.test_asyncio_browser_heartbeat_starves_when_event_loop_blocked()
    await m.test_browser_activity_heartbeat_survives_event_loop_block()
    print('ok')
asyncio.run(main())
"
```

Fix: process-local thread pump in
`agents/domains/spawn_browser_agent_v3/activity_heartbeat.py` (one daemon
thread, register/unregister per activity). 10k-agent behavior: still one
thread per worker and the same per-activity heartbeat RPCs; no extra
thread per browser.

Review cycle 1: `temporalio` 1.18.1 `activity.heartbeat` from the daemon
thread raises `RuntimeError` (`asyncio.create_task()` with no running
loop). The first pump swallowed that and the keepalive was silent again.
`_dispatch` now tries `ctx.run(beat)` on the thread (so injected
`heartbeat_fn` still works during `time.sleep`); on `RuntimeError` it
replays via `loop.call_soon_threadsafe` onto the loop captured at
`register()`. Cemented in
`test_browser_activity_heartbeat_replays_runtimeerror_on_activity_loop`.
