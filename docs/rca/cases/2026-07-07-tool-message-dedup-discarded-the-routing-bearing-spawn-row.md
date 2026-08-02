---
id: 2026-07-07-tool-message-dedup-discarded-the-routing-bearing-spawn-row
date: 2026-07-07
title: TOOL-message dedup matched a bare placeholder and silently discarded the row that carried the sub-agent routing
surface: back-end
component: messages-provider
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/messages.ts:findDuplicateToolMessage — dedup key (agentId, role, text, toolCallId, toolStatus, title) ignores busId/subAgentIds
symptoms:
  - '"Spawning general-purpose agents..." placeholder never replaced by the child tree'
  - single spawn_general_purpose_agent shows no live SubAgentTree at root
  - placeholder only replaced when the FINISHED spawn-tree row arrives
tags:
  - front-end
  - dedup
  - spawn-agent
  - sub-agent-tree
  - realtime
sources:
  - memory:project_spawning_relic_dedup_collision
  - agent 60ac085d-6887-41ba-98de-172eedac3fa3
repro: back-end/src/tests/blackbox/agents.blackbox.ts — "spawn-tree upgrade row is not deduped against bare placeholder"
status: fixed
---

## Problem

For a **single** `spawn_general_purpose_agent` call (not `for_each`), the FE
"Spawning general-purpose agents..." placeholder
(`SubAgentBubble.tsx:72`, branch `isSpawningMessage`) was never replaced by the
child tree: it sat there for the entire child run and was only replaced by the
FINISHED spawn-tree row at the end. Verified end-to-end on prod agent
`60ac085d-6887-41ba-98de-172eedac3fa3`.

## Diagnosis

`findDuplicateToolMessage` dedups TOOL rows by
`(agentId, role, text, toolCallId, toolStatus, title)`. A single spawn posts two
rows under the **same base toolCallId**: first a bare IN_PROGRESS "Spawning
sub-agent" row (`text=""`, no routing metadata), then `finalize_child`
(`agents/domains/spawn_sub_agents/handler.py:265`) yields an IN_PROGRESS row that
carries `busId` + `subAgentIds`. On every field in the dedup key the two are
identical, so dedup returned the bare row and **silently discarded the
routing-bearing one** — no live SubAgentTree row ever persisted at root. Nothing
else filled the gap because at root view the FE filters out all `subAgentId` child
rows (`useMessageFiltering.filterMessagesForSubAgent`) _before_ dedup.

`for_each` is immune because its children use **suffixed** toolCallIds
(`base:idx`) that cannot collide with the base placeholder — which is exactly why
the bug looked FE-specific and single-spawn-specific.

Explicitly ruled out: FE `isForEachPlaceholder` / placeholder-drop in
`useMessageFiltering.ts` (works fine mid-run), `handle_tool_event` coalescing
(does not coalesce), and `_handle_tool_event` (passes `sub_agent_id=None`).

## Solution

`findDuplicateToolMessage` now returns null — i.e. inserts — when the incoming row
introduces `busId`/`subAgentIds` that the candidate lacks: that is a genuine
spawn-tree _upgrade_, not a redundant retry. Idempotency is preserved because a
Temporal retry of the upgrade row matches the already-inserted routing-bearing row
(`orderBy timestamp desc`) and still dedups. Cemented by the blackbox case
"spawn-tree upgrade row is not deduped against bare placeholder" in
`agents.blackbox.ts`.

## Human feedback

None recorded.

## Reusable lesson

A dedup key must include every field that changes a row's meaning — if an update
adds routing or identity metadata, it is an upgrade and must never be collapsed
into the earlier bare row.
