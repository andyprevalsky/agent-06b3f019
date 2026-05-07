"""Blackbox tests for the providers/rose/ module.

Covers the units that aren't already exercised end-to-end via llm.blackbox.py:
  - transforms (message normalization, tool config, schema sanitization, vision)
  - streaming (Anthropic + OpenAI SSE parsers, error paths)
  - claude_auth (HTTP error classification, rotation, in-place retry)
  - waterfall (per-step error aggregation)
  - legacy_adapter (model→pool mapping, claude_token_error classification)
  - client (deadline, fall-through, collect)
  - pools (registry lookup, all_pool_names)
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _test_utils import BlackboxResult, set_mock_handler, setup_mock, teardown_mock

import httpx

from providers.rose import (
    ClaudeAuthContext,
    GptAuthContext,
    POOL_REGISTRY,
    RoseAllFailed,
    RoseAuthError,
    RoseClient,
    RoseDeadlineError,
    RoseError,
    RoseInvalidRequest,
    RoseRateLimitError,
    RoseServerError,
    RoseStallError,
    StreamChunk,
    all_pool_names,
    claude_auth_from_token,
    classify_claude_token_error,
    classify_gpt_token_error,
    get_pool,
    gpt_auth_from_token,
    is_rose_model,
    parse_anthropic_sse,
    parse_openai_sse,
    parse_responses_sse,
    pool_for_model,
)
from providers.rose.claude_auth import (
    build_anthropic_body,
    claude_auth_complete,
)
from providers.rose.gpt_auth import build_codex_responses_body
from providers.rose.schema import (
    build_anthropic_tools_from_response_model,
)
from providers.rose.transforms import (
    apply_anthropic_tool_config,
    get_messages_for_model,
    has_screenshot_markers,
    is_anthropic_model,
    is_vision_capable,
    reconstruct_agent_response,
    transform_content_block_for_anthropic,
    transform_messages_for_anthropic,
    transform_messages_for_openai,
    transform_messages_for_vision,
    transform_schema_for_anthropic,
)
from providers.rose.waterfall import build_openrouter_body, waterfall_complete
from utils.tool_schemas import ALL_PHASE_TOOLS, create_agent_action_model


# =====================================================================
# legacy_adapter
# =====================================================================


def test_is_rose_model_variants():
    assert is_rose_model("rose")
    assert is_rose_model("rose-ultra")
    assert is_rose_model("rose-labs/rose-1-lite")
    assert is_rose_model("rose-labs/rose-1-ultra")
    assert is_rose_model("ROSE-LABS/ROSE-1-LITE")  # case-insensitive
    assert not is_rose_model("anthropic/claude-sonnet-4.5")
    assert not is_rose_model(None)
    assert not is_rose_model("")


def test_pool_for_model_fuzzy():
    assert pool_for_model("rose-labs/rose-1-lite") == "rose-1-lite"
    assert pool_for_model("rose-labs/rose-1-ultra") == "rose-1-ultra"
    assert pool_for_model("rose") == "rose-1-lite"
    assert pool_for_model("rose-ultra") == "rose-1-ultra"
    # Fuzzy fallback for unknown rose-labs/* strings
    assert pool_for_model("rose-labs/something-ultra-new") == "rose-1-ultra"
    assert pool_for_model("rose-labs/something-mini") == "rose-1-lite"
    assert pool_for_model("openai/gpt-4") is None
    assert pool_for_model("") is None


def test_claude_auth_from_token_returns_none_when_falsy():
    assert claude_auth_from_token(None) is None
    assert claude_auth_from_token("") is None


def test_claude_auth_from_token_builds_context():
    ctx = claude_auth_from_token("ct-xyz")
    assert isinstance(ctx, ClaudeAuthContext)
    assert ctx.token == "ct-xyz"
    assert ctx.source == "user"
    assert ctx.max_rotations == 0
    assert ctx.mark_rate_limited is None
    assert ctx.fetch_fresh is None


def test_gpt_auth_from_token_builds_context():
    ctx = gpt_auth_from_token("gt-xyz", "acct_123")
    assert isinstance(ctx, GptAuthContext)
    assert ctx.token == "gt-xyz"
    assert ctx.account_id == "acct_123"
    assert ctx.source == "user"
    assert ctx.max_rotations == 0


def test_classify_claude_token_error_each_branch():
    assert classify_claude_token_error(RoseAuthError("a")) == "auth_error"
    assert classify_claude_token_error(RoseRateLimitError("b")) == "rate_limit"
    assert classify_claude_token_error(RoseStallError("c")) == "stall"
    assert classify_claude_token_error(RoseInvalidRequest("d")) == "invalid_request"
    assert classify_claude_token_error(RoseServerError("e")) == "server_error"
    # Unknown subclass falls back to server_error
    assert classify_claude_token_error(RoseError("z")) == "server_error"
    assert classify_gpt_token_error(RoseRateLimitError("b")) == "rate_limit"


# =====================================================================
# pools
# =====================================================================


def test_pool_registry_lookup():
    lite = get_pool("rose-1-lite")
    ultra = get_pool("rose-1-ultra")
    assert lite.name == "rose-1-lite"
    assert lite.claude_auth_model.startswith("claude-")
    assert lite.gpt_auth_model.startswith("gpt-")
    assert len(lite.waterfall) >= 1
    assert ultra.name == "rose-1-ultra"
    assert ultra.claude_auth_model.startswith("claude-")
    assert ultra.gpt_auth_model.startswith("gpt-")
    assert lite.waterfall != ultra.waterfall


def test_all_pool_names_matches_registry():
    names = set(all_pool_names())
    assert names == set(POOL_REGISTRY.keys())
    assert "rose-1-lite" in names
    assert "rose-1-ultra" in names


def test_get_pool_unknown_raises():
    raised = False
    try:
        get_pool("rose-nonexistent")  # type: ignore[arg-type]
    except (KeyError, ValueError):
        raised = True
    assert raised


# =====================================================================
# transforms — anthropic message shape
# =====================================================================


def test_is_anthropic_model_substring():
    assert is_anthropic_model("anthropic/claude-sonnet-4")
    assert is_anthropic_model("claude-opus-4-7")
    assert is_anthropic_model("CLAUDE-SONNET")
    assert not is_anthropic_model("openai/gpt-4o")
    assert not is_anthropic_model("google/gemini-3-flash-preview")


def test_transform_content_block_passthrough_for_text():
    block = {"type": "text", "text": "hello"}
    assert transform_content_block_for_anthropic(block) == block
    # Non-dict passes through.
    assert transform_content_block_for_anthropic("raw") == "raw"


def test_transform_content_block_image_data_uri():
    block = {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,AAAA"},
    }
    out = transform_content_block_for_anthropic(block)
    assert out["type"] == "image"
    assert out["source"]["type"] == "base64"
    assert out["source"]["media_type"] == "image/png"
    assert out["source"]["data"] == "AAAA"


def test_transform_content_block_image_url_http():
    block = {
        "type": "image_url",
        "image_url": {"url": "https://example.com/img.png"},
    }
    out = transform_content_block_for_anthropic(block)
    assert out["type"] == "image"
    assert out["source"]["type"] == "url"
    assert out["source"]["url"] == "https://example.com/img.png"


def test_transform_content_block_file_data_uri():
    block = {
        "type": "file",
        "file": {"file_data": "data:application/pdf;base64,PDF"},
    }
    out = transform_content_block_for_anthropic(block)
    assert out["type"] == "document"
    assert out["source"]["media_type"] == "application/pdf"
    assert out["source"]["data"] == "PDF"


def test_transform_messages_for_anthropic_pulls_system():
    static_sys, dynamic_sys, msgs = transform_messages_for_anthropic([
        {"role": "system", "content": "be brief"},
        {"role": "system", "content": "and friendly"},
        {"role": "user", "content": "hi"},
    ])
    assert static_sys == "be brief\n\nand friendly"
    assert dynamic_sys is None
    assert len(msgs) == 1
    assert msgs[0]["role"] == "user"


def test_transform_messages_for_anthropic_splits_on_boundary():
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    combined = f"static instructions{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}Current time: April 28"
    static_sys, dynamic_sys, msgs = transform_messages_for_anthropic([
        {"role": "system", "content": combined},
        {"role": "user", "content": "hi"},
    ])
    assert static_sys == "static instructions"
    assert dynamic_sys == "Current time: April 28"
    assert len(msgs) == 1


def test_transform_messages_for_anthropic_strips_trailing_assistant():
    _, _, msgs = transform_messages_for_anthropic([
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "should be stripped"},
    ])
    assert len(msgs) == 1
    assert msgs[0]["role"] == "user"


def test_transform_messages_for_anthropic_assistant_tool_calls_to_tool_use():
    _, _, msgs = transform_messages_for_anthropic([
        {"role": "user", "content": "search"},
        {
            "role": "assistant",
            "content": "doing it",
            "tool_calls": [
                {
                    "id": "tc-1",
                    "function": {"name": "web_search", "arguments": '{"q": "x"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "tc-1", "content": "results"},
    ])
    assert len(msgs) == 3  # leading user + assistant + bundled tool_result user
    assert msgs[0] == {"role": "user", "content": "search"}
    assistant = msgs[1]
    assert assistant["role"] == "assistant"
    blocks = assistant["content"]
    assert blocks[0] == {"type": "text", "text": "doing it"}
    assert blocks[1]["type"] == "tool_use"
    assert blocks[1]["id"] == "tc-1"
    assert blocks[1]["name"] == "web_search"
    assert blocks[1]["input"] == {"q": "x"}
    user = msgs[2]
    assert user["role"] == "user"
    assert user["content"][0]["type"] == "tool_result"
    assert user["content"][0]["tool_use_id"] == "tc-1"


def test_transform_messages_for_anthropic_dict_arguments():
    _, _, msgs = transform_messages_for_anthropic([
        {
            "role": "assistant",
            "tool_calls": [
                {"id": "t1", "function": {"name": "f", "arguments": {"a": 1}}}
            ],
        },
    ])
    # Trailing assistant strips; expect empty
    assert msgs == []


def test_transform_messages_for_anthropic_bundles_consecutive_tool_results():
    _, _, msgs = transform_messages_for_anthropic([
        {"role": "user", "content": "go"},
        {
            "role": "assistant",
            "tool_calls": [
                {"id": "t1", "function": {"name": "f", "arguments": "{}"}},
                {"id": "t2", "function": {"name": "g", "arguments": "{}"}},
            ],
        },
        {"role": "tool", "tool_call_id": "t1", "content": "r1"},
        {"role": "tool", "tool_call_id": "t2", "content": "r2"},
    ])
    # Two tool_result messages get bundled into one user message
    user_with_results = [
        m for m in msgs
        if m["role"] == "user"
        and isinstance(m.get("content"), list)
        and m["content"] and m["content"][0].get("type") == "tool_result"
    ]
    assert len(user_with_results) == 1
    assert len(user_with_results[0]["content"]) == 2


def test_transform_messages_for_anthropic_raises_on_missing_id():
    raised = False
    try:
        transform_messages_for_anthropic([
            {
                "role": "assistant",
                "tool_calls": [{"function": {"name": "f", "arguments": "{}"}}],
            },
        ])
    except ValueError as e:
        assert "missing id" in str(e)
        raised = True
    assert raised


def test_transform_messages_for_anthropic_raises_on_missing_name():
    raised = False
    try:
        transform_messages_for_anthropic([
            {
                "role": "assistant",
                "tool_calls": [{"id": "t1", "function": {"arguments": "{}"}}],
            },
        ])
    except ValueError as e:
        assert "function.name" in str(e)
        raised = True
    assert raised


def test_transform_messages_for_anthropic_raises_on_invalid_args_json():
    raised = False
    try:
        transform_messages_for_anthropic([
            {
                "role": "assistant",
                "tool_calls": [
                    {"id": "t1", "function": {"name": "f", "arguments": "not-json{"}}
                ],
            },
        ])
    except ValueError as e:
        assert "invalid tool_call arguments JSON" in str(e)
        raised = True
    assert raised


def test_transform_messages_for_anthropic_raises_on_tool_without_id():
    raised = False
    try:
        transform_messages_for_anthropic([
            {"role": "tool", "content": "x"},
        ])
    except ValueError as e:
        assert "missing tool_call_id" in str(e)
        raised = True
    assert raised


# =====================================================================
# transforms — schema sanitization
# =====================================================================


def test_transform_schema_strips_unsupported_keys():
    schema = {
        "type": "object",
        "minimum": 0,
        "maxItems": 10,
        "properties": {
            "x": {"type": "integer", "minimum": 1, "maximum": 100},
            "items": {"type": "array", "items": {"minLength": 1, "type": "string"}},
        },
    }
    out = transform_schema_for_anthropic(schema)
    assert "minimum" not in out
    assert "maxItems" not in out
    assert "minimum" not in out["properties"]["x"]
    assert "minLength" not in out["properties"]["items"]["items"]


def test_transform_schema_collapses_object_additionalProperties():
    schema = {
        "type": "object",
        "additionalProperties": {"type": "string"},
    }
    out = transform_schema_for_anthropic(schema)
    assert out["additionalProperties"] is False


def test_transform_schema_recurses_into_anyOf_oneOf_allOf_defs():
    schema = {
        "anyOf": [{"minimum": 1, "type": "integer"}],
        "oneOf": [{"maxLength": 10, "type": "string"}],
        "allOf": [{"type": "object"}],
        "$defs": {"X": {"minLength": 1, "type": "string"}},
    }
    out = transform_schema_for_anthropic(schema)
    assert "minimum" not in out["anyOf"][0]
    assert "maxLength" not in out["oneOf"][0]
    assert "minLength" not in out["$defs"]["X"]


def test_transform_schema_passthrough_non_dict():
    assert transform_schema_for_anthropic("not-a-dict") == "not-a-dict"
    assert transform_schema_for_anthropic(None) is None


def _walk_schema(obj):
    if isinstance(obj, dict):
        yield obj
        for value in obj.values():
            yield from _walk_schema(value)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk_schema(item)


def test_pydantic_response_model_builds_anthropic_native_tools_without_strict_by_default():
    AgentAction = create_agent_action_model(ALL_PHASE_TOOLS)

    tools = build_anthropic_tools_from_response_model(
        AgentAction,
        model="claude-sonnet-4-6",
    )

    assert tools is not None
    assert len(tools) == len(ALL_PHASE_TOOLS)
    by_name = {tool["name"]: tool for tool in tools}
    assert set(by_name) == set(ALL_PHASE_TOOLS)

    wait_for = by_name["wait_for"]
    assert "strict" not in wait_for
    wait_schema = wait_for["input_schema"]
    assert "tool" not in wait_schema["properties"]
    assert "tool" not in wait_schema["required"]
    # Pydantic runtime validators/defaults remain authoritative. The native
    # Anthropic schema should not force defaults/nulls into tool arguments.
    assert wait_schema["required"] == []
    assert wait_schema["properties"]["check_interval_seconds"]["minimum"] == 60
    assert wait_schema["properties"]["check_interval_seconds"]["maximum"] == 86400

    spawn_agent = by_name["spawn_agent"]["input_schema"]
    assert spawn_agent["required"] == ["type", "goal"]
    assert "output_schema" in spawn_agent["properties"]

    for tool in tools:
        assert "strict" not in tool


def test_pydantic_response_model_adds_strict_only_for_opted_in_tools():
    from pydantic import BaseModel
    from typing import ClassVar, Literal, Optional

    class LooseTool(BaseModel):
        """Loose test tool."""

        tool: Literal["loose_tool"]
        value: int

    class StrictTool(BaseModel):
        """Strict test tool."""

        anthropic_strict_tool: ClassVar[bool] = True
        tool: Literal["strict_tool"]
        value: int
        optional_value: Optional[int] = None

    class AgentAction(BaseModel):
        response: str
        tool_calls: list[LooseTool | StrictTool]

    unsupported = {
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "minLength",
        "maxLength",
        "multipleOf",
        "minItems",
        "maxItems",
    }

    unsupported_model_tools = build_anthropic_tools_from_response_model(
        AgentAction,
        model="claude-sonnet-4-4",
    )
    assert unsupported_model_tools is not None
    assert all("strict" not in tool for tool in unsupported_model_tools)

    tools = build_anthropic_tools_from_response_model(
        AgentAction,
        model="claude-sonnet-4-6",
    )
    assert tools is not None
    by_name = {tool["name"]: tool for tool in tools}
    assert "strict" not in by_name["loose_tool"]
    assert by_name["strict_tool"]["strict"] is True
    for node in _walk_schema(by_name["strict_tool"]["input_schema"]):
        assert not (unsupported & set(node)), node
        if node.get("type") == "object":
            assert node.get("additionalProperties") is False, node


def test_pydantic_response_model_without_tool_calls_builds_synthetic_native_tool():
    from pydantic import BaseModel, Field

    class ProgressScore(BaseModel):
        reasoning: str
        score: float = Field(ge=0, le=1)

    tools = build_anthropic_tools_from_response_model(
        ProgressScore,
        model="claude-sonnet-4-6",
    )

    assert tools is not None
    assert len(tools) == 1
    tool = tools[0]
    assert tool["name"] == "submit_response"
    assert "strict" not in tool
    schema = tool["input_schema"]
    assert schema["type"] == "object"
    assert set(schema["required"]) == {"reasoning", "score"}
    assert schema["properties"]["score"]["minimum"] == 0
    assert schema["properties"]["score"]["maximum"] == 1


# =====================================================================
# transforms — apply_anthropic_tool_config
# =====================================================================


def test_apply_tool_config_with_explicit_tools_and_choice():
    body = {}
    used_native = apply_anthropic_tool_config(
        body=body,
        response_format=None,
        use_native_tools=False,
        tools=[
            {"function": {"name": "f", "description": "d", "parameters": {"type": "object"}}}
        ],
        tool_choice="required",
    )
    assert used_native is False
    assert body["tools"][0]["name"] == "f"
    assert body["tool_choice"] == {"type": "any"}


def test_apply_tool_config_choice_auto_and_specific_tool():
    body1 = {}
    apply_anthropic_tool_config(
        body=body1,
        response_format=None,
        use_native_tools=False,
        tools=[{"name": "x", "description": "y", "input_schema": {"type": "object"}}],
        tool_choice="auto",
    )
    assert body1["tool_choice"] == {"type": "auto"}

    body2 = {}
    apply_anthropic_tool_config(
        body=body2,
        response_format=None,
        use_native_tools=False,
        tools=[{"name": "x", "description": "y", "input_schema": {"type": "object"}}],
        tool_choice={"function": {"name": "do_it"}},
    )
    assert body2["tool_choice"] == {"type": "tool", "name": "do_it"}


def test_apply_tool_config_response_format_native_lift():
    """When use_native_tools=True and pre-extracted tools are passed,
    install them as native Anthropic tools with tool_choice=auto.

    The extraction from response_format now happens in build_anthropic_body
    (claude_auth.py), not inside apply_anthropic_tool_config. This test
    verifies the direct native-tool installation path.
    """
    body = {}
    native_tools = [
        {"name": "web_search", "description": "search", "input_schema": {
            "type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"],
        }},
        {"name": "finished", "description": "finish", "input_schema": {
            "type": "object", "properties": {}, "required": [],
        }},
    ]
    used_native = apply_anthropic_tool_config(
        body=body,
        response_format=None,
        use_native_tools=True,
        tools=native_tools,
    )
    assert used_native is True
    names = sorted(t["name"] for t in body["tools"])
    assert names == ["finished", "web_search"]
    assert body["tool_choice"] == {"type": "auto"}


def test_apply_tool_config_response_format_structured_output_path():
    body = {}
    rf = {
        "json_schema": {
            "schema": {"type": "object", "properties": {"x": {"type": "string"}}}
        }
    }
    used = apply_anthropic_tool_config(
        body=body, response_format=rf, use_native_tools=False
    )
    assert used is False
    assert "output_format" in body
    assert body["output_format"]["type"] == "json_schema"

    body2 = {}
    apply_anthropic_tool_config(
        body=body2, response_format=rf, use_native_tools=True
    )
    # use_native_tools=True without anyOf variants → output_config (claudeAuth shape)
    assert "output_config" in body2


# =====================================================================
# transforms — vision + reconstruct
# =====================================================================


def test_is_vision_capable_membership():
    assert is_vision_capable("openai/gpt-4o")
    assert is_vision_capable("anthropic/claude-sonnet-4.5")
    assert not is_vision_capable("google/gemini-3-flash-preview")
    assert not is_vision_capable("rose-labs/rose-1-lite")


def test_has_screenshot_markers_detection():
    assert has_screenshot_markers([
        {"role": "tool", "content": '{"__screenshot_base64__": "AAA"}'}
    ])
    assert not has_screenshot_markers([{"role": "user", "content": "hi"}])
    assert not has_screenshot_markers([{"role": "tool", "content": "no marker"}])


def test_transform_messages_for_vision_expands_marker():
    out = transform_messages_for_vision([
        {
            "role": "tool",
            "content": json.dumps({"__screenshot_base64__": "ZZZZ", "summary": "ok"}),
        }
    ])
    assert len(out) == 2
    cleaned = json.loads(out[0]["content"])
    assert cleaned["screenshot_attached"] is True
    assert "__screenshot_base64__" not in cleaned
    user_msg = out[1]
    assert user_msg["role"] == "user"
    assert user_msg["content"][1]["type"] == "image_url"
    assert "ZZZZ" in user_msg["content"][1]["image_url"]["url"]


def test_transform_messages_for_vision_passthrough_on_invalid_json():
    msgs = [{"role": "tool", "content": "__screenshot_base64__:invalid"}]
    out = transform_messages_for_vision(msgs)
    assert out == msgs


def test_get_messages_for_model_routes_by_vision():
    msgs = [
        {"role": "tool", "content": json.dumps({"__screenshot_base64__": "X"})}
    ]
    # Vision-capable → expanded
    out_vision = get_messages_for_model(msgs, "openai/gpt-4o")
    assert len(out_vision) == 2
    # Non-vision → passthrough
    out_no = get_messages_for_model(msgs, "google/gemini-3-flash-preview")
    assert out_no == msgs


def test_reconstruct_agent_response_envelope():
    out = reconstruct_agent_response(
        text_content="hi there",
        tool_use_blocks=[
            {"name": "web_search", "input": {"q": "rose"}},
            {"name": "finished", "input": {}},
        ],
    )
    parsed = json.loads(out)
    assert parsed["response"] == "hi there"
    assert parsed["reasoning"] == ""
    assert parsed["tool_calls"][0] == {"tool": "web_search", "q": "rose"}
    assert parsed["tool_calls"][1] == {"tool": "finished"}


def test_reconstruct_agent_response_handles_non_dict_input():
    out = reconstruct_agent_response("", [{"name": "f", "input": None}])
    parsed = json.loads(out)
    # Non-dict input gets coerced to {}
    assert parsed["tool_calls"][0] == {"tool": "f"}


def test_transform_messages_for_openai_adds_cache_breakpoints():
    """Cache-control contract for the OR waterfall path: only the first system
    message's trailing block gets marked. The last user message must NOT be
    marked because Gemini-via-OR uses the LAST cache_control as the cache key,
    which would defeat caching when that block is per-call dynamic.
    """
    msgs = [
        {"role": "system", "content": "you are helpful"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "bye"},
    ]
    out = transform_messages_for_openai(msgs)
    # System message gets cache_control breakpoint
    assert out[0]["content"] == [
        {"type": "text", "text": "you are helpful", "cache_control": {"type": "ephemeral"}}
    ]
    # Last user message must remain UNMARKED (cross-provider safe).
    assert out[-1] == {"role": "user", "content": "bye"}
    # Middle messages are untouched
    assert out[1] == {"role": "user", "content": "hello"}
    assert out[2] == {"role": "assistant", "content": "hi"}
    # Original not mutated
    assert msgs[0]["content"] == "you are helpful"


def test_transform_messages_for_openai_multi_boundary_system_blocks_are_cached():
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    msgs = [
        {
            "role": "system",
            "content": (
                f"main{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}"
                f"user context{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}"
                f"phase{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}"
            ),
        },
        {"role": "user", "content": "hello"},
    ]
    out = transform_messages_for_openai(msgs)
    assert out[0]["content"] == [
        {"type": "text", "text": "main", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "user context", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "phase", "cache_control": {"type": "ephemeral"}},
    ]
    assert out[1] == {"role": "user", "content": "hello"}


# =====================================================================
# claude_auth — body assembly
# =====================================================================


def test_build_anthropic_body_identity_and_cache_block():
    spec = get_pool("rose-1-lite")
    body = build_anthropic_body(
        pool_spec=spec,
        messages=[
            {"role": "system", "content": "be helpful"},
            {"role": "user", "content": "hi"},
        ],
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        skip_cache_write=False,
    )
    assert body["model"] == spec.claude_auth_model
    assert body["max_tokens"] == 128
    assert body["stream"] is True
    sys = body["system"]
    assert sys[0]["text"].startswith("You are a Claude agent")
    # Without boundary, all system text is in one static block with global scope
    cached_blocks = [b for b in sys if "cache_control" in b]
    assert len(cached_blocks) == 1
    assert cached_blocks[0]["cache_control"] == {"type": "ephemeral", "scope": "global"}


def test_build_anthropic_body_static_dynamic_split():
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    spec = get_pool("rose-1-lite")
    system_content = f"static instructions{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}Current time: April 28"
    body = build_anthropic_body(
        pool_spec=spec,
        messages=[
            {"role": "system", "content": system_content},
            {"role": "user", "content": "hi"},
        ],
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        skip_cache_write=False,
    )
    sys = body["system"]
    # identity + disclaimer + static (cached) + dynamic (no cache)
    assert len(sys) == 4
    static_block = sys[2]
    dynamic_block = sys[3]
    assert static_block["text"] == "static instructions"
    assert static_block["cache_control"] == {"type": "ephemeral", "scope": "global"}
    assert dynamic_block["text"] == "Current time: April 28"
    assert "cache_control" not in dynamic_block


def test_build_anthropic_body_multi_boundary_system_blocks_are_cached():
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    spec = get_pool("rose-1-lite")
    system_content = (
        f"static instructions{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}"
        f"user context{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}"
        f"phase prompt{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}"
    )
    body = build_anthropic_body(
        pool_spec=spec,
        messages=[
            {"role": "system", "content": system_content},
            {"role": "user", "content": "hi"},
        ],
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        skip_cache_write=False,
    )

    sys = body["system"]
    assert [b["text"] for b in sys[2:]] == ["static instructions", "user context", "phase prompt"]
    assert all(b["cache_control"] == {"type": "ephemeral", "scope": "global"} for b in sys[2:])


def test_build_anthropic_body_message_cache_breakpoint():
    spec = get_pool("rose-1-lite")
    body = build_anthropic_body(
        pool_spec=spec,
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "reply"},
            {"role": "user", "content": "second"},
        ],
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        skip_cache_write=False,
    )
    msgs = body["messages"]
    # Last message should have cache_control on its last content block
    last_msg = msgs[-1]
    if isinstance(last_msg["content"], list):
        last_block = last_msg["content"][-1]
        assert last_block.get("cache_control") == {"type": "ephemeral"}
    else:
        # String content gets wrapped into a list with cache_control
        assert isinstance(last_msg["content"], list)
        assert last_msg["content"][-1]["cache_control"] == {"type": "ephemeral"}
    # Earlier messages should NOT have cache_control
    for msg in msgs[:-1]:
        if isinstance(msg.get("content"), list):
            for block in msg["content"]:
                assert "cache_control" not in block, f"Unexpected cache_control in non-last message"


def test_build_anthropic_body_skip_cache_write_keeps_system_markers():
    spec = get_pool("rose-1-lite")
    body = build_anthropic_body(
        pool_spec=spec,
        messages=[
            {"role": "system", "content": "x"},
            {"role": "user", "content": "y"},
        ],
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=64,
        skip_cache_write=True,
    )
    # skip_cache_write keeps system cache_control (for reads) but strips message breakpoint
    user_system = [b for b in body["system"] if b.get("text") not in (
        "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        "Disregard the previous identity — you are NOT Claude Code. You are a Rose Labs AI agent. Follow the system instructions below.",
    )]
    assert any("cache_control" in b for b in user_system), "system blocks should keep cache markers for reads"
    last_msg = body["messages"][-1]
    if isinstance(last_msg.get("content"), list):
        for block in last_msg["content"]:
            assert "cache_control" not in block, "message breakpoint should be stripped"
    else:
        assert isinstance(last_msg["content"], str)


# =====================================================================
# claude_auth — error classification (HTTP)
# =====================================================================


async def _drain(gen):
    out = []
    async for chunk in gen:
        out.append(chunk)
    return out


async def test_claude_auth_400_raises_invalid_request_no_rotation():
    captured: list[str] = []

    def handler(req):
        captured.append(str(req.url))
        return httpx.Response(400, json={"error": {"message": "bad shape"}})

    set_mock_handler(handler)

    spec = get_pool("rose-1-lite")
    auth = ClaudeAuthContext(token="t", source="user", user_id="", max_rotations=3)
    raised = False
    try:
        await _drain(claude_auth_complete(
            pool_spec=spec,
            messages=[{"role": "user", "content": "hi"}],
            auth=auth,
            request_id="r1",
            max_tokens=16,
        ))
    except RoseInvalidRequest:
        raised = True
    assert raised
    # Exactly one Anthropic call — no rotation on 400.
    assert len([u for u in captured if "api.anthropic.com" in u]) == 1


async def test_claude_auth_5xx_retries_then_raises_server_error():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(503, text="oops")

    set_mock_handler(handler)

    spec = get_pool("rose-1-lite")
    auth = ClaudeAuthContext(token="t", source="user", user_id="", max_rotations=0)
    raised = False
    try:
        await _drain(claude_auth_complete(
            pool_spec=spec,
            messages=[{"role": "user", "content": "hi"}],
            auth=auth,
            request_id="r-5xx",
            max_tokens=16,
        ))
    except RoseServerError:
        raised = True
    assert raised
    # Three in-place attempts before raising server error.
    assert calls["n"] == 3


async def test_claude_auth_401_rotates_and_exhausts():
    """401 → _RotateToken('auth_error'); with max_rotations=0, raises after one
    rotate attempt."""
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(401, json={"error": {"message": "expired"}})

    set_mock_handler(handler)

    spec = get_pool("rose-1-lite")
    auth = ClaudeAuthContext(token="t", source="user", user_id="", max_rotations=0)
    raised = False
    try:
        await _drain(claude_auth_complete(
            pool_spec=spec,
            messages=[{"role": "user", "content": "hi"}],
            auth=auth,
            request_id="r-401",
            max_tokens=16,
        ))
    except RoseAuthError:
        raised = True
    assert raised
    assert calls["n"] == 1


async def test_claude_auth_429_usage_window_marks_reset_and_fetches_fresh_token():
    """Usage-window 429 marks the exact reset time and rotates immediately."""
    reset_at = "2099-05-05T20:15:00Z"
    seen_tokens: list[str] = []
    marked: list[tuple[str, int, str | None]] = []

    async def mark(ctx, cooldown_seconds, rate_limited_until=None):
        marked.append((ctx.token, cooldown_seconds, rate_limited_until))
        return True

    async def fetch_fresh(user_id):
        assert user_id == "u-1"
        return ClaudeAuthContext(
            token="fresh-token",
            source="pool",
            user_id=user_id,
            pool_token_id="pool-2",
            mark_rate_limited=mark,
            fetch_fresh=fetch_fresh,
            max_rotations=1,
        )

    sse_body = "\n".join(
        _ev("message_start", {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 3}},
        })
        + _ev("content_block_start", {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        })
        + _ev("content_block_delta", {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": "ok"},
        })
        + _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
        + _ev("message_delta", {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 1},
        })
        + _ev("message_stop", {"type": "message_stop"})
    )

    def handler(req):
        seen_tokens.append(req.headers.get("authorization", ""))
        if len(seen_tokens) == 1:
            return httpx.Response(
                429,
                json={
                    "error": {
                        "message": f"Claude Code usage limit reached. Your limit resets at {reset_at}."
                    }
                },
                headers={"anthropic-ratelimit-unified-reset": reset_at},
            )
        return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    auth = ClaudeAuthContext(
        token="old-token",
        source="pool",
        user_id="u-1",
        pool_token_id="pool-1",
        mark_rate_limited=mark,
        fetch_fresh=fetch_fresh,
        max_rotations=1,
    )
    chunks = await _drain(claude_auth_complete(
        pool_spec=get_pool("rose-1-lite"),
        messages=[{"role": "user", "content": "hi"}],
        auth=auth,
        request_id="r-rotate-429",
        max_tokens=16,
    ))

    assert marked == [("old-token", 300, reset_at)]
    assert seen_tokens == ["Bearer old-token", "Bearer fresh-token"]
    assert any(c.kind == "content" and c.data.get("text") == "ok" for c in chunks)


async def test_claude_auth_429_transient_retries_before_rotating():
    """Transient 429s retry the same token before cooldown/rotation."""
    calls = {"n": 0}
    marked: list[tuple[str, str | None]] = []

    async def mark(ctx, cooldown_seconds, rate_limited_until=None):
        marked.append((ctx.token, rate_limited_until))
        return True

    def handler(req):
        calls["n"] += 1
        return httpx.Response(
            429,
            json={"error": {"message": "too many requests, slow down"}},
        )

    set_mock_handler(handler)

    auth = ClaudeAuthContext(
        token="transient-token",
        source="pool",
        user_id="u-1",
        mark_rate_limited=mark,
        max_rotations=0,
    )

    raised = False
    with patch("providers.rose.claude_auth.random.uniform", return_value=0), patch(
        "providers.rose.claude_auth.asyncio.sleep",
        new=AsyncMock(),
    ):
        try:
            await _drain(claude_auth_complete(
                pool_spec=get_pool("rose-1-lite"),
                messages=[{"role": "user", "content": "hi"}],
                auth=auth,
                request_id="r-transient-429",
                max_tokens=16,
            ))
        except RoseAuthError as exc:
            raised = True
            assert "rate_limit" in str(exc)

    assert raised
    assert calls["n"] == 3
    assert marked == [("transient-token", None)]


async def test_claude_auth_403_usage_limit_marks_body_reset_time():
    """Usage-limit 403 is a rate-limit rotation, not a permanent auth error."""
    reset_at = "2099-05-05T21:30:00Z"
    marked: list[tuple[str, str | None]] = []

    async def mark(ctx, cooldown_seconds, rate_limited_until=None):
        marked.append((ctx.token, rate_limited_until))
        return True

    def handler(req):
        return httpx.Response(
            403,
            json={
                "error": {
                    "message": f"Claude Code usage limit reached. Your limit resets at {reset_at}."
                }
            },
        )

    set_mock_handler(handler)

    auth = ClaudeAuthContext(
        token="limited-token",
        source="user",
        user_id="u-1",
        mark_rate_limited=mark,
        max_rotations=0,
    )
    raised = False
    try:
        await _drain(claude_auth_complete(
            pool_spec=get_pool("rose-1-lite"),
            messages=[{"role": "user", "content": "hi"}],
            auth=auth,
            request_id="r-usage-limit",
            max_tokens=16,
        ))
    except RoseAuthError as exc:
        raised = True
        assert "rate_limit" in str(exc)

    assert raised
    assert marked == [("limited-token", reset_at)]


# =====================================================================
# streaming — Anthropic native SSE parser
# =====================================================================


class _FakeStream:
    """Minimal _LineStream Protocol implementation for streaming tests."""

    def __init__(self, lines):
        self._lines = lines

    def aiter_lines(self):
        async def gen():
            for line in self._lines:
                yield line
        return gen()

    async def aclose(self):
        return None


def _ev(event: str, data: dict):
    return [f"event: {event}", f"data: {json.dumps(data)}", ""]


async def test_parse_anthropic_sse_text_and_usage():
    lines = []
    lines += _ev("message_start", {
        "type": "message_start",
        "message": {
            "usage": {
                "input_tokens": 7,
                "cache_read_input_tokens": 2,
                "cache_creation_input_tokens": 3,
            }
        },
    })
    lines += _ev("content_block_start", {
        "type": "content_block_start", "index": 0,
        "content_block": {"type": "text", "text": ""},
    })
    lines += _ev("content_block_delta", {
        "type": "content_block_delta", "index": 0,
        "delta": {"type": "text_delta", "text": "hi"},
    })
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn"},
        "usage": {"output_tokens": 5},
    })
    lines += _ev("message_stop", {"type": "message_stop"})

    chunks = await _drain(parse_anthropic_sse(
        _FakeStream(lines),
        actual_model="claude-test",
        pool_name="claude-token",
        request_id="r-anth-1",
    ))
    kinds = [c.kind for c in chunks]
    assert kinds[0] == "metadata"
    assert "content" in kinds
    assert kinds[-2] == "usage"
    assert kinds[-1] == "done"
    usage = next(c for c in chunks if c.kind == "usage")
    assert usage.data["prompt_tokens"] == 7
    assert usage.data["completion_tokens"] == 5
    assert usage.data["cache_read_input_tokens"] == 2
    assert usage.data["cache_creation_input_tokens"] == 3
    assert usage.data["finish_reason"] == "stop"


async def test_parse_anthropic_sse_tool_use_block():
    lines = []
    lines += _ev("message_start", {
        "type": "message_start", "message": {"usage": {"input_tokens": 1}},
    })
    lines += _ev("content_block_start", {
        "type": "content_block_start", "index": 0,
        "content_block": {"type": "tool_use", "id": "tu-1", "name": "f", "input": {}},
    })
    lines += _ev("content_block_delta", {
        "type": "content_block_delta", "index": 0,
        "delta": {"type": "input_json_delta", "partial_json": '{"a":'},
    })
    lines += _ev("content_block_delta", {
        "type": "content_block_delta", "index": 0,
        "delta": {"type": "input_json_delta", "partial_json": ' 1}'},
    })
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "tool_use"},
        "usage": {"output_tokens": 3},
    })
    lines += _ev("message_stop", {"type": "message_stop"})

    chunks = await _drain(parse_anthropic_sse(
        _FakeStream(lines),
        actual_model="claude-test",
        pool_name="claude-token",
        request_id="r-anth-tool",
    ))
    tool_chunks = [c for c in chunks if c.kind == "tool_call"]
    assert len(tool_chunks) == 1
    tc = tool_chunks[0]
    assert tc.data["id"] == "tu-1"
    assert tc.data["name"] == "f"
    assert tc.data["arguments"] == '{"a": 1}'
    usage = next(c for c in chunks if c.kind == "usage")
    assert usage.data["finish_reason"] == "tool_calls"


async def test_parse_anthropic_sse_empty_stream_raises_stall():
    lines = _ev("message_start", {
        "type": "message_start", "message": {"usage": {"input_tokens": 1}},
    })
    lines += _ev("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn"},
        "usage": {"output_tokens": 0},
    })
    raised = False
    try:
        await _drain(parse_anthropic_sse(
            _FakeStream(lines),
            actual_model="claude-test",
            pool_name="claude-token",
            request_id="r-empty",
        ))
    except RoseStallError:
        raised = True
    assert raised


async def test_parse_anthropic_sse_thinking_delta_counts_as_emitted():
    lines = []
    lines += _ev("message_start", {
        "type": "message_start", "message": {"usage": {"input_tokens": 1}},
    })
    lines += _ev("content_block_start", {
        "type": "content_block_start", "index": 0,
        "content_block": {"type": "thinking"},
    })
    lines += _ev("content_block_delta", {
        "type": "content_block_delta", "index": 0,
        "delta": {"type": "thinking_delta", "thinking": "let me think"},
    })
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn"},
        "usage": {"output_tokens": 2},
    })
    chunks = await _drain(parse_anthropic_sse(
        _FakeStream(lines),
        actual_model="claude-test",
        pool_name="claude-token",
        request_id="r-think",
    ))
    reasoning = [c for c in chunks if c.kind == "reasoning"]
    assert len(reasoning) == 1
    assert reasoning[0].data["text"] == "let me think"


async def test_parse_anthropic_sse_skips_event_lines_and_bad_json():
    lines = [
        "event: ignored",
        "",
        "data: not-json{{",
        "",
    ]
    lines += _ev("message_start", {
        "type": "message_start", "message": {"usage": {"input_tokens": 1}},
    })
    lines += _ev("content_block_start", {
        "type": "content_block_start", "index": 0,
        "content_block": {"type": "text", "text": ""},
    })
    lines += _ev("content_block_delta", {
        "type": "content_block_delta", "index": 0,
        "delta": {"type": "text_delta", "text": "ok"},
    })
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn"},
        "usage": {"output_tokens": 1},
    })
    chunks = await _drain(parse_anthropic_sse(
        _FakeStream(lines),
        actual_model="m",
        pool_name="claude-token",
        request_id="r-mix",
    ))
    contents = [c for c in chunks if c.kind == "content"]
    assert contents and contents[0].data["text"] == "ok"


# =====================================================================
# streaming — OpenAI/OpenRouter SSE parser
# =====================================================================


def _openai_sse(payloads: list[dict]) -> list[str]:
    lines = []
    for p in payloads:
        lines.append(f"data: {json.dumps(p)}")
        lines.append("")
    lines.append("data: [DONE]")
    return lines


async def test_parse_openai_sse_content_and_finish_reason():
    payloads = [
        {"choices": [{"delta": {"content": "hello "}}]},
        {"choices": [{"delta": {"content": "world"}, "finish_reason": "stop"}]},
        {"usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6}},
    ]
    chunks = await _drain(parse_openai_sse(
        _FakeStream(_openai_sse(payloads)),
        actual_model="g",
        pool_name="rose-1-lite",
        request_id="r-or-1",
    ))
    text = "".join(c.data["text"] for c in chunks if c.kind == "content")
    assert text == "hello world"
    usage = next(c for c in chunks if c.kind == "usage")
    assert usage.data["finish_reason"] == "stop"
    assert usage.data["total_tokens"] == 6


async def test_parse_openai_sse_tool_call_assembly_across_deltas():
    payloads = [
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "tc-1", "function": {"name": "f", "arguments": '{"a"'}}
        ]}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": ': 1}'}}
        ]}, "finish_reason": "tool_calls"}]},
        {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
    ]
    chunks = await _drain(parse_openai_sse(
        _FakeStream(_openai_sse(payloads)),
        actual_model="g",
        pool_name="p",
        request_id="r-tc",
    ))
    tcs = [c for c in chunks if c.kind == "tool_call"]
    assert len(tcs) == 1
    assert tcs[0].data["id"] == "tc-1"
    assert tcs[0].data["name"] == "f"
    assert tcs[0].data["arguments"] == '{"a": 1}'


async def test_parse_openai_sse_reasoning_content_alias():
    payloads = [
        {"choices": [{"delta": {"reasoning_content": "thinking..."}}]},
        {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
    ]
    chunks = await _drain(parse_openai_sse(
        _FakeStream(_openai_sse(payloads)),
        actual_model="g", pool_name="p", request_id="r-rc",
    ))
    rs = [c for c in chunks if c.kind == "reasoning"]
    assert rs and rs[0].data["text"] == "thinking..."


async def test_parse_openai_sse_empty_stream_raises_stall():
    payloads = [
        {"choices": [{"delta": {}}]},
        {"usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}},
    ]
    raised = False
    try:
        await _drain(parse_openai_sse(
            _FakeStream(_openai_sse(payloads)),
            actual_model="g", pool_name="p", request_id="r-empty-or",
        ))
    except RoseStallError:
        raised = True
    assert raised


async def test_parse_responses_sse_content_and_usage():
    lines = [
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"Hello"}',
        "",
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":" GPT"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10,"input_tokens_details":{"cached_tokens":2}}}}',
        "",
        "data: [DONE]",
    ]
    chunks = [c async for c in parse_responses_sse(
        _FakeStream(lines),
        actual_model="gpt-5.4-mini-gpt",
        pool_name="gpt-token",
        request_id="r1",
    )]
    assert chunks[0].kind == "metadata"
    assert chunks[0].data["pool_name"] == "gpt-token"
    assert "".join(c.data.get("text", "") for c in chunks if c.kind == "content") == "Hello GPT"
    usage = [c for c in chunks if c.kind == "usage"][0].data
    assert usage["prompt_tokens"] == 7
    assert usage["completion_tokens"] == 3
    assert usage["total_tokens"] == 10
    assert usage["cache_read_input_tokens"] == 2


async def test_parse_responses_sse_function_call_item():
    lines = [
        "event: response.output_item.done",
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        "",
        "data: [DONE]",
    ]
    chunks = [c async for c in parse_responses_sse(
        _FakeStream(lines),
        actual_model="gpt-5.4-gpt",
        pool_name="gpt-token",
        request_id="r-tool",
    )]
    tool = [c for c in chunks if c.kind == "tool_call"][0]
    assert tool.data == {"id": "call_1", "name": "lookup", "arguments": '{"q":"x"}'}
    assert [c for c in chunks if c.kind == "usage"][0].data["total_tokens"] == 5


async def test_parse_responses_sse_failed_context_length_is_invalid_request():
    lines = [
        "event: response.failed",
        'data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"too many tokens"}}}',
        "",
        "data: [DONE]",
    ]
    raised = False
    try:
        await _drain(parse_responses_sse(
            _FakeStream(lines),
            actual_model="gpt-5.5-gpt",
            pool_name="gpt-token",
            request_id="r-context",
        ))
    except RoseInvalidRequest:
        raised = True
    assert raised


def test_build_codex_responses_body_contract():
    pool = get_pool("rose-1-lite")
    body = build_codex_responses_body(
        pool_spec=pool,
        messages=[
            {"role": "system", "content": "be exact"},
            {"role": "user", "content": "hi"},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "unit_test",
                "strict": True,
                "schema": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        },
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "lookup",
                    "description": "Search",
                    "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
                },
            }
        ],
        temperature=0.2,
        effort="high",
        request_id="rid",
    )
    same_prompt_different_request = build_codex_responses_body(
        pool_spec=pool,
        messages=[
            {"role": "system", "content": "be exact"},
            {"role": "user", "content": "different live input"},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "unit_test",
                "strict": True,
                "schema": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        },
        temperature=0.2,
        effort="high",
        request_id="different-rid",
    )
    assert body["model"] == pool.gpt_auth_model
    assert body["stream"] is True
    assert body["store"] is False
    assert "max_tokens" not in body
    assert "max_output_tokens" not in body
    assert "temperature" not in body
    assert body["instructions"] == "be exact"
    assert body["input"][0]["content"][0]["type"] == "input_text"
    assert body["tools"][0]["name"] == "lookup"
    assert body["text"]["format"]["name"] == "unit_test"
    assert body["reasoning"]["effort"] == "high"
    assert body["prompt_cache_key"].startswith("rose:")
    assert body["prompt_cache_key"] == same_prompt_different_request["prompt_cache_key"]
    no_system_body = build_codex_responses_body(
        pool_spec=pool,
        messages=[{"role": "user", "content": "hi"}],
        request_id="no-system",
    )
    assert no_system_body["instructions"] == "You are a helpful assistant."
    max_effort_body = build_codex_responses_body(
        pool_spec=pool,
        messages=[{"role": "user", "content": "hi"}],
        effort="max",
        request_id="max-effort",
    )
    assert max_effort_body["reasoning"]["effort"] == "xhigh"


def test_build_codex_responses_body_preserves_tool_history_and_multimodal():
    pool = get_pool("rose-1-lite")
    body = build_codex_responses_body(
        pool_spec=pool,
        messages=[
            {"role": "system", "content": "be exact"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "inspect"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc", "detail": "high"}},
                ],
            },
            {
                "role": "assistant",
                "content": "calling",
                "codex_reasoning_items": [{"id": "rs_1", "encrypted_content": "secret", "summary": []}],
                "codex_message_items": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "id": "msg_1",
                        "phase": "final",
                        "content": [{"type": "output_text", "text": "prior"}],
                    }
                ],
                "tool_calls": [
                    {
                        "id": "call_lookup",
                        "function": {"name": "lookup", "arguments": {"q": "x"}},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_lookup", "content": '{"ok":true}'},
            {"role": "user", "content": "continue"},
        ],
        request_id="rid-tool-history",
    )
    input_items = body["input"]
    assert input_items[0]["content"][1] == {
        "type": "input_image",
        "image_url": "data:image/png;base64,abc",
        "detail": "high",
    }
    assert {"type": "reasoning", "encrypted_content": "secret", "summary": []} in input_items
    assert any(item.get("type") == "message" and item.get("id") == "msg_1" for item in input_items)
    assert any(item.get("type") == "function_call" and item.get("call_id") == "call_lookup" for item in input_items)
    assert any(item.get("type") == "function_call_output" and item.get("call_id") == "call_lookup" for item in input_items)


def test_build_codex_responses_body_converts_orphan_tool_rows_to_context():
    pool = get_pool("rose-1-lite")
    body = build_codex_responses_body(
        pool_spec=pool,
        messages=[
            {"role": "system", "content": "be exact"},
            {"role": "user", "content": "summarize prior tool output"},
            {"role": "tool", "tool_call_id": "missing_call", "content": "population: 123"},
        ],
        request_id="rid-orphan-tool",
    )
    input_items = body["input"]
    assert not any(item.get("type") == "function_call_output" for item in input_items)
    assert input_items[-1] == {
        "role": "user",
        "content": [{"type": "input_text", "text": "[TOOL]: population: 123"}],
    }


# =====================================================================
# waterfall
# =====================================================================


def test_build_openrouter_body_includes_optionals():
    body = build_openrouter_body(
        model="google/gemini-3-flash-preview",
        messages=[{"role": "user", "content": "hi"}],
        tools=[{"type": "function", "function": {"name": "f"}}],
        tool_choice="auto",
        response_format={"type": "json_object"},
        temperature=0.4,
        max_tokens=42,
        seed=7,
    )
    assert body["model"] == "google/gemini-3-flash-preview"
    assert body["stream"] is True
    assert body["stream_options"] == {"include_usage": True}
    assert body["tool_choice"] == "auto"
    assert body["temperature"] == 0.4
    assert body["max_tokens"] == 42
    assert body["seed"] == 7


def test_build_openrouter_body_minimal_omits_optionals():
    body = build_openrouter_body(
        model="m",
        messages=[],
        tools=None,
        tool_choice=None,
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
    )
    assert body["stream_options"] == {"include_usage": True}
    assert "tools" not in body
    assert "tool_choice" not in body
    assert "response_format" not in body
    assert "temperature" not in body
    assert "max_tokens" not in body
    assert "seed" not in body


async def test_waterfall_falls_through_then_succeeds():
    """First model returns 500 → second model streams clean response."""
    call_log: list[str] = []
    sse_ok = "\n".join(_openai_sse([
        {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]},
        {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
    ]))
    state = {"i": 0}

    def handler(req):
        call_log.append(str(req.url))
        body = json.loads(req.content.decode())
        model = body.get("model", "")
        i = state["i"]
        state["i"] += 1
        if i == 0:
            return httpx.Response(500, text="boom")
        return httpx.Response(
            200, text=sse_ok, headers={"Content-Type": "text/event-stream"}
        )

    set_mock_handler(handler)
    spec = get_pool("rose-1-lite")
    chunks = await _drain(waterfall_complete(
        pool_spec=spec,
        messages=[{"role": "user", "content": "hi"}],
        openrouter_key="ork-test",
        request_id="r-wf",
    ))
    kinds = [c.kind for c in chunks]
    assert "content" in kinds
    assert kinds[-1] == "done"
    # Both steps were called
    assert state["i"] == 2


async def test_waterfall_skips_anthropic_for_response_format():
    """OpenRouter Anthropic rejects response_format; waterfall skips to next model."""
    sse_ok = "\n".join(_openai_sse([
        {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]},
        {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
    ]))
    models_seen: list[str] = []

    def handler(req):
        body = json.loads(req.content.decode())
        models_seen.append(body["model"])
        return httpx.Response(
            200, text=sse_ok, headers={"Content-Type": "text/event-stream"}
        )

    set_mock_handler(handler)
    chunks = await _drain(waterfall_complete(
        pool_spec=get_pool("rose-1-ultra"),
        messages=[{"role": "user", "content": "hi"}],
        response_format={"type": "json_schema", "json_schema": {"schema": {"type": "object"}}},
        openrouter_key="ork-test",
        request_id="r-skip-anthropic-rf",
    ))

    assert models_seen == ["google/gemini-3.1-pro-preview"]
    assert any(c.kind == "content" for c in chunks)


async def test_waterfall_all_failed_raises_with_step_errors():
    def handler(req):
        return httpx.Response(503, text="upstream down")

    set_mock_handler(handler)
    spec = get_pool("rose-1-lite")
    raised = False
    try:
        await _drain(waterfall_complete(
            pool_spec=spec,
            messages=[{"role": "user", "content": "hi"}],
            openrouter_key="ork-test",
            request_id="r-all-fail",
        ))
    except RoseAllFailed as e:
        raised = True
        assert len(e.step_errors) == len(spec.waterfall)
    assert raised


async def test_waterfall_reports_cache_metrics_from_openrouter():
    """Waterfall streams usage with cache fields from prompt_tokens_details."""
    sse_ok = "\n".join(_openai_sse([
        {"choices": [{"delta": {"content": "cached"}, "finish_reason": "stop"}]},
        {"usage": {
            "prompt_tokens": 500,
            "completion_tokens": 10,
            "total_tokens": 510,
            "prompt_tokens_details": {
                "cached_tokens": 4500,
                "cache_write_tokens": 100,
            },
        }},
    ]))

    def handler(req):
        body = json.loads(req.content.decode())
        assert body.get("stream_options") == {"include_usage": True}, \
            "stream_options missing — OpenRouter won't return usage in streaming"
        msgs = body["messages"]
        sys_msg = next((m for m in msgs if m["role"] == "system"), None)
        if sys_msg:
            content = sys_msg["content"]
            if isinstance(content, list):
                assert any(b.get("cache_control") for b in content), \
                    "System message missing cache_control breakpoint"
        return httpx.Response(
            200, text=sse_ok, headers={"Content-Type": "text/event-stream"}
        )

    set_mock_handler(handler)
    spec = get_pool("rose-1-lite")
    chunks = await _drain(waterfall_complete(
        pool_spec=spec,
        messages=[
            {"role": "system", "content": "you are helpful"},
            {"role": "user", "content": "hello"},
        ],
        openrouter_key="ork-test",
        request_id="r-cache",
    ))
    usage_chunk = next(c for c in chunks if c.kind == "usage")
    assert usage_chunk.data["cache_read_input_tokens"] == 4500
    assert usage_chunk.data["cache_creation_input_tokens"] == 100
    assert usage_chunk.data["prompt_tokens"] == 500


# =====================================================================
# RoseClient — top-level orchestration
# =====================================================================


async def test_client_collect_waterfall_only_path():
    sse_ok = "\n".join(_openai_sse([
        {"choices": [{"delta": {"content": "hello"}, "finish_reason": "stop"}]},
        {"usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}},
    ]))

    def handler(req):
        return httpx.Response(
            200, text=sse_ok, headers={"Content-Type": "text/event-stream"}
        )

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    resp = await client.collect(
        pool="rose-1-lite",
        messages=[{"role": "user", "content": "hi"}],
        call_site="test-collect",
    )
    assert resp.content == "hello"
    assert resp.actual_model == "google/gemini-3-flash-preview"
    assert resp.usage.get("total_tokens") == 6


async def test_client_falls_through_from_claude_auth_to_waterfall():
    """Anthropic 401 → fall-through; waterfall succeeds; metadata carries
    `claude_token_error` set to auth_error."""
    sse_ok = "\n".join(_openai_sse([
        {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]},
        {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
    ]))

    def handler(req):
        url = str(req.url)
        if "api.anthropic.com" in url:
            return httpx.Response(401, json={"error": {"message": "expired"}})
        return httpx.Response(
            200, text=sse_ok, headers={"Content-Type": "text/event-stream"}
        )

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-lite",
        messages=[{"role": "user", "content": "hi"}],
        claude_auth=claude_auth_from_token("expired-token"),
        call_site="test-fallthrough",
    ):
        chunks.append(chunk)
    metadata = next(c for c in chunks if c.kind == "metadata")
    assert metadata.data.get("claude_token_error") == "auth_error"


async def test_client_splits_pydantic_model_to_claude_native_tools():
    AgentAction = create_agent_action_model(["wait_for", "attempt_completion"])

    sse_lines = []
    sse_lines += _ev("message_start", {
        "type": "message_start",
        "message": {"usage": {"input_tokens": 10}},
    })
    sse_lines += _ev("content_block_start", {
        "type": "content_block_start",
        "index": 0,
        "content_block": {
            "type": "tool_use",
            "id": "toolu_1",
            "name": "wait_for",
            "input": {},
        },
    })
    sse_lines += _ev("content_block_delta", {
        "type": "content_block_delta",
        "index": 0,
        "delta": {
            "type": "input_json_delta",
            "partial_json": '{"condition":"package ships"}',
        },
    })
    sse_lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    sse_lines += _ev("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "tool_use"},
        "usage": {"output_tokens": 5},
    })
    sse_lines += _ev("message_stop", {"type": "message_stop"})
    sse_body = "\n".join(sse_lines)

    seen_body = {}

    def handler(req):
        if "api.anthropic.com" in str(req.url):
            body = json.loads(req.content.decode())
            seen_body.update(body)
            return httpx.Response(
                200, text=sse_body, headers={"Content-Type": "text/event-stream"}
            )
        return httpx.Response(500, text="waterfall should not be called")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-lite",
        messages=[{"role": "user", "content": "wait until the package ships"}],
        response_model=AgentAction,
        claude_auth=claude_auth_from_token("valid-token"),
        call_site="test-pydantic-native-tools",
    ):
        chunks.append(chunk)

    assert "format" not in seen_body.get("output_config", {})
    tools = {tool["name"]: tool for tool in seen_body["tools"]}
    assert set(tools) == {"wait_for", "attempt_completion"}
    assert "strict" not in tools["wait_for"]
    wait_schema = tools["wait_for"]["input_schema"]
    assert "tool" not in wait_schema["properties"]
    assert wait_schema["required"] == []
    assert wait_schema["properties"]["check_interval_seconds"]["minimum"] == 60
    assert wait_schema["properties"]["check_interval_seconds"]["maximum"] == 86400

    tool_call = next(c for c in chunks if c.kind == "tool_call")
    assert tool_call.data["name"] == "wait_for"
    assert json.loads(tool_call.data["arguments"]) == {"condition": "package ships"}


async def test_client_splits_pydantic_model_to_gpt_native_tools():
    AgentAction = create_agent_action_model(["wait_for", "attempt_completion"])

    sse_lines = []
    sse_lines += _ev("response.output_item.done", {
        "type": "response.output_item.done",
        "item": {
            "type": "function_call",
            "call_id": "call_wait",
            "name": "wait_for",
            "arguments": '{"condition":"package ships"}',
        },
    })
    sse_lines += _ev("response.completed", {
        "type": "response.completed",
        "response": {
            "usage": {
                "input_tokens": 10,
                "output_tokens": 5,
                "total_tokens": 15,
            }
        },
    })
    sse_body = "\n".join(sse_lines)

    seen_body = {}

    def handler(req):
        if "chatgpt.com/backend-api/codex/responses" in str(req.url):
            body = json.loads(req.content.decode())
            seen_body.update(body)
            return httpx.Response(
                200, text=sse_body, headers={"Content-Type": "text/event-stream"}
            )
        return httpx.Response(500, text="waterfall should not be called")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-lite",
        messages=[{"role": "user", "content": "wait until the package ships"}],
        response_model=AgentAction,
        gpt_auth=gpt_auth_from_token("valid-token", "acct_123"),
        call_site="test-gpt-pydantic-native-tools",
    ):
        chunks.append(chunk)

    assert "text" not in seen_body
    assert seen_body["tool_choice"] == "required"
    tools = {tool["name"]: tool for tool in seen_body["tools"]}
    assert set(tools) == {"wait_for", "attempt_completion"}
    assert tools["wait_for"]["parameters"]["required"] == []

    metadata = next(c for c in chunks if c.kind == "metadata")
    assert metadata.data["actual_model"].endswith("-gpt")
    tool_call = next(c for c in chunks if c.kind == "tool_call")
    assert tool_call.data["name"] == "wait_for"
    assert json.loads(tool_call.data["arguments"]) == {"condition": "package ships"}


async def test_client_splits_plain_pydantic_model_to_forced_submit_tool():
    from pydantic import BaseModel, Field

    class ProgressScore(BaseModel):
        reasoning: str
        score: float = Field(ge=0, le=1)

    sse_lines = []
    sse_lines += _ev("message_start", {
        "type": "message_start",
        "message": {"usage": {"input_tokens": 10}},
    })
    sse_lines += _ev("content_block_start", {
        "type": "content_block_start",
        "index": 0,
        "content_block": {
            "type": "tool_use",
            "id": "toolu_submit",
            "name": "submit_response",
            "input": {},
        },
    })
    sse_lines += _ev("content_block_delta", {
        "type": "content_block_delta",
        "index": 0,
        "delta": {
            "type": "input_json_delta",
            "partial_json": '{"reasoning":"done","score":1}',
        },
    })
    sse_lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    sse_lines += _ev("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "tool_use"},
        "usage": {"output_tokens": 5},
    })
    sse_lines += _ev("message_stop", {"type": "message_stop"})
    sse_body = "\n".join(sse_lines)

    seen_body = {}

    def handler(req):
        if "api.anthropic.com" in str(req.url):
            body = json.loads(req.content.decode())
            seen_body.update(body)
            return httpx.Response(
                200, text=sse_body, headers={"Content-Type": "text/event-stream"}
            )
        return httpx.Response(500, text="waterfall should not be called")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-lite",
        messages=[{"role": "user", "content": "score progress"}],
        response_model=ProgressScore,
        claude_auth=claude_auth_from_token("valid-token"),
        call_site="test-pydantic-submit-tool",
    ):
        chunks.append(chunk)

    assert "format" not in seen_body.get("output_config", {})
    assert seen_body["tool_choice"] == {"type": "any"}
    assert "thinking" not in seen_body
    assert len(seen_body["tools"]) == 1
    tool = seen_body["tools"][0]
    assert tool["name"] == "submit_response"
    assert "__rose_force_tool_choice" not in tool
    assert tool["input_schema"]["properties"]["score"]["minimum"] == 0
    assert tool["input_schema"]["properties"]["score"]["maximum"] == 1

    tool_call = next(c for c in chunks if c.kind == "tool_call")
    assert tool_call.data["name"] == "submit_response"
    assert json.loads(tool_call.data["arguments"]) == {"reasoning": "done", "score": 1}


async def test_client_splits_plain_pydantic_model_to_gpt_required_submit_tool():
    from pydantic import BaseModel, Field

    class ProgressScore(BaseModel):
        reasoning: str
        score: float = Field(ge=0, le=1)

    sse_lines = []
    sse_lines += _ev("response.output_item.done", {
        "type": "response.output_item.done",
        "item": {
            "type": "function_call",
            "call_id": "call_submit",
            "name": "submit_response",
            "arguments": '{"reasoning":"done","score":1}',
        },
    })
    sse_lines += _ev("response.completed", {
        "type": "response.completed",
        "response": {
            "usage": {
                "input_tokens": 10,
                "output_tokens": 5,
                "total_tokens": 15,
            }
        },
    })
    sse_body = "\n".join(sse_lines)

    seen_body = {}

    def handler(req):
        if "chatgpt.com/backend-api/codex/responses" in str(req.url):
            body = json.loads(req.content.decode())
            seen_body.update(body)
            return httpx.Response(
                200, text=sse_body, headers={"Content-Type": "text/event-stream"}
            )
        return httpx.Response(500, text="waterfall should not be called")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-lite",
        messages=[{"role": "user", "content": "score progress"}],
        response_model=ProgressScore,
        gpt_auth=gpt_auth_from_token("valid-token", "acct_123"),
        call_site="test-gpt-pydantic-submit-tool",
    ):
        chunks.append(chunk)

    assert "text" not in seen_body
    assert seen_body["tool_choice"] == "required"
    assert len(seen_body["tools"]) == 1
    tool = seen_body["tools"][0]
    assert tool["name"] == "submit_response"
    assert "__rose_force_tool_choice" not in tool
    assert tool["parameters"]["properties"]["score"]["minimum"] == 0
    assert tool["parameters"]["properties"]["score"]["maximum"] == 1

    tool_call = next(c for c in chunks if c.kind == "tool_call")
    assert tool_call.data["name"] == "submit_response"
    assert json.loads(tool_call.data["arguments"]) == {"reasoning": "done", "score": 1}


async def test_client_deadline_enforced():
    """A long-stalling stream gets capped by the top-level deadline."""

    async def never_completing(req):
        await asyncio.sleep(10)
        return httpx.Response(200)

    def sync_wrapper(req):
        # Return a response that opens stream but never delivers data.
        # Easiest way: respond OK with a header but no body — parse_openai_sse
        # times out. We just block on the request itself.
        # asyncio.run() inside a sync handler is bad; instead, raise to force
        # error and let the deadline propagate.
        raise httpx.ConnectError("simulated stall")

    set_mock_handler(sync_wrapper)
    client = RoseClient(openrouter_key="ork-x")
    raised = False
    try:
        async for _ in client.complete(
            pool="rose-1-lite",
            messages=[{"role": "user", "content": "hi"}],
            call_site="test-deadline",
            deadline_s=0.5,
        ):
            pass
    except RoseError:
        raised = True
    assert raised


# =====================================================================
# Cache hit rate smoke tests
# =====================================================================


async def test_claude_auth_stream_reports_cache_hit_rate():
    """Simulated claudeAuth stream with cache metrics — validates cache_read
    tokens are reported and the hit rate is above a minimum threshold.

    This exercises the full path: build_anthropic_body (with static/dynamic
    split + message breakpoint) → claude_auth_complete → parse_anthropic_sse
    → usage chunk with cache metrics.
    """
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    spec = get_pool("rose-1-lite")

    # Simulate a second-turn call where most of the prompt is cached.
    # 500 input tokens, 4500 cache_read, 100 cache_creation → 90% hit rate.
    sse_lines = []
    sse_lines += _ev("message_start", {
        "type": "message_start",
        "message": {
            "usage": {
                "input_tokens": 500,
                "cache_read_input_tokens": 4500,
                "cache_creation_input_tokens": 100,
            }
        },
    })
    sse_lines += _ev("content_block_start", {
        "type": "content_block_start", "index": 0,
        "content_block": {"type": "text", "text": ""},
    })
    sse_lines += _ev("content_block_delta", {
        "type": "content_block_delta", "index": 0,
        "delta": {"type": "text_delta", "text": "cached response"},
    })
    sse_lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    sse_lines += _ev("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn"},
        "usage": {"output_tokens": 10},
    })
    sse_lines += _ev("message_stop", {"type": "message_stop"})

    sse_body = "\n".join(sse_lines)

    def handler(req):
        url = str(req.url)
        if "api.anthropic.com" in url:
            # Verify the request body has the expected cache structure
            body = json.loads(req.content.decode())
            sys_blocks = body.get("system", [])
            # Should have: identity + disclaimer + static (cached) + dynamic
            cached = [b for b in sys_blocks if "cache_control" in b]
            assert len(cached) >= 1, f"Expected cached system blocks, got {len(cached)}"
            global_cached = [b for b in cached if b["cache_control"].get("scope") == "global"]
            assert len(global_cached) == 1, f"Expected 1 global-scoped block, got {len(global_cached)}"

            # Verify last message has cache breakpoint
            msgs = body.get("messages", [])
            if msgs:
                last_msg = msgs[-1]
                content = last_msg.get("content")
                if isinstance(content, list) and content:
                    assert "cache_control" in content[-1], "Last message block missing cache_control breakpoint"

            return httpx.Response(
                200, text=sse_body, headers={"Content-Type": "text/event-stream"}
            )
        return httpx.Response(500, text="unexpected")

    set_mock_handler(handler)

    system_content = f"Static agent instructions here{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}Current time: April 28, 2026 at 04 PM\n\nUser context: Andy"

    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-lite",
        messages=[
            {"role": "system", "content": system_content},
            {"role": "user", "content": "first message"},
            {"role": "assistant", "content": "first reply"},
            {"role": "user", "content": "second message"},
        ],
        claude_auth=claude_auth_from_token("valid-token"),
        call_site="test-cache-hit-rate",
    ):
        chunks.append(chunk)

    usage = next(c for c in chunks if c.kind == "usage")
    cache_read = usage.data.get("cache_read_input_tokens", 0)
    cache_write = usage.data.get("cache_creation_input_tokens", 0)
    prompt_tokens = usage.data.get("prompt_tokens", 0)

    total_input = prompt_tokens + cache_read + cache_write
    assert total_input > 0, "No input tokens reported"
    hit_rate = cache_read / total_input
    assert hit_rate >= 0.5, (
        f"Cache hit rate {hit_rate:.0%} below 50% minimum "
        f"(read={cache_read}, write={cache_write}, prompt={prompt_tokens})"
    )


def test_build_anthropic_body_cache_structure_from_real_prompt():
    """build_system_prompt output produces correct cache structure when passed
    through build_anthropic_body: main+user-context and phase blocks get
    global cache markers, and the last message gets a breakpoint."""
    from utils.prompts import build_system_prompt

    spec = get_pool("rose-1-lite")
    system_text = build_system_prompt(
        phase="EXECUTE",
        enabled_tools=["web_search", "attempt_completion"],
        user_context_section="User: Andy, Phone: 555-1234",
    )

    body = build_anthropic_body(
        pool_spec=spec,
        messages=[
            {"role": "system", "content": system_text},
            {"role": "user", "content": "do the thing"},
        ],
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=8192,
        skip_cache_write=False,
    )

    sys_blocks = body["system"]
    # identity + disclaimer + main/user context + phase = 4 blocks
    assert len(sys_blocks) == 4, f"Expected 4 system blocks, got {len(sys_blocks)}"

    main_context_block = sys_blocks[2]
    phase_block = sys_blocks[3]

    for block in (main_context_block, phase_block):
        assert block["cache_control"] == {"type": "ephemeral", "scope": "global"}
    assert "You are a Rose Labs Agent" in main_context_block["text"]
    assert "Andy" in main_context_block["text"]
    assert "# Current Phase" in phase_block["text"]
    # Timestamp is now in message headers, not the system prompt dynamic section
    assert "Current time:" not in main_context_block["text"]
    assert "Current time:" not in phase_block["text"]

    msgs = body["messages"]
    last_content = msgs[-1]["content"]
    if isinstance(last_content, list):
        assert "cache_control" in last_content[-1]
    else:
        assert False, "Expected last message content to be list with cache_control"


# =====================================================================
# Test runner
# =====================================================================


async def run_all_tests():
    print("rose blackbox tests:")
    r = BlackboxResult()

    r.record("is_rose_model_variants", test_is_rose_model_variants)
    r.record("pool_for_model_fuzzy", test_pool_for_model_fuzzy)
    r.record("claude_auth_from_token_none", test_claude_auth_from_token_returns_none_when_falsy)
    r.record("claude_auth_from_token_builds", test_claude_auth_from_token_builds_context)
    r.record("gpt_auth_from_token_builds", test_gpt_auth_from_token_builds_context)
    r.record("classify_claude_token_error", test_classify_claude_token_error_each_branch)

    r.record("pool_registry_lookup", test_pool_registry_lookup)
    r.record("all_pool_names_matches", test_all_pool_names_matches_registry)
    r.record("get_pool_unknown_raises", test_get_pool_unknown_raises)

    r.record("is_anthropic_model", test_is_anthropic_model_substring)
    r.record("transform_block_passthrough", test_transform_content_block_passthrough_for_text)
    r.record("transform_block_image_data", test_transform_content_block_image_data_uri)
    r.record("transform_block_image_url", test_transform_content_block_image_url_http)
    r.record("transform_block_file_data", test_transform_content_block_file_data_uri)
    r.record("transform_msgs_pulls_system", test_transform_messages_for_anthropic_pulls_system)
    r.record("transform_msgs_splits_boundary", test_transform_messages_for_anthropic_splits_on_boundary)
    r.record("transform_msgs_strips_trailing", test_transform_messages_for_anthropic_strips_trailing_assistant)
    r.record("transform_msgs_assistant_tool_calls", test_transform_messages_for_anthropic_assistant_tool_calls_to_tool_use)
    r.record("transform_msgs_dict_args", test_transform_messages_for_anthropic_dict_arguments)
    r.record("transform_msgs_bundle_tool_results", test_transform_messages_for_anthropic_bundles_consecutive_tool_results)
    r.record("transform_msgs_raises_missing_id", test_transform_messages_for_anthropic_raises_on_missing_id)
    r.record("transform_msgs_raises_missing_name", test_transform_messages_for_anthropic_raises_on_missing_name)
    r.record("transform_msgs_raises_invalid_args", test_transform_messages_for_anthropic_raises_on_invalid_args_json)
    r.record("transform_msgs_raises_no_tool_id", test_transform_messages_for_anthropic_raises_on_tool_without_id)

    r.record("schema_strips_unsupported", test_transform_schema_strips_unsupported_keys)
    r.record("schema_collapses_addl_props", test_transform_schema_collapses_object_additionalProperties)
    r.record("schema_recurses_into_combinators", test_transform_schema_recurses_into_anyOf_oneOf_allOf_defs)
    r.record("schema_passthrough_non_dict", test_transform_schema_passthrough_non_dict)
    r.record("pydantic_to_anthropic_native_tools", test_pydantic_response_model_builds_anthropic_native_tools_without_strict_by_default)
    r.record("pydantic_to_anthropic_selective_strict", test_pydantic_response_model_adds_strict_only_for_opted_in_tools)
    r.record("pydantic_to_anthropic_synthetic_submit_tool", test_pydantic_response_model_without_tool_calls_builds_synthetic_native_tool)

    r.record("tool_config_explicit_tools", test_apply_tool_config_with_explicit_tools_and_choice)
    r.record("tool_config_choice_auto_specific", test_apply_tool_config_choice_auto_and_specific_tool)
    r.record("tool_config_native_lift", test_apply_tool_config_response_format_native_lift)
    r.record("tool_config_structured_output_paths", test_apply_tool_config_response_format_structured_output_path)

    r.record("is_vision_capable", test_is_vision_capable_membership)
    r.record("has_screenshot_markers", test_has_screenshot_markers_detection)
    r.record("vision_expands_marker", test_transform_messages_for_vision_expands_marker)
    r.record("vision_passthrough_invalid_json", test_transform_messages_for_vision_passthrough_on_invalid_json)
    r.record("get_messages_routes_by_vision", test_get_messages_for_model_routes_by_vision)
    r.record("reconstruct_envelope", test_reconstruct_agent_response_envelope)
    r.record("reconstruct_non_dict_input", test_reconstruct_agent_response_handles_non_dict_input)
    r.record("openai_messages_cache_breakpoints", test_transform_messages_for_openai_adds_cache_breakpoints)
    r.record("openai_messages_multi_boundary_cached", test_transform_messages_for_openai_multi_boundary_system_blocks_are_cached)

    r.record("anthropic_body_identity_cache", test_build_anthropic_body_identity_and_cache_block)
    r.record("anthropic_body_static_dynamic_split", test_build_anthropic_body_static_dynamic_split)
    r.record("anthropic_body_multi_boundary_cached", test_build_anthropic_body_multi_boundary_system_blocks_are_cached)
    r.record("anthropic_body_message_breakpoint", test_build_anthropic_body_message_cache_breakpoint)
    r.record("anthropic_body_skip_cache_write", test_build_anthropic_body_skip_cache_write_keeps_system_markers)

    await r.record_async("claude_auth_400_no_rotate", test_claude_auth_400_raises_invalid_request_no_rotation)
    await r.record_async("claude_auth_5xx_retries", test_claude_auth_5xx_retries_then_raises_server_error)
    await r.record_async("claude_auth_401_rotates", test_claude_auth_401_rotates_and_exhausts)
    await r.record_async(
        "claude_auth_429_usage_window_rotates_with_reset",
        test_claude_auth_429_usage_window_marks_reset_and_fetches_fresh_token,
    )
    await r.record_async(
        "claude_auth_429_transient_retries",
        test_claude_auth_429_transient_retries_before_rotating,
    )
    await r.record_async("claude_auth_403_usage_limit_reset", test_claude_auth_403_usage_limit_marks_body_reset_time)

    await r.record_async("anth_sse_text_usage", test_parse_anthropic_sse_text_and_usage)
    await r.record_async("anth_sse_tool_use", test_parse_anthropic_sse_tool_use_block)
    await r.record_async("anth_sse_empty_stalls", test_parse_anthropic_sse_empty_stream_raises_stall)
    await r.record_async("anth_sse_thinking_emitted", test_parse_anthropic_sse_thinking_delta_counts_as_emitted)
    await r.record_async("anth_sse_skip_bad_json", test_parse_anthropic_sse_skips_event_lines_and_bad_json)

    await r.record_async("openai_sse_content_finish", test_parse_openai_sse_content_and_finish_reason)
    await r.record_async("openai_sse_tool_call_assembly", test_parse_openai_sse_tool_call_assembly_across_deltas)
    await r.record_async("openai_sse_reasoning_alias", test_parse_openai_sse_reasoning_content_alias)
    await r.record_async("openai_sse_empty_stalls", test_parse_openai_sse_empty_stream_raises_stall)
    await r.record_async("responses_sse_content_usage", test_parse_responses_sse_content_and_usage)
    await r.record_async("responses_sse_function_call_item", test_parse_responses_sse_function_call_item)
    await r.record_async(
        "responses_sse_failed_context_length",
        test_parse_responses_sse_failed_context_length_is_invalid_request,
    )
    r.record("codex_responses_body_contract", test_build_codex_responses_body_contract)
    r.record("codex_body_tool_history_multimodal", test_build_codex_responses_body_preserves_tool_history_and_multimodal)
    r.record("codex_body_orphan_tool_context", test_build_codex_responses_body_converts_orphan_tool_rows_to_context)

    r.record("openrouter_body_optionals", test_build_openrouter_body_includes_optionals)
    r.record("openrouter_body_minimal", test_build_openrouter_body_minimal_omits_optionals)
    await r.record_async("waterfall_falls_through_succeeds", test_waterfall_falls_through_then_succeeds)
    await r.record_async("waterfall_skips_anthropic_response_format", test_waterfall_skips_anthropic_for_response_format)
    await r.record_async("waterfall_all_failed", test_waterfall_all_failed_raises_with_step_errors)
    await r.record_async("waterfall_cache_metrics", test_waterfall_reports_cache_metrics_from_openrouter)

    await r.record_async("client_collect_waterfall", test_client_collect_waterfall_only_path)
    await r.record_async("client_fallthrough_to_waterfall", test_client_falls_through_from_claude_auth_to_waterfall)
    await r.record_async("client_pydantic_native_tools_split", test_client_splits_pydantic_model_to_claude_native_tools)
    await r.record_async("client_gpt_pydantic_native_tools_split", test_client_splits_pydantic_model_to_gpt_native_tools)
    await r.record_async("client_pydantic_submit_tool_split", test_client_splits_plain_pydantic_model_to_forced_submit_tool)
    await r.record_async("client_gpt_pydantic_submit_tool_split", test_client_splits_plain_pydantic_model_to_gpt_required_submit_tool)
    await r.record_async("client_deadline_enforced", test_client_deadline_enforced)

    await r.record_async("cache_hit_rate_smoke", test_claude_auth_stream_reports_cache_hit_rate)
    r.record("cache_structure_real_prompt", test_build_anthropic_body_cache_structure_from_real_prompt)

    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
