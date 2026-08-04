---
id: 2026-07-13-benchmark-run-record-captured-only-root-agent-messages
date: 2026-07-13
title: The cloud benchmark run record captured only the root agent's messages, so a 97-agent fan-out replayed as a lone root
surface: harness
component: cloudbench-fleet
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: cloudbench-run.json — only logs.messages for the ROOT agent was captured, so no sub-agent threads existed to build a tree from
symptoms:
  - a 97-agent for_each fan-out opens in the viewer as a single root agent with no children
  - "/api/agents/tree?busId=<root> returns only the root"
  - sub-agent transcripts unrecoverable after the bench machine is reaped
tags:
  - cloudbench-fleet
  - trace-capture
  - for-each
  - fan-out
  - agent-tree
sources:
  - memory:project_cloudbench_per_bench_fleet_autoscale
repro: agents/benchmarks/logs_tree_test.py
status: fixed
---

## Problem

Opening a cloud benchmark run in the archive viewer showed a lone root agent even
for a 97-agent `for_each` fan-out: no sub-agent threads, therefore no tree. The
fan-out — the entire point of the run — was invisible after the fact, and once the
bench machine was reaped the sub-agent transcripts were gone for good (one such
run's transcripts are permanently unrecoverable; its `realtime_logs` captured only
the root topic).

## Diagnosis

`cloudbench-run.json` captured only the **root** agent's `logs.messages`. The
viewer builds its tree from per-agent threads, so with only the root persisted
there was nothing to nest. This was a capture gap, not a rendering bug: the
backend had the children during the run, but the durable artifact never copied
them down, so the loss became permanent at machine teardown.

## Solution

Added `logs.py:collect_tree_messages(root, tree_agents, get_agent_fn)` — a
deliberately lightweight per-agent capture (messages + parent + goal + status, not
the heavy per-agent backend/worker/realtime payload of `collect_tree_logs`) — wired
into `run_benchmark.py` at the collect point, gated on `tree_agent_count > 1`. It
stores `logs.tree = {agent_id: {...}}` for **every** agent.

`archive_api.load_archive` now indexes all `logs.tree` agents (`_subagent_summary`,
`busId` = root, `parent_agent_id` set, and `tools_in_use: []` which the frontend's
`AgentTreeNode` requires), so `/api/agents/tree?busId=<root>` returns the whole
tree instead of just the root. Frontend contract unchanged:
`useAgentTree` → `fetchTreeState` → `GET /api/agents/tree?busId=`.

Verified: the archive serves 54 nodes (1 root + 53 children) and the frontend DOM
renders 53 fan-out hits. Cemented by `logs_tree_test.py` (4 tests) plus tree cases
in `archive_api_test.py` (+3).

## Human feedback

None recorded.

## Reusable lesson

Capture per-agent threads for the whole tree in the durable run artifact — a
root-only record makes fan-out permanently unreviewable once the machine is reaped.
