---
id: 2026-10-26-staged-create-reconcile-flipped-selection-to-loading
date: 2026-10-26
title: Starting an agent hid the query box for ~0.5 s while the created agent's detail reloaded
surface: front-end
component: agent-context useAgentSelection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: useAgentSelection.reconcilePendingAgentCreation → loadAgentDetail set isLoadingAgent=true for an agent whose optimistic projection was already shown, so AgentChatArea.readOnlyNotice replaced the composer with "Loading agent details"
symptoms:
  - query box disappears for half a second when starting an agent
  - composer flickers after submitting a goal
  - Loading agent details. Controls will be available when loading finishes.
tags:
  - optimistic-create
  - composer
  - flicker
  - agent-context
sources:
  - commit a70049483
repro: front-end/src/tests/blackbox/rose-chrome-cleanup.blackbox.tsx ("starting an agent keeps the same query box mounted through creation and detail load")
status: fixed
---

## Problem

After submitting a goal from the new-agent composer, the query box vanished
for about half a second and came back. With GET /api/agents/:id held, the repro
found "Loading agent details. Controls will be available when loading
finishes." rendered in place of the composer on b3679ea7b.

## Diagnosis

handleSendMessage stages an optimistic projection (stagePendingAgentCreation
sets isLoadingAgent=false), POSTs /api/agents, then awaits
reconcilePendingAgentCreation. That called the generic loadAgentDetail, which
sets isLoadingAgent=true for the fetch. AgentChatArea.readOnlyNotice treats
`selectedAgentId && isLoadingAgent` as read-only and renders ReadOnlyNotice
instead of InputArea, unmounting the composer until the detail arrived.

## Solution

loadAgentDetail takes `refreshesStagedAgent`; the reconcile path refreshes the
projected agent in the background without toggling isLoadingAgent. Ordinary
selection still shows loading. No extra requests; same single detail fetch per
created agent.

## Human feedback

None recorded.

## Reusable lesson

A background refresh of an already-rendered (optimistic) entity must not reuse the "selection loading" flag that gates interactive controls.
