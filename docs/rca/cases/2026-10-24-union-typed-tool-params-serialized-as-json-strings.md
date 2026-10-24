---
id: 2026-10-24-union-typed-tool-params-serialized-as-json-strings
date: 2026-10-24
title: Union-typed tool parameters (anyOf[array, string|null]) were sent as JSON strings by qwen and Opus, forcing re-generation
surface: agents
component: rose-client cerebras tool projection + utils/tool_schemas WaitForTool
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: tool schema sent to the provider — omittable Optional params went to Cerebras as anyOf[X, null], and WaitForTool.agents went to every provider as anyOf[array, const "any", null]
symptoms:
  - "Failed to parse Rose response as AgentAction (parse attempt 1/3); re-generating. error=3 validation error(s): tool_calls.0.GrepTool.sources: Input should be a valid list"
  - "tool_calls.0.function-after[check_mutual_exclusion(), WaitForTool].agents.list[str]: Input should be a valid list"
  - "cerebras.tool_schema.non_strict reason='free-form object' tool_name=grep"
  - grep arguments {"sources": "[\"agent_network\"]", "head_limit": "30"}
  - wait_for arguments {"agents": "[\"/root/buy_canvas_tote\"]"}
tags:
  - tool-schema
  - cerebras
  - structured-output
  - wait-for
  - grep
  - re-generation
sources:
  - agent 1a44321e-d6f6-49d3-b876-5de5cca1796f (descend-full69-20261023 r005-j0069 explore_agent, qwen-3.8-27b, 7 copies)
  - agent 19cff9c2-23ef-4c12-8eae-858d5297b8e9 (descend-full69-20261023 r004-j0047 execute_loop, claude-opus-5-5, 3 copies)
repro: agents/tests/blackbox/rose.blackbox.py::test_cerebras_tools_send_omittable_optionals_as_their_type; agents/tests/blackbox/wait_for.blackbox.py::test_wait_for_agents_schema_is_a_plain_string_array
status: mitigated
---

## Problem

In /descend run descend-full69-20261023, 7 explore_agent copies on
`qwen-3.8-27b` (Cerebras) emitted grep calls with `sources` and `head_limit` as
JSON strings (`"[\"agent_network\"]"`, `"30"`). Three execute_loop copies on
`claude-opus-5-5` emitted `wait_for(agents="[\"/root/buy_canvas_tote\"]")`.
Pydantic rejected each response and the loop re-generated, up to twice. The
copies recovered, but each miss cost a full LLM turn.

## Diagnosis

Critical path: Pydantic tool model → `build_anthropic_tools_from_response_model`
→ provider body (`build_cerebras_body` / claude_auth) → model tool call →
AgentAction validation.

The triage label blamed Cerebras non-strict mode (grep's free-form `filters`
dict forces the whole toolset non-strict). A controlled live replay of the
captured j0069 request falsified that: with `filters` closed, all 7 tools were
`strict=True`, and 9/9 grep calls were still strings. Changing only the schema
encoding separated the outcomes:

| captured request, only variable changed | grep calls with real list/int |
| --- | --- |
| original (`anyOf[X, null]`, non-strict) | 0/9 |
| closed filters, `strict=True`, `anyOf[X, null]` kept | 0/9 |
| null branch dropped, `strict=True` | 7/7 |
| null branch dropped, original open filters (non-strict) | 7/7 |
| fixed build_cerebras_body, unchanged request | 9/9 |

The same class showed up on Opus. Replaying the captured j0047 execute_loop
request (same messages and tools, leased Claude token, 5 trials each):
`agents` typed `anyOf[array, const "any", null]` gave 5/5 strings; a plain
string array gave 5/5 lists.

Why 1: the model serialized an array/integer argument as a JSON string.
Why 2: the declared type was a union whose other branch admits a string or null,
which these models resolve by string-encoding the value. Grammar-constrained
decoding on Cerebras did not prevent it.
Why 3 (deepest owned): our schemas encode "may be omitted" as `anyOf[X, null]`
(Pydantic `Optional[X] = None`), and `wait_for` overloaded one parameter with an
array-or-sentinel-string union. Stop: below that is provider/model behaviour.

## Solution

- Cerebras body: `collapse_omittable_nulls` sends each non-required
  `Optional[X] = None` property as plain `X`, for both strict and non-strict
  toolsets. The caller's Pydantic model stays authoritative, since omission
  validates to None. Required and non-null-default fields keep their union.
  The field's own description wins over a nested model's docstring (the
  adversarial review caught `spawn_agent.output_schema` losing its field
  description in the first cut; asserted in the regression).
  This matches Claude Code, whose optional tool params are `.optional()` (omit,
  no null), e.g. `claude-code-src/src/tools/GrepTool/GrepTool.ts:40-48`. We do not
  adopt its `semanticNumber` coercion, because harness rewriting of model output
  is disallowed here.
- `WaitForTool.agents` is `Optional[List[str]]`; "any" is `["any"]`, matching
  Codex `wait_agent` targets as a plain string array
  (`codex/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:887-897`). The
  handler accepts `["any"]`. Mixing `"any"` with addresses is rejected truthfully.
- Not done: closing grep `filters`. It was not causal. Collapsing only the
  Cerebras projection was chosen over changing every provider's Optional encoding,
  because GPT strict structured outputs rely on nullable-required fields.

10k agents: schema transformation is per request and O(schema size), with no
shared state. Fast-cache exact keys change for calls that carry the wait_for
tool. The existing position fallback in `lookup_llm_cache` still resolves them.

Status is `mitigated` until a /descend rerun shows zero GrepTool/WaitForTool
re-generations.

## Human feedback

None recorded.

## Reusable lesson

When a model sends a list or number as a JSON string, look at the declared union
(anyOf with a null or string branch) before blaming strict mode, and replay the
captured request with only the schema changed.
