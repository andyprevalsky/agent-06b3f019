---
id: 2026-11-16-browser-recorder-worker-rss-growth-on-playing-video
date: 2026-11-16
title: browser-use's event history kept one whole page state per per-step DOM build, so a playing YouTube video grew the worker ~2 GB and livelocked a 4 GB guest
surface: agents
component: spawn-browser-agent-v3-recording
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/browser_tools/dom_service.py DOMService._browser_state_summary left every completed BrowserStateRequestEvent in browser-use's event_history (last 50 events); each result held a whole BrowserStateSummary. File recorders force a full DOM build every step (_step_observe_needs_dom), so a large re-rendering page added one retained tree per step.
symptoms:
  - "bench.log could not be read after 5 bounded retries -- infrastructure failure"
  - "Polar Odysseys — Stanford CS231N lecture open"
  - "[CdpMux] Worker event loop stalled 230.1s (no CDP traffic was read meanwhile)"
  - "top_memory_processes python 2164"
tags:
  - guest-memory
  - browser-recording
  - youtube
  - worker-rss
  - browser-perf-experiment
sources:
  - fleet run 20261116-041436-1080744 (baseline arm, task polar-odysseys-92cf5ed054aa, owner e69ccaed6cd441458ed10e3f4114c4be, build 1da1a94f95)
  - fleet run 20261116-041446-1089329 (treatment arm, same task, primary 8ed9100c2066d8)
  - agent 8d3cb84d-7f4a-4290-91e1-bc3f08a010d8
repro: agents/tests/blackbox/browser_step_timing.blackbox.py test_per_step_dom_builds_do_not_accumulate_page_states
status: open
---

## Problem

Task polar-odysseys-92cf5ed054aa ("open the Stanford CS231N introduction
lecture on YouTube and start playing it") lost its 4 GB guest in both arms of
the 2026-11-16 browser-perf run, so browser-perf flags are not involved. On the
baseline primary 8715eef0ede238, Fly metrics show MemAvailable falling from
1,668 MB at 04:26 to 52 MB at 04:28. The treatment primary 8ed9100c2066d8 fell
from 1,752 MB to 73 MB between 04:28:20 and 04:30:20.

The captured volume (exact-owner capture, `top_memory_processes` from
c790fa2586) names the holder. The worker python process grew from 198 MB at
04:25:36 to 663 MB at 04:26:21, 1,625 MB at 04:26:51 and 2,164 MB at 04:27:06.
The backend node process stayed near 535 MB and the Playwright driver near
180 MB. The worker had about 50 asyncio tasks, so this is not a task fan-out.
Fast Mode write-through stored only 14 MB, and the network recorder captured
only 4.5 MB of bodies. No googlevideo media body was recorded or stored.

## Diagnosis

A local experiment ran the production `spawn_browser_agent_activity_v3`
through the memory-fixture harness against live YouTube
(`watch?v=vT1JzLTH4G4`, headless Chromium with autoplay allowed). The scripted
model issued plain wait steps every 2 s, and worker RSS was sampled every 2 s:

- Default (recordings on): RSS grew linearly from 172 MB to 547 MB over about 100 s.
- Write-through off: same growth. Network recording off, including provider-exit
  monitoring: same growth. Idle recorder capture loop off
  (`BROWSER_AGENT_RECORDING_INTERVAL_SECONDS=3600`): same growth.
- `BROWSER_AGENT_RECORDINGS=0`: flat at 171–178 MB over 73 s.
- `malloc_trim(0)` at each sample did not reclaim the growth, so the memory is
  live, not allocator fragmentation. A one-frame tracemalloc diff attributed
  only about 60 MB of growth to traced Python objects, so most of the retained
  memory is outside the traced Python heap.

Further bisection on the same live page:
- Marks, observations and frame capture all disabled (with the idle loop off):
  still grows. The recorder's own data is not the holder.
- Per-step full DOM build disabled (`_step_observe_needs_dom` -> False) with
  recordings on: flat at 171–180 MB. The growth is the per-step DOM build that
  a file recorder forces for corpus observations.
- `gc.get_referrers` on the retained DOM roots at step 10 found 10 complete
  `EnhancedDOMTreeNode` roots, one per step, each reached through
  `SerializedDOMState <- BrowserStateSummary <- EventResult.result`. That is
  browser-use's `EventBus.event_history` (`max_history_size=50`), which keeps
  every completed `BrowserStateRequestEvent` with its whole page state.

## Solution

`DOMService._browser_state_summary` now drops completed
`BrowserStateRequestEvent` entries from the bus history after each read,
including failed reads. The caller holds the returned state and the session
caches the latest one, so only redundant copies are released. In-flight events
are untouched, matching browser-use's own history cleanup. Memory now scales
with one page state instead of up to 50 per session; at 10k agents this
removes up to 49 retained DOM trees per browser session.

Proof:
- Owning regression `test_per_step_dom_builds_do_not_accumulate_page_states`
  (domain `browser-step-timing`) uses real Chromium on a large page that
  re-renders every 50 ms. Before the fix the bus held 12 page states
  (2,064 selectors) after 12 reads. After the fix it holds 0. The test passed
  5 consecutive runs, and the full domain passes.
- Live YouTube experiment, production activity, same lecture: worker RSS
  plateaus at about 230 MB, against linear growth to 547 MB before the fix.
- Open gap: the exact benchmark task was not rerun locally
  (`scripts/run-bench --local polar-odysseys-92cf5ed054aa`). The next cloud
  run of that task is the outcome proof.

## Human feedback

None recorded.

## Reusable lesson

When a guest's memory collapses within minutes of opening a media page, compare worker RSS with browser recordings on and off on that live page before blaming the provider or the task.
