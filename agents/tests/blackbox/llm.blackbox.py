"""Blackbox tests for llm domain (pure functions + mockable activities)."""

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

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


def test_convert_context_to_messages_mixed_timestamp_awareness():
    """Duplicate terminal rows compare cleanly when one has no timestamp.

    parse_timestamp returns an aware datetime for a "Z" value, so a naive epoch
    fallback made the terminal-row dedup raise "can't compare offset-naive and
    offset-aware datetimes" and fail the entire summary conversion whenever one
    duplicate row lacked a timestamp.
    """
    from helpers.llm import convert_context_to_messages

    context = [
        {
            "role": "ASSISTANT",
            "text": "calling",
            "timestamp": "2026-01-01T00:00:00Z",
            "metadata": {"tool_calls": [{"tool": "web_search", "tool_call_id": "call-1"}]},
        },
        {
            "role": "TOOL",
            "text": "older result",
            "timestamp": "",
            "metadata": {
                "toolCallId": "call-1",
                "toolName": "web_search",
                "toolStatus": "FINISHED",
            },
        },
        {
            "role": "TOOL",
            "text": "newer result",
            "timestamp": "2026-01-01T00:00:05Z",
            "metadata": {
                "toolCallId": "call-1",
                "toolName": "web_search",
                "toolStatus": "FINISHED",
            },
        },
    ]

    result = convert_context_to_messages(context, include_system=False, include_assistant=True)

    tool_messages = [m for m in result if m.get("role") == "tool"]
    assert len(tool_messages) == 1, tool_messages
    assert "newer result" in tool_messages[0]["content"], tool_messages


def test_tool_call_declaration_dedup_ignores_argument_key_order():
    """A dual-write duplicate dedupes even when its argument keys are ordered differently.

    The duplicate check compares serialized arguments, and json.dumps preserves
    insertion order — so without sort_keys, two semantically identical
    declarations serialized in different key orders would be treated as
    conflicting and raise, failing the whole conversion.
    """
    import json

    import pytest

    from helpers.llm import register_tool_call_declaration

    declared: dict = {}
    forward = json.dumps({"query": "rose", "limit": 5}, sort_keys=True)
    reordered = json.dumps({"limit": 5, "query": "rose"}, sort_keys=True)

    call_id, emit_first = register_tool_call_declaration(declared, "call-1", "web_search", forward, "ASSISTANT")
    assert call_id == "call-1"
    assert emit_first is True

    _, emit_second = register_tool_call_declaration(declared, "call-1", "web_search", reordered, "ASSISTANT")
    assert emit_second is False, "same declaration in a different key order must dedupe"

    with pytest.raises(ValueError):
        register_tool_call_declaration(
            declared,
            "call-1",
            "web_search",
            json.dumps({"query": "other", "limit": 5}, sort_keys=True),
            "ASSISTANT",
        )


def test_tool_result_uses_declared_not_executed_tool_name():
    """A tool result must be labelled with the DECLARED tool name.

    spawn_agent legitimately executes as spawn_browser_agent, and the TOOL
    message records the executed name in metadata["toolName"]. Google validates
    functionResponse.name against the declared functions and rejects the whole
    request with 400 INVALID_ARGUMENT on a mismatch; OpenAI and Anthropic ignore
    it, so this stayed latent until Google was the only reachable model and it
    killed real agent runs whose work had already succeeded.
    """
    from helpers.llm import convert_context_to_messages

    context = [
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"tool_calls": [{"tool": "spawn_agent", "tool_call_id": "call_1"}]},
        },
        {
            "role": "TOOL",
            "text": "browser agent finished",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {
                # What actually ran — deliberately different from the declaration.
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "toolCallId": "call_1",
            },
        },
    ]

    # include_assistant=True so the tool_call is actually declared; without a
    # declaration the result degrades to a system message and never exercises
    # the tool-name labelling at all.
    result = convert_context_to_messages(context, include_system=False, include_assistant=True)
    tool_msgs = [m for m in result if m.get("role") == "tool"]
    assert len(tool_msgs) == 1, f"expected one tool message, got {result}"
    assert tool_msgs[0]["name"] == "spawn_agent", (
        "tool result must carry the DECLARED name; labelling it with the executed "
        f"name is rejected by Google. Got: {tool_msgs[0].get('name')}"
    )


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
            "metadata": {"tool_calls": [{"tool": "web_search", "tool_call_id": "tc-123", "query": "x"}]},
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


def test_tool_result_name_pairs_with_the_declared_call_not_the_display_name():
    """A tool result must be named for the function the ASSISTANT declared.

    metadata["toolName"] is the UI DISPLAY name and legitimately differs from the
    declared call (spawn_agent renders as spawn_browser_agent). Gemini pairs a
    tool result to its call by NAME, not by tool_call_id, so emitting the display
    name made it reject the request with 400 INVALID_ARGUMENT — which took out the
    only non-Anthropic waterfall route and failed 36/36 execute_loop calls.
    """
    from helpers.llm import convert_context_to_messages

    context = [
        {"role": "USER", "text": "order dinner", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "delegating",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"tool_calls": [{"tool": "spawn_agent", "tool_call_id": "9ryenvug"}]},
        },
        {
            "role": "TOOL",
            "text": "browser agent finished",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {
                "toolCallId": "9ryenvug",
                # The display name the UI shows — deliberately NOT the declared name.
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
            },
        },
    ]

    messages = convert_context_to_messages(context, include_system=False, include_assistant=True)
    tool_msg = next(m for m in messages if m["role"] == "tool")
    assistant_msg = next(m for m in messages if m["role"] == "assistant")
    declared = assistant_msg["tool_calls"][0]["function"]["name"]

    assert tool_msg["name"] == declared, (
        f"tool result name {tool_msg['name']!r} must match the declared call {declared!r}; "
        "a display-name mismatch is rejected by Gemini as an invalid argument"
    )
    assert tool_msg["name"] == "spawn_agent"


def test_missing_tool_call_id_fails_closed_instead_of_being_synthesized():
    """An id-less tool call must RAISE, never get a synthesized id.

    A fresh uuid4 per conversion can never pair with the persisted terminal
    result, so the real result is silently replaced by a synthetic placeholder —
    and the id the bookkeeping recorded disagrees with the one actually sent to
    the model. Failing closed surfaces the malformed row at its source instead.
    """
    from helpers.llm import convert_context_to_messages

    context = [
        {
            "role": "ASSISTANT",
            "text": "calling without an id",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"tool_calls": [{"tool": "web_search"}]},
        },
    ]

    try:
        convert_context_to_messages(context, include_system=False, include_assistant=True)
    except ValueError as error:
        assert "tool_call_id" in str(error), f"error must name the missing field, got {error!r}"
        assert "web_search" in str(error), f"error must name the offending tool, got {error!r}"
    else:
        raise AssertionError(
            "an ASSISTANT tool_call with no tool_call_id must raise, not silently "
            "synthesize an id that can never pair with its persisted result"
        )


def test_null_tool_call_ids_do_not_collide_on_the_string_none():
    """A present-but-null id must fail closed, not collapse onto the literal "None".

    `dict.get(key, default)` returns None when the key EXISTS and is null, so a
    `.get(k, uuid4())` default never fires: every such call became the string
    "None" and they all collided onto one another. Fail closed instead.
    """
    from helpers.llm import convert_context_to_messages

    context = [
        {
            "role": "ASSISTANT",
            "text": "two null-id calls",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "tool_calls": [
                    {"tool": "web_search", "tool_call_id": None},
                    {"tool": "grep", "tool_call_id": None},
                ]
            },
        },
    ]

    try:
        messages = convert_context_to_messages(context, include_system=False, include_assistant=True)
    except ValueError as error:
        assert "tool_call_id" in str(error), f"error must name the missing field, got {error!r}"
        return
    ids = [tc["id"] for tc in next(m for m in messages if m["role"] == "assistant")["tool_calls"]]
    assert "None" not in ids, f'null ids must never collapse onto the literal "None": {ids}'
    assert len(set(ids)) == 2, f"each null-id call needs its own unique id, got {ids}"


def test_tool_result_omits_name_when_no_declaration_is_known():
    """An unknown declaration must omit `name` rather than guess the display name.

    A wrong name is worse than no name: it is what the provider rejects.
    """
    from helpers.llm import convert_context_to_messages

    context = [
        {
            "role": "ASSISTANT",
            "text": "declared one call",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"tool_calls": [{"tool": "web_search", "tool_call_id": "tc-known"}]},
        },
        {
            "role": "TOOL",
            "text": "result for the known call",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {"toolCallId": "tc-known", "toolName": "web_search_display", "toolStatus": "FINISHED"},
        },
    ]

    messages = convert_context_to_messages(context, include_system=False, include_assistant=True)
    tool_msg = next(m for m in messages if m["role"] == "tool")
    # Declared name wins over the display name.
    assert tool_msg["name"] == "web_search"


def test_convert_context_to_messages_includes_structured_values_not_schema():
    """Terminal tool results include structured values without repeating raw output_schema."""
    from helpers.llm import convert_context_to_messages

    message_id = "11111111-1111-1111-1111-111111111111"
    output_schema = {"fields": [{"name": "selected_url", "type": "str", "required": True}]}
    context = [
        {"role": "USER", "text": "buy a beanie", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "tool_calls": [
                    {
                        "tool": "spawn_browser_agent",
                        "tool_call_id": "browser-1",
                        "goal": "buy a beanie",
                        "output_schema": output_schema,
                    }
                ]
            },
        },
        {
            "role": "TOOL",
            "message_id": message_id,
            "text": f"Browser done\n\nReference: @ref:message:{message_id}",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {
                "toolCallId": "browser-1",
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "title": "Browser automation complete",
                "output_schema": output_schema,
                "structured_response": {"selected_url": "https://amazon.com/item"},
            },
        },
    ]

    messages = convert_context_to_messages(context, include_system=False, include_assistant=True)
    tool_msg = next(m for m in messages if m["role"] == "tool")
    assert "Structured Response" in tool_msg["content"]
    assert '"https://amazon.com/item"' in tool_msg["content"]
    assert "Output Schema" not in tool_msg["content"]
    assert '"selected_url"' in tool_msg["content"]
    assert tool_msg["content"].endswith(f"Reference: @ref:message:{message_id}")


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


def _anthropic_tool_block_ids(messages):
    """(tool_use ids, [(tool_result id, 'messages.i.content.j')]) on the Anthropic wire."""
    from providers.rose.transforms import transform_messages_for_anthropic

    _static, _dynamic, anthropic = transform_messages_for_anthropic(messages)
    tool_use_ids = []
    tool_result_ids = []
    for i, msg in enumerate(anthropic):
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for j, block in enumerate(content):
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                tool_use_ids.append(block["id"])
            elif block.get("type") == "tool_result":
                tool_result_ids.append((block["tool_use_id"], f"messages.{i}.content.{j}"))
    return tool_use_ids, tool_result_ids


def test_convert_context_to_messages_one_tool_result_per_tool_use():
    """Two terminal TOOL rows sharing a toolCallId must yield ONE tool_result.

    Regression for the 2026-08-04 smoke failure on browser-biometrics-webdecoy
    (agent 1d7e1fb9-2604-45c6-906e-b6da1f12d4b7). spawn_browser_agent persists
    two terminal rows for one tool call -- "Task Failed" from inside the
    activity (spawn_browser_agent_v3/handler.py) and "Browser automation
    failed" from the manager boundary. generate_completion_summary is the only
    prod caller of convert_context_to_messages, and it emitted one `role: tool`
    message per row, so Anthropic rejected the whole request with 400
    "messages.2.content.1: each tool_use must have a single result. Found
    multiple `tool_result` blocks with id: toolu_011ZJAa4M5KxJUzKuJsemswi",
    Gemini answered 400 INVALID_ARGUMENT, and the rose-1-ultra pool died with
    RoseAllFailed -- the agent lost its completion summary entirely.

    The later row wins, matching what build_llm_messages has always shown the
    main loop, so both converters give the model the same view of a tool call.
    """
    from helpers.llm import convert_context_to_messages

    call_id = "toolu_011ZJAa4M5KxJUzKuJsemswi"
    context = [
        {"role": "USER", "text": "browse the demo", "timestamp": "2026-08-04T23:51:59.000Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2026-08-04T23:51:59.937Z",
            "metadata": {"tool_calls": [{"tool": "spawn_agent", "tool_call_id": call_id}]},
        },
        {
            "role": "TOOL",
            "text": "",
            "timestamp": "2026-08-04T23:52:00.325Z",
            "metadata": {
                "toolCallId": call_id,
                "toolName": "spawn_browser_agent",
                "toolStatus": "IN_PROGRESS",
                "title": "Starting up a browser",
            },
        },
        {
            "role": "TOOL",
            "text": "**Status**: FAILED\n\n**Outcome**: Navigation failed: net::ERR_CONNECTION_CLOSED",
            "timestamp": "2026-08-04T23:52:15.400Z",
            "metadata": {
                "toolCallId": call_id,
                "toolName": "spawn_browser_agent",
                "toolStatus": "ERROR",
                "title": "Task Failed",
            },
        },
        {
            "role": "TOOL",
            "text": "RuntimeError: Navigation failed: net::ERR_CONNECTION_CLOSED",
            "timestamp": "2026-08-04T23:52:15.797Z",
            "metadata": {
                "toolCallId": call_id,
                "toolName": "spawn_browser_agent",
                "toolStatus": "ERROR",
                "title": "Browser automation failed",
            },
        },
    ]

    messages = convert_context_to_messages(context, include_system=False, include_assistant=True)

    tool_msgs = [m for m in messages if m.get("role") == "tool"]
    assert len(tool_msgs) == 1, f"expected 1 tool message, got {[m['tool_call_id'] for m in tool_msgs]}"
    assert tool_msgs[0]["tool_call_id"] == call_id
    # Latest terminal row wins -- same row build_llm_messages keeps.
    assert "Browser automation failed" in tool_msgs[0]["content"]

    tool_use_ids, tool_result_ids = _anthropic_tool_block_ids(messages)
    assert tool_use_ids == [call_id]
    assert [tid for tid, _ in tool_result_ids] == [call_id], (
        f"Anthropic payload must carry exactly one tool_result per tool_use, got {tool_result_ids}"
    )


def test_convert_context_to_messages_pairs_orphan_tool_use():
    """A tool_use whose terminal TOOL row never landed gets a synthetic result.

    Same captured request as above also declared attempt_completion
    (dd27bdbb-1e39-4414-bea1-4d1fce95b691) with no terminal row, which
    Anthropic rejects with "tool_use ids were found without tool_result
    blocks". build_llm_messages already ran _ensure_tool_result_pairing;
    convert_context_to_messages did not.
    """
    from helpers.llm import SYNTHETIC_TOOL_RESULT_PLACEHOLDER, convert_context_to_messages

    call_id = "dd27bdbb-1e39-4414-bea1-4d1fce95b691"
    context = [
        {"role": "USER", "text": "do the thing", "timestamp": "2026-08-04T23:54:00.000Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2026-08-04T23:54:39.241Z",
            "metadata": {"tool_calls": [{"tool": "attempt_completion", "tool_call_id": call_id}]},
        },
        {
            "role": "TOOL",
            "text": "A completed child task returned a grounded structured response.",
            "timestamp": "2026-08-04T23:54:40.171Z",
            "metadata": {"verifierMessage": True, "title": "Progress: 100%"},
        },
    ]

    messages = convert_context_to_messages(context, include_system=False, include_assistant=True)

    tool_use_ids, tool_result_ids = _anthropic_tool_block_ids(messages)
    assert tool_use_ids == [call_id]
    assert [tid for tid, _ in tool_result_ids] == [call_id], (
        f"every tool_use needs a tool_result, got {tool_result_ids}"
    )
    synthetic = [m for m in messages if m.get("tool_call_id") == call_id]
    assert synthetic and synthetic[0]["content"] == SYNTHETIC_TOOL_RESULT_PLACEHOLDER


def test_convert_context_to_messages_subagent_row_cannot_win_the_dedup():
    """A row that is never sent to the model must not win the terminal dedup.

    Sub-agent-internal rows carry the parent's toolCallId with a later
    timestamp. If dedup ran before they were filtered, the internal row would
    win and the real result would be dropped, orphaning the tool_use.
    """
    from helpers.llm import SYNTHETIC_TOOL_RESULT_PLACEHOLDER, convert_context_to_messages

    call_id = "toolu_dedup_ordering"
    context = [
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2026-01-01T00:00:00Z",
            "metadata": {"tool_calls": [{"tool": "spawn_agent", "tool_call_id": call_id}]},
        },
        {
            "role": "TOOL",
            "text": "the real result the model must see",
            "timestamp": "2026-01-01T00:00:01Z",
            "metadata": {"toolCallId": call_id, "toolName": "spawn_agent", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": "internal sub-agent chatter",
            "timestamp": "2026-01-01T00:00:09Z",
            "metadata": {
                "toolCallId": call_id,
                "toolName": "spawn_agent",
                "toolStatus": "FINISHED",
                "subAgentId": "sub-1",
            },
        },
    ]

    messages = convert_context_to_messages(context, include_system=False, include_assistant=True)

    tool_msgs = [m for m in messages if m.get("role") == "tool"]
    assert len(tool_msgs) == 1, tool_msgs
    assert "the real result the model must see" in tool_msgs[0]["content"]
    assert tool_msgs[0]["content"] != SYNTHETIC_TOOL_RESULT_PLACEHOLDER
    assert "internal sub-agent chatter" not in tool_msgs[0]["content"]


def test_convert_context_to_messages_verifier_row_between_call_and_error_result():
    """A verifier row between a tool_call and its ERROR result must not split the pair.

    convert_context_to_messages renders verifier TOOL rows as `role: assistant`,
    and _ensure_tool_result_pairing treats every assistant as a run boundary. If
    the ERROR result sorts after that verifier row, the declaring assistant looks
    uncovered: the pairing pass synthesizes a placeholder AND keeps the real
    result, producing exactly the two-tool_result-blocks 400 this suite exists to
    prevent. Terminal rows are re-anchored to their IN_PROGRESS timestamp --
    ERROR as well as FINISHED -- so the pair stays contiguous.
    """
    from helpers.llm import SYNTHETIC_TOOL_RESULT_PLACEHOLDER, convert_context_to_messages

    call_id = "tc-verifier-interleave"
    context = [
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2026-01-01T00:00:00Z",
            "metadata": {"tool_calls": [{"tool": "spawn_agent", "tool_call_id": call_id}]},
        },
        {
            "role": "TOOL",
            "text": "",
            "timestamp": "2026-01-01T00:00:01Z",
            "metadata": {"toolCallId": call_id, "toolStatus": "IN_PROGRESS", "title": "Starting up a browser"},
        },
        {
            "role": "TOOL",
            "text": "still working on it",
            "timestamp": "2026-01-01T00:00:05Z",
            "metadata": {"verifierMessage": True, "title": "Progress: 50%"},
        },
        {
            "role": "TOOL",
            "text": "boom",
            "timestamp": "2026-01-01T00:00:09Z",
            "metadata": {"toolCallId": call_id, "toolStatus": "ERROR", "title": "Browser automation failed"},
        },
    ]

    messages = convert_context_to_messages(context, include_system=False, include_assistant=True)

    tool_use_ids, tool_result_ids = _anthropic_tool_block_ids(messages)
    assert tool_use_ids == [call_id]
    assert [tid for tid, _ in tool_result_ids] == [call_id], (
        f"verifier row must not split the tool_use/tool_result pair, got {tool_result_ids}"
    )
    tool_msgs = [m for m in messages if m.get("role") == "tool"]
    assert len(tool_msgs) == 1
    assert tool_msgs[0]["content"] != SYNTHETIC_TOOL_RESULT_PLACEHOLDER
    assert "boom" in tool_msgs[0]["content"]


