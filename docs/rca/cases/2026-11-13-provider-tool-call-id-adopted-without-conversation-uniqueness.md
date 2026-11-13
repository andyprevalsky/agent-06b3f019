---
id: 2026-11-13-provider-tool-call-id-adopted-without-conversation-uniqueness
date: 2026-11-13
title: A provider-reused tool_call_id was persisted as a second declaration's id and broke every later LLM call
surface: agents
component: helpers-llm-native-tool-ingestion
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py call_llm_structured_streaming adopted the native tool_call chunk id verbatim (chunk.data.get("id")) as the durable tool_call_id without checking the conversation's existing ids
symptoms:
  - "ASSISTANT metadata.tool_calls reuses tool_call_id 'spawn_agent:3' for conflicting declarations"
  - reuses tool_call_id for conflicting declarations
  - every call_llm_activity after a kimi-k3 tool turn raises ValueError and the agent never makes another LLM call
  - kimi-k3 tool_call ids like spawn_agent:3 / wait_for:2 repeat across turns
tags:
  - tool-call-id
  - kimi-k3
  - openrouter
  - rose-1-oss
  - native-tools
  - provider-contract
sources:
  - PR #1975 round-7 deploy smoke (browser-biometrics-webdecoy)
  - agent 3f6a83cd-164f-4e55-ab5d-39eb3923f92b
  - task browser-biometrics-webdecoy LLM dumps 775e2206c1a4, 369b842ea28c, 9cce7e697a91
repro: agents/tests/blackbox/llm.blackbox.py::test_provider_reused_tool_call_id_keeps_later_llm_calls_buildable
status: fixed
---

## Problem

In PR #1975's round-7 smoke (02:49Z, 2026-11-13), root agent `3f6a83cd-164f-4e55-ab5d-39eb3923f92b`, an `execute_loop` on pool `rose-1-oss` served by `moonshotai/kimi-k3` through OpenRouter, became permanently unable to call its model. The dumps embedded in the guest worker log show this sequence:

- `775e2206c1a4` emitted `spawn_agent:2`, which failed schema validation and was replayed in-call on the parse retry.
- The retry, `369b842ea28c`, emitted `spawn_agent:3` (task_name `fcaptcha_demo`). It was persisted, then rejected: "task_name 'fcaptcha_demo' is already used by another agent you spawned".
- The next call, `9cce7e697a91`, sent that `spawn_agent:3` declaration and its error result in the request. Kimi answered with a corrected spawn (`fcaptcha_run2`) under the **same** provider id `spawn_agent:3`.

From 02:49:41.99Z, every later `call_llm_activity` (activity 86 attempts 1–3, then activity 93) raised in `register_tool_call_declaration`: `ASSISTANT metadata.tool_calls reuses tool_call_id 'spawn_agent:3' for conflicting declarations`.

## Diagnosis

Critical path: OpenRouter SSE `delta.tool_calls[].id` → `providers/rose/streaming.py` emits `StreamChunk(kind="tool_call", data={"id": ...})` → `call_llm_structured_streaming` sets `tool_call_id = chunk.data.get("id") or uuid4()` and records it in `detected_tools_ordered` (also the early IN_PROGRESS `stream_tool_event`) → `run_agent` gives the Nth call of each tool the Nth detected id and persists it as `metadata.tool_calls[].tool_call_id` → the next `build_llm_messages` / `convert_context_to_messages` registers every declaration and raises on conflicting reuse.

The data is correct at the provider (kimi numbers ids per turn, which is legal for that model) and wrong at the first Rose step: the id was adopted as the conversation-wide durable key without ever being checked against the ids the conversation already holds. The registry check downstream was correct and must not be loosened. `_ensure_tool_result_pairing` keeps the first declaration per id, so accepting the duplicate would bind `fcaptcha_run2`'s result to the `fcaptcha_demo` arguments.

Step 5a ladder:

1. Why did the build raise? Two persisted declarations shared `spawn_agent:3`. Evidence: request dump `9cce7e697a91` message 13, plus the response dump.
2. Why did they share an id? Ingestion trusted the provider id as conversation-unique. Evidence: `helpers/llm.py` native `tool_call` branch.
3. Why was that possible? No boundary owned the invariant "a new declaration id is unique within the conversation". The only uniqueness check was the after-the-fact registry assertion.

The next rung ("provider ids are not a stable contract") is third-party behavior, so the deepest owned cause is rung 3. Sibling failures the same gap enables:

- The early IN_PROGRESS row is posted under the colliding id and merges with the old call's UI card.
- A parse-retry replay of a colliding tool_use carries a duplicate id inside one request, which strict providers reject.
- Repeated ids within one parallel batch would collide the same way.

Archive searches: "reuses tool_call_id for conflicting declarations" and "tool_call_id collision kimi duplicate tool call id provider". Hits were unrelated: browser chips keyed by task, a workflow uuid4 replay, and Kimi tool selection. Novel incident.

Local repro (captured request and response dumps, real `call_llm_activity` → OpenRouter SSE parser → `build_llm_messages`), run on unmodified main:

`cd agents && source venv/bin/activate && BLACKBOX_CASE_FUNCTIONS=test_provider_reused_tool_call_id_keeps_later_llm_calls_buildable,test_provider_tool_call_ids_stay_unique_within_one_response python scripts/run_blackbox_tests.py llm`

Result: `ValueError: ASSISTANT metadata.tool_calls reuses tool_call_id 'spawn_agent:3' for conflicting declarations ...` (and the in-batch case detected `wait_for:0` twice). After the fix the same command gives 2/2 passed.

## Solution

At the ingestion boundary, `call_llm_structured_streaming` collects every id the outgoing request already uses (`utils.tool_call_ids.request_tool_call_ids`). Each native tool call then claims a conversation-unique id (`claim_tool_call_id`):

- The provider id passes through unchanged when unique.
- A repeat takes the first free `<id>__<n>`.

That one id names the parse-retry replay, the early IN_PROGRESS row and the persisted declaration, so tool_use/tool_result pairing holds. History is never rewritten, so the cached prefix stays byte-identical (asserted in the regression). The rename is deterministic, so Fast Mode stream replays assign the same id. Normal providers (`toolu_*`, `call_*`, uuids) never collide and are unchanged; the existing llm (270), rose (296), rose-browser-use (122) and run-agent (105) blackbox suites pass.

Golden references, which converge on this shape:

- `kimi-code/packages/agent-core-v2/src/human/llm/protocol/rules/tool-call-ids.ts:128` `createToolCallIdNormalizer` takes history ids as taken, passes the first occurrence through and renames later ones to `<id>__<n>` at LLM ingestion.
- `hermes-agent/agent/turn_tool_validation.py:89` with `agent/message_sanitization.py:544` `uniquify_tool_call_ids`: session ids are taken and never rewritten (prompt cache); the incoming duplicate gets a deterministic `<id>_d<n>`.
- `openclaw/src/agents/tool-call-id.ts:392`: an occurrence-aware resolver gives repeated raw ids distinct ids.

At 10k agents: an O(request tool calls) set build per LLM call, held per activity. No shared state, channel or query.

## Human feedback

The assignment (Andy, via the parent thread) specified the fix: make IDs unique per declaration while preserving tool_call ↔ tool_result pairing and the cached prefix. It ruled out silencing the check, adding a string-matching classifier or injecting a nudge. It required the regression in the agents blackbox domain.

## Reusable lesson

Never adopt a provider-supplied tool_call id as a durable conversation key without claiming it against the ids the conversation already holds; rename only the incoming duplicate, never history.
