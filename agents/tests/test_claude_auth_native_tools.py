"""
End-to-end test for claudeAuth native tools pathway.

Validates that the claudeAuth path (using native Anthropic tools) produces
streaming output that is parsed identically by the agent's actual parsing code
compared to the racing pathway (structured output).

Tests use the EXACT same code the agent uses:
- create_agent_action_model() for Pydantic model generation
- prepare_schema_for_openai() for JSON schema generation
- Same SSE parsing + JSON extraction + Pydantic validation as call_llm_structured_streaming

Usage:
    cd agents && source venv/bin/activate
    python tests/test_claude_auth_native_tools.py

    # Run against production instead of local dev:
    ROSE_API_URL=https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions python tests/test_claude_auth_native_tools.py
"""

import asyncio
import json
import os
import re
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple, Type

import httpx
from pydantic import BaseModel

# Add agents/ to path so we can import the actual agent code
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from helpers.llm import prepare_schema_for_openai, _extract_response_from_partial_json
from utils.tool_schemas import (
    EXECUTE_PHASE_TOOLS,
    PLAN_PHASE_TOOLS,
    create_agent_action_model,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ROSE_API_URL = os.getenv(
    "ROSE_API_URL", "http://127.0.0.1:54321/functions/v1/completions"
)
ROSE_API_KEY = os.getenv("ROSE_API_KEY", "af1ea4b12ea8dbe07c555a45a8ad4dc8")
SUPABASE_ANON_KEY = os.getenv(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU",
)


def get_claude_token() -> Optional[str]:
    """Read Claude OAuth token from macOS Keychain (same as test-claude-auth-streaming.mjs)."""
    try:
        raw = subprocess.check_output(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        parsed = json.loads(raw)
        token = parsed.get("claudeAiOauth", {}).get("accessToken")
        if token:
            print(f"  Claude token: {token[:20]}...{token[-10:]}")
        return token
    except Exception as e:
        print(f"  Failed to read Claude token from keychain: {e}")
        return None


# ---------------------------------------------------------------------------
# SSE streaming + parsing (mirrors call_llm_structured_streaming logic)
# ---------------------------------------------------------------------------


async def stream_and_parse(
    request_body: dict,
    response_model: Type[BaseModel],
    label: str,
) -> Tuple[BaseModel, Dict[str, Any], List[str]]:
    """
    Stream SSE from Rose endpoint and parse using the EXACT same logic as
    call_llm_structured_streaming in agents/helpers/llm.py.

    Returns:
        (parsed_response, usage_dict, streaming_chunks_for_debugging)
    """
    print(f"\n{'=' * 60}")
    print(f"  {label}")
    print(f"{'=' * 60}")

    accumulated_reasoning = ""
    accumulated_json = ""
    chunk_count = 0
    actual_model = "unknown"
    stream_usage = None
    raw_chunks: List[str] = []

    # Track streaming text for UI display verification
    streamed_texts: List[str] = []

    async with httpx.AsyncClient(timeout=300.0) as client:
        async with client.stream(
            "POST",
            ROSE_API_URL,
            json=request_body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                "x-api-key": ROSE_API_KEY,
            },
        ) as resp:
            if resp.status_code != 200:
                error_body = await resp.aread()
                raise RuntimeError(
                    f"HTTP {resp.status_code}: {error_body.decode()[:500]}"
                )

            async for line in resp.aiter_lines():
                chunk_count += 1
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str == "[DONE]":
                    break

                try:
                    chunk_data = json.loads(data_str)
                except json.JSONDecodeError:
                    print(f"  PARSE_ERROR chunk#{chunk_count}: {data_str[:200]}")
                    continue

                raw_chunks.append(data_str)

                # Model info
                if chunk_data.get("actual_model") and actual_model == "unknown":
                    actual_model = chunk_data["actual_model"]
                    print(f"  Model: {actual_model}")

                # Usage
                if chunk_data.get("usage"):
                    stream_usage = chunk_data["usage"]

                # Delta content — same extraction as llm.py
                delta = chunk_data.get("choices", [{}])[0].get("delta", {})
                reasoning_delta = delta.get("reasoning") or ""
                content = delta.get("content") or ""

                if reasoning_delta:
                    accumulated_reasoning += reasoning_delta
                if content:
                    accumulated_json += content

                # Extract streaming text for UI display (same as llm.py)
                response_text = _extract_response_from_partial_json(
                    accumulated_reasoning, accumulated_json
                )
                if response_text:
                    streamed_texts.append(response_text)

    print(f"  Chunks: {chunk_count}, Model: {actual_model}")
    print(f"  Reasoning len: {len(accumulated_reasoning)}, JSON len: {len(accumulated_json)}")

    if stream_usage:
        print(
            f"  Usage: prompt={stream_usage.get('prompt_tokens', 0)} "
            f"completion={stream_usage.get('completion_tokens', 0)}"
        )

    # ---------- Parse JSON — same logic as llm.py lines 940-998 ----------
    if not accumulated_json:
        raise ValueError(f"No JSON content received ({chunk_count} chunks, model={actual_model})")

    json_content = accumulated_json
    explanation_text = ""

    # Markdown code block extraction
    code_block_match = re.search(r"```(?:json)?\s*(\{[\s\S]*\})\s*```", accumulated_json)
    if code_block_match:
        json_content = code_block_match.group(1)
        explanation_text = accumulated_json[: code_block_match.start()].strip()
    else:
        json_start = accumulated_json.find("{")
        if json_start != -1:
            explanation_text = accumulated_json[:json_start].strip()
            # Balanced brace extraction
            depth = 0
            in_string = False
            escape_next = False
            json_end = -1
            for i in range(json_start, len(accumulated_json)):
                c = accumulated_json[i]
                if escape_next:
                    escape_next = False
                    continue
                if c == "\\" and in_string:
                    escape_next = True
                    continue
                if c == '"' and not escape_next:
                    in_string = not in_string
                    continue
                if in_string:
                    continue
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        json_end = i
                        break
            if json_end != -1:
                json_content = accumulated_json[json_start : json_end + 1]

    parsed_content = json.loads(json_content)

    # ---------- Reasoning merging — same as llm.py lines 1038-1053 ----------
    combined_reasoning_parts = []
    if accumulated_reasoning and accumulated_reasoning.strip():
        combined_reasoning_parts.append(accumulated_reasoning.strip())

    json_reasoning = parsed_content.get("reasoning")
    if isinstance(json_reasoning, str) and json_reasoning.strip():
        if not combined_reasoning_parts or json_reasoning.strip() != combined_reasoning_parts[0]:
            combined_reasoning_parts.append(json_reasoning.strip())

    if explanation_text:
        combined_reasoning_parts.append(explanation_text)

    combined_reasoning = "\n\n".join(part for part in combined_reasoning_parts if part)
    if combined_reasoning and "response" in parsed_content:
        parsed_content["response"] = combined_reasoning + "\n\n" + parsed_content["response"]

    # ---------- Pydantic validation — same as llm.py line 1055 ----------
    response = response_model.model_validate(parsed_content)

    usage = {
        "prompt_tokens": (stream_usage or {}).get("prompt_tokens", 0),
        "completion_tokens": (stream_usage or {}).get("completion_tokens", 0),
        "actual_model": actual_model,
    }

    return response, usage, streamed_texts


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def build_request(
    messages: List[Dict],
    response_model: Type[BaseModel],
    *,
    claude_token: Optional[str] = None,
    model_seed: Optional[int] = None,
) -> dict:
    """Build a Rose API request body with the exact same schema the agent sends."""
    schema = prepare_schema_for_openai(response_model)
    body: dict = {
        "model": "rose-labs/rose-1-lite",
        "messages": messages,
        "temperature": 0.0,
        "max_tokens": 2048,
        "stream": True,
        "stream_options": {"include_usage": True},
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": response_model.__name__,
                "schema": schema,
                "strict": True,
            },
        },
    }
    if claude_token:
        body["claude_token"] = claude_token
    if model_seed is not None:
        body["model_seed"] = model_seed
    return body


