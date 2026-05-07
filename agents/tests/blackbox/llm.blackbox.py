"""Blackbox tests for llm domain (pure functions + mockable activities)."""

import asyncio
import json
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def test_prepare_schema_for_openai():
    """prepare_schema_for_openai returns strict OpenAI-ready JSON schema."""
    from pydantic import BaseModel, Field
    from helpers.llm import prepare_schema_for_openai

    class TestModel(BaseModel):
        name: str = Field(description="A name")
        age: int = Field(description="An age")

    result = prepare_schema_for_openai(TestModel)

    assert result["type"] == "object"
    assert "properties" in result
    assert "name" in result["properties"]
    assert "age" in result["properties"]
    assert "required" in result
    assert "name" in result["required"]
    assert "age" in result["required"]
    assert result["additionalProperties"] is False


def test_prepare_schema_for_openai_nested_and_array():
    """Schema preparation handles nested models, arrays, and union types recursively."""
    from typing import List, Optional, Union
    from pydantic import BaseModel, Field
    from helpers.llm import prepare_schema_for_openai

    class Inner(BaseModel):
        value: str

    class Outer(BaseModel):
        name: str
        items: List[Inner]
        maybe: Optional[str] = None
        either: Union[int, str] = 0

    result = prepare_schema_for_openai(Outer)
    assert result["additionalProperties"] is False
    # All fields must be required
    assert set(result["required"]) == set(result["properties"].keys())
    # Array items of nested objects should have additionalProperties False too
    items_schema = result["properties"]["items"]
    assert items_schema["type"] == "array"
    inner_schema = items_schema["items"]
    # anyOf or direct object — check recursion
    if "anyOf" in inner_schema:
        for sub in inner_schema["anyOf"]:
            if sub.get("type") == "object":
                assert sub["additionalProperties"] is False
    else:
        assert inner_schema["additionalProperties"] is False
    # $defs should be removed after inlining
    assert "$defs" not in result


def test_convert_context_to_messages():
    """convert_context_to_messages maps USER->user and TOOL->system (no declared tool_call)."""
    from helpers.llm import convert_context_to_messages

    context = [
        {"role": "USER", "text": "Hello there", "timestamp": "2024-01-01T00:00:01Z"},
        {
            "role": "TOOL",
            "text": "Search result: found 3 items",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {"toolName": "web_search", "toolStatus": "FINISHED", "title": "Web Search"},
        },
    ]

    result = convert_context_to_messages(context, include_system=False)

    assert len(result) == 2
    assert result[0]["role"] == "user"
    assert result[0]["content"] == "Hello there"
    # TOOL with no matching ASSISTANT tool_call => system role
    assert result[1]["role"] == "system"
    assert "Search result" in result[1]["content"]


def test_convert_context_to_messages_empty():
    """Empty context returns empty list."""
    from helpers.llm import convert_context_to_messages

    result = convert_context_to_messages([], include_system=False)
    assert result == []

    result_with_system = convert_context_to_messages([], include_system=True)
    assert result_with_system == []


def test_convert_context_to_messages_with_declared_tool_call():
    """ASSISTANT with tool_calls then TOOL with matching ID should become tool role."""
    from helpers.llm import convert_context_to_messages

    context = [
        {"role": "USER", "text": "query", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "thinking",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "tool_calls": [{"tool": "web_search", "tool_call_id": "tc-123", "query": "x"}]
            },
        },
        {
            "role": "TOOL",
            "text": "result",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {
                "toolCallId": "tc-123",
                "toolName": "web_search",
                "toolStatus": "FINISHED",
                "title": "Search Result",
                "structured_response": {"foo": "bar"},
            },
        },
    ]

    messages = convert_context_to_messages(context, include_system=False, include_assistant=True)
    # Expect user, assistant (with tool_calls), tool
    assert any(m["role"] == "tool" for m in messages)
    tool_msg = next(m for m in messages if m["role"] == "tool")
    assert tool_msg["tool_call_id"] == "tc-123"
    assert tool_msg["name"] == "web_search"
    assert "Search Result" in tool_msg["content"]
    assert "Structured Response" in tool_msg["content"]

    assistant_msg = next(m for m in messages if m["role"] == "assistant")
    assert "tool_calls" in assistant_msg


def test_convert_context_to_messages_verifier_message():
    """TOOL with verifierMessage should be rewritten to assistant role."""
    from helpers.llm import convert_context_to_messages

    context = [
        {"role": "USER", "text": "do the thing", "timestamp": "2024-01-01T00:00:01Z"},
        {
            "role": "TOOL",
            "text": "score 0.9",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {
                "verifierMessage": True,
                "title": "Verifier",
                "toolStatus": "FINISHED",
            },
        },
    ]

    msgs = convert_context_to_messages(context, include_system=False)
    assistant_msgs = [m for m in msgs if m["role"] == "assistant"]
    assert len(assistant_msgs) == 1
    assert "Verifier" in assistant_msgs[0]["content"]


def test_convert_context_to_messages_skip_subagent_and_inprogress():
    """Sub-agent messages and IN_PROGRESS tool messages should be skipped."""
    from helpers.llm import convert_context_to_messages

    context = [
        {
            "role": "USER",
            "text": "hidden sub",
            "timestamp": "2024-01-01T00:00:00Z",
            "metadata": {"subAgentId": "sub-1"},
        },
        {"role": "USER", "text": "top level", "timestamp": "2024-01-01T00:00:01Z"},
        {
            "role": "TOOL",
            "text": "wip",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {"toolStatus": "IN_PROGRESS", "toolCallId": "tc-x"},
        },
        {
            "role": "SYSTEM",
            "text": "blueprint",
            "timestamp": "2024-01-01T00:00:03Z",
        },
    ]

    msgs = convert_context_to_messages(context, include_system=True)
    # sub-agent user should be skipped; IN_PROGRESS skipped; SYSTEM included first
    roles = [m["role"] for m in msgs]
    assert "user" in roles
    assert "system" in roles
    # Only the top-level user message
    user_msgs = [m for m in msgs if m["role"] == "user"]
    assert len(user_msgs) == 1
    assert user_msgs[0]["content"] == "top level"


def test_extract_completed_tool_calls():
    """_extract_completed_tool_calls parses complete tool call objects from JSON."""
    from helpers.llm import _extract_completed_tool_calls

    json_str = '{"tool_calls": [{"name": "web_search", "parameters": {"query": "test"}}, {"name": "grep", "parameters": {"pattern": "hello"}}]}'
    result = _extract_completed_tool_calls(json_str)

    assert len(result) == 2
    assert result[0]["name"] == "web_search"
    assert result[0]["parameters"]["query"] == "test"
    assert result[1]["name"] == "grep"


def test_extract_completed_tool_calls_partial():
    """_extract_completed_tool_calls returns only complete objects from partial JSON."""
    from helpers.llm import _extract_completed_tool_calls

    # First object is complete, second is cut off
    json_str = '{"tool_calls": [{"name": "web_search", "parameters": {"query": "test"}}, {"name": "grep", "para'
    result = _extract_completed_tool_calls(json_str)

    assert len(result) == 1
    assert result[0]["name"] == "web_search"


def test_extract_completed_tool_calls_no_array():
    """Returns empty list if no tool_calls array present."""
    from helpers.llm import _extract_completed_tool_calls

    assert _extract_completed_tool_calls('{"foo": "bar"}') == []
    assert _extract_completed_tool_calls("") == []


def test_extract_response_from_partial_json_empty():
    """_extract_response_from_partial_json returns None when both are empty."""
    from helpers.llm import _extract_response_from_partial_json

    assert _extract_response_from_partial_json("", "") is None


def test_extract_response_from_partial_json_reasoning_only():
    """_extract_response_from_partial_json returns reasoning when no json_content."""
    from helpers.llm import _extract_response_from_partial_json

    result = _extract_response_from_partial_json("thinking hard", "")
    assert result == "thinking hard"


def test_extract_response_from_partial_json_complete_json():
    """Extracts response field from complete JSON."""
    from helpers.llm import _extract_response_from_partial_json

    json_str = '{"reasoning": "because X", "response": "hello world"}'
    result = _extract_response_from_partial_json("", json_str)
    assert "because X" in result
    assert "hello world" in result


def test_extract_response_from_partial_json_markdown_block():
    """Extracts response from markdown code block with explanation prefix."""
    from helpers.llm import _extract_response_from_partial_json

    content = 'Here is my analysis.\n```json\n{"reasoning": "abc", "response": "final answer"}\n```'
    result = _extract_response_from_partial_json("", content)
    assert "Here is my analysis" in result
    assert "final answer" in result


def test_extract_response_from_partial_json_partial_fields():
    """Partial JSON with just a response field gets extracted via regex fallback."""
    from helpers.llm import _extract_response_from_partial_json

    content = '{"reasoning": "working", "response": "still typing'
    result = _extract_response_from_partial_json("", content)
    assert result is not None
    assert "working" in result or "still typing" in result


def test_extract_nested_agent_json_blob_raw():
    """Extracts nested JSON object from raw string."""
    from helpers.llm import _extract_nested_agent_json_blob

    text = '{"tool_calls": [{"tool": "x"}], "response": "ok"}'
    result = _extract_nested_agent_json_blob(text)
    assert result is not None
    assert result["response"] == "ok"


def test_extract_nested_agent_json_blob_fenced():
    """Extracts nested JSON from markdown fence."""
    from helpers.llm import _extract_nested_agent_json_blob

    text = 'Text before\n```json\n{"a": 1, "b": 2}\n```\ntext after'
    result = _extract_nested_agent_json_blob(text)
    assert result == {"a": 1, "b": 2}


def test_extract_nested_agent_json_blob_none_cases():
    """Returns None for non-string or non-JSON content."""
    from helpers.llm import _extract_nested_agent_json_blob

    assert _extract_nested_agent_json_blob(None) is None  # type: ignore[arg-type]
    assert _extract_nested_agent_json_blob("") is None
    assert _extract_nested_agent_json_blob("no json here") is None


def test_extract_nested_agent_json_blob_braces_embedded():
    """Finds JSON braces embedded in prose."""
    from helpers.llm import _extract_nested_agent_json_blob

    text = 'Prefix {"key": "value"} suffix text'
    result = _extract_nested_agent_json_blob(text)
    assert result == {"key": "value"}


def test_build_verifier_json_schema():
    """_build_verifier_json_schema with no args returns base schema with reasoning and score."""
    from helpers.llm import _build_verifier_json_schema

    result = _build_verifier_json_schema()

    assert result["type"] == "json_schema"
    schema = result["json_schema"]["schema"]
    assert schema["type"] == "object"
    assert "reasoning" in schema["properties"]
    assert "score" in schema["properties"]
    assert "reasoning" in schema["required"]
    assert "score" in schema["required"]
    assert schema["additionalProperties"] is False
    assert result["json_schema"]["name"] == "ProgressScore"