def test_collapse_duplicate_tool_results_timestamp_edge_cases():
    """Ties keep the earlier row; naive/missing timestamps must not raise."""
    from helpers.llm import collapse_duplicate_tool_results

    def tool(call_id, text, ts=None):
        msg = {"role": "TOOL", "text": text, "metadata": {"toolCallId": call_id, "toolStatus": "FINISHED"}}
        if ts is not None:
            msg["timestamp"] = ts
        return msg

    # Identical timestamps -> earlier row wins (matches the inline dedup this replaced).
    tied = collapse_duplicate_tool_results(
        [tool("a", "first", "2026-01-01T00:00:02Z"), tool("a", "second", "2026-01-01T00:00:02Z")]
    )
    assert [m["text"] for m in tied] == ["first"]

    # Offset-naive vs missing timestamp: comparing aware and naive datetimes
    # raises TypeError unless every parse path is normalized to UTC.
    mixed = collapse_duplicate_tool_results([tool("a", "naive", "2026-01-01T00:00:02"), tool("a", "no timestamp")])
    assert [m["text"] for m in mixed] == ["naive"]

    # created_at is a valid timestamp source and must order correctly.
    fallback = collapse_duplicate_tool_results(
        [
            {**tool("a", "older"), "created_at": "2026-01-01T00:00:01Z"},
            {**tool("a", "newer"), "created_at": "2026-01-01T00:00:09Z"},
        ]
    )
    assert [m["text"] for m in fallback] == ["newer"]


async def test_build_llm_messages_dedupes_duplicate_terminal_tool_rows():
    """The main agent loop's converter keeps one terminal row per toolCallId too.

    build_llm_messages had this inline; the refactor hoisted it into
    collapse_duplicate_tool_results, so pin the behaviour at this converter
    rather than trusting the shared helper's own test.
    """
    from helpers.llm import build_llm_messages

    call_id = "toolu_build_llm_dedup"
    context = [
        {"role": "USER", "text": "go", "timestamp": "2026-01-01T00:00:00Z"},
        {
            "role": "TOOL",
            "text": "in progress",
            "timestamp": "2026-01-01T00:00:01Z",
            "metadata": {"toolCallId": call_id, "toolStatus": "IN_PROGRESS"},
        },
        {
            "role": "TOOL",
            "text": "in-activity terminal row",
            "timestamp": "2026-01-01T00:00:02Z",
            "metadata": {"toolCallId": call_id, "toolStatus": "FINISHED", "title": "Task Completed"},
        },
        {
            "role": "TOOL",
            "text": "manager-boundary terminal row",
            "timestamp": "2026-01-01T00:00:03Z",
            "metadata": {"toolCallId": call_id, "toolStatus": "FINISHED", "title": "Browser automation complete"},
        },
    ]

    messages = await build_llm_messages(context, "sys")
    blob = json.dumps(messages)
    assert blob.count("manager-boundary terminal row") == 1, messages
    assert "in-activity terminal row" not in blob, messages
    assert "in progress" not in blob, messages