def validate_parsed_response(
    response: BaseModel,
    phase: str,
    path_label: str,
) -> List[str]:
    """
    Validate that a parsed response meets all quality requirements.
    Returns list of failure messages (empty = pass).
    """
    failures: List[str] = []

    # 1. response field must be a string
    if not isinstance(response.response, str):
        failures.append(f"[{path_label}] response is not a string: {type(response.response)}")
        return failures

    # 2. response must not contain raw JSON structures
    response_text = response.response
    # Check for JSON object patterns that indicate leakage
    json_patterns = [
        (r'^\s*\{', "response starts with JSON object"),
        (r'"tool"\s*:', "response contains '\"tool\":' (tool_calls leaked into response)"),
        (r'"tool_calls"\s*:', "response contains '\"tool_calls\":' (meta-structure leaked)"),
        (r'"name"\s*:\s*"[a-z_]+".*"arguments"\s*:', "response contains name/arguments format (wrong tool format)"),
    ]
    for pattern, msg in json_patterns:
        if re.search(pattern, response_text):
            failures.append(f"[{path_label}] {msg}. Response text (first 300): {response_text[:300]}")

    # 2b. Log whether response contains reasoning text
    # With tool_choice=any + system prompt fix, the model should produce text most of the time
    # but it's not guaranteed — an empty response is valid (just no "Thinking..." text in UI)
    stripped = response_text.strip()
    if not stripped:
        print(f"  Note: response is empty (no reasoning text — model skipped text block)")
    else:
        print(f"  Response text ({len(stripped)} chars): {stripped[:80]}...")

    # 3. tool_calls must exist and be a list
    if not hasattr(response, "tool_calls"):
        failures.append(f"[{path_label}] response has no tool_calls attribute")
        return failures

    if not isinstance(response.tool_calls, list):
        failures.append(f"[{path_label}] tool_calls is not a list: {type(response.tool_calls)}")
        return failures

    # 4. Each tool_call must have 'tool' field with correct discriminator
    for i, tc in enumerate(response.tool_calls):
        if not hasattr(tc, "tool"):
            failures.append(f"[{path_label}] tool_calls[{i}] missing 'tool' attribute")
            continue

        # tool must be a string
        if not isinstance(tc.tool, str):
            failures.append(f"[{path_label}] tool_calls[{i}].tool is not a string: {type(tc.tool)}")
            continue

        # tool must be a known tool name for this phase
        expected_tools = EXECUTE_PHASE_TOOLS if phase == "execute" else PLAN_PHASE_TOOLS
        if tc.tool not in expected_tools:
            failures.append(
                f"[{path_label}] tool_calls[{i}].tool='{tc.tool}' not in {phase} tools: {expected_tools}"
            )

        # Must NOT have 'name' or 'arguments' fields (wrong format)
        if hasattr(tc, "name") and tc.tool != tc.name if hasattr(tc, "name") else False:
            failures.append(f"[{path_label}] tool_calls[{i}] has legacy 'name' field")
        if hasattr(tc, "arguments"):
            failures.append(f"[{path_label}] tool_calls[{i}] has legacy 'arguments' field")

    # 5. At least one tool call should be present (we prompted for it)
    if len(response.tool_calls) == 0:
        failures.append(f"[{path_label}] tool_calls is empty (model should have called a tool)")

    return failures


