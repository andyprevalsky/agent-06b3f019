---
id: 2026-10-24-anthropic-request-builder-sent-empty-text-and-open-output-schema
date: 2026-10-24
title: claudeAuth request builder sent empty text blocks and open structured-output objects, so Anthropic 400'd completion_summary and verifier_browser
surface: agents
component: rose-client (providers/rose/transforms.py Anthropic adapter)
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/transforms.py — transform_messages_for_anthropic kept blank text blocks/messages, and apply_anthropic_tool_config installed a non-strict OpenAI schema as output_config.format without additionalProperties:false
symptoms:
  - "messages: text content blocks must be non-empty"
  - "output_config.format.schema: For 'object' type, 'additionalProperties' must be explicitly set to false"
  - "rose.claude_auth.invalid_request"
  - call_site=completion_summary falls through claudeAuth to Foundry on every copy of agent-display-revenue-chart
tags:
  - anthropic-400
  - claude-auth
  - completion-summary
  - verifier-browser
  - structured-output
  - observability
sources:
  - fleet run descend-full69-20261023 cluster R4 (r001-j0014 r002-j0028 r003-j0042 r004-j0056 r005-j0070; verifier_browser r004-j0045 r005-j0061)
  - agent 81c45d8f-c055-4e07-ab82-137398f314a9 (completion_summary dump llm/9996070e0664)
  - agent 1a29f3ea-b03c-4e5d-b50f-529844eec56a (verifier_browser dump llm/053f97dbadd0)
repro: agents/tests/blackbox/rose.blackbox.py::test_build_anthropic_body_accepts_completion_summary_context_with_empty_rows, ::test_build_anthropic_body_closes_non_strict_output_format_objects, ::test_claude_auth_400_logs_provider_message
status: fixed
---

## Problem

In the descend-full69 run, all 5 copies of agent-display-revenue-chart got a
deterministic Claude 400 `invalid_request` at call_site completion_summary,
first at 23:18:20Z on r004-j0056. verifier_browser hit the same 400 on j0045
and j0061. Each call fell through to the out-of-credit funded keys and then to
Foundry. The tasks still passed, but every one of those calls lost the user's
Claude lease and its $0 cost. The worker logged only `error_body_len` (161 and
216), so the reason was invisible.

## Diagnosis

The exact request inputs came from the R2 trace bundles
(`llm/9996070e0664`, `llm/053f97dbadd0`). Replaying them through the
production `claude_auth_complete` with a leased Claude token reproduced both
400s and captured the bodies:

1. completion_summary: `messages: text content blocks must be non-empty`.
   `convert_context_to_messages` renders some rows as `""`: the two
   attachment rows, and an assistant row whose turn was tool-call-only.
   plan_loop is unaffected because it gets timestamp prefixes, which are
   never empty. `transform_messages_for_anthropic` merged adjacent user rows
   into `[text, "", "", text]` and kept the empty assistant message.
2. verifier_browser: `output_config.format.schema: For 'object' type,
   'additionalProperties' must be explicitly set to false`. The verifier
   output has optional fields, so `rose_openai_strict=False`, and
   `build_openai_response_format` emits the plain Pydantic schema with no
   `additionalProperties`. `apply_anthropic_tool_config` then installed it as
   `output_config.format`. `transform_schema_for_anthropic` only collapses an
   explicit dict or `true` to `false`; it never adds the key when it is
   missing.

Deepest owned cause: the Anthropic adapter is the single place that must
satisfy Anthropic's request invariants, and it trusted provider-neutral inputs
to already satisfy them. It is a relative of
2026-08-04-convert-context-to-messages-skips-provider-invariant-guards: same
class, different invariant.

## Solution

The fix is in the adapter, so it covers every caller:
- `transform_messages_for_anthropic` drops whitespace-only text blocks, and
  drops any user/assistant message left with no content. This mirrors
  claude-code-src/src/utils/messages.ts:4869
  (filterWhitespaceOnlyAssistantMessages). Real content and tool pairs are
  unchanged.
- `_close_output_format_objects` sets `additionalProperties: false` on every
  object of the structured-output schema. It only applies to
  `output_config.format` / `output_format`; tool input schemas are untouched.
  This converges on claude-code-src/src/utils/sessionTitle.ts:98.
- `rose.claude_auth.invalid_request` now logs `provider_message` (Anthropic's
  validation message, capped at 200 chars).

At 10k agents: pure per-request transforms, O(message blocks + schema
nodes). No shared state, no extra calls.

## Human feedback

None recorded.

## Reusable lesson

When claudeAuth 400s at one call site only, replay that call's archived dump through claude_auth_complete to capture Anthropic's message, then fix the Anthropic adapter so it enforces the provider invariant for every caller.
