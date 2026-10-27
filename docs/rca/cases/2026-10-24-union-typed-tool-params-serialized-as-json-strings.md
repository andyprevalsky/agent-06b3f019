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
  - list_agents arguments {"cursor": "null", "path_prefix": "null", "query": "null"} -> GET /api/agents/<owner>/tree 400, "Observed tool failure: list_agents ... status=ERROR"
  - "tool_calls.1.GrepTool.role: Input should be 'USER', 'ASSISTANT' or 'TOOL'; tool_calls.1.GrepTool.surface: Input should be 'WEB', 'MAC_APP', 'SMS' or 'WHATSAPP'"
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
  - agent afc26036-df61-4861-ab05-da6cd0cf35fe explore task 80e12b33-4b0e-4342-90c4-15c25fe85bf0 (PR 1604 /deploy local smoke browser-auth-assistance-declined, 2026-10-27, qwen-3.8-27b; follow-up regression of this fix)
repro: agents/tests/blackbox/rose.blackbox.py::test_cerebras_tools_send_omittable_optionals_as_their_type; agents/tests/blackbox/rose.blackbox.py::test_cerebras_tools_keep_null_for_omittable_string_optionals; agents/tests/blackbox/wait_for.blackbox.py::test_wait_for_agents_schema_is_a_plain_string_array
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

Follow-up regression (2026-10-27, PR 1604 local smoke
`browser-auth-assistance-declined`, evaluator `no_tool_failures`). The first
cut collapsed every omittable Optional, strings included. The explore toolset is
non-strict (grep `filters`), and qwen-3.8-27b sometimes fills every optional
field. For collapsed string fields it wrote the string `"null"`; for ints,
booleans and objects it wrote literal `null`. The `list_agents` call sent
`cursor/query/path_prefix="null"`, and the backend tree route returned 400
(tool ERROR). `grep` sent `role/surface="null"`, which failed enum validation,
then `page_after="null"`, which raised `InvalidGrepParamError`. Replaying the
preserved explore request (`1793130710504-5814e61c6977-explore_agent.json`)
through `cerebras_complete` on cerebras-direct gave 4/5 responses with `"null"`
strings on HEAD 42df86aa2. With string properties kept as
`anyOf[string, null]`, 0/8 responses had them. Every call validated through
`GrepTool`/`ListAgentsTool` with those fields `None`, and
`sources`/`head_limit` stayed a real list and integer. The same request on
OpenRouter qwen (uncollapsed anyOf) also wrote literal null for string fields.
Why: removing the null branch from a string type leaves `"null"` as the model's
only spelling of "no value", and the harness cannot tell it from a real value.

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
- Follow-up (2026-10-27): string-typed Optionals, including enums, keep
  `anyOf[string, null]`. Only non-string types (array, integer, number,
  boolean, object) collapse. String-encoding a string value is harmless, so the
  original failure cannot recur there, and literal null stays expressible. The
  harness never string-matches `"null"`. The strict projection already accepts
  `anyOf[string, null]`. 10k agents: unchanged per-request O(schema) work.
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
(anyOf with a null or string branch) before blaming strict mode, replay the
captured request with only the schema changed, and never remove the null branch
from a string type, because then `"null"` becomes the only way to say "no value".