def validate_streaming_text(
    streamed_texts: List[str],
    path_label: str,
) -> List[str]:
    """
    Validate that streaming text shown to the user is clean.
    The UI shows _extract_response_from_partial_json output progressively.
    Returns list of failure messages.
    """
    failures: List[str] = []

    if not streamed_texts:
        # No streaming text is ok for very short responses
        return failures

    # Check the final streamed text (what the user would see)
    final_text = streamed_texts[-1]

    # Should not contain raw JSON structures
    if re.search(r'^\s*\{', final_text):
        failures.append(f"[{path_label}] streamed text starts with JSON: {final_text[:200]}")

    # Should not contain tool_calls JSON
    if '"tool_calls"' in final_text and '"tool"' in final_text:
        # Allow if it's just mentioned in natural language
        if re.search(r'"tool_calls"\s*:\s*\[', final_text):
            failures.append(f"[{path_label}] streamed text contains raw tool_calls array: {final_text[:300]}")

    # Should not contain name/arguments format
    if re.search(r'"name"\s*:\s*"[a-z_]+"', final_text) and re.search(r'"arguments"\s*:', final_text):
        failures.append(f"[{path_label}] streamed text contains name/arguments format: {final_text[:300]}")

    return failures


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


async def test_execute_phase_spawn_browser(claude_token: str) -> List[str]:
    """
    Test execute phase with spawn_browser_agent tool.
    8 tools in schema — fits within Anthropic's 8 anyOf limit for structured output.
    """
    print("\n" + "=" * 70)
    print("TEST: Execute phase — spawn_browser_agent (8 tools in schema)")
    print("=" * 70)

    AgentAction = create_agent_action_model(EXECUTE_PHASE_TOOLS)
    messages = [
        {
            "role": "system",
            "content": (
                "You are a helpful agent. Respond with a brief thought in the response field, "
                "then call spawn_browser_agent to look up 'weather in San Francisco today'."
            ),
        },
        {"role": "user", "content": "What's the weather like in San Francisco right now?"},
    ]

    all_failures: List[str] = []

    # --- ClaudeAuth path (structured output) ---
    body_claude = build_request(messages, AgentAction, claude_token=claude_token)
    response_claude, usage_claude, texts_claude = await stream_and_parse(
        body_claude, AgentAction, "ClaudeAuth: Execute spawn_browser_agent"
    )

    failures = validate_parsed_response(response_claude, "execute", "claude/execute/spawn_browser")
    failures += validate_streaming_text(texts_claude, "claude/execute/spawn_browser/streaming")

    # Verify a tool was called (model may pick spawn_browser_agent or another tool)
    if not response_claude.tool_calls:
        failures.append("[claude/execute/spawn_browser] Expected at least one tool call but got none")
    else:
        tool_names = [tc.tool for tc in response_claude.tool_calls]
        print(f"  Tool calls: {tool_names}")

    if failures:
        print(f"  FAILURES: {len(failures)}")
        for f in failures:
            print(f"    - {f}")
    else:
        print(f"  PASS")

    all_failures.extend(failures)

    # --- Baseline path (racing/structured output via model_seed=3) ---
    # Baseline is a nice-to-have comparison — don't fail the suite if racing times out
    response_baseline = None
    try:
        body_baseline = build_request(messages, AgentAction, model_seed=3)
        response_baseline, usage_baseline, texts_baseline = await stream_and_parse(
            body_baseline, AgentAction, "Baseline: Execute web_search (model_seed=3)"
        )

        failures = validate_parsed_response(response_baseline, "execute", "baseline/execute/web_search")
        failures += validate_streaming_text(texts_baseline, "baseline/execute/web_search/streaming")

        if failures:
            print(f"  FAILURES: {len(failures)}")
            for f in failures:
                print(f"    - {f}")
        else:
            print(f"  PASS")

        all_failures.extend(failures)
    except Exception as e:
        print(f"  SKIPPED (baseline timed out or failed: {e})")

    # --- Cross-check: both paths produce structurally identical output ---
    if response_baseline and response_claude.tool_calls and response_baseline.tool_calls:
        claude_tools = [tc.tool for tc in response_claude.tool_calls]
        baseline_tools = [tc.tool for tc in response_baseline.tool_calls]
        if claude_tools != baseline_tools:
            all_failures.append(
                f"[cross-check/execute/web_search] Tool names differ: claude={claude_tools} baseline={baseline_tools}"
            )
        else:
            print(f"  Cross-check: tool names match ({claude_tools})")

    return all_failures


