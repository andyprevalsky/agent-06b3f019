---
id: 2026-07-07-foreach-aggregate-subagentids-clobbered-by-busid-group
date: 2026-07-07
title: The for_each aggregate chip's own subAgentIds were overwritten by the busId group, collapsing a 50-agent tree to 2 on completion
surface: front-end
component: terminal-message-filtering
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "front-end/src/features/terminal-component-group/components/useMessageFiltering.ts:buildMergedMessages (~313-326) — the generic busId-group step overwrites subAgentIds after mergeForEachTerminalMessage set them"
symptoms:
  - first agent tree spawn of ~100 agents randomly disappears from the UI
  - "spawn tree shows 50 children DURING the run and 2 after completion"
  - "server /api/tool-usage/tree still reports agent_count: 107"
tags:
  - front-end
  - for-each
  - spawn-tree
  - message-merge
  - dedup
sources:
  - memory:project_foreach_tree_vanish_fe_merge
repro: none-recorded
status: open
---

## Problem

On DEMO run `60ac085d` (personal-brand, fully fast-cache replayed, 107 agents,
PAUSED) the first ~100-agent spawn tree "randomly disappeared" from the UI at
22:20:58. The backend was intact: 0 nondeterminism events fleet-wide, `for_each`
fired exactly once (1 START 22:10:08 / 1 FINISH 22:20:58), and
`/api/tool-usage/tree` still reported `agent_count: 107`. Replaying the real
messages through the FE merge reproduced it — 50 children DURING the run, 2 AFTER
completion.

## Diagnosis

This is a frontend-only merge bug, not backend determinism or re-keying. All spawn
trees share ONE `busId` (the root agent id) and `spawnGroupKey` groups by `busId`.
The `for_each` terminal (FINISHED) row carries no `busId`/`subAgentIds`;
`mergeForEachTerminalMessage` correctly reconstructs its 50 child ids and sets
`forEachAggregate: true` — but the generic busId-group step then OVERWRITES
`subAgentIds` with `group.ids`. Once the terminal arrives, the 50 suffixed children
(`callId=base:idx`) are excluded from that group (skipIndices via terminalGroups),
leaving only later DAG-task spawns (bare callIds) in `group.ids`, so the aggregate
collapses 50 → 2. The deeper smell: grouping by root `busId` conflates unrelated
spawn clusters, since multiple DAG spawn tasks live under one bus.

## Solution

Recorded fix direction, not yet landed: in `buildMergedMessages`, when
`msg.metadata.forEachAggregate === true`, preserve the message's OWN `subAgentIds`
instead of clobbering them with the busId group's ids, and give the aggregate a
distinct cache key (e.g. the terminal base callId) so it cannot collide on `busId`.
Regression-test home:
`front-end/src/tests/blackbox/use-message-filtering.blackbox.ts`.

## Human feedback

None recorded.

## Reusable lesson

When a UI element "vanishes", verify the server tree count first — if the backend
still reports the children, the bug is a merge step overwriting a message's own
reconstructed ids with a coarser group key.
