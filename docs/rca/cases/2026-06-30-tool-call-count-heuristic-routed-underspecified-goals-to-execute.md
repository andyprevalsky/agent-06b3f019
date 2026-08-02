---
id: 2026-06-30-tool-call-count-heuristic-routed-underspecified-goals-to-execute
date: 2026-06-30
title: A tool-call-count heuristic routed underspecified goals into EXECUTE, where the agent cannot ask the user
surface: cross
component: chat-router
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "chat router plan-vs-execute mode selection — the tool-call-count heuristic pushed bare purchase goals into EXECUTE"
symptoms:
  - '"get me a 6 pack" is routed to EXECUTE instead of PLAN'
  - an EXECUTE-phase agent asks or waits for the user instead of proceeding
  - the agent blocks claiming it does not have the user's address or payment method
tags:
  - routing
  - plan-vs-execute
  - prompt
  - wait-for-user
  - purchase-flow
sources:
  - PR #672
repro: agents/scripts/repro_6pack_decision.py
status: fixed
---

## Problem

Bare, underspecified goals such as "get me a 6 pack" were routed straight into
EXECUTE mode, where the agent has no way to ask the user for the missing
details — so the run stalled on a question nobody could answer. The same agents
also falsely blocked on "I don't have your address / payment method" even though
the browser sub-agent already carries the user's saved address and stored
payment. Repro harnesses (`agents/scripts/repro_router_decision.py`,
`repro_6pack_decision.py`) pinned the decision: after the fix "get me a 6 pack"
selects PLAN with 0/5 execute votes on both Sonnet 4.6 and Opus 4.8.

## Diagnosis

Two layers held contradictory contracts. Tier 1, the chat router, selected
EXECUTE from a tool-call-count heuristic — a proxy for "small task" that says
nothing about whether the goal is fully specified or decomposable by one agent.
Tier 2, the EXECUTE phase prompt, did not forbid asking/waiting for the user, and
`spawn_agent(browser)` never told the main agent that the browser sub-agent
already has saved address plus stored payment (auto-paying up to a limit). So a
goal that needed clarification landed in the one phase that cannot clarify, and
the phase's own prompt let it wait rather than proceed. The router's criterion
was never aligned with the capability of the phase it routes into.

## Solution

Tier 1 now requires EXECUTE to be both (1) fully specified — no user
clarification needed — and (2) completable by a single agent without
decomposition; otherwise the goal routes to PLAN. The tool-call-count heuristic
was removed, and the canonical PLAN/EXECUTE phase prompts are embedded by
reference so they stay byte-identical to `agents/utils/prompts.py`, guarded by a
new router↔phase drift test (3/3 passing). Tier 2 now mandates "make the best
assumption and proceed; never ask/wait for the user", and `spawn_agent(browser)`
discloses the saved address and stored payment so the agent stops falsely
blocking on them. Specified purchases still route to EXECUTE.

## Human feedback

The record notes only that the Tier 1 + Tier 2 prompt edits required and
received explicit human approval before shipping (prompt approval guard); no
correction to the diagnosis itself is recorded.

## Reusable lesson

Route on whether the goal is answerable by the target phase's actual
capabilities — never on a proxy metric like expected tool-call count — and make
the phase that cannot ask the user say so in its own prompt.