async def test_execute_phase_multiple_tools(claude_token: str) -> List[str]:
    """
    Test execute phase with a prompt that triggers multiple tool calls.
    Verifies that multiple native tool_use blocks are correctly reconstructed.
    """
    print("\n" + "=" * 70)
    print("TEST: Execute phase — multiple tool calls")
    print("=" * 70)

    AgentAction = create_agent_action_model(EXECUTE_PHASE_TOOLS)
    messages = [
        {
            "role": "system",
            "content": (
                "You are a helpful agent. First explain your plan in the response field, "
                "then call TWO spawn_browser_agent tools: one to look up 'best Italian restaurants San Francisco' "
                "AND one to look up 'weather San Francisco tonight'. Always call both."
            ),
        },
        {
            "role": "user",
            "content": (
                "I want to find the best Italian restaurant in SF and check tonight's weather. "
                "Search for both."
            ),
        },
    ]

    body = build_request(messages, AgentAction, claude_token=claude_token)
    response, usage, texts = await stream_and_parse(
        body, AgentAction, "ClaudeAuth: Multiple tool calls"
    )

    failures = validate_parsed_response(response, "execute", "claude/execute/multi_tool")
    failures += validate_streaming_text(texts, "claude/execute/multi_tool/streaming")

    # Should have at least 2 tool calls
    if len(response.tool_calls) < 2:
        failures.append(
            f"[claude/execute/multi_tool] Expected 2+ tool calls, got {len(response.tool_calls)}: "
            f"{[tc.tool for tc in response.tool_calls]}"
        )
    else:
        print(f"  Tool calls: {[(tc.tool, getattr(tc, 'query', '?')) for tc in response.tool_calls]}")

    if failures:
        print(f"  FAILURES: {len(failures)}")
        for f in failures:
            print(f"    - {f}")
    else:
        print(f"  PASS")

    return failures


