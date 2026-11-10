---
id: 2026-11-10-chat-model-boundaries-omit-saved-profile
date: 2026-11-10
title: Chat model requests omit the saved user profile that SMS and main agents already receive
surface: back-end
component: chat-model-context
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: handleChatMessage loads transcript and project context but does not load or forward the user profile when Router and Generator construct their system messages
symptoms:
  - "whats the cheapest easiest laundromat near me"
  - "I need your zip code or address to pull up nearby options"
  - "missing stored profile fields"
tags:
  - chat
  - user-profile
  - missing-context
  - grep
sources:
  - agent e388d514-2aaf-4c96-b620-083e4c9c3e9e
  - commit 5fedf69abbe2cc5a1a8794d5f0a07f186ff8eae5
  - commit 1f1e176a4
  - commit d9a154486
repro: back-end/src/tests/blackbox/chat-profile-context.blackbox.ts
status: open
---

## Problem

The MAC_APP chat created at 2026-10-28T20:39:10Z asked exactly
`whats the cheapest easiest laundromat near me`. Its three persisted messages
are the user request, assistant reasoning that location is unavailable, and a
`send_message_to_user` result asking for a ZIP/address. There were no search
calls and no Temporal workflow. Runtime evidence was retrieved read-only into
private `.context/rca-e388d514/runtime.json` and `messages.log`.

The current profile has address fields, but its observed `updatedAt` is later
than this turn. Those reads do **not** prove the exact profile values at the
incident time. The full original production LLM request is not archived:
`fetch-agent-llm-dumps.ts` and `publish_evidence_links.py` both returned
`No archived LLM base calls`. This diagnosis proves the deterministic missing
input/capability boundaries, not the original model's internal reasoning or a
replayed recommendation outcome.

Archive searches included `chat location user profile`, `grep chat explore
search`, `I need your zip code or address`, and `chat user profile missing`.
This is a relative of the clock-context and subagent-context chat cases, not a
recurrence of their first-bad boundaries. The recipient-only address case
concerns incomplete stored data; this case reproduces with every profile
field populated.

## Diagnosis

Critical path: stored User profile and Message history -> handleChatMessage ->
Router/Generator system-message assembly -> provider request -> visible reply.
Python `helpers/user_profile.py` already renders personal/delivery sections;
SMS `formatUserContext` already renders these selected User fields. Chat only
loaded Message rows, and its model builders deliberately ignore persisted
SYSTEM rows, so adding a SYSTEM row cannot repair the profile-delivery boundary.

The unchanged permanent blackbox seeds two isolated users and captures the
actual serialized provider requests from the real chat handler. On original
source and again on current-main baseline `1f1e176a4`, six direct/search
Router/Generator requests omit all ten populated fixture profile fields:
`AssertionError ... 6 !== 0`. On the fixed source it passes, verifies the fresh
address on the next turn, preserves SYSTEM filtering, prevents profile
persistence, and excludes the foreign user's profile. Provider responses are
scripted branch controls; this is context-boundary proof, not model-quality proof.

Commands (from back-end, both database URLs explicitly local):

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_rca_e388d514 \
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/victoria_rca_e388d514 \
node --import tsx src/tests/blackbox/chat-profile-context.blackbox.ts
```

The normal `src/tests/blackbox/run.ts` discovers this domain; backend coverage
runs it in the normal deploy backend gate. Typical local duration is 3.2 s.
The latest merge preserves the existing project-context path and its single
lookup; its exact system-message regression now also asserts the profile.

The original chat schema also rejected `action=grep` and the loop only executed
web search. That gap was independently fixed on main by PR #1711
(`d9a154486`, authored `7e6c3feab`): one shared grep definition/executor now
serves explore, SMS and chat. On resumption, the duplicate local implementation
was removed in favor of that canonical code. An additional permanent pipeline
regression drives real chat -> shared grep executor -> actual scoped document
query -> persisted result -> second Router/Generator; another user's matching
document stays excluded. It uses scripted completion replies and does not claim
that a particular model will choose a particular laundry service.

Deepest owned cause: interactive surfaces separately assembled their context,
so chat could omit a profile the established SMS and Python contexts already
supplied. Unify the existing formatter instead of copying it or adding a
location-specific prompt instruction. No instruction text is rewritten.
Abstraction check: the broader candidate is replacing all SMS/chat/Temporal
runtime contracts; that is incoherent for this repair because those surfaces
intentionally have distinct delivery and lifecycle contracts. Shared profile
selection/rendering is the coherent responsibility they actually share.

Golden mechanisms inspected: Hermes `agent/system_prompt.py:516` and `:783`
loads profile blocks into the volatile system suffix; OpenClaw
`src/agents/workspace.ts:912` and `src/agents/system-prompt.ts:854` loads context
files into system context; Claude Code `src/utils/api.ts:449` and
`src/query.ts:660` adds user context at the model boundary. Exact current-patch
review is recorded in the deploy approval receipt, not inferred from these leads.

## Solution

Extract SMS's formatter and selected profile fields unchanged into
`providers/userProfileContext.ts`. Chat reads that selected profile once per
turn, in parallel with its transcript and project lookup. Initial routing,
after-search routing, ordinary generation and speculative generation receive
the same snapshot. Each new turn reloads the profile. Both model builders retain
the static cache prefix and append project plus profile context after its
boundary. SMS retains its existing formatter output and import compatibility.

This also prevents missing personal identity, delivery recipient and address
fields in follow-ups without persisting private context as chat messages.
At 10k concurrent agents, the change adds one indexed unique-user lookup per
chat turn, no polling, global fan-in or tree-wide work. Grep retains the shared
service's existing limits and lifecycle; a separately owned oversized-result
incident is outside this profile repair and is not claimed fixed here.

Local causal fail/pass is complete; deployment and live outcome verification
are pending. No historical original-request or original-model replay is claimed.

## Human feedback

The user requested chat grep parity with main-agent explores and asked to use
existing user-profile assembly in other locations. Both requirements remain in
scope. No instruction to diagnose only or to avoid deployment was given.

## Reusable lesson

Share selected user-profile rendering at every interactive model boundary and verify the serialized requests across direct replies, retrieval rounds and fresh turns.
