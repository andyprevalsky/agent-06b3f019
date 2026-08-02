---
id: 2026-07-16-subagent-tree-derived-only-from-node-object-streams
date: 2026-07-16
title: The sub-agent tree was derived only from node objects arriving on two decoupled streams, so spawned trees rendered nothing until refresh
surface: front-end
component: agent-tree
classification: our-bug
problem_class: other
first_bad_boundary: "front-end sub-agent tree derivation — a node existed in the tree only once its object arrived via the REST snapshot or the realtime bus"
symptoms:
  - spawned sub-agent trees render nothing until the page is refreshed
  - sub-agent counts are wrong or zero while agent data is still loading
  - spawned agents never appear in the tree even though their IDs are known
tags:
  - front-end
  - sub-agent
  - spawn-agent
  - realtime
  - agent-tree
sources:
  - PR #780
repro: subagent-tree-render.blackbox.tsx
status: fixed
---

## Problem

When an agent spawned sub-agents, the sub-agent tree rendered nothing — no nodes,
no counts — and only appeared after a full page refresh.

## Diagnosis

The tree was derived exclusively from sub-agent _node objects_, and those objects
reach the frontend over two decoupled streams: the REST snapshot and the realtime
bus. Whether any node existed in the derived tree therefore depended on which
stream won the race for that agent, and neither stream is guaranteed to deliver
before the parent renders. The frontend already knew the authoritative
`subAgentIds` from the parent, so it had enough information to render structure
immediately — it just wasn't the source of truth for the derivation. The deeper
cause is deriving existence from payload arrival rather than from the identity
list the parent already carries.

## Solution

Drive the tree off the known `subAgentIds`, rendering a pending "spinning up…"
placeholder per ID that bus or REST data then enriches by `agentId`. That removes
the order-dependent race entirely and keeps counts and structure correct while
data is still loading. Cemented as a front-end blackbox regression
(`subagent-tree-render.blackbox.tsx`) that fails before the fix and passes after.

## Human feedback

None recorded.

## Reusable lesson

Render structure from the identity list you already hold and let payloads enrich
it — deriving existence from whichever of two decoupled streams arrives first is a
race, not a data model.