async def test_execute_phase_spawn_sub_agent(claude_token: str) -> List[str]:
    """
    Test execute phase with spawn_sub_agent — a deeply nested schema.
    This is the tool that was failing in the original bug (agent stuck in loop).
    """
    print("\n" + "=" * 70)
    print("TEST: Execute phase — spawn_sub_agent (deeply nested schema)")
    print("=" * 70)

    AgentAction = create_agent_action_model(EXECUTE_PHASE_TOOLS)
    messages = [
        {
            "role": "system",
            "content": (
                "You are a helpful agent. Think briefly in the response field, "
                "then call spawn_sub_agent to create a sub-agent with:\n"
                "- goal: 'Research the top 3 AI startups in San Francisco'\n"
                "- read_only: true\n"
                "- verifier type: 'FLOAT_LLM_JUDGE' with prompt 'Did the agent find 3 startups?'\n"
                "- output_schema with one field: name='startups', type='list[str]', required=true, description='List of startup names'"
            ),
        },
        {"role": "user", "content": "Find the top 3 AI startups in SF."},
    ]

    body = build_request(messages, AgentAction, claude_token=claude_token)
    response, usage, texts = await stream_and_parse(
        body, AgentAction, "ClaudeAuth: spawn_sub_agent"
    )

    failures = validate_parsed_response(response, "execute", "claude/execute/sub_agent")
    failures += validate_streaming_text(texts, "claude/execute/sub_agent/streaming")

    # Check spawn_agent with type="sub_agent" was called with correct structure
    # Note: spawn_sub_agent is an alias — the schema tool is spawn_agent
    sub_agent_calls = [tc for tc in response.tool_calls if tc.tool == "spawn_agent" and getattr(tc, "type", None) == "sub_agent"]
    if not sub_agent_calls:
        called = [(tc.tool, getattr(tc, "type", "?")) for tc in response.tool_calls]
        failures.append(f"[claude/execute/sub_agent] Expected spawn_agent(type=sub_agent) but got {called}")
    else:
        tc = sub_agent_calls[0]
        if hasattr(tc, "goal") and tc.goal:
            print(f"  goal: {tc.goal[:80]}")
        else:
            failures.append("[claude/execute/sub_agent] missing 'goal'")
        if not hasattr(tc, "verifier") or not tc.verifier:
            failures.append("[claude/execute/sub_agent] missing 'verifier'")
        else:
            print(f"  verifier: {tc.verifier.type}")
            if tc.verifier.type != "FLOAT_LLM_JUDGE":
                failures.append(f"[claude/execute/sub_agent] verifier.type={tc.verifier.type}, expected FLOAT_LLM_JUDGE")
        if not hasattr(tc, "output_schema") or not tc.output_schema:
            failures.append("[claude/execute/sub_agent] missing 'output_schema'")
        elif not getattr(tc.output_schema, "fields", None):
            failures.append("[claude/execute/sub_agent] output_schema.fields is empty")
        else:
            print(f"  output_schema.fields: {[f.name for f in tc.output_schema.fields]}")

    if failures:
        print(f"  FAILURES: {len(failures)}")
        for f in failures:
            print(f"    - {f}")
    else:
        print(f"  PASS")

    return failures


