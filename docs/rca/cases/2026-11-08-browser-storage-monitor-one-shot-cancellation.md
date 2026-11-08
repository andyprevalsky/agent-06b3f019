---
id: 2026-11-08-browser-storage-monitor-one-shot-cancellation
date: 2026-11-08
title: Storage monitor cancellation race could block native browser shutdown
surface: agents
component: dom-service-disconnect
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: browser disconnect awaited a periodic storage monitor whose one-shot cancellation could be consumed by a completed RPC
symptoms:
  - "Checkpoint CDP release timed out"
  - "StorageStateWatchdog.on_BrowserStopEvent() has been running for >15s"
  - "Browser Session Cleanup Failed"
tags:
  - browser
  - cancellation
  - storage-state
  - shutdown
sources:
  - PR #1831
  - commit 66adafe0bb9707fbc0568eb298773e1483402327
  - agent 62578edf-4888-48c2-86fa-d6a08c2b269a
  - plan:.context/production-mixed-mode-evidence/storage-watchdog-native-pair.json
repro: agents/tests/blackbox/storage_watchdog_cleanup.blackbox.py
status: fixed
---

## Problem

The actual sandbox new-user smoke completed checkout but failed the ordered
contract on browser agent ERROR. Native worker logs recorded the storage
watchdog BrowserStopEvent handler blocked for over15 seconds, then the unchanged
20-second checkpoint CDP release deadline expired. Later cleanup completed;
all13 campaign resources had verified native teardown. The completed sandbox
payment was CLEARED and funding CONSUMED, card CLOSED0; it is neither an exact
release stall nor evidence of financial recovery of the three protected duties.
The native smoke FAIL remains preserved.

## Diagnosis

Gate: UNKNOWN for attribution of this native incident; the deployment owner
retains the assigned repair. Native logs locate the blocked watchdog handler,
but do not capture its inner RPC/cancellation schedule. Precise lost-cancellation
causality for that original incident remains unproven. Do not infer provider
death or treat this timeout as an external-provider exception.

Two archive searches and the October28 owned-CDP pause checkpoint and November7
backing-host failure cases were read. They require confirmed transport closure
and distinguish actual provider-death evidence from a timeout. Neither warrants
weakening the 20-second deadline or skipping storage persistence.

The pinned watchdog cancels its periodic task once, then awaits it. Python3.11
wait_for can consume that cancellation if its child RPC completes concurrently;
the unfenced periodic loop then returns to its next30-second sleep. The local
mechanism reproduced first with the real watchdog and DOM service, then through
real BrowserSession.stop and its event bus. A controlled fake cookie RPC reply
wins immediately before native stop's cancellation; the pre-fix unchanged test
fails at20seconds with a reply observed while cancelling()==1. This establishes
a real owned shutdown defect consistent with the observed blocked boundary,
not a captured inner trace from the original guest.

## Solution

DOM disconnect first quiesces the exact session-owned periodic storage task,
redelivering cancellation until it acknowledges completion. This removes the
background writer before native stop dispatches the final SaveStorageStateEvent.
The monitor reference is captured once; no unrelated task, provider process or
browser is cancelled. A50ms acknowledgement poll is inside the unchanged caller
20-second bound; it adds no network request, provider retry, shared lock or
unbounded successful cleanup claim. At10k agents it uses only each disconnect's
own task, with no cross-agent serialization. Native keep_alive and mux
close/wait_closed confirmation remain unchanged.

The permanent native blackbox uses the real session/event bus/watchdog and a
loopback WebSocket provider: before exit1 (2passes/1failure), after exit0
(3passes), with identical final test bytes and command. A pending RPC stops
without a reply. A deliberately cancellation-resistant writer still cannot
claim shutdown or release at the native deadline. Final storage-save dispatch
precedes BrowserStopEvent, and success requires the real WebSocket close
handshake. Receipt hashes, native logs and the initial controlled stack are
preserved privately. No production money or paid provider was used locally.
Golden reference: existing owned-CDP checkpoint contract; no prompt or trajectory
change, no assertion, timeout, concurrency or coverage relaxation.

## Human feedback

The user prohibits retrying the original production payment task, reminting any
of the three protected allocations, and substituting a release-stall or external
waiver for its actual mixed-mode ERROR. Those duties remain UNVERIFIED and are
independent of this sandbox browser cleanup failure.

## Reusable lesson

Quiesce a session's periodic storage writer before final persistence and require acknowledged task and transport closure within the existing shutdown deadline.
