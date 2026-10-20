---
id: 2026-10-20-linkedin-sync-agent-routed-through-chat-router
date: 2026-10-20
title: LinkedIn connect spawned a chat agent whose router died on the long export goal, and "Connecting" lived only in React state
surface: cross
component: integrations-linkedin-sync
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/integrations/api.ts createLinkedInSyncAgentApi — created the fully specified export task without start_phase, so it entered chat mode and the chat router had to restate it; sync state was never persisted server-side
symptoms:
  - "Failed to parse router response as JSON"
  - "Sorry — I couldn't generate a response just now. Please try again."
  - LinkedIn connect says "Agent spawned" but the agent never runs (status ACTIVE, temporal_workflow_id null)
  - "[ChatStructuredRetry] Transient structured-output miss; regenerate budget exhausted callSite=chat_router kind=parse"
tags:
  - integrations
  - linkedin
  - chat-router
  - truncation
sources:
  - agent 1df3cbe4-9417-4e44-8f4e-4aaa625f7a1d
repro: front-end/src/tests/blackbox/integrations-linkedin.blackbox.tsx + back-end/src/tests/blackbox/integrations.linkedin-sync-1.cases.ts
status: fixed
---

## Problem

Clicking LinkedIn → Connect toasted "Agent spawned", but the agent never ran,
and "Connecting your data…" vanished on refresh. Prod agent `1df3cbe4`
(02:26:56Z) had two messages: the 1,650-char export goal, then
`Sorry — I couldn't generate a response just now` (`chat_handler_failure`).
It had no `temporal_workflow_id`. Render logged `ChatStructuredRetry … kind=parse`
twice, then `Chat handler error: Failed to parse router response as JSON`.
`GET /api/agents` listed the agent at index 0, so it was in the list; it was
inert because it never started. "Connecting…" was `useState` in
`useMessagesSync`, so a reload always dropped it.

## Diagnosis

`createLinkedInSyncAgentApi` posted the goal with no `start_phase` (plus
`depth: 1` and a hard-coded `MAC_APP` source), so the backend started the
agent in chat mode. The chat router must restate the request into `goal`
under the Cerebras route's `max_tokens: 1024`. Local replay sent the same goal
(bearer token replaced by a same-length placeholder) through `callRouterLlm`
on prod's `rose-fast`/`direct-cerebras`. It failed 5/5 with
`finish_reason: "length"`: the restatement (including ~715 chars of token) hit
the cap before `mode`, which is emitted last. Sending the goal as a text
attachment failed 4/5, because text files are inlined into the same turn.
Prod captured only 200 chars of router output, so prod truncation is inferred
from the unchanged local replay.

The integration chose the wrong entry point. A fully specified, machine-built
task has nothing for a chat router to decide, yet it was sent through the
path that must restate it.

## Solution

- The FE creates the export directly as a cloud agent with
  `start_phase: 'execute'` through the normal `createAgent` client (client
  source, default budget, no `depth` hack). The backend starts the Temporal
  workflow synchronously, and a start failure marks the agent FAILED. The
  goal text is unchanged.
- `POST /api/integrations/linkedin/sync` records the agent on the existing
  `Integration` row (`linkedin`, `SYNCING`, `config.syncAgentId`).
- `GET /api/integrations` reads the row as `SYNC_FAILED` once the agent can
  no longer upload. That covers a terminal status, an archived agent, or a
  chat agent still lacking a workflow 2 minutes after creation.
- A second start while one can still upload returns 409.
- The FE derives "Connecting…" from that row and re-reads it every 15s while
  syncing.
- 10k agents: one indexed agent lookup per user, and only while their
  LinkedIn row is SYNCING.

Open sibling: any long chat message can still truncate the router's restated
`goal`. A router-level fix (emit `mode` before `goal`, recover a cut-off
restatement from the request verbatim; 0/5 → 5/5 locally) is parked in
`.context/patches/chat-router-truncated-goal-salvage.patch`. It awaits a
separate decision.

Golden reference: `claude-code-src/cli.js:4177` treats `max_tokens`
truncation as recoverable rather than terminal. That is relevant to the
parked router sibling. The LinkedIn fix itself removes the router from a path
that never needed routing.

## Human feedback

- "it should spawn a normal agent the normal way, and use the prompt we decided
  on". The goal text is unchanged.
- On long inputs: "it should attach files not raw text them if needed (but y
  we need files)".
- Rejected routing the LinkedIn request through the chat router at all: "NO,
  it should directly spawn a cloud agent not route through the router at all".
  The router-level fix was pulled out of this change.
- Declined archiving the dead agent `1df3cbe4` ("Leave it").

## Reusable lesson

Start machine-built, fully specified agent tasks directly as cloud agents
(`start_phase`), never through the chat router, and persist integration sync
state server-side rather than in component state.