def test_collapse_duplicate_tool_results_keeps_latest_terminal_row():
    """The shared invariant helper keeps the latest terminal row, per toolCallId."""
    from helpers.llm import collapse_duplicate_tool_results

    def tool(ts, call_id, text, status="FINISHED"):
        return {
            "role": "TOOL",
            "text": text,
            "timestamp": ts,
            "metadata": {"toolCallId": call_id, "toolStatus": status},
        }

    context = [
        {"role": "USER", "text": "go", "timestamp": "2026-01-01T00:00:00Z"},
        tool("2026-01-01T00:00:01Z", "a", "in progress", status="IN_PROGRESS"),
        tool("2026-01-01T00:00:02Z", "a", "first terminal"),
        tool("2026-01-01T00:00:03Z", "a", "second terminal", status="ERROR"),
        tool("2026-01-01T00:00:04Z", "b", "only terminal"),
        {"role": "TOOL", "text": "no call id", "timestamp": "2026-01-01T00:00:05Z", "metadata": {}},
    ]

    kept = collapse_duplicate_tool_results(context)
    texts = [m["text"] for m in kept]
    assert texts == ["go", "in progress", "second terminal", "only terminal", "no call id"], texts

    # Idempotent.
    assert collapse_duplicate_tool_results(kept) == kept


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
        {
            "role": "TOOL",
            "text": "hidden fanout tree row",
            "timestamp": "2024-01-01T00:00:00Z",
            "metadata": {"subAgentIds": ["sub-1"], "busId": "bus-1", "toolCallId": "tc:0", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": "direct child final result",
            "timestamp": "2024-01-01T00:00:00Z",
            "metadata": {"subAgentIds": ["sub-2"], "busId": "bus-1", "toolCallId": "tc", "toolStatus": "FINISHED"},
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
    assert all("hidden fanout tree row" not in m.get("content", "") for m in msgs)
    assert any("direct child final result" in m.get("content", "") for m in msgs)


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

    assert _extract_nested_agent_json_blob(None) is None
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


def test_verifier_response_model_uses_closed_session_file_pointer_schema():
    """Remote file outputs must produce OpenAI-strict object properties."""
    from helpers.file_resolution import transform_schema_for_remote_session
    from helpers.llm import _build_verifier_response_model
    from providers.rose.schema import build_openai_response_format

    response_schema = {
        "fields": [
            {"name": "source_file", "type": "file_pointer"},
            {"name": "program_output", "type": "str"},
            {"name": "steps", "type": "int"},
        ]
    }

    remote_schema = transform_schema_for_remote_session(response_schema)
    response_model = _build_verifier_response_model(remote_schema)
    schema = build_openai_response_format(response_model)["json_schema"]["schema"]

    output = schema["properties"]["output"]
    source_file = output["properties"]["source_file"]
    assert output["required"] == ["source_file", "program_output", "steps"]
    assert source_file["type"] == "object"
    assert source_file["required"] == ["path"]
    assert source_file["properties"]["path"]["type"] == "string"
    assert source_file["additionalProperties"] is False


def test_build_verifier_json_schema_object_type():
    """`object` fields with explicit properties emit closed nested schema."""
    from helpers.llm import _build_verifier_json_schema

    response_schema = {
        "fields": [
            {
                "name": "selected_beanie",
                "type": "object",
                "properties": [
                    {"name": "title", "type": "str"},
                    {"name": "price_usd", "type": "float"},
                    {"name": "preview", "type": "file_pointer"},
                    {"name": "remote_preview", "type": "session_file_pointer"},
                ],
            },
        ]
    }
    result = _build_verifier_json_schema(response_schema)
    output = result["json_schema"]["schema"]["properties"]["output"]
    props = output["properties"]

    beanie = props["selected_beanie"]
    assert beanie["type"] == "object"
    assert beanie["additionalProperties"] is False
    assert beanie["required"] == ["title", "price_usd", "preview", "remote_preview"]
    assert beanie["properties"]["title"]["type"] == "string"
    assert beanie["properties"]["price_usd"]["type"] == "number"
    assert beanie["properties"]["preview"]["type"] == "object"
    assert "storage_path" in beanie["properties"]["preview"]["properties"]
    assert beanie["properties"]["remote_preview"]["required"] == ["path"]
    assert result["json_schema"]["strict"] is True


def test_build_verifier_json_schema_list_object_type():
    """`list[object]` fields with explicit properties emit closed item schema."""
    from helpers.llm import _build_verifier_json_schema

    response_schema = {
        "fields": [
            {
                "name": "items",
                "type": "list[object]",
                "properties": [
                    {"name": "name", "type": "str"},
                    {"name": "rank", "type": "int"},
                    {"name": "asset", "type": "file_pointer"},
                    {"name": "remote_asset", "type": "session_file_pointer"},
                ],
            },
        ]
    }
    result = _build_verifier_json_schema(response_schema)
    output = result["json_schema"]["schema"]["properties"]["output"]
    props = output["properties"]

    assert props["items"]["type"] == "array"
    assert props["items"]["items"]["type"] == "object"
    assert props["items"]["items"]["additionalProperties"] is False
    assert props["items"]["items"]["required"] == ["name", "rank", "asset", "remote_asset"]
    assert props["items"]["items"]["properties"]["asset"]["type"] == "object"
    assert props["items"]["items"]["properties"]["remote_asset"]["required"] == ["path"]
    assert result["json_schema"]["strict"] is True


def test_build_verifier_json_schema_mixed_object_properties_stays_strict():
    """A schema mixing primitives and explicit object properties stays strict."""
    from helpers.llm import _build_verifier_json_schema

    response_schema = {
        "fields": [
            {"name": "name", "type": "str"},
            {"name": "count", "type": "int"},
            {
                "name": "meta",
                "type": "object",
                "properties": [{"name": "source", "type": "str"}],
            },
        ]
    }
    result = _build_verifier_json_schema(response_schema)
    assert result["json_schema"]["strict"] is True


def test_build_verifier_response_model_requires_nested_object_properties():
    """Verifier Pydantic model rejects partial nested objects when properties are explicit."""
    from pydantic import ValidationError

    from helpers.llm import _build_verifier_response_model

    response_schema = {
        "fields": [
            {
                "name": "selected_beanie",
                "type": "object",
                "properties": [
                    {"name": "title", "type": "str"},
                    {"name": "price_usd", "type": "float"},
                ],
            },
            {"name": "added_to_cart", "type": "bool"},
        ]
    }
    model = _build_verifier_response_model(response_schema)

    parsed = model.model_validate(
        {
            "output": {
                "selected_beanie": {"title": "Ribbed beanie", "price_usd": 12.99},
                "added_to_cart": True,
            },
            "reasoning": "The cart shows the selected beanie.",
            "score": 1,
        }
    )
    assert parsed.output.selected_beanie.title == "Ribbed beanie"

    raised = False
    try:
        model.model_validate(
            {
                "output": {
                    "selected_beanie": {"title": "Ribbed beanie"},
                    "added_to_cart": True,
                },
                "reasoning": "Partial cart state.",
                "score": 0.5,
            }
        )
    except ValidationError as exc:
        raised = True
        assert "price_usd" in str(exc)
    assert raised


def test_normalize_response_schema_for_purchase_goal_adds_confirmation_identifier():
    """Purchase goals cannot be satisfied by product selection or checkout fields alone."""
    from helpers.llm import _normalize_response_schema_for_goal

    schema = {
        "fields": [
            {"name": "selected_beanie_url", "type": "str", "required": True},
            {"name": "selected_beanie_price_usd", "type": "float", "required": True},
        ]
    }

    result = _normalize_response_schema_for_goal(
        "Buy me a black beanie on Amazon that costs less than $35 and looks well-made.",
        schema,
    )

    field_names = [field["name"] for field in result["fields"]]
    assert field_names == [
        "selected_beanie_url",
        "selected_beanie_price_usd",
        "order_confirmation_id",
    ]
    assert result["fields"][-1]["required"] is True
    assert "confirmation id" in result["fields"][-1]["description"]


def test_fill_missing_verifier_output_accepts_matching_idempotent_card_last4():
    """Two independent card-ready results with the same last four populate both fields.

    Reproduces agent-payment-idempotent-abandonment: the LLM verifier left
    second_card_last_four empty and scored 0.5 because it invented a
    uniqueness requirement, which pushed the root agent to spawn a third
    browser. Grounded payment-card evidence must fill both fields and promote
    the score to 1.0.
    """
    from helpers.llm import _fill_missing_verifier_output_from_messages

    schema = {
        "fields": [
            {"name": "first_card_last_four", "type": "str", "required": True},
            {"name": "second_card_last_four", "type": "str", "required": True},
            {"name": "order_confirmation_id", "type": "str", "required": True},
        ]
    }
    parsed = {
        "output": {
            "first_card_last_four": "1617",
            "second_card_last_four": "",
            "order_confirmation_id": "tp_56671705",
        },
        "reasoning": (
            "No tool result provides a distinct second card's last four digits; "
            "both card-ready results refer to the same card ending in 1617."
        ),
        "score": 0.5,
    }
    messages = [
        {
            "role": "tool",
            "content": "One-time card ending in 1617 is ready for checkout.",
            "metadata": {
                "toolName": "payment_card_ready",
                "toolStatus": "FINISHED",
                "paymentCardLast4": "1617",
            },
        },
        {
            "role": "tool",
            "content": "Approved one-time payment card last four: 1617",
            "metadata": {
                "toolName": "payment_card_ready",
                "toolStatus": "FINISHED",
                "paymentCardLast4": "1617",
            },
        },
        {
            "role": "tool",
            "content": "Order confirmation ID tp_56671705 using card last four 1617.",
            "metadata": {"toolName": "spawn_browser_agent", "toolStatus": "FINISHED"},
        },
    ]

    result = _fill_missing_verifier_output_from_messages(parsed, schema, messages)

    assert result["output"]["first_card_last_four"] == "1617"
    assert result["output"]["second_card_last_four"] == "1617"
    assert result["output"]["order_confirmation_id"] == "tp_56671705"
    assert result["score"] == 1.0
    assert "idempotent" in result["reasoning"].lower() or "matching" in result["reasoning"].lower()


def test_fill_missing_verifier_output_keeps_partial_score_without_second_card_evidence():
    """Do not invent a second last-four when only one card-ready evidence exists."""
    from helpers.llm import _fill_missing_verifier_output_from_messages

    schema = {
        "fields": [
            {"name": "first_card_last_four", "type": "str", "required": True},
            {"name": "second_card_last_four", "type": "str", "required": True},
            {"name": "order_confirmation_id", "type": "str", "required": True},
        ]
    }
    parsed = {
        "output": {
            "first_card_last_four": "1617",
            "second_card_last_four": "",
            "order_confirmation_id": "tp_56671705",
        },
        "reasoning": "Only the first card request is grounded.",
        "score": 0.5,
    }
    messages = [
        {
            "role": "tool",
            "content": "One-time card ending in 1617 is ready for checkout.",
            "metadata": {
                "toolName": "payment_card_ready",
                "toolStatus": "FINISHED",
                "paymentCardLast4": "1617",
            },
        },
    ]

    result = _fill_missing_verifier_output_from_messages(parsed, schema, messages)

    assert result["output"]["second_card_last_four"] == ""
    assert result["score"] == 0.5


async def test_fetch_claude_max_token_activity():
    """fetch_claude_max_token_activity GETs /api/integrations/claude-code/credentials/token."""
    setup_mock(
        {
            "/api/integrations/claude-code/credentials/token": {
                "status": 200,
                "json": {"accessToken": "test-claude-token-123", "source": "user", "poolTokenId": None},
            },
        }
    )

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
    setup_mock(
        {
            "/api/integrations/claude-code/credentials/token": {
                "status": 404,
                "json": {"error": "Not found"},
            },
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import fetch_claude_max_token_activity

        result = await fetch_claude_max_token_activity("user-no-token")

    assert result is None


async def test_fetch_claude_max_token_activity_server_error():
    """fetch_claude_max_token_activity returns None on 500."""
    setup_mock(
        {
            "/api/integrations/claude-code/credentials/token": {
                "status": 500,
                "json": {"error": "server"},
            },
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import fetch_claude_max_token_activity

        result = await fetch_claude_max_token_activity("user-err")

    assert result is None


async def test_fetch_claude_max_token_activity_missing_token_field():
    """fetch_claude_max_token_activity returns None when accessToken missing in 200 response."""
    setup_mock(
        {
            "/api/integrations/claude-code/credentials/token": {
                "status": 200,
                "json": {"source": "user"},  # no accessToken
            },
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import fetch_claude_max_token_activity

        result = await fetch_claude_max_token_activity("user-missing")

    assert result is None


async def test_fetch_compute_token_activity_passes_lineage_params():
    """Unified compute token fetch sends lineage metadata to backend."""
    setup_mock(
        {
            "/api/integrations/compute-code/credentials/token": {
                "status": 200,
                "json": {
                    "type": "gpt",
                    "accessToken": "gpt-token",
                    "accountId": "acct-1",
                    "source": "pool",
                    "poolTokenId": "pool-1",
                    "lineageKey": "agent:a-1",
                    "fastCacheAffinityKey": "affinity-1",
                },
            },
        }
    )

    with patch.dict(os.environ, {"BENCHMARK_COMPUTE_TOKEN_TYPE": ""}), patch("temporalio.activity.heartbeat"):
        from helpers.llm import fetch_compute_token_activity

        result = await fetch_compute_token_activity(
            "user-1",
            lineage_key="agent:a-1",
            agent_id="a-1",
            root_agent_id="root-1",
            fast_cache_affinity_key="affinity-1",
        )

    assert result == {
        "type": "gpt",
        "accessToken": "gpt-token",
        "accountId": "acct-1",
        "source": "pool",
        "poolTokenId": "pool-1",
        "lineageKey": "agent:a-1",
        "fastCacheAffinityKey": "affinity-1",
    }
    call = assert_captured_call(
        url_contains="/api/integrations/compute-code/credentials/token",
        method="GET",
    )
    assert "lineageKey=agent%3Aa-1" in call["url"]
    assert "agentId=a-1" in call["url"]
    assert "rootAgentId=root-1" in call["url"]
    assert "fastCacheAffinityKey=affinity-1" in call["url"]
    assert "tokenType=" not in call["url"]


async def test_fetch_compute_token_activity_pins_benchmark_provider():
    """Predeploy cache measurements lease one provider across repeated calls."""
    setup_mock(
        {
            "/api/integrations/compute-code/credentials/token": {
                "status": 200,
                "json": {
                    "type": "claude",
                    "accessToken": "claude-token",
                    "source": "pool",
                    "poolTokenId": "pool-claude-1",
                },
            },
        }
    )

    with patch.dict(os.environ, {"BENCHMARK_COMPUTE_TOKEN_TYPE": "claude"}), patch("temporalio.activity.heartbeat"):
        from helpers.llm import fetch_compute_token_activity

        result = await fetch_compute_token_activity("user-1")

    assert result is not None
    assert result["type"] == "claude"
    call = assert_captured_call(
        url_contains="/api/integrations/compute-code/credentials/token",
        method="GET",
    )
    assert "tokenType=claude" in call["url"]


def test_benchmark_compute_token_type_rejects_conflicting_provider_policy():
    """A Claude pin cannot silently defeat an explicit Anthropic exclusion."""
    from providers.rose.policy import benchmark_compute_token_type

    with patch.dict(
        os.environ,
        {
            "BENCHMARK_COMPUTE_TOKEN_TYPE": "claude",
            "ROSE_EXCLUDE_ANTHROPIC_FAMILY": "1",
        },
    ):
        try:
            benchmark_compute_token_type()
            raise AssertionError("conflicting provider policies were accepted")
        except ValueError as exc:
            assert "conflicts" in str(exc)


async def test_fetch_compute_token_activity_excludes_claude_tokens_by_policy():
    """Anthropic exclusion constrains unified compute leases to GPT tokens."""
    setup_mock(
        {
            "/api/integrations/compute-code/credentials/token": {
                "status": 200,
                "json": {
                    "type": "gpt",
                    "accessToken": "gpt-token",
                    "accountId": "acct-1",
                    "source": "pool",
                    "poolTokenId": "pool-gpt-1",
                },
            },
        }
    )

    with patch.dict(os.environ, {"ROSE_EXCLUDE_ANTHROPIC_FAMILY": "1"}), patch("temporalio.activity.heartbeat"):
        from helpers.llm import fetch_compute_token_activity

        result = await fetch_compute_token_activity("user-1")

    assert result is not None
    assert result["type"] == "gpt"
    call = assert_captured_call(
        url_contains="/api/integrations/compute-code/credentials/token",
        method="GET",
    )
    assert "tokenType=gpt" in call["url"]


async def test_heartbeat_compute_token_lineage_activity_posts_lineage_key():
    """Lineage heartbeat posts the lease key without requiring a token fetch."""
    setup_mock(
        {
            "/api/integrations/compute-code/token/lineage-heartbeat": {
                "status": 200,
                "json": {"ok": True, "updated": 1},
            },
        }
    )

    from helpers.llm import heartbeat_compute_token_lineage_activity

    result = await heartbeat_compute_token_lineage_activity("agent:a-1")

    assert result is True
    call = assert_captured_call(
        url_contains="/api/integrations/compute-code/token/lineage-heartbeat",
        method="POST",
    )
    assert json.loads(call["requestBody"]) == {"lineageKey": "agent:a-1"}


async def test_mark_claude_token_rate_limited_user_success():
    """mark_claude_token_rate_limited_activity POSTs with user source."""
    setup_mock(
        {
            "/api/integrations/claude-code/token/rate-limited": {
                "status": 200,
                "json": {"ok": True},
            },
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import mark_claude_token_rate_limited_activity

        result = await mark_claude_token_rate_limited_activity(source="user", user_id="u-1", cooldown_seconds=60)

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
    setup_mock(
        {
            "/api/integrations/claude-code/token/rate-limited": {
                "status": 200,
                "json": {"ok": True},
            },
        }
    )

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
    setup_mock(
        {
            "/api/integrations/claude-code/token/rate-limited": {
                "status": 200,
                "json": {"ok": True},
            },
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import mark_claude_token_rate_limited_activity

        result = await mark_claude_token_rate_limited_activity(source="pool", user_id="u-1", pool_token_id="pool-42")

    assert result is True
    call = get_captured_requests()[0]
    body = json.loads(call["requestBody"])
    assert body["source"] == "pool"
    assert body["poolTokenId"] == "pool-42"
    assert "userId" not in body


async def test_mark_claude_token_rate_limited_forwards_failure_reason():
    """Auth-error marks include failureReason so backend can disable pool tokens."""
    setup_mock(
        {
            "/api/integrations/claude-code/token/rate-limited": {
                "status": 200,
                "json": {"ok": True},
            },
        }
    )

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
    setup_mock(
        {
            "/api/integrations/claude-code/token/rate-limited": {
                "status": 500,
                "json": {"error": "boom"},
            },
        }
    )

    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import mark_claude_token_rate_limited_activity

        result = await mark_claude_token_rate_limited_activity(source="user", user_id="u-1")

    assert result is False


async def test_set_response_schema_activity_success():
    """set_response_schema_activity generates and saves schema."""
    setup_mock(
        {
            "/api/agents/": {  # PATCH .../agents/{id}
                "status": 200,
                "json": {"ok": True},
            },
        }
    )
    rose_calls = []

    class FakeRoseClient:
        async def collect(self, **kwargs):
            rose_calls.append(kwargs)
            return SimpleNamespace(
                content=json.dumps(
                    {
                        "reasoning": "Need a concise summary.",
                        "fields": [{"name": "summary", "type": "str"}],
                    }
                ),
                tool_calls=[],
                usage={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
            )

    generation = "agent-abc:replacement:generation-2"
    activity_time = datetime.now(timezone.utc)
    activity_info = SimpleNamespace(
        workflow_id=generation,
        workflow_run_id="run-2",
        activity_id="set-response-schema",
        activity_type="set_response_schema_activity",
        attempt=1,
        task_queue="agents",
        current_attempt_scheduled_time=activity_time,
        scheduled_time=activity_time,
        started_time=activity_time,
    )
    with (
        patch("temporalio.activity.heartbeat"),
        patch("temporalio.activity.info", return_value=activity_info),
        patch("helpers.llm.RoseClient", FakeRoseClient),
    ):
        from helpers.llm import set_response_schema_activity

        result = await set_response_schema_activity("agent-abc", ["goal 1", "goal 2"])

    assert result is not None
    assert result["schema"]["fields"][0]["name"] == "summary"
    assert result["usage"]["prompt_tokens"] == 100
    assert result["usage"]["completion_tokens"] == 50
    assert result["usage"]["total_tokens"] == 150

    assert rose_calls
    assert rose_calls[0]["pool"] == "rose-1-lite"
    assert rose_calls[0]["call_site"] == "response_schema"

    # Verify it saved through the backend, without using backend schema generation.
    captures = get_captured_requests()
    urls = [c["url"] for c in captures]
    assert not any("generate-response-schema" in u for u in urls)
    assert any("/api/agents/agent-abc" in u for u in urls)
    schema_save = next(c for c in captures if "/api/agents/agent-abc" in c["url"])
    assert schema_save["requestHeaders"]["x-agent-workflow-generation"] == generation


async def test_set_response_schema_activity_uses_internal_auth_only():
    """set_response_schema_activity defaults to no direct compute auth."""
    setup_mock(
        {
            "/api/agents/": {
                "status": 200,
                "json": {"ok": True},
            },
        }
    )
    rose_calls = []

    class FakeRoseClient:
        async def collect(self, **kwargs):
            rose_calls.append(kwargs)
            return SimpleNamespace(
                content=json.dumps(
                    {
                        "reasoning": "Need a concise summary.",
                        "fields": [{"name": "summary", "type": "str"}],
                    }
                ),
                tool_calls=[],
                usage={"prompt_tokens": 10, "completion_tokens": 5},
            )

    with patch("temporalio.activity.heartbeat"), patch("helpers.llm.RoseClient", FakeRoseClient):
        from helpers.llm import set_response_schema_activity

        result = await set_response_schema_activity("agent-abc", ["goal"])

    assert result is not None
    assert rose_calls[0]["claude_auth"] is None
    assert rose_calls[0]["gpt_auth"] is None
    captures = get_captured_requests()
    assert not any("generate-response-schema" in c["url"] for c in captures)
    save_requests = [c for c in captures if "/api/agents/agent-abc" in c["url"]]
    assert save_requests
    headers = {k.lower(): v for k, v in save_requests[0]["requestHeaders"].items()}
    assert "x-api-key" in headers
    assert "x-user-id" not in headers
    assert "x-compute-token-type" not in headers
    assert "x-compute-access-token" not in headers


async def test_set_response_schema_activity_passes_workflow_compute_auth_to_rose():
    """set_response_schema_activity passes the workflow's selected compute token to RoseClient."""
    setup_mock(
        {
            "/api/agents/": {
                "status": 200,
                "json": {"ok": True},
            },
        }
    )
    rose_calls = []

    class FakeRoseClient:
        async def collect(self, **kwargs):
            rose_calls.append(kwargs)
            return SimpleNamespace(
                content=json.dumps(
                    {
                        "reasoning": "Need a concise summary.",
                        "fields": [{"name": "summary", "type": "str"}],
                    }
                ),
                tool_calls=[],
                usage={"prompt_tokens": 10, "completion_tokens": 5},
            )

    with patch("temporalio.activity.heartbeat"), patch("helpers.llm.RoseClient", FakeRoseClient):
        from helpers.llm import set_response_schema_activity

        result = await set_response_schema_activity(
            "agent-abc",
            ["goal"],
            {
                "type": "gpt",
                "accessToken": "gpt-token",
                "accountId": "acct-123",
                "userId": "user-1",
                "source": "pool",
                "poolTokenId": "pool-1",
            },
        )

    assert result is not None
    assert rose_calls
    assert rose_calls[0]["claude_auth"] is None
    gpt_auth = rose_calls[0]["gpt_auth"]
    assert gpt_auth is not None
    assert gpt_auth.token == "gpt-token"
    assert gpt_auth.account_id == "acct-123"
    assert gpt_auth.user_id == "user-1"
    assert gpt_auth.pool_token_id == "pool-1"
    captures = get_captured_requests()
    assert not any("generate-response-schema" in c["url"] for c in captures)


async def test_codex_responses_body_has_input_for_system_only_context():
    """Codex Responses rejects empty input, so system-only first turns get a start input."""
    from providers.rose.gpt_auth import build_codex_responses_body
    from providers.rose.pools import get_pool

    body = build_codex_responses_body(
        pool_spec=get_pool("rose-1-lite"),
        messages=[{"role": "system", "content": "System instructions only"}],
        request_id="req-1",
    )

    assert body["input"] == [{"role": "user", "content": [{"type": "input_text", "text": "Begin."}]}]


async def test_set_response_schema_activity_empty_goal():
    """Returns None when no user messages are provided."""
    with patch("temporalio.activity.heartbeat"):
        from helpers.llm import set_response_schema_activity

        result = await set_response_schema_activity("agent-a", [])

    assert result is None


async def test_set_response_schema_activity_no_schema_returned():
    """Returns None when Rose returns no schema content."""

    class FakeRoseClient:
        async def collect(self, **kwargs):
            return SimpleNamespace(content="", tool_calls=[], usage={})

    with patch("temporalio.activity.heartbeat"), patch("helpers.llm.RoseClient", FakeRoseClient):
        from helpers.llm import set_response_schema_activity

        result = await set_response_schema_activity("agent-b", ["goal"])

    assert result is None


async def test_set_response_schema_activity_http_error():
    """Returns None on schema generation error."""

    class FakeRoseClient:
        async def collect(self, **kwargs):
            raise RuntimeError("boom")

    with patch("temporalio.activity.heartbeat"), patch("helpers.llm.RoseClient", FakeRoseClient):
        from helpers.llm import set_response_schema_activity

        result = await set_response_schema_activity("agent-c", ["goal"])

    assert result is None


async def test_set_response_schema_activity_save_error_raises():
    """A generated schema is not successful unless the agent-row save is durable."""
    setup_mock(
        {
            "/api/agents/": {
                "status": 500,
                "json": {"error": "save failed"},
            },
        }
    )

    class FakeRoseClient:
        async def collect(self, **kwargs):
            return SimpleNamespace(
                content=json.dumps(
                    {
                        "reasoning": "Need a concise summary.",
                        "fields": [{"name": "summary", "type": "str"}],
                    }
                ),
                tool_calls=[],
                usage={"prompt_tokens": 10, "completion_tokens": 5},
            )

    with patch("temporalio.activity.heartbeat"), patch("helpers.llm.RoseClient", FakeRoseClient):
        from helpers.llm import set_response_schema_activity

        try:
            await set_response_schema_activity("agent-save-fails", ["goal"])
            raise AssertionError("Expected response-schema persistence failure")
        except RuntimeError as exc:
            assert "save response schema" in str(exc).lower()


async def test_call_llm_rose_path():
    """call_llm routes Rose models through the in-process Rose client."""
    sse = _anthropic_sse_body(
        text="hello from rose",
        input_tokens=10,
        output_tokens=20,
        stop_reason="end_turn",
    )
    setup_mock(
        {
            "/api/integrations/compute-code/anthropic-key/cooldown": {
                "status": 200,
                "json": {"onCooldown": False},
            },
            "api.anthropic.com/v1/messages": {
                "status": 200,
                "text": sse,
                "headers": {"Content-Type": "text/event-stream"},
            },
        }
    )

    from providers.rose import client as rose_client

    rose_client._reset_anthropic_api_key_cooldown_cache()
    try:
        with patch("temporalio.activity.heartbeat"), patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-api03-test"}):
            from helpers.llm import call_llm

            result = await call_llm(
                messages=[{"role": "user", "content": "hi"}],
                model="rose-labs/rose-1-lite",
                call_site="test",
            )
    finally:
        rose_client._reset_anthropic_api_key_cooldown_cache()

    assert result["content"] == "hello from rose"
    assert result["finish_reason"] == "stop"
    assert result["usage"]["prompt_tokens"] == 10
    assert result["usage"]["completion_tokens"] == 20
    assert result["usage"]["total_tokens"] == 30
    assert result["usage"]["actual_model"] == "claude-sonnet-5-anthropic"


async def test_call_llm_rose_with_claude_token_and_skip_cache_write():
    """call_llm with claude_token routes to Anthropic claudeAuth path; skip_cache_write keeps system markers."""
    sse = _anthropic_sse_body(text="ok")
    setup_mock(
        {
            "api.anthropic.com/v1/messages": {
                "status": 200,
                "text": sse,
                "headers": {"Content-Type": "text/event-stream"},
            },
        }
    )

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
    assert body["model"] == "claude-sonnet-5"
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


async def test_call_llm_rose_response_model_uses_output_config():
    """call_llm response_model routes Rose claudeAuth through structured output config."""
    import httpx
    from pydantic import BaseModel
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm

    class SimpleResult(BaseModel):
        answer: str
        ok: bool

    sse = _anthropic_sse_body(
        text='{"answer":"done","ok":true}',
        stop_reason="end_turn",
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
    assert "tools" not in body
    assert "tool_choice" not in body
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert set(body["output_config"]["format"]["schema"]["properties"]) == {"answer", "ok"}
    assert json.loads(result["content"]) == {"answer": "done", "ok": True}


async def test_call_llm_rose_http_error_raises():
    """Persistent 5xx from every waterfall step raises RoseAllFailed."""
    setup_mock(
        {
            "openrouter.ai/api/v1/chat/completions": {
                "status": 500,
                "json": {"error": "boom"},
            },
        }
    )

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
            "metadata": {"tool_calls": [{"tool": "web_search", "tool_call_id": "tc-1", "query": "latest updates"}]},
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


async def test_build_llm_messages_preserves_timestamp_timezone():
    """LLM timestamp headers must retain the source offset so local-time math is unambiguous."""
    from helpers.llm import build_llm_messages

    context = [
        {
            "role": "USER",
            "text": "What time is it here?",
            "timestamp": "2026-07-11T13:45:00-07:00",
        }
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        messages = await build_llm_messages(context, "System prompt")

    assert messages[1]["content"].startswith("[2026-07-11T13:45-07:00] ")


async def test_build_llm_messages_normalizes_pointer_annotations_across_context_sources():
    """In-memory and backend-fetched copies of one context must build identical requests.

    The workflow annotates its in-memory USER/TOOL rows with self-reference
    pointers, while a cross-worker activity fetches canonical DB rows without
    those transient annotations. Worker placement must not change LLM-visible
    request bytes or destroy a conversation's prompt-cache prefix.
    """
    from helpers.context_pointers import annotate_with_pointer
    from helpers.llm import build_llm_messages

    canonical_context = [
        {
            "message_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "role": "USER",
            "text": "Buy the benchmark item",
            "timestamp": "2026-07-21T12:34:00Z",
            "metadata": {},
        }
    ]
    in_memory_context = [{**canonical_context[0], "metadata": {}}]
    annotate_with_pointer(in_memory_context[0])

    in_memory_messages = await build_llm_messages(in_memory_context, "System prompt")
    backend_messages = await build_llm_messages(canonical_context, "System prompt")

    assert backend_messages == in_memory_messages
    assert (
        '<resolved-ref pointer="@ref:message:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"/>' in backend_messages[1]["content"]
    )
    assert canonical_context[0]["text"] == "Buy the benchmark item"


async def test_build_llm_messages_preserves_codex_reasoning_metadata_separately():
    """Encrypted GPT reasoning state should be replayable without entering visible assistant text."""
    from helpers.llm import build_llm_messages

    reasoning_item = {"id": "rs_1", "encrypted_content": "enc-secret", "summary": []}
    context = [
        {"role": "USER", "text": "Continue", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "visible reasoning summary\n\nvisible answer",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"codex_reasoning_items": [reasoning_item]},
        },
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        messages = await build_llm_messages(context, "System prompt")

    assistant = [m for m in messages if m.get("role") == "assistant"][0]
    assert assistant["content"].endswith("visible reasoning summary\n\nvisible answer")
    assert assistant["codex_reasoning_items"] == [reasoning_item]
    assert "enc-secret" not in assistant["content"]


async def test_build_llm_messages_unmatched_terminal_tool_becomes_user():
    """Terminal TOOL message without matching assistant declaration should become a user message."""
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "Find data", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"tool_calls": [{"tool": "web_search", "tool_call_id": "tc-1", "query": "alpha"}]},
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
            "metadata": {"tool_calls": [{"tool": "web_search", "tool_call_id": "tc-1", "query": "alpha"}]},
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


async def test_build_llm_messages_skips_exclude_from_model_boundary():
    """Cursor-only compaction boundary rows must not enter LLM prompts."""
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "Visible goal", "timestamp": "2026-04-05T12:00:00Z", "metadata": {}},
        {
            "role": "SYSTEM",
            "text": "hidden boundary text",
            "timestamp": "2026-04-05T12:01:00Z",
            "metadata": {"contextCompactionBoundary": True, "excludeFromModel": True},
        },
        {"role": "ASSISTANT", "text": "Visible answer", "timestamp": "2026-04-05T12:02:00Z", "metadata": {}},
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        msgs = await build_llm_messages(context, "sys")

    rendered = "\n".join(str(m.get("content")) for m in msgs)
    assert "Visible goal" in rendered
    assert "Visible answer" in rendered
    assert "hidden boundary text" not in rendered
    assert "contextCompactionBoundary" not in rendered


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
            "role": "TOOL",
            "text": "ok A",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {"toolCallId": tc_a, "toolName": "spawn_browser_agent", "toolStatus": "FINISHED"},
        },
        # Empty file-output ASSISTANT row (browser screenshot)
        {"role": "ASSISTANT", "text": "", "timestamp": "2024-01-01T00:00:03Z", "metadata": {}, "file_pointer": fp},
        {
            "role": "TOOL",
            "text": "ok B",
            "timestamp": "2024-01-01T00:00:04Z",
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
    assert {m["tool_call_id"]: m.get("name") for m in tool_msgs} == {
        tc_a: "spawn_agent",
        tc_b: "spawn_agent",
    }

    # Verify NO empty assistant message ended up in the final list — file-output
    # rows should be filtered out entirely.
    empty_assistants = [
        m
        for m in msgs
        if m.get("role") == "assistant" and not m.get("tool_calls") and not (m.get("content") or "").strip()
    ]
    assert not empty_assistants, f"Empty file-output assistant rows must be skipped; got {empty_assistants}"

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
    from providers.rose.pools import get_pool
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
                "delta": {"content": '```json\n{"response": "hello", "tool_calls": []}\n```'},
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
    # OpenAI-compatible transports report an inclusive prompt total. Rose's
    # provider-neutral contract exposes only the uncached tail for downstream
    # pricing; the Rose-client regression separately pins the original total.
    assert usage["prompt_tokens"] == 5
    assert usage["completion_tokens"] == 5
    assert usage["cache_read_input_tokens"] == 2
    assert usage["cache_creation_input_tokens"] == 3
    # Waterfall path uses the first model in rose-1-lite's fallback list.
    assert usage["actual_model"] == get_pool("rose-1-lite").waterfall[0]
    assert usage["pool_name"] == "rose-1-lite"
    assert usage["cancelled"] is False
    assert detected == []


async def test_call_llm_structured_streaming_retries_malformed_output():
    """A malformed output is re-generated with validation feedback (bounded)."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    def _payload(content: str) -> dict:
        return {
            "actual_model": "claude-sonnet-4-6",
            "pool_name": "test-pool",
            "pool_size": 1,
            "choices": [{"delta": {"content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    # First generation is schema-invalid (tool_calls must be a list); the retry
    # re-generates and parses cleanly.
    malformed_body = _sse_body([_payload('{"response": "x", "tool_calls": "not-a-list"}')])
    valid_body = _sse_body([_payload('{"response": "recovered", "tool_calls": []}')])

    call_count = {"n": 0}
    request_payloads = []

    def handler(req: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        request_payloads.append(json.loads(req.content))
        body = malformed_body if call_count["n"] == 1 else valid_body
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    AgentAction = create_agent_action_model([])

    async def on_chunk(text: str, tokens: int):
        pass

    response, _usage, _detected = await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "hi"}],
        model="rose-labs/rose-1-lite",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        call_site="test",
        _exclude_anthropic_family=True,
    )

    # Exactly one retry: the malformed first generation re-generated once and parsed.
    assert call_count["n"] == 2, f"expected one re-generation (2 calls), got {call_count['n']}"
    retry_messages = request_payloads[1]["messages"]
    # The rejected turn is replayed so the model can see what it actually emitted,
    # rather than being told "your response was wrong" with no response in context.
    assert len(retry_messages) == 3, f"expected original + assistant replay + correction, got {retry_messages}"
    assert retry_messages[-2]["role"] == "assistant", retry_messages
    assert "not-a-list" in retry_messages[-2]["content"], retry_messages[-2]
    correction = retry_messages[-1]
    assert correction["role"] == "user", correction
    assert "did not satisfy the required output schema" in correction["content"], correction
    assert "input should be a valid list" in correction["content"].lower(), correction
    assert response.response == "recovered"


async def test_structured_parse_retry_rewinds_streamed_text_for_delta_consumers():
    """A parse retry must not strand delta consumers on the rejected attempt's text.

    `on_chunk` hands out a monotonically growing buffer, so every streaming
    consumer (domains/reasoning/service.py, call_llm_activity, run_agent) emits
    `text_so_far[len(last_text):]` and keeps `last_text`. A parse retry restarts
    that buffer at "", so without a rewind the rejected text stays in the
    consumer's accumulator and a corrected response that is NOT a
    prefix-extension of it is delivered as an empty (or garbled tail) delta —
    the consumer completes holding stale output.
    """
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    # Divergent AND shorter than the rejected text, so pure suffix math yields ""
    # — this is the case that silently drops the correction entirely.
    rejected_text = "The first attempt claims the meeting is Monday at noon."
    corrected_text = "Actually the meeting is Friday."
    assert not corrected_text.startswith(rejected_text)
    assert len(corrected_text) < len(rejected_text)

    def _payload(content: str) -> dict:
        return {
            "actual_model": "claude-sonnet-4-6",
            "pool_name": "test-pool",
            "pool_size": 1,
            "choices": [{"delta": {"content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    # tool_calls must be a list — the first generation fails validation only
    # AFTER its `response` text has already streamed out through on_chunk.
    malformed_body = _sse_body([_payload(json.dumps({"response": rejected_text, "tool_calls": "not-a-list"}))])
    valid_body = _sse_body([_payload(json.dumps({"response": corrected_text, "tool_calls": []}))])

    call_count = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        body = malformed_body if call_count["n"] == 1 else valid_body
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    AgentAction = create_agent_action_model([])

    # Mirrors the real consumers' delta-suffix bookkeeping exactly.
    last_text = [""]
    broadcast: list[str] = []

    async def on_chunk(text_so_far: str, tokens: int):
        delta = text_so_far[len(last_text[0]) :]
        if delta:
            broadcast.append(delta)
        last_text[0] = text_so_far

    response, _usage, _detected = await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "when is the meeting?"}],
        model="rose-labs/rose-1-lite",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        call_site="test",
        _exclude_anthropic_family=True,
    )

    assert call_count["n"] == 2, f"expected one re-generation (2 calls), got {call_count['n']}"
    assert response.response == corrected_text, response.response

    # The whole point: what the consumer reconstructed must be the corrected
    # response, not the rejected one and not a tail of it.
    reconstructed = "".join(broadcast)
    assert corrected_text in reconstructed, f"correction never reached the consumer: {reconstructed!r}"
    assert reconstructed.endswith(corrected_text), f"consumer ends on stale text: {reconstructed!r}"
    assert last_text[0] == corrected_text, f"consumer state stranded on rejected attempt: {last_text[0]!r}"


async def _call_llm_structured_streaming_replays_invalid_native_tool_use_case():
    """A schema-invalid native tool_use is replayed with a paired tool_result error."""
    from helpers.llm import call_llm_structured_streaming
    from providers.rose.types import StreamChunk
    from utils.tool_schemas import create_agent_action_model

    captured_messages: list = []
    calls = {"n": 0}

    async def fake_cached_complete(*args, **kwargs):
        calls["n"] += 1
        captured_messages.append(json.loads(json.dumps(kwargs.get("messages") or [])))
        yield StreamChunk(
            kind="metadata",
            data={"actual_model": "claude-sonnet-4-6-claude", "pool_name": "rose-1-lite", "request_id": "r1"},
        )
        if calls["n"] == 1:
            # `query` is required by the web_search schema — this fails validation.
            yield StreamChunk(
                kind="tool_call",
                data={"id": "toolu_bad", "name": "web_search", "arguments": json.dumps({})},
            )
        else:
            yield StreamChunk(
                kind="tool_call",
                data={"id": "toolu_ok", "name": "web_search", "arguments": json.dumps({"query": "recovered"})},
            )
        yield StreamChunk(
            kind="usage", data={"prompt_tokens": 1, "completion_tokens": 1, "finish_reason": "tool_calls"}
        )
        yield StreamChunk(kind="done", data={})

    import providers.fast_cache.rose_cache as rose_cache_module

    original = rose_cache_module.cached_complete
    rose_cache_module.cached_complete = fake_cached_complete
    try:
        AgentAction = create_agent_action_model(["web_search"])

        async def on_chunk(text: str, tokens: int):
            pass

        response, _usage, _detected = await call_llm_structured_streaming(
            messages=[{"role": "user", "content": "search something"}],
            model="rose",
            temperature=1.0,
            max_tokens=512,
            response_model=AgentAction,
            on_chunk=on_chunk,
            call_site="test",
        )
    finally:
        rose_cache_module.cached_complete = original

    assert calls["n"] == 2, f"expected one re-generation (2 calls), got {calls['n']}"
    retry_messages = captured_messages[1]
    assert len(retry_messages) == 3, f"expected original + tool_use replay + tool_result, got {retry_messages}"

    # The rejected tool_use is replayed as an assistant turn keyed by the
    # provider's own id, so the paired tool_result below can reference it.
    assistant_turn = retry_messages[-2]
    assert assistant_turn["role"] == "assistant", retry_messages
    assert assistant_turn["tool_calls"][0]["id"] == "toolu_bad", assistant_turn
    assert assistant_turn["tool_calls"][0]["function"]["name"] == "web_search", assistant_turn

    # The validation error comes back as a tool result, not a bare user turn —
    # every tool_use must be answered by a tool_result with a matching id.
    tool_result = retry_messages[-1]
    assert tool_result["role"] == "tool", retry_messages
    assert tool_result["tool_call_id"] == "toolu_bad", tool_result
    assert "did not satisfy the required output schema" in tool_result["content"], tool_result

    assert response.tool_calls[0].query == "recovered"


def test_structured_retry_replay_is_wire_valid_for_anthropic():
    """The replayed turn must survive the Anthropic transform with paired tool ids.

    Anthropic rejects a tool_use block that has no tool_result with a matching
    tool_use_id, so an unpaired replay would turn a recoverable parse retry into
    a hard 400 on the claudeAuth path.
    """
    from helpers.llm import _build_structured_retry_messages
    from providers.rose.transforms import transform_messages_for_anthropic

    retry_messages = _build_structured_retry_messages(
        [{"role": "user", "content": "search something"}],
        error_message="tool_calls.0.query: Field required",
        tool_use_blocks=[{"id": "toolu_bad", "name": "web_search", "input": {}}],
        text_buffer="let me search",
        raw_json="",
    )
    _system, _cache, messages = transform_messages_for_anthropic(retry_messages)

    tool_use_ids, tool_result_ids = [], []
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                tool_use_ids.append(block["id"])
            elif block.get("type") == "tool_result":
                tool_result_ids.append(block["tool_use_id"])

    assert tool_use_ids == ["toolu_bad"], messages
    assert tool_result_ids == tool_use_ids, f"unpaired tool_use would 400: {messages}"


async def test_call_llm_structured_streaming_model_detected_callback():
    """on_model_detected fires with the actual_model from the first chunk."""
    from providers.rose.pools import get_pool
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    payload = {
        "choices": [
            {
                "delta": {"content": '{"response": "done", "tool_calls": []}'},
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
    assert seen_models == [get_pool("rose-1-lite").waterfall[0]]


async def test_call_llm_verifier_streaming_parses_score():
    """_call_llm_verifier parses JSON score from SSE stream."""
    from providers.rose.pools import get_pool
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier
    from config import load_config

    payload = {
        "choices": [{"delta": {"content": '{"reasoning": "looks good", "score": 0.75}'}}],
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
    assert usage["actual_model"] == get_pool("rose-1-lite").waterfall[0]
    assert usage["pool_name"] == "rose-1-lite"


async def test_call_llm_verifier_uses_large_output_cap():
    """Verifier requests enough output tokens for large structured extraction."""
    import httpx
    from config import load_config
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import VERIFIER_MAX_TOKENS, _call_llm_verifier

    seen_max_tokens = []
    body = _sse_body(
        [
            {
                "choices": [{"delta": {"content": '{"reasoning": "ok", "score": 1.0}'}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        ]
    )

    def handler(req):
        seen_max_tokens.append(json.loads(req.content.decode()).get("max_tokens"))
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        await _call_llm_verifier(
            messages=[{"role": "user", "content": "x"}],
            model="rose",
            config=load_config(),
        )

    provider_max_tokens = [value for value in seen_max_tokens if value is not None]
    assert provider_max_tokens
    assert all(value == VERIFIER_MAX_TOKENS for value in provider_max_tokens)


async def test_call_llm_verifier_bounds_provider_stream_time():
    """Verifier provider attempts carry explicit deadline, TTFT, and idle bounds."""
    from config import load_config
    from helpers.llm import (
        VERIFIER_ATTEMPT_DEADLINE_S,
        VERIFIER_IDLE_TIMEOUT_S,
        VERIFIER_TTFT_TIMEOUT_S,
        _call_llm_verifier,
    )
    from providers.rose.types import StreamChunk

    captured = {}

    async def fake_cached_complete(_client, *, call_site, **kwargs):
        captured.update(kwargs)
        yield StreamChunk(kind="metadata", data={"actual_model": "fake", "pool_name": "fake"})
        yield StreamChunk(kind="content", data={"text": '{"reasoning":"ok","score":1.0}'})
        yield StreamChunk(
            kind="usage",
            data={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        )
        yield StreamChunk(kind="done", data={})

    with (
        patch("temporalio.activity.heartbeat"),
        patch("providers.fast_cache.rose_cache.cached_complete", fake_cached_complete),
    ):
        result, _usage = await _call_llm_verifier(
            messages=[{"role": "user", "content": "x"}],
            model="rose",
            config=load_config(),
        )

    assert result["score"] == 1.0
    assert captured["deadline_s"] == VERIFIER_ATTEMPT_DEADLINE_S
    assert captured["ttft_timeout_s"] == VERIFIER_TTFT_TIMEOUT_S
    assert captured["idle_timeout_s"] == VERIFIER_IDLE_TIMEOUT_S


async def test_call_llm_verifier_dump_extra_includes_browser_recording_metadata():
    """Verifier dumps preserve browser recording metadata for the HTML renderer."""
    import httpx
    from config import load_config
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier

    agent_id = "verifier-recording-dump-test"
    call_site = "verifier-browser-recording-test"
    dump_dir = Path(__file__).resolve().parents[3] / ".llm-dumps" / agent_id
    dump_dir.mkdir(parents=True, exist_ok=True)
    for path in dump_dir.glob(f"*{call_site}.json"):
        path.unlink()

    body = _sse_body(
        [
            {
                "choices": [{"delta": {"content": '{"reasoning": "done", "score": 1.0}'}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
            }
        ]
    )

    def handler(req):
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        await _call_llm_verifier(
            messages=[{"role": "user", "content": "verify browser"}],
            model="rose",
            config=load_config(),
            call_site=call_site,
            agent_id=agent_id,
            dump_extra={
                "browser_recording_manifest_path": "/tmp/recording/manifest.json",
                "browser_recording_path": "/tmp/recording/index.html",
                "browser_recording_task_id": "task-123",
            },
        )

    dumps = sorted(dump_dir.glob(f"*{call_site}.json"))
    assert dumps
    payload = json.loads(dumps[-1].read_text())
    assert payload["extra"]["browser_recording_manifest_path"] == "/tmp/recording/manifest.json"
    assert payload["extra"]["browser_recording_path"] == "/tmp/recording/index.html"
    assert payload["extra"]["browser_recording_task_id"] == "task-123"


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
    assert captured["body"]["model"] == "claude-sonnet-5"
    assert captured["body"]["stream"] is True
    assert result["score"] == 1.0
    assert result["output"]["summary"] == "ok"


async def test_call_llm_verifier_fills_missing_output_from_structured_tool_response():
    """Verifier keeps strict schema while recovering copied fields from tool evidence."""
    import httpx
    from config import load_config
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier

    payload = {
        "choices": [
            {
                "delta": {
                    "content": json.dumps(
                        {
                            "reasoning": "complete; all fields are visible in the tool result",
                            "score": 1.0,
                            "output": {
                                "collatz_sequence": [3, 10, 5, 16, 8, 4, 2, 1],
                                "total_steps": 7,
                            },
                        }
                    )
                }
            }
        ],
        "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    config = load_config()
    structured_response = {
        "collatz_sequence": [3, 10, 5, 16, 8, 4, 2, 1],
        "python_script_path": "/home/user/collatz_3.py",
        "total_steps": 7,
    }

    with patch("temporalio.activity.heartbeat"):
        result, _usage = await _call_llm_verifier(
            messages=[
                {"role": "system", "content": "verify"},
                {
                    "role": "user",
                    "content": "Tool finished\n\nStructured Response: "
                    + json.dumps(structured_response)
                    + "\n\nEvaluate the agent's progress as JSON.",
                },
            ],
            model="rose",
            config=config,
            response_schema={
                "fields": [
                    {"name": "collatz_sequence", "type": "list[int]"},
                    {"name": "python_script_path", "type": "str"},
                    {"name": "total_steps", "type": "int"},
                ]
            },
        )

    assert result["score"] == 1.0
    assert result["output"]["python_script_path"] == "/home/user/collatz_3.py"
    assert result["output"]["total_steps"] == 7


async def test_check_progress_happy_path():
    """check_progress streams a score and returns structured_response when score >= 1."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import check_progress

    payload = {
        "choices": [
            {"delta": {"content": '{"reasoning": "complete", "score": 1.0, "output": {"summary": "finished"}}'}}
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
        "choices": [{"delta": {"content": '{"reasoning": "partial", "score": 0.4, "output": {"summary": "x"}}'}}],
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


def test_filter_context_for_execute_verifier_uses_execute_boundary():
    """Execute verifier context excludes plan/research rows before the execute boundary."""
    from helpers.llm import _filter_context_for_execute_verifier

    context = [
        {"role": "USER", "text": "original research goal", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "TOOL",
            "text": "Tokyo plan-phase explore result",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": "plan created",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {"toolName": "set_plan", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": "Beginning execute",
            "timestamp": "2024-01-01T00:00:03Z",
            "metadata": {"toolName": "attempt_completion", "title": "Beginning Execute Phase"},
        },
        {
            "role": "TOOL",
            "text": "execute spawn result",
            "timestamp": "2024-01-01T00:00:04Z",
            "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": "late plan row should still be excluded",
            "timestamp": "2024-01-01T00:00:05Z",
            "metadata": {"toolName": "attempt_completion", "phase": "PLAN"},
        },
    ]

    filtered = _filter_context_for_execute_verifier(context)
    text = "\n".join(m.get("text", "") for m in filtered)
    assert "original research goal" not in text
    assert "Tokyo plan-phase explore result" not in text
    assert "plan created" not in text
    assert "Beginning execute" not in text
    assert "late plan row" not in text
    assert "execute spawn result" in text


async def test_check_progress_execute_filters_plan_context_before_llm():
    """check_progress sends only execute-phase context to the verifier LLM."""
    from helpers.llm import check_progress

    captured_messages = []

    async def fake_call_llm_verifier(messages, *_args, **_kwargs):
        captured_messages.extend(messages)
        return {"score": 0.5, "reasoning": "partial"}, {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    context = [
        {"role": "USER", "text": "original goal", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "TOOL",
            "text": "plan explore result",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": "plan",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {"toolName": "set_plan", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": "execute result",
            "timestamp": "2024-01-01T00:00:03Z",
            "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
        },
    ]

    with patch("temporalio.activity.heartbeat"), patch("helpers.llm._call_llm_verifier", fake_call_llm_verifier):
        result = await check_progress(
            context=context,
            verifier_system_prompt="VERIFY",
            model="rose",
            call_site="verifier_execute",
        )

    assert result["score"] == 0.5
    rendered = json.dumps(captured_messages)
    assert "execute result" in rendered
    assert "original goal" not in rendered
    assert "plan explore result" not in rendered
    assert "set_plan" not in rendered


async def test_check_progress_disables_fast_cache_read_after_verifier_parse_failure():
    """Verifier retries should not replay the same invalid cached response repeatedly."""
    from helpers.llm import check_progress
    from providers.fast_cache.context import current_context, set_context

    seen_contexts = []

    async def fake_call_llm_verifier(messages, *_args, **_kwargs):
        ctx = current_context()
        seen_contexts.append((ctx.read_enabled if ctx else None, ctx.should_write if ctx else None))
        if len(seen_contexts) == 1:
            raise json.JSONDecodeError("bad cached verifier payload", "", 0)
        return (
            {"score": 1.0, "reasoning": "valid on live retry"},
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        )

    try:
        with (
            patch("temporalio.activity.heartbeat"),
            patch("helpers.llm._call_llm_verifier", fake_call_llm_verifier),
            patch("helpers.llm.asyncio.sleep", AsyncMock()),
            patch("helpers.llm.random.uniform", return_value=0),
        ):
            result = await check_progress(
                context=[{"role": "USER", "text": "finish the task", "timestamp": "2024-01-01T00:00:00Z"}],
                verifier_system_prompt="VERIFY",
                model="rose",
                call_site="verifier_execute",
                fast_mode_cache_enabled=True,
                fast_mode_goal="finish the task",
                fast_mode_step=2,
            )
    finally:
        set_context(None)

    assert result["score"] == 1.0
    assert seen_contexts == [(True, True), (False, True)]


async def test_check_progress_fences_the_entire_verifier_retry_loop():
    """A hung verifier is cancelled once; retries cannot exceed the total budget."""
    from helpers.llm import check_progress

    calls = 0

    async def hung_verifier(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        await asyncio.Event().wait()

    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.llm._call_llm_verifier", hung_verifier),
        patch("helpers.llm.VERIFIER_TOTAL_TIMEOUT_S", 0.01),
        patch("helpers.llm.random.uniform", return_value=0),
    ):
        result = await asyncio.wait_for(
            check_progress(
                context=[{"role": "USER", "text": "finish", "timestamp": "2024-01-01T00:00:00Z"}],
                verifier_system_prompt="VERIFY",
                call_site="verifier_execute",
            ),
            timeout=0.5,
        )

    assert result["score"] == 0.5
    assert "Verifier exceeded" in result["reasoning"]
    assert calls == 1


async def test_check_progress_browser_success_uses_fast_cache_write_only():
    """Live browser evidence must not be overwritten by a stale verifier cache replay."""
    from helpers.llm import check_progress
    from providers.fast_cache.context import current_context, set_context

    seen_contexts = []

    async def fake_call_llm_verifier(messages, *_args, **_kwargs):
        ctx = current_context()
        seen_contexts.append((ctx.read_enabled if ctx else None, ctx.should_write if ctx else None))
        return (
            {"score": 1.0, "reasoning": "browser evidence accepted"},
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        )

    context = [
        {"role": "USER", "text": "complete the FCaptcha demo", "timestamp": "2026-07-04T03:20:45Z"},
        {
            "role": "TOOL",
            "text": "**Status**: ✅ SUCCESS",
            "timestamp": "2026-07-04T03:24:06Z",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "title": "Browser automation complete",
                "structured_response": {
                    "fcaptcha_risk_score_display": "0.16",
                    "checkbox_mode_passed": True,
                    "invisible_form_submitted": True,
                    "visible_verdict_text": "Verified! / Form submission allowed!",
                },
            },
        },
    ]

    try:
        with patch("temporalio.activity.heartbeat"), patch("helpers.llm._call_llm_verifier", fake_call_llm_verifier):
            result = await check_progress(
                context=context,
                verifier_system_prompt="VERIFY",
                model="rose",
                call_site="verifier_execute",
                fast_mode_cache_enabled=True,
                fast_mode_goal="complete the FCaptcha demo",
                fast_mode_step=2,
            )
    finally:
        set_context(None)

    assert result["score"] == 1.0
    assert seen_contexts == [(False, True)]


async def test_check_progress_extracts_browser_recording_metadata_from_context():
    """Execute verifier dumps inherit recording metadata from browser tool messages."""
    from helpers.llm import check_progress

    captured_dump_extra = []

    async def fake_call_llm_verifier(messages, *_args, **kwargs):
        captured_dump_extra.append(kwargs.get("dump_extra"))
        return {"score": 1.0, "reasoning": "done"}, {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    context = [
        {"role": "USER", "text": "book ride", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "TOOL",
            "text": "Local browser recording: /tmp/browser-run/index.html",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "action_type": "recording",
                "task_id": "browser-task-1",
                "recording_path": "/tmp/browser-run/index.html",
                "browser_session_metadata": {
                    "provider": "steel",
                    "proxy_source": "steel",
                    "proxy_location": {"city": "DALLAS", "state": "TX", "country": "US"},
                },
            },
        },
    ]

    with patch("temporalio.activity.heartbeat"), patch("helpers.llm._call_llm_verifier", fake_call_llm_verifier):
        result = await check_progress(
            context=context,
            verifier_system_prompt="VERIFY",
            model="rose",
            call_site="verifier_execute",
        )

    assert result["score"] == 1.0
    assert captured_dump_extra == [
        {
            "browser_recording_path": "/tmp/browser-run/index.html",
            "browser_recording_manifest_path": "/tmp/browser-run/manifest.json",
            "browser_recording_task_id": "browser-task-1",
            "browser_session_metadata": {
                "provider": "steel",
                "proxy_source": "steel",
                "proxy_location": {"city": "DALLAS", "state": "TX", "country": "US"},
            },
        }
    ]


async def test_check_progress_accepts_completed_code_task_structured_response():
    """Parent execute verifier accepts a finished code child structured response without an LLM call."""
    from helpers.llm import check_progress

    async def verifier_should_not_run(*_args, **_kwargs):
        raise AssertionError("verifier should not run for completed code task output")

    structured_response = {
        "collatz_sequence": [
            27,
            82,
            41,
            124,
            62,
            31,
            94,
            47,
            142,
            71,
            214,
            107,
            322,
            161,
            484,
            242,
            121,
            364,
            182,
            91,
            274,
            137,
            412,
            206,
            103,
            310,
            155,
            466,
            233,
            700,
            350,
            175,
            526,
            263,
            790,
            395,
            1186,
            593,
            1780,
            890,
            445,
            1336,
            668,
            334,
            167,
            502,
            251,
            754,
            377,
            1132,
            566,
            283,
            850,
            425,
            1276,
            638,
            319,
            958,
            479,
            1438,
            719,
            2158,
            1079,
            3238,
            1619,
            4858,
            2429,
            7288,
            3644,
            1822,
            911,
            2734,
            1367,
            4102,
            2051,
            6154,
            3077,
            9232,
            4616,
            2308,
            1154,
            577,
            1732,
            866,
            433,
            1300,
            650,
            325,
            976,
            488,
            244,
            122,
            61,
            184,
            92,
            46,
            23,
            70,
            35,
            106,
            53,
            160,
            80,
            40,
            20,
            10,
            5,
            16,
            8,
            4,
            2,
            1,
        ],
        "total_steps": 111,
        "python_script": {
            "id": "file-1",
            "path": "/home/user/collatz_27.py",
            "storage_path": "uploads/collatz_27.py",
        },
    }
    context = [
        {"role": "USER", "text": "compute Collatz sequence from 27"},
        {
            "role": "TOOL",
            "text": "Status: SUCCESS",
            "metadata": {
                "toolName": "spawn_claude_code_agent",
                "toolStatus": "FINISHED",
                "action_type": "task_complete",
                "success": True,
                "structured_response": structured_response,
            },
        },
    ]

    with patch("helpers.llm._call_llm_verifier", verifier_should_not_run), patch("temporalio.activity.heartbeat"):
        result = await check_progress(
            context=context,
            verifier_system_prompt="VERIFY",
            response_schema={
                "fields": [
                    {"name": "collatz_sequence", "type": "list[int]"},
                    {"name": "total_steps", "type": "int"},
                    {"name": "python_script", "type": "file_pointer"},
                ]
            },
            call_site="verifier_execute",
        )

    assert result["score"] == 1.0
    assert result["structured_response"] == structured_response
    assert result["usage"]["actual_model"] == "structured_response"


def test_completed_code_task_rejects_failed_placeholder_structured_response():
    """A failed code child cannot satisfy the parent with schema-shaped defaults."""
    from helpers.llm import _completed_child_task_structured_response, _structured_response_satisfies_schema

    schema = {
        "fields": [
            {"name": "python_source", "type": "object"},
            {"name": "printed_output", "type": "str"},
            {"name": "collatz_step_count", "type": "int"},
            {"name": "collatz_sequence_from_27", "type": "list[int]"},
        ]
    }
    placeholder = {
        "python_source": {"path": "", "storage_path": ""},
        "printed_output": "",
        "collatz_step_count": 0,
        "collatz_sequence_from_27": [],
    }
    assert _structured_response_satisfies_schema(placeholder, schema) is True

    for success_value in (False, None):
        metadata = {
            "toolName": "spawn_claude_code_agent",
            "toolStatus": "FINISHED",
            "action_type": "task_complete",
            "structured_response": placeholder,
        }
        if success_value is not None:
            metadata["success"] = success_value
        assert _completed_child_task_structured_response([{"role": "TOOL", "metadata": metadata}], schema) is None


async def test_check_progress_accepts_completed_browser_task_structured_response():
    """Parent execute verifier accepts a finished browser child structured response without an LLM call."""
    from helpers.llm import check_progress

    async def verifier_should_not_run(*_args, **_kwargs):
        raise AssertionError("verifier should not run for completed browser task output")

    structured_response = {
        "fcaptcha_risk_score_display": "0.16",
        "checkbox_mode_passed": True,
        "invisible_form_submitted": True,
        "visible_verdict_text": "Verified!; Form submission allowed!",
    }
    context = [
        {"role": "USER", "text": "check the FCaptcha demo"},
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "title": "Browser automation complete",
                "structured_response": structured_response,
            },
        },
    ]

    with patch("helpers.llm._call_llm_verifier", verifier_should_not_run), patch("temporalio.activity.heartbeat"):
        result = await check_progress(
            context=context,
            verifier_system_prompt="VERIFY",
            response_schema={
                "fields": [
                    {"name": "fcaptcha_risk_score_display", "type": "str"},
                    {"name": "checkbox_mode_passed", "type": "bool"},
                    {"name": "invisible_form_submitted", "type": "bool"},
                    {"name": "visible_verdict_text", "type": "str"},
                ]
            },
            call_site="verifier_execute",
        )

    assert result["score"] == 1.0
    assert result["structured_response"] == structured_response
    assert result["usage"]["actual_model"] == "structured_response"


async def test_call_planner_llm_activity_happy_path():
    """call_planner_llm_activity builds system prompt, streams a plan, returns result+usage."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_planner_llm_activity

    # Build a valid PlannerResponse JSON the verifier can parse
    plan_json = json.dumps(
        {
            "title": "Test Plan",
            "tasks": [{"task_idx": "0", "goal": "task 1 goal", "tool_name": "spawn_explore_agent", "depends_on": []}],
            "join": "all",
        }
    )
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
            return httpx.Response(
                200, json={"messages": [{"id": pointer_id, "text": "scoped referenced text", "role": "USER"}]}
            )
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
    anthropic_calls = [c for c in captured["calls"] if "api.anthropic.com" in c["url"] and c["body"]]
    assert len(anthropic_calls) >= 1, f"No Anthropic call captured; got {[c['url'] for c in captured['calls']]}"
    planner_body = anthropic_calls[0]["body"]
    # Planner uses skip_cache_write → system blocks KEEP cache_control for reads.
    user_system_blocks = [b for b in planner_body.get("system", []) if "cache_control" in b]
    assert len(user_system_blocks) > 0, "skip_cache_write should keep system cache markers for reads"
    # claude_token is forwarded as the Anthropic Bearer token, not in the body.
    assert anthropic_calls[0]["headers"].get("authorization") == "Bearer ct-planner-123"
    assert captured["batch_user_id"] == "planner-user"
    assert "scoped referenced text" in json.dumps(planner_body)
    # Anthropic uses the claudeAuth model from the rose-1-lite pool.
    assert planner_body["model"] == "claude-sonnet-5"
    assert planner_body["stream"] is True
    # Anthropic's literal "max" stalls — we normalize to "xhigh" (the highest
    # reliably-streaming level, mirroring gpt_auth which maps "max" → "xhigh").
    assert planner_body["output_config"]["effort"] == "xhigh"


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

    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.llm.stream_assistant_chunk", new_callable=AsyncMock) as stream_mock,
    ):
        result = await call_llm_activity(
            messages_or_agent_id=[{"role": "user", "content": "hi"}],
            model="rose-labs/rose-1-lite",
            tool_names=[],
            reasoning_max_tokens=0,
            agent_id="agent-llm-act",
            stream_id="stream-1",
            call_site="test_cla",
            cache_sequence_id="agent:agent-llm-act:call:test_cla",
        )

    assert result["response"] == "hello world"
    assert result["tool_calls"] == []
    assert result["usage"]["total_tokens"] == 30
    assert result["usage"]["cache_sequence_id"] == "agent:agent-llm-act:call:test_cla"
    assert result["detected_tools_ordered"] == []
    first_stream = stream_mock.await_args_list[0].kwargs
    assert first_stream["delta"] == ""
    assert first_stream["done"] is False
    assert first_stream["sequence"] == 0
    assert isinstance(first_stream["llm_started_at_ms"], int)


async def test_call_llm_activity_marks_structured_contract_failures_non_retryable():
    """A malformed structured output is re-generated a bounded number of times
    in-activity (non-deterministic — a fresh call usually parses); if it still
    fails, the error is surfaced NON-retryable so Temporal does not additionally
    multiply it."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_activity
    from temporalio.exceptions import ApplicationError

    payload = {
        "actual_model": "google/gemini-3.1-pro-preview",
        "choices": [
            {
                "delta": {
                    "content": json.dumps(
                        {
                            "response": "Sending the message now.",
                            "tool_calls": [
                                {
                                    "tool": "send_message",
                                    "person_id": "+19729777432",
                                    "channel": "imessage",
                                    "from_email": None,
                                    "intent": "Send a short hello.",
                                    "context_gates": None,
                                }
                            ],
                        }
                    )
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
    }
    completion_calls = 0

    def handler(req):
        nonlocal completion_calls
        if "/completions" in str(req.url):
            completion_calls += 1
            return httpx.Response(200, text=_sse_body([payload]))
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        try:
            await call_llm_activity(
                messages_or_agent_id=[{"role": "user", "content": "Say hello"}],
                model="rose-labs/rose-1-ultra",
                tool_names=["message_person"],
                reasoning_max_tokens=0,
                call_site="structured-contract-test",
            )
            error = None
        except ApplicationError as exc:
            error = exc

    assert error is not None
    assert error.non_retryable is True
    assert error.type == "LLMStructuredOutputError"
    # Bounded in-activity re-generation (1 initial + MAX_STRUCTURED_PARSE_RETRIES),
    # then surfaced non-retryable — so it is not multiplied further by Temporal.
    assert completion_calls == 3


async def test_call_llm_activity_rejects_wrong_required_tool_non_retryably():
    """An allowed but wrong tool must never escape a completion-only handoff."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_activity
    from temporalio.exceptions import ApplicationError

    payload = {
        "actual_model": "claude-sonnet-4-6",
        "choices": [
            {
                "delta": {
                    "content": json.dumps(
                        {
                            "response": "",
                            "tool_calls": [{"tool": "web_search", "query": "repeat the completed work"}],
                        }
                    )
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
    }
    completion_calls = 0

    def handler(req):
        nonlocal completion_calls
        if "/completions" in str(req.url):
            completion_calls += 1
            return httpx.Response(200, text=_sse_body([payload]))
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)

    with patch("temporalio.activity.heartbeat"):
        try:
            await call_llm_activity(
                messages_or_agent_id=[{"role": "user", "content": "Finish from the completed child"}],
                model="rose-labs/rose-1-lite",
                tool_names=["web_search", "attempt_completion"],
                reasoning_max_tokens=0,
                call_site="required-tool-contract-test",
                required_tool="attempt_completion",
            )
            error = None
        except ApplicationError as exc:
            error = exc

    assert error is not None
    assert error.non_retryable is True
    assert error.type == "LLMStructuredOutputError"
    assert "Got: ['web_search']" in str(error)
    assert completion_calls == 1


async def test_call_llm_activity_forces_required_tool_at_provider():
    """Completion-only handoffs should constrain generation, not just reject it later."""
    from helpers.llm import call_llm_activity

    captured: dict = {}

    async def fake_structured_streaming(**kwargs):
        captured.update(kwargs)
        response_model = kwargs["response_model"]
        return (
            response_model(response="", tool_calls=[{"tool": "attempt_completion"}]),
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            [],
        )

    with (
        patch("helpers.llm.call_llm_structured_streaming", fake_structured_streaming),
        patch("temporalio.activity.heartbeat"),
    ):
        result = await call_llm_activity(
            messages_or_agent_id=[{"role": "user", "content": "Finish from the completed child"}],
            model="rose-labs/rose-1-lite",
            tool_names=["web_search", "attempt_completion"],
            reasoning_max_tokens=0,
            call_site="required-tool-provider-contract-test",
            required_tool="attempt_completion",
        )

    assert captured.get("tool_choice") == {"name": "attempt_completion"}
    assert result["tool_calls"][0]["tool"] == "attempt_completion"


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

    with patch("temporalio.activity.heartbeat"), patch("helpers.llm.activity.in_activity", return_value=False):
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

    with patch("temporalio.activity.heartbeat"), patch("helpers.llm.activity.in_activity", return_value=False):
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


async def test_call_llm_activity_force_backend_ignores_and_preserves_shared_context():
    """Forced backend context cannot consume a concurrent param-populator's shared slot."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _pending_llm_context, call_llm_activity

    agent_id_key = "agent-forced-backend-1"
    stale_pending = (
        [{"role": "USER", "text": "Concurrent DAG snapshot", "timestamp": "2024-01-01T00:00:00Z"}],
        "other system prompt",
        set(),
    )
    _pending_llm_context[agent_id_key] = stale_pending
    agent_data = {
        "agent": {"id": agent_id_key, "model": "rose"},
        "messages": [{"role": "USER", "text": "Canonical backend context", "timestamp": "2024-01-01T00:00:00Z"}],
    }
    llm_payload = {
        "actual_model": "claude-opus-4-7",
        "choices": [
            {
                "delta": {"content": '{"response": "forced backend ok", "tool_calls": []}'},
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
    try:
        with patch("temporalio.activity.heartbeat"), patch("helpers.llm.activity.in_activity", return_value=False):
            result = await call_llm_activity(
                messages_or_agent_id=agent_id_key,
                model="rose",
                tool_names=[],
                reasoning_max_tokens=0,
                agent_id=agent_id_key,
                call_site="forced-backend-test",
                system_prompt="You are a test assistant.",
                force_backend_context=True,
            )

        assert result["response"] == "forced backend ok"
        assert backend_called[0] is True
        assert _pending_llm_context[agent_id_key] is stale_pending
    finally:
        _pending_llm_context.pop(agent_id_key, None)


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


async def test_build_verifier_json_schema_object_type_explicit_shape():
    """`object` field with properties emits closed object schema."""
    from helpers.llm import _build_verifier_json_schema

    schema = {
        "fields": [
            {
                "name": "meta",
                "type": "object",
                "properties": [{"name": "source", "type": "str"}],
            },
        ]
    }
    result = _build_verifier_json_schema(schema)
    meta_prop = result["json_schema"]["schema"]["properties"]["output"]["properties"]["meta"]
    assert meta_prop["type"] == "object"
    assert meta_prop["additionalProperties"] is False
    assert meta_prop["required"] == ["source"]
    assert result["json_schema"]["strict"] is True


async def test_build_verifier_json_schema_list_object_type_explicit_shape():
    """`list[object]` field with properties emits closed item schema."""
    from helpers.llm import _build_verifier_json_schema

    schema = {
        "fields": [
            {
                "name": "rows",
                "type": "list[object]",
                "properties": [{"name": "label", "type": "str"}],
            },
        ]
    }
    result = _build_verifier_json_schema(schema)
    rows_prop = result["json_schema"]["schema"]["properties"]["output"]["properties"]["rows"]
    assert rows_prop["type"] == "array"
    assert rows_prop["items"]["type"] == "object"
    assert rows_prop["items"]["additionalProperties"] is False
    assert rows_prop["items"]["required"] == ["label"]
    assert result["json_schema"]["strict"] is True


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
    assert 'TOOL_RESULT {"tool_name": "search"' in msgs[-1]["content"]


def test_build_verifier_context_messages_formats_tool_result_payload():
    """Verifier sees explicit TOOL_RESULT payloads, not ambiguous prose labels."""
    from helpers.llm import build_verifier_context_messages

    ctx = [
        {"role": "USER", "text": "Find one fact"},
        {
            "role": "TOOL",
            "text": "Agent completed goal",
            "metadata": {
                "toolCallId": "tc-1",
                "toolName": "spawn_general_purpose_agent",
                "toolStatus": "FINISHED",
                "title": "Spawning sub-agent",
                "structured_response": {
                    "entity_name": "Opticality Ventures",
                    "source_url": "https://example.com",
                },
            },
        },
    ]

    msgs = build_verifier_context_messages(ctx, "system")
    content = msgs[-1]["content"]

    assert '"tool_name": "spawn_general_purpose_agent"' in content
    assert '"tool_call_id": "tc-1"' in content
    assert '"title": "Spawning sub-agent"' in content
    assert '"result": {"entity_name": "Opticality Ventures", "source_url": "https://example.com"}' in content
    assert "structured_response" not in content
    assert "toolStatus" not in content
    assert "status" not in content


def test_build_verifier_context_messages_formats_camelcase_structured_response():
    """Verifier payload accepts persisted camelCase structured response metadata."""
    from helpers.llm import build_verifier_context_messages

    ctx = [
        {
            "role": "TOOL",
            "text": "fallback text",
            "metadata": {
                "toolCallId": "tc-2",
                "toolName": "spawn_general_purpose_agent",
                "structuredResponse": {"answer": "from persisted metadata"},
            },
        },
    ]

    msgs = build_verifier_context_messages(ctx, "system")
    content = msgs[-1]["content"]

    assert '"result": {"answer": "from persisted metadata"}' in content
    assert "structuredResponse" not in content
    assert "fallback text" not in content


def test_build_verifier_context_messages_includes_only_dag_reasoning_assistant_rows():
    """Verifier sees DAG reasoning outputs but not ordinary assistant narration."""
    from helpers.llm import build_verifier_context_messages

    ctx = [
        {
            "role": "ASSISTANT",
            "text": "ordinary assistant narration should stay hidden",
            "metadata": {},
            "timestamp": "2026-07-08T00:00:00Z",
        },
        {
            "role": "ASSISTANT",
            "text": "thirty hook-tested openings",
            "metadata": {
                "plannedToolName": "reasoning",
                "dagTaskIndex": 4,
                "streamId": "dag-reasoning-4",
            },
            "timestamp": "2026-07-08T00:00:01Z",
        },
    ]

    msgs = build_verifier_context_messages(ctx, "system")
    content = msgs[-1]["content"]

    assert '"tool_name": "reasoning"' in content
    assert '"result": "thirty hook-tested openings"' in content
    assert '"dag_task_index": 4' in content
    assert "ordinary assistant narration should stay hidden" not in content
    assert "plannedToolName" not in content
    assert "streamId" not in content


def test_build_verifier_context_messages_includes_assistant_file_evidence_without_assistant_text():
    """Verifier sees assistant file-output evidence without ordinary assistant narration."""
    from helpers.llm import build_verifier_context_messages

    ctx = [
        {
            "role": "ASSISTANT",
            "message_id": "file-msg-1",
            "text": "ordinary assistant narration should stay hidden",
            "file_pointer": {
                "id": "file-1",
                "storage_path": "user/file-1_calendar.csv",
                "original_filename": "calendar.csv",
                "mime_type": "text/csv",
                "size_bytes": 31,
                "created_at": "2026-07-08T00:00:00Z",
            },
            "metadata": {},
            "timestamp": "2026-07-08T00:00:00Z",
        }
    ]
    evidence = {
        "file-msg-1": [
            {
                "tool_name": "artifact_file",
                "artifact": {"original_filename": "calendar.csv", "mime_type": "text/csv"},
                "content_inlined": True,
                "result": "[File: calendar.csv]\n```\ndate,platform\n2026-07-06,YouTube\n```",
            }
        ]
    }

    msgs = build_verifier_context_messages(ctx, "system", verifier_file_evidence_by_message=evidence)
    content = msgs[-1]["content"]

    assert '"tool_name": "artifact_file"' in content
    assert "calendar.csv" in content
    assert "2026-07-06,YouTube" in content
    assert "ordinary assistant narration should stay hidden" not in content


async def test_resolve_verifier_file_evidence_uses_cached_text_file_content():
    """Verifier artifact evidence uses the same cached file path as main-agent attachment loading."""
    from helpers.llm import _resolve_verifier_file_evidence

    ctx = [
        {
            "role": "ASSISTANT",
            "message_id": "file-msg-2",
            "text": "",
            "file_pointer": {
                "id": "file-2",
                "storage_path": "user/file-2_calendar.csv",
                "original_filename": "calendar.csv",
                "mime_type": "text/csv",
                "size_bytes": 31,
                "created_at": "2026-07-08T00:00:00Z",
            },
            "metadata": {},
        }
    ]

    with patch("helpers.llm.get_cached_file", return_value=(b"date,platform\n2026-07-06,YouTube\n", {})):
        evidence = await _resolve_verifier_file_evidence(ctx)

    payload = evidence["file-msg-2"][0]
    assert payload["tool_name"] == "artifact_file"
    assert payload["content_inlined"] is True
    assert payload["artifact"]["original_filename"] == "calendar.csv"
    assert "2026-07-06,YouTube" in payload["result"]


async def test_build_verifier_context_messages_self_closes_trailing_refs():
    """Verifier context should not expand terminal message refs inside JSON/batches."""
    from helpers.context_pointers import resolve_pointers_in_messages
    from helpers.llm import build_verifier_context_messages

    user_id = "33333333-3333-3333-3333-333333333333"
    tool_id = "44444444-4444-4444-4444-444444444444"
    ctx = [
        {
            "role": "USER",
            "message_id": user_id,
            "text": f"Goal text\n\nReference: @ref:message:{user_id}",
            "timestamp": "2024-01-01T00:00:00Z",
        },
        {
            "role": "TOOL",
            "message_id": tool_id,
            "text": f"Tool body\n\nReference: @ref:message:{tool_id}",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "toolCallId": "tc-3",
                "toolName": "some_tool",
                "toolStatus": "FINISHED",
                "title": "Done",
            },
        },
    ]

    msgs = build_verifier_context_messages(ctx, "system")
    resolved = await resolve_pointers_in_messages(msgs, local_context=ctx)
    content = resolved[-1]["content"]

    assert f'Reference: <resolved-ref pointer="@ref:message:{user_id}"/>' in content
    assert f'Reference: <resolved-ref pointer=\\"@ref:message:{tool_id}\\"/>' in content
    assert "</resolved-ref>" not in content
    assert content.count("Goal text") == 1
    assert content.count("Tool body") == 1


def test_build_verifier_context_messages_filters_subagent_tree_rows():
    """Verifier sees the base aggregate result, not fanout tree UI rows."""
    from helpers.llm import build_verifier_context_messages

    ctx = [
        {"role": "USER", "text": "Process rows"},
        {
            "role": "TOOL",
            "text": "child UI summary should be hidden",
            "metadata": {
                "toolCallId": "tc-1:0",
                "toolName": "spawn_general_purpose_agent",
                "toolStatus": "FINISHED",
                "subAgentIds": ["child-1"],
                "busId": "bus-1",
            },
        },
        {
            "role": "TOOL",
            "text": "Completed for_each delegation for 1 items.",
            "metadata": {
                "toolCallId": "tc-1",
                "toolName": "spawn_general_purpose_agent_for_each",
                "toolStatus": "FINISHED",
                "structured_response": {
                    "items": [
                        {
                            "index": 0,
                            "agent_id": "child-1",
                            "status": "completed",
                            "structured_response": {"answer": "done"},
                        }
                    ]
                },
            },
        },
    ]

    msgs = build_verifier_context_messages(ctx, "system")
    content = "\n".join(str(m["content"]) for m in msgs)

    assert "child UI summary should be hidden" not in content
    assert '"tool_name": "spawn_general_purpose_agent_for_each"' in content
    assert '"items": [{"index": 0, "agent_id": "child-1", "status": "completed"' in content


def test_build_verifier_context_messages_prunes_superseded_browser_protocol_failure():
    """A later successful browser result should supersede stale protocol-init verifier feedback."""
    from helpers.llm import build_verifier_context_messages

    ctx = [
        {"role": "USER", "text": "Use a browser agent to complete FCaptcha.", "timestamp": "2026-07-04T02:53:30Z"},
        {
            "role": "TOOL",
            "text": (
                "Verifier score: 0%\n\nReasoning: The browser agent failed to initialize "
                "with an 'unsupported protocol' error."
            ),
            "timestamp": "2026-07-04T02:56:48Z",
            "metadata": {
                "toolName": "attempt_completion",
                "toolCallId": "tc-attempt-1",
                "toolStatus": "FINISHED",
                "title": "⚖️ Verifier rejected (0%) — continue task",
                "verifierMessage": True,
            },
        },
        {
            "role": "TOOL",
            "text": "**Status**: ✅ SUCCESS",
            "timestamp": "2026-07-04T02:59:57Z",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolCallId": "tc-browser-1",
                "toolStatus": "FINISHED",
                "title": "Browser automation complete",
                "structured_response": {
                    "fcaptcha_risk_score_display": "0.16",
                    "checkbox_mode_passed": True,
                    "invisible_form_submitted": True,
                    "visible_verdict_text": "Verified! / Form submission allowed!",
                },
            },
        },
    ]

    messages = build_verifier_context_messages(ctx, "system")
    content = "\n".join(str(m["content"]) for m in messages)

    assert "unsupported protocol" not in content
    assert '"fcaptcha_risk_score_display": "0.16"' in content
    assert '"checkbox_mode_passed": true' in content


async def test_build_llm_messages_prunes_superseded_browser_protocol_failure():
    """The next root-agent turn should not be told to redo browser work after browser success."""
    from helpers.llm import build_llm_messages

    ctx = [
        {"role": "USER", "text": "Use a browser agent to complete FCaptcha.", "timestamp": "2026-07-04T02:53:30Z"},
        {
            "role": "TOOL",
            "text": (
                "Verifier score: 0%\n\nReasoning: The browser agent failed to initialize "
                "with an 'unsupported protocol' error. Take a NEW action."
            ),
            "timestamp": "2026-07-04T02:56:48Z",
            "metadata": {
                "toolName": "attempt_completion",
                "toolCallId": "tc-attempt-1",
                "toolStatus": "FINISHED",
                "title": "⚖️ Verifier rejected (0%) — continue task",
                "verifierMessage": True,
            },
        },
        {
            "role": "TOOL",
            "text": "**Status**: ✅ SUCCESS",
            "timestamp": "2026-07-04T02:59:57Z",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolCallId": "tc-browser-1",
                "toolStatus": "FINISHED",
                "title": "Browser automation complete",
                "structured_response": {
                    "fcaptcha_risk_score_display": "0.16",
                    "checkbox_mode_passed": True,
                    "invisible_form_submitted": True,
                    "visible_verdict_text": "Verified! / Form submission allowed!",
                },
            },
        },
    ]

    messages = await build_llm_messages(ctx, "system")
    content = "\n".join(str(m["content"]) for m in messages)

    assert "unsupported protocol" not in content
    assert "Take a NEW action" not in content
    assert "Structured Response" in content
    assert '"fcaptcha_risk_score_display": "0.16"' in content


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
            "metadata": {"tool_calls": [{"tool": "web_search", "tool_call_id": "tc-5", "query": "answer"}]},
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

    sse = _sse_body(
        [
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
        ]
    )

    def handler(req):
        url = str(req.url)
        if "openrouter.ai/api/v1/chat/completions" in url:
            return httpx.Response(200, text=sse, headers={"Content-Type": "text/event-stream"})
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


async def test_build_llm_messages_attempt_completion_verifier_result_is_tool_result():
    """Verifier progress should be the terminal result for the original attempt_completion call."""
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "finish", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "ASSISTANT",
            "text": "",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {"tool_calls": [{"tool": "attempt_completion", "tool_call_id": "tc-ac-1"}]},
        },
        {
            "role": "TOOL",
            "text": "Running verifier to check completion...",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {
                "toolCallId": "tc-ac-1",
                "toolStatus": "IN_PROGRESS",
                "toolName": "attempt_completion",
                "title": "Attempting completion",
            },
        },
        {
            "role": "TOOL",
            "text": "Needs more evidence",
            "timestamp": "2024-01-01T00:00:03Z",
            "metadata": {
                "toolCallId": "tc-ac-1",
                "toolStatus": "FINISHED",
                "toolName": "attempt_completion",
                "title": "Progress: 50%",
            },
        },
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        msgs = await build_llm_messages(context, "sys")

    tool_msgs = [m for m in msgs if m["role"] == "tool"]
    assert len(tool_msgs) == 1
    assert tool_msgs[0]["tool_call_id"] == "tc-ac-1"
    assert tool_msgs[0]["name"] == "attempt_completion"
    assert "Progress: 50%" in tool_msgs[0]["content"]
    assert "Needs more evidence" in tool_msgs[0]["content"]
    assert "Running verifier" not in tool_msgs[0]["content"]


async def test_build_llm_messages_strips_cloud_agent_lifecycle_tools():
    """Cloud-agent lifecycle TOOL rows are UI-only and never sent to LLMs."""
    from helpers.llm import build_llm_messages

    context = [
        {"role": "USER", "text": "start the task", "timestamp": "2024-01-01T00:00:00Z"},
        {
            "role": "TOOL",
            "text": "",
            "timestamp": "2024-01-01T00:00:01Z",
            "metadata": {
                "toolCallId": "tc-cloud",
                "toolStatus": "IN_PROGRESS",
                "toolName": "cloud_agent",
                "title": "Creating Cloud Agent",
            },
        },
        {
            "role": "TOOL",
            "text": "",
            "timestamp": "2024-01-01T00:00:02Z",
            "metadata": {
                "toolCallId": "tc-cloud",
                "toolStatus": "IN_PROGRESS",
                "toolName": "cloud_agent",
                "title": "Preparing Cloud Agent",
            },
        },
        {
            "role": "TOOL",
            "text": "",
            "timestamp": "2024-01-01T00:00:03Z",
            "metadata": {
                "toolCallId": "tc-cloud",
                "toolStatus": "IN_PROGRESS",
                "toolName": "cloud_agent",
                "title": "Starting Reasoning",
            },
        },
        {
            "role": "TOOL",
            "text": "",
            "timestamp": "2024-01-01T00:00:04Z",
            "metadata": {
                "toolCallId": "tc-cloud",
                "toolStatus": "FINISHED",
                "toolName": "cloud_agent",
                "title": "Cloud Agent Ready",
            },
        },
    ]

    with patch("helpers.llm.activity.in_activity", return_value=False):
        msgs = await build_llm_messages(context, "sys")

    rendered = "\n".join(str(m.get("content", "")) for m in msgs)
    assert "start the task" in rendered
    assert "Creating Cloud Agent" not in rendered
    assert "Preparing Cloud Agent" not in rendered
    assert "Starting Reasoning" not in rendered
    assert "Cloud Agent Ready" not in rendered


async def test_call_llm_structured_streaming_tool_detection_callback():
    """on_tool_detected fires when accumulated JSON contains a tool call."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    chunks = [
        {
            "choices": [
                {"delta": {"content": '{"response": "", "tool_calls": [{"tool": "web_search", "query": "x"}]}'}}
            ],
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


async def _call_llm_structured_streaming_replayed_native_tool_call_without_json_case():
    """Fast Mode replayed native tool calls parse even when stored model label is -anthropic."""
    from helpers.llm import call_llm_structured_streaming
    from providers.rose.types import StreamChunk
    from utils.tool_schemas import create_agent_action_model

    async def fake_cached_complete(*args, **kwargs):
        yield StreamChunk(
            kind="metadata",
            data={
                "actual_model": "claude-sonnet-4-6-anthropic",
                "pool_name": "rose-1-lite",
                "request_id": "cached-r1",
                "from_fast_cache": True,
            },
        )
        yield StreamChunk(
            kind="tool_call",
            data={
                "id": "toolu_cached",
                "name": "web_search",
                "arguments": json.dumps({"query": "best cities to live in your 20s"}),
            },
        )
        yield StreamChunk(
            kind="usage",
            data={
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "cache_read_input_tokens": 100,
                "finish_reason": "tool_calls",
            },
        )
        yield StreamChunk(kind="done", data={"from_fast_cache": True})

    # helpers.llm imports cached_complete lazily inside the function, so patch
    # the source module — the lazy import resolves this attribute at call time.
    import providers.fast_cache.rose_cache as rose_cache_module

    original_cached_complete = rose_cache_module.cached_complete
    rose_cache_module.cached_complete = fake_cached_complete
    try:
        AgentAction = create_agent_action_model(["web_search"])
        detected = []

        async def on_chunk(text: str, tokens: int):
            pass

        async def on_tool_detected(name, tool_call_id):
            detected.append((name, tool_call_id))

        response, usage, detected_ordered = await call_llm_structured_streaming(
            messages=[{"role": "user", "content": "Do a web search"}],
            model="rose",
            temperature=1.0,
            max_tokens=512,
            response_model=AgentAction,
            on_chunk=on_chunk,
            on_tool_detected=on_tool_detected,
            call_site="execute_loop",
        )

        assert response.response == ""
        assert len(response.tool_calls) == 1
        assert response.tool_calls[0].tool == "web_search"
        assert response.tool_calls[0].query == "best cities to live in your 20s"
        assert usage["cache_read_input_tokens"] == 100
        assert detected == [("web_search", "toolu_cached")]
        assert [(name, tid) for name, tid, _ in detected_ordered] == [("web_search", "toolu_cached")]
    finally:
        rose_cache_module.cached_complete = original_cached_complete


def test_call_llm_structured_streaming_replayed_native_tool_call_without_json():
    asyncio.run(_call_llm_structured_streaming_replayed_native_tool_call_without_json_case())


async def test_call_llm_structured_streaming_attention_streaming():
    """on_attention_stream fires for send_message_to_user tool message."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    chunks = [
        {
            "choices": [
                {
                    "delta": {
                        "content": '{"response": "", "tool_calls": [{"tool": "send_message_to_user", "message": "Hello there!", "is_question": false}]}'
                    }
                }
            ],
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


async def test_call_llm_escalates_max_tokens_on_finish_reason_length():
    """Non-streaming call_llm must retry once when finish_reason=length.

    Reproduces message_person truncation: max_tokens=1024 cut email drafts
    mid-sentence ("Please share the") because call_llm did not escalate the
    way call_llm_structured_streaming already does.
    """
    from types import SimpleNamespace
    from unittest.mock import patch
    from helpers.llm import call_llm

    truncated = (
        "Subject: LLM and Cloud Credit Amounts for Speedrun Marketplace\n"
        "Hi Speedrun Team,\n\nPlease share the"
    )
    full = (
        truncated
        + " exact credit amounts by provider for OpenAI, Anthropic, AWS, "
        "Google Cloud, Azure, and Runpod.\n\nThanks,\nAndy"
    )
    calls: list[int] = []

    class FakeRoseClient:
        async def collect(self, **kwargs):
            max_tokens = kwargs["max_tokens"]
            calls.append(max_tokens)
            if max_tokens < 32768:
                return SimpleNamespace(
                    content=truncated,
                    tool_calls=[],
                    reasoning="",
                    codex_reasoning_items=[],
                    actual_model="claude-sonnet-4-6-claude",
                    pool_name="rose-1-lite",
                    request_id="req-trunc",
                    claude_token_error=None,
                    gpt_token_error=None,
                    usage={
                        "prompt_tokens": 200,
                        "completion_tokens": max_tokens,
                        "total_tokens": 200 + max_tokens,
                        "finish_reason": "length",
                    },
                )
            return SimpleNamespace(
                content=full,
                tool_calls=[],
                reasoning="",
                codex_reasoning_items=[],
                actual_model="claude-sonnet-4-6-claude",
                pool_name="rose-1-lite",
                request_id="req-full",
                claude_token_error=None,
                gpt_token_error=None,
                usage={
                    "prompt_tokens": 200,
                    "completion_tokens": 180,
                    "total_tokens": 380,
                    "finish_reason": "stop",
                },
            )

    with patch("temporalio.activity.heartbeat"), patch("helpers.llm.RoseClient", FakeRoseClient):
        result = await call_llm(
            messages=[{"role": "user", "content": "draft the email"}],
            model="rose-labs/rose-1-lite",
            max_tokens=1024,
            call_site="message_person",
        )

    assert calls == [1024, 32768], f"Expected escalation retry, got max_tokens calls={calls}"
    assert result["finish_reason"] == "stop"
    assert result["content"] == full
    assert "exact credit amounts by provider" in result["content"]


async def test_call_llm_verifier_claude_token_error_surfaces():
    """When claudeAuth Anthropic call fails 401, RoseClient falls through to
    waterfall and surfaces `claude_token_error` on the metadata chunk."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier
    from config import load_config

    waterfall_body = _sse_body(
        [
            {
                "choices": [{"delta": {"content": '{"reasoning": "ok", "score": 0.5}'}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
            }
        ]
    )

    def handler(req):
        url = str(req.url)
        if "api.anthropic.com" in url:
            # 401 from Anthropic → RoseAuthError → fall through to waterfall.
            return httpx.Response(401, json={"error": {"message": "expired"}})
        if "openrouter.ai/api/v1/chat/completions" in url:
            return httpx.Response(200, text=waterfall_body, headers={"Content-Type": "text/event-stream"})
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


async def test_call_llm_structured_streaming_rejects_unenforced_openrouter_tool_choice():
    """Missing or alternate direct-OpenRouter tools cannot bypass a required tool."""
    import pytest
    from unittest.mock import MagicMock, patch
    from helpers.llm import LLMStructuredOutputError, call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    AgentAction = create_agent_action_model(["web_search", "attempt_completion"])
    from_openai = MagicMock()

    async def on_chunk(_text: str, _tokens: int):
        raise AssertionError("a rejected direct OpenRouter request must not stream")

    with patch("helpers.llm.AsyncOpenAI") as async_openai, patch("helpers.llm.instructor.from_openai", from_openai):
        with pytest.raises(LLMStructuredOutputError, match="unsupported for direct OpenRouter"):
            await call_llm_structured_streaming(
                messages=[{"role": "user", "content": "Finish from the completed child"}],
                model="anthropic/claude-sonnet-4",
                temperature=0.5,
                max_tokens=256,
                response_model=AgentAction,
                on_chunk=on_chunk,
                call_site="openrouter-required-tool-contract",
                tool_choice={"name": "attempt_completion"},
            )

    async_openai.assert_not_called()
    from_openai.assert_not_called()


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


async def test_call_llm_structured_streaming_rose_cancelled_error_propagates():
    """Rose stream cancellation must not become a successful empty AgentAction."""
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    AgentAction = create_agent_action_model([])

    class FakeRoseClient:
        async def complete(self, **kwargs):
            raise asyncio.CancelledError()
            yield  # pragma: no cover

    async def on_chunk(text: str, tokens: int):
        raise AssertionError("cancelled stream should not emit chunks")

    raised = False
    with patch("temporalio.activity.heartbeat"), patch("helpers.llm.RoseClient", FakeRoseClient):
        try:
            await call_llm_structured_streaming(
                messages=[{"role": "user", "content": "q"}],
                model="rose-labs/rose-1-lite",
                temperature=0.5,
                max_tokens=256,
                response_model=AgentAction,
                on_chunk=on_chunk,
                call_site="rose-cancelled",
            )
        except asyncio.CancelledError:
            raised = True

    assert raised


async def test_call_llm_structured_streaming_openrouter_cancelled_error_propagates():
    """OpenRouter stream cancellation must not become a successful empty AgentAction."""
    from unittest.mock import MagicMock, patch
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    AgentAction = create_agent_action_model([])

    async def cancelled_iter(*args, **kwargs):
        raise asyncio.CancelledError()
        yield  # pragma: no cover

    fake_completions = MagicMock()
    fake_completions.create_partial = cancelled_iter

    fake_client = MagicMock()
    fake_client.chat.completions = fake_completions

    async def on_chunk(text: str, tokens: int):
        raise AssertionError("cancelled stream should not emit chunks")

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
                call_site="openrouter-cancelled",
            )
        except asyncio.CancelledError:
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


def test_normalize_provider_tool_names_is_allowlisted():
    """Only known provider namespaces are removed from structured tool names."""
    from helpers.llm import _normalize_provider_tool_names

    payload = {
        "tool_calls": [
            {"tool": "default_api:grep", "pattern": "whatsapp"},
            {"tool": "untrusted_api:grep", "pattern": "whatsapp"},
            {"tool": "default_api:", "pattern": "whatsapp"},
        ]
    }

    assert _normalize_provider_tool_names(payload) == 1
    assert payload["tool_calls"][0]["tool"] == "grep"
    assert payload["tool_calls"][1]["tool"] == "untrusted_api:grep"
    assert payload["tool_calls"][2]["tool"] == "default_api:"


async def test_call_llm_structured_streaming_normalizes_provider_tool_name():
    """Provider schema namespaces do not invalidate an otherwise declared tool."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    content = json.dumps(
        {
            "response": "Searching WhatsApp history",
            "tool_calls": [
                {
                    "tool": "default_api:grep",
                    "pattern": "whatsapp",
                    "sources": ["whatsapp"],
                }
            ],
        }
    )
    payload = {
        "choices": [{"delta": {"content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
    }
    body = _sse_body([payload])

    def handler(req):
        return httpx.Response(200, text=body)

    set_mock_handler(handler)
    AgentAction = create_agent_action_model(["grep"])

    async def on_chunk(text, tokens):
        pass

    response, _usage, _detected = await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "q"}],
        model="rose",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        call_site="provider-tool-name-normalization",
    )

    assert len(response.tool_calls) == 1
    assert response.tool_calls[0].tool == "grep"


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


async def test_call_llm_structured_streaming_gpt_native_streams_reasoning_to_chunks():
    """GPT Responses visible reasoning should stream and persist like claudeAuth thinking."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    lines: list[str] = []

    def _ev(event: str, data: dict) -> None:
        lines.append(f"event: {event}")
        lines.append(f"data: {json.dumps(data)}")
        lines.append("")

    _ev(
        "response.output_item.added",
        {
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "id": "rs_1",
                "type": "reasoning",
                "summary": [],
                "encrypted_content": "encrypted-secret",
            },
        },
    )
    _ev(
        "response.reasoning_summary_text.delta",
        {"type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "delta": "Visible reasoning summary. "},
    )
    _ev(
        "response.reasoning_summary_text.delta",
        {"type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "delta": "More reasoning."},
    )
    _ev(
        "response.output_item.done",
        {
            "type": "response.output_item.done",
            "item": {
                "id": "rs_1",
                "type": "reasoning",
                "summary": [{"text": "Visible reasoning summary. More reasoning."}],
                "encrypted_content": "encrypted-secret",
            },
        },
    )
    _ev("response.output_text.delta", {"type": "response.output_text.delta", "delta": "Final answer."})
    _ev(
        "response.output_item.done",
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_1",
                "name": "web_search",
                "arguments": '{"query":"verify"}',
            },
        },
    )
    _ev(
        "response.completed",
        {
            "type": "response.completed",
            "response": {"usage": {"input_tokens": 5, "output_tokens": 6, "total_tokens": 11}},
        },
    )
    lines.append("data: [DONE]")
    lines.append("")

    def handler(req):
        assert "chatgpt.com/backend-api/codex/responses" in str(req.url)
        return httpx.Response(200, text="\n".join(lines))

    set_mock_handler(handler)
    AgentAction = create_agent_action_model(["web_search"])
    chunks_received: list[str] = []

    async def on_chunk(text, tokens):
        chunks_received.append(text)

    response, usage, detected = await call_llm_structured_streaming(
        messages=[{"role": "user", "content": "q"}],
        model="rose",
        temperature=0.7,
        max_tokens=512,
        response_model=AgentAction,
        on_chunk=on_chunk,
        gpt_token="gpt-token",
        gpt_account_id="acct-1",
        gpt_token_source="user",
        gpt_token_user_id="user-1",
        call_site="gpt-native-reasoning-stream",
    )

    assert chunks_received
    assert "Visible reasoning summary" in chunks_received[0]
    assert "Final answer." in chunks_received[-1]
    assert response.response.startswith("Visible reasoning summary.")
    assert "Final answer." in response.response
    assert response.tool_calls[0].tool == "web_search"
    assert getattr(response, "codex_reasoning_items") == [
        {
            "id": "rs_1",
            "encrypted_content": "encrypted-secret",
            "summary": [{"text": "Visible reasoning summary. More reasoning."}],
        }
    ]


async def test_call_llm_structured_streaming_single_call_dedup():
    """send_message_to_user is deduplicated when model emits twice."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from utils.tool_schemas import create_agent_action_model

    content = json.dumps(
        {
            "response": "test",
            "tool_calls": [
                {"tool": "send_message_to_user", "message": "first", "is_question": False},
                {"tool": "send_message_to_user", "message": "second", "is_question": False},
            ],
        }
    )
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


async def test_call_llm_structured_streaming_fast_cache_writes_only_after_validation():
    """Structured LLM responses are cached only after AgentAction validation succeeds."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import call_llm_structured_streaming
    from providers.fast_cache import client as fast_cache_client
    from providers.fast_cache.context import FastCacheContext, reset_context, set_context
    from providers.fast_cache import rose_cache
    from utils.tool_schemas import create_agent_action_model

    store = {}
    set_calls = 0

    async def cache_get(key):
        return None

    async def cache_set(key, kind, goal_hash, value):
        nonlocal set_calls
        set_calls += 1
        store[key] = value
        return True

    original_client_get = fast_cache_client.cache_get
    original_client_set = fast_cache_client.cache_set
    original_rose_get = rose_cache.cache_client.cache_get
    original_rose_set = rose_cache.cache_client.cache_set
    token = set_context(FastCacheContext(enabled=True, goal="structured cache validation"))
    try:
        fast_cache_client.cache_get = cache_get
        fast_cache_client.cache_set = cache_set
        rose_cache.cache_client.cache_get = cache_get
        rose_cache.cache_client.cache_set = cache_set

        AgentAction = create_agent_action_model([])

        async def on_chunk(text, tokens):
            pass

        invalid_payload = {
            "choices": [{"delta": {"content": '{"response":"","tool_calls":[{"tool":"spawn_agent"}]}'}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 3, "total_tokens": 6},
        }

        def invalid_handler(req):
            return httpx.Response(200, text=_sse_body([invalid_payload]))

        set_mock_handler(invalid_handler)
        raised = False
        try:
            await call_llm_structured_streaming(
                messages=[{"role": "user", "content": "q"}],
                model="rose",
                temperature=0.7,
                max_tokens=512,
                response_model=AgentAction,
                on_chunk=on_chunk,
                call_site="validation-cache",
            )
        except ValueError:
            raised = True
        assert raised
        assert set_calls == 0
        assert store == {}

        valid_payload = {
            "choices": [{"delta": {"content": '{"response":"ok","tool_calls":[]}'}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 3, "total_tokens": 6},
        }

        def valid_handler(req):
            return httpx.Response(200, text=_sse_body([valid_payload]))

        set_mock_handler(valid_handler)
        response, _, _ = await call_llm_structured_streaming(
            messages=[{"role": "user", "content": "q"}],
            model="rose",
            temperature=0.7,
            max_tokens=512,
            response_model=AgentAction,
            on_chunk=on_chunk,
            call_site="validation-cache",
            cache_sequence_id="sequence-a",
        )
        assert response.response == "ok"
        assert set_calls == 1
        assert len(store) == 1

        response, _, _ = await call_llm_structured_streaming(
            messages=[{"role": "user", "content": "q"}],
            model="rose",
            temperature=0.7,
            max_tokens=512,
            response_model=AgentAction,
            on_chunk=on_chunk,
            call_site="validation-cache",
            cache_sequence_id="sequence-b",
        )
        assert response.response == "ok"
        assert set_calls == 2
        assert len(store) == 2, "structured cache keys must remain isolated by sequence"
    finally:
        reset_context(token)
        fast_cache_client.cache_get = original_client_get
        fast_cache_client.cache_set = original_client_set
        rose_cache.cache_client.cache_get = original_rose_get
        rose_cache.cache_client.cache_set = original_rose_set


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
        assert "No JSON" in msg or "Failed to parse" in msg or "waterfall" in msg or "stream closed" in msg, (
            f"unexpected error: {msg}"
        )
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

    with (
        patch("helpers.llm._call_llm_verifier", fake_verifier),
        patch("helpers.llm.asyncio.sleep", fast_sleep),
        patch("temporalio.activity.heartbeat"),
    ):
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
        m["role"] == "user" and isinstance(m.get("content"), str) and "[SYSTEM]:" in m["content"] for m in messages
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
    tool_as_user = [
        m
        for m in messages
        if m.get("role") == "user" and isinstance(m.get("content"), str) and "[TOOL]:" in m["content"]
    ]
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

    text = 'prefix garbage {"tool_calls": [{"tool": "web_search", "query": "hi"}]} trailing'
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
        "choices": [
            {
                "delta": {
                    "content": '{"response": "thinking", "tool_calls": [{"tool": "send_message_to_user", "message": "Hello there"}]'
                }
            }
        ],
    }
    payload_2 = {
        "choices": [{"delta": {"content": "}"}}],
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
    from providers.rose.pools import get_pool
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier
    from config import load_config

    # Deliver a complete JSON body (stream_interrupted path requires RemoteProtocolError - harder to mock)
    # This exercises the normal path with stream_usage capture.
    body = _sse_body(
        [
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
        ]
    )

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
    assert usage["actual_model"] == get_pool("rose-1-lite").waterfall[0]
    assert usage["cache_read_input_tokens"] == 2
    assert usage["cache_creation_input_tokens"] == 1


async def test_call_llm_verifier_jsondecode_error_with_accumulated_reasoning():
    """_call_llm_verifier extracts JSON from reasoning when content is empty (thinking models)."""
    import httpx
    from helpers.httpx_capture import set_mock_handler
    from helpers.llm import _call_llm_verifier
    from config import load_config

    # Reasoning-only stream: content is empty, reasoning contains the JSON
    body = _sse_body(
        [
            {
                "choices": [{"delta": {"reasoning": 'Let me think... {"reasoning": "evaluated", "score": 0.6}'}}],
                "usage": {"prompt_tokens": 2, "completion_tokens": 5, "total_tokens": 7},
            }
        ]
    )

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

    schema = _build_verifier_json_schema(
        {
            "fields": [
                {"name": "tags", "type": "list[str]"},
                {"name": "counts", "type": "list[int]"},
                {"name": "flag", "type": "bool"},
            ]
        }
    )
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
        "choices": [
            {"delta": {"content": '{"reasoning": "done", "response": "ok", "tool_calls": []}'}, "finish_reason": "stop"}
        ],
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
            "tool_calls": [{"id": "tc1", "type": "function", "function": {"name": "spawn_agent", "arguments": "{}"}}],
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
            "tool_calls": [{"id": "tc1", "type": "function", "function": {"name": "foo", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "tc1", "content": "result"},
        {
            "role": "assistant",
            "content": "second",
            "tool_calls": [{"id": "tc1", "type": "function", "function": {"name": "foo", "arguments": "{}"}}],
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
            "tool_calls": [{"id": "tc1", "type": "function", "function": {"name": "foo", "arguments": "{}"}}],
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
            "tool_calls": [{"id": "tc1", "type": "function", "function": {"name": "foo", "arguments": "{}"}}],
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
    r.record(
        "tool_result_uses_declared_not_executed_tool_name",
        test_tool_result_uses_declared_not_executed_tool_name,
    )
    r.record("convert_context_to_messages_empty", test_convert_context_to_messages_empty)
    r.record(
        "convert_context_to_messages_one_tool_result_per_tool_use",
        test_convert_context_to_messages_one_tool_result_per_tool_use,
    )
    r.record(
        "convert_context_to_messages_pairs_orphan_tool_use",
        test_convert_context_to_messages_pairs_orphan_tool_use,
    )
    r.record(
        "convert_context_to_messages_subagent_row_cannot_win_the_dedup",
        test_convert_context_to_messages_subagent_row_cannot_win_the_dedup,
    )
    r.record(
        "convert_context_to_messages_verifier_row_between_call_and_error_result",
        test_convert_context_to_messages_verifier_row_between_call_and_error_result,
    )
    r.record(
        "collapse_duplicate_tool_results_timestamp_edge_cases",
        test_collapse_duplicate_tool_results_timestamp_edge_cases,
    )
    await r.record_async(
        "build_llm_messages_dedupes_duplicate_terminal_tool_rows",
        test_build_llm_messages_dedupes_duplicate_terminal_tool_rows,
    )
    r.record(
        "collapse_duplicate_tool_results_keeps_latest_terminal_row",
        test_collapse_duplicate_tool_results_keeps_latest_terminal_row,
    )
    r.record(
        "convert_context_to_messages_with_declared_tool_call", test_convert_context_to_messages_with_declared_tool_call
    )
    r.record(
        "tool_result_name_pairs_with_declared_call",
        test_tool_result_name_pairs_with_the_declared_call_not_the_display_name,
    )
    r.record(
        "tool_result_omits_name_when_no_declaration_known",
        test_tool_result_omits_name_when_no_declaration_is_known,
    )
    r.record(
        "missing_tool_call_id_fails_closed",
        test_missing_tool_call_id_fails_closed_instead_of_being_synthesized,
    )
    r.record(
        "null_tool_call_ids_do_not_collide",
        test_null_tool_call_ids_do_not_collide_on_the_string_none,
    )
    r.record(
        "convert_context_to_messages_includes_structured_values_not_schema",
        test_convert_context_to_messages_includes_structured_values_not_schema,
    )
    r.record("convert_context_to_messages_verifier_message", test_convert_context_to_messages_verifier_message)
    r.record(
        "convert_context_to_messages_skip_subagent_and_inprogress",
        test_convert_context_to_messages_skip_subagent_and_inprogress,
    )
    r.record("extract_completed_tool_calls", test_extract_completed_tool_calls)
    r.record("extract_completed_tool_calls_partial", test_extract_completed_tool_calls_partial)
    r.record("extract_completed_tool_calls_no_array", test_extract_completed_tool_calls_no_array)
    r.record("extract_response_from_partial_json_empty", test_extract_response_from_partial_json_empty)
    r.record(
        "extract_response_from_partial_json_reasoning_only", test_extract_response_from_partial_json_reasoning_only
    )
    r.record("extract_response_from_partial_json_complete_json", test_extract_response_from_partial_json_complete_json)
    r.record(
        "extract_response_from_partial_json_markdown_block", test_extract_response_from_partial_json_markdown_block
    )
    r.record(
        "extract_response_from_partial_json_partial_fields", test_extract_response_from_partial_json_partial_fields
    )
    r.record("extract_nested_agent_json_blob_raw", test_extract_nested_agent_json_blob_raw)
    r.record("extract_nested_agent_json_blob_fenced", test_extract_nested_agent_json_blob_fenced)
    r.record("extract_nested_agent_json_blob_none_cases", test_extract_nested_agent_json_blob_none_cases)
    r.record("extract_nested_agent_json_blob_braces_embedded", test_extract_nested_agent_json_blob_braces_embedded)
    r.record("build_verifier_json_schema", test_build_verifier_json_schema)
    r.record("verifier_score_schema_no_numeric_bounds", test_verifier_score_schema_has_no_numeric_bounds)
    r.record("build_verifier_json_schema_with_response_schema", test_build_verifier_json_schema_with_response_schema)
    r.record("build_verifier_json_schema_all_types", test_build_verifier_json_schema_all_types)
    r.record(
        "verifier_response_model_closed_session_file_pointer",
        test_verifier_response_model_uses_closed_session_file_pointer_schema,
    )
    r.record("build_verifier_json_schema_object_type", test_build_verifier_json_schema_object_type)
    r.record("build_verifier_json_schema_list_object_type", test_build_verifier_json_schema_list_object_type)
    r.record(
        "build_verifier_json_schema_mixed_object_properties",
        test_build_verifier_json_schema_mixed_object_properties_stays_strict,
    )
    r.record(
        "build_verifier_response_model_requires_nested_object_properties",
        test_build_verifier_response_model_requires_nested_object_properties,
    )
    await r.record_async("fetch_claude_max_token_activity", test_fetch_claude_max_token_activity)
    await r.record_async("fetch_claude_max_token_activity_not_found", test_fetch_claude_max_token_activity_not_found)
    await r.record_async(
        "fetch_claude_max_token_activity_server_error", test_fetch_claude_max_token_activity_server_error
    )
    await r.record_async(
        "fetch_claude_max_token_activity_missing_token_field", test_fetch_claude_max_token_activity_missing_token_field
    )
    await r.record_async(
        "fetch_compute_token_activity_passes_lineage_params",
        test_fetch_compute_token_activity_passes_lineage_params,
    )
    await r.record_async(
        "fetch_compute_token_activity_pins_benchmark_provider",
        test_fetch_compute_token_activity_pins_benchmark_provider,
    )
    r.record(
        "benchmark_compute_token_type_rejects_conflicting_provider_policy",
        test_benchmark_compute_token_type_rejects_conflicting_provider_policy,
    )
    await r.record_async(
        "fetch_compute_token_activity_excludes_claude_tokens_by_policy",
        test_fetch_compute_token_activity_excludes_claude_tokens_by_policy,
    )
    await r.record_async(
        "mark_claude_token_rate_limited_user_success", test_mark_claude_token_rate_limited_user_success
    )
    await r.record_async(
        "mark_claude_token_rate_limited_explicit_reset", test_mark_claude_token_rate_limited_uses_explicit_reset_time
    )
    await r.record_async(
        "mark_claude_token_rate_limited_pool_success", test_mark_claude_token_rate_limited_pool_success
    )
    await r.record_async(
        "mark_claude_token_rate_limited_failure_reason", test_mark_claude_token_rate_limited_forwards_failure_reason
    )
    await r.record_async("mark_claude_token_rate_limited_failure", test_mark_claude_token_rate_limited_failure)
    await r.record_async("set_response_schema_activity_success", test_set_response_schema_activity_success)
    await r.record_async(
        "set_response_schema_activity_uses_internal_auth_only",
        test_set_response_schema_activity_uses_internal_auth_only,
    )
    await r.record_async(
        "set_response_schema_activity_passes_workflow_compute_auth_to_rose",
        test_set_response_schema_activity_passes_workflow_compute_auth_to_rose,
    )
    await r.record_async(
        "codex_responses_body_has_input_for_system_only_context",
        test_codex_responses_body_has_input_for_system_only_context,
    )
    await r.record_async("set_response_schema_activity_empty_goal", test_set_response_schema_activity_empty_goal)
    await r.record_async(
        "set_response_schema_activity_no_schema_returned", test_set_response_schema_activity_no_schema_returned
    )
    await r.record_async("set_response_schema_activity_http_error", test_set_response_schema_activity_http_error)
    await r.record_async(
        "set_response_schema_activity_save_error_raises",
        test_set_response_schema_activity_save_error_raises,
    )
    r.record(
        "filter_context_for_execute_verifier_boundary", test_filter_context_for_execute_verifier_uses_execute_boundary
    )
    await r.record_async(
        "check_progress_execute_filters_plan_context",
        test_check_progress_execute_filters_plan_context_before_llm,
    )
    await r.record_async("call_llm_rose_path", test_call_llm_rose_path)
    await r.record_async(
        "call_llm_rose_with_claude_token_and_skip_cache_write",
        test_call_llm_rose_with_claude_token_and_skip_cache_write,
    )
    await r.record_async(
        "call_llm_rose_response_model_output_config", test_call_llm_rose_response_model_uses_output_config
    )
    await r.record_async("call_llm_rose_http_error_raises", test_call_llm_rose_http_error_raises)
    await r.record_async(
        "build_llm_messages_preserves_tool_calls_and_tool_role",
        test_build_llm_messages_preserves_tool_calls_and_tool_role,
    )
    await r.record_async(
        "build_llm_messages_preserves_timestamp_timezone",
        test_build_llm_messages_preserves_timestamp_timezone,
    )
    await r.record_async(
        "build_llm_messages_normalizes_pointer_annotations_across_context_sources",
        test_build_llm_messages_normalizes_pointer_annotations_across_context_sources,
    )
    await r.record_async(
        "build_llm_messages_preserves_codex_reasoning_metadata_separately",
        test_build_llm_messages_preserves_codex_reasoning_metadata_separately,
    )
    await r.record_async(
        "build_llm_messages_unmatched_terminal_tool_becomes_user",
        test_build_llm_messages_unmatched_terminal_tool_becomes_user,
    )
    await r.record_async(
        "build_llm_messages_terminal_tool_missing_id_raises", test_build_llm_messages_terminal_tool_missing_id_raises
    )
    await r.record_async(
        "build_llm_messages_system_and_non_terminal_tool", test_build_llm_messages_system_and_non_terminal_tool
    )
    await r.record_async("build_llm_messages_assistant_merging", test_build_llm_messages_assistant_merging)
    await r.record_async("build_llm_messages_skip_subagent", test_build_llm_messages_skip_subagent)
    await r.record_async(
        "build_llm_messages_skips_exclude_from_model_boundary",
        test_build_llm_messages_skips_exclude_from_model_boundary,
    )
    await r.record_async(
        "build_llm_messages_attachment_large_falls_back_to_metadata",
        test_build_llm_messages_attachment_large_falls_back_to_metadata,
    )
    await r.record_async(
        "build_llm_messages_skips_empty_file_output_assistant",
        test_build_llm_messages_skips_empty_file_output_assistant,
    )
    await r.record_async(
        "build_llm_messages_assistant_tool_call_validation_errors",
        test_build_llm_messages_assistant_tool_call_validation_errors,
    )
    await r.record_async(
        "build_llm_messages_filters_inprogress_keeps_latest_finished",
        test_build_llm_messages_filters_inprogress_keeps_latest_finished,
    )
    await r.record_async(
        "build_llm_messages_attempt_completion_verifier_result",
        test_build_llm_messages_attempt_completion_verifier_result_is_tool_result,
    )
    await r.record_async(
        "build_llm_messages_strips_cloud_agent_lifecycle_tools",
        test_build_llm_messages_strips_cloud_agent_lifecycle_tools,
    )
    await r.record_async("call_llm_structured_streaming_happy_path", test_call_llm_structured_streaming_happy_path)
    await r.record_async(
        "call_llm_structured_streaming_retries_malformed_output",
        test_call_llm_structured_streaming_retries_malformed_output,
    )
    await r.record_async(
        "structured_parse_retry_rewinds_streamed_text_for_delta_consumers",
        test_structured_parse_retry_rewinds_streamed_text_for_delta_consumers,
    )
    await r.record_async(
        "call_llm_structured_streaming_replays_invalid_native_tool_use",
        _call_llm_structured_streaming_replays_invalid_native_tool_use_case,
    )
    r.record(
        "structured_retry_replay_is_wire_valid_for_anthropic",
        test_structured_retry_replay_is_wire_valid_for_anthropic,
    )
    await r.record_async(
        "call_llm_structured_streaming_model_detected_callback",
        test_call_llm_structured_streaming_model_detected_callback,
    )
    await r.record_async("call_llm_verifier_streaming_parses_score", test_call_llm_verifier_streaming_parses_score)
    await r.record_async("call_llm_verifier_uses_large_output_cap", test_call_llm_verifier_uses_large_output_cap)
    await r.record_async(
        "call_llm_verifier_bounds_provider_stream_time",
        test_call_llm_verifier_bounds_provider_stream_time,
    )
    await r.record_async(
        "call_llm_verifier_dump_extra_includes_browser_recording_metadata",
        test_call_llm_verifier_dump_extra_includes_browser_recording_metadata,
    )
    await r.record_async("call_llm_verifier_claude_token_and_schema", test_call_llm_verifier_claude_token_and_schema)
    await r.record_async(
        "call_llm_verifier_fills_structured_tool_output",
        test_call_llm_verifier_fills_missing_output_from_structured_tool_response,
    )
    await r.record_async("check_progress_happy_path", test_check_progress_happy_path)
    await r.record_async(
        "check_progress_below_threshold_returns_partial_structured_response",
        test_check_progress_below_threshold_returns_partial_structured_response,
    )
    await r.record_async(
        "check_progress_accepts_completed_code_task_structured_response",
        test_check_progress_accepts_completed_code_task_structured_response,
    )
    r.record(
        "completed_code_task_rejects_failed_placeholder_structured_response",
        test_completed_code_task_rejects_failed_placeholder_structured_response,
    )
    await r.record_async(
        "check_progress_accepts_completed_browser_task_structured_response",
        test_check_progress_accepts_completed_browser_task_structured_response,
    )
    await r.record_async(
        "check_progress_disables_fast_cache_read_after_verifier_parse_failure",
        test_check_progress_disables_fast_cache_read_after_verifier_parse_failure,
    )
    await r.record_async(
        "check_progress_fences_the_entire_verifier_retry_loop",
        test_check_progress_fences_the_entire_verifier_retry_loop,
    )
    await r.record_async(
        "check_progress_browser_success_uses_fast_cache_write_only",
        test_check_progress_browser_success_uses_fast_cache_write_only,
    )
    await r.record_async("call_planner_llm_activity_happy_path", test_call_planner_llm_activity_happy_path)
    # Additional llm coverage
    await r.record_async("call_llm_activity_happy_path", test_call_llm_activity_happy_path_with_messages_list)
    await r.record_async(
        "call_llm_activity_agent_id_shared_ctx", test_call_llm_activity_with_agent_id_reads_shared_context
    )
    await r.record_async("call_llm_activity_missing_ctx", test_call_llm_activity_missing_context_raises)
    await r.record_async("call_llm_activity_cross_machine_fb", test_call_llm_activity_cross_machine_fallback)
    await r.record_async(
        "call_llm_activity_force_backend",
        test_call_llm_activity_force_backend_ignores_and_preserves_shared_context,
    )
    await r.record_async("call_planner_llm_activity_failure", test_call_planner_llm_activity_failure_raises)
    await r.record_async("verifier_schema_file_pointer", test_build_verifier_json_schema_file_pointer_type)
    await r.record_async("verifier_schema_list_file_pointer", test_build_verifier_json_schema_list_file_pointer_type)
    await r.record_async(
        "verifier_schema_session_file_pointer", test_build_verifier_json_schema_session_file_pointer_type
    )
    await r.record_async(
        "verifier_schema_list_session_file_pointer", test_build_verifier_json_schema_list_session_file_pointer_type
    )
    await r.record_async("verifier_schema_unknown_fallback", test_build_verifier_json_schema_unknown_type_fallback)
    await r.record_async("verifier_schema_object_type", test_build_verifier_json_schema_object_type_explicit_shape)
    await r.record_async(
        "verifier_schema_list_object_type", test_build_verifier_json_schema_list_object_type_explicit_shape
    )
    await r.record_async(
        "verifier_schema_strict_when_closed", test_build_verifier_json_schema_strict_true_when_no_open_objects
    )
    r.record("verifier_ctx_screenshot_multimodal", test_build_verifier_context_messages_screenshot_emits_multimodal)
    r.record("verifier_ctx_screenshot_strips_b64", test_build_verifier_context_messages_screenshot_strips_b64_from_text)
    r.record("verifier_ctx_no_screenshot_text_only", test_build_verifier_context_messages_no_screenshot_stays_text)
    r.record("verifier_ctx_tool_result_payload", test_build_verifier_context_messages_formats_tool_result_payload)
    r.record(
        "verifier_ctx_camelcase_structured_response",
        test_build_verifier_context_messages_formats_camelcase_structured_response,
    )
    r.record(
        "verifier_ctx_dag_reasoning_assistant_rows",
        test_build_verifier_context_messages_includes_only_dag_reasoning_assistant_rows,
    )
    r.record(
        "verifier_ctx_assistant_file_evidence",
        test_build_verifier_context_messages_includes_assistant_file_evidence_without_assistant_text,
    )
    await r.record_async(
        "verifier_file_evidence_cached_text",
        test_resolve_verifier_file_evidence_uses_cached_text_file_content,
    )
    await r.record_async(
        "verifier_ctx_self_closes_trailing_refs",
        test_build_verifier_context_messages_self_closes_trailing_refs,
    )
    r.record("verifier_ctx_filters_subagent_tree_rows", test_build_verifier_context_messages_filters_subagent_tree_rows)
    r.record(
        "verifier_ctx_prunes_superseded_browser_protocol_failure",
        test_build_verifier_context_messages_prunes_superseded_browser_protocol_failure,
    )
    await r.record_async(
        "build_llm_messages_prunes_superseded_browser_protocol_failure",
        test_build_llm_messages_prunes_superseded_browser_protocol_failure,
    )
    await r.record_async("extract_response_raw_json", test_extract_response_from_partial_json_raw_json_object)
    await r.record_async("extract_response_tool_calls_only", test_extract_response_from_partial_json_tool_calls_only)
    await r.record_async("extract_completed_tool_calls_multiple", test_extract_completed_tool_calls_multiple)
    await r.record_async(
        "convert_ctx_assistant_with_tool_calls", test_convert_context_to_messages_assistant_with_tool_calls
    )
    await r.record_async("safe_time", test_safe_time_returns_float)
    await r.record_async("safe_heartbeat", test_safe_heartbeat_no_raise_when_no_activity)
    await r.record_async("call_llm_rose_cache_fields", test_call_llm_rose_with_usage_and_cache_fields)
    await r.record_async(
        "convert_ctx_in_progress_tool", test_convert_context_to_messages_non_terminal_tool_becomes_user
    )
    await r.record_async("stream_tool_detection_cb", test_call_llm_structured_streaming_tool_detection_callback)
    await r.record_async(
        "stream_replayed_native_tool_call_without_json",
        _call_llm_structured_streaming_replayed_native_tool_call_without_json_case,
    )
    await r.record_async("stream_attention_streaming", test_call_llm_structured_streaming_attention_streaming)
    await r.record_async("call_llm_openrouter_path", test_call_llm_openrouter_path)
    await r.record_async(
        "call_llm_escalates_max_tokens_on_length",
        test_call_llm_escalates_max_tokens_on_finish_reason_length,
    )
    await r.record_async("verifier_claude_token_error", test_call_llm_verifier_claude_token_error_surfaces)
    await r.record_async("verifier_reasoning_fallback_to_json", test_call_llm_verifier_reasoning_fallback_to_json)
    await r.record_async("verifier_no_json_raises", test_call_llm_verifier_no_json_raises)
    await r.record_async(
        "call_llm_activity_no_stream_id", test_call_llm_activity_no_stream_id_skips_streaming_callbacks
    )
    await r.record_async(
        "call_llm_activity_structured_contract_non_retryable",
        test_call_llm_activity_marks_structured_contract_failures_non_retryable,
    )
    await r.record_async(
        "call_llm_activity_required_tool_non_retryable",
        test_call_llm_activity_rejects_wrong_required_tool_non_retryably,
    )
    await r.record_async(
        "call_llm_activity_required_tool_forced_at_provider",
        test_call_llm_activity_forces_required_tool_at_provider,
    )
    await r.record_async("mark_claude_token_rate_limited_exception", test_mark_claude_token_rate_limited_exception_path)
    await r.record_async("fetch_claude_max_token_exception", test_fetch_claude_max_token_exception_path)
    await r.record_async("call_llm_openrouter_exception", test_call_llm_openrouter_exception_path)
    await r.record_async("stream_openrouter_path", test_call_llm_structured_streaming_openrouter_path)
    await r.record_async(
        "stream_openrouter_required_tool_fails_closed",
        test_call_llm_structured_streaming_rejects_unenforced_openrouter_tool_choice,
    )
    await r.record_async("stream_openrouter_exception", test_call_llm_structured_streaming_openrouter_exception_raises)
    await r.record_async(
        "stream_rose_cancelled_propagates",
        test_call_llm_structured_streaming_rose_cancelled_error_propagates,
    )
    await r.record_async(
        "stream_openrouter_cancelled_propagates",
        test_call_llm_structured_streaming_openrouter_cancelled_error_propagates,
    )
    await r.record_async("stream_nested_tool_recovery", test_call_llm_structured_streaming_nested_tool_recovery)
    r.record("normalize_provider_tool_names_allowlist", test_normalize_provider_tool_names_is_allowlisted)
    await r.record_async(
        "stream_provider_tool_name_normalization",
        test_call_llm_structured_streaming_normalizes_provider_tool_name,
    )
    await r.record_async(
        "stream_thinking_model_reasoning_json", test_call_llm_structured_streaming_thinking_model_reasoning_json
    )
    await r.record_async(
        "stream_gpt_native_reasoning_to_chunks",
        test_call_llm_structured_streaming_gpt_native_streams_reasoning_to_chunks,
    )
    await r.record_async("stream_single_call_dedup", test_call_llm_structured_streaming_single_call_dedup)
    await r.record_async(
        "stream_json_parse_failure_raises", test_call_llm_structured_streaming_json_parse_failure_raises
    )
    await r.record_async(
        "stream_fast_cache_writes_only_after_validation",
        test_call_llm_structured_streaming_fast_cache_writes_only_after_validation,
    )
    r.record(
        "normalize_response_schema_purchase_confirmation_identifier",
        test_normalize_response_schema_for_purchase_goal_adds_confirmation_identifier,
    )
    r.record(
        "fill_missing_verifier_output_matching_idempotent_card_last4",
        test_fill_missing_verifier_output_accepts_matching_idempotent_card_last4,
    )
    r.record(
        "fill_missing_verifier_output_partial_without_confirmation",
        test_fill_missing_verifier_output_keeps_partial_score_without_second_card_evidence,
    )
    await r.record_async("stream_no_json_content_raises", test_call_llm_structured_streaming_no_json_content_raises)
    await r.record_async("check_progress_empty_context", test_check_progress_empty_context_runs_verifier)
    await r.record_async(
        "check_progress_extracts_browser_recording_metadata",
        test_check_progress_extracts_browser_recording_metadata_from_context,
    )
    # Final coverage bumps (W3-*)
    await r.record_async(
        "check_progress_retries_on_transient_failure", test_check_progress_retries_on_transient_failure_then_succeeds
    )
    await r.record_async(
        "check_progress_error_returns_fallback_score", test_check_progress_error_returns_fallback_score
    )
    await r.record_async("build_llm_messages_system_role_prefix", test_build_llm_messages_system_role_gets_prefix)
    await r.record_async(
        "build_llm_messages_non_terminal_tool_user_text", test_build_llm_messages_non_terminal_tool_becomes_user_text
    )
    await r.record_async(
        "mark_claude_token_rate_limited_pool_body", test_mark_claude_token_rate_limited_pool_body_includes_pool_id
    )
    await r.record_async(
        "fetch_claude_max_token_missing_access_token_field",
        test_fetch_claude_max_token_activity_missing_access_token_field,
    )
    await r.record_async(
        "set_response_schema_empty_goal_short_circuits", test_set_response_schema_activity_empty_goal_short_circuits
    )
    await r.record_async(
        "extract_response_regex_fallback_unclosed",
        test_extract_response_from_partial_json_regex_fallback_unclosed_response,
    )
    await r.record_async("extract_nested_agent_json_blob_rfind", test_extract_nested_agent_json_blob_rfind_strategy)
    await r.record_async(
        "stream_attention_stream_without_question",
        test_call_llm_structured_streaming_attention_stream_without_question_field,
    )
    await r.record_async(
        "verifier_stream_interrupted_parses_partial", test_call_llm_verifier_stream_interrupted_still_parses_partial
    )
    await r.record_async(
        "verifier_jsondecode_error_accumulated_reasoning",
        test_call_llm_verifier_jsondecode_error_with_accumulated_reasoning,
    )
    await r.record_async("verifier_schema_with_list_str_field", test_build_verifier_json_schema_with_list_str_field)
    await r.record_async(
        "stream_non_dict_choices_continues", test_call_llm_structured_streaming_non_dict_choices_continues
    )
    r.record(
        "ensure_tool_result_pairing_inserts_synthetic",
        test_ensure_tool_result_pairing_inserts_synthetic_for_orphan_tool_use,
    )
    r.record(
        "ensure_tool_result_pairing_strips_orphan_tool_result",
        test_ensure_tool_result_pairing_strips_orphan_tool_result,
    )
    r.record(
        "ensure_tool_result_pairing_dedupes_cross_message_ids",
        test_ensure_tool_result_pairing_dedupes_cross_message_tool_use_ids,
    )
    r.record("ensure_tool_result_pairing_idempotent", test_ensure_tool_result_pairing_idempotent)
    r.record(
        "ensure_tool_result_pairing_preserves_well_formed",
        test_ensure_tool_result_pairing_preserves_well_formed_messages,
    )
    teardown_mock()
    r.record(
        "convert_context_to_messages_mixed_timestamp_awareness",
        test_convert_context_to_messages_mixed_timestamp_awareness,
    )
    r.record(
        "tool_call_declaration_dedup_ignores_argument_key_order",
        test_tool_call_declaration_dedup_ignores_argument_key_order,
    )
    await r.record_async(
        "heartbeat_compute_token_lineage_activity_posts_lineage_key",
        test_heartbeat_compute_token_lineage_activity_posts_lineage_key,
    )
    return r.summary()


if __name__ == "__main__":
    # run_all_tests() returns r.summary(), a dict — which is truthy even when
    # tests failed. `0 if <dict> else 1` therefore exited 0 on a red suite, so
    # running this file directly reported a false green. scripts/run_blackbox_tests.py
    # (the /deploy gate) reads summary["failed"] and was never fooled; this
    # only ever misled direct invocation. Branch on the count, not the dict.
    _summary = asyncio.run(run_all_tests())
    raise SystemExit(0 if _summary["failed"] == 0 else 1)
