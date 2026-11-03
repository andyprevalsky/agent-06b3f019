---
id: 2026-09-30-explore-wait-cancel-drops-saved-tool-evidence
date: 2026-09-30
title: Explore wait cancellation discarded saved research and retriggered child searches
surface: agents
component: domains/spawn_agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_agent/handler.py SpawnAgentManager._spawn_explore returned a completed placeholder after TRY_CANCEL without reading task-scoped saved tool messages
symptoms:
  - 'Timeout after 484s (dynamic cap=480s)'
  - 'Research finished with the evidence gathered so far.'
  - 'Cancelling explore agent after parent wait budget'
tags:
  - explore
  - spawn-agent
  - cancellation
  - benchmark
sources:
  - agent 55d1f287-d420-4849-bd07-3563d4a0e32a
  - agent 7ac99299-6dec-4791-b7d1-203555a029a5
  - agent 98b8b162-d5d7-4d5e-9e09-d5f13cb73b7d
  - fleet run 1790826809-51355-95332
repro: agents/tests/blackbox/spawn_agent.blackbox.py test_handler_explore_cancel_grace_wraps_up_without_awaiting_handle and test_persisted_explore_evidence_is_task_scoped
status: open
---

## Problem

The local `/deploy` smoke task `spawn-sub-agents` reported `ACTIVE` and failed its
480-second dynamic cap after 484 seconds (the saved run row records 521 seconds
including runner overhead). Its root agent ultimately completed with the correct
Tokyo and NYC estimates at 04:12:16 UTC, 545 seconds after creation. The two
general-purpose children were spawned in parallel, yet both performed redundant
explore research after receiving an empty placeholder from their first explore.

## Diagnosis

The first NYC explore saved a `web_search` message containing the Census Bureau's
`8,584,629` at 04:04:30 UTC and a corroborating NYC planning document at
04:05:51. At 04:06:47, the parent hit `LIVE_EXPLORE_PARENT_WAIT=150s` and
cancelled the activity. Its tool result was instead `Research finished with the
evidence gathered so far.` at 04:06:48; the child then spawned another explore
at 04:06:57. Tokyo's first explore followed the same cancel/placeholder path at
04:06:40 and then launched two further searches. The final Tokyo verification
returned at 04:11:11. These timestamps are in the saved isolated worker log and
task-scoped messages captured before the stack was torn down.

The wait limit protects parent runs from a hung explore activity and is not the
first bad boundary. `_spawn_explore` uses `TRY_CANCEL`; when cancellation resolves
without a heartbeat payload, it fabricates a success-shaped placeholder and
does not read the evidence already saved by `save_explore_message`. That violates
the spawn tool's research-result contract and gives the parent no useful result.
The underlying class is loss of durable child output at an asynchronous cancel
handoff. The activity owns live local tool results, while the workflow must use
a new activity to read persisted messages deterministically. Deleting the wait
limit would reintroduce an unbounded parent stall, and changing prompts would
leave this output handoff broken for other research topics.

## Solution

`fetch_persisted_explore_evidence_activity` now fetches only messages created
since that explore started, selects completed evidence-tool outputs by `taskId`,
and returns the full research result to the parent. Tool-manager posts carry
`fullToolEvidence=true` to distinguish their complete payloads from the
500-character `explore_post_message` UI copies; during worker cutover, legacy
complete posts longer than that UI cap also qualify. Legacy complete results
of 500 characters or fewer cannot be distinguished from UI copies and are
excluded during cutover. Error-shaped results are excluded. `wait_for` receives
the complete selected results for its condition check. `_spawn_explore` uses it only when
the 150-second cancel path would otherwise return the generic placeholder. No
saved evidence produces an explicit error instead of a fake success. A Temporal
`workflow.patched` marker preserves replay of histories that already crossed
the old placeholder path. The activity is registered in `agents/worker.py`.

The saved run's real NYC messages had `taskId`, `toolName`, `toolStatus`, and
full tool-manager text (7–9 KB for the first searches). Replaying those messages
up to the original cancellation through the recovery helper selected ten
results, retained `8,584,629`, and excluded Tokyo data. The
backend `GET /api/agents/:id?since=` route filters `Message.timestamp > since`.
At 10k agents the change adds one bounded backend read only per timed-out
explore, scoped by start time; ordinary explores make no extra call. Focused
spawn-agent blackbox tests passed. A fresh local smoke run is still required to
establish the end-to-end timing outcome.

## Human feedback

None recorded.

## Reusable lesson

Recover a cancelled child's persisted, task-scoped tool evidence before returning its result to the parent.
