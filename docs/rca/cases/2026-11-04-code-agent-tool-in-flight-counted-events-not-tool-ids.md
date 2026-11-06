---
id: 2026-11-04-code-agent-tool-in-flight-counted-events-not-tool-ids
date: 2026-11-04
title: Code-agent idle pause never fired because in-flight tools were counted per event instead of per tool id
surface: agents
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py _run_agentic_loop on_event in_flight_tool_count (+1 per tool_use event, -1 per tool_result event) against ws-server event shapes that repeat tool_use per call and merge parallel results
symptoms:
  - code session never idle-pauses after its first tool call
  - hung Claude Code CLI stays attached forever with no "Code session idle; pausing it (resumable)"
  - every tool_use_id emitted twice (partial + final)
  - Codex shell command idle-paused mid-run
tags:
  - idle-pause
  - tool-accounting
  - code-agent
  - e2b
  - codex
  - multi-day
sources:
  - commit 28a7bfc99 (base on which the repro fails; fix on branch fix/code-agent-multiday-t1-ws-transport)
  - task T1 of the parent RCA "Review long-running rose code agents" (devbox 211c7467), finding T1 #2
  - agent 36672b38 (code session af0f1889), live E2B event observer on base 28a7bfc99
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_run_agentic_loop_finished_real_tool_calls_then_hung_cli_is_paused (+ test_run_agentic_loop_codex_item_lifecycle_tracks_tools_in_flight)
status: fixed
---

## Problem

After its first tool call a code session could never idle-pause, so a hung CLI
stayed attached (and its sandbox billed) indefinitely. Live evidence from the
parent: a read-only observer on a real Claude Code E2B session (code session
af0f1889) saw 25 events after ~15 s, tool_use=6, tool_result=3, every
tool_use_id emitted twice; the production accounting gave in_flight=3 after 3
completed tools. Regression on base 28a7bfc99 (real ws-server, scripted CLI
emitting one tool call then two parallel calls, all finished, then hanging):
`finished tools kept the hung CLI attached` (15 s timeout, idle window 1 s).
Codex regression: `finished Codex tools kept a quiet session attached`.

## Diagnosis

`on_event` added 1 per `tool_use` event and subtracted 1 per `tool_result`
event. The event contract does not have one of each per call:

- Claude ws-server emits `tool_use` at `content_block_start` (partial) and
  again from the assistant envelope, and merges the results of parallel calls
  into one `tool_result` with `tool_results[]`.
- Codex ws-server emits `tool_use` on item/started and item/completed for MCP
  calls and web search (web search never gets a `tool_result`); shell commands
  and file changes are `command`/`file_change` items, which were not counted at
  all, so a long Codex command could be idle-paused mid-run.

The count therefore only climbed for Claude (and ignored real Codex work), and
`CODE_SESSION_IDLE_PAUSE_S` never fired. The existing test used a single
synthetic non-partial tool_use, so it matched the counter, not the contract.

## Solution

`ToolsInFlight` tracks tools by identity: Claude `tool_use_id` (idempotent over
partial/final), each id in a `tool_result`/`tool_results[]` finishes its call,
Codex items are in flight from `status: started` to `status: completed`
(including commands and file changes), and a finished turn (`result`,
`turn_ended`, `final`) clears the set. Id-less tool_use events from older
sandboxes keep the previous counter behaviour. Golden reference: Claude Code
tracks in-progress tools as a Set keyed by tool_use_id and deletes each
tool_result block's id (`claude-code-src/src/hooks/useRemoteSession.ts:250-263`,
`src/services/tools/toolOrchestration.ts:127,183`); the fix converges on it.

10k-agent behavior: per-activity in-memory set bounded by the tools concurrently
running in that one session; no shared state, no extra I/O.

Pending: on the branch; the parent integrates it into the combined deploy.

## Human feedback

None recorded.

## Reusable lesson

Track in-flight work by the identity the event contract carries (tool_use_id, item_id), never by counting events whose multiplicity the producer does not promise.