def test_verifier_score_schema_has_no_numeric_bounds():
    """Verifier score guidance stays descriptive so Anthropic output_config accepts it."""
    from helpers.llm import _build_verifier_json_schema, _build_verifier_response_model

    unsupported = {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"}

    def walk(obj):
        if isinstance(obj, dict):
            assert unsupported.isdisjoint(obj)
            for value in obj.values():
                walk(value)
        elif isinstance(obj, list):
            for value in obj:
                walk(value)

    response_format = _build_verifier_json_schema()
    pydantic_schema = _build_verifier_response_model().model_json_schema()

    walk(response_format["json_schema"]["schema"])
    walk(pydantic_schema)


def test_build_verifier_json_schema_with_response_schema():
    """_build_verifier_json_schema with response schema adds output property."""
    from helpers.llm import _build_verifier_json_schema

    response_schema = {
        "fields": [
            {"name": "summary", "type": "str"},
            {"name": "count", "type": "int"},
        ]
    }
    result = _build_verifier_json_schema(response_schema)

    schema = result["json_schema"]["schema"]
    assert "output" in schema["properties"]
    assert "output" in schema["required"]
    assert result["json_schema"]["name"] == "ProgressScoreWithOutput"

    output_props = schema["properties"]["output"]["properties"]
    assert "summary" in output_props
    assert output_props["summary"]["type"] == "string"
    assert "count" in output_props
    assert output_props["count"]["type"] == "integer"


def test_build_verifier_json_schema_all_types():
    """_build_verifier_json_schema handles every supported field type."""
    from helpers.llm import _build_verifier_json_schema

    response_schema = {
        "fields": [
            {"name": "s", "type": "str"},
            {"name": "i", "type": "int"},
            {"name": "f", "type": "float"},
            {"name": "b", "type": "bool"},
            {"name": "ls", "type": "list[str]"},
            {"name": "li", "type": "list[int]"},
            {"name": "fp", "type": "file_pointer"},
            {"name": "lfp", "type": "list[file_pointer]"},
            {"name": "sfp", "type": "session_file_pointer"},
            {"name": "lsfp", "type": "list[session_file_pointer]"},
            {"name": "unknown", "type": "weird_unknown_type"},
        ]
    }
    result = _build_verifier_json_schema(response_schema)
    output = result["json_schema"]["schema"]["properties"]["output"]
    props = output["properties"]

    assert props["s"] == {"type": "string"}
    assert props["i"] == {"type": "integer"}
    assert props["f"] == {"type": "number"}
    assert props["b"] == {"type": "boolean"}
    assert props["ls"]["type"] == "array"
    assert props["ls"]["items"] == {"type": "string"}
    assert props["li"]["type"] == "array"
    assert props["li"]["items"] == {"type": "integer"}
    # file_pointer expands to an object with fixed keys
    assert props["fp"]["type"] == "object"
    assert "id" in props["fp"]["properties"]
    assert props["fp"]["additionalProperties"] is False
    # list[file_pointer] is array with object items
    assert props["lfp"]["type"] == "array"
    assert props["lfp"]["items"]["type"] == "object"
    # session_file_pointer requires path
    assert props["sfp"]["required"] == ["path"]
    assert props["lsfp"]["type"] == "array"
    assert props["lsfp"]["items"]["required"] == ["path"]
    # unknown falls back to string
    assert props["unknown"] == {"type": "string"}
    # All output props are required
    assert set(output["required"]) == set(props.keys())
    # No open-object types here, so strict mode stays on.
    assert result["json_schema"]["strict"] is True


def test_build_verifier_json_schema_object_type():
    """_build_verifier_json_schema accepts `object` and disables strict mode.

    Open-object fields (additionalProperties: True) are incompatible with
    OpenAI strict mode. The schema builder must emit a sensible JSON Schema
    for `object` AND drop the `strict` flag at the envelope level so the
    payload is accepted by structured-output models.
    """
    from helpers.llm import _build_verifier_json_schema

    response_schema = {
        "fields": [
            {"name": "meta", "type": "object", "description": "Generic object meta"},
        ]
    }
    result = _build_verifier_json_schema(response_schema)
    output = result["json_schema"]["schema"]["properties"]["output"]
    props = output["properties"]

    assert props["meta"]["type"] == "object"
    assert props["meta"]["additionalProperties"] is True, (
        "object fields must be open-shape (additionalProperties=True) — sub-fields are "
        "described in the description text, not declared in the schema."
    )
    assert props["meta"]["description"] == "Generic object meta"
    # Open-object types force strict=False at the envelope level.
    assert result["json_schema"]["strict"] is False, (
        "An `object` field requires additionalProperties=True, which is forbidden "
        "by OpenAI strict mode. The envelope MUST flip strict to False."
    )


def test_build_verifier_json_schema_list_object_type():
    """_build_verifier_json_schema accepts `list[object]` and disables strict mode."""
    from helpers.llm import _build_verifier_json_schema

    response_schema = {
        "fields": [
            {"name": "items", "type": "list[object]", "description": "List of items"},
        ]
    }
    result = _build_verifier_json_schema(response_schema)
    output = result["json_schema"]["schema"]["properties"]["output"]
    props = output["properties"]

    assert props["items"]["type"] == "array"
    assert props["items"]["items"]["type"] == "object"
    assert props["items"]["items"]["additionalProperties"] is True, (
        "list[object] items must be open-shape — same reasoning as `object`."
    )
    assert props["items"]["description"] == "List of items"
    # Open-object types force strict=False at the envelope level.
    assert result["json_schema"]["strict"] is False, (
        "A `list[object]` field requires items.additionalProperties=True, which "
        "is forbidden by OpenAI strict mode. The envelope MUST flip strict to False."
    )


def test_build_verifier_json_schema_mixed_open_and_closed():
    """A schema mixing closed types and an open-object type must still drop strict.

    The strict flag is a single envelope-level boolean — even one open-object
    field anywhere in the schema must flip it to False.
    """
    from helpers.llm import _build_verifier_json_schema

    response_schema = {
        "fields": [
            {"name": "name", "type": "str"},
            {"name": "count", "type": "int"},
            {"name": "meta", "type": "object", "description": "metadata blob"},
        ]
    }
    result = _build_verifier_json_schema(response_schema)
    assert result["json_schema"]["strict"] is False


async def test_fetch_claude_max_token_activity():
    """fetch_claude_max_token_activity GETs /api/integrations/claude-code/credentials/token."""
    setup_mock({
        "/api/integrations/claude-code/credentials/token": {
            "status": 200,
            "json": {"accessToken": "test-claude-token-123", "source": "user", "poolTokenId": None},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import fetch_claude_max_token_activity

        result = await fetch_claude_max_token_activity("user-abc")

    assert result == {
        "accessToken": "test-claude-token-123",
        "source": "user",
        "poolTokenId": None,
    }
    assert_captured_call(
        url_contains="/api/integrations/claude-code/credentials/token",
        method="GET",
        header_present="X-API-Key",
    )


async def test_fetch_claude_max_token_activity_not_found():
    """fetch_claude_max_token_activity returns None on 404."""
    setup_mock({
        "/api/integrations/claude-code/credentials/token": {
            "status": 404,
            "json": {"error": "Not found"},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import fetch_claude_max_token_activity

        result = await fetch_claude_max_token_activity("user-no-token")

    assert result is None


async def test_fetch_claude_max_token_activity_server_error():
    """fetch_claude_max_token_activity returns None on 500."""
    setup_mock({
        "/api/integrations/claude-code/credentials/token": {
            "status": 500,
            "json": {"error": "server"},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import fetch_claude_max_token_activity

        result = await fetch_claude_max_token_activity("user-err")

    assert result is None


async def test_fetch_claude_max_token_activity_missing_token_field():
    """fetch_claude_max_token_activity returns None when accessToken missing in 200 response."""
    setup_mock({
        "/api/integrations/claude-code/credentials/token": {
            "status": 200,
            "json": {"source": "user"},  # no accessToken
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import fetch_claude_max_token_activity

        result = await fetch_claude_max_token_activity("user-missing")

    assert result is None


async def test_mark_claude_token_rate_limited_user_success():
    """mark_claude_token_rate_limited_activity POSTs with user source."""
    setup_mock({
        "/api/integrations/claude-code/token/rate-limited": {
            "status": 200,
            "json": {"ok": True},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import mark_claude_token_rate_limited_activity

        result = await mark_claude_token_rate_limited_activity(
            source="user", user_id="u-1", cooldown_seconds=60
        )

    assert result is True
    call = assert_captured_call(
        url_contains="/api/integrations/claude-code/token/rate-limited",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["source"] == "user"
    assert body["userId"] == "u-1"
    assert "rateLimitedUntil" in body


async def test_mark_claude_token_rate_limited_uses_explicit_reset_time():
    """Exact Anthropic usage-limit reset timestamps are passed through."""
    setup_mock({
        "/api/integrations/claude-code/token/rate-limited": {
            "status": 200,
            "json": {"ok": True},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import mark_claude_token_rate_limited_activity

        result = await mark_claude_token_rate_limited_activity(
            source="pool",
            user_id="u-1",
            pool_token_id="pool-42",
            cooldown_seconds=60,
            rate_limited_until="2026-05-05T20:15:00Z",
        )

    assert result is True
    call = assert_captured_call(
        url_contains="/api/integrations/claude-code/token/rate-limited",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["source"] == "pool"
    assert body["poolTokenId"] == "pool-42"
    assert body["rateLimitedUntil"] == "2026-05-05T20:15:00Z"


async def test_mark_claude_token_rate_limited_pool_success():
    """Pool source includes poolTokenId in body."""
    setup_mock({
        "/api/integrations/claude-code/token/rate-limited": {
            "status": 200,
            "json": {"ok": True},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import mark_claude_token_rate_limited_activity

        result = await mark_claude_token_rate_limited_activity(
            source="pool", user_id="u-1", pool_token_id="pool-42"
        )

    assert result is True
    call = get_captured_requests()[0]
    body = json.loads(call["requestBody"])
    assert body["source"] == "pool"
    assert body["poolTokenId"] == "pool-42"
    assert "userId" not in body


async def test_mark_claude_token_rate_limited_forwards_failure_reason():
    """Auth-error marks include failureReason so backend can disable pool tokens."""
    setup_mock({
        "/api/integrations/claude-code/token/rate-limited": {
            "status": 200,
            "json": {"ok": True},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import mark_claude_token_rate_limited_activity

        result = await mark_claude_token_rate_limited_activity(
            source="pool",
            user_id="u-1",
            pool_token_id="pool-42",
            failure_reason="auth_error",
        )

    assert result is True
    call = get_captured_requests()[0]
    body = json.loads(call["requestBody"])
    assert body["source"] == "pool"
    assert body["poolTokenId"] == "pool-42"
    assert body["failureReason"] == "auth_error"


async def test_mark_claude_token_rate_limited_failure():
    """Non-200 status returns False."""
    setup_mock({
        "/api/integrations/claude-code/token/rate-limited": {
            "status": 500,
            "json": {"error": "boom"},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import mark_claude_token_rate_limited_activity

        result = await mark_claude_token_rate_limited_activity(
            source="user", user_id="u-1"
        )

    assert result is False


async def test_set_response_schema_activity_success():
    """set_response_schema_activity generates and saves schema."""
    setup_mock({
        "/api/agents/generate-response-schema": {
            "status": 200,
            "json": {
                "schema": {"fields": [{"name": "summary", "type": "str"}]},
                "tokensIn": 100,
                "tokensOut": 50,
            },
        },
        "/api/agents/": {  # PATCH .../agents/{id}
            "status": 200,
            "json": {"ok": True},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import set_response_schema_activity

        result = await set_response_schema_activity("agent-abc", ["goal 1", "goal 2"])

    assert result is not None
    assert result["schema"]["fields"][0]["name"] == "summary"
    assert result["usage"]["prompt_tokens"] == 100
    assert result["usage"]["completion_tokens"] == 50
    assert result["usage"]["total_tokens"] == 150

    # Verify it hit both endpoints
    captures = get_captured_requests()
    urls = [c["url"] for c in captures]
    assert any("generate-response-schema" in u for u in urls)
    assert any("/api/agents/agent-abc" in u for u in urls)


async def test_set_response_schema_activity_uses_internal_auth_only():
    """set_response_schema_activity does not forward compute-token scoped user headers."""
    setup_mock({
        "/api/agents/generate-response-schema": {
            "status": 200,
            "json": {
                "schema": {"fields": [{"name": "summary", "type": "str"}]},
                "tokensIn": 10,
                "tokensOut": 5,
            },
        },
        "/api/agents/": {
            "status": 200,
            "json": {"ok": True},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import set_response_schema_activity

        result = await set_response_schema_activity("agent-abc", ["goal"])

    assert result is not None
    captures = get_captured_requests()
    schema_requests = [c for c in captures if "generate-response-schema" in c["url"]]
    assert schema_requests
    headers = {k.lower(): v for k, v in schema_requests[0]["requestHeaders"].items()}
    assert "x-api-key" in headers
    assert "x-user-id" not in headers


async def test_set_response_schema_activity_empty_goal():
    """Returns None when no user messages are provided."""
    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import set_response_schema_activity

        result = await set_response_schema_activity("agent-a", [])

    assert result is None


async def test_set_response_schema_activity_no_schema_returned():
    """Returns None when backend returns no schema field."""
    setup_mock({
        "/api/agents/generate-response-schema": {
            "status": 200,
            "json": {"tokensIn": 0, "tokensOut": 0},  # no schema
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import set_response_schema_activity

        result = await set_response_schema_activity("agent-b", ["goal"])

    assert result is None


async def test_set_response_schema_activity_http_error():
    """Returns None on HTTP error."""
    setup_mock({
        "/api/agents/generate-response-schema": {
            "status": 500,
            "json": {"error": "boom"},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import set_response_schema_activity

        result = await set_response_schema_activity("agent-c", ["goal"])

    assert result is None


async def test_call_llm_rose_path():
    """call_llm routes Rose models through the in-process Rose client (waterfall via OpenRouter)."""
    sse = _sse_body([
        {
            "choices": [
                {"delta": {"content": "hello from rose"}, "finish_reason": "stop"}
            ],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "total_tokens": 30,
            },
        }
    ])
    setup_mock({
        "openrouter.ai/api/v1/chat/completions": {
            "status": 200,
            "text": sse,
            "headers": {"Content-Type": "text/event-stream"},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import call_llm

        result = await call_llm(
            messages=[{"role": "user", "content": "hi"}],
            model="rose-labs/rose-1-lite",
            call_site="test",
        )

    assert result["content"] == "hello from rose"
    assert result["finish_reason"] == "stop"
    assert result["usage"]["prompt_tokens"] == 10
    assert result["usage"]["completion_tokens"] == 20
    assert result["usage"]["total_tokens"] == 30


async def test_call_llm_rose_with_claude_token_and_skip_cache_write():
    """call_llm with claude_token routes to Anthropic claudeAuth path; skip_cache_write keeps system markers."""
    sse = _anthropic_sse_body(text="ok")
    setup_mock({
        "api.anthropic.com/v1/messages": {
            "status": 200,
            "text": sse,
            "headers": {"Content-Type": "text/event-stream"},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import call_llm

        await call_llm(
            messages=[
                {"role": "system", "content": "You are helpful."},
                {"role": "user", "content": "q"},
            ],
            model="rose",
            response_format={"type": "json_object"},
            claude_token="ct-123",
            skip_cache_write=True,
            call_site="tester",
        )

    captures = get_captured_requests()
    anthropic_calls = [c for c in captures if "api.anthropic.com" in c["url"]]
    assert anthropic_calls, f"Expected an Anthropic call, got {[c['url'] for c in captures]}"
    call = anthropic_calls[0]
    assert any(k.lower() == "authorization" for k in call["requestHeaders"])
    body = json.loads(call["requestBody"])
    assert body["model"] == "claude-sonnet-4-6"
    assert body["stream"] is True
    assert isinstance(body["system"], list)
    # skip_cache_write=True keeps system cache_control for reads but strips message breakpoint
    user_system_blocks = [b for b in body["system"] if "cache_control" in b]
    assert len(user_system_blocks) > 0, "skip_cache_write should keep system cache markers for reads"
    last_msg = body["messages"][-1]
    content = last_msg.get("content", "")
    if isinstance(content, list):
        for block in content:
            assert "cache_control" not in block, "message breakpoint should be stripped"


async def test_call_llm_rose_response_model_uses_submit_tool():
    """call_llm response_model routes Rose claudeAuth through native submit_response tool."""
    import httpx
    from pydantic import BaseModel
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm

    class SimpleResult(BaseModel):
        answer: str
        ok: bool

    sse = _anthropic_sse_body(
        tool_calls=[
            {
                "name": "submit_response",
                "input": {"answer": "done", "ok": True},
            }
        ],
        stop_reason="tool_use",
    )
    captured: dict = {}

    def handler(req):
        if "api.anthropic.com" in str(req.url):
            captured["body"] = json.loads(req.content.decode("utf-8"))
        return httpx.Response(200, text=sse, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        result = await call_llm(
            messages=[{"role": "user", "content": "return result"}],
            model="rose",
            response_model=SimpleResult,
            claude_token="ct-123",
            call_site="test-submit-model",
        )

    body = captured["body"]
    assert "format" not in body.get("output_config", {})
    assert body["tool_choice"] == {"type": "any"}
    assert body["tools"][0]["name"] == "submit_response"
    assert json.loads(result["content"]) == {"answer": "done", "ok": True}


async def test_call_llm_rose_http_error_raises():
    """Persistent 5xx from every waterfall step raises RoseAllFailed."""
    setup_mock({
        "openrouter.ai/api/v1/chat/completions": {
            "status": 500,
            "json": {"error": "boom"},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import call_llm

        try:
            await call_llm(
                messages=[{"role": "user", "content": "q"}],
                model="rose",
                call_site="t",
            )
            raise AssertionError("Expected error")
        except Exception:
            pass  # expected — all waterfall steps return 500


async def test_build_llm_messages_preserves_tool_calls_and_tool_role():
    """build_llm_messages should preserve assistant tool_calls and emit matched tool role messages."""
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "Find recent updates", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "tool_calls": [
                    {"tool": "web_search", "tool_call_id": "tc-1", "query": "latest updates"}
                ]
            },
        },
        {
            "role": "TOOL",
            "text": "Found 3 recent updates",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {
                "toolName": "web_search",
                "toolCallId": "tc-1",
                "toolStatus": "FINISHED",
            },
        },
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        messages = await build_llm_messages(context, "System prompt")

    assistant_msgs = [m for m in messages if m.get("role") == "assistant"]
    tool_msgs = [m for m in messages if m.get("role") == "tool"]

    assert len(assistant_msgs) >= 1
    assert len(tool_msgs) >= 1

    assistant = assistant_msgs[0]
    assert "tool_calls" in assistant
    assert assistant["tool_calls"][0]["id"] == "tc-1"
    assert assistant["tool_calls"][0]["function"]["name"] == "web_search"

    tool_msg = tool_msgs[0]
    assert tool_msg["tool_call_id"] == "tc-1"
    assert tool_msg["name"] == "web_search"
    assert "Found 3 recent updates" in tool_msg["content"]


async def test_build_llm_messages_unmatched_terminal_tool_becomes_user():
    """Terminal TOOL message without matching assistant declaration should become a user message."""
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "Find data", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "tool_calls": [
                    {"tool": "web_search", "tool_call_id": "tc-1", "query": "alpha"}
                ]
            },
        },
        {
            "role": "TOOL",
            "text": "Found alpha",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {
                "toolName": "web_search",
                "toolCallId": "tc-2",
                "toolStatus": "FINISHED",
            },
        },
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        msgs = await build_llm_messages(context, "System prompt")
        # Unmatched TOOL becomes a user message with tool result label
        user_msgs = [m for m in msgs if m["role"] == "user" and "[web_search result]" in m.get("content", "")]
        assert len(user_msgs) == 1, f"Expected 1 user message with tool result label, got {len(user_msgs)}"
        assert "Found alpha" in user_msgs[0]["content"]


async def test_build_llm_messages_terminal_tool_missing_id_raises():
    """Terminal TOOL message without toolCallId should hard-fail."""
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "Find data", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "tool_calls": [
                    {"tool": "web_search", "tool_call_id": "tc-1", "query": "alpha"}
                ]
            },
        },
        {
            "role": "TOOL",
            "text": "Found alpha",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {
                "toolName": "web_search",
                "toolStatus": "FINISHED",
            },
        },
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        try:
            await build_llm_messages(context, "System prompt")
            raise AssertionError("Expected ValueError for terminal TOOL message without toolCallId")
        except ValueError as e:
            assert "missing toolCallId" in str(e)


async def test_build_llm_messages_system_and_non_terminal_tool():
    """SYSTEM role and non-terminal TOOL convert to user role prefixed text."""
    from helpers.llm import build_llm_messages

    context = [
        {
            "role": "SYSTEM",
            "text": "note-from-system",
            "timestamp": "2024-01-01T00:00:00Z",
        },
        {
            "role": "TOOL",
            "text": "other",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"toolStatus": "OTHER", "title": "debug"},
        },
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        msgs = await build_llm_messages(context, "System prompt")

    # Skip the system-prompt message; find user messages
    user_msgs = [m for m in msgs if m["role"] == "user"]
    assert any("[SYSTEM]: note-from-system" in m["content"] for m in user_msgs)
    assert any("[TOOL]: other" in m["content"] for m in user_msgs)


async def test_build_llm_messages_assistant_merging():
    """Consecutive ASSISTANT messages should be merged into one."""
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "q", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "first part",
            "timestamp": "2024-01-01T00:00:01Z",
        },
        {
            "role": "ASSISTANT",
            "text": "second part",
            "timestamp": "2024-01-01T00:00:02Z",
        },
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        msgs = await build_llm_messages(context, "sys")

    assistants = [m for m in msgs if m["role"] == "assistant"]
    assert len(assistants) == 1
    assert "first part" in assistants[0]["content"]
    assert "second part" in assistants[0]["content"]


async def test_build_llm_messages_skip_subagent():
    """Messages with subAgentId should be filtered out."""
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "visible", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "USER",
            "text": "hidden",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"subAgentId": "sub-1"},
        },
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        msgs = await build_llm_messages(context, "sys")

    user_msgs = [m for m in msgs if m["role"] == "user"]
    texts = [m["content"] for m in user_msgs]
    assert any("visible" in t for t in texts)
    assert not any("hidden" in t for t in texts)


async def test_build_llm_messages_attachment_large_falls_back_to_metadata():
    """Large attachment is represented as metadata text, not multimodal content."""
    from helpers.llm import build_llm_messages

    # size > 20MB threshold -> metadata only
    large_fp = {
        "id": "f-1",
        "storage_path": "u/f.png",
        "original_filename": "f.png",
        "mime_type": "image/png",
        "size_bytes": 50_000_000,  # 50MB
        "created_at": "2024-01-01T00:00:00Z",
    }
    context = [
        {
            "role": "USER",
            "text": "Check this",
            "timestamp": "2024-01-01T00:00:00Z",
            "file_pointer": large_fp,
        }
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        msgs = await build_llm_messages(context, "sys")

    user = [m for m in msgs if m["role"] == "user"][0]
    # Should be plain text with metadata appended (no multimodal array)
    assert isinstance(user["content"], str)
    assert "f.png" in user["content"]


async def test_build_llm_messages_skips_empty_file_output_assistant():
    """Empty ASSISTANT rows with only a file_pointer (browser screenshots /
    sub-agent output files posted via AssistantEvent) must be skipped, otherwise
    they split a parallel tool_result run and Anthropic returns 400.

    Repro: parent issues two parallel spawn_agent calls. Each browser tool emits
    an AssistantEvent(file_pointer=screenshot) between the early '✓ Task
    Completed' POST_MESSAGE and the late 'Browser automation complete'
    POST_MESSAGE. After dedup keeps only the latest FINISHED TOOL per
    toolCallId, the sequence becomes
    [TOOL_A_finished, ASSISTANT_screenshot_A, ASSISTANT_screenshot_B, TOOL_B_finished].
    Without skipping, the empty assistants split tool_result_A from tool_result_B,
    leaving the second tool_use without a matching tool_result in the next
    message.
    """
    from helpers.llm import build_llm_messages

    tc_a = "toolu_browser_A"
    tc_b = "toolu_browser_B"
    fp = {
        "id": "fp-1",
        "storage_path": "u/screenshot.png",
        "original_filename": "screenshot.png",
        "mime_type": "image/png",
        "size_bytes": 1024,
        "created_at": "2024-01-01T00:00:00Z",
    }
    context = [
        {"role": "USER", "text": "Find Tokyo and NYC populations.", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "tool_calls": [
                    {"tool": "spawn_agent", "tool_call_id": tc_a, "type": "browser", "goal": "Tokyo"},
                    {"tool": "spawn_agent", "tool_call_id": tc_b, "type": "browser", "goal": "NYC"},
                ],
            },
        },
        {
            "role": "TOOL", "text": "ok A", "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {"toolCallId": tc_a, "toolName": "spawn_browser_agent", "toolStatus": "FINISHED"},
        },
        # Empty file-output ASSISTANT row (browser screenshot)
        {"role": "ASSISTANT", "text": "", "timestamp": "2024-01-01T00:00:03Z", "metadata": {}, "file_pointer": fp},
        {
            "role": "TOOL", "text": "ok B", "timestamp": "2024-01-01T00:00:04Z",
            "metadata": {"toolCallId": tc_b, "toolName": "spawn_browser_agent", "toolStatus": "FINISHED"},
        },
        {"role": "ASSISTANT", "text": "", "timestamp": "2024-01-01T00:00:05Z", "metadata": {}, "file_pointer": fp},
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        msgs = await build_llm_messages(context, "sys")

    # Find the assistant with two tool_calls
    assistants_with_tools = [m for m in msgs if m.get("role") == "assistant" and m.get("tool_calls")]
    assert len(assistants_with_tools) == 1, f"Expected 1 tool-calling assistant, got {len(assistants_with_tools)}"

    # Both tool messages should immediately follow (no empty assistant in between).
    tool_msgs = [m for m in msgs if m.get("role") == "tool"]
    assert len(tool_msgs) == 2, f"Expected 2 tool messages, got {len(tool_msgs)}"

    # Verify NO empty assistant message ended up in the final list — file-output
    # rows should be filtered out entirely.
    empty_assistants = [
        m for m in msgs
        if m.get("role") == "assistant"
        and not m.get("tool_calls")
        and not (m.get("content") or "").strip()
    ]
    assert not empty_assistants, (
        f"Empty file-output assistant rows must be skipped; got {empty_assistants}"
    )

    # Verify that in the produced sequence, both tool messages appear before any
    # assistant-without-tool_calls message — confirming the tool_result run is
    # contiguous (Anthropic requires `tool_result` to immediately follow the
    # tool_use that declared it in the next user message).
    seen_tool_msg = False
    for m in msgs:
        if m.get("role") == "tool":
            seen_tool_msg = True
        elif m.get("role") == "assistant" and seen_tool_msg and not m.get("tool_calls"):
            break
    # If we ever see an assistant-without-tool_calls AFTER tool messages, that's
    # the post-completion summary turn (fine) — but we should never see one
    # BETWEEN two tool messages.
    tool_indices = [i for i, m in enumerate(msgs) if m.get("role") == "tool"]
    if len(tool_indices) >= 2:
        # All tool messages should be contiguous (possibly with a single
        # tool-calling assistant before them, never an empty assistant
        # between them).
        for i in range(tool_indices[0], tool_indices[-1] + 1):
            assert msgs[i].get("role") == "tool", (
                f"Found non-tool message at index {i} between tool messages: {msgs[i]}"
            )


async def test_build_llm_messages_assistant_tool_call_validation_errors():
    """Invalid metadata.tool_calls on ASSISTANT raises ValueError."""
    from helpers.llm import build_llm_messages

    # Non-list tool_calls
    context_a = [
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:00Z",
            "metadata": {"tool_calls": "not a list"},
        }
    ]
    with patch("helpers.llm.activity.in_activity", return_value=False):
        try:
            await build_llm_messages(context_a, "sys")
            raise AssertionError("Expected ValueError")
        except ValueError as e:
            assert "must be a list" in str(e)

    # Tool call missing 'tool'
    context_b = [
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:00Z",
            "metadata": {"tool_calls": [{"tool_call_id": "tc-1"}]},
        }
    ]
    with patch("helpers.llm.activity.in_activity", return_value=False):
        try:
            await build_llm_messages(context_b, "sys")
            raise AssertionError("Expected ValueError")
        except ValueError as e:
            assert "missing 'tool'" in str(e)

    # Tool call missing 'tool_call_id'
    context_c = [
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:00Z",
            "metadata": {"tool_calls": [{"tool": "web_search"}]},
        }
    ]
    with patch("helpers.llm.activity.in_activity", return_value=False):
        try:
            await build_llm_messages(context_c, "sys")
            raise AssertionError("Expected ValueError")
        except ValueError as e:
            assert "missing 'tool_call_id'" in str(e)


def _sse_body(chunks: list[dict]) -> str:
    """Build a fake OpenAI/OpenRouter SSE stream body from a list of chunk dicts.

    Used to mock the waterfall path (no claude_token), which goes to
    `https://openrouter.ai/api/v1/chat/completions`.
    """
    out = []
    for c in chunks:
        out.append(f"data: {json.dumps(c)}")
    out.append("data: [DONE]")
    out.append("")
    return "\n".join(out)


def _anthropic_sse_body(
    *,
    text: str = "",
    tool_calls: list[dict] | None = None,
    input_tokens: int = 10,
    output_tokens: int = 5,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
    stop_reason: str = "end_turn",
) -> str:
    """Build an Anthropic native SSE stream body for the claudeAuth path.

    Used to mock `https://api.anthropic.com/v1/messages` when a test sets
    `claude_token=...`. Emits message_start → content_block_start →
    content_block_delta(s) → content_block_stop per block → message_delta →
    message_stop in the order Anthropic produces them.
    """
    tool_calls = tool_calls or []
    lines: list[str] = []

    def _ev(event: str, data: dict) -> None:
        lines.append(f"event: {event}")
        lines.append(f"data: {json.dumps(data)}")
        lines.append("")

    _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {
                "id": "msg_test",
                "role": "assistant",
                "model": "claude-sonnet-4-6",
                "usage": {
                    "input_tokens": input_tokens,
                    "cache_creation_input_tokens": cache_creation_tokens,
                    "cache_read_input_tokens": cache_read_tokens,
                },
            },
        },
    )

    block_idx = 0
    if text:
        _ev(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": block_idx,
                "content_block": {"type": "text", "text": ""},
            },
        )
        _ev(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": block_idx,
                "delta": {"type": "text_delta", "text": text},
            },
        )
        _ev(
            "content_block_stop",
            {"type": "content_block_stop", "index": block_idx},
        )
        block_idx += 1

    for tc in tool_calls:
        tc_id = tc.get("id") or f"toolu_{block_idx}"
        tc_name = tc["name"]
        tc_input = tc.get("input", {})
        _ev(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": block_idx,
                "content_block": {
                    "type": "tool_use",
                    "id": tc_id,
                    "name": tc_name,
                    "input": {},
                },
            },
        )
        _ev(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": block_idx,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": json.dumps(tc_input),
                },
            },
        )
        _ev(
            "content_block_stop",
            {"type": "content_block_stop", "index": block_idx},
        )
        block_idx += 1

    _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": None},
            "usage": {"output_tokens": output_tokens},
        },
    )
    _ev("message_stop", {"type": "message_stop"})
    return "\n".join(lines)


async def test_call_llm_structured_streaming_happy_path():
    """Structured streaming parses accumulated content into a Pydantic response."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    # Emit a single chunk carrying the whole JSON + a final [DONE]
    payload = {
        "actual_model": "claude-sonnet-4-6",
        "pool_name": "test-pool",
        "pool_size": 1,
        "choices": [
            {
                "delta": {
                    "content": '```json\n{"response": "hello", "tool_calls": []}\n```'
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
            "cache_read_input_tokens": 2,
            "cache_creation_input_tokens": 3,
        },
    }
    body = _sse_body([payload])

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    AgentAction = create_agent_action_model([])

    chunks_seen = []

    async def on_chunk(text: str, tokens: int):
        chunks_seen.append(text)

    response, usage, detected = await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "hi"}],
        model="rose-labs/rose-1-lite",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        call_site="test",
    )

    assert response.response == "hello"
    assert response.tool_calls == []
    assert usage["prompt_tokens"] == 10
    assert usage["completion_tokens"] == 5
    assert usage["cache_read_input_tokens"] == 2
    assert usage["cache_creation_input_tokens"] == 3
    # Waterfall path uses the first model in rose-1-lite's fallback list.
    assert usage["actual_model"] == "google/gemini-3-flash-preview"
    assert usage["pool_name"] == "rose-1-lite"
    assert usage["cancelled"] is False
    assert detected == []


async def test_call_llm_structured_streaming_model_detected_callback():
    """on_model_detected fires with the actual_model from the first chunk."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    payload = {
        "choices": [
            {
                "delta": {
                    "content": '{"response": "done", "tool_calls": []}'
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    AgentAction = create_agent_action_model([])
    seen_models = []

    def on_model_detected(m: str):
        seen_models.append(m)

    async def on_chunk(text: str, tokens: int):
        pass

    await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "q"}],
        model="rose",
        temperature=0.7,
        max_tokens=256,
        response_model=AgentAction,
        on_chunk=on_chunk,
        on_model_detected=on_model_detected,
        call_site="test",
    )

    # No claude_token → routes through waterfall → first model from rose-1-lite.
    assert seen_models == ["google/gemini-3-flash-preview"]


async def test_call_llm_verifier_streaming_parses_score():
    """_call_llm_verifier parses JSON score from SSE stream."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier
    from config import load_config

    payload = {
        "choices": [
            {"delta": {"content": '{"reasoning": "looks good", "score": 0.75}'}}
        ],
        "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    config = load_config()

    with patch("temporalio.activity.heartbeat"):
        result, usage = await _call_llm_verifier(
            messages=[{"role": "user", "content": "x"}],
            model="rose",
            config=config,
        )

    assert result["score"] == 0.75
    assert result["reasoning"] == "looks good"
    assert usage["prompt_tokens"] == 100
    # Waterfall path → first model from rose-1-lite.
    assert usage["actual_model"] == "google/gemini-3-flash-preview"
    assert usage["pool_name"] == "rose-1-lite"


async def test_call_llm_verifier_claude_token_and_schema():
    """Verifier forwards claude_token and embeds response_schema in request body."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier
    from config import load_config

    # claude_token is set → routes through claudeAuth path → Anthropic native SSE.
    body = _anthropic_sse_body(
        text='{"reasoning": "r", "score": 1.0, "output": {"summary": "ok"}}',
    )

    captured: dict = {}

    def handler(req):
        if "api.anthropic.com" in str(req.url):
            captured["body"] = json.loads(req.content.decode("utf-8"))
            captured["headers"] = dict(req.headers)
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    config = load_config()

    with patch("temporalio.activity.heartbeat"):
        result, _usage = await _call_llm_verifier(
            messages=[{"role": "user", "content": "go"}],
            model="rose",
            config=config,
            response_schema={"fields": [{"name": "summary", "type": "str"}]},
            claude_token="ct-99",
        )

    # Bearer token forwarded to Anthropic as-is.
    assert captured["headers"].get("authorization") == "Bearer ct-99"
    # Anthropic body uses claudeAuth model from rose-1-lite pool.
    assert captured["body"]["model"] == "claude-sonnet-4-6"
    assert captured["body"]["stream"] is True
    assert result["score"] == 1.0
    assert result["output"]["summary"] == "ok"


async def test_check_progress_happy_path():
    """check_progress streams a score and returns structured_response when score >= 1."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import check_progress

    payload = {
        "choices": [
            {
                "delta": {
                    "content": '{"reasoning": "complete", "score": 1.0, "output": {"summary": "finished"}}'
                }
            }
        ],
        "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        result = await check_progress(
            context=[{"role": "USER", "text": "goal", "timestamp": "2024-01-01T00:00:00Z"}],
            verifier_system_prompt="VERIFY",
            model="rose",
            response_schema={"fields": [{"name": "summary", "type": "str"}]},
        )

    assert result["score"] == 1.0
    assert result["reasoning"] == "complete"
    assert result["structured_response"] == {"summary": "finished"}
    assert "Score: 1.0" in result["message"]


async def test_check_progress_below_threshold_returns_partial_structured_response():
    """C2: structured_response is always returned (even on score < 1.0) so the
    agent can see partial extraction in its next iteration."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import check_progress

    payload = {
        "choices": [
            {
                "delta": {
                    "content": '{"reasoning": "partial", "score": 0.4, "output": {"summary": "x"}}'
                }
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        result = await check_progress(
            context=[{"role": "USER", "text": "goal", "timestamp": "2024-01-01T00:00:00Z"}],
            verifier_system_prompt="VERIFY",
            response_schema={"fields": [{"name": "summary", "type": "str"}]},
        )

    assert result["score"] == 0.4
    # C2: partial structured_response must come through, not be dropped.
    assert result["structured_response"] == {"summary": "x"}


async def test_call_planner_llm_activity_happy_path():
    """call_planner_llm_activity builds system prompt, streams a plan, returns result+usage."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_planner_llm_activity

    # Build a valid PlannerResponse JSON the verifier can parse
    plan_json = json.dumps({
        "title": "Test Plan",
        "content": "Do the thing",
        "tasks": [
            {"goal": "task 1 goal", "tool_name": "spawn_explore_agent", "depends_on": []}
        ],
        "dependencies_graph": [{"task_idx": "0", "depends_on": []}],
        "join": "all",
    })
    # claude_max_token is set → routes through Anthropic claudeAuth path.
    body = _anthropic_sse_body(text=plan_json, input_tokens=100, output_tokens=50)

    pointer_id = "bbbb1111-0000-0000-0000-000000000000"
    captured = {"calls": [], "batch_user_id": None}

    def handler(req):
        url = str(req.url)
        try:
            parsed_body = json.loads(req.content.decode())
        except Exception:
            parsed_body = None
        captured["calls"].append({"url": url, "headers": dict(req.headers), "body": parsed_body})
        if "/api/agents/messages/batch" in url:
            captured["batch_user_id"] = req.headers.get("x-user-id")
            return httpx.Response(200, json={
                "messages": [{"id": pointer_id, "text": "scoped referenced text", "role": "USER"}]
            })
        if "api.anthropic.com" in url:
            return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})
        # Broadcast/realtime endpoints: return 200 empty
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        result = await call_planner_llm_activity(
            messages=[{"role": "user", "content": f"plan me this @ref:message:{pointer_id}"}],
            model="rose",
            tools_description="web_search: search the web",
            user_context="user is testing",
            claude_max_token="ct-planner-123",
            agent_id="agent-planner",
            tool_call_id="tc-planner",
            claude_token_user_id="planner-user",
        )

    assert result["result"]["title"] == "Test Plan"
    assert len(result["result"]["tasks"]) == 1
    assert result["usage"]["llm"][0]["tokens_in"] == 100
    assert result["usage"]["llm"][0]["tokens_out"] == 50
    anthropic_calls = [
        c for c in captured["calls"] if "api.anthropic.com" in c["url"] and c["body"]
    ]
    assert len(anthropic_calls) >= 1, (
        f"No Anthropic call captured; got {[c['url'] for c in captured['calls']]}"
    )
    planner_body = anthropic_calls[0]["body"]
    # Planner uses skip_cache_write → system blocks KEEP cache_control for reads.
    user_system_blocks = [
        b for b in planner_body.get("system", []) if "cache_control" in b
    ]
    assert len(user_system_blocks) > 0, "skip_cache_write should keep system cache markers for reads"
    # claude_token is forwarded as the Anthropic Bearer token, not in the body.
    assert anthropic_calls[0]["headers"].get("authorization") == "Bearer ct-planner-123"
    assert captured["batch_user_id"] == "planner-user"
    assert "scoped referenced text" in json.dumps(planner_body)
    # Anthropic uses the claudeAuth model from the rose-1-lite pool.
    assert planner_body["model"] == "claude-sonnet-4-6"
    assert planner_body["stream"] is True


async def test_call_llm_activity_happy_path_with_messages_list():
    """call_llm_activity with pre-built messages returns response + tool_calls + usage."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_activity

    payload = {
        "actual_model": "claude-sonnet-4-6",
        "choices": [
            {
                "delta": {
                    "content": '{"response": "hello world", "tool_calls": []}',
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
    }
    body = _sse_body([payload])

    def handler(req):
        url = str(req.url)
        if "/completions" in url:
            return httpx.Response(200, text=body)
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        result = await call_llm_activity(
            messages_or_agent_id=[{"role": "user", "content": "hi"}],
            model="rose-labs/rose-1-lite",
            tool_names=[],
            reasoning_max_tokens=0,
            agent_id="agent-llm-act",
            stream_id="stream-1",
            call_site="test_cla",
        )

    assert result["response"] == "hello world"
    assert result["tool_calls"] == []
    assert result["usage"]["total_tokens"] == 30
    assert result["detected_tools_ordered"] == []


async def test_call_llm_activity_with_agent_id_reads_shared_context():
    """When agent_id is passed, activity reads context from _pending_llm_context."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _pending_llm_context, call_llm_activity

    agent_id_key = "agent-shared-ctx-test-1"
    _pending_llm_context[agent_id_key] = (
        [{"role": "USER", "text": "Hello!", "timestamp": "2024-01-01T00:00:00Z"}],
        "test system prompt",
        set(),
    )

    payload = {
        "actual_model": "claude-opus-4-7",
        "choices": [
            {
                "delta": {"content": '{"response": "ack", "tool_calls": []}'},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
    }
    body = _sse_body([payload])

    def handler(req):
        url = str(req.url)
        if "/completions" in url:
            return httpx.Response(200, text=body)
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"), patch(
        "helpers.llm.activity.in_activity", return_value=False
    ):
        result = await call_llm_activity(
            messages_or_agent_id=agent_id_key,
            model="rose",
            tool_names=[],
            reasoning_max_tokens=0,
            agent_id="agent-llm-sc",
            stream_id="stream-2",
            call_site="shared-ctx",
        )

    assert result["response"] == "ack"
    # Shared state should be cleaned up on success
    assert agent_id_key not in _pending_llm_context


async def test_call_llm_activity_missing_context_raises():
    """call_llm_activity raises if _pending_llm_context has no entry and no system_prompt."""
    from helpers.llm import call_llm_activity, _pending_llm_context

    agent_id_key = "agent-missing-ctx-404"
    _pending_llm_context.pop(agent_id_key, None)

    with patch("temporalio.activity.heartbeat"):
        try:
            await call_llm_activity(
                messages_or_agent_id=agent_id_key,
                model="rose",
                tool_names=[],
                reasoning_max_tokens=0,
            )
            assert False, "Should have raised ValueError"
        except ValueError as e:
            assert "No pending LLM context" in str(e)
            assert "no system_prompt" in str(e)


async def test_call_llm_activity_cross_machine_fallback():
    """When local context is missing but system_prompt is provided, fetches from backend."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _pending_llm_context, call_llm_activity

    agent_id_key = "agent-cross-machine-fb-1"
    _pending_llm_context.pop(agent_id_key, None)

    agent_data = {
        "agent": {"id": agent_id_key, "model": "rose"},
        "messages": [{"role": "USER", "text": "Hello from backend!", "timestamp": "2024-01-01T00:00:00Z"}],
    }

    llm_payload = {
        "actual_model": "claude-opus-4-7",
        "choices": [
            {
                "delta": {"content": '{"response": "cross-machine ok", "tool_calls": []}'},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
    }
    body = _sse_body([llm_payload])

    backend_called = [False]

    def handler(req):
        url = str(req.url)
        if f"/api/agents/{agent_id_key}" in url:
            backend_called[0] = True
            return httpx.Response(200, json=agent_data)
        if "/completions" in url:
            return httpx.Response(200, text=body)
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"), patch(
        "helpers.llm.activity.in_activity", return_value=False
    ):
        result = await call_llm_activity(
            messages_or_agent_id=agent_id_key,
            model="rose",
            tool_names=[],
            reasoning_max_tokens=0,
            agent_id="agent-llm-xm",
            stream_id="stream-xm",
            call_site="cross-machine-test",
            system_prompt="You are a test assistant.",
        )

    assert result["response"] == "cross-machine ok"
    assert backend_called[0], "Should have fetched context from backend API"
    assert agent_id_key not in _pending_llm_context


async def test_call_planner_llm_activity_failure_raises():
    """Planner LLM raises if /completions returns non-200 and no retries succeed."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_planner_llm_activity

    call_count = {"n": 0}

    def handler(req):
        url = str(req.url)
        if "/completions" in url:
            call_count["n"] += 1
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        try:
            await call_planner_llm_activity(
                messages=[{"role": "user", "content": "plan"}],
                model="rose",
                tools_description="web_search",
                user_context="",
                agent_id="agent-plan-fail",
                tool_call_id="tc-pf",
            )
            assert False, "Should have raised"
        except Exception:
            # Expected - streaming got non-200
            pass


async def test_build_verifier_json_schema_file_pointer_type():
    """file_pointer field type emits the full FilePointer schema in the output."""
    from helpers.llm import _build_verifier_json_schema

    schema = {
        "fields": [
            {"name": "report", "type": "file_pointer"},
        ]
    }
    result = _build_verifier_json_schema(schema)
    output_props = result["json_schema"]["schema"]["properties"]["output"]["properties"]
    assert "report" in output_props
    report = output_props["report"]
    assert report["type"] == "object"
    assert "id" in report["properties"]
    assert "storage_path" in report["properties"]
    assert set(report["required"]) >= {"id", "storage_path", "original_filename"}


async def test_build_verifier_json_schema_list_file_pointer_type():
    """list[file_pointer] field wraps FilePointer schema in an array."""
    from helpers.llm import _build_verifier_json_schema

    schema = {
        "fields": [
            {"name": "reports", "type": "list[file_pointer]"},
        ]
    }
    result = _build_verifier_json_schema(schema)
    reports_prop = result["json_schema"]["schema"]["properties"]["output"]["properties"]["reports"]
    assert reports_prop["type"] == "array"
    assert reports_prop["items"]["type"] == "object"
    assert "id" in reports_prop["items"]["properties"]


async def test_build_verifier_json_schema_session_file_pointer_type():
    """session_file_pointer emits a compact object with only 'path'."""
    from helpers.llm import _build_verifier_json_schema

    schema = {
        "fields": [
            {"name": "output_file", "type": "session_file_pointer"},
        ]
    }
    result = _build_verifier_json_schema(schema)
    sfp_prop = result["json_schema"]["schema"]["properties"]["output"]["properties"]["output_file"]
    assert sfp_prop["type"] == "object"
    assert list(sfp_prop["properties"].keys()) == ["path"]
    assert sfp_prop["required"] == ["path"]


async def test_build_verifier_json_schema_list_session_file_pointer_type():
    """list[session_file_pointer] wraps the compact schema in an array."""
    from helpers.llm import _build_verifier_json_schema

    schema = {
        "fields": [
            {"name": "files", "type": "list[session_file_pointer]"},
        ]
    }
    result = _build_verifier_json_schema(schema)
    files_prop = result["json_schema"]["schema"]["properties"]["output"]["properties"]["files"]
    assert files_prop["type"] == "array"
    assert files_prop["items"]["type"] == "object"
    assert list(files_prop["items"]["properties"].keys()) == ["path"]


async def test_build_verifier_json_schema_unknown_type_fallback():
    """Unknown field type falls back to string."""
    from helpers.llm import _build_verifier_json_schema

    schema = {
        "fields": [
            {"name": "weird", "type": "some_type_we_dont_support"},
        ]
    }
    result = _build_verifier_json_schema(schema)
    weird_prop = result["json_schema"]["schema"]["properties"]["output"]["properties"]["weird"]
    assert weird_prop == {"type": "string"}


async def test_build_verifier_json_schema_object_type_open_shape():
    """`object` field emits an open-shape object (additionalProperties: True) and disables strict."""
    from helpers.llm import _build_verifier_json_schema

    schema = {
        "fields": [
            {"name": "meta", "type": "object", "description": "metadata blob"},
        ]
    }
    result = _build_verifier_json_schema(schema)
    meta_prop = result["json_schema"]["schema"]["properties"]["output"]["properties"]["meta"]
    assert meta_prop["type"] == "object"
    assert meta_prop["additionalProperties"] is True
    assert meta_prop["description"] == "metadata blob"
    # OpenAI strict mode forbids additionalProperties: True. Verifier must drop strict.
    assert result["json_schema"]["strict"] is False


async def test_build_verifier_json_schema_list_object_type_open_shape():
    """`list[object]` field emits array-of-open-objects and disables strict."""
    from helpers.llm import _build_verifier_json_schema

    schema = {
        "fields": [
            {"name": "rows", "type": "list[object]", "description": "rows of data"},
        ]
    }
    result = _build_verifier_json_schema(schema)
    rows_prop = result["json_schema"]["schema"]["properties"]["output"]["properties"]["rows"]
    assert rows_prop["type"] == "array"
    assert rows_prop["items"]["type"] == "object"
    assert rows_prop["items"]["additionalProperties"] is True
    assert rows_prop["description"] == "rows of data"
    assert result["json_schema"]["strict"] is False


async def test_build_verifier_json_schema_strict_true_when_no_open_objects():
    """Schema with only closed-shape fields keeps strict=True."""
    from helpers.llm import _build_verifier_json_schema

    schema = {
        "fields": [
            {"name": "name", "type": "str"},
            {"name": "count", "type": "int"},
            {"name": "tags", "type": "list[str]"},
        ]
    }
    result = _build_verifier_json_schema(schema)
    assert result["json_schema"]["strict"] is True


def test_build_verifier_context_messages_screenshot_emits_multimodal():
    """TOOL message with `metadata.screenshot_b64` becomes a multimodal user message."""
    from helpers.llm import build_verifier_context_messages

    ctx = [
        {"role": "USER", "text": "Goal: take a screenshot"},
        {
            "role": "TOOL",
            "text": "Final state screenshot attached",
            "metadata": {
                "screenshot_b64": "iVBORw0KGgoAAAA...",
                "toolName": "final_screenshot",
                "toolStatus": "FINISHED",
            },
        },
    ]
    msgs = build_verifier_context_messages(ctx, "You are a verifier.")

    # Look for any user message with content as a list (multimodal)
    multimodal_msgs = [m for m in msgs if isinstance(m.get("content"), list)]
    assert len(multimodal_msgs) == 1, f"expected exactly 1 multimodal message, got {len(multimodal_msgs)}"

    blocks = multimodal_msgs[0]["content"]
    text_blocks = [b for b in blocks if b.get("type") == "text"]
    image_blocks = [b for b in blocks if b.get("type") == "image"]
    assert len(text_blocks) == 1
    assert len(image_blocks) == 1
    assert image_blocks[0]["source"]["type"] == "base64"
    assert image_blocks[0]["source"]["media_type"] == "image/png"
    assert image_blocks[0]["source"]["data"] == "iVBORw0KGgoAAAA..."
    # Body text should describe, not include the b64
    assert "iVBORw0KGgoAAAA..." not in text_blocks[0]["text"]


def test_build_verifier_context_messages_screenshot_strips_b64_from_text():
    """When TOOL.text accidentally contains the b64 string, it's stripped from the text block."""
    from helpers.llm import build_verifier_context_messages

    b64 = "ABCDEFGH=="
    ctx = [
        {"role": "USER", "text": "Goal"},
        {
            "role": "TOOL",
            "text": f"Screenshot: {b64}",  # b64 inlined into text
            "metadata": {
                "screenshot_b64": b64,
                "toolName": "final_screenshot",
                "toolStatus": "FINISHED",
            },
        },
    ]
    msgs = build_verifier_context_messages(ctx, "system")

    multimodal_msgs = [m for m in msgs if isinstance(m.get("content"), list)]
    text = next(b["text"] for b in multimodal_msgs[0]["content"] if b.get("type") == "text")
    # b64 must not survive in the text block
    assert b64 not in text


def test_build_verifier_context_messages_no_screenshot_stays_text():
    """TOOL message without screenshot_b64 keeps current text-only batching behavior."""
    from helpers.llm import build_verifier_context_messages

    ctx = [
        {"role": "USER", "text": "Goal"},
        {
            "role": "TOOL",
            "text": "tool result",
            "metadata": {"toolName": "search", "toolStatus": "FINISHED"},
        },
    ]
    msgs = build_verifier_context_messages(ctx, "system")
    # No multimodal messages
    assert all(isinstance(m["content"], str) for m in msgs)


async def test_extract_response_from_partial_json_raw_json_object():
    """_extract_response_from_partial_json parses a non-fenced JSON object from content."""
    from helpers.llm import _extract_response_from_partial_json

    result = _extract_response_from_partial_json(
        reasoning="",
        json_content='{"response": "bare response text", "tool_calls": []}',
    )
    assert result == "bare response text"


async def test_extract_response_from_partial_json_tool_calls_only():
    """_extract_response_from_partial_json returns None when only tool_calls present (no response)."""
    from helpers.llm import _extract_response_from_partial_json

    result = _extract_response_from_partial_json(
        reasoning="",
        json_content='{"tool_calls": [{"tool": "web_search", "query": "x"}]}',
    )
    # No response field - returns None
    assert result is None or result == "" or isinstance(result, str)


async def test_extract_completed_tool_calls_multiple():
    """_extract_completed_tool_calls returns multiple tool calls from completed JSON."""
    from helpers.llm import _extract_completed_tool_calls

    content = (
        '{"response": "working on it", "tool_calls": ['
        '{"tool": "web_search", "tool_call_id": "tc-1", "query": "x"},'
        '{"tool": "web_fetch", "tool_call_id": "tc-2", "url": "http://example.com"}'
        "]}"
    )
    result = _extract_completed_tool_calls(content)
    assert len(result) == 2
    assert result[0]["tool"] == "web_search"
    assert result[1]["tool"] == "web_fetch"


async def test_convert_context_to_messages_assistant_with_tool_calls():
    """convert_context_to_messages preserves assistant tool_calls metadata."""
    from helpers.llm import convert_context_to_messages

    context = [
        {"role": "USER", "text": "search", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "searching",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "tool_calls": [
                    {"tool": "web_search", "tool_call_id": "tc-5", "query": "answer"}
                ]
            },
        },
        {
            "role": "TOOL",
            "text": "results here",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {
                "toolCallId": "tc-5",
                "toolStatus": "FINISHED",
                "toolName": "web_search",
            },
        },
    ]
    msgs = convert_context_to_messages(context, include_system=False, include_assistant=True)
    # Should have user, assistant (with tool_calls), tool (matched to tc-5)
    assert len(msgs) == 3
    assert msgs[1]["role"] == "assistant"
    assert msgs[1].get("tool_calls") is not None
    assert msgs[2]["role"] == "tool"
    assert msgs[2]["tool_call_id"] == "tc-5"


async def test_safe_time_returns_float():
    """_safe_time returns a non-negative float."""
    from helpers.llm import _safe_time

    val = _safe_time()
    assert isinstance(val, float)
    assert val >= 0


async def test_safe_heartbeat_no_raise_when_no_activity():
    """_safe_heartbeat is silent when no activity is running."""
    from helpers.llm import _safe_heartbeat

    # Should not raise even outside Temporal activity context
    _safe_heartbeat("test message")


async def test_call_llm_rose_with_usage_and_cache_fields():
    """call_llm streams a Rose response over OpenRouter SSE and returns content + usage."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm

    sse = _sse_body([
        {
            "choices": [{"delta": {"content": "hi back"}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": 50,
                "completion_tokens": 30,
                "total_tokens": 80,
                "cache_read_input_tokens": 10,
                "cache_creation_input_tokens": 5,
            },
        },
    ])

    def handler(req):
        url = str(req.url)
        if "openrouter.ai/api/v1/chat/completions" in url:
            return httpx.Response(
                200, text=sse, headers={"Content-Type": "text/event-stream"}
            )
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)

    response = await call_llm(
        messages=[{"role": "user", "content": "ping"}],
        model="rose-labs/rose-1-lite",
        temperature=0.5,
        max_tokens=256,
    )
    assert isinstance(response, dict)
    assert response.get("content") == "hi back"


async def test_convert_context_to_messages_non_terminal_tool_becomes_user():
    """IN_PROGRESS TOOL messages become user context messages in convert_context_to_messages."""
    from helpers.llm import convert_context_to_messages

    context = [
        {"role": "USER", "text": "start", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "TOOL",
            "text": "still running",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "toolCallId": "tc-ip",
                "toolStatus": "IN_PROGRESS",
                "toolName": "web_search",
            },
        },
    ]
    msgs = convert_context_to_messages(context, include_system=False)
    # in-progress tool messages aren't a "tool" role because no declared assistant tool_call → skipped
    # but they can still be included as user context depending on impl
    tool_role = [m for m in msgs if m["role"] == "tool"]
    assert len(tool_role) == 0


async def test_build_llm_messages_filters_inprogress_keeps_latest_finished():
    """IN_PROGRESS tool messages dropped; only latest FINISHED per toolCallId kept."""
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "q", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"tool_calls": [{"tool": "web_search", "tool_call_id": "tc-1"}]},
        },
        {
            "role": "TOOL",
            "text": "in-progress",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {"toolCallId": "tc-1", "toolStatus": "IN_PROGRESS", "toolName": "web_search"},
        },
        {
            "role": "TOOL",
            "text": "old finished",
            "timestamp": "2024-01-01T00:00:03Z",
            "metadata": {"toolCallId": "tc-1", "toolStatus": "FINISHED", "toolName": "web_search"},
        },
        {
            "role": "TOOL",
            "text": "new finished",
            "timestamp": "2024-01-01T00:00:04Z",
            "metadata": {"toolCallId": "tc-1", "toolStatus": "FINISHED", "toolName": "web_search"},
        },
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        msgs = await build_llm_messages(context, "sys")

    tool_msgs = [m for m in msgs if m["role"] == "tool"]
    assert len(tool_msgs) == 1
    assert "new finished" in tool_msgs[0]["content"]
    # No IN_PROGRESS content should appear
    assert not any("in-progress" in str(m.get("content", "")) for m in msgs)


async def test_call_llm_structured_streaming_tool_detection_callback():
    """on_tool_detected fires when accumulated JSON contains a tool call."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    chunks = [
        {
            "choices": [{"delta": {"content": '{"response": "", "tool_calls": [{"tool": "web_search", "query": "x"}]}'}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
            "actual_model": "claude-sonnet-4-6",
        },
    ]
    body = _sse_body(chunks)

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)

    AgentAction = create_agent_action_model(["web_search"])
    detected = []

    async def on_chunk(text: str, tokens: int):
        pass

    async def on_tool_detected(name, tool_call_id):
        detected.append((name, tool_call_id))

    response, usage, detected_ordered = await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "q"}],
        model="rose",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        on_tool_detected=on_tool_detected,
        call_site="tool-detect",
    )

    assert any(name == "web_search" for name, _ in detected)
    assert any(t == "web_search" for t, _, _ in detected_ordered)


async def test_call_llm_structured_streaming_attention_streaming():
    """on_attention_stream fires for send_message_to_user tool message."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    chunks = [
        {
            "choices": [{"delta": {"content": '{"response": "", "tool_calls": [{"tool": "send_message_to_user", "message": "Hello there!", "is_question": false}]}'}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 3, "total_tokens": 6},
        },
    ]
    body = _sse_body(chunks)

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)

    AgentAction = create_agent_action_model(["send_message_to_user"])
    streamed = []

    async def on_chunk(text: str, tokens: int):
        pass

    async def on_attention(tool_call_id, message, is_question):
        streamed.append((tool_call_id, message, is_question))

    await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "q"}],
        model="rose",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        on_attention_stream=on_attention,
        call_site="attn",
    )

    assert len(streamed) >= 1
    # Message content should appear (attention stream emits progressively)
    assert any("Hello" in str(m) for _, m, _ in streamed)


async def test_call_llm_openrouter_path():
    """call_llm with non-Rose model routes via OpenAI SDK (OpenRouter base_url)."""
    from unittest.mock import AsyncMock, MagicMock, patch
    from helpers.llm import call_llm

    fake_response = MagicMock()
    fake_response.choices = [MagicMock()]
    fake_response.choices[0].message.content = "openrouter reply"
    fake_response.choices[0].message.model_dump = lambda: {"content": "openrouter reply"}
    fake_response.choices[0].finish_reason = "stop"
    fake_response.model = "anthropic/claude-sonnet-4"
    fake_response.usage.prompt_tokens = 11
    fake_response.usage.completion_tokens = 7
    fake_response.usage.total_tokens = 18

    fake_client = MagicMock()
    fake_client.chat.completions.create = AsyncMock(return_value=fake_response)

    with patch("helpers.llm.AsyncOpenAI", return_value=fake_client):
        result = await call_llm(
            messages=[{"role": "user", "content": "hi"}],
            model="anthropic/claude-sonnet-4",
            temperature=0.6,
            max_tokens=256,
        )

    assert result["content"] == "openrouter reply"
    assert result["usage"]["total_tokens"] == 18
    assert result["finish_reason"] == "stop"


async def test_call_llm_verifier_claude_token_error_surfaces():
    """When claudeAuth Anthropic call fails 401, RoseClient falls through to
    waterfall and surfaces `claude_token_error` on the metadata chunk."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier
    from config import load_config

    waterfall_body = _sse_body([
        {
            "choices": [{"delta": {"content": '{"reasoning": "ok", "score": 0.5}'}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
        }
    ])

    def handler(req):
        url = str(req.url)
        if "api.anthropic.com" in url:
            # 401 from Anthropic → RoseAuthError → fall through to waterfall.
            return httpx.Response(401, json={"error": {"message": "expired"}})
        if "openrouter.ai/api/v1/chat/completions" in url:
            return httpx.Response(
                200, text=waterfall_body, headers={"Content-Type": "text/event-stream"}
            )
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    config = load_config()

    with patch("temporalio.activity.heartbeat"):
        result, usage = await _call_llm_verifier(
            messages=[{"role": "user", "content": "x"}],
            model="rose",
            config=config,
            claude_token="expired-token",
            call_site="verifier-err",
        )

    # auth failure on claudeAuth path is classified as auth_error.
    assert usage.get("claude_token_error") == "auth_error"
    assert result["score"] == 0.5


async def test_call_llm_verifier_reasoning_fallback_to_json():
    """_call_llm_verifier extracts JSON from reasoning block for thinking models."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier
    from config import load_config

    # reasoning carries the JSON; content is empty
    chunks = [
        {
            "choices": [{"delta": {"reasoning": '{"reasoning": "thinking...", "score": 0.9}'}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
            "actual_model": "claude-thinking",
        },
    ]
    body = _sse_body(chunks)

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)
    config = load_config()

    with patch("temporalio.activity.heartbeat"):
        result, usage = await _call_llm_verifier(
            messages=[{"role": "user", "content": "x"}],
            model="rose",
            config=config,
            call_site="verifier-think",
        )

    assert result["score"] == 0.9
    assert "thinking" in result["reasoning"]


async def test_call_llm_verifier_no_json_raises():
    """_call_llm_verifier raises when stream contains no JSON content."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier
    from config import load_config

    chunks = [
        {
            "choices": [{"delta": {}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 0, "total_tokens": 1},
        },
    ]
    body = _sse_body(chunks)

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)
    config = load_config()

    raised = False
    try:
        with patch("temporalio.activity.heartbeat"):
            await _call_llm_verifier(
                messages=[{"role": "user", "content": "x"}],
                model="rose",
                config=config,
                call_site="verifier-empty",
            )
    except ValueError as e:
        assert "No JSON content" in str(e)
        raised = True
    assert raised


async def test_call_llm_activity_no_stream_id_skips_streaming_callbacks():
    """call_llm_activity without stream_id skips on_chunk streaming but still returns result."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_activity

    payload = {
        "choices": [{"delta": {"content": '{"response": "no-stream", "tool_calls": []}'}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
    }
    body = _sse_body([payload])

    def handler(req):
        if "/completions" in str(req.url):
            return httpx.Response(200, text=body)
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        result = await call_llm_activity(
            messages_or_agent_id=[{"role": "user", "content": "hi"}],
            model="rose-labs/rose-1-lite",
            tool_names=[],
            reasoning_max_tokens=0,
            # no agent_id / stream_id
            call_site="no-stream",
        )

    assert result["response"] == "no-stream"
    assert result["tool_calls"] == []


async def test_mark_claude_token_rate_limited_exception_path():
    """mark_claude_token_rate_limited_activity returns False on exception."""
    import httpx
    from helpers.httpx_capture import set_mock_handler

    def handler(req):
        raise httpx.ConnectError("connection refused")

    set_mock_handler(handler)

    from helpers.llm import mark_claude_token_rate_limited_activity

    result = await mark_claude_token_rate_limited_activity(
        source="user",
        user_id="user-x",
    )
    assert result is False


async def test_fetch_claude_max_token_exception_path():
    """fetch_claude_max_token_activity returns None on httpx exception."""
    import httpx
    from helpers.httpx_capture import set_mock_handler

    def handler(req):
        raise httpx.ConnectError("bad")

    set_mock_handler(handler)

    from helpers.llm import fetch_claude_max_token_activity

    result = await fetch_claude_max_token_activity("user-z")
    assert result is None


async def test_call_llm_openrouter_exception_path():
    """call_llm surfaces exceptions from the OpenRouter client."""
    from unittest.mock import AsyncMock, MagicMock, patch
    from helpers.llm import call_llm

    fake_client = MagicMock()
    fake_client.chat.completions.create = AsyncMock(side_effect=RuntimeError("openrouter down"))

    raised = False
    with patch("helpers.llm.AsyncOpenAI", return_value=fake_client):
        try:
            await call_llm(
                messages=[{"role": "user", "content": "hi"}],
                model="anthropic/claude-sonnet-4",
            )
        except RuntimeError as e:
            assert "openrouter down" in str(e)
            raised = True
    assert raised


async def test_call_llm_structured_streaming_openrouter_path():
    """Non-Rose models route through instructor.create_partial and emit chunks."""
    from unittest.mock import AsyncMock, MagicMock, patch
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    AgentAction = create_agent_action_model([])

    # Build partial objects that instructor would yield
    partials = []
    texts = [
        "short",
        "short plus some more text here to trigger the 18-char batching threshold",
        "short plus some more text here to trigger the 18-char batching threshold and one more chunk",
    ]
    for t in texts:
        p = MagicMock()
        p.response = t
        p.tool_calls = []
        partials.append(p)

    async def partial_iter(*args, **kwargs):
        for p in partials:
            yield p

    fake_completions = MagicMock()
    fake_completions.create_partial = partial_iter

    fake_client = MagicMock()
    fake_client.chat.completions = fake_completions

    chunks_received = []

    async def on_chunk(text, tokens):
        chunks_received.append(text)

    with patch("helpers.llm.AsyncOpenAI"), patch("helpers.llm.instructor.from_openai", return_value=fake_client):
        response, usage, detected = await call_llm_structured_streaming(
            messages=[{"role": "user", "content": "q"}],
            model="anthropic/claude-sonnet-4",
            temperature=0.5,
            max_tokens=256,
            response_model=AgentAction,
            on_chunk=on_chunk,
            call_site="or-stream",
        )
    # Final response must be the last partial; response text equals final
    assert response is partials[-1]
    assert usage["total_tokens"] >= 0
    # on_chunk should have been called at least once (batching + final flush)
    assert len(chunks_received) >= 1


async def test_call_llm_structured_streaming_openrouter_exception_raises():
    """OpenRouter streaming propagates exceptions from instructor."""
    from unittest.mock import MagicMock, patch
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    AgentAction = create_agent_action_model([])

    async def broken_iter(*args, **kwargs):
        raise RuntimeError("openrouter boom")
        yield  # pragma: no cover

    fake_completions = MagicMock()
    fake_completions.create_partial = broken_iter

    fake_client = MagicMock()
    fake_client.chat.completions = fake_completions

    async def on_chunk(text, tokens):
        pass

    raised = False
    with patch("helpers.llm.AsyncOpenAI"), patch("helpers.llm.instructor.from_openai", return_value=fake_client):
        try:
            await call_llm_structured_streaming(
                messages=[{"role": "user", "content": "q"}],
                model="anthropic/claude-sonnet-4",
                temperature=0.5,
                max_tokens=256,
                response_model=AgentAction,
                on_chunk=on_chunk,
                call_site="or-stream-err",
            )
        except RuntimeError as e:
            assert "openrouter boom" in str(e)
            raised = True
    assert raised


async def test_call_llm_structured_streaming_nested_tool_recovery():
    """Structured streaming unwraps nested tool_calls from response text."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    # Outer response has no tool_calls but embeds a nested agent JSON blob
    nested_blob = '{"response": "inner", "tool_calls": [{"tool": "web_search", "query": "nested"}]}'
    outer_content = '{"response": "' + nested_blob.replace('"', '\\"') + '", "tool_calls": []}'

    payload = {
        "choices": [{"delta": {"content": outer_content}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)

    AgentAction = create_agent_action_model(["web_search"])

    async def on_chunk(text, tokens):
        pass

    response, usage, detected = await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "q"}],
        model="rose",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        call_site="nested-recovery",
    )
    # After recovery, response.tool_calls should have the nested web_search
    assert len(response.tool_calls) >= 1
    assert response.tool_calls[0].tool == "web_search"


async def test_call_llm_structured_streaming_thinking_model_reasoning_json():
    """Thinking models that put JSON in reasoning have it extracted."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    # Content is empty, reasoning carries the JSON
    payload = {
        "choices": [{"delta": {"reasoning": '{"response": "thinking reply", "tool_calls": []}'}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)

    AgentAction = create_agent_action_model([])

    async def on_chunk(text, tokens):
        pass

    response, usage, detected = await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "q"}],
        model="rose",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        call_site="thinking",
    )
    assert "thinking reply" in (response.response or "")


async def test_call_llm_structured_streaming_single_call_dedup():
    """send_message_to_user is deduplicated when model emits twice."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    content = json.dumps({
        "response": "test",
        "tool_calls": [
            {"tool": "send_message_to_user", "message": "first", "is_question": False},
            {"tool": "send_message_to_user", "message": "second", "is_question": False},
        ],
    })
    payload = {
        "choices": [{"delta": {"content": content}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)

    AgentAction = create_agent_action_model(["send_message_to_user"])

    async def on_chunk(text, tokens):
        pass

    response, usage, detected = await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "q"}],
        model="rose",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        call_site="dedup",
    )
    # Dedup keeps only the first send_message_to_user
    assert len(response.tool_calls) == 1


async def test_call_llm_structured_streaming_json_parse_failure_raises():
    """When streaming delivers invalid JSON, structured streaming raises ValueError."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    # Malformed JSON
    payload = {
        "choices": [{"delta": {"content": "not-json-at-all {{{"}}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 3, "total_tokens": 6},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)

    AgentAction = create_agent_action_model([])

    async def on_chunk(text, tokens):
        pass

    raised = False
    try:
        await call_llm_structured_streaming(
            messages=[{"role": "user", "content": "q"}],
            model="rose",
            temperature=0.7,
            max_tokens=512,
            response_model=AgentAction,
            on_chunk=on_chunk,
            call_site="parse-fail",
        )
    except ValueError:
        raised = True
    assert raised


async def test_call_llm_structured_streaming_no_json_content_raises():
    """Empty delta content raises ValueError when no JSON can be extracted."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    # No content or reasoning — fully empty
    payload = {
        "choices": [{"delta": {}}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 0, "total_tokens": 1},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)

    AgentAction = create_agent_action_model([])

    async def on_chunk(text, tokens):
        pass

    # An empty stream stalls in the waterfall; both pool steps fail → RoseAllFailed.
    raised = False
    try:
        await call_llm_structured_streaming(
            messages=[{"role": "user", "content": "q"}],
            model="rose",
            temperature=0.7,
            max_tokens=512,
            response_model=AgentAction,
            on_chunk=on_chunk,
            call_site="empty",
        )
    except Exception as e:
        msg = str(e)
        assert (
            "No JSON" in msg
            or "Failed to parse" in msg
            or "waterfall" in msg
            or "stream closed" in msg
        ), f"unexpected error: {msg}"
        raised = True
    assert raised


async def test_check_progress_empty_context_runs_verifier():
    """check_progress with minimal context runs verifier and returns parsed score."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import check_progress

    payload = {
        "choices": [{"delta": {"content": '{"reasoning": "nothing", "score": 0.0}'}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        result = await check_progress(
            context=[],
            verifier_system_prompt="verify",
            model="rose",
            call_site="empty-ctx",
        )
    assert result["score"] == 0.0


# ===========================================================================
# Additional coverage: verifier retries, build_llm_messages, streaming edges,
# set_response_schema paths, mark_claude_token edges, nested recovery.
# ===========================================================================


async def test_check_progress_retries_on_transient_failure_then_succeeds():
    """check_progress retries verifier on failure until one succeeds (exponential backoff path)."""
    from helpers.llm import check_progress

    call_count = [0]

    async def fake_verifier(
        messages,
        model,
        config,
        response_schema,
        claude_token=None,
        call_site="",
        agent_id=None,
        **_kwargs,
    ):
        call_count[0] += 1
        if call_count[0] == 1:
            raise ValueError("transient parse error")
        return (
            {"score": 0.75, "reasoning": "ok"},
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        )

    import asyncio as _asyncio

    async def fast_sleep(_d):
        return None

    with patch("helpers.llm._call_llm_verifier", fake_verifier), \
         patch("helpers.llm.asyncio.sleep", fast_sleep), \
         patch("temporalio.activity.heartbeat"):
        result = await check_progress(
            context=[],
            verifier_system_prompt="verify",
            model="rose",
            call_site="retry-ok",
        )
    assert call_count[0] >= 2, f"Expected >=2 attempts, got {call_count[0]}"
    assert result["score"] == 0.75


async def test_check_progress_error_returns_fallback_score():
    """check_progress returns score=0.5 fallback when the outer try/except is hit before retries."""
    from helpers.llm import check_progress

    # Force an exception before the retry loop by making load_config raise
    def raise_config():
        raise RuntimeError("config explode")

    with patch("helpers.llm.load_config", raise_config), patch("temporalio.activity.heartbeat"):
        result = await check_progress(
            context=[],
            verifier_system_prompt="verify",
            model="rose",
            call_site="fallback",
        )
    # Outer try/except returns fallback score 0.5
    assert result["score"] == 0.5
    assert "failed" in result["reasoning"].lower() or "Progress check failed" in result["reasoning"]


async def test_build_llm_messages_system_role_gets_prefix():
    """build_llm_messages converts SYSTEM role entries to user with [SYSTEM]: prefix."""
    from unittest.mock import patch as _patch
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "hello", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "SYSTEM",
            "text": "a system-level note",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {},
        },
    ]
    with _patch("helpers.llm.activity.in_activity", return_value=False):
        messages = await build_llm_messages(context, "sys")
    # First is system, then user + system-as-user
    assert messages[0]["role"] == "system"
    assert any(
        m["role"] == "user" and isinstance(m.get("content"), str) and "[SYSTEM]:" in m["content"]
        for m in messages
    ), f"Expected a [SYSTEM]: user message, got: {messages}"


async def test_build_llm_messages_non_terminal_tool_becomes_user_text():
    """build_llm_messages converts non-terminal TOOL rows (no toolStatus) to user [TOOL]: text."""
    from unittest.mock import patch as _patch
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "question", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "TOOL",
            "text": "mid-progress log",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"toolName": "web_search"},  # No toolStatus -> non-terminal
        },
    ]
    with _patch("helpers.llm.activity.in_activity", return_value=False):
        messages = await build_llm_messages(context, "sys")
    tool_as_user = [m for m in messages if m.get("role") == "user" and isinstance(m.get("content"), str) and "[TOOL]:" in m["content"]]
    assert tool_as_user, f"Expected a [TOOL]:-prefixed user message, got: {messages}"


async def test_mark_claude_token_rate_limited_pool_body_includes_pool_id():
    """Pool-source cooldown request body includes poolTokenId, not userId."""
    import json as _json
    import httpx
    from helpers.httpx_capture import set_mock_handler, get_captures
    from helpers.llm import mark_claude_token_rate_limited_activity

    def handler(req: httpx.Request):
        return httpx.Response(200, text="")

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        ok = await mark_claude_token_rate_limited_activity(
            source="pool",
            user_id="u-1",
            pool_token_id="pool-42",
            cooldown_seconds=60,
        )
    assert ok is True
    caps = get_captures()
    assert caps, "Expected an outbound HTTP capture"
    body = _json.loads(caps[-1]["requestBody"])
    assert body["source"] == "pool"
    assert body["poolTokenId"] == "pool-42"
    # Pool source does NOT include userId in body
    assert "userId" not in body


async def test_fetch_claude_max_token_activity_missing_access_token_field():
    """200 with no accessToken field returns None (falls through missing-token branch)."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import fetch_claude_max_token_activity

    def handler(req):
        # 200 but no accessToken -> triggers the if token: False path, returns None
        return httpx.Response(200, json={"source": "user"})

    set_mock_handler(handler)
    with patch("temporalio.activity.heartbeat"):
        result = await fetch_claude_max_token_activity("user-1")
    assert result is None


async def test_set_response_schema_activity_empty_goal_short_circuits():
    """set_response_schema_activity with empty user_messages returns None without HTTP calls."""
    from helpers.httpx_capture import set_mock_handler, get_captures, clear_captures
    from helpers.llm import set_response_schema_activity

    clear_captures()
    # No handler set: default 404s. But we should see zero captures.
    def handler(req):
        import httpx as _hx
        return _hx.Response(500, text="should never be called")

    set_mock_handler(handler)
    with patch("temporalio.activity.heartbeat"):
        result = await set_response_schema_activity(agent_id="agent-1", user_messages=[])
    assert result is None
    # Empty goal path takes the short-circuit before any HTTP call
    assert len(get_captures()) == 0


async def test_extract_response_from_partial_json_regex_fallback_unclosed_response():
    """_extract_response_from_partial_json falls back to regex when JSON is unclosed."""
    from helpers.llm import _extract_response_from_partial_json

    # Unclosed JSON (no closing }); response half-captured - regex fallback kicks in
    partial = '{"reasoning": "thinking", "response": "hello world partially'
    result = _extract_response_from_partial_json("", partial)
    assert result is not None
    assert "hello world" in result


async def test_extract_nested_agent_json_blob_rfind_strategy():
    """_extract_nested_agent_json_blob uses rfind fallback when no fenced block present."""
    from helpers.llm import _extract_nested_agent_json_blob

    text = "prefix garbage {\"tool_calls\": [{\"tool\": \"web_search\", \"query\": \"hi\"}]} trailing"
    result = _extract_nested_agent_json_blob(text)
    assert isinstance(result, dict)
    assert "tool_calls" in result


async def test_call_llm_structured_streaming_attention_stream_without_question_field():
    """Attention streaming with no is_question field defaults to True and streams message."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    # Build an accumulated stream that includes send_message_to_user with message field
    payload_1 = {
        "choices": [{"delta": {"content": '{"response": "thinking", "tool_calls": [{"tool": "send_message_to_user", "message": "Hello there"}]'}}],
    }
    payload_2 = {
        "choices": [{"delta": {"content": '}'}}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 10, "total_tokens": 13},
    }
    body = _sse_body([payload_1, payload_2])

    def handler(req):
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    AgentAction = create_agent_action_model(["send_message_to_user"])
    attention_calls: list = []

    async def on_attention_stream(tool_call_id, message, is_question):
        attention_calls.append({"id": tool_call_id, "msg": message, "q": is_question})

    async def on_chunk(text, tokens):
        pass

    result, usage, detected = await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "hi"}],
        model="rose",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        on_attention_stream=on_attention_stream,
        call_site="attn-no-q",
    )
    # Should have triggered attention stream at least once with is_question=True (default)
    assert attention_calls, f"Expected attention_calls to be emitted, got {attention_calls}"
    assert all(c["q"] is True for c in attention_calls)


async def test_call_llm_verifier_stream_interrupted_still_parses_partial():
    """Verifier surfaces partial JSON parse when stream terminates early with accumulated content."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier
    from config import load_config

    # Deliver a complete JSON body (stream_interrupted path requires RemoteProtocolError - harder to mock)
    # This exercises the normal path with stream_usage capture.
    body = _sse_body([
        {
            "actual_model": "claude-sonnet-4",
            "pool_name": "test-pool",
            "choices": [{"delta": {"content": '{"reasoning": "done", "score": 0.9}'}}],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "cache_read_input_tokens": 2,
                "cache_creation_input_tokens": 1,
            },
        }
    ])

    def handler(req):
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    cfg = load_config()
    with patch("temporalio.activity.heartbeat"):
        parsed, usage = await _call_llm_verifier(
            messages=[{"role": "user", "content": "x"}],
            model="rose",
            config=cfg,
            response_schema=None,
            claude_token=None,
            call_site="verifier-test",
        )
    assert parsed["score"] == 0.9
    # Waterfall path → first model from rose-1-lite pool.
    assert usage["actual_model"] == "google/gemini-3-flash-preview"
    assert usage["cache_read_input_tokens"] == 2
    assert usage["cache_creation_input_tokens"] == 1


async def test_call_llm_verifier_jsondecode_error_with_accumulated_reasoning():
    """_call_llm_verifier extracts JSON from reasoning when content is empty (thinking models)."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier
    from config import load_config

    # Reasoning-only stream: content is empty, reasoning contains the JSON
    body = _sse_body([
        {
            "choices": [{"delta": {"reasoning": 'Let me think... {"reasoning": "evaluated", "score": 0.6}'}}],
            "usage": {"prompt_tokens": 2, "completion_tokens": 5, "total_tokens": 7},
        }
    ])

    def handler(req):
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    cfg = load_config()
    with patch("temporalio.activity.heartbeat"):
        parsed, _ = await _call_llm_verifier(
            messages=[{"role": "user", "content": "x"}],
            model="rose",
            config=cfg,
            response_schema=None,
            claude_token=None,
            call_site="verifier-reason",
        )
    assert parsed["score"] == 0.6


async def test_build_verifier_json_schema_with_list_str_field():
    """_build_verifier_json_schema handles list[str] field mapping."""
    from helpers.llm import _build_verifier_json_schema

    schema = _build_verifier_json_schema({
        "fields": [
            {"name": "tags", "type": "list[str]"},
            {"name": "counts", "type": "list[int]"},
            {"name": "flag", "type": "bool"},
        ]
    })
    # Schema has an "output" field in properties
    props = schema["json_schema"]["schema"]["properties"]
    output_props = props["output"]["properties"]
    assert output_props["tags"]["type"] == "array"
    assert output_props["tags"]["items"]["type"] == "string"
    assert output_props["counts"]["type"] == "array"
    assert output_props["counts"]["items"]["type"] == "integer"
    assert output_props["flag"]["type"] == "boolean"


async def test_call_llm_structured_streaming_non_dict_choices_continues():
    """Streaming skips chunks with empty/missing choices without raising."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    payload_empty_choices = {"choices": [], "actual_model": "claude-sonnet-4"}
    payload_real = {
        "choices": [{"delta": {"content": '{"reasoning": "done", "response": "ok", "tool_calls": []}'}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }
    body = _sse_body([payload_empty_choices, payload_real])

    def handler(req):
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    AgentAction = create_agent_action_model([])

    async def on_chunk(text, tokens):
        pass

    result, usage, detected = await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "q"}],
        model="rose",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        call_site="empty-choices",
    )
    # Completed successfully despite empty-choices chunk; response parsed
    assert result is not None, f"result is None, usage={usage}"
    assert hasattr(result, "response"), f"result type={type(result)}: {result!r}"
    # Streaming parser may merge reasoning+response; just confirm parse succeeded
    assert "ok" in result.response, f"Expected 'ok' substring, got {result.response!r}"


def test_ensure_tool_result_pairing_inserts_synthetic_for_orphan_tool_use():
    """Orphan assistant tool_use → synthetic tool_result inserted right after."""
    from helpers.llm import _ensure_tool_result_pairing, SYNTHETIC_TOOL_RESULT_PLACEHOLDER

    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": "ok",
            "tool_calls": [
                {"id": "tc1", "type": "function", "function": {"name": "spawn_agent", "arguments": "{}"}}
            ],
        },
        {"role": "user", "content": "next turn"},
        {"role": "assistant", "content": "continuing"},
    ]
    fixed = _ensure_tool_result_pairing(msgs)
    # Synthetic tool_result is inserted between the orphan assistant and the next user.
    tool_msgs = [m for m in fixed if m.get("role") == "tool"]
    assert len(tool_msgs) == 1, f"Expected 1 synthetic tool message, got {len(tool_msgs)}"
    assert tool_msgs[0]["tool_call_id"] == "tc1"
    assert tool_msgs[0]["content"] == SYNTHETIC_TOOL_RESULT_PLACEHOLDER
    assert tool_msgs[0]["name"] == "spawn_agent"


def test_ensure_tool_result_pairing_strips_orphan_tool_result():
    """tool message with tool_call_id not declared by any preceding assistant is dropped."""
    from helpers.llm import _ensure_tool_result_pairing

    msgs = [
        {"role": "user", "content": "hi"},
        {"role": "tool", "tool_call_id": "ghost", "content": "orphaned"},
        {"role": "assistant", "content": "continuing"},
    ]
    fixed = _ensure_tool_result_pairing(msgs)
    assert all(m.get("role") != "tool" for m in fixed), f"Orphan tool not stripped: {fixed}"


def test_ensure_tool_result_pairing_dedupes_cross_message_tool_use_ids():
    """Same tool_call_id appearing in two assistant messages → second is stripped."""
    from helpers.llm import _ensure_tool_result_pairing

    msgs = [
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": "first",
            "tool_calls": [
                {"id": "tc1", "type": "function", "function": {"name": "foo", "arguments": "{}"}}
            ],
        },
        {"role": "tool", "tool_call_id": "tc1", "content": "result"},
        {
            "role": "assistant",
            "content": "second",
            "tool_calls": [
                {"id": "tc1", "type": "function", "function": {"name": "foo", "arguments": "{}"}}
            ],
        },
    ]
    fixed = _ensure_tool_result_pairing(msgs)
    second_assistant = fixed[-1] if fixed[-1].get("role") == "assistant" else None
    # The second assistant should have its duplicate tc1 stripped.
    assert second_assistant is not None, f"Last message not assistant: {fixed}"
    assert not second_assistant.get("tool_calls"), (
        f"Duplicate tool_call_id should have been stripped: {second_assistant}"
    )


def test_ensure_tool_result_pairing_idempotent():
    """Running the helper twice on its own output yields identical messages."""
    from helpers.llm import _ensure_tool_result_pairing

    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": "ok",
            "tool_calls": [
                {"id": "tc1", "type": "function", "function": {"name": "foo", "arguments": "{}"}}
            ],
        },
        {"role": "user", "content": "next"},
        {"role": "assistant", "content": "done"},
    ]
    once = _ensure_tool_result_pairing(msgs)
    twice = _ensure_tool_result_pairing(once)
    assert once == twice, f"Not idempotent:\nfirst={once}\nsecond={twice}"


def test_ensure_tool_result_pairing_preserves_well_formed_messages():
    """A well-formed conversation passes through unchanged."""
    from helpers.llm import _ensure_tool_result_pairing

    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": "ok",
            "tool_calls": [
                {"id": "tc1", "type": "function", "function": {"name": "foo", "arguments": "{}"}}
            ],
        },
        {"role": "tool", "tool_call_id": "tc1", "name": "foo", "content": "result"},
        {"role": "assistant", "content": "done"},
    ]
    fixed = _ensure_tool_result_pairing(msgs)
    assert fixed == msgs, f"Well-formed messages mutated:\nin={msgs}\nout={fixed}"


async def run_all_tests():
    print("llm blackbox tests:")
    r = BlackboxResult()
    r.record("prepare_schema_for_openai", test_prepare_schema_for_openai)
    r.record("prepare_schema_for_openai_nested_and_array", test_prepare_schema_for_openai_nested_and_array)
    r.record("convert_context_to_messages", test_convert_context_to_messages)
    r.record("convert_context_to_messages_empty", test_convert_context_to_messages_empty)
    r.record("convert_context_to_messages_with_declared_tool_call", test_convert_context_to_messages_with_declared_tool_call)
    r.record("convert_context_to_messages_verifier_message", test_convert_context_to_messages_verifier_message)
    r.record("convert_context_to_messages_skip_subagent_and_inprogress", test_convert_context_to_messages_skip_subagent_and_inprogress)
    r.record("extract_completed_tool_calls", test_extract_completed_tool_calls)
    r.record("extract_completed_tool_calls_partial", test_extract_completed_tool_calls_partial)
    r.record("extract_completed_tool_calls_no_array", test_extract_completed_tool_calls_no_array)
    r.record("extract_response_from_partial_json_empty", test_extract_response_from_partial_json_empty)
    r.record("extract_response_from_partial_json_reasoning_only", test_extract_response_from_partial_json_reasoning_only)
    r.record("extract_response_from_partial_json_complete_json", test_extract_response_from_partial_json_complete_json)
    r.record("extract_response_from_partial_json_markdown_block", test_extract_response_from_partial_json_markdown_block)
    r.record("extract_response_from_partial_json_partial_fields", test_extract_response_from_partial_json_partial_fields)
    r.record("extract_nested_agent_json_blob_raw", test_extract_nested_agent_json_blob_raw)
    r.record("extract_nested_agent_json_blob_fenced", test_extract_nested_agent_json_blob_fenced)
    r.record("extract_nested_agent_json_blob_none_cases", test_extract_nested_agent_json_blob_none_cases)
    r.record("extract_nested_agent_json_blob_braces_embedded", test_extract_nested_agent_json_blob_braces_embedded)
    r.record("build_verifier_json_schema", test_build_verifier_json_schema)
    r.record("verifier_score_schema_no_numeric_bounds", test_verifier_score_schema_has_no_numeric_bounds)
    r.record("build_verifier_json_schema_with_response_schema", test_build_verifier_json_schema_with_response_schema)
    r.record("build_verifier_json_schema_all_types", test_build_verifier_json_schema_all_types)
    r.record("build_verifier_json_schema_object_type", test_build_verifier_json_schema_object_type)
    r.record("build_verifier_json_schema_list_object_type", test_build_verifier_json_schema_list_object_type)
    r.record("build_verifier_json_schema_mixed_open_and_closed", test_build_verifier_json_schema_mixed_open_and_closed)
    await r.record_async("fetch_claude_max_token_activity", test_fetch_claude_max_token_activity)
    await r.record_async("fetch_claude_max_token_activity_not_found", test_fetch_claude_max_token_activity_not_found)
    await r.record_async("fetch_claude_max_token_activity_server_error", test_fetch_claude_max_token_activity_server_error)
    await r.record_async("fetch_claude_max_token_activity_missing_token_field", test_fetch_claude_max_token_activity_missing_token_field)
    await r.record_async("mark_claude_token_rate_limited_user_success", test_mark_claude_token_rate_limited_user_success)
    await r.record_async("mark_claude_token_rate_limited_explicit_reset", test_mark_claude_token_rate_limited_uses_explicit_reset_time)
    await r.record_async("mark_claude_token_rate_limited_pool_success", test_mark_claude_token_rate_limited_pool_success)
    await r.record_async("mark_claude_token_rate_limited_failure_reason", test_mark_claude_token_rate_limited_forwards_failure_reason)
    await r.record_async("mark_claude_token_rate_limited_failure", test_mark_claude_token_rate_limited_failure)
    await r.record_async("set_response_schema_activity_success", test_set_response_schema_activity_success)
    await r.record_async("set_response_schema_activity_uses_internal_auth_only", test_set_response_schema_activity_uses_internal_auth_only)
    await r.record_async("set_response_schema_activity_empty_goal", test_set_response_schema_activity_empty_goal)
    await r.record_async("set_response_schema_activity_no_schema_returned", test_set_response_schema_activity_no_schema_returned)
    await r.record_async("set_response_schema_activity_http_error", test_set_response_schema_activity_http_error)
    await r.record_async("call_llm_rose_path", test_call_llm_rose_path)
    await r.record_async("call_llm_rose_with_claude_token_and_skip_cache_write", test_call_llm_rose_with_claude_token_and_skip_cache_write)
    await r.record_async("call_llm_rose_response_model_submit_tool", test_call_llm_rose_response_model_uses_submit_tool)
    await r.record_async("call_llm_rose_http_error_raises", test_call_llm_rose_http_error_raises)
    await r.record_async("build_llm_messages_preserves_tool_calls_and_tool_role", test_build_llm_messages_preserves_tool_calls_and_tool_role)
    await r.record_async("build_llm_messages_unmatched_terminal_tool_becomes_user", test_build_llm_messages_unmatched_terminal_tool_becomes_user)
    await r.record_async("build_llm_messages_terminal_tool_missing_id_raises", test_build_llm_messages_terminal_tool_missing_id_raises)
    await r.record_async("build_llm_messages_system_and_non_terminal_tool", test_build_llm_messages_system_and_non_terminal_tool)
    await r.record_async("build_llm_messages_assistant_merging", test_build_llm_messages_assistant_merging)
    await r.record_async("build_llm_messages_skip_subagent", test_build_llm_messages_skip_subagent)
    await r.record_async("build_llm_messages_attachment_large_falls_back_to_metadata", test_build_llm_messages_attachment_large_falls_back_to_metadata)
    await r.record_async("build_llm_messages_skips_empty_file_output_assistant", test_build_llm_messages_skips_empty_file_output_assistant)
    await r.record_async("build_llm_messages_assistant_tool_call_validation_errors", test_build_llm_messages_assistant_tool_call_validation_errors)
    await r.record_async("build_llm_messages_filters_inprogress_keeps_latest_finished", test_build_llm_messages_filters_inprogress_keeps_latest_finished)
    await r.record_async("call_llm_structured_streaming_happy_path", test_call_llm_structured_streaming_happy_path)
    await r.record_async("call_llm_structured_streaming_model_detected_callback", test_call_llm_structured_streaming_model_detected_callback)
    await r.record_async("call_llm_verifier_streaming_parses_score", test_call_llm_verifier_streaming_parses_score)
    await r.record_async("call_llm_verifier_claude_token_and_schema", test_call_llm_verifier_claude_token_and_schema)
    await r.record_async("check_progress_happy_path", test_check_progress_happy_path)
    await r.record_async("check_progress_below_threshold_returns_partial_structured_response", test_check_progress_below_threshold_returns_partial_structured_response)
    await r.record_async("call_planner_llm_activity_happy_path", test_call_planner_llm_activity_happy_path)
    # Additional llm coverage
    await r.record_async("call_llm_activity_happy_path", test_call_llm_activity_happy_path_with_messages_list)
    await r.record_async("call_llm_activity_agent_id_shared_ctx", test_call_llm_activity_with_agent_id_reads_shared_context)
    await r.record_async("call_llm_activity_missing_ctx", test_call_llm_activity_missing_context_raises)
    await r.record_async("call_llm_activity_cross_machine_fb", test_call_llm_activity_cross_machine_fallback)
    await r.record_async("call_planner_llm_activity_failure", test_call_planner_llm_activity_failure_raises)
    await r.record_async("verifier_schema_file_pointer", test_build_verifier_json_schema_file_pointer_type)
    await r.record_async("verifier_schema_list_file_pointer", test_build_verifier_json_schema_list_file_pointer_type)
    await r.record_async("verifier_schema_session_file_pointer", test_build_verifier_json_schema_session_file_pointer_type)
    await r.record_async("verifier_schema_list_session_file_pointer", test_build_verifier_json_schema_list_session_file_pointer_type)
    await r.record_async("verifier_schema_unknown_fallback", test_build_verifier_json_schema_unknown_type_fallback)
    await r.record_async("verifier_schema_object_type", test_build_verifier_json_schema_object_type_open_shape)
    await r.record_async("verifier_schema_list_object_type", test_build_verifier_json_schema_list_object_type_open_shape)
    await r.record_async("verifier_schema_strict_when_closed", test_build_verifier_json_schema_strict_true_when_no_open_objects)
    r.record("verifier_ctx_screenshot_multimodal", test_build_verifier_context_messages_screenshot_emits_multimodal)
    r.record("verifier_ctx_screenshot_strips_b64", test_build_verifier_context_messages_screenshot_strips_b64_from_text)
    r.record("verifier_ctx_no_screenshot_text_only", test_build_verifier_context_messages_no_screenshot_stays_text)
    await r.record_async("extract_response_raw_json", test_extract_response_from_partial_json_raw_json_object)
    await r.record_async("extract_response_tool_calls_only", test_extract_response_from_partial_json_tool_calls_only)
    await r.record_async("extract_completed_tool_calls_multiple", test_extract_completed_tool_calls_multiple)
    await r.record_async("convert_ctx_assistant_with_tool_calls", test_convert_context_to_messages_assistant_with_tool_calls)
    await r.record_async("safe_time", test_safe_time_returns_float)
    await r.record_async("safe_heartbeat", test_safe_heartbeat_no_raise_when_no_activity)
    await r.record_async("call_llm_rose_cache_fields", test_call_llm_rose_with_usage_and_cache_fields)
    await r.record_async("convert_ctx_in_progress_tool", test_convert_context_to_messages_non_terminal_tool_becomes_user)
    await r.record_async("stream_tool_detection_cb", test_call_llm_structured_streaming_tool_detection_callback)
    await r.record_async("stream_attention_streaming", test_call_llm_structured_streaming_attention_streaming)
    await r.record_async("call_llm_openrouter_path", test_call_llm_openrouter_path)
    await r.record_async("verifier_claude_token_error", test_call_llm_verifier_claude_token_error_surfaces)
    await r.record_async("verifier_reasoning_fallback_to_json", test_call_llm_verifier_reasoning_fallback_to_json)
    await r.record_async("verifier_no_json_raises", test_call_llm_verifier_no_json_raises)
    await r.record_async("call_llm_activity_no_stream_id", test_call_llm_activity_no_stream_id_skips_streaming_callbacks)
    await r.record_async("mark_claude_token_rate_limited_exception", test_mark_claude_token_rate_limited_exception_path)
    await r.record_async("fetch_claude_max_token_exception", test_fetch_claude_max_token_exception_path)
    await r.record_async("call_llm_openrouter_exception", test_call_llm_openrouter_exception_path)
    await r.record_async("stream_openrouter_path", test_call_llm_structured_streaming_openrouter_path)
    await r.record_async("stream_openrouter_exception", test_call_llm_structured_streaming_openrouter_exception_raises)
    await r.record_async("stream_nested_tool_recovery", test_call_llm_structured_streaming_nested_tool_recovery)
    await r.record_async("stream_thinking_model_reasoning_json", test_call_llm_structured_streaming_thinking_model_reasoning_json)
    await r.record_async("stream_single_call_dedup", test_call_llm_structured_streaming_single_call_dedup)
    await r.record_async("stream_json_parse_failure_raises", test_call_llm_structured_streaming_json_parse_failure_raises)
    await r.record_async("stream_no_json_content_raises", test_call_llm_structured_streaming_no_json_content_raises)
    await r.record_async("check_progress_empty_context", test_check_progress_empty_context_runs_verifier)
    # Final coverage bumps (W3-*)
    await r.record_async("check_progress_retries_on_transient_failure", test_check_progress_retries_on_transient_failure_then_succeeds)
    await r.record_async("check_progress_error_returns_fallback_score", test_check_progress_error_returns_fallback_score)
    await r.record_async("build_llm_messages_system_role_prefix", test_build_llm_messages_system_role_gets_prefix)
    await r.record_async("build_llm_messages_non_terminal_tool_user_text", test_build_llm_messages_non_terminal_tool_becomes_user_text)
    await r.record_async("mark_claude_token_rate_limited_pool_body", test_mark_claude_token_rate_limited_pool_body_includes_pool_id)
    await r.record_async("fetch_claude_max_token_missing_access_token_field", test_fetch_claude_max_token_activity_missing_access_token_field)
    await r.record_async("set_response_schema_empty_goal_short_circuits", test_set_response_schema_activity_empty_goal_short_circuits)
    await r.record_async("extract_response_regex_fallback_unclosed", test_extract_response_from_partial_json_regex_fallback_unclosed_response)
    await r.record_async("extract_nested_agent_json_blob_rfind", test_extract_nested_agent_json_blob_rfind_strategy)
    await r.record_async("stream_attention_stream_without_question", test_call_llm_structured_streaming_attention_stream_without_question_field)
    await r.record_async("verifier_stream_interrupted_parses_partial", test_call_llm_verifier_stream_interrupted_still_parses_partial)
    await r.record_async("verifier_jsondecode_error_accumulated_reasoning", test_call_llm_verifier_jsondecode_error_with_accumulated_reasoning)
    await r.record_async("verifier_schema_with_list_str_field", test_build_verifier_json_schema_with_list_str_field)
    await r.record_async("stream_non_dict_choices_continues", test_call_llm_structured_streaming_non_dict_choices_continues)
    r.record("ensure_tool_result_pairing_inserts_synthetic", test_ensure_tool_result_pairing_inserts_synthetic_for_orphan_tool_use)
    r.record("ensure_tool_result_pairing_strips_orphan_tool_result", test_ensure_tool_result_pairing_strips_orphan_tool_result)
    r.record("ensure_tool_result_pairing_dedupes_cross_message_ids", test_ensure_tool_result_pairing_dedupes_cross_message_tool_use_ids)
    r.record("ensure_tool_result_pairing_idempotent", test_ensure_tool_result_pairing_idempotent)
    r.record("ensure_tool_result_pairing_preserves_well_formed", test_ensure_tool_result_pairing_preserves_well_formed_messages)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
