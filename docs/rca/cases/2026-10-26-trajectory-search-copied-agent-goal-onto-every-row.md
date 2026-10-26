---
id: 2026-10-26-trajectory-search-copied-agent-goal-onto-every-row
date: 2026-10-26
title: AgentTrajectorySearch copied each agent's goal onto every message row (~2.3 GB) and the fixture's ToolSideEffect read scanned the table
surface: back-end
component: trajectory-search
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/prisma/migrations/20260929120000_agent_trajectory_search sync_agent_trajectory_search() and traceArchiveSearchIndex.ts upsertRowsSql wrote agent.goal/title into every AgentTrajectorySearch row; traceArchiveFixture.ts filtered ToolSideEffect by operationKey contains <agentId> with no usable index"
symptoms:
  - AgentTrajectorySearch agentGoal averages 1.2 KB of a 2.9 KB row (prod TABLESAMPLE 2026-10-26, ~2.28 GB of goal copies)
  - every trajectory row repeated the agent goal
  - fixture ToolSideEffect read cannot seek by operationKey
  - AgentTrajectorySearch_searchText_trgm_idx rebuild does not fit prod free disk
tags:
  - trajectory-search
  - scalability
  - 10k-agents
  - agent-trajectory-search
  - trigram-index
sources:
  - memory:scalability-audit-100-seats-20261024
  - PR #1575
repro: back-end/src/tests/blackbox/archive-run-cost.helper.ts (trajectory goal stored once per agent; legacy goal copies normalize idempotently; fixture tool side effects seek by index)
status: fixed
---

## Problem

Prod `AgentTrajectorySearch` holds about 2.05M rows: a 1.7 GB heap, 5.5 GB of TOAST and 1.7 GB of indexes. A 1% TABLESAMPLE (2026-10-26, read-only) shows `agentGoal` averaging 1,242 of 2,900 bytes per row, about 2.28 GB in total. That is one goal copy per message row, while only tens of thousands of agents exist. Separately, the per-run fixture read `ToolSideEffect` with `operationKey LIKE '%<agentId>%'`, which no index can serve, so it scans the whole table. The table holds ~2k rows today, but the scan is O(table) on every run capture.

## Diagnosis

The trigger `sync_agent_trajectory_search()` and the archive indexer's `upsertRowsSql` both denormalized `Agent.goal`/`title` onto each projected message, and `codeEvents.ts` did the same through `upsertTrajectoryRows`. The only reader is `searchAgentTrajectories`, and no predicate filters on the goal. Storing it once per agent loses nothing.

Archive searches: "advisory lock transaction held storage I/O pinned connection pool" (relative of the lock lane) and "denormalized column copied every row table bloat" (no relevant hit). Novel.

Local repros (`ROSE_USE_SYSTEM_PG=true CONDUCTOR_WORKSPACE_NAME=s10lane CONDUCTOR_PORT=4710 bash back-end/scripts/run-blackbox-tests.sh archive`), before the fix:
- `trajectory goal stored once per agent -- every trajectory row repeated the agent goal`
- `fixture tool side effects seek by index -- ... "Node Type":"Seq Scan" ... "Relation Name":"ToolSideEffect"`

## Solution

- **Per-agent goal/title.** New `AgentTrajectoryAgent` table (agentId PK, userId, goal, title). All three writers (the trigger, the archive indexer and code events) upsert the agent row only when the owner matches and the value changed. Message rows now store `''`/`NULL`.
  - Search joins `g.agentId = s.agentId AND g.userId = s.userId` and prefers a legacy row's own non-empty copy, so output is unchanged.
  - The user-delete trigger also deletes the agent rows.
  - Migration `20261026210002` is cheap DDL plus the trigger rewrite. It contains no full-table backfill: the 2026-09-29 projection migration already showed that a boot-time full scan hits the pooled statement timeout (57014).
- **Legacy copies.** `backfill-agent-trajectory-search.ts --agent-goals` is a primary-key-ordered, bounded, idempotent batch. It upserts the agent row with `DO NOTHING`, then clears a row's copy only when it is identical to the agent row's value, so search output never changes. A divergent legacy copy is kept.
  - Running it on prod is a separate, explicit step.
  - Clearing creates dead TOAST that autovacuum makes reusable inside the table. It does not return disk to the OS; only a table rewrite (`pg_repack` / `VACUUM FULL`) would.
- **ToolSideEffect.** `ToolSideEffect_operationKey_trgm_idx` (GIN trigram, a one-statement concurrent migration). The fixture's read moved to `toolSideEffectsForAgentsSql` (`LIKE` OR-list), which the index serves. The local runtime-SQL hook applies the same index non-concurrently.
- **searchText trigram index: not restored.**
  - Prod disk is 90 GB, with 27.06 GB free (management API, 2026-10-26).
  - `searchText` holds 5.51 GB raw (2.79 GB stored).
  - A local GIN-trigram build over 81 MB of real agent transcript text produced a 69 MB index, a ratio of 0.88, which projects a ~4.9 GB final index.
  - Adding S3's ~16 GB temp observation and ~5 GB of build WAL gives a 21–26 GB peak against 27 GB free. That is not a safe margin, and normalizing `agentGoal` does not return disk to the OS.

At 10,000 agents: one goal row per agent instead of one per message; one extra primary-key lookup per search result row; one batched upsert per indexed batch; the fixture's side-effect read is an index seek.

## Human feedback

The parent required normalizing to one row per run, with a migration and an idempotent backfill, while keeping search_trajectories and planner-memory semantics. The searchText trigram index was to be restored only if it fits prod's free disk with a safe margin: no disk resize. The grain is per agent, because rows carry their own agent's goal, not the root's.

## Reusable lesson

Store per-entity attributes once and join them, keep legacy copies readable until an idempotent bounded backfill proves them redundant, and never put a full-table backfill in a boot-time migration.
