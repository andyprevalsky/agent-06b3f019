---
id: 2026-04-17-claude-code-messages-minted-fresh-tool-call-ids
date: 2026-04-17
title: Claude Code sub-agent messages minted fresh tool_call_ids, orphaning tool_use on replay
surface: agents
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py — save_claude_code_message called without tool_call_id, so repo.py minted a fresh UUID
symptoms:
  - spawn-sub-agents smoke benchmark fails
  - parallel-tool-calls smoke benchmark fails
  - OAI tool_result_pairing validation error on conversation replay
  - TOOL message toolCallId matches no parent ASSISTANT tool_use.id
tags:
  - claude-code
  - tool-call-id
  - tool-result-pairing
  - smoke-benchmark
  - sub-agent
sources:
  - PR #391
repro: none-recorded
status: fixed
---

## Problem

The `spawn-sub-agents` and `parallel-tool-calls` smoke benchmarks were failing
before this PR. On replay, the conversation failed OAI `tool_result_pairing`
validation: TOOL messages produced by the Claude Code sub-agent carried a
`toolCallId` that matched no `tool_use.id` on any parent ASSISTANT message, so
the tool results were orphaned.

## Diagnosis

`agents/domains/spawn_claude_code_agent/service.py` called
`save_claude_code_message` without passing `tool_call_id`. With no id supplied,
`repo.py` minted a fresh UUID for each saved message. The identifier that must be
inherited from the parent assistant turn was therefore invented locally at the
persistence layer — the pairing contract (every TOOL message references the
`tool_use.id` that requested it) was satisfiable only by accident. What made it
possible: the repository defaulted a _correlation_ identifier instead of
requiring it, so a caller that forgot to plumb it produced structurally invalid
history with no error at write time. The break only surfaced later, at replay
validation, far from the bad write.

## Solution

Plumbed `tool_call_id` through `_run_agentic_loop` and passed it to all 10
`save_claude_code_message` call sites — including init, status updates,
authentication errors, and task started/cancelled/failed. Because every message
class in the loop now inherits the parent id, the fix also covers the error and
lifecycle paths (not just the happy path) that would otherwise emit orphaned
TOOL messages only during failures. Verified by the smoke suite going 5/5,
including `spawn-sub-agents` (146s) and `parallel-tool-calls` (207s).

## Human feedback

None recorded.

## Reusable lesson

When a persistence helper can mint a correlation id itself, a caller that forgets
to pass one writes structurally invalid history silently — require the id rather
than defaulting it, and plumb it to every call site including the error paths.