async def test_execute_phase_send_message(claude_token: str) -> List[str]:
    """
    Test execute phase with send_message_to_user_execute_phase.
    Verifies the message field is correctly extracted.
    """
    print("\n" + "=" * 70)
    print("TEST: Execute phase — send_message_to_user_execute_phase")
    print("=" * 70)

    AgentAction = create_agent_action_model(EXECUTE_PHASE_TOOLS)
    messages = [
        {
            "role": "system",
            "content": (
                "You are a helpful agent. Think briefly in the response field, "
                "then call send_message_to_user_execute_phase with message: "
                "'I found the information you requested. Here are the results.'"
            ),
        },
        {"role": "user", "content": "Give me a status update."},
    ]

    body = build_request(messages, AgentAction, claude_token=claude_token)
    response, usage, texts = await stream_and_parse(
        body, AgentAction, "ClaudeAuth: send_message"
    )

    failures = validate_parsed_response(response, "execute", "claude/execute/send_msg")
    failures += validate_streaming_text(texts, "claude/execute/send_msg/streaming")

    msg_calls = [tc for tc in response.tool_calls if tc.tool == "send_message_to_user_execute_phase"]
    if not msg_calls:
        failures.append("[claude/execute/send_msg] Expected send_message call but got none")
    else:
        tc = msg_calls[0]
        if not hasattr(tc, "message") or not tc.message:
            failures.append("[claude/execute/send_msg] send_message missing 'message' field")
        else:
            print(f"  message: {tc.message[:100]}")

    if failures:
        print(f"  FAILURES: {len(failures)}")
        for f in failures:
            print(f"    - {f}")
    else:
        print(f"  PASS")

    return failures


async def test_plan_phase(claude_token: str) -> List[str]:
    """
    Test plan phase (5 tools — under the 8 anyOf limit).
    Even though it doesn't exceed the limit, we should verify consistency.
    """
    print("\n" + "=" * 70)
    print("TEST: Plan phase — web_search (5 tools)")
    print("=" * 70)

    AgentAction = create_agent_action_model(PLAN_PHASE_TOOLS)
    messages = [
        {
            "role": "system",
            "content": (
                "You are a helpful planning agent. Think about what you need to research "
                "in the response field, then call web_search to search for 'latest AI news 2026'."
            ),
        },
        {"role": "user", "content": "Research the latest AI developments."},
    ]

    all_failures: List[str] = []

    # ClaudeAuth path
    body_claude = build_request(messages, AgentAction, claude_token=claude_token)
    response_claude, _, texts_claude = await stream_and_parse(
        body_claude, AgentAction, "ClaudeAuth: Plan phase web_search"
    )

    failures = validate_parsed_response(response_claude, "plan", "claude/plan/web_search")
    failures += validate_streaming_text(texts_claude, "claude/plan/web_search/streaming")

    if failures:
        print(f"  FAILURES: {len(failures)}")
        for f in failures:
            print(f"    - {f}")
    else:
        print(f"  PASS")

    all_failures.extend(failures)

    # Baseline path for comparison — don't fail suite if racing times out
    try:
        body_baseline = build_request(messages, AgentAction, model_seed=3)
        response_baseline, _, texts_baseline = await stream_and_parse(
            body_baseline, AgentAction, "Baseline: Plan phase web_search (model_seed=3)"
        )

        failures = validate_parsed_response(response_baseline, "plan", "baseline/plan/web_search")
        failures += validate_streaming_text(texts_baseline, "baseline/plan/web_search/streaming")

        if failures:
            print(f"  FAILURES: {len(failures)}")
            for f in failures:
                print(f"    - {f}")
        else:
            print(f"  PASS")

        all_failures.extend(failures)
    except Exception as e:
        print(f"  SKIPPED (baseline timed out or failed: {e})")

    return all_failures


