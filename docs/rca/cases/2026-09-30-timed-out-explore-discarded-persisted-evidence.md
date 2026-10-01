---
id: 2026-09-30-timed-out-explore-discarded-persisted-evidence
date: 2026-09-30
title: Explore wait expiration discarded completed persisted research
surface: agents
component: spawn-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_agent/handler.py Explore timeout result assembly returned generic success without reading completed task evidence
symptoms:
  - Research finished with the evidence gathered so far.
  - spawn-sub-agents timeout after 483s
  - parallel-tool-calls timeout after 603s
tags:
  - explore-agent
  - cancellation
  - evidence-loss
sources:
  - PR #1063
  - agent 33e26eb6-f50b-4457-97f4-4cefdd1c2ff5
  - agent 683b75da-3354-4cd7-800d-1787fc9c4b19
  - agent 0c1d61f6-6434-4332-bbf5-c0e6b0626f0b
repro: agents/tests/blackbox/spawn_agent.blackbox.py
status: fixed
---

## Problem

The unchanged `spawn-sub-agents` and `parallel-tool-calls` smoke tasks timed out on the old code at 483 and 603 seconds. In the population task, Tokyo research had a completed `web_fetch` with the official `14,303,513` figure, yet the parent received `Research finished with the evidence gathered so far.` after its Explore wait expired. That result contained no answer, so the parent continued research rather than completing its multiplication. The parallel city task also lost completed research on wait expiration.

## Diagnosis

The parent waits 150 seconds for an Explore activity, then sends TRY_CANCEL. Cancellation can finish without heartbeat details, leaving the handler with a generic fallback. Completed `web_search` and `web_fetch` messages were already persisted to the backend under the Explore `taskId`, but `_spawn_explore` did not consult them. The first wrong boundary was timeout result assembly: it treated an empty activity return as a successful research result despite the durable evidence channel. The local replay printed the generic fallback before the fix and a 12,000 character evidence result containing `14,303,513` afterward. The deepest proven cause is a split result contract in which transient cancellation output took precedence over completed persisted tool evidence. Archive searches for `explore agent timeout partial evidence fallback` and `click_coordinates click empty arguments browser` found related evidence-loss cases, but none at this wait-expiry boundary.

## Solution

When the parent wait expires with an empty or generic Explore result, the handler now calls a registered activity that reads the parent agent's persisted messages. It accepts only FINISHED research tools with the same `taskId`, excludes reasoning and concurrent tasks, and caps returned content at 12,000 characters while sharing the budget across observations. That cap can silently clip an observation mid-record, including a URL or fact; the activity currently reads the full agent message history before filtering locally. The `spawn-agent` blackbox suite passed the timeout, isolation, and bounded-content assertions. The unchanged `spawn-sub-agents` and `parallel-tool-calls` tasks passed in 478.2 and 523.8 seconds; the latter rerun crossed the 150 second Explore wait and produced no generic fallback. The same rule protects other long Explore tasks whose cancellation return loses heartbeat details. At 10k agents, only tasks that cross the parent wait budget make one extra backend read, but that read can grow with the agent history even though prompt content is bounded.

## Human feedback

The user requested accessible trajectory links and an approval explanation in `/RCA` format. No deployment approval was given in this exchange.

## Reusable lesson

Recover completed task-scoped research from persisted tool messages when an Explore wait expires without an activity result.
