---
id: 2026-09-09-planner-memory-archive-tool-alias-leaked-to-planner
date: 2026-09-09
title: Archive-internal spawn_agent labels leaked into planner-facing memories
surface: agents
component: planner-memory-transcript
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/planner_memory/transcript.py _compact_call
symptoms:
  - "ungrounded tool 'spawn_explore_agent'"
  - "spawn_agent start_url=https://www.amctheatres.com/"
  - "generic spawn_agent survived critical-path parsing"
tags:
  - planner-memory
  - tool-alias
  - transcript-compaction
  - planner-tools
sources:
  - plan:agents/benchmarks/runs/memory-compressor-20260909T205752Z.json
  - plan:agents/benchmarks/runs/memory-compressor-20260909T210116Z.json
repro: agents/tests/blackbox/planner_memory.blackbox.py
status: fixed
---

## Problem

Archived assistant calls use the orchestration label `spawn_agent` plus a
per-call `type`, while planner-visible tools are concrete names such as
`spawn_browser_agent` and `spawn_explore_agent`. Compression could therefore
store the internal alias or infer one concrete tool globally from a mixed-tool
path. After the evaluator was taught to inspect entry-point tools, the focused
real-trace command `cd agents && python3
benchmarks/run_memory_compressor_bench.py --only
e2681fe6-09a7-440a-9bd1-8bded1590cd4,9ba001b4-12bd-4513-970c-9b238c434e7a
--concurrency 2` failed 0/2 in
`memory-compressor-20260909T205752Z.json` with `ungrounded tool
'spawn_explore_agent'`.

The critical path was `archive assistant/tool rows -> build_transcript ->
trim/bound rows -> compressor payload -> parse_critical_path -> injected tool
names`. The first wrong representation was produced while compacting each row.
Archive searches for `spawn_agent start_url`, `ungrounded tool`, and
`archive tool alias planner` found no prior matching cause; this was novel.

## Diagnosis

Alias resolution happened after compaction and used the set of tools remaining
in the bounded transcript. That loses two facts: which `type` belonged to each
assistant call, and which tool-result metadata described a particular call.
Head/tail bounding could also discard the only row that established a valid
tool. The deepest owned cause was treating a per-event protocol mapping as a
global record heuristic.

## Solution

`_compact_call` now maps every assistant `spawn_agent` call from its own exact
`type`. Tool rows map from their own `plannedToolName` or `agentType`, and the
transcript records its complete tool inventory before head/tail bounding. The
compressor is explicitly forbidden to emit archive-internal `spawn_agent`, and
`parse_critical_path` rejects it as defense in depth; there is no global
single-alias rewrite.

The permanent blackbox covers mixed browser/explore calls, tool-row metadata,
pre-bound inventory, and generic-label rejection. The identical focused command
then passed 2/2 in `memory-compressor-20260909T210116Z.json`, including the
113-message large trace. This repair is deterministic preprocessing and adds no
LLM or backend request.

## Human feedback

None recorded.

## Reusable lesson

Resolve protocol aliases at the individual event that carries their discriminator, before lossy transcript bounding.