async def test_attempt_completion(claude_token: str) -> List[str]:
    """
    Test execute phase with attempt_completion tool.
    """
    print("\n" + "=" * 70)
    print("TEST: Execute phase — attempt_completion")
    print("=" * 70)

    AgentAction = create_agent_action_model(EXECUTE_PHASE_TOOLS)
    messages = [
        {
            "role": "system",
            "content": (
                "You are a helpful agent. The user asked you to say hello and you did. "
                "Think briefly in the response field about how the task is done, "
                "then call attempt_completion to signal you are done."
            ),
        },
        {"role": "user", "content": "Say hello."},
        {"role": "assistant", "content": '{"response": "I will say hello.", "tool_calls": [{"tool": "send_message_to_user_execute_phase", "message": "Hello!"}]}'},
    ]

    body = build_request(messages, AgentAction, claude_token=claude_token)
    response, usage, texts = await stream_and_parse(
        body, AgentAction, "ClaudeAuth: attempt_completion"
    )

    # For attempt_completion, the model may produce text-only (no tools) with tool_choice:auto
    # This is valid behavior — we're testing parsing correctness, not model behavior
    # Skip the "tool_calls empty" and "response empty" checks for this test
    failures = []

    # Just verify basic parsing works
    if not isinstance(response.response, str):
        failures.append(f"[claude/execute/completion] response is not a string: {type(response.response)}")

    # Verify no JSON leakage
    for pattern, msg in [
        (r'^\s*\{', "response starts with JSON"),
        (r'"tool_calls"\s*:\s*\[', "tool_calls leaked into response"),
    ]:
        if re.search(pattern, response.response):
            failures.append(f"[claude/execute/completion] {msg}: {response.response[:200]}")

    failures += validate_streaming_text(texts, "claude/execute/completion/streaming")

    completion_calls = [tc for tc in response.tool_calls if tc.tool == "attempt_completion"]
    if not completion_calls:
        called = [tc.tool for tc in response.tool_calls]
        if called:
            print(f"  Note: model called {called} instead of attempt_completion (model choice, not parsing bug)")
        else:
            print(f"  Note: model produced text-only response (no tools called — valid with tool_choice:auto)")
    else:
        print(f"  attempt_completion called correctly")

    if failures:
        print(f"  FAILURES: {len(failures)}")
        for f in failures:
            print(f"    - {f}")
    else:
        print(f"  PASS")

    return failures


