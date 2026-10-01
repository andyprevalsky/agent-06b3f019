---
id: 2026-08-03-clamshell-sleep-invalidated-live-benchmark-timeout
date: 2026-08-03
title: Mac clamshell sleep suspended the local live benchmark and inflated a 900-second timeout to 1759 seconds
surface: harness
component: local-benchmark-runner
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: benchmark execution environment — a live irreversible task ran on a laptop allowed to enter clamshell sleep
symptoms:
  - benchmark reports Timeout after 1759s with dynamic cap 900s
  - every local worker log has the same fifteen-minute gap
  - pmset records Clamshell Sleep during the benchmark interval
tags:
  - benchmark
  - clamshell-sleep
  - ecommerce
  - local-runner
  - timeout
sources:
  - agent 43ffeb05-a5e4-4073-9293-0c1c2870ee77
  - agent 1aa492a0-8865-493a-804f-a7fe5a3347a7
  - agent 3e067004-c801-4710-a589-070958c1e08f
repro: macOS pmset sleep log aligned with the benchmark and all twelve local worker logs
status: mitigated
---

## Problem

The live DoorDash rerun reported a timeout after 1759 seconds even though its
dynamic cap was 900 seconds. During the run, all twelve local worker logs stopped
for the same fifteen-minute interval. macOS `pmset` recorded entry into
Clamshell Sleep at the start of that gap and wake at its end.

## Diagnosis

The benchmark did not consume 1759 seconds of active agent time. Closing the
laptop suspended the local controller and worker processes, including monotonic
timeout progress and Temporal heartbeats. On wake, the elapsed wall clock had
crossed the harness cap and the worker reported heartbeat fallout. This differs
from the archived CDP-freeze incident: there, a renderer blocked an active
worker; here, the entire host stopped running.

### Recurrence on 2026-09-30: predeploy browser and chat smoke

The unchanged `browser-smoke` task in
`agents/benchmarks/runs/20261001_012954_spawn-sub-agents,browser-biometrics-webdecoy,parallel-tool-calls,claude-code-agent,browser-smoke,chat-mode.json`
failed for agent `1aa492a0-8865-493a-804f-a7fe5a3347a7` with
`Timeout after 217s (dynamic cap=182s)` and status `ACTIVE`. The browser had
already opened `https://example.com`, read its tab title, and evaluated the
HTML `<title>` as `Example Domain` by 2026-10-01 01:17:08 UTC. Its completion
verifier began at 01:17:17 UTC.

The macOS `pmset -g log` for this host records `Entering Sleep state due to
'Clamshell Sleep'` at 2026-09-30 18:17:23 PDT (01:17:23 UTC), lasting 161
seconds, and `DarkWake` at 18:20:04 PDT. All local worker logs stop after
01:17:17 UTC and resume at 01:20:04 UTC with `event loop stalled`; the backend
log has the same gap. After wake, the browser file-list call returned
`ReadTimeout` and the verifier's model fallback reported DNS resolution errors
(`nodename nor servname provided, or not known`). The sleep began after the
browser had found the answer and crossed the task's dynamic cap while the
host was suspended. This is the same first-bad boundary as the original case,
not evidence that the browser needed a larger cap.

The run's `0.0%` repeatable prompt-cache ratchet is secondary: the root agent
made one `execute_loop` LLM call before waiting in `spawn_browser_agent`, so
the same-run `cache_sequence_id` metric had no repeated root call to count.
The separate browser-use cache report showed four calls with 93–98% hits.
The unfinished task cannot establish its completed-run cache outcome.

The original case's mitigation did not prevent this recurrence because the
local predeploy runner still ran on a laptop that could enter clamshell sleep.
For this reversible smoke task, rerun the exact task on an open, awake host
and verify that the run interval has no sleep event before treating its timeout
and cache metrics as valid. `caffeinate` alone does not prevent clamshell sleep.

The same run's `chat-mode` task, agent
`3e067004-c801-4710-a589-070958c1e08f`, also failed with `Timeout after
52s (dynamic cap=37s)`. The chat answer had already been persisted at
2026-09-30 18:17:00.985 PDT, after about three seconds of active work. The
benchmark awaited archive start before polling from 18:17:01 to 18:21:15,
across the clamshell sleep and post-wake R2 DNS retries. Its first GET at
18:21:15.662 found the answer; macOS then entered another 47-second
`Maintenance Sleep` at 18:21:19. The next GET at 18:22:07.151 reached the
benchmark's wall-clock deadline check before its chat-answer check, so it
reported the timeout. This task also needs an unchanged awake-host rerun;
the response latency measured on this sleeping host is invalid.

## Solution

The affected run is classified as invalid timeout evidence rather than repaired
by increasing the benchmark timeout. A second live rerun was prohibited because
the first run had already placed a real $35.55 order, so repeating it could
duplicate an irreversible purchase. Future local live benchmark runs must keep
the host awake and open or use a non-sleeping execution host; `caffeinate` alone
is not treated as reliable protection from clamshell sleep.

## Human feedback

None recorded.

## Reusable lesson

Do not interpret elapsed wall time across whole-host suspension as active benchmark latency, and never rerun an irreversible task merely to replace invalid timing evidence.
