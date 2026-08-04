---
id: 2026-04-29-tool-choice-defaulted-to-auto-for-synthetic-extraction-tool
date: 2026-04-29
title: claudeAuth defaulted tool_choice to auto (and downgraded forced choice under thinking), so structured-output calls returned prose
surface: agents
component: rose-client
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: 'agents/providers/rose/claude_auth.py:assemble_anthropic_body — apply_anthropic_tool_config defaults tool_choice to {"type":"auto"} even for tools synthesized from response_format'
symptoms:
  - plan_loop and verifier return prose instead of JSON on the claudeAuth path
  - streaming JSON parser blows up on assistant prose
  - structured output broken on every claudeAuth call
tags:
  - claude-auth
  - structured-output
  - tool-choice
  - extended-thinking
  - anthropic
sources:
  - memory:project_claude_auth_structured_output
repro: none-recorded
status: fixed
---

## Problem

Structured output was broken on every claudeAuth call — `plan_loop` and the
verifier came back as assistant prose instead of JSON, and the streaming JSON
parser then blew up on that prose. Verified end-to-end after the fix: the agent
went PLAN → set_plan → planner → DAG → attempt_completion, with
`agent_cache.py` showing 6 claudeAuth calls, 42% cache hit, $0 cost.

## Diagnosis

Two interacting bugs in `assemble_anthropic_body`:

1. `apply_anthropic_tool_config` defaults `tool_choice` to `{"type":"auto"}`
   whenever the caller doesn't pass one — including the case where the tool was
   synthesized from `response_format` extraction, where the call MUST land on the
   synthetic tool.
2. The pre-existing "thinking + tool_choice" downgrade unconditionally rewrote
   `any|tool` → `auto`, so even an explicitly forced choice was un-forced.

The upstream constraint is real: the Anthropic API rejects forced `any|tool`
while extended thinking is enabled, and the earlier fix chose to preserve
thinking by downgrading tool_choice. That trade is correct for real tool lists
(the model still picks a tool in practice) but wrong for structured output, where
not calling the synthetic tool means there is no JSON at all. The deepest cause
is one global downgrade rule applied to two call classes with opposite
requirements.

## Solution

Branch by provenance of the tools. When tools came from
`_extract_tools_from_response_format` (i.e. `tools=None && response_format!=None`),
force `tool_choice="any"` AND drop `thinking` — sacrifice thinking, not the
schema. For real tool lists with a caller-set forced `tool_choice`, keep
downgrading to `auto`. This also protects every other extraction-shaped call
(verifier, any future `response_format` user) from the same silent prose return.

## Human feedback

None recorded.

## Reusable lesson

Never apply one provider-constraint downgrade rule to both real tool calls and
schema-extraction calls — when the tool exists only to carry structured output,
force the tool and drop thinking instead.