async def test_schema_compatibility() -> List[str]:
    """
    Verify that the schemas generated by prepare_schema_for_openai are valid
    for both execute phase (11 tools) and plan phase (5 tools).
    Non-network test — just validates schema generation.
    """
    print("\n" + "=" * 70)
    print("TEST: Schema compatibility (offline)")
    print("=" * 70)

    failures: List[str] = []

    for phase_name, tool_list in [("execute", EXECUTE_PHASE_TOOLS), ("plan", PLAN_PHASE_TOOLS)]:
        model = create_agent_action_model(tool_list)
        schema = prepare_schema_for_openai(model)

        # Basic structure checks
        if schema.get("type") != "object":
            failures.append(f"[schema/{phase_name}] root type is not 'object': {schema.get('type')}")

        props = schema.get("properties", {})
        if "response" not in props:
            failures.append(f"[schema/{phase_name}] missing 'response' property")
        if "tool_calls" not in props:
            failures.append(f"[schema/{phase_name}] missing 'tool_calls' property")

        # Check anyOf variants match tool list
        items = props.get("tool_calls", {}).get("items", {})
        any_of = items.get("anyOf", [])
        if len(any_of) != len(tool_list):
            failures.append(
                f"[schema/{phase_name}] anyOf has {len(any_of)} variants, expected {len(tool_list)}"
            )

        # Each variant must have 'tool' with const discriminator
        schema_tool_names = []
        for variant in any_of:
            tool_prop = variant.get("properties", {}).get("tool", {})
            const_val = tool_prop.get("const")
            if not const_val:
                failures.append(f"[schema/{phase_name}] variant missing tool.const")
            else:
                schema_tool_names.append(const_val)

        if set(schema_tool_names) != set(tool_list):
            failures.append(
                f"[schema/{phase_name}] schema tools {set(schema_tool_names)} != expected {set(tool_list)}"
            )

        # additionalProperties must be false on all objects
        def check_additional_props(obj: dict, path: str):
            if isinstance(obj, dict):
                if obj.get("type") == "object" and "properties" in obj:
                    if obj.get("additionalProperties") is not False:
                        # Allow dict-typed additionalProperties
                        if not isinstance(obj.get("additionalProperties"), dict):
                            failures.append(
                                f"[schema/{phase_name}] {path} missing additionalProperties:false"
                            )
                for k, v in obj.items():
                    if isinstance(v, dict):
                        check_additional_props(v, f"{path}.{k}")
                    elif isinstance(v, list):
                        for i, item in enumerate(v):
                            if isinstance(item, dict):
                                check_additional_props(item, f"{path}.{k}[{i}]")

        check_additional_props(schema, "root")

        print(f"  {phase_name}: {len(any_of)} tools, schema OK")

    if failures:
        print(f"  FAILURES: {len(failures)}")
        for f in failures:
            print(f"    - {f}")
    else:
        print(f"  PASS")

    return failures


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main():
    print("=" * 70)
    print("claudeAuth Native Tools E2E Test Suite")
    print("=" * 70)
    print(f"Rose API: {ROSE_API_URL}")

    all_failures: List[str] = []

    # Schema tests (offline, no network needed)
    all_failures.extend(await test_schema_compatibility())

    # Get Claude token for network tests
    print("\nReading Claude token from keychain...")
    claude_token = get_claude_token()
    if not claude_token:
        print("\nERROR: No Claude token available. Cannot run network tests.")
        print("Make sure Claude Code is authenticated (the token is stored in macOS Keychain).")
        if all_failures:
            print(f"\nSchema tests had {len(all_failures)} failure(s).")
        sys.exit(1)

    # Execute phase tests (11 tools — the critical path)
    all_failures.extend(await test_execute_phase_spawn_browser(claude_token))
    all_failures.extend(await test_execute_phase_multiple_tools(claude_token))
    all_failures.extend(await test_execute_phase_spawn_sub_agent(claude_token))
    all_failures.extend(await test_execute_phase_send_message(claude_token))
    all_failures.extend(await test_attempt_completion(claude_token))

    # Plan phase tests (5 tools)
    all_failures.extend(await test_plan_phase(claude_token))

    # Summary
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)

    if all_failures:
        print(f"\nFAILED: {len(all_failures)} failure(s)")
        for i, f in enumerate(all_failures, 1):
            print(f"  {i}. {f}")
        sys.exit(1)
    else:
        print("\nALL TESTS PASSED")
        sys.exit(0)


if __name__ == "__main__":
    asyncio.run(main())
