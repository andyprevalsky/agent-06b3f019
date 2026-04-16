"""Blackbox tests for llm domain (pure functions only)."""

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


async def test_fetch_claude_max_token_activity():
    """fetch_claude_max_token_activity GETs /api/integrations/claude-code/credentials/token."""
    setup_mock({
        "/api/integrations/claude-code/credentials/token": {
            "status": 200,
            "json": {"accessToken": "test-claude-token-123"},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import fetch_claude_max_token_activity

        result = await fetch_claude_max_token_activity("user-abc")

    assert result == "test-claude-token-123"
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


async def run_all_tests():
    print("llm blackbox tests:")
    r = BlackboxResult()
    r.record("prepare_schema_for_openai", test_prepare_schema_for_openai)
    r.record("convert_context_to_messages", test_convert_context_to_messages)
    r.record("convert_context_to_messages_empty", test_convert_context_to_messages_empty)
    r.record("extract_completed_tool_calls", test_extract_completed_tool_calls)
    r.record("extract_completed_tool_calls_partial", test_extract_completed_tool_calls_partial)
    r.record("build_verifier_json_schema", test_build_verifier_json_schema)
    r.record("build_verifier_json_schema_with_response_schema", test_build_verifier_json_schema_with_response_schema)
    await r.record_async("fetch_claude_max_token_activity", test_fetch_claude_max_token_activity)
    await r.record_async("fetch_claude_max_token_activity_not_found", test_fetch_claude_max_token_activity_not_found)
    await r.record_async("build_llm_messages_preserves_tool_calls_and_tool_role", test_build_llm_messages_preserves_tool_calls_and_tool_role)
    await r.record_async("build_llm_messages_unmatched_terminal_tool_becomes_user", test_build_llm_messages_unmatched_terminal_tool_becomes_user)
    await r.record_async("build_llm_messages_terminal_tool_missing_id_raises", test_build_llm_messages_terminal_tool_missing_id_raises)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
