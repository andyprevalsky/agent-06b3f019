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

import argparse
import asyncio
import json
import os
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import AsyncMock, patch


async def test_rose_local_loopback_and_no_fallback():
    from providers.rose.local import local_config

    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            requests.append((self.path, json.loads(self.rfile.read(length))))
            payload = (
                'data: {"choices":[{"index":0,"delta":{"content":"local ok"},"finish_reason":null}]}\n\n'
                'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
                '"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n'
                'data: [DONE]\n\n'
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with patch.dict(os.environ, {
            "ROSE_LOCAL_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
            "ROSE_LOCAL_MODEL": "test-local-model",
        }):
            with patch("providers.rose.client.waterfall_complete", side_effect=AssertionError("remote fallback")):
                chunks = [chunk async for chunk in RoseClient().complete(
                    pool="rose-local", messages=[{"role": "user", "content": "hello"}], dump_context=False,
                )]
            assert requests[0][0] == "/v1/chat/completions"
            assert requests[0][1]["model"] == "test-local-model"
            assert requests[0][1]["messages"][-1]["content"] == "hello"
            assert next(chunk.data["actual_model"] for chunk in chunks if chunk.kind == "metadata") == "local/test-local-model"
            assert "".join(chunk.data["text"] for chunk in chunks if chunk.kind == "content") == "local ok"
            assert any(chunk.kind == "done" for chunk in chunks)
        with patch.dict(os.environ, {"ROSE_LOCAL_BASE_URL": "https://api.openrouter.ai/v1", "ROSE_LOCAL_MODEL": "x"}):
            try:
                local_config()
            except RoseError:
                pass
            else:
                raise AssertionError("Rose Local accepted a remote endpoint")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

from _test_utils import BlackboxResult, set_mock_handler, teardown_mock
from _rose_stream_progress_fixture import single_step_waterfall

import httpx

from providers.rose import (
    ClaudeAuthContext,
    GptAuthContext,
    POOL_REGISTRY,
    PoolSpec,
    RoseAllFailed,
    RoseAuthError,
    RoseClient,
    RoseDeadlineError,
    RoseError,
    RoseInvalidRequest,
    RoseRefusalError,
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
from providers.rose.client import (
    _cache_input_accounting,
    _messages_without_internal_system_boundaries,
    _normalize_usage_input_tokens,
)
from providers.rose.gpt_auth import build_codex_responses_body, gpt_auth_complete
from providers.rose.pricing import get_model_pricing
from providers.rose.schema import (
    build_anthropic_tools_from_response_model,
    build_openai_response_format,
)
from providers.rose.transport import (
    ANTHROPIC_FAST_MODE_BETA,
    OPENAI_RESPONSES_API_URL,
    _codex_extra_headers_from_body,
    _with_fast_mode_beta,
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

# Speed-pool tests opt back in with patch.dict. A live CEREBRAS_API_KEY would
# make every flash complete() hit Cerebras before OpenRouter.
_LIVE_CEREBRAS_API_KEY = os.environ.pop("CEREBRAS_API_KEY", "")


# =====================================================================
# legacy_adapter
# =====================================================================


def test_is_rose_model_variants():
    assert is_rose_model("rose")
    assert is_rose_model("rose-ultra")
    assert is_rose_model("rose-fast")
    assert is_rose_model("rose-labs/rose-1-flash")
    assert is_rose_model("rose-labs/rose-1-ultra")
    assert is_rose_model("rose-labs/rose-1-browser-use")
    assert is_rose_model("ROSE-LABS/ROSE-1-LITE")  # case-insensitive
    assert not is_rose_model("anthropic/claude-sonnet-4.5")
    assert not is_rose_model(None)
    assert not is_rose_model("")


def test_pool_for_model_fuzzy():
    assert pool_for_model("rose-labs/rose-1-mini") == "rose-1-mini"
    assert pool_for_model("rose-labs/rose-1-flash") == "rose-1-flash"
    assert pool_for_model("rose-labs/rose-1-lite") == "rose-1-flash"
    assert pool_for_model("rose-1-lite") == "rose-1-flash"
    assert pool_for_model("rose-labs/rose-1-ultra") == "rose-1-ultra"
    assert pool_for_model("rose-labs/rose-1-browser-use") == "rose-1-browser-use"
    assert pool_for_model("rose") == "rose-1-flash"
    assert pool_for_model("rose-flash") == "rose-1-flash"
    assert pool_for_model("rose-fast") == "rose-1-flash"
    assert pool_for_model("rose-mini") == "rose-1-mini"
    assert pool_for_model("rose-ultra") == "rose-1-ultra"
    # Fuzzy fallback for unknown rose-labs/* strings
    assert pool_for_model("rose-labs/something-ultra-new") == "rose-1-ultra"
    assert pool_for_model("rose-labs/something-mini") == "rose-1-mini"
    assert pool_for_model("rose-labs/new-browser-use") == "rose-1-browser-use"
    assert pool_for_model("rose-labs/rose-1-oss") == "rose-1-oss"
    assert pool_for_model("rose-labs/something-oss") == "rose-1-oss"
    assert pool_for_model("rose-labs/something-else") == "rose-1-flash"
    assert pool_for_model("openai/gpt-4") is None
    assert pool_for_model("") is None


def test_oss_pool_is_open_weights_only():
    """rose-1-oss must serve ONLY its open-weights waterfall.

    The pool exists so a task whose prompt the frontier primaries decline can be
    pinned to an open-source model. If a direct-token (claudeAuth / gptAuth)
    route could serve it, that pin would silently resolve back to the very model
    that declined, and the pool would be decorative.
    """
    oss = POOL_REGISTRY["rose-1-oss"]
    assert oss.direct_auth_enabled is False
    assert oss.waterfall == ("moonshotai/kimi-k3",)
    assert not any("anthropic/" in m or "openai/" in m for m in oss.waterfall)
    # Its funded Azure fallback is open-weights too, never the inert gpt_auth_model.
    from providers.rose.pools import foundry_model

    assert oss.foundry_enabled and foundry_model(oss) == "DeepSeek-V3.2"
    assert foundry_model(oss) != oss.gpt_auth_model
    # Speed pools skip Claude/GPT auth so Cerebras Qwen is the real primary.
    # The explicit WMH runner pins its exact GPT-6.1 Sol waterfall model.
    auth_skipped = {"rose-1-oss", "rose-1-flash", "rose-1-browser-use", "rose-wmh-gpt61", "rose-local"}
    for name, spec in POOL_REGISTRY.items():
        if name in auth_skipped:
            assert spec.direct_auth_enabled is False, f"{name} should skip direct auth"
        else:
            assert spec.direct_auth_enabled is True, f"{name} lost direct auth"

    # EVERY proprietary route must consult the flag -- not just the OAuth ones.
    # Gating only OAuth left the funded ANTHROPIC_API_KEY / OPENAI_API_KEY
    # routes reachable, so a pinned run could still be served by a proprietary
    # model while the pool claimed otherwise.
    client_src = (Path(__file__).resolve().parents[2] / "providers" / "rose" / "client.py").read_text()
    for marker in (
        'openai_api_key = _openai_api_key() if pool_spec.direct_auth_enabled else ""',
        "pool_spec.direct_auth_enabled",
    ):
        assert marker in client_src, f"missing direct_auth_enabled gate: {marker}"
    # The Anthropic funded-key branch must be gated too.
    anthropic_branch = client_src.split("anthropic_api_key = (load_config()")[1][:400]
    assert "pool_spec.direct_auth_enabled" in anthropic_branch, (
        "ANTHROPIC_API_KEY route is not gated by direct_auth_enabled"
    )


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
    assert classify_claude_token_error(RoseRefusalError("r")) == "refusal"
    assert classify_claude_token_error(RoseServerError("e")) == "server_error"
    # Unknown subclass falls back to server_error
    assert classify_claude_token_error(RoseError("z")) == "server_error"
    assert classify_gpt_token_error(RoseRateLimitError("b")) == "rate_limit"


# =====================================================================
# pools
# =====================================================================


def test_pool_registry_lookup():
    mini = get_pool("rose-1-mini")
    flash = get_pool("rose-1-flash")
    ultra = get_pool("rose-1-ultra")
    browser_use = get_pool("rose-1-browser-use")
    assert mini.gpt_auth_model == "gpt-5.6-luna"
    assert mini.waterfall == (
        "anthropic/claude-haiku-4.5",
        "z-ai/glm-5.3-flash",
    )
    assert mini.waterfall_reasoning_effort == "low"
    assert flash.name == "rose-1-flash"
    assert flash.claude_auth_model.startswith("claude-")
    assert flash.gpt_auth_model == "gpt-5.6-luna"
    assert flash.waterfall == ("qwen/qwen3.8-27b", "google/gemini-3.8-flash")
    assert flash.waterfall_reasoning_effort == "low"
    assert flash.direct_auth_enabled is False
    assert flash.cerebras_model == "qwen-3.8-27b"
    assert flash.cerebras_reasoning_effort == "high"
    assert flash.cerebras_reasoning_effort in {"none", "low", "medium", "high"}
    assert ultra.name == "rose-1-ultra"
    assert ultra.claude_auth_model == "claude-opus-5-5"
    assert ultra.gpt_auth_model == "gpt-6-sol"
    # Opus 5.5 is claudeAuth (index 58, $4/$20). Paid waterfall is gpt-6-sol
    # (index 48, $2/$10) then kimi-k3. Fable is not on the paid path.
    assert ultra.waterfall == ("openai/gpt-6-sol", "moonshotai/kimi-k3")
    assert "anthropic/claude-fable-5.1" not in ultra.waterfall
    assert browser_use.claude_auth_model == "claude-sonnet-5"
    assert browser_use.gpt_auth_model == "gpt-5.6-luna"
    assert browser_use.waterfall == ("qwen/qwen3.8-27b", "google/gemini-3.8-flash")
    assert browser_use.waterfall_reasoning_effort == "low"
    assert browser_use.direct_auth_enabled is False
    assert browser_use.cerebras_model == "qwen-3.8-27b"
    assert browser_use.cerebras_reasoning_effort == "high"
    assert ultra.waterfall_reasoning_effort is None
    assert "anthropic/claude-fable-5.1" not in browser_use.waterfall
    assert not any(m.startswith("anthropic/") for m in ultra.waterfall)
    assert not any(m.startswith("anthropic/") for m in browser_use.waterfall)
    assert flash.waterfall != ultra.waterfall
    assert get_model_pricing("qwen-3.8-27b") == {
        "input_cents_per_1k": 0.099,
        "output_cents_per_1k": 0.149,
    }
    assert get_model_pricing("qwen/qwen3.8-27b") == {
        "input_cents_per_1k": 0.015,
        "output_cents_per_1k": 0.08,
    }


def test_cerebras_native_tools_enforce_representable_shapes():
    """The actual request builder must enforce native types without mutating schemas."""
    from copy import deepcopy
    from typing import Literal

    from pydantic import BaseModel, Field, ValidationError
    from providers.rose.cerebras import build_cerebras_body
    from utils.tool_schemas import create_agent_action_model

    class TypedTool(BaseModel):
        tool: Literal["typed_lookup"]
        labels: list[str] = Field(min_length=1, max_length=3)
        count: int = Field(ge=1, le=5)
        note: str | None = Field(default=None, min_length=2, max_length=12)

    model = create_agent_action_model(["typed_lookup"], tool_registry={"typed_lookup": TypedTool})
    tools = build_anthropic_tools_from_response_model(model)
    original = deepcopy(tools)
    body = build_cerebras_body(
        model="qwen-3.8-27b",
        messages=[],
        tools=tools,
        tool_choice="any",
        response_format=None,
        temperature=1,
        max_tokens=128,
        effort="high",
    )
    function = body["tools"][0]["function"]
    assert function.get("strict") is True, "Representable native types lack constrained decoding"
    params = function["parameters"]
    assert params["additionalProperties"] is False
    assert params["properties"]["labels"]["type"] == "array"
    assert params["properties"]["labels"]["items"]["type"] == "string"
    assert "minItems" not in params["properties"]["labels"]
    assert params["properties"]["count"]["minimum"] == 1
    assert params["properties"]["count"]["maximum"] == 5
    assert params["properties"]["note"]["anyOf"] == [{"type": "string"}, {"type": "null"}]
    assert body["tool_choice"] == "required"
    assert "response_format" not in body
    assert tools == original
    for payload in (
        {"tool": "typed_lookup", "labels": '["a"]', "count": 2},
        {"tool": "typed_lookup", "labels": [], "count": 2},
        {"tool": "typed_lookup", "labels": ["a"], "count": 6},
        {"tool": "typed_lookup", "labels": ["a"], "count": 2, "note": "x"},
    ):
        try:
            TypedTool.model_validate(payload)
        except ValidationError:
            pass
        else:
            raise AssertionError("Original local constraints were weakened")
    assert TypedTool.model_validate({"tool": "typed_lookup", "labels": ["a"], "count": 2}).note is None


def test_cerebras_native_tools_keep_incompatible_schemas_visible():
    """Mixed toolsets must never close maps, invent types, or mutate fallback schemas."""
    from copy import deepcopy

    from providers.rose.cerebras import build_cerebras_body

    schemas = [
        {
            "type": "object",
            "properties": {"values": {"type": "object", "additionalProperties": {"type": "string"}}},
            "additionalProperties": False,
        },
        {"type": "object", "properties": {"anything": {}}, "additionalProperties": False},
        {
            "type": "object",
            "properties": {"value": {"oneOf": [{"type": "string"}, {"type": "null"}]}},
            "additionalProperties": False,
        },
        {"type": "object", "properties": {"values": {"type": "array", "items": True}}, "additionalProperties": False},
        {
            "type": "object",
            "properties": {"value": {"$ref": "https://example.invalid/schema"}},
            "additionalProperties": False,
        },
    ]
    schemas.append(
        {
            "type": "object",
            "additionalProperties": False,
            "properties": {"x": {"type": "integer"}},
            "required": ["x", "x"],
        }
    )
    invalid_bounds = [
        {"minimum": "invalid"},
        {"maximum": True},
        {"exclusiveMinimum": float("nan")},
        {"exclusiveMaximum": float("inf")},
        {"multipleOf": 0},
        {"multipleOf": -1},
        {"multipleOf": False},
        {"minimum": 5, "maximum": 4},
        {"minimum": 2, "exclusiveMaximum": 2},
        {"exclusiveMinimum": 2, "maximum": 2},
        {"exclusiveMinimum": 3, "exclusiveMaximum": 2},
    ]
    schemas.extend(
        {"type": "object", "additionalProperties": False, "properties": {"value": {"type": "number", **bounds}}}
        for bounds in invalid_bounds
    )
    # Raw Python-built tool schemas reach this builder without JSON roundtrip.
    # Invalid names must decline strict projection rather than throw TypeError.
    for key in (1, True, None, ("tuple",)):
        schemas.extend(
            [
                {"type": "object", "additionalProperties": False, "properties": {key: {"type": "string"}}},
                {"type": "object", "additionalProperties": False, "properties": {}, key: 1, "unknown": True},
                {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"nested": {"type": "string", key: 1, "unknown": True}},
                },
            ]
        )
    supported = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "pattern": {"type": "string", "pattern": "^a", "format": "email", "minLength": 1},
            "nested": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "value": {"anyOf": [{"type": "number", "minimum": 0}, {"type": "null"}]},
                    "flag": {"type": "boolean"},
                },
                "required": ["flag"],
            },
        },
        "required": ["pattern"],
    }
    tools = [{"name": f"generic_{i}", "input_schema": schema} for i, schema in enumerate([supported, *schemas])]
    original = deepcopy(tools)
    body = build_cerebras_body(
        model="qwen-3.8-27b",
        messages=[],
        tools=tools,
        tool_choice="any",
        response_format=None,
        temperature=None,
        max_tokens=None,
        effort=None,
    )
    functions = [tool["function"] for tool in body["tools"]]
    for function, schema in zip(functions, [supported, *schemas], strict=True):
        assert function["strict"] is False
        assert function["parameters"] == schema
    # Test each incompatible schema alone too: a different open-map tool must
    # not conceal a numeric/required validation regression in the mixed set.
    for tool in tools[1:]:
        isolated = build_cerebras_body(
            model="qwen-3.8-27b",
            messages=[],
            tools=[tool],
            tool_choice="any",
            response_format=None,
            temperature=None,
            max_tokens=None,
            effort=None,
        )
        assert isolated["tools"][0]["function"]["strict"] is False
        assert isolated["tools"][0]["function"]["parameters"] == tool["input_schema"]
    supported_body = build_cerebras_body(
        model="qwen-3.8-27b",
        messages=[],
        tools=tools[:1],
        tool_choice="any",
        response_format=None,
        temperature=None,
        max_tokens=None,
        effort=None,
    )
    function = supported_body["tools"][0]["function"]
    assert function["strict"] is True
    assert function["parameters"]["properties"]["pattern"] == {"type": "string"}
    assert function["parameters"]["required"] == ["pattern"]
    assert function["parameters"]["properties"]["nested"] == supported["properties"]["nested"]
    assert tools == original


async def test_cerebras_raw_schema_keys_reach_native_client():
    """Public complete accepts raw nested dictionaries; canonical models remain valid."""
    from copy import deepcopy

    tools = [
        {
            "name": "raw_lookup",
            "input_schema": {"type": "object", "properties": {1: {"type": "string"}}, "additionalProperties": False},
        }
    ]
    original = deepcopy(tools)
    requests = []

    def handler(request):
        assert request.url.host == "api.cerebras.ai", "No route fallthrough is expected"
        body = json.loads(request.content)
        requests.append(body)
        assert body["tools"][0]["function"]["strict"] is False
        # Ordinary HTTP JSON serialization already stringifies integer keys;
        # the adapter must preserve the Python caller input, not normalize it.
        assert body["tools"][0]["function"]["parameters"] == json.loads(json.dumps(original[0]["input_schema"]))
        return httpx.Response(
            200,
            text="\n".join(_openai_sse([{"choices": [{"delta": {"content": "native"}, "finish_reason": "stop"}]}])),
            headers={"Content-Type": "text/event-stream"},
        )

    set_mock_handler(handler)
    with patch.dict(os.environ, {"CEREBRAS_API_KEY": "offline-key-shape", "ROSE_FAST_CACHE_MODE": "off"}):
        chunks = await _drain(
            RoseClient(openrouter_key="offline-unused").complete(
                pool="rose-1-flash",
                messages=[{"role": "user", "content": "lookup"}],
                tools=tools,
            )
        )
    assert len(requests) == 1
    assert any(chunk.kind == "content" and chunk.data.get("text") == "native" for chunk in chunks)
    assert tools == original


async def test_cerebras_mixed_toolset_uses_valid_request_contract():
    """Replay the actual Cerebras 400 contract through builder and transport."""
    from providers.rose.cerebras import build_cerebras_body
    from providers.rose.transport import get_error_body, post_cerebras_stream

    tools = [
        {
            "name": "typed",
            "input_schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {"labels": {"type": "array", "items": {"type": "string"}}},
            },
        },
        {
            "name": "open_map",
            "input_schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {"filters": {"type": "object", "additionalProperties": {"type": "string"}}},
            },
        },
    ]
    captured_error = {
        "message": "Tools with mixed values for 'strict' are not allowed. Please set all tools to 'strict: true' or 'strict: false'",
        "type": "invalid_request_error",
        "param": "tools",
        "code": "wrong_api_format",
        "id": "",
    }

    def handler(request):
        body = json.loads(request.content)
        assert [tool["function"]["name"] for tool in body["tools"]] == ["typed", "open_map"]
        if len({tool["function"]["strict"] for tool in body["tools"]}) > 1:
            return httpx.Response(400, json=captured_error)
        assert all(tool["function"]["strict"] is False for tool in body["tools"])
        assert [tool["function"]["parameters"] for tool in body["tools"]] == [tool["input_schema"] for tool in tools]
        return httpx.Response(200, text="data: [DONE]\n", headers={"content-type": "text/event-stream"})

    set_mock_handler(handler)
    body = build_cerebras_body(
        model="qwen-3.8-27b",
        messages=[],
        tools=tools,
        tool_choice="any",
        response_format=None,
        temperature=None,
        max_tokens=128,
        effort=None,
    )
    async with post_cerebras_stream(
        body=body, cerebras_key="offline-placeholder", request_id="captured-mixed-contract"
    ) as response:
        assert response.status_code == 200, get_error_body(response)


async def test_cerebras_strict_native_response_retains_parser_retry():
    """Real HTTP builder + native stream + structured parser still reject captured bad types."""
    from typing import Literal

    from helpers.llm import call_llm_structured_streaming
    from pydantic import BaseModel, Field
    from utils.tool_schemas import create_agent_action_model

    class GenericTool(BaseModel):
        tool: Literal["generic_lookup"]
        labels: list[str] = Field(min_length=1)
        count: int = Field(ge=1, le=5)

    model = create_agent_action_model(["generic_lookup"], tool_registry={"generic_lookup": GenericTool})
    requests = []
    corrected = False

    def handler(request):
        if request.url.host not in {"api.cerebras.ai", "openrouter.ai"}:
            return httpx.Response(200, json={})
        body = json.loads(request.content)
        requests.append(body)
        function = body["tools"][0]["function"]
        assert function["name"] == "generic_lookup"
        if request.url.host == "api.cerebras.ai":
            assert function["strict"] is True
        assert function["parameters"]["properties"]["labels"]["type"] == "array"
        assert body["model"] == ("qwen-3.8-27b" if request.url.host == "api.cerebras.ai" else "google/gemini-3.8-flash")
        assert body["tool_choice"] == "required"
        assert "response_format" not in body
        # Exact observed malformed encoding: a JSON array encoded as a string.
        arguments = {"labels": ["Software Engineer"] if corrected else '["Software Engineer"]', "count": 5}
        payloads = [
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "captured-local",
                                    "type": "function",
                                    "function": {"name": "generic_lookup", "arguments": json.dumps(arguments)},
                                }
                            ]
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
            {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
        ]
        return httpx.Response(200, text="\n".join(_openai_sse(payloads)), headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    async def on_chunk(*args):
        pass

    with patch.dict(os.environ, {"CEREBRAS_API_KEY": "offline-test-placeholder", "ROSE_FAST_CACHE_MODE": "off"}):
        try:
            await call_llm_structured_streaming(
                messages=[{"role": "user", "content": "offline replay"}],
                model="rose-labs/rose-1-flash",
                temperature=1,
                max_tokens=128,
                response_model=model,
                on_chunk=on_chunk,
                call_site="test",
                skip_cache_write=True,
            )
        except Exception as exc:
            assert type(exc).__name__ == "LLMStructuredOutputError"
            assert "valid list" in str(exc)
        else:
            raise AssertionError("Malformed native arrays were silently coerced")
        assert len(requests) == 3
        assert [body["model"] for body in requests] == ["qwen-3.8-27b", "qwen-3.8-27b", "google/gemini-3.8-flash"]
        assert all(
            any(row.get("role") == "tool" and "valid list" in str(row.get("content")) for row in body["messages"])
            for body in requests[1:]
        )
        corrected = True
        response, _, _ = await call_llm_structured_streaming(
            messages=[{"role": "user", "content": "offline replay"}],
            model="rose-labs/rose-1-flash",
            temperature=1,
            max_tokens=128,
            response_model=model,
            on_chunk=on_chunk,
            call_site="test",
            skip_cache_write=True,
        )
        assert len(requests) == 4
        assert response.tool_calls[0].labels == ["Software Engineer"]
        assert response.tool_calls[0].count == 5


async def test_cerebras_tool_call_at_output_limit_is_escalated_not_accepted():
    """A Cerebras reply that spent its whole output limit is a cut-off, whatever finish it reports.

    Regression for explore-agent-mid-run-message b2726cac: the explore's final
    qwen-3.8-27b call used completion_tokens == max_completion_tokens (8192),
    mostly on reasoning, yet Cerebras reported finish_reason="tool_calls" with a
    strict-grammar-closed attempt_completion_with_result whose table stopped
    mid-sentence. The cut-off result became the explore's FINAL_ANSWER.
    """
    from typing import Literal

    from helpers.llm import call_llm_structured_streaming
    from pydantic import BaseModel
    from utils.tool_schemas import create_agent_action_model

    class FinishTool(BaseModel):
        tool: Literal["attempt_completion_with_result"]
        result: str

    model = create_agent_action_model(
        ["attempt_completion_with_result"], tool_registry={"attempt_completion_with_result": FinishTool}
    )
    requests = []
    truncated = "| 7 | Prime Intellect | Series A | 2026-07-08 | announced a"
    complete = (
        truncated + " $130M Series A led by Founders Fund. |\n| 8 | Seltz | Seed | 2026-06-24 | led by B Capital. |"
    )

    def handler(request):
        if request.url.host not in {"api.cerebras.ai", "openrouter.ai"}:
            return httpx.Response(200, json={})
        body = json.loads(request.content)
        requests.append(body)
        limit = body.get("max_completion_tokens") or body.get("max_tokens")
        first = len(requests) == 1
        payloads = [
            {"choices": [{"delta": {"reasoning": "checking every lead investor"}, "finish_reason": None}]},
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": f"captured-{len(requests)}",
                                    "type": "function",
                                    "function": {
                                        "name": "attempt_completion_with_result",
                                        "arguments": json.dumps({"result": truncated if first else complete}),
                                    },
                                }
                            ]
                        },
                        # Exact observed provider label at the limit.
                        "finish_reason": "tool_calls",
                    }
                ]
            },
            {
                "usage": {
                    "prompt_tokens": 14330,
                    "completion_tokens": limit if first else 9000,
                    "total_tokens": 14330 + (limit if first else 9000),
                }
            },
        ]
        return httpx.Response(200, text="\n".join(_openai_sse(payloads)), headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)

    async def on_chunk(*args):
        pass

    with patch.dict(os.environ, {"CEREBRAS_API_KEY": "offline-test-placeholder", "ROSE_FAST_CACHE_MODE": "off"}):
        response, usage, _ = await call_llm_structured_streaming(
            messages=[{"role": "user", "content": "offline replay"}],
            model="rose-labs/rose-1-flash",
            temperature=1,
            max_tokens=8192,
            response_model=model,
            on_chunk=on_chunk,
            call_site="explore_agent",
            skip_cache_write=True,
        )

    assert requests[0]["max_completion_tokens"] == 8192
    assert len(requests) == 2, "a reply that used the whole output limit must be retried with room to finish"
    assert requests[1]["max_completion_tokens"] > 8192
    assert response.tool_calls[0].result == complete


def test_build_cerebras_body_strips_cache_control():
    """Cerebras 400s Anthropic/OpenRouter cache_control on system parts.

    Live hop 2026-09-28: qwen-3.8-27b rejected
    ``messages.0.system.content.list[...].text.cache_control`` as unsupported
    and fell through to OpenRouter. The body must keep text/image parts and
    drop every cache_control key.
    """
    from providers.rose.cerebras import build_cerebras_body

    body = build_cerebras_body(
        model="qwen-3.8-27b",
        messages=[
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": "you are helpful",
                        "cache_control": {"type": "ephemeral"},
                    },
                    {"type": "text", "text": "phase rules"},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "look", "cache_control": {"type": "ephemeral"}},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/png;base64,aaa"},
                    },
                ],
            },
        ],
        tools=None,
        tool_choice=None,
        response_format=None,
        temperature=None,
        max_tokens=None,
        effort="high",
    )
    dumped = json.dumps(body)
    assert "cache_control" not in dumped
    assert body["model"] == "qwen-3.8-27b"
    assert body["reasoning_effort"] == "high"
    system = body["messages"][0]["content"]
    assert isinstance(system, list)
    assert system[0]["type"] == "text"
    assert system[0]["text"] == "you are helpful"
    user = body["messages"][1]["content"]
    assert any(part.get("type") == "image_url" for part in user)


def test_every_waterfall_model_is_vision_capable():
    """Every pool waterfall model must be in VISION_MODELS.

    `transform_messages_for_vision` only runs when `is_vision_capable(model)`
    is True; a waterfall model missing from the allowlist SILENTLY DROPS the
    screenshot rather than raising, so a browser agent would fly blind on that
    fallback layer with no error to trace. This invariant caught
    moonshotai/kimi-k3, google/gemini-3.6-flash and google/gemini-3-flash-preview
    all missing while already sitting in live waterfalls.
    """
    from providers.rose.transforms import VISION_MODELS

    missing = [
        (name, model) for name, spec in POOL_REGISTRY.items() for model in spec.waterfall if model not in VISION_MODELS
    ]
    assert missing == [], f"waterfall models absent from VISION_MODELS: {missing}"


def test_every_browser_route_model_sees_images():
    """Browser agents run on their spawning agent's pool, so every route that can
    serve a screenshot must see it. Foundry alone may be text-only: the client
    skips it for image requests (test_text_only_foundry_skipped_for_image_requests).
    """
    from providers.rose.pools import foundry_model
    from providers.rose.transforms import route_model_accepts_images

    blind = []
    for name, spec in POOL_REGISTRY.items():
        routes = [*spec.waterfall, *([spec.cerebras_model] if spec.cerebras_model else [])]
        if spec.direct_auth_enabled:
            routes += [spec.claude_auth_model, spec.gpt_auth_model]
        blind += [(name, model) for model in routes if not route_model_accepts_images(model)]
    assert blind == [], f"image-serving routes without vision: {blind}"
    # Bare direct-route ids resolve onto their OpenRouter vision entries.
    assert route_model_accepts_images("claude-opus-5-5")
    assert route_model_accepts_images("gpt-6-sol")
    assert not route_model_accepts_images(foundry_model(POOL_REGISTRY["rose-1-oss"]))


def test_all_pool_names_matches_registry():
    names = set(all_pool_names())
    assert names == set(POOL_REGISTRY.keys())
    assert "rose-1-flash" in names
    assert "rose-1-ultra" in names


def test_get_pool_unknown_raises():
    raised = False
    try:
        get_pool("rose-nonexistent")
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
    static_sys, dynamic_sys, msgs = transform_messages_for_anthropic(
        [
            {"role": "system", "content": "be brief"},
            {"role": "system", "content": "and friendly"},
            {"role": "user", "content": "hi"},
        ]
    )
    assert static_sys == "be brief\n\nand friendly"
    assert dynamic_sys is None
    assert len(msgs) == 1
    assert msgs[0]["role"] == "user"


def test_transform_messages_for_anthropic_splits_on_boundary():
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    combined = f"static instructions{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}Current time: April 28"
    static_sys, dynamic_sys, msgs = transform_messages_for_anthropic(
        [
            {"role": "system", "content": combined},
            {"role": "user", "content": "hi"},
        ]
    )
    assert static_sys == "static instructions"
    assert dynamic_sys == "Current time: April 28"
    assert len(msgs) == 1


def test_transform_messages_for_anthropic_preserves_repeated_boundaries_for_cache_blocks():
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    combined = (
        f"static instructions{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}Current time: April 28{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}"
    )
    static_sys, dynamic_sys, msgs = transform_messages_for_anthropic(
        [
            {"role": "system", "content": combined},
            {"role": "user", "content": "hi"},
        ]
    )
    assert static_sys == "static instructions"
    assert dynamic_sys == f"Current time: April 28{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}"
    assert "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" not in static_sys
    assert len(msgs) == 1


def test_browser_dump_messages_split_internal_system_boundary():
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    messages = [
        {
            "role": "system",
            "content": f"static rules{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic rules{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}",
        },
        {"role": "user", "content": "hello"},
    ]

    cleaned = _messages_without_internal_system_boundaries(messages)

    assert cleaned == [
        {"role": "system", "content": "static rules"},
        {"role": "system", "content": "dynamic rules"},
        {"role": "user", "content": "hello"},
    ]
    assert "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" not in json.dumps(cleaned)


def test_transform_messages_for_anthropic_strips_trailing_assistant():
    _, _, msgs = transform_messages_for_anthropic(
        [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "should be stripped"},
        ]
    )
    assert len(msgs) == 1
    assert msgs[0]["role"] == "user"


def test_transform_messages_for_anthropic_assistant_tool_calls_to_tool_use():
    _, _, msgs = transform_messages_for_anthropic(
        [
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
        ]
    )
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
    _, _, msgs = transform_messages_for_anthropic(
        [
            {
                "role": "assistant",
                "tool_calls": [{"id": "t1", "function": {"name": "f", "arguments": {"a": 1}}}],
            },
        ]
    )
    # Trailing assistant strips; expect empty
    assert msgs == []


def test_transform_messages_for_anthropic_bundles_consecutive_tool_results():
    _, _, msgs = transform_messages_for_anthropic(
        [
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
        ]
    )
    # Two tool_result messages get bundled into one user message
    user_with_results = [
        m
        for m in msgs
        if m["role"] == "user"
        and isinstance(m.get("content"), list)
        and m["content"]
        and m["content"][0].get("type") == "tool_result"
    ]
    assert len(user_with_results) == 1
    assert len(user_with_results[0]["content"]) == 2


def test_build_anthropic_body_does_not_mutate_caller_messages():
    """RoseClient reuses one `messages` list across claudeAuth -> waterfall.

    The Anthropic transform merges consecutive user turns and the cache
    breakpoint rewrites the last message; both must operate on copies, or the
    OpenRouter fallback after a claudeAuth failure sends merged/duplicated
    content carrying Anthropic-only cache_control keys.
    """
    import copy

    from providers.rose.claude_auth import build_anthropic_body
    from providers.rose.pools import get_pool
    from providers.rose.transforms import transform_messages_for_anthropic

    messages = [
        {"role": "system", "content": "static system prompt"},
        {"role": "user", "content": "GOAL: g\n\nPlan this goal into tasks."},
        {"role": "user", "content": "# Reference Plans\n\nblock"},
        {"role": "user", "content": "[TOOL]: earlier output"},
    ]
    snapshot = copy.deepcopy(messages)

    first = transform_messages_for_anthropic(messages)
    assert messages == snapshot, "transform_messages_for_anthropic mutated its input"
    second = transform_messages_for_anthropic(messages)
    assert first == second, "transform must be idempotent on unchanged input"
    assert len(first[2]) == 1 and len(first[2][0]["content"]) == 3, "consecutive user turns merge into one message"

    body = build_anthropic_body(
        pool_spec=get_pool("rose-1-ultra"),
        messages=messages,
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=64,
    )
    assert messages == snapshot, "build_anthropic_body mutated its input"
    assert body["messages"][0]["content"][-1].get("cache_control") == {"type": "ephemeral"}
    body_again = build_anthropic_body(
        pool_spec=get_pool("rose-1-ultra"),
        messages=messages,
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=64,
    )
    assert body_again["messages"] == body["messages"], "rebuilding from the same input must give the same body"


def test_transform_messages_for_anthropic_raises_on_missing_id():
    raised = False
    try:
        transform_messages_for_anthropic(
            [
                {
                    "role": "assistant",
                    "tool_calls": [{"function": {"name": "f", "arguments": "{}"}}],
                },
            ]
        )
    except ValueError as e:
        assert "missing id" in str(e)
        raised = True
    assert raised


def test_transform_messages_for_anthropic_raises_on_missing_name():
    raised = False
    try:
        transform_messages_for_anthropic(
            [
                {
                    "role": "assistant",
                    "tool_calls": [{"id": "t1", "function": {"arguments": "{}"}}],
                },
            ]
        )
    except ValueError as e:
        assert "function.name" in str(e)
        raised = True
    assert raised


def test_transform_messages_for_anthropic_raises_on_invalid_args_json():
    raised = False
    try:
        transform_messages_for_anthropic(
            [
                {
                    "role": "assistant",
                    "tool_calls": [{"id": "t1", "function": {"name": "f", "arguments": "not-json{"}}],
                },
            ]
        )
    except ValueError as e:
        assert "invalid tool_call arguments JSON" in str(e)
        raised = True
    assert raised


def test_transform_messages_for_anthropic_raises_on_tool_without_id():
    raised = False
    try:
        transform_messages_for_anthropic(
            [
                {"role": "tool", "content": "x"},
            ]
        )
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
    assert wait_schema["required"] == ["description"]
    assert wait_schema["properties"]["check_interval_seconds"]["minimum"] == 60
    assert wait_schema["properties"]["check_interval_seconds"]["maximum"] == 86400

    spawn_agent = by_name["spawn_agent"]["input_schema"]
    assert spawn_agent["required"] == ["type", "task_name", "goal"]
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
        tools=[{"function": {"name": "f", "description": "d", "parameters": {"type": "object"}}}],
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
        {
            "name": "web_search",
            "description": "search",
            "input_schema": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
        {
            "name": "finished",
            "description": "finish",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
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


def test_browser_use_uses_auto_tool_choice_not_any():
    """Browser-use MUST use tool_choice='auto', never 'any'/'required'.

    Forcing tool use forbids the model from emitting a reasoning text block before its
    tool call; without that step the model degenerates into reflexively re-picking the
    safe no-op `screenshot` tool every turn (verified: the identical request returns a
    17-token bare `screenshot` under 'any' vs. reasoned `input_text`/`click` under 'auto').
    """
    import inspect
    from providers.rose.client import RoseClient

    src = inspect.getsource(RoseClient.complete_browser_use)
    assert 'tool_choice = "auto"' in src, "browser-use must set tool_choice='auto'"
    assert 'tool_choice = "any"' not in src, "browser-use must NOT force tool_choice='any'"
    assert 'tool_choice = "required"' not in src, "browser-use must NOT force tool_choice='required'"


def test_browser_use_advertises_request_payment_card():
    """request_payment_card must be ADVERTISED to the model, not just registered for parse/dispatch.

    It drifted before: registered in AVAILABLE_ACTIONS + _VALID_ACTIONS + the action dispatcher
    + the autopay prompt, but MISSING from the BROWSER_USE_TOOLS catalog that
    build_browser_use_tools reads. build_browser_use_tools silently skips any action absent from
    the catalog, so the model never saw the tool, couldn't call it, and typed the card refs the
    prompt listed instead of minting a card.
    """
    from browser_tools.schemas import AVAILABLE_ACTIONS
    from providers.rose.browser_use import BROWSER_USE_TOOLS, build_browser_use_tools

    assert "request_payment_card" in BROWSER_USE_TOOLS, "missing from BROWSER_USE_TOOLS catalog"
    tools = build_browser_use_tools(AVAILABLE_ACTIONS)
    rpc = next((t for t in tools if t["name"] == "request_payment_card"), None)
    assert rpc is not None, "request_payment_card not advertised to the model"
    props = rpc["input_schema"]["properties"]
    for p in ("merchant", "line_items", "subtotal_cents", "total_cents"):
        assert p in props, f"request_payment_card schema missing required param {p}"


def test_apply_tool_config_response_format_structured_output_path():
    body = {}
    rf = {"json_schema": {"schema": {"type": "object", "properties": {"x": {"type": "string"}}}}}
    used = apply_anthropic_tool_config(body=body, response_format=rf, use_native_tools=False)
    assert used is False
    assert "output_format" in body
    assert body["output_format"]["type"] == "json_schema"

    body2 = {}
    apply_anthropic_tool_config(body=body2, response_format=rf, use_native_tools=True)
    # use_native_tools=True without anyOf variants → output_config (claudeAuth shape)
    assert "output_config" in body2


# =====================================================================
# transforms — vision + reconstruct
# =====================================================================


def test_is_vision_capable_membership():
    assert is_vision_capable("openai/gpt-4o")
    assert is_vision_capable("openai/gpt-5.6-luna")
    assert is_vision_capable("openai/gpt-5.6-terra")
    assert is_vision_capable("openai/gpt-5.6-sol")
    assert is_vision_capable("openai/gpt-6-luna")
    assert is_vision_capable("anthropic/claude-sonnet-4.5")
    # Every live waterfall layer must be vision-capable.
    assert is_vision_capable("google/gemini-3.5-flash-lite")
    assert is_vision_capable("google/gemini-3.1-flash-lite")
    assert is_vision_capable("google/gemini-3.8-flash")
    assert is_vision_capable("moonshotai/kimi-k3")
    # gpt-oss-20b is genuinely text->text on OpenRouter.
    assert not is_vision_capable("openai/gpt-oss-20b")
    assert not is_vision_capable("rose-labs/rose-1-flash")


def test_has_screenshot_markers_detection():
    assert has_screenshot_markers([{"role": "tool", "content": '{"__screenshot_base64__": "AAA"}'}])
    assert not has_screenshot_markers([{"role": "user", "content": "hi"}])
    assert not has_screenshot_markers([{"role": "tool", "content": "no marker"}])


def test_transform_messages_for_vision_expands_marker():
    out = transform_messages_for_vision(
        [
            {
                "role": "tool",
                "content": json.dumps({"__screenshot_base64__": "ZZZZ", "summary": "ok"}),
            }
        ]
    )
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
    msgs = [{"role": "tool", "content": json.dumps({"__screenshot_base64__": "X"})}]
    # Vision-capable → expanded
    out_vision = get_messages_for_model(msgs, "openai/gpt-4o")
    assert len(out_vision) == 2
    # Non-vision → passthrough (gpt-oss-20b is text->text on OpenRouter)
    out_no = get_messages_for_model(msgs, "openai/gpt-oss-20b")
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
    """Cache-control contract for unscoped OR helper calls: only the first
    system message is marked, never a mutable user tail.
    """
    msgs = [
        {"role": "system", "content": "you are helpful"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "bye"},
    ]
    out = transform_messages_for_openai(msgs)
    # System message gets cache_control breakpoint
    assert out[0]["content"] == [{"type": "text", "text": "you are helpful", "cache_control": {"type": "ephemeral"}}]
    # Last user message must remain UNMARKED (cross-provider safe).
    assert out[-1] == {"role": "user", "content": "bye"}
    # Middle messages are untouched
    assert out[1] == {"role": "user", "content": "hello"}
    assert out[2] == {"role": "assistant", "content": "hi"}
    # Original not mutated
    assert msgs[0]["content"] == "you are helpful"
    assert msgs[1]["content"] == "hello"


def test_transform_messages_for_openai_marks_explicit_cache_conversation_prefix():
    """Explicit-cache providers may include the stable opening turn.

    The opening user goal remains byte-identical across an agent task's later
    turns. The mutable conversation tail must remain outside the breakpoint.
    """
    msgs = [
        {"role": "system", "content": "stable rules"},
        {"role": "user", "content": "stable task goal"},
        {"role": "assistant", "content": "working"},
        {"role": "tool", "content": "dynamic result"},
    ]

    out = transform_messages_for_openai(msgs, cache_opening_user=True)

    assert out[1]["content"] == [{"type": "text", "text": "stable task goal", "cache_control": {"type": "ephemeral"}}]
    assert out[-1] == {"role": "tool", "content": "dynamic result"}
    assert msgs[1]["content"] == "stable task goal", "callers' messages must not be mutated"


def test_transform_messages_for_openai_stamps_tool_call_type():
    """Google (via OpenRouter) rejects an assistant tool_call without OpenAI's
    ``type: "function"`` with 400 "The conversation transcript is malformed",
    which silently demotes the pool to its weakest leg. Producers currently
    hand-write the field; this keeps the invariant enforced, not conventional.
    See back-end sibling: rose.blackbox.ts "OpenAI tool_calls carry the function
    type discriminator".
    """
    msgs = [
        {"role": "system", "content": "s"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "a", "function": {"name": "f", "arguments": "{}"}}],
        },
        {"role": "assistant", "content": "", "tool_calls": [{"id": "b", "name": "g"}]},
        # Responses-dialect calls carry `call_id`; chat-dialect tool results are
        # matched by `id`, so it has to be mapped across.
        {"role": "assistant", "content": "", "tool_calls": [{"call_id": "c", "name": "h"}]},
        {"role": "tool", "tool_call_id": "c", "content": "done"},
    ]
    out = transform_messages_for_openai(msgs)

    nested = out[1]["tool_calls"][0]
    assert nested["type"] == "function", nested
    assert nested["function"]["name"] == "f", nested

    # The flat {id, name} shape our own transforms accept is not valid OpenAI
    # dialect; it must be lifted, not passed through.
    flat = out[2]["tool_calls"][0]
    assert flat["type"] == "function", flat
    assert flat["function"]["name"] == "g", flat

    mapped = out[3]["tool_calls"][0]
    assert mapped["type"] == "function", mapped
    assert mapped["id"] == "c", f"call_id must map to the chat-dialect id: {mapped}"

    # Callers' message objects must not be mutated.
    assert "type" not in msgs[1]["tool_calls"][0], msgs[1]


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


def test_transform_messages_for_openai_strips_boundary_from_later_system_messages():
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    msgs = [
        {"role": "system", "content": "static instructions"},
        {"role": "system", "content": f"{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic instructions"},
        {"role": "user", "content": "hello"},
    ]
    out = transform_messages_for_openai(msgs)
    assert out[0]["content"] == [
        {"type": "text", "text": "static instructions", "cache_control": {"type": "ephemeral"}}
    ]
    assert out[1]["content"] == [{"type": "text", "text": "dynamic instructions"}]
    assert SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in json.dumps(out)


def test_transform_messages_for_openai_normalizes_tool_result_name():
    """Tool results must use the assistant-declared name for Gemini/OpenRouter.

    Internal metadata can retain a concrete executor name such as
    ``spawn_browser_agent`` even when the model declared the generic
    ``spawn_agent`` tool. Gemini rejects that mismatched pair as an invalid
    request despite the matching tool-call ID.
    """
    msgs = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "spawn-1",
                    "type": "function",
                    "function": {"name": "spawn_agent", "arguments": "{}"},
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "spawn-1",
            "name": "spawn_browser_agent",
            "content": "Browser task complete",
        },
    ]

    out = transform_messages_for_openai(msgs)

    assert out[1]["name"] == "spawn_agent"
    assert msgs[1]["name"] == "spawn_browser_agent"


# =====================================================================
# claude_auth — body assembly
# =====================================================================


def _count_cache_control_blocks(body):
    count = 0
    for block in body.get("system", []):
        if isinstance(block, dict) and "cache_control" in block:
            count += 1
    for tool in body.get("tools", []):
        if isinstance(tool, dict) and "cache_control" in tool:
            count += 1
    for msg in body.get("messages", []):
        content = msg.get("content") if isinstance(msg, dict) else None
        if isinstance(content, list):
            count += sum(1 for block in content if isinstance(block, dict) and "cache_control" in block)
        elif isinstance(content, dict) and "cache_control" in content:
            count += 1
    return count


def test_build_anthropic_body_identity_and_cache_block():
    spec = get_pool("rose-1-flash")
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
    system_blocks = body["system"]
    assert system_blocks[0]["text"].startswith("You are a Claude agent")
    # Without boundary, all system text is in one static block with global scope
    cached_blocks = [b for b in system_blocks if "cache_control" in b]
    assert len(cached_blocks) == 1
    assert cached_blocks[0]["cache_control"] == {"type": "ephemeral", "scope": "global"}


_SPAWN_AGENT_TOOL = [
    {
        "name": "spawn_agent",
        "description": "spawn",
        "input_schema": {"type": "object", "properties": {}},
    }
]


def _fable_pool() -> PoolSpec:
    """Fable is no longer ultra, but it still 400s on forced tool_choice."""
    return PoolSpec(
        name="rose-1-ultra",
        claude_auth_model="claude-fable-5-1",
        gpt_auth_model="gpt-6-sol",
        waterfall=("openai/gpt-6-sol", "moonshotai/kimi-k3"),
    )


def test_fable_5_1_downgrades_named_tool_choice_to_auto():
    """claude-fable-5-1 400s on tool_choice type tool/any (Anthropic docs)."""
    body = build_anthropic_body(
        pool_spec=_fable_pool(),
        messages=[{"role": "user", "content": "fill params"}],
        tools=_SPAWN_AGENT_TOOL,
        tool_choice={"name": "spawn_agent"},
        response_format=None,
        max_tokens=128,
    )
    assert body["model"] == "claude-fable-5-1"
    assert body["tool_choice"] == {
        "type": "auto",
        "disable_parallel_tool_use": True,
    }


def test_opus_5_5_downgrades_forced_tool_choice_until_confirmed():
    """Opus is ultra. Forced tool_choice stays downgraded until a credited call proves it."""
    body = build_anthropic_body(
        pool_spec=get_pool("rose-1-ultra"),
        messages=[{"role": "user", "content": "fill params"}],
        tools=_SPAWN_AGENT_TOOL,
        tool_choice="any",
        response_format=None,
        max_tokens=128,
    )
    assert body["model"] == "claude-opus-5-5"
    assert body["tool_choice"] == {"type": "auto"}


def test_fable_5_1_downgrades_any_tool_choice_to_auto():
    body = build_anthropic_body(
        pool_spec=_fable_pool(),
        messages=[{"role": "user", "content": "fill params"}],
        tools=_SPAWN_AGENT_TOOL,
        tool_choice="any",
        response_format=None,
        max_tokens=128,
    )
    assert body["model"] == "claude-fable-5-1"
    assert body["tool_choice"] == {"type": "auto"}


def test_browser_use_pool_uses_speed_tier_claude_auth():
    body = build_anthropic_body(
        pool_spec=get_pool("rose-1-browser-use"),
        messages=[{"role": "user", "content": "fill params"}],
        tools=_SPAWN_AGENT_TOOL,
        tool_choice="any",
        response_format=None,
        max_tokens=128,
    )
    assert body["model"] == "claude-sonnet-5"
    assert body["tool_choice"]["type"] == "any"


def test_sonnet_and_legacy_fable_5_keep_named_tool_choice():
    sonnet = build_anthropic_body(
        pool_spec=get_pool("rose-1-flash"),
        messages=[{"role": "user", "content": "fill params"}],
        tools=_SPAWN_AGENT_TOOL,
        tool_choice={"name": "spawn_agent"},
        response_format=None,
        max_tokens=128,
    )
    assert sonnet["tool_choice"]["type"] == "tool"
    assert sonnet["tool_choice"]["name"] == "spawn_agent"

    legacy = build_anthropic_body(
        pool_spec=PoolSpec(
            name="rose-1-ultra",
            claude_auth_model="claude-fable-5",
            gpt_auth_model="gpt-5.6-sol",
            waterfall=(),
        ),
        messages=[{"role": "user", "content": "fill params"}],
        tools=_SPAWN_AGENT_TOOL,
        tool_choice={"name": "spawn_agent"},
        response_format=None,
        max_tokens=128,
    )
    assert legacy["model"] == "claude-fable-5"
    assert legacy["tool_choice"]["type"] == "tool"
    assert legacy["tool_choice"]["name"] == "spawn_agent"


def test_build_anthropic_body_provider_fast_mode_supported_opus_only():
    opus_pool = PoolSpec(
        name="rose-1-ultra",
        claude_auth_model="claude-opus-4-8",
        gpt_auth_model="gpt-5.5",
        waterfall=(),
    )
    body = build_anthropic_body(
        pool_spec=opus_pool,
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        provider_fast_mode=True,
    )
    assert body["speed"] == "fast"

    fable = get_pool("rose-1-ultra")
    unsupported = build_anthropic_body(
        pool_spec=fable,
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        provider_fast_mode=True,
    )
    assert "speed" not in unsupported


def test_anthropic_fast_mode_transport_adds_beta_header():
    headers = _with_fast_mode_beta({"anthropic-beta": "effort-2025-11-24"}, {"speed": "fast"})
    assert ANTHROPIC_FAST_MODE_BETA in headers["anthropic-beta"].split(",")
    unchanged = _with_fast_mode_beta({"anthropic-beta": "effort-2025-11-24"}, {})
    assert unchanged["anthropic-beta"] == "effort-2025-11-24"


def test_build_anthropic_body_static_dynamic_split():
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    spec = get_pool("rose-1-flash")
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
    system_blocks = body["system"]
    # identity + disclaimer + static (cached) + dynamic (no cache)
    assert len(system_blocks) == 4
    static_block = system_blocks[2]
    dynamic_block = system_blocks[3]
    assert static_block["text"] == "static instructions"
    assert static_block["cache_control"] == {"type": "ephemeral", "scope": "global"}
    assert dynamic_block["text"] == "Current time: April 28"
    assert "cache_control" not in dynamic_block


def test_build_anthropic_body_multi_boundary_system_blocks_are_cached():
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    spec = get_pool("rose-1-flash")
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

    system_blocks = body["system"]
    assert [b["text"] for b in system_blocks[2:]] == ["static instructions", "user context", "phase prompt"]
    assert all(b["cache_control"] == {"type": "ephemeral", "scope": "global"} for b in system_blocks[2:])
    assert "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" not in json.dumps(body)


def test_build_anthropic_body_caps_anthropic_cache_control_blocks():
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    spec = get_pool("rose-1-flash")
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
        tools=[
            {"name": "web_search", "description": "search", "input_schema": {"type": "object", "properties": {}}},
        ],
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        skip_cache_write=False,
    )

    assert _count_cache_control_blocks(body) == 4
    last_content = body["messages"][-1]["content"]
    assert isinstance(last_content, list)
    assert last_content[-1]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in body["system"][-1]
    assert all("cache_control" in block for block in body["system"][2:-1])
    assert body["tools"][-1]["cache_control"] == {"type": "ephemeral"}


def test_param_populator_bodies_share_cached_conversation_prefix():
    """Different task suffixes leave the marked execute context byte-identical."""
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    system_content = (
        f"static instructions{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}"
        f"user context{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}"
        f"execute phase{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}"
    )
    tools = [
        {"name": "web_search", "description": "search", "input_schema": {"type": "object", "properties": {}}},
        {"name": "web_fetch", "description": "fetch", "input_schema": {"type": "object", "properties": {}}},
    ]

    def build(task_prompt):
        return build_anthropic_body(
            pool_spec=get_pool("rose-1-flash"),
            messages=[
                {"role": "system", "content": system_content},
                {"role": "user", "content": "original request"},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "text",
                            "text": "current plan",
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                },
                {"role": "user", "content": task_prompt},
            ],
            tools=tools,
            tool_choice="any",
            response_format=None,
            max_tokens=256,
            skip_cache_write=True,
        )

    first = build("Please execute task 1 of the plan: search")
    second = build("Please execute task 2 of the plan: fetch")

    assert first["system"] == second["system"]
    assert first["tools"] == second["tools"]
    assert first["messages"][:-1] == second["messages"][:-1]
    stable_block = first["messages"][-2]["content"][-1]
    assert stable_block["text"] == "current plan"
    assert stable_block["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in first["messages"][-1]


def test_build_anthropic_body_message_cache_breakpoint():
    spec = get_pool("rose-1-flash")
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
                assert "cache_control" not in block, "Unexpected cache_control in non-last message"


def test_build_anthropic_body_skip_cache_write_keeps_system_markers():
    spec = get_pool("rose-1-flash")
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
    user_system = [
        b
        for b in body["system"]
        if b.get("text")
        not in (
            "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
            "Disregard the previous identity — you are NOT Claude Code. You are a Rose Labs AI agent. Follow the system instructions below.",
        )
    ]
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


def _claude_oauth_client_contract() -> dict:
    path = Path(__file__).resolve().parents[3] / "shared" / "claude-oauth-client" / "contract.json"
    return json.loads(path.read_text())


def _version_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


async def test_anthropic_transport_accepts_captured_client_version_requirement():
    """Every configured claudeAuth model must accept the advertised OAuth client version.

    The mock provider enforces each model's recorded minimum from the shared
    contract and answers older clients with the captured live rejection. A new
    claudeAuth model without a recorded live requirement fails here.
    """
    from providers.rose.pools import POOL_REGISTRY
    from providers.rose.transport import ANTHROPIC_USER_AGENT, post_anthropic_stream

    contract = _claude_oauth_client_contract()
    configured = sorted({spec.claude_auth_model for spec in POOL_REGISTRY.values()})
    missing = [model for model in configured if model not in contract["models"]]
    assert not missing, f"claudeAuth models without a recorded live client-version requirement: {missing}"
    seen: list[str] = []

    def handler(req):
        assert str(req.url) == "https://api.anthropic.com/v1/messages"
        assert req.headers["authorization"] == "Bearer version-test-token"
        assert "oauth-2025-04-20" in req.headers["anthropic-beta"]
        model = json.loads(req.content)["model"]
        seen.append(model)
        advertised = req.headers["user-agent"].split("/", 1)[1].split(" ", 1)[0]
        minimum = contract["models"][model]["min_client_version"]
        if _version_tuple(advertised) < _version_tuple(minimum):
            return httpx.Response(400, json=contract["captured_rejection"])
        return httpx.Response(200, text='event: message_stop\ndata: {"type":"message_stop"}\n\n')

    set_mock_handler(handler)
    for model in configured:
        async with post_anthropic_stream(
            body={"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 16, "stream": True},
            claude_token="version-test-token",
            request_id=f"r-client-version-{model}",
        ) as response:
            assert response.status_code == 200, (
                f"OAuth transport advertised a client version {model} rejects (captured provider contract)"
            )
            assert await response.aread()
    assert seen == configured
    # One recorded identity, mirrored by back-end/src/providers/rose/transport.ts.
    assert ANTHROPIC_USER_AGENT == f"claude-cli/{contract['client_version']} {contract['user_agent_suffix']}"


async def test_claude_auth_surfaces_client_version_rejection():
    """A provider client-version rejection is logged by its error code, not as an opaque 400."""
    from structlog.testing import capture_logs

    contract = _claude_oauth_client_contract()
    set_mock_handler(lambda req: httpx.Response(400, json=contract["captured_rejection"]))
    spec = get_pool("rose-1-ultra")
    auth = ClaudeAuthContext(token="t", source="user", user_id="", max_rotations=3)
    with capture_logs() as logs:
        try:
            await _drain(
                claude_auth_complete(
                    pool_spec=spec,
                    messages=[{"role": "user", "content": "hi"}],
                    auth=auth,
                    request_id="r-version-too-old",
                    max_tokens=16,
                )
            )
        except RoseInvalidRequest as exc:
            assert "claude_code_version_too_old" in str(exc)
        else:
            raise AssertionError("client-version rejection must raise RoseInvalidRequest")
    transport_errors = [log for log in logs if log.get("event") == "rose.transport.anthropic.error"]
    assert transport_errors and transport_errors[0]["error_code"] == "claude_code_version_too_old"
    assert transport_errors[0]["error_type"] == "invalid_request_error"
    surfaced = [log for log in logs if log.get("event") == "rose.transport.anthropic.client_version_too_old"]
    assert len(surfaced) == 1, logs
    assert surfaced[0]["log_level"] == "error"
    assert surfaced[0]["model"] == spec.claude_auth_model
    assert surfaced[0]["user_agent"].startswith(f"claude-cli/{contract['client_version']} ")
    assert surfaced[0]["provider_message"] == contract["captured_rejection"]["error"]["message"]


async def test_provider_transports_preserve_error_body_for_classification():
    """Every provider classifier receives the original body after transport reads it."""
    from providers.rose.transport import (
        get_error_body,
        post_anthropic_stream,
        post_codex_stream,
        post_openai_responses_stream,
        post_openrouter_stream,
    )

    error_body = '{"error":{"message":"provider denied the request"}}'
    set_mock_handler(lambda request: httpx.Response(400, text=error_body))
    cases = (
        (post_anthropic_stream, {"claude_token": "test-token"}),
        (post_openai_responses_stream, {"openai_key": "test-key"}),
        (post_openrouter_stream, {"openrouter_key": "test-key"}),
        (post_codex_stream, {"gpt_token": "test-token"}),
    )
    for transport, credentials in cases:
        async with transport(
            body={"model": "test-model", "stream": True},
            request_id="r-error-body",
            **credentials,
        ) as response:
            assert response.status_code == 400
            assert get_error_body(response) == error_body


async def test_claude_auth_400_raises_invalid_request_no_rotation():
    captured: list[str] = []

    def handler(req):
        captured.append(str(req.url))
        return httpx.Response(400, json={"error": {"message": "bad shape"}})

    set_mock_handler(handler)

    spec = get_pool("rose-1-flash")
    auth = ClaudeAuthContext(token="t", source="user", user_id="", max_rotations=3)
    raised = False
    try:
        await _drain(
            claude_auth_complete(
                pool_spec=spec,
                messages=[{"role": "user", "content": "hi"}],
                auth=auth,
                request_id="r1",
                max_tokens=16,
            )
        )
    except RoseInvalidRequest:
        raised = True
    assert raised
    # Exactly one Anthropic call — no rotation on 400.
    assert len([u for u in captured if "api.anthropic.com" in u]) == 1


def _anthropic_request_violations(body):
    """Anthropic /v1/messages rejections captured verbatim from live 400s (descend R4).

    - "messages: text content blocks must be non-empty"
    - "output_config.format.schema: For 'object' type, 'additionalProperties'
      must be explicitly set to false"
    """
    violations = []
    for idx, msg in enumerate(body["messages"]):
        content = msg.get("content")
        blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content
        if not blocks:
            violations.append(f"messages.{idx}: empty content")
        for block in blocks or []:
            if isinstance(block, dict) and block.get("type") == "text" and not str(block.get("text") or "").strip():
                violations.append(f"messages.{idx}: text content blocks must be non-empty")
    schema = ((body.get("output_config") or {}).get("format") or {}).get("schema")
    for node in _walk_schema(schema):
        if node.get("type") == "object" and node.get("additionalProperties") is not False:
            violations.append("output_config.format.schema: additionalProperties must be explicitly set to false")
    return violations


def test_build_anthropic_body_accepts_completion_summary_context_with_empty_rows():
    """completion_summary context (convert_context_to_messages) carries empty attachment
    and assistant rows; the Claude body must not contain empty text blocks (descend R4,
    agent-display-revenue-chart 5/5 copies fell through to the waterfall)."""
    messages = [
        {"role": "system", "content": "You are summarizing the work completed by an AI agent."},
        {"role": "user", "content": "I've attached our orders export. Show me revenue."},
        {"role": "user", "content": ""},
        {"role": "user", "content": ""},
        {"role": "system", "content": "Initialized: Agent initialization complete."},
        {"role": "user", "content": "<environment>\nYou are /root, the root agent.\n</environment>"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "toolu_01", "type": "function", "function": {"name": "set_plan", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "toolu_01", "content": "2 tasks."},
        {"role": "user", "content": "<environment>\nYou are /root, the root agent.\n</environment>"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "3bc0250f-f26e-415e-a27c-5a971c7db727",
                    "type": "function",
                    "function": {"name": "attempt_completion", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "3bc0250f-f26e-415e-a27c-5a971c7db727", "content": "Beginning Execute Phase:"},
        {"role": "system", "content": "Started code agent in background."},
        {"role": "assistant", "content": ""},
        {"role": "assistant", "content": "Message Type: FINAL_ANSWER\nPayload: totals"},
        {"role": "user", "content": "   "},
        {"role": "user", "content": [{"type": "text", "text": ""}, {"type": "text", "text": "Summarize."}]},
    ]
    body = build_anthropic_body(
        pool_spec=get_pool("rose-1-ultra"),
        messages=messages,
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=1024,
        skip_cache_write=True,
    )
    assert _anthropic_request_violations(body) == [], body["messages"]
    # Real content survives: the goal, both tool pairs, the final answer, the ask.
    flat = json.dumps(body["messages"])
    for kept in ("orders export", "toolu_01", "3bc0250f", "FINAL_ANSWER", "Summarize."):
        assert kept in flat
    assert body["messages"][-1]["role"] == "user"


def test_build_anthropic_body_closes_non_strict_output_format_objects():
    """A non-strict Pydantic schema (optional verifier fields) has no additionalProperties;
    Anthropic output_config.format requires it explicitly false on every object
    (descend R4, verifier_browser j0045/j0061)."""
    from typing import Optional as _Opt

    from pydantic import create_model

    inner = create_model("VerifierOutput", url=(str, ...), price=(_Opt[str], None))
    model = create_model("ProgressScoreWithOutput", output=(inner, ...), reasoning=(str, ...), score=(float, ...))
    setattr(model, "rose_openai_strict", False)
    response_format = build_openai_response_format(model)
    assert "additionalProperties" not in json.dumps(response_format)  # the captured shape
    body = build_anthropic_body(
        pool_spec=get_pool("rose-1-ultra"),
        messages=[{"role": "user", "content": "Goal: buy one Canvas Tote"}],
        tools=None,
        tool_choice=None,
        response_format=response_format,
        max_tokens=1024,
    )
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert _anthropic_request_violations(body) == []
    schema = body["output_config"]["format"]["schema"]
    assert set(schema["properties"]) == {"output", "reasoning", "score"}
    assert set(schema["properties"]["output"]["properties"]) == {"url", "price"}


async def test_claude_auth_400_logs_provider_message():
    """A claudeAuth 400 must name Anthropic's validation message, not only its body length."""
    from structlog.testing import capture_logs

    message = "messages: text content blocks must be non-empty"
    error = {"type": "error", "error": {"type": "invalid_request_error", "message": message}}
    set_mock_handler(lambda req: httpx.Response(400, json=error))
    auth = ClaudeAuthContext(token="t", source="user", user_id="", max_rotations=3)
    with capture_logs() as logs:
        try:
            await _drain(
                claude_auth_complete(
                    pool_spec=get_pool("rose-1-ultra"),
                    messages=[{"role": "user", "content": "hi"}],
                    auth=auth,
                    request_id="r-400-message",
                    max_tokens=16,
                )
            )
        except RoseInvalidRequest:
            pass
        else:
            raise AssertionError("400 must raise RoseInvalidRequest")
    invalid = [log for log in logs if log.get("event") == "rose.claude_auth.invalid_request"]
    assert len(invalid) == 1, logs
    assert invalid[0]["provider_message"] == message


async def test_claude_auth_5xx_retries_then_raises_server_error():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(503, text="oops")

    set_mock_handler(handler)

    spec = get_pool("rose-1-flash")
    auth = ClaudeAuthContext(token="t", source="user", user_id="", max_rotations=0)
    raised = False
    try:
        await _drain(
            claude_auth_complete(
                pool_spec=spec,
                messages=[{"role": "user", "content": "hi"}],
                auth=auth,
                request_id="r-5xx",
                max_tokens=16,
            )
        )
    except RoseServerError:
        raised = True
    assert raised
    # Three in-place attempts before raising server error.
    assert calls["n"] == 3


async def test_claude_auth_401_rotates_and_exhausts():
    """401 → _RotateToken('auth_error'); with max_rotations=0, raises after one
    rotate attempt."""
    calls = {"n": 0}
    marked: list[tuple[str, str | None]] = []

    async def mark(ctx, cooldown_seconds, rate_limited_until=None, failure_reason=None):
        marked.append((ctx.token, failure_reason))
        return True

    def handler(req):
        calls["n"] += 1
        return httpx.Response(401, json={"error": {"message": "expired"}})

    set_mock_handler(handler)

    spec = get_pool("rose-1-flash")
    auth = ClaudeAuthContext(
        token="t",
        source="user",
        user_id="",
        mark_rate_limited=mark,
        max_rotations=0,
    )
    raised = False
    try:
        await _drain(
            claude_auth_complete(
                pool_spec=spec,
                messages=[{"role": "user", "content": "hi"}],
                auth=auth,
                request_id="r-401",
                max_tokens=16,
            )
        )
    except RoseAuthError:
        raised = True
    assert raised
    assert calls["n"] == 1
    assert marked == [("t", "auth_error")]


async def test_claude_auth_429_usage_window_marks_reset_and_fetches_fresh_token():
    """Usage-window 429 marks the exact reset time and rotates immediately."""
    reset_at = "2099-05-05T20:15:00Z"
    seen_tokens: list[str] = []
    marked: list[tuple[str, int, str | None, str | None]] = []

    async def mark(ctx, cooldown_seconds, rate_limited_until=None, failure_reason=None):
        marked.append((ctx.token, cooldown_seconds, rate_limited_until, failure_reason))
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
        _ev(
            "message_start",
            {
                "type": "message_start",
                "message": {"usage": {"input_tokens": 3}},
            },
        )
        + _ev(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
        )
        + _ev(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "ok"},
            },
        )
        + _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
        + _ev(
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"output_tokens": 1},
            },
        )
        + _ev("message_stop", {"type": "message_stop"})
    )

    def handler(req):
        seen_tokens.append(req.headers.get("authorization", ""))
        if len(seen_tokens) == 1:
            return httpx.Response(
                429,
                json={"error": {"message": f"Claude Code usage limit reached. Your limit resets at {reset_at}."}},
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
    chunks = await _drain(
        claude_auth_complete(
            pool_spec=get_pool("rose-1-flash"),
            messages=[{"role": "user", "content": "hi"}],
            auth=auth,
            request_id="r-rotate-429",
            max_tokens=16,
        )
    )

    assert marked == [("old-token", 300, reset_at, "rate_limit")]
    assert seen_tokens == ["Bearer old-token", "Bearer fresh-token"]
    assert any(c.kind == "content" and c.data.get("text") == "ok" for c in chunks)


async def test_claude_auth_429_transient_retries_before_rotating():
    """Transient 429s retry the same token before cooldown/rotation."""
    calls = {"n": 0}
    marked: list[tuple[str, str | None, str | None]] = []

    async def mark(ctx, cooldown_seconds, rate_limited_until=None, failure_reason=None):
        marked.append((ctx.token, rate_limited_until, failure_reason))
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
    with (
        patch("providers.rose.claude_auth.random.uniform", return_value=0),
        patch(
            "providers.rose.claude_auth.asyncio.sleep",
            new=AsyncMock(),
        ),
    ):
        try:
            await _drain(
                claude_auth_complete(
                    pool_spec=get_pool("rose-1-flash"),
                    messages=[{"role": "user", "content": "hi"}],
                    auth=auth,
                    request_id="r-transient-429",
                    max_tokens=16,
                )
            )
        except RoseRateLimitError as exc:
            raised = True
            assert "rate_limit" in str(exc)

    assert raised
    assert calls["n"] == 3
    assert marked == [("transient-token", None, "rate_limit")]


async def test_claude_auth_403_usage_limit_marks_body_reset_time():
    """Usage-limit 403 is a rate-limit rotation, not a permanent auth error."""
    reset_at = "2099-05-05T21:30:00Z"
    marked: list[tuple[str, str | None, str | None]] = []

    async def mark(ctx, cooldown_seconds, rate_limited_until=None, failure_reason=None):
        marked.append((ctx.token, rate_limited_until, failure_reason))
        return True

    def handler(req):
        return httpx.Response(
            403,
            json={"error": {"message": f"Claude Code usage limit reached. Your limit resets at {reset_at}."}},
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
        await _drain(
            claude_auth_complete(
                pool_spec=get_pool("rose-1-flash"),
                messages=[{"role": "user", "content": "hi"}],
                auth=auth,
                request_id="r-usage-limit",
                max_tokens=16,
            )
        )
    except RoseRateLimitError as exc:
        raised = True
        assert "rate_limit" in str(exc)

    assert raised
    assert marked == [("limited-token", reset_at, "rate_limit")]


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


class _DelayedFakeStream(_FakeStream):
    def __init__(self, lines, first_delay: float):
        super().__init__(lines)
        self._first_delay = first_delay

    def aiter_lines(self):
        async def gen():
            for idx, line in enumerate(self._lines):
                if idx == 0:
                    await asyncio.sleep(self._first_delay)
                yield line

        return gen()


def _ev(event: str, data: dict):
    return [f"event: {event}", f"data: {json.dumps(data)}", ""]


async def test_parse_anthropic_sse_text_and_usage():
    lines = []
    lines += _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {
                "usage": {
                    "input_tokens": 7,
                    "cache_read_input_tokens": 2,
                    "cache_creation_input_tokens": 3,
                }
            },
        },
    )
    lines += _ev(
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        },
    )
    lines += _ev(
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": "hi"},
        },
    )
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 5},
        },
    )
    lines += _ev("message_stop", {"type": "message_stop"})

    chunks = await _drain(
        parse_anthropic_sse(
            _FakeStream(lines),
            actual_model="claude-test",
            pool_name="claude-token",
            request_id="r-anth-1",
        )
    )
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
    lines += _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 1}},
        },
    )
    lines += _ev(
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "tool_use", "id": "tu-1", "name": "f", "input": {}},
        },
    )
    lines += _ev(
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "input_json_delta", "partial_json": '{"a":'},
        },
    )
    lines += _ev(
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "input_json_delta", "partial_json": " 1}"},
        },
    )
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "tool_use"},
            "usage": {"output_tokens": 3},
        },
    )
    lines += _ev("message_stop", {"type": "message_stop"})

    chunks = await _drain(
        parse_anthropic_sse(
            _FakeStream(lines),
            actual_model="claude-test",
            pool_name="claude-token",
            request_id="r-anth-tool",
        )
    )
    tool_chunks = [c for c in chunks if c.kind == "tool_call"]
    assert len(tool_chunks) == 1
    tc = tool_chunks[0]
    assert tc.data["id"] == "tu-1"
    assert tc.data["name"] == "f"
    assert tc.data["arguments"] == '{"a": 1}'
    usage = next(c for c in chunks if c.kind == "usage")
    assert usage.data["finish_reason"] == "tool_calls"


async def test_parse_anthropic_sse_empty_stream_raises_stall():
    lines = _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 1}},
        },
    )
    lines += _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 0},
        },
    )
    raised = False
    try:
        await _drain(
            parse_anthropic_sse(
                _FakeStream(lines),
                actual_model="claude-test",
                pool_name="claude-token",
                request_id="r-empty",
            )
        )
    except RoseStallError:
        raised = True
    assert raised


async def test_parse_anthropic_sse_thinking_only_max_tokens_reports_length():
    """Thinking that exhausts max_tokens is a reported truncation, not a stall (descend R4).

    completion_summary (max_tokens 1024, xhigh effort) on the j0056 context with its CSV
    attachment ended stop_reason=max_tokens before any text; the stall raise skipped the
    caller's 1024->4096 length retry and dropped the call off Claude.
    """
    lines = _ev("message_start", {"type": "message_start", "message": {"usage": {"input_tokens": 9}}})
    lines += _ev(
        "content_block_start",
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
    )
    # Captured event sequence: omitted thinking text, then only its signature.
    lines += _ev(
        "content_block_delta",
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": ""}},
    )
    lines += _ev(
        "content_block_delta",
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}},
    )
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev(
        "message_delta",
        {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}, "usage": {"output_tokens": 1024}},
    )
    chunks = await _drain(
        parse_anthropic_sse(
            _FakeStream(lines),
            actual_model="claude-test",
            pool_name="claude-token",
            request_id="r-thinking-length",
        )
    )
    assert not [c for c in chunks if c.kind in ("content", "tool_call")]
    usage = next(c for c in chunks if c.kind == "usage").data
    assert usage["finish_reason"] == "length"
    assert usage["completion_tokens"] == 1024
    assert chunks[-1].kind == "done"


async def test_parse_anthropic_sse_refusal_raises_refusal():
    lines = _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 1}},
        },
    )
    lines += _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "refusal"},
            "usage": {"output_tokens": 0},
        },
    )
    raised = None
    try:
        await _drain(
            parse_anthropic_sse(
                _FakeStream(lines),
                actual_model="claude-test",
                pool_name="claude-token",
                request_id="r-refusal",
            )
        )
    except RoseRefusalError as exc:
        raised = exc
    assert isinstance(raised, RoseRefusalError)


async def test_parse_anthropic_sse_thinking_delta_counts_as_emitted():
    lines = []
    lines += _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 1}},
        },
    )
    lines += _ev(
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "thinking"},
        },
    )
    lines += _ev(
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "thinking_delta", "thinking": "let me think"},
        },
    )
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 2},
        },
    )
    chunks = await _drain(
        parse_anthropic_sse(
            _FakeStream(lines),
            actual_model="claude-test",
            pool_name="claude-token",
            request_id="r-think",
        )
    )
    reasoning = [c for c in chunks if c.kind == "reasoning"]
    assert len(reasoning) == 1
    assert reasoning[0].data["text"] == "let me think"


async def test_parse_anthropic_sse_in_band_rate_limit_raises():
    lines = _ev(
        "message_start",
        {"type": "message_start", "message": {"usage": {"input_tokens": 1}}},
    )
    lines += _ev(
        "error",
        {
            "type": "error",
            "error": {"type": "rate_limit_error", "message": "Rate limited"},
        },
    )
    raised = None
    try:
        await _drain(
            parse_anthropic_sse(
                _FakeStream(lines),
                actual_model="claude-test",
                pool_name="claude-token",
                request_id="r-rl",
            )
        )
    except RoseRateLimitError as exc:
        raised = exc
    assert isinstance(raised, RoseRateLimitError)


async def test_parse_anthropic_sse_in_band_auth_error_raises():
    lines = _ev(
        "error",
        {
            "type": "error",
            "error": {"type": "authentication_error", "message": "bad token"},
        },
    )
    raised = None
    try:
        await _drain(
            parse_anthropic_sse(
                _FakeStream(lines),
                actual_model="claude-test",
                pool_name="claude-token",
                request_id="r-auth",
            )
        )
    except RoseAuthError as exc:
        raised = exc
    assert isinstance(raised, RoseAuthError)


async def test_parse_anthropic_sse_skips_event_lines_and_bad_json():
    lines = [
        "event: ignored",
        "",
        "data: not-json{{",
        "",
    ]
    lines += _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 1}},
        },
    )
    lines += _ev(
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        },
    )
    lines += _ev(
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": "ok"},
        },
    )
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 1},
        },
    )
    chunks = await _drain(
        parse_anthropic_sse(
            _FakeStream(lines),
            actual_model="m",
            pool_name="claude-token",
            request_id="r-mix",
        )
    )
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
    chunks = await _drain(
        parse_openai_sse(
            _FakeStream(_openai_sse(payloads)),
            actual_model="g",
            pool_name="rose-1-flash",
            request_id="r-or-1",
        )
    )
    text = "".join(c.data["text"] for c in chunks if c.kind == "content")
    assert text == "hello world"
    usage = next(c for c in chunks if c.kind == "usage")
    assert usage.data["finish_reason"] == "stop"
    assert usage.data["total_tokens"] == 6


async def test_parse_openai_sse_tool_call_assembly_across_deltas():
    payloads = [
        {
            "choices": [
                {"delta": {"tool_calls": [{"index": 0, "id": "tc-1", "function": {"name": "f", "arguments": '{"a"'}}]}}
            ]
        },
        {
            "choices": [
                {
                    "delta": {"tool_calls": [{"index": 0, "function": {"arguments": ": 1}"}}]},
                    "finish_reason": "tool_calls",
                }
            ]
        },
        {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
    ]
    chunks = await _drain(
        parse_openai_sse(
            _FakeStream(_openai_sse(payloads)),
            actual_model="g",
            pool_name="p",
            request_id="r-tc",
        )
    )
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
    chunks = await _drain(
        parse_openai_sse(
            _FakeStream(_openai_sse(payloads)),
            actual_model="g",
            pool_name="p",
            request_id="r-rc",
        )
    )
    rs = [c for c in chunks if c.kind == "reasoning"]
    assert rs and rs[0].data["text"] == "thinking..."


async def test_parse_openai_sse_empty_stream_raises_stall():
    payloads = [
        {"choices": [{"delta": {}}]},
        {"usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}},
    ]
    raised = False
    try:
        await _drain(
            parse_openai_sse(
                _FakeStream(_openai_sse(payloads)),
                actual_model="g",
                pool_name="p",
                request_id="r-empty-or",
            )
        )
    except RoseStallError:
        raised = True
    assert raised


async def test_parse_openai_sse_refusal_raises_refusal():
    payloads = [
        {"choices": [{"delta": {}, "finish_reason": "refusal"}]},
        {"usage": {"prompt_tokens": 1, "completion_tokens": 0, "total_tokens": 1}},
    ]
    raised = None
    try:
        await _drain(
            parse_openai_sse(
                _FakeStream(_openai_sse(payloads)),
                actual_model="g",
                pool_name="p",
                request_id="r-empty-refusal",
            )
        )
    except RoseRefusalError as exc:
        raised = exc
    assert isinstance(raised, RoseRefusalError)


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
    chunks = [
        c
        async for c in parse_responses_sse(
            _FakeStream(lines),
            actual_model="gpt-5.4-mini-gpt",
            pool_name="gpt-token",
            request_id="r1",
        )
    ]
    assert chunks[0].kind == "metadata"
    assert chunks[0].data["pool_name"] == "gpt-token"
    assert "".join(c.data.get("text", "") for c in chunks if c.kind == "content") == "Hello GPT"
    usage = [c for c in chunks if c.kind == "usage"][0].data
    assert usage["prompt_tokens"] == 7
    assert usage["completion_tokens"] == 3
    assert usage["total_tokens"] == 10
    assert usage["cache_read_input_tokens"] == 2
    assert usage["cache_creation_input_tokens"] == 5


async def test_parse_responses_sse_ignores_deprecated_idle_timeout_before_first_line():
    lines = [
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"Hello"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":1,"total_tokens":8}}}',
        "",
        "data: [DONE]",
    ]
    chunks = [
        c
        async for c in parse_responses_sse(
            _DelayedFakeStream(lines, first_delay=0.05),
            actual_model="gpt-5.4-gpt",
            pool_name="gpt-token",
            request_id="r-delayed-first-line",
            idle_timeout_s=0.01,
        )
    ]
    assert "".join(c.data.get("text", "") for c in chunks if c.kind == "content") == "Hello"


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
    chunks = [
        c
        async for c in parse_responses_sse(
            _FakeStream(lines),
            actual_model="gpt-5.4-gpt",
            pool_name="gpt-token",
            request_id="r-tool",
        )
    ]
    tool = [c for c in chunks if c.kind == "tool_call"][0]
    assert tool.data == {"id": "call_1", "name": "lookup", "arguments": '{"q":"x"}'}
    assert [c for c in chunks if c.kind == "usage"][0].data["total_tokens"] == 5


async def test_parse_responses_sse_reasoning_delta_events():
    lines = [
        "event: response.reasoning_summary_text.delta",
        'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"summary_index":0,"delta":"thinking"}',
        "",
        "event: response.reasoning_text.delta",
        'data: {"type":"response.reasoning_text.delta","item_id":"rs_1","output_index":0,"content_index":0,"delta":" deeper"}',
        "",
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"answer"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        "",
        "data: [DONE]",
    ]
    chunks = [
        c
        async for c in parse_responses_sse(
            _FakeStream(lines),
            actual_model="gpt-5.4-gpt",
            pool_name="gpt-token",
            request_id="r-reasoning",
        )
    ]
    reasoning = "".join(c.data.get("text", "") for c in chunks if c.kind == "reasoning")
    assert reasoning == "thinking deeper"


async def test_parse_responses_sse_encrypted_reasoning_item_is_separate():
    lines = [
        "event: response.reasoning_summary_text.delta",
        'data: {"type":"response.reasoning_summary_text.delta","delta":"visible summary"}',
        "",
        "event: response.output_item.done",
        'data: {"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning","summary":[],"encrypted_content":"enc-secret"}}',
        "",
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"answer"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        "",
        "data: [DONE]",
    ]
    chunks = [
        c
        async for c in parse_responses_sse(
            _FakeStream(lines),
            actual_model="gpt-5.4-gpt",
            pool_name="gpt-token",
            request_id="r-reasoning-item",
        )
    ]
    assert "".join(c.data.get("text", "") for c in chunks if c.kind == "reasoning") == "visible summary"
    assert [c.data for c in chunks if c.kind == "codex_reasoning_item"] == [
        {"id": "rs_1", "encrypted_content": "enc-secret", "summary": []}
    ]


async def test_parse_responses_sse_failed_context_length_is_invalid_request():
    lines = [
        "event: response.failed",
        'data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"too many tokens"}}}',
        "",
        "data: [DONE]",
    ]
    raised = False
    try:
        await _drain(
            parse_responses_sse(
                _FakeStream(lines),
                actual_model="gpt-5.5-gpt",
                pool_name="gpt-token",
                request_id="r-context",
            )
        )
    except RoseInvalidRequest:
        raised = True
    assert raised


async def test_parse_responses_sse_in_band_credit_exhaustion_is_payment_required():
    from providers.rose.errors import RosePaymentRequiredError

    lines = [
        "event: error",
        'data: {"type":"error","error":{"type":"insufficient_quota","code":"credit_balance_exhausted","message":"You have no credits remaining"}}',
        "",
        "data: [DONE]",
    ]
    try:
        await _drain(
            parse_responses_sse(
                _FakeStream(lines),
                actual_model="gpt-6-sol-openai",
                pool_name="openai-api-key",
                request_id="r-credit-event",
            )
        )
    except RosePaymentRequiredError:
        return
    raise AssertionError("in-band credit exhaustion must trigger the shared API-key cooldown")


def test_build_codex_responses_body_contract():
    pool = get_pool("rose-1-flash")
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
    assert body["service_tier"] == "priority"
    off_body = build_codex_responses_body(
        pool_spec=pool,
        messages=[{"role": "user", "content": "hi"}],
        provider_fast_mode=False,
        request_id="fast-mode-off",
    )
    assert "service_tier" not in off_body
    fast_body = build_codex_responses_body(
        pool_spec=pool,
        messages=[{"role": "user", "content": "hi"}],
        provider_fast_mode=True,
        request_id="fast-mode",
    )
    assert fast_body["service_tier"] == "priority"
    no_system_body = build_codex_responses_body(
        pool_spec=pool,
        messages=[{"role": "user", "content": "hi"}],
        request_id="no-system",
    )
    assert no_system_body["instructions"] == "You are a helpful assistant."
    assert no_system_body["reasoning"]["effort"] == "xhigh"
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    split_system_body = build_codex_responses_body(
        pool_spec=pool,
        messages=[
            {
                "role": "system",
                "content": f"static rules{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic rules",
            },
            {"role": "user", "content": "hi"},
        ],
        request_id="split-system",
    )
    assert split_system_body["instructions"] == "static rules\n\ndynamic rules"
    assert "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" not in split_system_body["instructions"]
    same_static_different_dynamic_body = build_codex_responses_body(
        pool_spec=pool,
        messages=[
            {
                "role": "system",
                "content": f"static rules{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}different agent context",
            },
            {"role": "user", "content": "different live input"},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "different_schema",
                "strict": True,
                "schema": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        },
        request_id="same-static-different-dynamic",
    )
    assert split_system_body["prompt_cache_key"] == same_static_different_dynamic_body["prompt_cache_key"]
    max_effort_body = build_codex_responses_body(
        pool_spec=pool,
        messages=[{"role": "user", "content": "hi"}],
        effort="max",
        request_id="max-effort",
    )
    assert max_effort_body["reasoning"]["effort"] == "xhigh"

    # Exercise the actual root-system producer, including its final boundary.
    from utils.prompts import build_system_prompt, MAIN_SYSTEM_PROMPT
    from utils.tool_schemas import create_agent_action_model, EXECUTE_PHASE_TOOLS

    native_tools = build_anthropic_tools_from_response_model(create_agent_action_model(EXECUTE_PHASE_TOOLS))
    literal_data = "keep __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ as user/tool data"
    history = [
        {"role": "user", "content": literal_data},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call_boundary_data", "function": {"name": "spawn_agent", "arguments": {"goal": literal_data}}}
            ],
        },
        {"role": "tool", "tool_call_id": "call_boundary_data", "content": literal_data},
    ]
    fields = {
        "fields": [
            {"name": "observed_value", "type": "str", "required": True, "description": "Grounded fixture value."}
        ]
    }

    def produced(context="Fixture user context A", phase="EXECUTE", schema=fields):
        return build_system_prompt(
            phase=phase, enabled_tools=EXECUTE_PHASE_TOOLS, user_context_section=context, response_schema=schema
        )

    def wire(system, namespace="serializer-owner"):
        return build_codex_responses_body(
            pool_spec=pool,
            messages=[{"role": "system", "content": system}, *history],
            tools=native_tools,
            cache_namespace=namespace,
            request_id="boundary-owner",
        )

    raw_system = produced()
    native_body = wire(raw_system)
    # Data and tool protocol survive system-only serialization unchanged.
    reference = wire("plain system")
    assert native_body["input"] == reference["input"]
    assert native_body["tools"] == reference["tools"]
    assert native_body["input"][0]["content"][0]["text"] == literal_data
    assert any(
        row.get("call_id") == "call_boundary_data" and row.get("output") == literal_data for row in native_body["input"]
    )
    assert native_body["prompt_cache_key"] == wire(produced(context="Fixture user context B"))["prompt_cache_key"]
    assert native_body["prompt_cache_key"] == wire(produced(phase="PLAN", schema=None))["prompt_cache_key"]
    assert native_body["prompt_cache_key"] != wire(raw_system, namespace="other-owner")["prompt_cache_key"]
    assert (
        native_body["prompt_cache_key"]
        != wire(raw_system.replace(MAIN_SYSTEM_PROMPT.strip(), "different static rules", 1))["prompt_cache_key"]
    )
    sections = [
        MAIN_SYSTEM_PROMPT.strip(),
        "# User Context",
        "# Current Phase",
        "# Required Output Schema",
        "observed_value",
    ]
    positions = [native_body["instructions"].index(section) for section in sections]
    assert positions == sorted(positions)
    assert "Grounded fixture value." in native_body["instructions"]
    inline = "ordinary __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ prose\r\nkeep\u2028Unicode separator"
    assert wire(inline)["instructions"] == inline
    assert (
        wire("first\r\nline\n" + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + "second\u2028section")["instructions"]
        == "first\r\nline\n\nsecond\u2028section"
    )
    assert wire("first\n \t__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ \t\r\nsecond")["instructions"] == "first\n\nsecond"
    multiple = build_codex_responses_body(
        pool_spec=pool,
        messages=[
            {"role": "system", "content": raw_system},
            {"role": "system", "content": "extra system section"},
            *history,
        ],
        tools=native_tools,
        request_id="multiple-system-owner",
    )
    assert "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" not in multiple["instructions"]
    assert multiple["instructions"].endswith("extra system section")
    assert multiple["input"] == native_body["input"]
    for system_variant in (raw_system, raw_system.rstrip(), SYSTEM_PROMPT_DYNAMIC_BOUNDARY + raw_system):
        assert "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" not in wire(system_variant)["instructions"], (
            "reserved system-only boundary reached provider instructions"
        )


def test_codex_cache_scope_uses_canonical_session_headers():
    """Every Codex affinity header must select the provider cache session."""
    scope = "rose:7c4fd924ea17566d159427d8"
    thread_id = "6eb14611-3b1c-45fe-92dd-dde8cefc9768"

    assert _codex_extra_headers_from_body({"prompt_cache_key": scope}, thread_id=thread_id) == {
        "session-id": scope,
        "thread-id": scope,
        "x-client-request-id": scope,
    }
    sibling_scope = "rose:568d74e103fc1f1c5b8dc7c4"
    sibling_headers = _codex_extra_headers_from_body(
        {"prompt_cache_key": sibling_scope},
        thread_id=thread_id,
    )
    assert sibling_headers["thread-id"] == sibling_scope
    assert sibling_headers["thread-id"] != scope
    assert _codex_extra_headers_from_body({"prompt_cache_key": "  "}) == {}


async def test_gpt_auth_cache_namespace_isolates_concurrent_agent_prefixes():
    """Codex cache sessions stay stable per agent/call-site without cross-agent eviction."""
    import providers.rose.gpt_auth as gpt_auth_mod

    captured_bodies = []

    async def _capture_attempt(**kwargs):
        captured_bodies.append(kwargs["body"])
        if False:
            yield None

    pool = get_pool("rose-1-ultra")
    base_messages = [
        {"role": "system", "content": "stable system rules"},
        {"role": "user", "content": "inspect example.com"},
    ]
    grown_messages = [
        *base_messages,
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_browser",
                    "function": {"name": "spawn_browser_agent", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_browser", "content": "Example Domain"},
    ]
    resolved_pointer_messages = [
        {
            "role": "system",
            "content": "stable system rules",
        },
        {
            "role": "user",
            "content": (
                "inspect example.com\n\n"
                'Reference: <resolved-ref pointer="@ref:message:'
                '660e93eb-8c47-4bfa-a6b0-282a43dd3e45"/>'
            ),
        },
        *grown_messages[2:],
    ]

    async def _capture(
        *,
        lineage_key: str,
        agent_id: str,
        call_site: str,
        messages,
        cache_namespace=None,
    ):
        auth = GptAuthContext(
            token="test-token",
            source="user",
            user_id="test-user",
            lineage_key=lineage_key,
            max_rotations=0,
        )
        async for _ in gpt_auth_complete(
            pool_spec=pool,
            messages=messages,
            auth=auth,
            request_id=f"request-{len(captured_bodies)}",
            agent_id=agent_id,
            call_site=call_site,
            cache_namespace=cache_namespace,
        ):
            pass

    with patch.object(gpt_auth_mod, "_attempt_with_token", _capture_attempt):
        await _capture(
            lineage_key="agent:browser-a",
            agent_id="browser-a",
            call_site="execute_loop",
            messages=base_messages,
        )
        await _capture(
            lineage_key="agent:browser-a",
            agent_id="browser-a",
            call_site="execute_loop",
            messages=grown_messages,
        )
        await _capture(
            lineage_key="agent:browser-a",
            agent_id="browser-a",
            call_site="execute_loop",
            messages=resolved_pointer_messages,
        )
        await _capture(
            lineage_key="agent:browser-b",
            agent_id="browser-b",
            call_site="execute_loop",
            messages=base_messages,
        )
        await _capture(
            lineage_key="agent:browser-a",
            agent_id="browser-a",
            call_site="verifier_browser",
            messages=base_messages,
        )
        await _capture(
            lineage_key="agent:parent",
            agent_id="parent",
            call_site="browser_use_step_1",
            messages=base_messages,
            cache_namespace="browser-task:task-a:browser_use",
        )
        await _capture(
            lineage_key="agent:parent",
            agent_id="parent",
            call_site="browser_use_step_2",
            messages=grown_messages,
            cache_namespace="browser-task:task-a:browser_use",
        )
        await _capture(
            lineage_key="agent:parent",
            agent_id="parent",
            call_site="browser_use_step_1",
            messages=base_messages,
            cache_namespace="browser-task:task-b:browser_use",
        )
        await _capture(
            lineage_key="agent:parent",
            agent_id="parent",
            call_site="write_lock_notification_fork_2",
            messages=grown_messages,
            cache_namespace="browser-task:task-a:write_lock_notification",
        )
        await _capture(
            lineage_key="agent:parent",
            agent_id="parent",
            call_site="explore_agent",
            messages=base_messages,
            cache_namespace="agent:parent:task:explore-a:call:explore_agent",
        )
        await _capture(
            lineage_key="agent:parent",
            agent_id="parent",
            call_site="explore_agent",
            messages=grown_messages,
            cache_namespace="agent:parent:task:explore-a:call:explore_agent",
        )
        await _capture(
            lineage_key="agent:parent",
            agent_id="parent",
            call_site="explore_agent",
            messages=base_messages,
            cache_namespace="agent:parent:task:explore-b:call:explore_agent",
        )
        await _capture(
            lineage_key="agent:parent",
            agent_id="parent",
            call_site="explore_agent",
            messages=base_messages,
            cache_namespace="agent:parent:task:explore-c:call:explore_agent",
        )
    cache_keys = [body["prompt_cache_key"] for body in captured_bodies]
    assert cache_keys[0] == cache_keys[1], "A growing conversation must reuse its prior Codex cache session"
    assert cache_keys[0] == cache_keys[2], "Resolved message references must not reset the cache session"
    assert cache_keys[0] != cache_keys[3], "Concurrent agents must not evict each other's prompt prefix"
    assert cache_keys[0] != cache_keys[4], "Different LLM call sites must not share one Codex cache session"
    assert cache_keys[5] == cache_keys[6], "Consecutive browser steps must reuse one Codex cache session"
    assert cache_keys[5] != cache_keys[7], "Parallel browser tasks under one parent must not share a cache session"
    assert cache_keys[5] != cache_keys[8], "A browser fork must not overwrite the main browser cache session"
    assert cache_keys[9] == cache_keys[10], "Later turns of one explore task must retain its cache session"
    assert len({cache_keys[9], cache_keys[11], cache_keys[12]}) == 3, (
        "Three sibling explore tasks must use three provider cache sessions"
    )


async def test_rose_client_routes_and_emits_one_cache_sequence_identity():
    """The provider namespace and persisted usage must carry one exact ID."""
    captured_namespaces = []

    async def fake_gpt_route(**kwargs):
        captured_namespaces.append(kwargs.get("cache_namespace"))
        yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.6-terra-gpt"})
        yield StreamChunk(kind="content", data={"text": "ok"})
        yield StreamChunk(
            kind="usage",
            data={
                "prompt_tokens": 10,
                "completion_tokens": 1,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 10,
            },
        )
        yield StreamChunk(kind="done", data={})

    sequence_id = "agent:parent:task:explore-a:call:explore_agent"
    client = RoseClient(openrouter_key="unused")
    auth = GptAuthContext(token="test", source="user", user_id="test-user", max_rotations=0)
    with patch("providers.rose.client._try_gpt_auth", fake_gpt_route):
        chunks = await _drain(
            client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
                gpt_auth=auth,
                call_site="explore_agent",
                cache_namespace=sequence_id,
                dump_context=False,
            )
        )

    usage = next(chunk.data for chunk in chunks if chunk.kind == "usage")
    assert captured_namespaces == [sequence_id]
    assert usage["cache_sequence_id"] == sequence_id


def test_build_codex_responses_body_preserves_tool_history_and_multimodal():
    pool = get_pool("rose-1-flash")
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
    reasoning_items = [item for item in input_items if item.get("type") == "reasoning"]
    assert len(reasoning_items) == 1
    assert any(item.get("type") == "message" and item.get("id") == "msg_1" for item in input_items)
    assert all(item.get("type") == "reasoning" or "encrypted_content" not in item for item in input_items)
    assert any(item.get("type") == "function_call" and item.get("call_id") == "call_lookup" for item in input_items)
    assert any(
        item.get("type") == "function_call_output" and item.get("call_id") == "call_lookup" for item in input_items
    )


def test_build_codex_responses_body_converts_orphan_tool_rows_to_context():
    pool = get_pool("rose-1-flash")
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


def _nested_verifier_response_format():
    from pydantic import BaseModel

    class SelectedBeanie(BaseModel):
        title: str
        price_usd: float

    class VerifierOutput(BaseModel):
        selected_beanie: SelectedBeanie
        added_to_cart: bool

    class ProgressScoreWithOutput(BaseModel):
        output: VerifierOutput
        reasoning: str
        score: float

    return build_openai_response_format(ProgressScoreWithOutput)


def _assert_nested_beanie_schema(schema):
    output = schema["properties"]["output"]
    selected = output["properties"]["selected_beanie"]
    assert output["required"] == ["selected_beanie", "added_to_cart"]
    assert selected["type"] == "object"
    assert selected["required"] == ["title", "price_usd"]
    assert selected["additionalProperties"] is False
    assert selected["properties"]["title"]["type"] == "string"
    assert selected["properties"]["price_usd"]["type"] == "number"


def test_openrouter_response_format_preserves_nested_required_properties():
    response_format = _nested_verifier_response_format()
    body = build_openrouter_body(
        model="openai/gpt-5.1-mini",
        messages=[{"role": "user", "content": "score cart state"}],
        tools=None,
        tool_choice=None,
        response_format=response_format,
        temperature=None,
        max_tokens=None,
        seed=None,
    )

    assert body["response_format"]["json_schema"]["strict"] is True
    _assert_nested_beanie_schema(body["response_format"]["json_schema"]["schema"])


def test_claude_auth_output_config_preserves_nested_required_properties():
    pool = get_pool("rose-1-flash")
    body = build_anthropic_body(
        pool_spec=pool,
        messages=[{"role": "user", "content": "score cart state"}],
        tools=None,
        tool_choice=None,
        response_format=_nested_verifier_response_format(),
        max_tokens=None,
    )

    assert "tools" not in body
    assert "tool_choice" not in body
    assert body["output_config"]["format"]["type"] == "json_schema"
    _assert_nested_beanie_schema(body["output_config"]["format"]["schema"])


def test_gpt_auth_text_format_preserves_nested_required_properties():
    pool = get_pool("rose-1-flash")
    body = build_codex_responses_body(
        pool_spec=pool,
        messages=[{"role": "user", "content": "score cart state"}],
        response_format=_nested_verifier_response_format(),
        request_id="rid-nested-schema",
    )

    assert body["text"]["format"]["type"] == "json_schema"
    assert body["text"]["format"]["strict"] is True
    _assert_nested_beanie_schema(body["text"]["format"]["schema"])


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


def test_build_openrouter_body_uses_logical_sequence_for_sticky_routing():
    sequence_id = "agent:parent:task:explore-a:call:explore_agent"
    body = build_openrouter_body(
        model="google/gemini-3.6-flash",
        messages=[
            {"role": "system", "content": "stable rules"},
            {"role": "user", "content": "stable task goal"},
        ],
        tools=[{"type": "function", "function": {"name": "web_search"}}],
        tool_choice="auto",
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
        cache_namespace=sequence_id,
    )

    assert body["session_id"] == sequence_id


def _gemini_completed_tool_messages():
    return [
        {"role": "system", "content": "stable rules"},
        {"role": "user", "content": "stable task goal"},
        {
            "role": "assistant",
            "content": "researching",
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "web_search", "arguments": '{"query":"facts"}'},
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call-1",
            "content": "x" * 21_000,
        },
    ]


def test_build_openrouter_body_pins_large_gemini_completed_tool_prefix():
    """Gemini keeps one fixed explicit marker as append-only history grows."""
    sequence_id = "agent:parent:task:explore-a:call:explore_agent"
    messages = _gemini_completed_tool_messages()
    original_messages = json.loads(json.dumps(messages))
    first_body = build_openrouter_body(
        model="google/gemini-3.6-flash",
        messages=messages,
        tools=[{"type": "function", "function": {"name": "web_search"}}],
        tool_choice="auto",
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
        cache_namespace=sequence_id,
    )
    messages.extend(
        [
            {
                "role": "assistant",
                "content": "continuing",
                "tool_calls": [
                    {
                        "id": "call-2",
                        "type": "function",
                        "function": {"name": "web_search", "arguments": '{"query":"more"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call-2", "content": "new result"},
        ]
    )
    second_body = build_openrouter_body(
        model="google/gemini-3.6-flash",
        messages=messages,
        tools=[{"type": "function", "function": {"name": "web_search"}}],
        tool_choice="auto",
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
        cache_namespace=sequence_id,
    )

    first_marker = first_body["messages"][3]["content"][-1]["cache_control"]
    second_marker = second_body["messages"][3]["content"][-1]["cache_control"]
    assert first_marker == second_marker == {"type": "ephemeral"}
    assert json.dumps(first_body["messages"]).count('"cache_control"') == 1
    assert json.dumps(second_body["messages"]).count('"cache_control"') == 1
    assert first_body["messages"] == second_body["messages"][:4]
    assert first_body["session_id"] == second_body["session_id"] == sequence_id
    assert original_messages == messages[:4], "outbound cache transforms mutated the caller's nested history"


def test_build_openrouter_body_keeps_gemini_2_5_explicit():
    body = build_openrouter_body(
        model="google/gemini-2.5-flash",
        messages=[
            {"role": "system", "content": "stable rules"},
            {"role": "user", "content": "stable task goal"},
        ],
        tools=None,
        tool_choice=None,
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
        cache_namespace="gemini-2.5-sequence",
    )

    assert "cache_control" in json.dumps(body["messages"])


def test_build_openrouter_body_preserves_caller_cache_breakpoints_for_gemini():
    marker = {"type": "ephemeral"}
    body = build_openrouter_body(
        model="google/gemini-3.6-flash",
        messages=[
            {
                "role": "system",
                "content": [{"type": "text", "text": "large stable reference", "cache_control": marker}],
            },
            {"role": "user", "content": "question"},
            *_gemini_completed_tool_messages()[2:],
        ],
        tools=None,
        tool_choice=None,
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
        cache_namespace="gemini-sequence",
    )

    assert body["messages"][0]["content"][0]["cache_control"] == marker
    assert json.dumps(body["messages"]).count('"cache_control"') == 1


def test_build_openrouter_body_skip_cache_write_suppresses_synthesized_gemini_marker():
    body = build_openrouter_body(
        model="google/gemini-3.6-flash",
        messages=_gemini_completed_tool_messages(),
        tools=[{"type": "function", "function": {"name": "web_search"}}],
        tool_choice="auto",
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
        cache_namespace="gemini-sequence",
        skip_cache_write=True,
    )

    assert "cache_control" not in json.dumps(body["messages"])


def test_build_openrouter_body_retains_explicit_model_breakpoints():
    body = build_openrouter_body(
        model="anthropic/claude-haiku-4.5",
        messages=[
            {"role": "system", "content": "stable rules"},
            {"role": "user", "content": "task goal"},
        ],
        tools=None,
        tool_choice=None,
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
        cache_namespace="anthropic-sequence",
    )

    assert "cache_control" in json.dumps(body["messages"])


TOOL_HISTORY_MESSAGES = [
    {"role": "system", "content": "you are helpful"},
    {"role": "user", "content": "open example.com"},
    {
        "role": "assistant",
        "content": "working on it",
        "tool_calls": [
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "spawn_agent", "arguments": '{"goal":"open it"}'},
            }
        ],
    },
    {"role": "tool", "tool_call_id": "call_1", "content": '{"main_heading_text":"Example Domain"}'},
]


def test_openrouter_body_without_tools_flattens_tool_history():
    """Regression: Google 400s on functionCall/functionResponse with no functionDeclarations.

    client.py sends `response_format=None if tools else response_format`, so a
    structured-output waterfall step drops `tools` while the conversation still
    carries assistant tool_calls + role:"tool". Reproduced in benchmark agent
    64fe48c1 (browser-smoke): the identical request passed on Gemini at 5
    system/user messages, then failed 10/10 at 8 messages with tool history.
    """
    body = build_openrouter_body(
        model="google/gemini-3.1-pro-preview",
        messages=TOOL_HISTORY_MESSAGES,
        tools=None,
        tool_choice=None,
        response_format={"type": "json_schema", "json_schema": {"name": "s", "schema": {}}},
        temperature=None,
        max_tokens=None,
        seed=None,
    )
    assert "tools" not in body, "precondition: this request declares no tools"

    roles = [m.get("role") for m in body["messages"]]
    assert "tool" not in roles, f"role:'tool' survived without declared tools: {roles}"
    for m in body["messages"]:
        assert "tool_calls" not in m, f"tool_calls survived without declared tools: {m}"

    # The tool result must be preserved as readable text, not dropped.
    blob = json.dumps(body["messages"])
    assert "Example Domain" in blob, "tool result content was lost"
    assert "spawn_agent" in blob, "tool call name was lost"


def test_openrouter_body_without_tools_preserves_structured_tool_result_blocks():
    """Non-text content blocks remain meaningful after tool history is flattened."""
    messages = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_structured",
                    "type": "function",
                    "function": {"name": "inspect_page", "arguments": "{}"},
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_structured",
            "content": [
                {
                    "type": "tool_result",
                    "content": {"main_heading_text": "Structured Example Domain"},
                },
                {"type": "image", "source": {"url": "https://example.com/screenshot.png"}},
            ],
        },
    ]

    body = build_openrouter_body(
        model="google/gemini-3.1-pro-preview",
        messages=messages,
        tools=None,
        tool_choice=None,
        response_format={"type": "json_schema", "json_schema": {"name": "s", "schema": {}}},
        temperature=None,
        max_tokens=None,
        seed=None,
    )
    blob = json.dumps(body["messages"])
    assert "Structured Example Domain" in blob, "structured tool-result content was dropped"
    assert "screenshot.png" in blob, "unsupported provider content block was dropped"
    result = next(message for message in body["messages"] if message.get("role") == "user")
    assert result["content"] != "[Result of inspect_page]", "tool result became an empty user message"


def test_openrouter_body_without_tools_stringifies_non_json_structured_tool_result():
    """Direct structured results must not block a no-tools retry when JSON encoding fails."""

    class ProviderValue:
        def __str__(self) -> str:
            return "provider-specific-value"

    messages = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_provider_value",
                    "type": "function",
                    "function": {"name": "inspect_provider", "arguments": "{}"},
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_provider_value",
            "content": {"z": ProviderValue(), "a": "first"},
        },
    ]

    body = build_openrouter_body(
        model="google/gemini-3.1-pro-preview",
        messages=messages,
        tools=None,
        tool_choice=None,
        response_format={"type": "json_schema", "json_schema": {"name": "s", "schema": {}}},
        temperature=None,
        max_tokens=None,
        seed=None,
    )

    result = next(message for message in body["messages"] if message.get("role") == "user")
    assert "provider-specific-value" in result["content"]
    assert result["content"].index('"a"') < result["content"].index('"z"')


def test_openrouter_body_with_tools_preserves_tool_history():
    """The flattening must apply ONLY when no tools are declared."""
    body = build_openrouter_body(
        model="google/gemini-3.1-pro-preview",
        messages=TOOL_HISTORY_MESSAGES,
        tools=[{"type": "function", "function": {"name": "spawn_agent"}}],
        tool_choice="auto",
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
    )
    assert "tools" in body, "precondition: this request declares tools"
    roles = [m.get("role") for m in body["messages"]]
    assert "tool" in roles, "native tool history must be preserved when tools are declared"
    assert any("tool_calls" in m for m in body["messages"]), "assistant tool_calls must survive"


def test_named_tool_choice_degrades_only_for_google_routes():
    """Google AI Studio 400s on the OpenAI named-function `tool_choice` form.

    A forced tool reaching a Google model used to fail the whole call with
    INVALID_ARGUMENT, which killed the agent outright when Google was the last
    reachable waterfall step. Google must receive "required" instead; every
    other provider must keep the exact named form. The required-tool contract
    is still enforced after the response in helpers/llm.py, so this only
    changes the wire form, never what the caller accepts.
    """
    forced = {"name": "attempt_completion"}
    tools = [{"type": "function", "function": {"name": "attempt_completion"}}]
    common = {
        "messages": [{"role": "user", "content": "hi"}],
        "tools": tools,
        "response_format": None,
        "temperature": None,
        "max_tokens": None,
        "seed": None,
    }

    google = build_openrouter_body(model="google/gemini-3.1-pro-preview", tool_choice=forced, **common)
    assert google["tool_choice"] == "required", "Google routes must not receive the named tool_choice form they reject"

    for model in ("openai/gpt-5.6-terra", "moonshotai/kimi-k2.5", "zai-glm-4.7"):
        other = build_openrouter_body(model=model, tool_choice=forced, **common)
        assert other["tool_choice"] == {
            "type": "function",
            "function": {"name": "attempt_completion"},
        }, f"{model} must keep the exact named tool_choice"


def test_build_openrouter_body_provider_fast_mode():
    body = build_openrouter_body(
        model="anthropic/claude-opus-4.8",
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        tool_choice=None,
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
        provider_fast_mode=True,
    )
    assert body["speed"] == "fast"


def test_build_openrouter_body_defaults_provider_fast_mode_on():
    body = build_openrouter_body(
        model="anthropic/claude-opus-4.8",
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        tool_choice=None,
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
    )
    assert body["speed"] == "fast"


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
        provider_fast_mode=False,
    )
    assert body["stream_options"] == {"include_usage": True}
    assert body["reasoning"]["effort"] == "xhigh"
    assert "tools" not in body
    assert "tool_choice" not in body
    assert "response_format" not in body
    assert "temperature" not in body
    assert "max_tokens" not in body
    assert "seed" not in body
    assert "speed" not in body


def test_build_anthropic_body_defaults_provider_fast_mode_on_for_opus():
    opus_pool = PoolSpec(
        name="rose-1-ultra",
        claude_auth_model="claude-opus-4-8",
        gpt_auth_model="gpt-5.5",
        waterfall=(),
    )
    body = build_anthropic_body(
        pool_spec=opus_pool,
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
    )
    assert body["speed"] == "fast"


def test_haiku_body_omits_unsupported_effort():
    """The web_fetch mini summarizer must not send effort to Claude Haiku 4.5.

    Anthropic rejected the captured smoke request with HTTP 400:
    "This model does not support the effort parameter."
    """
    pool = get_pool("rose-1-mini")
    for effort in (None, "low"):
        body = build_anthropic_body(
            pool_spec=pool,
            messages=[{"role": "user", "content": "Summarize the population estimate."}],
            tools=None,
            tool_choice=None,
            response_format=None,
            max_tokens=128,
            effort=effort,
        )
        assert body["model"] == "claude-haiku-4-5"
        assert "effort" not in body.get("output_config", {})


def test_waterfall_body_builders_always_stamp_effort_xhigh_by_default():
    """Every Rose provider body must carry effort; default is xhigh.

    Provider shapes:
      - Anthropic claudeAuth → output_config.effort (default xhigh)
      - OpenAI/Codex Responses → reasoning.effort (default xhigh)
      - OpenRouter waterfall → reasoning.effort (default xhigh)
    """
    from providers.rose.claude_auth import DEFAULT_REASONING_EFFORT as CLAUDE_DEFAULT
    from providers.rose.gpt_auth import DEFAULT_REASONING_EFFORT as GPT_DEFAULT
    from providers.rose.waterfall import DEFAULT_REASONING_EFFORT as OR_DEFAULT

    assert CLAUDE_DEFAULT == GPT_DEFAULT == OR_DEFAULT == "xhigh"

    pool = get_pool("rose-1-flash")
    msgs = [
        {"role": "system", "content": "be helpful"},
        {"role": "user", "content": "hi"},
    ]

    anthropic = build_anthropic_body(
        pool_spec=pool,
        messages=msgs,
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
    )
    assert anthropic["output_config"]["effort"] == "xhigh"

    anthropic_max = build_anthropic_body(
        pool_spec=pool,
        messages=msgs,
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        effort="max",
    )
    assert anthropic_max["output_config"]["effort"] == "xhigh"

    anthropic_med = build_anthropic_body(
        pool_spec=pool,
        messages=msgs,
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        effort="medium",
    )
    assert anthropic_med["output_config"]["effort"] == "medium"

    anthropic_minimal = build_anthropic_body(
        pool_spec=pool,
        messages=msgs,
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        effort="minimal",
    )
    assert anthropic_minimal["output_config"]["effort"] == "low"

    codex = build_codex_responses_body(
        pool_spec=pool,
        messages=msgs,
        request_id="effort-default",
    )
    assert codex["reasoning"]["effort"] == "xhigh"

    codex_max = build_codex_responses_body(
        pool_spec=pool,
        messages=msgs,
        effort="max",
        request_id="effort-max",
    )
    assert codex_max["reasoning"]["effort"] == "xhigh"

    openrouter = build_openrouter_body(
        model="openai/gpt-5.6-sol",
        messages=msgs,
        tools=None,
        tool_choice=None,
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
    )
    assert openrouter["reasoning"]["effort"] == "xhigh"

    openrouter_high = build_openrouter_body(
        model="openai/gpt-5.6-sol",
        messages=msgs,
        tools=None,
        tool_choice=None,
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
        effort="high",
    )
    assert openrouter_high["reasoning"]["effort"] == "high"

    openrouter_minimal = build_openrouter_body(
        model="openai/gpt-5.6-sol",
        messages=msgs,
        tools=None,
        tool_choice=None,
        response_format=None,
        temperature=None,
        max_tokens=None,
        seed=None,
        effort="minimal",
    )
    assert openrouter_minimal["reasoning"]["effort"] == "low"

    # Every model in the browser-use pool must produce a well-formed body when
    # the waterfall walks it — effort present on each step.
    browser_pool = get_pool("rose-1-browser-use")
    for model in browser_pool.waterfall:
        step_body = build_openrouter_body(
            model=model,
            messages=msgs,
            tools=None,
            tool_choice=None,
            response_format=None,
            temperature=None,
            max_tokens=None,
            seed=None,
        )
        assert "reasoning" in step_body, f"missing reasoning on {model}"
        assert step_body["reasoning"].get("effort") == "xhigh", f"bad effort on {model}"

    # Browser-use dump must record effective effort (xhigh), not None.
    from providers.rose.client import _browser_use_dump_config
    from providers.rose.types import RoseResponse

    fake_resp = RoseResponse(
        content="",
        tool_calls=[],
        reasoning="",
        actual_model="openai/gpt-5.6-sol",
        pool_name="rose-1-browser-use",
        request_id="dump-effort",
        usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    )
    dump = _browser_use_dump_config(
        pool_spec=browser_pool,
        response=fake_resp,
        mode="waterfall",
        max_tokens=16000,
        temperature=1.0,
        include_screenshot=False,
        call_site="browser_use_step_4",
        deadline_s=60.0,
        claude_auth=None,
        gpt_auth=None,
        available_actions=["click"],
        tools=[],
        tool_choice="auto",
    )
    # The browser pool's OpenRouter waterfall sends its pinned effort, not the default.
    assert browser_pool.waterfall_reasoning_effort == "low"
    assert dump["reasoning_effort"] == "low"
    assert dump["effective_params"]["reasoning_effort"] == "low"
    assert dump["requested_params"]["reasoning_effort"] is None

    # Inventory: every agents-side body builder stamps non-empty effort.
    inventory = {
        "anthropic": anthropic["output_config"]["effort"],
        "codex": codex["reasoning"]["effort"],
        "openrouter": openrouter["reasoning"]["effort"],
    }
    for label, effort in inventory.items():
        assert isinstance(effort, str) and effort, f"{label} missing effort: {effort!r}"


def test_all_rose_llm_call_sites_rely_on_builder_effort_default():
    """Structural: every agents RoseClient call path either passes effort or
    omits it (builder fills xhigh). No call site may pass effort='' / falsy
    sentinel that would skip stamping.
    """
    import ast
    from pathlib import Path

    agents_root = Path(__file__).resolve().parents[2]
    # helpers/llm.py is the choke point for agent LLM calls.
    llm_py = (agents_root / "helpers" / "llm.py").read_text()
    tree = ast.parse(llm_py)
    # Collect keyword names used in call_llm / collect / complete invocations
    # that set effort= — ensure none pass empty string.
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        for kw in node.keywords:
            if kw.arg == "effort" and isinstance(kw.value, ast.Constant):
                assert kw.value.value not in ("", None), (
                    f"helpers/llm.py must not pass empty effort at line {node.lineno}"
                )


async def test_waterfall_falls_through_then_succeeds():
    """First model returns 500 → second model streams clean response."""
    call_log: list[str] = []
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    state = {"i": 0}

    efforts: list[str] = []

    def handler(req):
        call_log.append(str(req.url))
        body = json.loads(req.content.decode())
        efforts.append(body.get("reasoning", {}).get("effort"))
        i = state["i"]
        state["i"] += 1
        if i == 0:
            return httpx.Response(500, text="boom")
        return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    spec = get_pool("rose-1-flash")
    chunks = await _drain(
        waterfall_complete(
            pool_spec=spec,
            messages=[{"role": "user", "content": "hi"}],
            openrouter_key="ork-test",
            request_id="r-wf",
        )
    )
    kinds = [c.kind for c in chunks]
    assert "content" in kinds
    assert kinds[-1] == "done"
    # Both steps were called, and the speed pool pins waterfall effort low.
    assert state["i"] == 2
    assert efforts == ["low", "low"]


def _offline_waterfall_streaming_client(handler):
    from helpers import httpx_capture

    # The capture harness buffers bodies. Keep the real HTTP streaming boundary
    # over an offline transport so header and partial-output failures stay distinct.
    with patch.object(httpx.AsyncClient, "__init__", httpx_capture._original_init or httpx.AsyncClient.__init__):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), trust_env=False)


async def test_waterfall_raw_tls_failure_before_headers_uses_existing_next_model():
    spec = get_pool("rose-1-ultra")
    messages = [{"role": "system", "content": "unchanged rules"}, {"role": "user", "content": "unchanged request"}]
    completed = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "existing fallback"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 2, "completion_tokens": 2, "total_tokens": 4}},
            ]
        )
    )

    # The handled read-error control and captured raw TLS alert must take the
    # same bounded next-model path, with one attempt per unchanged pool member.
    for failure in (
        httpx.ReadError("offline header read failed"),
        ssl.SSLError(1, "[SSL: SSLV3_ALERT_BAD_RECORD_MAC] sslv3 alert bad record mac"),
    ):
        bodies = []

        def handler(request):
            assert request.url.host == "openrouter.ai"
            body = json.loads(request.content)
            bodies.append(body)
            if body["model"] == spec.waterfall[0]:
                raise failure
            return httpx.Response(200, text=completed, headers={"Content-Type": "text/event-stream"})

        streaming_client = _offline_waterfall_streaming_client(handler)
        with patch("providers.rose.transport.get_streaming_http_client", return_value=streaming_client):
            async with streaming_client:
                chunks = await _drain(
                    waterfall_complete(
                        pool_spec=spec,
                        messages=messages,
                        max_tokens=16384,
                        openrouter_key="offline-fake",
                        request_id="raw-tls-waterfall-before-headers",
                    )
                )
        assert [body["model"] for body in bodies] == list(spec.waterfall)
        assert bodies[0]["messages"] == bodies[1]["messages"]
        assert all(body["max_tokens"] == 16384 for body in bodies)
        assert "".join(chunk.data.get("text", "") for chunk in chunks if chunk.kind == "content") == "existing fallback"
        assert chunks[-1].kind == "done"
        assert streaming_client.is_closed


async def test_waterfall_raw_tls_failure_after_productive_output_preserves_cause_without_replay():
    spec = get_pool("rose-1-ultra")
    failure = ssl.SSLError(1, "[SSL: SSLV3_ALERT_BAD_RECORD_MAC] sslv3 alert bad record mac")
    models_seen = []
    closed = []
    chunks = []

    class InterruptedStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            raise failure

        async def aclose(self):
            closed.append(True)

    def handler(request):
        assert request.url.host == "openrouter.ai"
        model = json.loads(request.content)["model"]
        models_seen.append(model)
        assert model == spec.waterfall[0], "productive output must prevent a second model attempt"
        return httpx.Response(200, stream=InterruptedStream(), headers={"Content-Type": "text/event-stream"})

    streaming_client = _offline_waterfall_streaming_client(handler)
    with patch("providers.rose.transport.get_streaming_http_client", return_value=streaming_client):
        async with streaming_client:
            try:
                async for chunk in waterfall_complete(
                    pool_spec=spec,
                    messages=[{"role": "user", "content": "unchanged request"}],
                    openrouter_key="offline-fake",
                    request_id="raw-tls-waterfall-after-output",
                ):
                    chunks.append(chunk)
                raise AssertionError("a partial failed stream must remain an error")
            except RoseError as error:
                assert not isinstance(error, RoseAllFailed)
                assert error.__cause__ is failure
    assert models_seen == [spec.waterfall[0]]
    assert "".join(chunk.data.get("text", "") for chunk in chunks if chunk.kind == "content") == "partial"
    assert not any(chunk.kind == "done" for chunk in chunks)
    assert closed == [True]
    assert streaming_client.is_closed


async def test_waterfall_raw_tls_failure_on_all_models_preserves_exact_step_errors():
    spec = get_pool("rose-1-ultra")
    models_seen = []
    failures = {
        model: ssl.SSLError(1, "[SSL: SSLV3_ALERT_BAD_RECORD_MAC] sslv3 alert bad record mac")
        for model in spec.waterfall
    }

    def handler(request):
        assert request.url.host == "openrouter.ai"
        model = json.loads(request.content)["model"]
        models_seen.append(model)
        raise failures[model]

    streaming_client = _offline_waterfall_streaming_client(handler)
    with patch("providers.rose.transport.get_streaming_http_client", return_value=streaming_client):
        async with streaming_client:
            try:
                await _drain(
                    waterfall_complete(
                        pool_spec=spec,
                        messages=[{"role": "user", "content": "unchanged request"}],
                        openrouter_key="offline-fake",
                        request_id="raw-tls-waterfall-all-models",
                    )
                )
                raise AssertionError("TLS failure on every model must remain terminal")
            except RoseAllFailed as error:
                assert [step.model for step in error.step_errors] == list(spec.waterfall)
                for step in error.step_errors:
                    assert type(step.error) is RoseError
                    assert step.error.__cause__ is failures[step.model]
                    assert "SSLV3_ALERT_BAD_RECORD_MAC" in str(step.error)
    assert models_seen == list(spec.waterfall)
    assert streaming_client.is_closed


async def test_browser_qwen_prefers_cached_provider_without_affecting_flash():
    """Browser Qwen prefers a cache-capable endpoint on any pool and retains fallback."""
    bodies = []
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )

    def handler(req):
        bodies.append(json.loads(req.content.decode()))
        return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    # A flash-root browser agent runs on rose-1-flash; the browser flag, not the
    # pool, selects the cache-capable endpoint.
    for pool_name, browser_use in (("rose-1-browser-use", True), ("rose-1-flash", True), ("rose-1-flash", False)):
        await _drain(
            waterfall_complete(
                pool_spec=get_pool(pool_name),
                messages=[{"role": "system", "content": "stable rules"}, {"role": "user", "content": "task"}],
                openrouter_key="ork-test",
                request_id=f"r-{pool_name}",
                cache_namespace="browser-task:task-1:browser_use",
                browser_use=browser_use,
            )
        )

    assert [body["model"] for body in bodies] == ["qwen/qwen3.8-27b"] * 3
    for body in bodies[:2]:
        assert body["provider"] == {"order": ["novita"], "allow_fallbacks": True}
        assert body["session_id"] == "browser-task:task-1:browser_use"
    assert "provider" not in bodies[2]


async def test_waterfall_skips_anthropic_for_response_format():
    """OpenRouter Anthropic rejects response_format; waterfall skips to next model."""
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    models_seen: list[str] = []

    def handler(req):
        body = json.loads(req.content.decode())
        models_seen.append(body["model"])
        return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    chunks = await _drain(
        waterfall_complete(
            # rose-1-mini, not ultra: ultra's waterfall no longer contains an
            # Anthropic layer, so it cannot exercise the skip. mini still leads
            # with anthropic/claude-haiku-4.5.
            pool_spec=get_pool("rose-1-mini"),
            messages=[{"role": "user", "content": "hi"}],
            response_format={"type": "json_schema", "json_schema": {"schema": {"type": "object"}}},
            openrouter_key="ork-test",
            request_id="r-skip-anthropic-rf",
        )
    )

    assert models_seen == ["z-ai/glm-5.3-flash"]
    assert any(c.kind == "content" for c in chunks)


async def test_waterfall_uses_anthropic_with_native_tools():
    """Native tools avoid the Anthropic response_format incompatibility."""
    sse_ok = "\n".join(
        _openai_sse(
            [
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call-complete",
                                        "type": "function",
                                        "function": {"name": "attempt_completion", "arguments": "{}"},
                                    }
                                ]
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                },
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    bodies: list[dict] = []

    def handler(req):
        body = json.loads(req.content.decode())
        bodies.append(body)
        return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    chunks = await _drain(
        waterfall_complete(
            # rose-1-mini leads with anthropic/claude-haiku-4.5 — the only
            # remaining pool with an Anthropic waterfall layer.
            pool_spec=get_pool("rose-1-mini"),
            messages=[{"role": "user", "content": "finish"}],
            tools=[
                {
                    "name": "attempt_completion",
                    "description": "Finish the task",
                    "input_schema": {"type": "object", "properties": {}},
                }
            ],
            tool_choice={"name": "attempt_completion"},
            openrouter_key="ork-test",
            request_id="r-anthropic-native-tools",
        )
    )

    assert [body["model"] for body in bodies] == ["anthropic/claude-haiku-4.5"]
    assert "response_format" not in bodies[0]
    assert bodies[0]["tool_choice"] == {
        "type": "function",
        "function": {"name": "attempt_completion"},
    }
    assert any(c.kind == "tool_call" for c in chunks)


async def test_waterfall_excludes_anthropic_family_when_requested():
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    models_seen: list[str] = []

    def handler(req):
        body = json.loads(req.content.decode())
        models_seen.append(body["model"])
        return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    chunks = await _drain(
        waterfall_complete(
            # rose-1-mini: the only pool that still has an Anthropic waterfall
            # layer to exclude (ultra/browser-use are now Anthropic-free).
            pool_spec=get_pool("rose-1-mini"),
            messages=[{"role": "user", "content": "hi"}],
            openrouter_key="ork-test",
            request_id="r-exclude-anthropic",
            exclude_anthropic_family=True,
        )
    )

    assert models_seen == ["z-ai/glm-5.3-flash"]
    assert any(c.kind == "content" for c in chunks)


async def test_ultra_structured_output_falls_through_second_layer_invalid_request():
    """The ultra pool retains a structured-output-capable fallback after its 2nd layer 400s.

    Named for the SLOT, not the model: this pinned `google/gemini-3.1-pro-preview` until that
    model was dropped from the waterfall for 400ing, at which point the test kept passing
    against a model the pool no longer tries. Derive the models from the registry instead.
    """
    ultra_waterfall = [model for model in get_pool("rose-1-ultra").waterfall if not model.startswith("anthropic/")]
    second_layer, third_layer = ultra_waterfall[0], ultra_waterfall[1]
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": '{"ok":true}'}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    models_seen: list[str] = []

    def handler(req):
        body = json.loads(req.content.decode())
        models_seen.append(body["model"])
        if body["model"] == second_layer:
            return httpx.Response(400, text="invalid structured-output argument")
        return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    chunks = await _drain(
        waterfall_complete(
            pool_spec=get_pool("rose-1-ultra"),
            messages=[{"role": "user", "content": "hi"}],
            response_format={"type": "json_schema", "json_schema": {"schema": {"type": "object"}}},
            openrouter_key="ork-test",
            request_id="r-ultra-structured-fallback",
            exclude_anthropic_family=True,
        )
    )

    # A third layer must exist and be reached: a 2-model ultra waterfall would leave structured
    # output with no fallback at all once the second layer rejects the request.
    assert models_seen == [second_layer, third_layer]
    assert any(c.kind == "content" for c in chunks)


async def test_waterfall_all_failed_raises_with_step_errors():
    def handler(req):
        return httpx.Response(503, text="upstream down")

    set_mock_handler(handler)
    spec = get_pool("rose-1-flash")
    raised = False
    try:
        await _drain(
            waterfall_complete(
                pool_spec=spec,
                messages=[{"role": "user", "content": "hi"}],
                openrouter_key="ork-test",
                request_id="r-all-fail",
            )
        )
    except RoseAllFailed as e:
        raised = True
        assert len(e.step_errors) == len(spec.waterfall)
    assert raised


async def test_waterfall_reports_cache_metrics_from_openrouter():
    """Waterfall streams usage with cache fields from prompt_tokens_details."""
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "cached"}, "finish_reason": "stop"}]},
                {
                    "usage": {
                        "prompt_tokens": 500,
                        "completion_tokens": 10,
                        "total_tokens": 510,
                        "prompt_tokens_details": {
                            "cached_tokens": 4500,
                            "cache_write_tokens": 100,
                        },
                    }
                },
            ]
        )
    )

    def handler(req):
        body = json.loads(req.content.decode())
        assert body.get("stream_options") == {"include_usage": True}, (
            "stream_options missing — OpenRouter won't return usage in streaming"
        )
        msgs = body["messages"]
        sys_msg = next((m for m in msgs if m["role"] == "system"), None)
        if sys_msg:
            content = sys_msg["content"]
            if isinstance(content, list):
                assert any(b.get("cache_control") for b in content), "System message missing cache_control breakpoint"
        return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    spec = get_pool("rose-1-flash")
    chunks = await _drain(
        waterfall_complete(
            pool_spec=spec,
            messages=[
                {"role": "system", "content": "you are helpful"},
                {"role": "user", "content": "hello"},
            ],
            openrouter_key="ork-test",
            request_id="r-cache",
        )
    )
    usage_chunk = next(c for c in chunks if c.kind == "usage")
    assert usage_chunk.data["cache_read_input_tokens"] == 4500
    assert usage_chunk.data["cache_creation_input_tokens"] == 100
    assert usage_chunk.data["prompt_tokens"] == 500


# =====================================================================
# Anthropic API-key funded default + shared cooldown
# =====================================================================


def test_anthropic_api_key_headers_use_x_api_key():
    from providers.rose.transport import _anthropic_api_key_headers, _anthropic_headers

    api_hdr = _anthropic_api_key_headers("sk-ant-api03-test")
    assert api_hdr["x-api-key"] == "sk-ant-api03-test"
    assert "Authorization" not in api_hdr  # api-key path must NOT use Bearer
    assert "oauth-2025-04-20" not in api_hdr["anthropic-beta"]
    # OAuth path is the inverse: Bearer, no x-api-key.
    oauth_hdr = _anthropic_headers("oat-token")
    assert oauth_hdr["Authorization"] == "Bearer oat-token"
    assert "x-api-key" not in oauth_hdr


async def test_anthropic_api_key_complete_402_raises_payment_required():
    """402 (out of credits) is classified as RosePaymentRequiredError so the
    client backs the key off rather than retrying it."""
    from providers.rose.claude_auth import anthropic_api_key_complete
    from providers.rose.errors import RosePaymentRequiredError

    def handler(req):
        return httpx.Response(402, json={"error": {"message": "Insufficient credits"}})

    set_mock_handler(handler)
    raised = False
    try:
        await _drain(
            anthropic_api_key_complete(
                pool_spec=get_pool("rose-1-flash"),
                messages=[{"role": "user", "content": "hi"}],
                api_key="sk-ant-api03-test",
                request_id="r-apikey-402",
            )
        )
    except RosePaymentRequiredError:
        raised = True
    assert raised, "expected RosePaymentRequiredError on HTTP 402"


async def test_anthropic_api_key_complete_400_credit_balance_raises_payment_required():
    """Anthropic reports an exhausted API-key balance as HTTP 400, not 402.

    Preserve that exact production response so the client trips the shared
    cooldown instead of treating it as a request-shape error and retrying the
    dead credential for every agent call.
    """
    from providers.rose.claude_auth import anthropic_api_key_complete
    from providers.rose.errors import RosePaymentRequiredError

    def handler(req):
        return httpx.Response(
            400,
            json={
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "message": (
                        "Your credit balance is too low to access the Anthropic API. "
                        "Please go to Plans & Billing to upgrade or purchase credits."
                    ),
                },
            },
        )

    set_mock_handler(handler)
    raised = False
    try:
        await _drain(
            anthropic_api_key_complete(
                pool_spec=get_pool("rose-1-flash"),
                messages=[{"role": "user", "content": "hi"}],
                api_key="sk-ant-api03-test",
                request_id="r-apikey-400-credit",
            )
        )
    except RosePaymentRequiredError:
        raised = True
    assert raised, "expected RosePaymentRequiredError for the captured HTTP 400 credit banner"


async def test_anthropic_api_key_complete_sets_anthropic_suffix():
    """actual_model carries the `-anthropic` suffix (billed), NOT `-claude` ($0)."""
    from providers.rose.claude_auth import anthropic_api_key_complete

    lines = []
    lines += _ev("message_start", {"type": "message_start", "message": {"usage": {"input_tokens": 1}}})
    lines += _ev(
        "content_block_start",
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
    )
    lines += _ev(
        "content_block_delta",
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hi"}},
    )
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev(
        "message_delta",
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}},
    )
    lines += _ev("message_stop", {"type": "message_stop"})
    sse_ok = "\n".join(lines)

    def handler(req):
        return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    chunks = await _drain(
        anthropic_api_key_complete(
            pool_spec=get_pool("rose-1-flash"),
            messages=[{"role": "user", "content": "hi"}],
            api_key="sk-ant-api03-test",
            request_id="r-apikey-suffix",
        )
    )
    meta = next(c for c in chunks if c.kind == "metadata")
    am = meta.data.get("actual_model", "")
    assert am.endswith("-anthropic"), f"expected -anthropic suffix, got {am!r}"
    assert not am.endswith("-claude")


async def test_anthropic_api_key_cooldown_mark_then_on_cooldown():
    """Marking the cooldown flips the in-memory fast path to 'on cooldown'."""
    import providers.rose.client as rc

    rc._reset_anthropic_api_key_cooldown_cache()

    def handler(req):
        # Backend cooldown read/write — answer both harmlessly.
        if req.url.path.endswith("/anthropic-key/cooldown"):
            return httpx.Response(200, json={"onCooldown": False})
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    assert await rc._anthropic_api_key_on_cooldown() is False
    await rc._mark_anthropic_api_key_cooldown("RosePaymentRequiredError")
    assert await rc._anthropic_api_key_on_cooldown() is True  # in-memory fast path
    rc._reset_anthropic_api_key_cooldown_cache()


async def test_gpt_api_key_credit_failure_cools_all_agent_requests_before_foundry():
    """An in-band credit error is tried once, then Foundry serves later calls."""
    import providers.rose.client as rc

    rc._reset_gpt_api_key_cooldown_cache()
    seen = {"openai": 0, "foundry": 0, "cooldown_post": 0, "openrouter": 0}
    shared_cooldown = {"active": False}
    foundry_sse = "\n".join(
        [
            "event: response.output_text.delta",
            'data: {"type":"response.output_text.delta","delta":"Foundry works"}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2,"total_tokens":4}}}',
            "",
            "data: [DONE]",
        ]
    )
    exhausted_sse = "\n".join(
        [
            "event: error",
            'data: {"type":"error","error":{"type":"insufficient_quota","code":"credit_balance_exhausted","message":"You have no credits remaining"}}',
            "",
            "data: [DONE]",
        ]
    )

    def handler(req):
        if str(req.url) == OPENAI_RESPONSES_API_URL:
            seen["openai"] += 1
            return httpx.Response(200, text=exhausted_sse)
        if req.url.host == "a-4989-resource.openai.azure.com":
            seen["foundry"] += 1
            return httpx.Response(200, text=foundry_sse)
        if req.url.path.endswith("/gpt-key/cooldown"):
            return httpx.Response(200, json={"onCooldown": shared_cooldown["active"]})
        if req.url.path.endswith("/token/rate-limited"):
            assert json.loads(req.content)["type"] == "gpt_api_key"
            seen["cooldown_post"] += 1
            shared_cooldown["active"] = True
            return httpx.Response(200, json={"ok": True})
        if req.url.host == "openrouter.ai":
            seen["openrouter"] += 1
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    with patch.dict(
        os.environ,
        {
            "GPT_API_KEY": "sk-proj-test",
            "ANTHROPIC_API_KEY": "",
            "AZURE_FOUNDRY_ENDPOINT": "https://a-4989-resource.openai.azure.com",
            "AZURE_FOUNDRY_API_KEY": "foundry-test-key",
            "AZURE_FOUNDRY_DEPLOYMENTS": "gpt-6-sol",
        },
    ):
        try:
            for attempt in range(2):
                if attempt == 1:
                    # Simulate a different Fly worker with a cold process cache.
                    rc._reset_gpt_api_key_cooldown_cache()
                chunks = await _drain(
                    RoseClient(openrouter_key="ork-x").complete(
                        pool="rose-1-ultra",
                        messages=[{"role": "user", "content": "hi"}],
                    )
                )
                assert any(c.kind == "content" for c in chunks)
        finally:
            rc._reset_gpt_api_key_cooldown_cache()
    assert seen == {"openai": 1, "foundry": 2, "cooldown_post": 1, "openrouter": 0}


async def test_client_openai_api_key_serves_before_anthropic_and_openrouter():
    lines = [
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"Hello GPT"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10,"input_tokens_details":{"cached_tokens":2}}}}',
        "",
        "data: [DONE]",
    ]
    sse_ok = "\n".join(lines)
    seen = {"openai": 0, "anthropic": 0, "openrouter": 0}
    captured: dict[str, object] = {}

    def handler(req):
        if str(req.url) == OPENAI_RESPONSES_API_URL:
            seen["openai"] += 1
            captured["authorization"] = req.headers.get("authorization")
            captured["body"] = json.loads(req.content.decode("utf-8"))
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        if req.url.host == "api.anthropic.com":
            seen["anthropic"] += 1
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        if req.url.host == "openrouter.ai":
            seen["openrouter"] += 1
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    prev_gpt = os.environ.get("GPT_API_KEY")
    prev_anthropic = os.environ.get("ANTHROPIC_API_KEY")
    os.environ["GPT_API_KEY"] = "sk-proj-test"
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-api03-test"
    try:
        chunks = await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
            )
        )
    finally:
        if prev_gpt is None:
            os.environ.pop("GPT_API_KEY", None)
        else:
            os.environ["GPT_API_KEY"] = prev_gpt
        if prev_anthropic is None:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            os.environ["ANTHROPIC_API_KEY"] = prev_anthropic

    body = captured["body"]
    assert isinstance(body, dict)
    assert seen == {"openai": 1, "anthropic": 0, "openrouter": 0}
    assert captured["authorization"] == "Bearer sk-proj-test"
    assert body.get("model") == "gpt-6-sol"
    assert body.get("service_tier") == "priority"
    meta = next((c for c in chunks if c.kind == "metadata"), None)
    assert meta is not None and str(meta.data.get("actual_model", "")).endswith("-openai")


async def test_client_openai_api_key_preserves_tools_without_gpt_auth():
    lines = [
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"using tool"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
        "",
        "data: [DONE]",
    ]
    sse_ok = "\n".join(lines)
    captured: dict[str, object] = {}

    def handler(req):
        if str(req.url) == OPENAI_RESPONSES_API_URL:
            captured["body"] = json.loads(req.content.decode("utf-8"))
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    prev_gpt = os.environ.get("GPT_API_KEY")
    os.environ["GPT_API_KEY"] = "sk-proj-test"
    tools = [
        {
            "type": "function",
            "function": {
                "name": "lookup",
                "description": "Look up a value",
                "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
            },
        }
    ]
    try:
        await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "use a tool"}],
                tools=tools,
            )
        )
    finally:
        if prev_gpt is None:
            os.environ.pop("GPT_API_KEY", None)
        else:
            os.environ["GPT_API_KEY"] = prev_gpt

    body = captured["body"]
    assert isinstance(body, dict)
    assert body["tools"][0]["name"] == "lookup"
    assert body["tool_choice"] == "required"
    assert "text" not in body, "native tools should suppress JSON response_format on funded GPT route"


async def test_client_openai_api_key_failure_falls_through_to_anthropic_before_openrouter():
    import providers.rose.client as rc

    rc._reset_gpt_api_key_cooldown_cache()
    lines = [
        "event: content_block_delta",
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic"}}',
        "",
        "event: message_delta",
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
    ]
    sse_ok = "\n".join(lines)
    seen = {"openai": 0, "anthropic": 0, "openrouter": 0}

    def handler(req):
        if str(req.url) == OPENAI_RESPONSES_API_URL:
            seen["openai"] += 1
            return httpx.Response(401, json={"error": {"message": "bad key"}})
        if req.url.host == "api.anthropic.com":
            seen["anthropic"] += 1
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        if req.url.host == "openrouter.ai":
            seen["openrouter"] += 1
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        if req.url.path.endswith("/anthropic-key/cooldown"):
            return httpx.Response(200, json={"onCooldown": False})
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    prev_gpt = os.environ.get("GPT_API_KEY")
    prev_anthropic = os.environ.get("ANTHROPIC_API_KEY")
    os.environ["GPT_API_KEY"] = "sk-proj-test"
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-api03-test"
    try:
        chunks = await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
            )
        )
    finally:
        if prev_gpt is None:
            os.environ.pop("GPT_API_KEY", None)
        else:
            os.environ["GPT_API_KEY"] = prev_gpt
        if prev_anthropic is None:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            os.environ["ANTHROPIC_API_KEY"] = prev_anthropic
        rc._reset_gpt_api_key_cooldown_cache()

    assert seen == {"openai": 1, "anthropic": 1, "openrouter": 0}
    meta = next((c for c in chunks if c.kind == "metadata"), None)
    assert meta is not None and str(meta.data.get("actual_model", "")).endswith("-anthropic")


async def test_client_gpt_token_usage_limit_falls_back_to_openai_api_key():
    """A GPT/Codex compute token that hits `usage_limit_reached` (the exact
    ChatGPT-plan 429 that blocked the deploy Codex smoke) must fall back to the
    funded OpenAI API key in `GPT_API_KEY` — not straight to the OpenRouter
    waterfall. This is the same env-driven path that runs on prod and during a
    real agent run, so the whole request goes through the real transport stack.
    """
    openai_lines = [
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"served by openai key"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":6,"output_tokens":4,"total_tokens":10}}}',
        "",
        "data: [DONE]",
    ]
    openai_sse = "\n".join(openai_lines)
    # Matches the Codex 429 shape documented in providers/rose/gpt_auth.py.
    codex_429_body = {
        "error": {
            "type": "usage_limit_reached",
            "plan_type": "pro",
            "resets_in_seconds": 88465,
        }
    }
    seen = {"codex": 0, "openai": 0, "openrouter": 0}
    captured: dict[str, object] = {}

    def handler(req):
        url = str(req.url)
        if "chatgpt.com/backend-api/codex/responses" in url:
            seen["codex"] += 1
            return httpx.Response(429, json=codex_429_body)
        if url == OPENAI_RESPONSES_API_URL:
            seen["openai"] += 1
            captured["authorization"] = req.headers.get("authorization")
            captured["body"] = json.loads(req.content.decode("utf-8"))
            return httpx.Response(200, text=openai_sse, headers={"Content-Type": "text/event-stream"})
        if req.url.host == "openrouter.ai":
            seen["openrouter"] += 1
            return httpx.Response(500, text="waterfall should not be reached")
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    prev_gpt = os.environ.get("GPT_API_KEY")
    os.environ["GPT_API_KEY"] = "sk-proj-test"
    try:
        # No-op the 429 backoff so the codex-token retries don't sleep.
        with patch("providers.rose.gpt_auth.asyncio.sleep", new=AsyncMock(return_value=None)):
            chunks = await _drain(
                RoseClient(openrouter_key="ork-x").complete(
                    pool="rose-1-ultra",
                    messages=[{"role": "user", "content": "hi"}],
                    gpt_auth=gpt_auth_from_token("exhausted-codex-token", "acct_123"),
                    call_site="test-gpt-usage-limit-openai-fallback",
                )
            )
    finally:
        if prev_gpt is None:
            os.environ.pop("GPT_API_KEY", None)
        else:
            os.environ["GPT_API_KEY"] = prev_gpt

    # The exhausted codex token was tried and the funded OpenAI key served the
    # response; the OpenRouter waterfall was never reached.
    assert seen["codex"] >= 1
    assert seen["openai"] == 1
    assert seen["openrouter"] == 0
    assert captured["authorization"] == "Bearer sk-proj-test"
    body = captured["body"]
    assert isinstance(body, dict)
    assert body.get("model") == "gpt-6-sol"

    content = "".join(c.data.get("text", "") for c in chunks if c.kind == "content")
    assert content == "served by openai key"
    meta = next((c for c in chunks if c.kind == "metadata"), None)
    assert meta is not None
    assert str(meta.data.get("actual_model", "")).endswith("-openai")
    # The classified token failure is surfaced so callers can see WHY it fell back.
    assert meta.data.get("gpt_token_error") == "rate_limit"


async def test_client_raw_tls_failure_before_headers_uses_funded_fallback():
    """The captured raw TLS alert must fall through before any output is exposed."""
    seen = {"codex": 0, "openai": 0, "openrouter": 0}
    failure = ssl.SSLError(1, "[SSL: SSLV3_ALERT_BAD_RECORD_MAC] sslv3 alert bad record mac")
    completed = (
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"funded fallback"}\n\n'
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2,"total_tokens":4}}}\n\n'
    )

    def handler(request):
        if request.url.host == "chatgpt.com":
            seen["codex"] += 1
            raise failure
        if str(request.url) == OPENAI_RESPONSES_API_URL:
            seen["openai"] += 1
            return httpx.Response(200, text=completed, headers={"Content-Type": "text/event-stream"})
        if request.url.host == "openrouter.ai":
            seen["openrouter"] += 1
            raise AssertionError("funded fallback must complete before the waterfall")
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    with patch.dict(os.environ, {"GPT_API_KEY": "offline-fake", "ANTHROPIC_API_KEY": ""}):
        chunks = await _drain(
            RoseClient(openrouter_key="offline-fake").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "unchanged request"}],
                gpt_auth=gpt_auth_from_token("offline-token", "offline-account"),
                call_site="test-raw-tls-before-headers",
                dump_context=False,
            )
        )
    assert seen == {"codex": 1, "openai": 1, "openrouter": 0}, seen
    assert "".join(chunk.data.get("text", "") for chunk in chunks if chunk.kind == "content") == "funded fallback"
    metadata = [chunk.data for chunk in chunks if chunk.kind == "metadata"]
    assert len(metadata) == 1, metadata
    assert metadata[0]["actual_model"].endswith("-openai")
    assert metadata[0]["gpt_token_error"] == "server_error"


async def test_cerebras_and_foundry_raw_tls_failures_become_route_errors():
    """A raw TLS alert before output must be a Rose route error so later routes still run."""
    import types

    import providers.rose.cerebras as cb
    import providers.rose.foundry as foundry
    from providers.rose.pools import foundry_model

    failure = ssl.SSLError(1, "[SSL: SSLV3_ALERT_BAD_RECORD_MAC] sslv3 alert bad record mac")
    messages = [{"role": "user", "content": "unchanged request"}]
    provider_requests = []

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"rateLimitedUntil": None})
        provider_requests.append(request.url.host)
        raise failure

    set_mock_handler(handler)
    try:
        await _drain(
            cb.cerebras_complete(
                pool_spec=get_pool("rose-1-flash"),
                messages=messages,
                cerebras_key="offline-provider-key",
                request_id="raw-tls-cerebras",
            )
        )
        raise AssertionError("a raw TLS alert must not complete the Cerebras route")
    except RoseError as error:
        assert error.__cause__ is failure
    assert len(provider_requests) == 1

    deployment = foundry_model(get_pool("rose-1-ultra"))
    env = {
        "AZURE_FOUNDRY_ENDPOINT": "https://offline.invalid",
        "AZURE_FOUNDRY_API_KEY": "offline",
        "AZURE_FOUNDRY_DEPLOYMENTS": deployment,
    }
    real = httpx.AsyncClient
    module_httpx = types.SimpleNamespace(
        AsyncClient=lambda **kw: real(transport=httpx.MockTransport(handler), trust_env=False),
        Timeout=httpx.Timeout,
        Headers=httpx.Headers,
        TransportError=httpx.TransportError,
    )
    with (
        patch.object(foundry, "httpx", module_httpx),
        patch.object(foundry, "os", types.SimpleNamespace(environ=env, getenv=lambda k, v=None: env.get(k, v))),
        patch.object(foundry, "_auth_cooldown_until", {}),
        patch.object(foundry, "_cooldown_until", {}),
    ):
        try:
            await _drain(
                foundry.foundry_complete(
                    pool_spec=get_pool("rose-1-ultra"),
                    messages=messages,
                    response_format=None,
                    tools=None,
                    context_tools=None,
                    tool_choice=None,
                    temperature=None,
                    effort=None,
                    provider_fast_mode=True,
                    request_id="raw-tls-foundry",
                    route_key="raw-tls",
                    agent_id=None,
                    call_site="test",
                    cache_namespace="raw-tls-cache",
                    ttft_timeout_s=90,
                    idle_timeout_s=120,
                )
            )
            raise AssertionError("a raw TLS alert must not complete the Foundry route")
        except RoseServerError as error:
            assert "SSLError" in str(error)
    assert provider_requests[1:] == ["offline.invalid"]


async def test_client_raw_tls_failure_after_output_preserves_error_without_replay():
    """A TLS alert after productive output must keep the same error and stop."""
    from helpers import httpx_capture

    seen = {"codex": 0, "openai": 0, "openrouter": 0}
    closed = []
    failure = ssl.SSLError(1, "[SSL: SSLV3_ALERT_BAD_RECORD_MAC] sslv3 alert bad record mac")

    class InterruptedStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n'
            raise failure

        async def aclose(self):
            closed.append(True)

    def handler(request):
        if request.url.host == "chatgpt.com":
            seen["codex"] += 1
            return httpx.Response(200, stream=InterruptedStream(), headers={"Content-Type": "text/event-stream"})
        if str(request.url) == OPENAI_RESPONSES_API_URL:
            seen["openai"] += 1
            raise AssertionError("productive output must not switch to the funded route")
        if request.url.host == "openrouter.ai":
            seen["openrouter"] += 1
            raise AssertionError("productive output must not switch to the waterfall")
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    chunks = []
    # The capture harness buffers response bodies. Use the real httpx streaming
    # context over an offline transport to preserve the productive-output boundary.
    with patch.object(httpx.AsyncClient, "__init__", httpx_capture._original_init or httpx.AsyncClient.__init__):
        streaming_client = httpx.AsyncClient(transport=httpx.MockTransport(handler), trust_env=False)
    with (
        patch.dict(os.environ, {"GPT_API_KEY": "offline-fake", "ANTHROPIC_API_KEY": ""}),
        patch("providers.rose.transport.get_streaming_http_client", return_value=streaming_client),
    ):
        async with streaming_client:
            try:
                async for chunk in RoseClient(openrouter_key="offline-fake").complete(
                    pool="rose-1-ultra",
                    messages=[{"role": "user", "content": "unchanged request"}],
                    gpt_auth=gpt_auth_from_token("offline-token", "offline-account"),
                    call_site="test-raw-tls-after-output",
                    dump_context=False,
                ):
                    chunks.append(chunk)
            except ssl.SSLError as error:
                assert error is failure
            else:
                raise AssertionError("the original TLS alert must reach the caller")
    assert seen == {"codex": 1, "openai": 0, "openrouter": 0}, seen
    assert "".join(chunk.data.get("text", "") for chunk in chunks if chunk.kind == "content") == "partial"
    assert closed == [True], closed


async def test_client_codex_404_falls_through_to_waterfall():
    """Codex Cloudflare/edge 404 (empty body — same for garbage tokens) must NOT
    fail the whole complete() call. It must raise RoseServerError (in
    _FALL_THROUGH_ERRORS) so RoseClient walks openai-api-key / OpenRouter
    waterfall. Regression: bare RoseError on 404 aborted spawn-subagents smoke
    3× with `RoseError: Codex 404:` and never reached waterfall.
    """
    import os

    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "waterfall after codex 404"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}},
            ]
        )
    )
    seen = {"codex": 0, "openai": 0, "openrouter": 0}

    def handler(req):
        url = str(req.url)
        if "chatgpt.com/backend-api/codex/responses" in url:
            seen["codex"] += 1
            # Match the live edge failure: HTTP 404, empty body, cf-ray present.
            return httpx.Response(404, text="", headers={"cf-ray": "test-codex-404"})
        if url == OPENAI_RESPONSES_API_URL:
            seen["openai"] += 1
            return httpx.Response(500, text="openai key must not be required for this regression")
        if req.url.host == "openrouter.ai":
            seen["openrouter"] += 1
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    prev_gpt = os.environ.pop("GPT_API_KEY", None)
    prev_anthropic = os.environ.pop("ANTHROPIC_API_KEY", None)
    try:
        chunks = await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
                gpt_auth=gpt_auth_from_token("blocked-codex-token", "acct_404"),
                call_site="test-codex-404-waterfall",
            )
        )
    finally:
        if prev_gpt is not None:
            os.environ["GPT_API_KEY"] = prev_gpt
        if prev_anthropic is not None:
            os.environ["ANTHROPIC_API_KEY"] = prev_anthropic

    assert seen["codex"] >= 1, "Codex route must be attempted"
    assert seen["openrouter"] == 1, "OpenRouter waterfall must serve after Codex 404"
    content = "".join(c.data.get("text", "") for c in chunks if c.kind == "content")
    assert content == "waterfall after codex 404"
    meta = next((c for c in chunks if c.kind == "metadata"), None)
    assert meta is not None
    assert meta.data.get("gpt_token_error") == "server_error"
    assert classify_gpt_token_error(RoseServerError("Codex 404: ", status=404)) == "server_error"


async def test_client_api_key_tier_402_falls_through_to_waterfall():
    """End-to-end: no compute token → funded api-key tier hit → 402 → backs off
    and falls through to the OpenRouter waterfall (which serves the response)."""
    import os

    import providers.rose.client as rc

    rc._reset_anthropic_api_key_cooldown_cache()
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    seen = {"anthropic": 0, "openrouter": 0, "cooldown_post": 0}

    def handler(req):
        host = req.url.host
        path = req.url.path
        if host == "api.anthropic.com":
            seen["anthropic"] += 1
            return httpx.Response(402, json={"error": {"message": "Insufficient credits"}})
        if host == "openrouter.ai":
            seen["openrouter"] += 1
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        if path.endswith("/anthropic-key/cooldown"):
            return httpx.Response(200, json={"onCooldown": False})
        if path.endswith("/token/rate-limited"):
            seen["cooldown_post"] += 1
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    prev = os.environ.get("ANTHROPIC_API_KEY")
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-api03-test"
    try:
        chunks = await _drain(
            RoseClient().complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
            )
        )
    finally:
        if prev is None:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            os.environ["ANTHROPIC_API_KEY"] = prev
        rc._reset_anthropic_api_key_cooldown_cache()

    assert seen["anthropic"] == 1, f"api-key tier should be tried once, got {seen['anthropic']}"
    assert seen["openrouter"] >= 1, "should fall through to waterfall"
    assert seen["cooldown_post"] >= 1, "402 should back off the shared key (cooldown POST)"
    assert any(c.kind == "content" for c in chunks), "waterfall should serve content"
    # actual_model must be a waterfall model, NOT the -anthropic api-key suffix.
    meta = next((c for c in chunks if c.kind == "metadata"), None)
    assert meta is not None and not meta.data.get("actual_model", "").endswith("-anthropic")


async def test_client_exclude_anthropic_family_skips_api_key_and_anthropic_waterfall():
    import providers.rose.client as rc

    rc._reset_anthropic_api_key_cooldown_cache()
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    seen = {"anthropic": 0, "openrouter_models": []}

    def handler(req):
        host = req.url.host
        if host == "api.anthropic.com":
            seen["anthropic"] += 1
            return httpx.Response(500, text="anthropic should be skipped")
        if host == "openrouter.ai":
            body = json.loads(req.content.decode())
            seen["openrouter_models"].append(body["model"])
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    prev = os.environ.get("ANTHROPIC_API_KEY")
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-api03-test"
    try:
        chunks = await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                # rose-1-mini: still has an Anthropic waterfall layer to skip.
                pool="rose-1-mini",
                messages=[{"role": "user", "content": "hi"}],
                _exclude_anthropic_family=True,
            )
        )
    finally:
        if prev is None:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            os.environ["ANTHROPIC_API_KEY"] = prev
        rc._reset_anthropic_api_key_cooldown_cache()

    assert seen["anthropic"] == 0
    assert seen["openrouter_models"] == ["z-ai/glm-5.3-flash"]
    assert any(c.kind == "content" for c in chunks)


async def test_client_env_exclude_anthropic_family_applies_to_every_call():
    import providers.rose.client as rc

    rc._reset_anthropic_api_key_cooldown_cache()
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    seen = {"anthropic": 0, "openrouter_models": []}

    def handler(req):
        if req.url.host == "api.anthropic.com":
            seen["anthropic"] += 1
            return httpx.Response(500, text="anthropic should be skipped")
        if req.url.host == "openrouter.ai":
            body = json.loads(req.content.decode())
            seen["openrouter_models"].append(body["model"])
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    with patch.dict(
        os.environ,
        {
            "ANTHROPIC_API_KEY": "sk-ant-api03-test",
            "ROSE_EXCLUDE_ANTHROPIC_FAMILY": "1",
        },
    ):
        chunks = await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                # rose-1-mini: still has an Anthropic waterfall layer to skip.
                pool="rose-1-mini",
                messages=[{"role": "user", "content": "hi"}],
                claude_auth=ClaudeAuthContext(
                    token="sk-ant-oat01-test",
                    source="user",
                    user_id="test-user",
                ),
            )
        )
    rc._reset_anthropic_api_key_cooldown_cache()

    assert seen["anthropic"] == 0
    assert seen["openrouter_models"] == ["z-ai/glm-5.3-flash"]
    assert any(c.kind == "content" for c in chunks)


# =====================================================================
# RoseClient — top-level orchestration
# =====================================================================


async def test_client_collect_waterfall_only_path():
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "hello"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}},
            ]
        )
    )

    def handler(req):
        return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    with patch.dict(os.environ, {"CEREBRAS_API_KEY": ""}, clear=False):
        os.environ.pop("CEREBRAS_API_KEY", None)
        resp = await client.collect(
            pool="rose-1-flash",
            messages=[{"role": "user", "content": "hi"}],
            call_site="test-collect",
        )
    assert resp.content == "hello"
    assert resp.actual_model == get_pool("rose-1-flash").waterfall[0]
    assert resp.usage.get("total_tokens") == 6


async def test_flash_skips_auth_and_hits_cerebras_qwen():
    """rose-fast goes Cerebras qwen-3.8-27b even when Claude/GPT tokens are set."""
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "from-cerebras"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}},
            ]
        )
    )
    seen = {"cerebras": 0, "anthropic": 0, "openrouter": 0, "models": [], "effort": []}

    def handler(req):
        host = req.url.host
        body = json.loads(req.content.decode()) if req.content else {}
        if host == "api.cerebras.ai":
            seen["cerebras"] += 1
            seen["models"].append(body.get("model"))
            seen["effort"].append(body.get("reasoning_effort"))
            assert "cache_control" not in json.dumps(body)
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        if host == "api.anthropic.com":
            seen["anthropic"] += 1
            return httpx.Response(500, text="auth must be skipped")
        if host == "openrouter.ai":
            seen["openrouter"] += 1
            return httpx.Response(500, text="waterfall must not run")
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    with patch.dict(os.environ, {"CEREBRAS_API_KEY": "csk-test"}, clear=False):
        chunks = await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-flash",
                messages=[
                    {
                        "role": "system",
                        "content": [
                            {
                                "type": "text",
                                "text": "you are helpful",
                                "cache_control": {"type": "ephemeral"},
                            }
                        ],
                    },
                    {"role": "user", "content": "hi"},
                ],
                claude_auth=ClaudeAuthContext(token="sk-ant-oat01-test", source="user", user_id="u"),
                gpt_auth=gpt_auth_from_token("gt-test", "acct"),
            )
        )
    assert seen["cerebras"] == 1
    assert seen["anthropic"] == 0
    assert seen["openrouter"] == 0
    assert seen["models"] == ["qwen-3.8-27b"]
    assert seen["effort"] == ["high"]
    assert any(c.kind == "content" and c.data.get("text") == "from-cerebras" for c in chunks)


async def test_flash_cerebras_failure_falls_to_openrouter_qwen():
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "from-or"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}},
            ]
        )
    )
    seen = {"cerebras": 0, "openrouter_models": []}

    def handler(req):
        host = req.url.host
        body = json.loads(req.content.decode()) if req.content else {}
        if host == "api.cerebras.ai":
            seen["cerebras"] += 1
            return httpx.Response(503, text="cerebras down")
        if host == "openrouter.ai":
            seen["openrouter_models"].append(body.get("model"))
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    with patch.dict(os.environ, {"CEREBRAS_API_KEY": "csk-test"}, clear=False):
        chunks = await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-flash",
                messages=[{"role": "user", "content": "hi"}],
                claude_auth=ClaudeAuthContext(token="sk-ant-oat01-test", source="user", user_id="u"),
            )
        )
    assert seen["cerebras"] == 1
    assert seen["openrouter_models"][0] == "qwen/qwen3.8-27b"
    assert any(c.kind == "content" for c in chunks)


def test_cerebras_cooldown_preserves_provider_reset_evidence():
    from providers.rose.cerebras import _provider_cooldown_seconds
    from datetime import datetime, timedelta, timezone
    from email.utils import format_datetime

    cases = [
        ({}, 60.0),
        ({"retry-after": "0"}, 0.0),
        ({"retry-after": "12.5"}, 12.5),
        ({"retry-after": "invalid"}, 60.0),
        ({"retry-after": "nan"}, 60.0),
        ({"retry-after": "1e308"}, 60.0),
        ({"retry-after": format_datetime(datetime.now(timezone.utc) - timedelta(seconds=30))}, 0.0),
        ({"x-ratelimit-remaining-tokens-minute": "0", "x-ratelimit-reset-tokens-minute": "23"}, 23.0),
        (
            {"retry-after": "10", "x-ratelimit-remaining-tokens-minute": "0", "x-ratelimit-reset-tokens-minute": "25"},
            25.0,
        ),
    ]
    for headers, expected in cases:
        assert _provider_cooldown_seconds(httpx.Response(429, headers=headers)) == expected
    assert _provider_cooldown_seconds(httpx.Response(503)) is None
    assert (
        _provider_cooldown_seconds(
            httpx.Response(
                200, headers={"x-ratelimit-remaining-tokens-minute": "0", "x-ratelimit-reset-tokens-minute": "7"}
            )
        )
        == 7
    )
    assert _provider_cooldown_seconds(httpx.Response(200, headers={"x-ratelimit-remaining-tokens-minute": "3"})) is None
    assert (
        _provider_cooldown_seconds(httpx.Response(200, headers={"x-ratelimit-remaining-tokens-minute": "-inf"})) is None
    )


async def test_cerebras_cooldown_skips_known_quota_then_reopens():
    import providers.rose.cerebras as cb
    from types import SimpleNamespace

    cb._reset_cerebras_cooldown_cache()
    clock = SimpleNamespace(now=1000.0)
    seen = {"cerebras": 0, "fallback": 0}
    sse = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "fixture-response"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}},
            ]
        )
    )

    def handler(req):
        body = json.loads(req.content)
        assert body["messages"][-1]["content"] == "unchanged request"
        if req.url.host == "api.cerebras.ai":
            seen["cerebras"] += 1
            if seen["cerebras"] == 1:
                return httpx.Response(429, headers={"retry-after": "30"}, text="fixture rate limit")
        elif req.url.host == "openrouter.ai":
            seen["fallback"] += 1
            assert body["model"] == get_pool("rose-1-flash").waterfall[0]
        else:
            raise AssertionError(f"unexpected host {req.url.host}")
        return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})

    set_mock_handler(handler)
    with (
        patch("providers.rose.cerebras.load_config", lambda: SimpleNamespace()),
        patch("providers.rose.cerebras.time", SimpleNamespace(monotonic=lambda: clock.now)),
        patch.dict(os.environ, {"CEREBRAS_API_KEY": "offline-quota-fixture"}),
    ):
        for _ in range(3):
            response = await RoseClient(openrouter_key="offline-fake").collect(
                pool="rose-1-flash",
                messages=[{"role": "user", "content": "unchanged request"}],
                dump_context=False,
            )
            assert response.content == "fixture-response"
        assert seen == {"cerebras": 1, "fallback": 3}, seen
        clock.now += 31
        await RoseClient(openrouter_key="offline-fake").collect(
            pool="rose-1-flash", messages=[{"role": "user", "content": "unchanged request"}], dump_context=False
        )
        assert seen == {"cerebras": 2, "fallback": 3}, seen
        # Credential rotation cannot inherit the exhausted credential's state.
        first, _ = cb._cooldown_scope("old-key", "qwen-3.8-27b")
        second, _ = cb._cooldown_scope("new-key", "qwen-3.8-27b")
        other_model, _ = cb._cooldown_scope("old-key", "other-model")
        cb._remember_cooldown(first, 60)
        assert await cb._cerebras_on_cooldown(first, "") is True
        assert await cb._cerebras_on_cooldown(second, "") is False
        assert await cb._cerebras_on_cooldown(other_model, "") is False
    cb._reset_cerebras_cooldown_cache()


async def test_cerebras_shared_cooldown_singleflight_and_failures():
    import providers.rose.cerebras as cb
    from datetime import datetime, timedelta, timezone
    from types import SimpleNamespace

    cb._reset_cerebras_cooldown_cache()
    requests = []
    reset = (datetime.now(timezone.utc) + timedelta(seconds=120)).isoformat()
    mode = {"value": "cooled"}

    async def handler(req):
        requests.append(req)
        await asyncio.sleep(0.01)
        if mode["value"] == "failed":
            raise httpx.ConnectError("offline backend unavailable")
        assert req.method == "GET"
        assert req.url.params["model"] == "qwen-3.8-27b"
        assert len(req.url.params["credentialId"]) == 64
        return httpx.Response(200, json={"rateLimitedUntil": reset})

    set_mock_handler(handler)
    with patch(
        "providers.rose.cerebras.load_config",
        lambda: SimpleNamespace(
            backend=SimpleNamespace(api_url="https://backend.invalid", api_key="offline-backend-key")
        ),
    ):
        scope, key = cb._cooldown_scope("never-serialize-this-provider-key", "qwen-3.8-27b")
        results = await asyncio.gather(*(cb._cerebras_on_cooldown(scope, key) for _ in range(10)))
        assert all(results) and len(requests) == 1
        assert "never-serialize-this-provider-key" not in str(requests[0].url)
        # A shorter observed reset cannot shorten existing local cooldown.
        until = cb._cooldowns[scope][0]
        cb._remember_cooldown(scope, 5)
        assert cb._cooldowns[scope][0] >= until
        cb._reset_cerebras_cooldown_cache()
        mode["value"] = "failed"
        assert await cb._cerebras_on_cooldown(scope, key) is False
        await cb._mark_cerebras_cooldown(scope, key, 45)
        assert await cb._cerebras_on_cooldown(scope, key) is True
        # Local mark survives a failed backend write, so the hot path has no RPC.
        assert len(requests) == 3
    cb._reset_cerebras_cooldown_cache()


async def test_cerebras_cooldown_rpc_is_bounded_and_cancellation_isolated():
    import providers.rose.cerebras as cb
    from datetime import datetime, timedelta, timezone

    cb._reset_cerebras_cooldown_cache()
    entered = asyncio.Event()
    release = asyncio.Event()
    seen = []
    reset = (datetime.now(timezone.utc) + timedelta(seconds=120)).isoformat()

    async def handler(req):
        seen.append(req.method)
        entered.set()
        await release.wait()
        return httpx.Response(200, json={"rateLimitedUntil": reset})

    set_mock_handler(handler)
    scope = ("https://backend.invalid", "a" * 64, "qwen-3.8-27b")
    real_client = httpx.AsyncClient

    def offline_client(*args, **kwargs):
        return real_client(transport=httpx.MockTransport(handler), trust_env=False)

    with patch("providers.rose.cerebras.httpx.AsyncClient", offline_client):
        try:
            first = asyncio.create_task(cb._cerebras_on_cooldown(scope, "offline-fake"))
            await entered.wait()
            sibling = asyncio.create_task(cb._cerebras_on_cooldown(scope, "offline-fake"))
            first.cancel()
            try:
                await first
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("caller cancellation was swallowed")
            release.set()
            assert await sibling is True
            assert seen == ["GET"], seen
            cb._reset_cerebras_cooldown_cache()
            release.clear()
            entered.clear()
            # Keep the real RPC budget for the cancellation/response handshake.
            # The short test budget belongs only to requests deliberately held open.
            with patch("providers.rose.cerebras._COOLDOWN_RPC_TIMEOUT_S", 0.04):
                # The mocked request has no IO timeout of its own. A whole-RPC
                # budget must release all ten callers, even with shielded lookup.
                results = await asyncio.wait_for(
                    asyncio.gather(*(cb._cerebras_on_cooldown(scope, "offline-fake") for _ in range(10))), timeout=10
                )
                assert results == [False] * 10
                assert seen == ["GET", "GET"]
                await asyncio.sleep(0)
                assert not cb._cooldown_reads
                await asyncio.wait_for(cb._mark_cerebras_cooldown(scope, "offline-fake", 30), timeout=10)
                assert await cb._cerebras_on_cooldown(scope, "offline-fake") is True
                assert seen == ["GET", "GET", "POST"]
        finally:
            pending = list(cb._cooldown_reads.values())
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            cb._reset_cerebras_cooldown_cache()


async def test_cerebras_successful_quota_headers_do_not_wait_for_shared_mark():
    for finish in ("close", "cancel", "complete"):
        await _assert_cerebras_successful_quota_headers_do_not_wait_for_shared_mark(finish)
        await _assert_cerebras_successful_quota_headers_do_not_wait_for_shared_mark(finish, public=True)


async def _assert_cerebras_successful_quota_headers_do_not_wait_for_shared_mark(finish, *, public=False):
    import providers.rose.cerebras as cb
    from helpers import httpx_capture
    from types import SimpleNamespace

    cb._reset_cerebras_cooldown_cache()
    mark_entered = asyncio.Event()
    mark_release = asyncio.Event()
    mark_finished = asyncio.Event()
    mark_tasks = []
    requests = []
    sse = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "ready"}, "finish_reason": "stop"}]},
            ]
        )
    )

    async def handler(request):
        requests.append(request)
        if request.url.host == "api.cerebras.ai":
            return httpx.Response(
                200,
                text=sse,
                headers={
                    "content-type": "text/event-stream",
                    "x-ratelimit-remaining-tokens-minute": "0",
                    "x-ratelimit-reset-tokens-minute": "30",
                },
            )
        assert request.url.host == "backend.invalid"
        if request.method == "GET":
            return httpx.Response(200, json={"rateLimitedUntil": None})
        assert request.method == "POST"
        mark_tasks.append(asyncio.current_task())
        mark_entered.set()
        try:
            await mark_release.wait()
        finally:
            mark_finished.set()
        return httpx.Response(200, json={"ok": True})

    real_client = httpx.AsyncClient

    def offline_client(*args, **kwargs):
        return real_client(transport=httpx.MockTransport(handler), trust_env=False)

    async def first_content(source):
        async for chunk in source:
            if chunk.kind == "content":
                return chunk
        raise AssertionError("successful provider response produced no content")

    with (
        patch.object(real_client, "__init__", httpx_capture._original_init or real_client.__init__),
        patch("providers.rose.cerebras.httpx.AsyncClient", offline_client),
        patch(
            "providers.rose.cerebras.load_config",
            lambda: SimpleNamespace(
                backend=SimpleNamespace(api_url="https://backend.invalid", api_key="offline-backend-key")
            ),
        ),
        patch("providers.rose.client.load_config", lambda: SimpleNamespace(anthropic=SimpleNamespace(api_key=""))),
        patch("providers.rose.client._cerebras_api_key", return_value="offline-provider-key"),
    ):
        async with offline_client() as stream_client:
            with patch("providers.rose.transport.get_streaming_http_client", return_value=stream_client):
                source = (
                    RoseClient(openrouter_key="offline-fake").complete(
                        pool="rose-1-flash",
                        messages=[{"role": "user", "content": "unchanged request"}],
                        request_id="offline-success-quota",
                        dump_context=False,
                    )
                    if public
                    else cb.cerebras_complete(
                        pool_spec=get_pool("rose-1-flash"),
                        messages=[{"role": "user", "content": "unchanged request"}],
                        cerebras_key="offline-provider-key",
                        request_id="offline-success-quota",
                    )
                )
                next_content = asyncio.create_task(first_content(source))
                finish_stream = None
                try:
                    await asyncio.wait_for(mark_entered.wait(), timeout=10)
                    chunk = await asyncio.wait_for(asyncio.shield(next_content), timeout=10)
                    assert chunk.data["text"] == "ready"
                    scope, key = cb._cooldown_scope("offline-provider-key", get_pool("rose-1-flash").cerebras_model)
                    assert await cb._cerebras_on_cooldown(scope, key) is True
                    assert not mark_finished.is_set()
                    assert [request.method for request in requests] == ["GET", "POST", "POST"]
                    if finish == "close":
                        await source.aclose()
                    else:
                        finish_stream = asyncio.create_task(_drain(source))
                        await asyncio.sleep(0)
                        await asyncio.sleep(0)
                        assert not finish_stream.done(), "stream exited before joining its shared mark"
                        if finish == "cancel":
                            finish_stream.cancel()
                            await asyncio.gather(finish_stream, return_exceptions=True)
                            assert finish_stream.cancelled(), "stream cancellation was swallowed"
                        else:
                            mark_release.set()
                            await asyncio.wait_for(finish_stream, timeout=10)
                    assert mark_finished.is_set(), "stream exit abandoned the shared mark"
                    assert mark_tasks and all(task.done() for task in mark_tasks)
                    assert all(task.cancelled() == (finish != "complete") for task in mark_tasks)
                finally:
                    mark_release.set()
                    if not next_content.done():
                        next_content.cancel()
                    await asyncio.gather(next_content, return_exceptions=True)
                    if finish_stream is not None:
                        if not finish_stream.done():
                            finish_stream.cancel()
                        await asyncio.gather(finish_stream, return_exceptions=True)
                    await source.aclose()
                    await asyncio.gather(*mark_tasks, return_exceptions=True)
                    cb._reset_cerebras_cooldown_cache()


async def test_client_collect_preserves_multiple_unstructured_text_items():
    async def complete(**_kwargs):
        yield StreamChunk(
            kind="content",
            data={
                "text": "hello ",
                "item_id": "text-1",
                "output_index": 0,
                "content_index": 0,
                "phase": "final_answer",
            },
        )
        yield StreamChunk(
            kind="content",
            data={
                "text": "world",
                "item_id": "text-2",
                "output_index": 1,
                "content_index": 0,
                "phase": "final_answer",
            },
        )
        yield StreamChunk(kind="done", data={})

    client = RoseClient(openrouter_key="ork-x")
    client.complete = complete
    response = await client.collect(
        pool="rose-1-flash",
        messages=[{"role": "user", "content": "hi"}],
        call_site="test-collect-multiple-items",
    )

    assert response.content == "hello world"


async def test_client_collect_selects_final_structured_output_item():
    from pydantic import BaseModel

    class Answer(BaseModel):
        answer: str

    async def complete(**_kwargs):
        yield StreamChunk(
            kind="content",
            data={
                "text": '{"answer":"commentary"}',
                "item_id": "commentary",
                "output_index": 0,
                "content_index": 0,
                "phase": "commentary",
            },
        )
        yield StreamChunk(
            kind="content",
            data={
                "text": '{"answer":"final"}',
                "item_id": "final",
                "output_index": 1,
                "content_index": 0,
                "phase": "final_answer",
            },
        )
        yield StreamChunk(kind="done", data={})

    client = RoseClient(openrouter_key="ork-x")
    client.complete = complete
    response = await client.collect(
        pool="rose-1-flash",
        messages=[{"role": "user", "content": "hi"}],
        response_model=Answer,
        call_site="test-collect-structured-items",
    )

    assert response.content == '{"answer":"final"}'


def _cut_off_recovery_handler(replies: dict, seen: list):
    """Mock OpenRouter: `replies[(model, max_tokens)]` is (text, finish_reason)."""

    def handler(req):
        body = json.loads(req.content)
        key = (body["model"], body.get("max_tokens"))
        seen.append(key)
        text, finish = replies[key]
        sse = "\n".join(
            _openai_sse(
                [
                    {"choices": [{"delta": {"content": text}, "finish_reason": finish}]},
                    {"usage": {"prompt_tokens": 5, "completion_tokens": 9, "total_tokens": 14}},
                ]
            )
        )
        return httpx.Response(200, text=sse, headers={"Content-Type": "text/event-stream"})

    return handler


async def test_collect_retries_a_cut_off_reply_with_a_larger_limit_then_the_next_model():
    """A structured reply cut off at the output limit is never re-asked unchanged."""
    from pydantic import BaseModel

    class Answer(BaseModel):
        answer: str

    seen: list = []
    set_mock_handler(
        _cut_off_recovery_handler(
            {
                ("qwen/qwen3.8-27b", 2048): ('{"answer":"cut', "length"),
                ("qwen/qwen3.8-27b", 16000): ('{"answer":"still cut', "length"),
                ("google/gemini-3.8-flash", 16000): ('{"answer":"ok"}', "stop"),
            },
            seen,
        )
    )
    response = await RoseClient(openrouter_key="ork-x").collect(
        pool="rose-1-flash",
        messages=[{"role": "user", "content": "hi"}],
        response_model=Answer,
        max_tokens=2048,
        call_site="test-cut-off-recovery",
    )

    assert seen == [
        ("qwen/qwen3.8-27b", 2048),
        ("qwen/qwen3.8-27b", 16000),
        ("google/gemini-3.8-flash", 16000),
    ], seen
    assert response.content == '{"answer":"ok"}', response.content
    assert response.actual_model == "google/gemini-3.8-flash", response.actual_model
    # The two abandoned attempts were real spend: their tokens ride on the final
    # usage, per attempt with the model that produced them.
    assert response.usage.get("prompt_tokens") == 15, response.usage
    assert response.usage.get("completion_tokens") == 27, response.usage
    assert response.usage.get("total_tokens") == 42, response.usage
    assert len(response.usage.get("abandoned_attempts") or []) == 2, response.usage
    assert response.usage.get("finish_reason") == "stop", response.usage


async def test_collect_stops_retrying_once_the_larger_limit_is_enough():
    from pydantic import BaseModel

    class Answer(BaseModel):
        answer: str

    seen: list = []
    set_mock_handler(
        _cut_off_recovery_handler(
            {
                ("qwen/qwen3.8-27b", 2048): ('{"answer":"cut', "length"),
                ("qwen/qwen3.8-27b", 16000): ('{"answer":"ok"}', "stop"),
            },
            seen,
        )
    )
    response = await RoseClient(openrouter_key="ork-x").collect(
        pool="rose-1-flash",
        messages=[{"role": "user", "content": "hi"}],
        response_model=Answer,
        max_tokens=2048,
        call_site="test-cut-off-larger-limit",
    )

    assert seen == [("qwen/qwen3.8-27b", 2048), ("qwen/qwen3.8-27b", 16000)], seen
    assert response.content == '{"answer":"ok"}', response.content


async def test_collect_recovers_a_cut_off_reply_that_is_itself_the_result():
    """A plain reply declared as the whole result (a JSON document) is unusable when cut off."""
    seen: list = []
    set_mock_handler(
        _cut_off_recovery_handler(
            {
                ("qwen/qwen3.8-27b", 16384): ('{"outcomes": [{"tool_results": "cut', "length"),
                ("qwen/qwen3.8-27b", 32000): ('{"outcomes": []}', "stop"),
            },
            seen,
        )
    )
    response = await RoseClient(openrouter_key="ork-x").collect(
        pool="rose-1-flash",
        messages=[{"role": "user", "content": "simulate"}],
        max_tokens=16384,
        call_site="test-cut-off-whole-result",
        result_required=True,
    )

    assert seen == [("qwen/qwen3.8-27b", 16384), ("qwen/qwen3.8-27b", 32000)], seen
    assert response.content == '{"outcomes": []}', response.content
    assert len(response.usage.get("abandoned_attempts") or []) == 1, response.usage


async def test_cut_off_recovery_leaves_plain_text_and_non_opted_streams_alone():
    """A cut-off answer in prose is still a partial answer; streams that cannot restart get one attempt."""
    from pydantic import BaseModel

    class Answer(BaseModel):
        answer: str

    seen: list = []
    set_mock_handler(_cut_off_recovery_handler({("qwen/qwen3.8-27b", 2048): ("half an ans", "length")}, seen))
    client = RoseClient(openrouter_key="ork-x")
    response = await client.collect(
        pool="rose-1-flash",
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=2048,
        call_site="test-cut-off-plain-text",
    )
    assert response.content == "half an ans" and len(seen) == 1, (response.content, seen)

    chunks = await _drain(
        client.complete(
            pool="rose-1-flash",
            messages=[{"role": "user", "content": "hi"}],
            response_model=Answer,
            max_tokens=2048,
            call_site="test-cut-off-plain-stream",
        )
    )
    assert len(seen) == 2 and not any(chunk.kind == "restart" for chunk in chunks), seen


def test_cut_off_recovery_limits_model_keys_and_cache_restart():
    from providers.demo_cache.rose_cache import accumulate_chunk, empty_response
    from providers.rose.truncation import escalated_max_tokens, model_key, needs_result

    assert escalated_max_tokens(2048) == 16000
    assert escalated_max_tokens(8192) == 32000
    assert escalated_max_tokens(32000) is None and escalated_max_tokens(None) is None
    assert model_key("qwen/qwen3.8-27b") == model_key("qwen-3.8-27b")
    assert model_key("claude-sonnet-5-claude") == model_key("anthropic/claude-sonnet-5")
    assert model_key("google/gemini-3.8-flash") != model_key("qwen/qwen3.8-27b")
    assert needs_result(tools=[{"name": "click"}], tool_choice=None, response_model=None)
    assert not needs_result(tools=[{"name": "click"}], tool_choice="none", response_model=None)
    assert not needs_result(tools=None, tool_choice=None, response_model=None)

    stored = empty_response()
    accumulate_chunk(stored, StreamChunk(kind="content", data={"text": "abandoned"}))
    accumulate_chunk(stored, StreamChunk(kind="restart", data={}))
    accumulate_chunk(stored, StreamChunk(kind="content", data={"text": "kept"}))
    assert stored["content"] == "kept", stored


async def test_client_collect_emits_common_rose_timing_logs():
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "hello"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}},
            ]
        )
    )

    def handler(req):
        return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})

    logged: list[tuple[str, dict]] = []

    def capture_info(event, *args, **kwargs):
        logged.append((event, kwargs))

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    with patch("providers.rose.client.logger.info", side_effect=capture_info):
        resp = await client.collect(
            pool="rose-1-flash",
            messages=[{"role": "user", "content": "hi"}],
            call_site="test-collect-logging",
        )

    assert resp.content == "hello"
    event_names = [event for event, _ in logged]
    assert "rose.complete.first_chunk" in event_names
    assert "rose.complete.first_productive_chunk" in event_names
    assert "rose.complete.waterfall.done" in event_names

    first_productive = next(kwargs for event, kwargs in logged if event == "rose.complete.first_productive_chunk")
    assert first_productive["kind"] == "content"
    assert first_productive["active_route"] == "waterfall"
    assert first_productive["elapsed_s"] is not None

    done = next(kwargs for event, kwargs in logged if event == "rose.complete.waterfall.done")
    assert done["active_route"] == "waterfall"
    assert done["first_chunk_s"] is not None
    assert done["first_contentful_token_s"] is not None
    assert done["first_productive_kind"] == "content"
    assert done["last_chunk_kind"] == "done"
    assert done["chunk_counts"]["metadata"] >= 1
    assert done["chunk_counts"]["content"] >= 1
    assert done["chunk_counts"]["usage"] == 1
    assert done["chunk_counts"]["done"] == 1


async def test_client_falls_through_from_claude_auth_to_waterfall():
    """Anthropic 401 → fall-through; waterfall succeeds; metadata carries
    `claude_token_error` set to auth_error."""
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )

    def handler(req):
        url = str(req.url)
        if "api.anthropic.com" in url:
            return httpx.Response(401, json={"error": {"message": "expired"}})
        return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-ultra",
        messages=[{"role": "user", "content": "hi"}],
        claude_auth=claude_auth_from_token("expired-token"),
        call_site="test-fallthrough",
    ):
        chunks.append(chunk)
    metadata = next(c for c in chunks if c.kind == "metadata")
    assert metadata.data.get("claude_token_error") == "auth_error"


async def test_client_foundry_stream_exit_closes_http_owner():
    """Public close/cancellation joins the real Foundry HTTP context before returning."""
    from types import SimpleNamespace

    from helpers import httpx_capture
    import providers.rose.foundry as foundry

    failures = []
    for finish in ("close", "cancel", "complete"):
        waiting = asyncio.Event()
        release = asyncio.Event()
        closed = asyncio.Event()
        responses = []
        clients = []
        requests = []

        class Body(httpx.AsyncByteStream):
            def __init__(self, waiting=waiting, release=release, closed=closed):
                self.waiting = waiting
                self.release = release
                self.closed = closed

            async def __aiter__(self):
                yield b'data: {"type":"response.output_text.delta","delta":"ready"}\n\n'
                self.waiting.set()
                await self.release.wait()
                yield (
                    b'data: {"type":"response.completed","response":{"usage":'
                    b'{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n'
                    b"data: [DONE]\n\n"
                )

            async def aclose(self):
                self.closed.set()

        def handler(request, requests=requests, responses=responses, body_type=Body):
            assert request.url.host == "foundry.invalid", "unexpected model route"
            requests.append(request)
            response = httpx.Response(200, stream=body_type(), headers={"content-type": "text/event-stream"})
            responses.append(response)
            return response

        real_client = httpx.AsyncClient

        def offline_client(*args, _real_client=real_client, _handler=handler, _clients=clients, **kwargs):
            client = _real_client(transport=httpx.MockTransport(_handler), trust_env=False)
            _clients.append(client)
            return client

        with (
            patch.object(real_client, "__init__", httpx_capture._original_init or real_client.__init__),
            patch("providers.rose.foundry.httpx.AsyncClient", offline_client),
            patch("providers.rose.client._openai_api_key", return_value=""),
            patch("providers.rose.client._cerebras_api_key", return_value=""),
            patch("providers.rose.client.load_config", lambda: SimpleNamespace(anthropic=SimpleNamespace(api_key=""))),
            patch.object(foundry, "_auth_cooldown_until", {}),
            patch.object(foundry, "_cooldown_until", {}),
            patch.dict(
                os.environ,
                {
                    "AZURE_FOUNDRY_ENDPOINT": "https://foundry.invalid",
                    "AZURE_FOUNDRY_API_KEY": "offline-fake",
                    "AZURE_FOUNDRY_DEPLOYMENTS": "gpt-6-sol",
                },
            ),
        ):
            source = RoseClient(openrouter_key="offline-fake").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "unchanged request"}],
                request_id=f"offline-foundry-{finish}",
                dump_context=False,
            )
            consumer = None
            try:
                while (chunk := await anext(source)).kind != "content":
                    pass
                assert chunk.data["text"] == "ready"
                assert len(requests) == 1 and not closed.is_set()
                if finish == "close":
                    await source.aclose()
                else:
                    consumer = asyncio.create_task(_drain(source))
                    await asyncio.wait_for(waiting.wait(), timeout=10)
                    if finish == "cancel":
                        consumer.cancel()
                        await asyncio.gather(consumer, return_exceptions=True)
                        assert consumer.cancelled(), "consumer cancellation was swallowed"
                    else:
                        release.set()
                        await asyncio.wait_for(consumer, timeout=10)
                assert closed.is_set(), f"{finish} returned before closing Foundry response"
                assert all(response.is_closed for response in responses)
                assert all(client.is_closed for client in clients), f"{finish} abandoned Foundry HTTP client"
                assert len(requests) == 1, "stream exit must not fall through to another model"
            except AssertionError as error:
                failures.append(str(error))
            finally:
                release.set()
                if consumer is not None:
                    if not consumer.done():
                        consumer.cancel()
                    await asyncio.gather(consumer, return_exceptions=True)
                await source.aclose()
                for response in responses:
                    await response.aclose()
                for client in clients:
                    await client.aclose()
                await asyncio.sleep(0)
    assert not failures, "; ".join(failures)


async def test_client_foundry_server_error_falls_through_to_openrouter():
    """A Foundry failure before output must preserve the Ultra waterfall."""
    sse_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "openrouter ok"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    attempted = []

    def handler(req):
        url = str(req.url)
        if "a-4989-resource.openai.azure.com" in url:
            attempted.append("foundry")
            return httpx.Response(500, text="upstream unavailable")
        if "openrouter.ai" in url:
            attempted.append("openrouter")
            return httpx.Response(200, text=sse_ok, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="unexpected route")

    set_mock_handler(handler)
    with patch.dict(
        os.environ,
        {
            "AZURE_FOUNDRY_ENDPOINT": "https://a-4989-resource.openai.azure.com",
            "AZURE_FOUNDRY_API_KEY": "test-key",
            "AZURE_FOUNDRY_DEPLOYMENTS": "gpt-6-sol",
            "GPT_API_KEY": "",
            "ANTHROPIC_API_KEY": "",
        },
    ):
        chunks = await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
                _exclude_anthropic_family=True,
                call_site="test-foundry-server-fallthrough",
            )
        )

    assert attempted == ["foundry", "openrouter"]
    assert next(c for c in chunks if c.kind == "metadata").data["actual_model"] == "openai/gpt-6-sol"
    assert any(c.kind == "content" and c.data.get("text") == "openrouter ok" for c in chunks)


async def test_browser_use_dump_records_foundry_wire_effort_and_temperature():
    """The browser-use dump must record what the Foundry route actually sent (descend R13).

    rose-1-browser-use pins waterfall_reasoning_effort=low for its Foundry fallback,
    and the Responses body carries no temperature; the dump said xhigh / 0.3.
    """
    from helpers import observability

    sent = []
    foundry_sse = "\n".join(
        [
            'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call",'
            '"id":"fc_1","call_id":"call_1","name":"wait","arguments":""}}',
            'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1",'
            '"delta":"{\\"time_ms\\":1}"}',
            'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call",'
            '"id":"fc_1","call_id":"call_1","name":"wait","arguments":"{\\"time_ms\\":1}"}}',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
            "data: [DONE]",
            "",
        ]
    )

    def handler(request):
        if request.url.host.endswith("openai.azure.com"):
            sent.append(json.loads(request.content))
            return httpx.Response(200, text=foundry_sse, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="unexpected route")

    set_mock_handler(handler)
    dumps = []
    with (
        patch.dict(
            os.environ,
            {
                "AZURE_FOUNDRY_ENDPOINT": "https://a-4989-resource.openai.azure.com",
                "AZURE_FOUNDRY_API_KEY": "test-key",
                "CEREBRAS_API_KEY": "",
                "GPT_API_KEY": "",
                "ANTHROPIC_API_KEY": "",
            },
        ),
        patch.object(observability, "dump_llm_context", side_effect=lambda **kw: dumps.append(kw)),
    ):
        await RoseClient(openrouter_key="ork-x").complete_browser_use(
            task="Wait briefly",
            browser_state={"url": "https://example.com", "title": "Example", "dom_tree": "[1] button"},
            action_history=[],
            available_actions=["wait"],
            include_screenshot=False,
            call_site="test-browser-dump-wire-effort",
            deadline_s=30,
            skip_cache_write=True,
        )
    teardown_mock()
    assert len(sent) == 1, sent
    wire = sent[0]
    assert len(dumps) == 1, dumps
    config = dumps[0]["config"]
    assert config["pool_name"] == "foundry"
    assert config["effective_params"]["reasoning_effort"] == wire["reasoning"]["effort"] == "low"
    assert config["reasoning_effort"] == wire["reasoning"]["effort"]
    assert config["effective_params"]["temperature"] == wire.get("temperature")
    assert config["temperature"] == wire.get("temperature")


async def test_client_foundry_region_rate_limit_fails_over_before_openrouter():
    """A rate-limited Azure region hands the Ultra call to another region, not OpenRouter.

    Only when every configured region is cooling does the waterfall continue.
    """
    import providers.rose.foundry as foundry

    regions = {
        "a-4989-resource.openai.azure.com": ("", "key-1"),
        "rose-eastus2.openai.azure.com": ("_2", "key-2"),
        "rose-swedencentral.openai.azure.com": ("_3", "key-3"),
    }
    foundry_sse = "\n".join(
        [
            'data: {"type":"response.output_text.delta","delta":"region ok"}',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
            "data: [DONE]",
            "",
        ]
    )
    openrouter_sse = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "openrouter ok"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    attempted: list[str] = []
    limited: set[str] = set()

    def handler(req):
        host = req.url.host
        if host in regions:
            assert req.headers["api-key"] == regions[host][1], "region used another region's key"
            attempted.append(host)
            if host in limited:
                return httpx.Response(429, headers={"retry-after": "30"})
            return httpx.Response(200, text=foundry_sse, headers={"Content-Type": "text/event-stream"})
        if host == "openrouter.ai":
            attempted.append("openrouter")
            return httpx.Response(200, text=openrouter_sse, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="unexpected route")

    env = {"GPT_API_KEY": "", "ANTHROPIC_API_KEY": "", "CEREBRAS_API_KEY": ""}
    for host, (suffix, key) in regions.items():
        env[f"AZURE_FOUNDRY_ENDPOINT{suffix}"] = f"https://{host}"
        env[f"AZURE_FOUNDRY_API_KEY{suffix}"] = key
        env[f"AZURE_FOUNDRY_DEPLOYMENTS{suffix}"] = "gpt-6-sol"

    async def run(agent_id: str) -> list:
        return await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
                agent_id=agent_id,
                dump_context=False,
                _exclude_anthropic_family=True,
                call_site="test-foundry-region-failover",
            )
        )

    set_mock_handler(handler)
    with (
        patch.dict(os.environ, env),
        patch.object(foundry, "_cooldown_until", {}),
        patch.object(foundry, "_auth_cooldown_until", {}),
    ):
        agent_id = "agent-region-failover"
        plan = [r.host for r, _ in foundry._route_plan(foundry.foundry_regions(), "gpt-6-sol", agent_id)]
        assert sorted(plan) == sorted(regions)
        limited.add(plan[0])
        chunks = await run(agent_id)
        assert attempted == plan[:2], attempted
        assert next(c for c in chunks if c.kind == "metadata").data["actual_model"] == "gpt-6-sol-foundry"
        assert any(c.kind == "content" and c.data.get("text") == "region ok" for c in chunks)

        attempted.clear()
        limited.update(regions)
        chunks = await run(agent_id)
        assert attempted == plan[1:] + ["openrouter"], attempted
        assert any(c.kind == "content" and c.data.get("text") == "openrouter ok" for c in chunks)


async def test_client_foundry_skips_non_https_optional_region_and_keeps_serving():
    """A typo (``http://``) in one optional Foundry slot must not stop Foundry.

    Before 2026-10-19 one non-HTTPS optional region made every Foundry request
    raise ``RoseInvalidRequest`` while ``foundry_configured`` stayed true, so
    every Ultra call left Azure credit for OpenRouter. The bad slot is skipped
    with one warning naming it; a non-HTTPS region 1 still rejects the config.
    """
    import providers.rose.foundry as foundry
    from structlog.testing import capture_logs

    foundry_sse = "\n".join(
        [
            'data: {"type":"response.output_text.delta","delta":"region ok"}',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
            "data: [DONE]",
            "",
        ]
    )
    attempted: list[str] = []

    def handler(req):
        if req.url.host.endswith(".openai.azure.com"):
            attempted.append(f"{req.url.scheme}://{req.url.host}")
        if req.url.host == "a-4989-resource.openai.azure.com" and req.url.scheme == "https":
            return httpx.Response(200, text=foundry_sse, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="unexpected route")

    env = {name: "" for name in foundry.FOUNDRY_REGION_ENV_NAMES}
    env.update(
        {
            "GPT_API_KEY": "",
            "ANTHROPIC_API_KEY": "",
            "CEREBRAS_API_KEY": "",
            "AZURE_FOUNDRY_ENDPOINT": "https://a-4989-resource.openai.azure.com",
            "AZURE_FOUNDRY_API_KEY": "key-1",
            "AZURE_FOUNDRY_DEPLOYMENTS": "gpt-6-sol",
            "AZURE_FOUNDRY_ENDPOINT_7": "http://typo-region.openai.azure.com",
            "AZURE_FOUNDRY_API_KEY_7": "key-7",
            "AZURE_FOUNDRY_DEPLOYMENTS_7": "gpt-6-sol",
        }
    )

    async def run() -> list:
        return await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
                agent_id="agent-insecure-optional-region",
                dump_context=False,
                _exclude_anthropic_family=True,
                call_site="test-foundry-insecure-optional-region",
            )
        )

    set_mock_handler(handler)
    with (
        patch.dict(os.environ, env),
        patch.object(foundry, "_cooldown_until", {}),
        patch.object(foundry, "_auth_cooldown_until", {}),
        patch.object(foundry, "_warned_insecure_regions", set()),
    ):
        with capture_logs() as logs:
            assert foundry.foundry_configured(get_pool("rose-1-ultra"))
            for _ in range(2):
                chunks = await run()
                assert next(c for c in chunks if c.kind == "metadata").data["actual_model"] == "gpt-6-sol-foundry"
                assert any(c.kind == "content" and c.data.get("text") == "region ok" for c in chunks)
        assert attempted == ["https://a-4989-resource.openai.azure.com"] * 2, attempted
        warnings = [entry for entry in logs if entry["event"] == "rose.foundry.region_not_https"]
        assert [entry["env"] for entry in warnings] == ["AZURE_FOUNDRY_ENDPOINT_7"], warnings

        # A non-HTTPS region 1 is still a whole-configuration error.
        os.environ["AZURE_FOUNDRY_ENDPOINT"] = "http://a-4989-resource.openai.azure.com"
        attempted.clear()
        try:
            await _drain(
                foundry.foundry_complete(
                    pool_spec=get_pool("rose-1-ultra"),
                    messages=[{"role": "user", "content": "hi"}],
                    response_format=None,
                    tools=None,
                    context_tools=None,
                    tool_choice=None,
                    temperature=None,
                    effort="high",
                    provider_fast_mode=False,
                    request_id="req-insecure-primary",
                    route_key="agent-insecure-primary",
                    agent_id="agent-insecure-primary",
                    call_site="test",
                    cache_namespace=None,
                    ttft_timeout_s=2,
                    idle_timeout_s=2,
                )
            )
        except RoseInvalidRequest as exc:
            assert "AZURE_FOUNDRY_ENDPOINT must be HTTPS" in str(exc)
        else:
            raise AssertionError("non-HTTPS region 1 must reject the configuration")
        assert attempted == [], attempted


async def test_wmh_pool_uses_its_azure_gpt_6_1_deployment_before_openrouter():
    """Azure credit serves the world model ahead of OpenRouter, on the WMH model.

    The production deployment list (``AZURE_FOUNDRY_DEPLOYMENTS=gpt-6-sol``) names
    Ultra's GPT-6 deployments; it must not route a GPT-6.1 world-model request to
    a different model. OpenRouter credit ran out mid-run on 2026-10-10 (HTTP 402).
    """
    import providers.rose.foundry as foundry

    sse = (
        b'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
        b'data: {"type":"response.completed","response":{"usage":'
        b'{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n'
        b"data: [DONE]\n\n"
    )
    seen = []

    def handler(req):
        if "a-4989-resource.openai.azure.com" in str(req.url):
            body = json.loads(req.content)
            seen.append((body["model"], body["reasoning"]["effort"]))
            return httpx.Response(200, content=sse, headers={"Content-Type": "text/event-stream"})
        seen.append(str(req.url.host))
        return httpx.Response(500, text="unexpected route")

    set_mock_handler(handler)
    with (
        patch.object(foundry, "_auth_cooldown_until", {}),
        patch.object(foundry, "_cooldown_until", {}),
        patch.dict(
            os.environ,
            {
                "AZURE_FOUNDRY_ENDPOINT": "https://a-4989-resource.openai.azure.com",
                "AZURE_FOUNDRY_API_KEY": "test-key",
                "AZURE_FOUNDRY_DEPLOYMENTS": "gpt-6-sol",
                "GPT_API_KEY": "",
                "ANTHROPIC_API_KEY": "",
            },
        ),
    ):
        for pool in ("rose-wmh-gpt61", "rose-1-ultra"):
            chunks = await _drain(
                RoseClient(openrouter_key="ork-x").complete(
                    pool=pool,
                    messages=[{"role": "user", "content": "simulate"}],
                    _exclude_anthropic_family=True,
                    call_site="test-foundry-wmh-deployment",
                )
            )
            assert any(c.kind == "content" and c.data.get("text") == "ok" for c in chunks), (pool, chunks)

    assert seen == [("gpt-6.1-sol", "xhigh"), ("gpt-6-sol", "xhigh")], seen


async def test_gpt56_foundry_turns_cache_markers_into_breakpoints_and_reports_true_writes():
    """GPT-5.6+ caches only at breakpoints (measured on Azure 2026-10-12).

    Rose maps the caller's ordinary ``cache_control`` markers to GPT-5.6+
    ``prompt_cache_breakpoint``s, as it maps them to Anthropic's own markers;
    prompts do not change. Implicit mode stays on, so the latest message is
    still cached for chat-style callers. A reported zero cache write stays zero.
    """
    import providers.rose.foundry as foundry
    from providers.rose.gpt_auth import supports_prompt_cache_breakpoints

    def sse(details):
        usage = {"input_tokens": 1000, "output_tokens": 1, "total_tokens": 1001}
        if details is not None:
            usage["input_tokens_details"] = details
        return (
            b'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
            + b'data: {"type":"response.completed","response":{"usage":'
            + json.dumps(usage).encode()
            + b"}}\n\n"
            + b"data: [DONE]\n\n"
        )

    bodies, replies = [], []

    def handler(req):
        body = json.loads(req.content)
        bodies.append(body)
        if "a-4989-resource.openai.azure.com" in str(req.url):
            return httpx.Response(200, content=replies.pop(0), headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="unexpected route")

    marker = {"type": "ephemeral"}
    messages = [
        {"role": "system", "content": "policy"},
        {"role": "user", "content": [{"type": "text", "text": "unit one", "cache_control": marker}]},
        {"role": "user", "content": [{"type": "text", "text": "unit two", "cache_control": marker}]},
        {"role": "user", "content": "this call only"},
    ]
    set_mock_handler(handler)
    env = {
        "AZURE_FOUNDRY_ENDPOINT": "https://a-4989-resource.openai.azure.com",
        "AZURE_FOUNDRY_API_KEY": "test-key",
        "AZURE_FOUNDRY_DEPLOYMENTS": "gpt-6-sol",
        "GPT_API_KEY": "",
        "ANTHROPIC_API_KEY": "",
    }
    usages = []
    with (
        patch.object(foundry, "_auth_cooldown_until", {}),
        patch.object(foundry, "_cooldown_until", {}),
        patch.dict(os.environ, env),
    ):
        for pool, details in (
            ("rose-wmh-gpt61", {"cached_tokens": 900, "cache_write_tokens": 0}),
            ("rose-1-ultra", {"cached_tokens": 0}),
        ):
            replies.append(sse(details))
            chunks = await _drain(
                RoseClient(openrouter_key="ork-x").complete(
                    pool=pool,
                    messages=messages,
                    _exclude_anthropic_family=True,
                    call_site="test-foundry-breakpoints",
                )
            )
            usages.append(next(c.data for c in chunks if c.kind == "usage"))

    assert [body["model"] for body in bodies] == ["gpt-6.1-sol", "gpt-6-sol"]
    for body in bodies:
        marked = [part.get("prompt_cache_breakpoint") for item in body["input"] for part in item["content"]]
        assert marked == [{"mode": "explicit"}, {"mode": "explicit"}, None]
        assert "prompt_cache_options" not in body and '"cache_control"' not in json.dumps(body["input"])
    # Reported zero writes stay zero; an absent field keeps the inclusive fallback.
    assert usages[0]["cache_creation_input_tokens"] == 0 and usages[0]["cache_read_input_tokens"] == 900
    assert usages[1]["cache_creation_input_tokens"] == 1000
    # Earlier models reject the field; only GPT-5.6 and later receive it.
    assert [
        supports_prompt_cache_breakpoints(m)
        for m in (
            "gpt-5.5",
            "gpt-5",
            "gpt-5.6",
            "gpt-6-sol",
            "gpt-6.1-sol",
            "claude-opus-5-5",
            None,
        )
    ] == [False, False, True, True, True, False, False]


def test_responses_body_marks_every_completed_user_message_without_caller_markers():
    """Replaying 911 real agent calls (2026-10-12) through the measured GPT-5.6+ cache rule:
    implicit mode plus a breakpoint after every user message before the final item cost 0.51x
    of no caching (0.55x implicit only; explicit mode 0.61x). Rose applies it for every caller."""
    from providers.rose.gpt_auth import build_codex_responses_body
    from providers.rose.pools import get_pool

    messages = [
        {"role": "system", "content": "policy"},
        {"role": "user", "content": "stable context"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "c1", "content": "result"},
        {"role": "user", "content": [{"type": "text", "text": "part a"}, {"type": "text", "text": "part b"}]},
        {"role": "user", "content": "this call only"},
    ]
    body = build_codex_responses_body(
        pool_spec=get_pool("rose-wmh-gpt61"),
        messages=messages,
        request_id="r",
        tools=[{"type": "function", "function": {"name": "lookup", "parameters": {}}}],
        cache_breakpoints=True,
    )
    marked = [
        [part.get("prompt_cache_breakpoint") for part in item["content"]]
        if isinstance(item.get("content"), list)
        else item.get("type")
        for item in body["input"]
    ]
    assert marked == [
        [{"mode": "explicit"}],
        "function_call",
        "function_call_output",
        [None, {"mode": "explicit"}],
        [None],
    ], marked
    plain = build_codex_responses_body(pool_spec=get_pool("rose-wmh-gpt61"), messages=messages, request_id="r")
    assert '"prompt_cache_breakpoint"' not in json.dumps(plain), "routes without breakpoint support are unchanged"


def test_responses_body_keeps_at_most_the_latest_50_cache_breakpoints():
    from providers.rose.gpt_auth import build_codex_responses_body
    from providers.rose.pools import get_pool

    messages = [
        {"role": "user", "content": [{"type": "text", "text": f"unit {i}", "cache_control": {"type": "ephemeral"}}]}
        for i in range(60)
    ]
    body = build_codex_responses_body(
        pool_spec=get_pool("rose-wmh-gpt61"), messages=messages, request_id="r", cache_breakpoints=True
    )
    marked = ["prompt_cache_breakpoint" in item["content"][0] for item in body["input"]]
    assert marked == [False] * 10 + [True] * 50
    older = build_codex_responses_body(
        pool_spec=get_pool("rose-wmh-gpt61"),
        model_override="gpt-5.5",
        messages=messages,
        request_id="r",
        cache_breakpoints=True,
    )
    assert '"prompt_cache_breakpoint"' not in json.dumps(older)


async def test_client_foundry_luna_backs_mini_and_speed_pools():
    """Mini, flash and browser-use fall back to Azure gpt-5.6-luna before OpenRouter; oss to DeepSeek-V3.2.

    Speed pools keep the direct Cerebras hop first; Foundry serves only after it
    fails before content. The shared Sol deployment list never receives Luna.
    """
    from providers.rose import cerebras as cerebras_route

    foundry_sse = "\n".join(
        [
            'data: {"type":"response.output_text.delta","delta":"luna ok"}',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
            "data: [DONE]",
            "",
        ]
    )
    cerebras_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "from-cerebras"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    attempted: list[str] = []
    foundry_models: list[str] = []
    foundry_efforts: list[str] = []
    cerebras_status = {"code": 200}

    def handler(req):
        host = req.url.host
        if host == "api.cerebras.ai":
            attempted.append("cerebras")
            if cerebras_status["code"] == 200:
                return httpx.Response(200, text=cerebras_ok, headers={"Content-Type": "text/event-stream"})
            return httpx.Response(cerebras_status["code"], json={"error": {"message": "quota exceeded"}})
        if host == "a-4989-resource.openai.azure.com":
            attempted.append("foundry")
            foundry_body = json.loads(req.content)
            foundry_models.append(foundry_body["model"])
            foundry_efforts.append((foundry_body.get("reasoning") or {}).get("effort"))
            return httpx.Response(200, text=foundry_sse, headers={"Content-Type": "text/event-stream"})
        if host == "openrouter.ai":
            attempted.append("openrouter")
            return httpx.Response(500, text="OpenRouter must not be reached")
        return httpx.Response(200, json={"ok": True})

    async def run(pool: str) -> list:
        return await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool=pool,
                messages=[{"role": "user", "content": "hi"}],
                _exclude_anthropic_family=True,
                call_site=f"test-foundry-luna-{pool}",
            )
        )

    set_mock_handler(handler)
    env = {
        "AZURE_FOUNDRY_ENDPOINT": "https://a-4989-resource.openai.azure.com",
        "AZURE_FOUNDRY_API_KEY": "test-key",
        "AZURE_FOUNDRY_DEPLOYMENTS": "gpt-6-sol",
        "CEREBRAS_API_KEY": "csk-test",
        "GPT_API_KEY": "",
        "ANTHROPIC_API_KEY": "",
    }
    with patch.dict(os.environ, env):
        cerebras_route._reset_cerebras_cooldown_cache()
        chunks = await run("rose-1-flash")
        assert attempted == ["cerebras"], "a healthy Cerebras hop stays primary"
        assert any(c.kind == "content" and c.data.get("text") == "from-cerebras" for c in chunks)

        for pool in ("rose-1-flash", "rose-1-browser-use"):
            attempted.clear()
            cerebras_route._reset_cerebras_cooldown_cache()
            cerebras_status["code"] = 402
            chunks = await run(pool)
            assert attempted == ["cerebras", "foundry"], (pool, attempted)
            assert next(c for c in chunks if c.kind == "metadata").data["actual_model"] == "gpt-5.6-luna-foundry"
            assert any(c.kind == "content" and c.data.get("text") == "luna ok" for c in chunks)

        attempted.clear()
        chunks = await run("rose-1-mini")
        assert attempted == ["foundry"], attempted
        assert next(c for c in chunks if c.kind == "metadata").data["actual_model"] == "gpt-5.6-luna-foundry"

        # The open-weights pool keeps its guarantee on Azure: DeepSeek-V3.2.
        attempted.clear()
        chunks = await run("rose-1-oss")
        assert attempted == ["foundry"], attempted
        assert next(c for c in chunks if c.kind == "metadata").data["actual_model"] == "DeepSeek-V3.2-foundry"
        cerebras_route._reset_cerebras_cooldown_cache()

    assert foundry_models == ["gpt-5.6-luna", "gpt-5.6-luna", "gpt-5.6-luna", "DeepSeek-V3.2"]
    # A fallback layer keeps the pool's fast effort; xhigh TTFT is slow on fast GPT layers.
    assert foundry_efforts == ["low", "low", "low", None], "DeepSeek gets no reasoning params"
    assert get_pool("rose-1-ultra").foundry_enabled


async def test_text_only_foundry_skipped_for_image_requests():
    """rose-1-oss's DeepSeek cannot see screenshots: an image request skips it for
    the vision waterfall, text keeps it, and a vision Foundry model still serves."""
    foundry_sse = "\n".join(
        [
            'data: {"type":"response.output_text.delta","delta":"foundry ok"}',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
            "data: [DONE]",
            "",
        ]
    )
    openrouter_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "kimi ok"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    attempted: list[str] = []
    openrouter_bodies: list[dict] = []

    def handler(req):
        if req.url.host == "a-4989-resource.openai.azure.com":
            attempted.append(f"foundry:{json.loads(req.content)['model']}")
            return httpx.Response(200, text=foundry_sse, headers={"Content-Type": "text/event-stream"})
        if req.url.host == "openrouter.ai":
            body = json.loads(req.content)
            openrouter_bodies.append(body)
            attempted.append(f"openrouter:{body['model']}")
            return httpx.Response(200, text=openrouter_ok, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(200, json={"ok": True})

    image_message = {
        "role": "user",
        "content": [
            {"type": "text", "text": "what is on screen?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}},
        ],
    }

    async def run(pool: str, message: dict) -> list:
        return await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool=pool, messages=[message], _exclude_anthropic_family=True, call_site="test-foundry-vision"
            )
        )

    set_mock_handler(handler)
    env = {
        "AZURE_FOUNDRY_ENDPOINT": "https://a-4989-resource.openai.azure.com",
        "AZURE_FOUNDRY_API_KEY": "test-key",
        "AZURE_FOUNDRY_DEPLOYMENTS": "gpt-6-sol",
        "GPT_API_KEY": "",
        "ANTHROPIC_API_KEY": "",
    }
    with patch.dict(os.environ, env):
        chunks = await run("rose-1-oss", image_message)
        assert attempted == ["openrouter:moonshotai/kimi-k3"], attempted
        assert next(c for c in chunks if c.kind == "metadata").data["actual_model"] == "moonshotai/kimi-k3"
        sent = openrouter_bodies[0]["messages"][-1]["content"]
        assert any(part.get("type") == "image_url" for part in sent), "the screenshot reaches kimi-k3"

        attempted.clear()
        await run("rose-1-oss", {"role": "user", "content": "hi"})
        assert attempted == ["foundry:DeepSeek-V3.2"], attempted

        attempted.clear()
        await run("rose-1-ultra", image_message)
        assert attempted == ["foundry:gpt-6-sol"], attempted


async def test_client_direct_auth_ttft_falls_through_before_first_chunk():
    """RoseClient-level direct-auth TTFT is retriable if no chunk reached the caller."""

    async def stalled_direct_auth(**kwargs):
        await asyncio.sleep(0.05)
        yield StreamChunk(kind="content", data={"text": "too late"})

    async def waterfall_ok(**kwargs):
        yield StreamChunk(kind="metadata", data={"actual_model": "fallback-model", "pool_name": "rose-1-flash"})
        yield StreamChunk(kind="content", data={"text": "fallback ok"})
        yield StreamChunk(
            kind="usage",
            data={
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "actual_model": "fallback-model",
                "pool_name": "rose-1-flash",
                "finish_reason": "stop",
            },
        )
        yield StreamChunk(kind="done", data={})

    client = RoseClient(openrouter_key="ork-x")
    with (
        patch("providers.rose.client._try_claude_auth", stalled_direct_auth),
        patch("providers.rose.client.waterfall_complete", single_step_waterfall(waterfall_ok)),
    ):
        chunks = await _drain(
            client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
                claude_auth=claude_auth_from_token("ct"),
                call_site="test-direct-ttft-fallthrough",
                ttft_timeout_s=0.01,
                idle_timeout_s=0.1,
            )
        )

    assert any(c.kind == "content" and c.data.get("text") == "fallback ok" for c in chunks)
    metadata = next(c for c in chunks if c.kind == "metadata")
    assert metadata.data["claude_token_error"] == "stall"


async def test_client_direct_auth_stall_falls_through_immediately():
    """Single TTFT stall falls through to waterfall on first attempt with
    claude_token_error=='stall' so the workflow's rotation gate fires.

    The escalating stall-retry ladder (20→40→60s TTFT) was removed because
    Anthropic batches 150k responses with a single long TTFB; retries just
    killed connections before the model flushed. The new 45s TTFT covers
    cold-start jitter on its own.
    """
    from types import SimpleNamespace

    from _rose_stream_progress_fixture import _VirtualClock

    # Keep the real event loop while the existing stream fixture owns the
    # client's deadline clock; host scheduling cannot exhaust a 10ms budget.
    clock = _VirtualClock()
    clock_asyncio = SimpleNamespace(
        wait=clock.wait,
        ensure_future=asyncio.ensure_future,
        CancelledError=asyncio.CancelledError,
        create_task=asyncio.create_task,
        wait_for=asyncio.wait_for,
    )
    attempts: list[float] = []

    async def always_stalls(**kwargs):
        attempts.append(kwargs.get("ttft_timeout_s"))
        await clock.sleep(1.0)  # never produces a chunk within the client's budget
        yield StreamChunk(kind="metadata", data={"actual_model": "claude-x-claude"})

    async def waterfall_ok(**kwargs):
        yield StreamChunk(kind="metadata", data={"actual_model": "fallback-model", "pool_name": "rose-1-flash"})
        yield StreamChunk(kind="content", data={"text": "fallback"})
        yield StreamChunk(
            kind="usage",
            data={
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "actual_model": "fallback-model",
                "finish_reason": "stop",
            },
        )
        yield StreamChunk(kind="done", data={})

    client = RoseClient(openrouter_key="ork-x")
    with (
        patch("providers.rose.client._try_claude_auth", always_stalls),
        patch("providers.rose.client.waterfall_complete", single_step_waterfall(waterfall_ok)),
        patch("providers.rose.client.time", SimpleNamespace(monotonic=clock.monotonic)),
        patch("providers.rose.client.asyncio", clock_asyncio),
    ):
        chunks = await _drain(
            client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
                claude_auth=claude_auth_from_token("ct"),
                call_site="test-stall-fallthrough",
                ttft_timeout_s=0.01,
                idle_timeout_s=0.5,
            )
        )

    assert len(attempts) == 1, f"expected single attempt (no retry ladder), got {len(attempts)}"
    metadata = next(c for c in chunks if c.kind == "metadata")
    assert metadata.data["claude_token_error"] == "stall"
    assert any(c.kind == "content" and c.data.get("text") == "fallback" for c in chunks)


async def test_client_direct_auth_stall_marks_token_before_rotation():
    """A TTFT stall backs the compute token off before fetching a replacement."""
    events: list[str] = []
    marked: list[tuple[str, int, str | None]] = []
    fetches: list[str] = []

    async def mark_rate_limited(ctx, cooldown_seconds, rate_limited_until=None, failure_reason=None):
        events.append("mark")
        marked.append((ctx.token, cooldown_seconds, failure_reason))
        return True

    async def fetch_fresh(user_id: str):
        events.append("fetch")
        fetches.append(user_id)
        return GptAuthContext(
            token="fresh-token",
            source="user",
            user_id=user_id,
            account_id="acct_123",
            mark_rate_limited=mark_rate_limited,
            fetch_fresh=None,
            max_rotations=1,
        )

    async def first_token_stalls_then_fresh_succeeds(**kwargs):
        auth = kwargs["auth"]
        if auth.token == "stale-token":
            await asyncio.sleep(1.0)
            yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.4-gpt"})
            return
        yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.4-gpt", "pool_name": "gpt-token"})
        yield StreamChunk(kind="content", data={"text": "fresh ok"})
        yield StreamChunk(
            kind="usage",
            data={
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "actual_model": "gpt-5.4-gpt",
                "finish_reason": "stop",
            },
        )
        yield StreamChunk(kind="done", data={})

    auth = GptAuthContext(
        token="stale-token",
        source="user",
        user_id="user-123",
        account_id="acct_123",
        mark_rate_limited=mark_rate_limited,
        fetch_fresh=fetch_fresh,
        max_rotations=1,
    )
    client = RoseClient(openrouter_key="ork-x")
    with patch("providers.rose.client._try_gpt_auth", first_token_stalls_then_fresh_succeeds):
        chunks = await _drain(
            client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
                gpt_auth=auth,
                call_site="test-stall-cooldown",
                # The assertion is about cooling the stalled token before
                # rotation. Leave room for coverage and host scheduling after
                # the 10 ms TTFT guard fires.
                deadline_s=10.0,
                ttft_timeout_s=0.01,
                idle_timeout_s=0.5,
            )
        )

    assert events == ["mark", "fetch"]
    assert marked == [("stale-token", 600, "stall")]
    assert fetches == ["user-123"]
    assert any(c.kind == "content" and c.data.get("text") == "fresh ok" for c in chunks)


async def test_client_direct_auth_internal_idle_timeout_marks_and_rotates():
    """A direct-auth idle timeout before visible output cools the token and rotates."""
    events: list[str] = []
    marked: list[tuple[str, int, str | None]] = []

    async def mark_rate_limited(ctx, cooldown_seconds, rate_limited_until=None, failure_reason=None):
        events.append("mark")
        marked.append((ctx.token, cooldown_seconds, failure_reason))
        return True

    async def fetch_fresh(user_id: str):
        events.append("fetch")
        return GptAuthContext(
            token="fresh-token",
            source="user",
            user_id=user_id,
            account_id="acct_123",
            mark_rate_limited=mark_rate_limited,
            fetch_fresh=None,
            max_rotations=1,
        )

    async def first_token_idles_then_fresh_succeeds(**kwargs):
        auth = kwargs["auth"]
        if auth.token == "stale-token":
            yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.4-gpt"})
            yield StreamChunk(
                kind="codex_reasoning_item",
                data={"id": "rs_1", "encrypted_content": "opaque", "summary": []},
            )
            await asyncio.sleep(1.0)
            yield StreamChunk(kind="content", data={"text": "too late"})
            return
        yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.4-gpt", "pool_name": "gpt-token"})
        yield StreamChunk(kind="content", data={"text": "fresh ok"})
        yield StreamChunk(
            kind="usage",
            data={
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "actual_model": "gpt-5.4-gpt",
                "finish_reason": "stop",
            },
        )
        yield StreamChunk(kind="done", data={})

    auth = GptAuthContext(
        token="stale-token",
        source="user",
        user_id="user-123",
        account_id="acct_123",
        mark_rate_limited=mark_rate_limited,
        fetch_fresh=fetch_fresh,
        max_rotations=1,
    )
    client = RoseClient(openrouter_key="ork-x")
    with patch("providers.rose.client._try_gpt_auth", first_token_idles_then_fresh_succeeds):
        chunks = await _drain(
            client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
                gpt_auth=auth,
                call_site="test-timeout-stall-cooldown",
                deadline_s=2.0,
                ttft_timeout_s=0.5,
                idle_timeout_s=0.01,
            )
        )

    assert events == ["mark", "fetch"]
    assert marked == [("stale-token", 600, "timeout_stall")]
    assert any(c.kind == "content" and c.data.get("text") == "fresh ok" for c in chunks)


async def test_client_direct_auth_outer_deadline_marks_without_burning_next_token():
    """An exhausted outer deadline cools the active token without consuming another."""
    events: list[str] = []
    marked: list[tuple[str, int, str | None]] = []

    async def mark_rate_limited(ctx, cooldown_seconds, rate_limited_until=None, failure_reason=None):
        events.append("mark")
        marked.append((ctx.token, cooldown_seconds, failure_reason))
        return True

    async def fetch_fresh(user_id: str):
        events.append("fetch")
        return GptAuthContext(
            token="fresh-token",
            source="user",
            user_id=user_id,
            account_id="acct_123",
            mark_rate_limited=mark_rate_limited,
            fetch_fresh=None,
            max_rotations=1,
        )

    async def first_token_hits_deadline_then_fresh_succeeds(**kwargs):
        auth = kwargs["auth"]
        if auth.token == "stale-token":
            yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.4-gpt"})
            while True:
                await asyncio.sleep(0.005)
                yield StreamChunk(
                    kind="codex_reasoning_item",
                    data={"id": "rs_loop", "encrypted_content": "opaque", "summary": []},
                )
        yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.4-gpt", "pool_name": "gpt-token"})
        yield StreamChunk(kind="content", data={"text": "fresh ok"})
        yield StreamChunk(
            kind="usage",
            data={
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "actual_model": "gpt-5.4-gpt",
                "finish_reason": "stop",
            },
        )
        yield StreamChunk(kind="done", data={})

    auth = GptAuthContext(
        token="stale-token",
        source="user",
        user_id="user-123",
        account_id="acct_123",
        mark_rate_limited=mark_rate_limited,
        fetch_fresh=fetch_fresh,
        max_rotations=1,
    )
    client = RoseClient(openrouter_key="ork-x")
    with patch("providers.rose.client._try_gpt_auth", first_token_hits_deadline_then_fresh_succeeds):
        raised = False
        try:
            await _drain(
                client.complete(
                    pool="rose-1-ultra",
                    messages=[{"role": "user", "content": "hi"}],
                    gpt_auth=auth,
                    call_site="test-deadline-stall-cooldown",
                    deadline_s=0.03,
                    # This case owns the outer-deadline boundary. Keep the
                    # inner transport timers far enough away that a loaded CI
                    # event loop cannot make TTFT win the race by accident.
                    ttft_timeout_s=5.0,
                    idle_timeout_s=5.0,
                )
            )
        except RoseDeadlineError as exc:
            raised = "deadline" in str(exc)

    assert raised, "expected exhausted outer deadline to remain terminal"
    assert events == ["mark"]
    assert marked == [("stale-token", 600, "timeout_stall")]


async def test_client_reproduces_rotated_gpt_direct_auth_deadline():
    """Fast local repro for the prod explore stall pattern.

    The prod run waited 90s for TTFT, fetched a fresh compute token, then
    exhausted the 170s rose.complete deadline on the rotated direct GPT route.
    This shrinks those timers to milliseconds while exercising the same client
    branches: direct GPT stall -> fetch_fresh -> rotated direct GPT stall ->
    RoseDeadlineError.
    """

    attempts: list[str] = []
    fetches: list[str] = []

    async def silent_gpt_auth(**kwargs):
        token = kwargs["auth"].token
        attempts.append(token)
        if token == "stale-token":
            raise RoseStallError("rose.complete TTFT exceeded 0.05s")
        if token == "fresh-token":
            yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.4-gpt"})
            yield StreamChunk(kind="content", data={"text": "partial"})
            raise RoseDeadlineError("rose.complete deadline exceeded after 0.2s")
        raise AssertionError(f"unexpected token: {token}")

    async def fetch_fresh(user_id: str):
        fetches.append(user_id)
        return GptAuthContext(
            token="fresh-token",
            source="user",
            user_id=user_id,
            account_id="acct_123",
            fetch_fresh=None,
            max_rotations=1,
        )

    async def silent_waterfall(**kwargs):
        raise RoseDeadlineError("rose.complete deadline exceeded after 0.2s")
        yield StreamChunk(kind="metadata", data={"actual_model": "fallback"})

    async def api_key_on_cooldown():
        return True

    auth = GptAuthContext(
        token="stale-token",
        source="user",
        user_id="user-123",
        account_id="acct_123",
        fetch_fresh=fetch_fresh,
        max_rotations=1,
    )
    client = RoseClient(openrouter_key="ork-x")

    raised = False
    with (
        patch("providers.rose.client._try_gpt_auth", silent_gpt_auth),
        patch("providers.rose.client.waterfall_complete", single_step_waterfall(silent_waterfall)),
        patch("providers.rose.client._anthropic_api_key_on_cooldown", api_key_on_cooldown),
    ):
        try:
            async for _ in client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "repro final explore synthesis"}],
                gpt_auth=auth,
                call_site="explore_agent",
                deadline_s=5.0,
                ttft_timeout_s=0.05,
                idle_timeout_s=0.5,
            ):
                pass
        except RoseDeadlineError as exc:
            raised = "deadline" in str(exc)

    assert raised, "expected the shrunken prod stall to exhaust rose.complete deadline"
    assert attempts == ["stale-token", "fresh-token"]
    assert fetches == ["user-123"]


async def test_client_does_not_use_supplied_gpt_auth_as_fallback():
    """If Claude direct auth fails, a separate supplied GPT auth is not fallback.

    Cross-provider retry must happen only through the compute-token fetch callback.
    """
    waterfall_ok = "\n".join(
        _openai_sse(
            [
                {"choices": [{"delta": {"content": "waterfall"}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
            ]
        )
    )
    calls: list[str] = []

    def handler(req):
        url = str(req.url)
        calls.append(url)
        if "api.anthropic.com" in url:
            return httpx.Response(401, json={"error": {"message": "expired"}})
        if "chatgpt.com/backend-api/codex/responses" in url:
            return httpx.Response(200, text="gpt fallback should not run")
        return httpx.Response(200, text=waterfall_ok, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    response = await client.collect(
        pool="rose-1-ultra",
        messages=[{"role": "user", "content": "hi"}],
        claude_auth=claude_auth_from_token("expired-token"),
        gpt_auth=gpt_auth_from_token("valid-gpt-token", "acct_123"),
        call_site="test-no-gpt-fallback",
    )

    assert response.content == "waterfall"
    assert response.claude_token_error == "auth_error"
    assert any("api.anthropic.com" in call for call in calls)
    assert not any("chatgpt.com/backend-api/codex/responses" in call for call in calls)
    assert any("openrouter.ai" in call for call in calls)


async def test_client_rotates_compute_token_across_providers_before_waterfall():
    """A failed Claude compute token can rotate to GPT in the same Rose call."""
    gpt_lines = []
    gpt_lines += _ev(
        "response.output_text.delta",
        {"type": "response.output_text.delta", "delta": "rotated"},
    )
    gpt_lines += _ev(
        "response.completed",
        {
            "type": "response.completed",
            "response": {"usage": {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}},
        },
    )
    gpt_body = "\n".join(gpt_lines)
    calls: list[str] = []
    marked: list[tuple[str, str]] = []

    async def mark_rate_limited(ctx, cooldown_seconds, rate_limited_until=None, failure_reason=None):
        marked.append((ctx.token_type, failure_reason))
        return True

    async def fetch_fresh(user_id):
        return GptAuthContext(
            token="fresh-gpt",
            account_id="acct-fresh",
            source="pool",
            user_id=user_id,
            pool_token_id="pool-gpt",
            mark_rate_limited=mark_rate_limited,
            fetch_fresh=None,
            max_rotations=3,
        )

    def handler(req):
        url = str(req.url)
        calls.append(url)
        if "api.anthropic.com" in url:
            return httpx.Response(401, json={"error": {"message": "expired"}})
        if "chatgpt.com/backend-api/codex/responses" in url:
            return httpx.Response(200, text=gpt_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="waterfall should not be called")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-ultra",
        messages=[{"role": "user", "content": "hi"}],
        claude_auth=ClaudeAuthContext(
            token="expired-claude",
            source="pool",
            user_id="user-1",
            pool_token_id="pool-claude",
            mark_rate_limited=mark_rate_limited,
            fetch_fresh=fetch_fresh,
            max_rotations=3,
        ),
        call_site="test-compute-rotation",
    ):
        chunks.append(chunk)

    assert marked == [("claude", "auth_error")]
    assert any("api.anthropic.com" in call for call in calls)
    assert any("chatgpt.com/backend-api/codex/responses" in call for call in calls)
    assert not any("openrouter.ai" in call for call in calls)
    assert "".join(c.data.get("text", "") for c in chunks if c.kind == "content") == "rotated"
    usage = next(c for c in chunks if c.kind == "usage").data
    assert usage["gpt_token_rotated"] is True
    assert usage["compute_token_rotated"] is True
    assert usage["compute_token_used"]["type"] == "gpt"
    assert usage["compute_token_used"]["source"] == "pool"
    assert usage["compute_token_used"]["poolTokenId"] == "pool-gpt"


async def test_client_completion_never_serializes_compute_credentials():
    """Leased compute credentials must never leave RoseClient in usage or dumps.

    Prod 2026-10-14..20: every direct-auth `llm.context.dump_updated` event
    carried the leased OAuth access token at
    `output.usage.compute_token_used.accessToken` into ClickHouse fly_logs.
    Downstream consumers only need the non-secret lease identity.
    """
    import tempfile

    import helpers.observability as observability

    expired_secret = "expired-claude-secret-access-token-0123456789"
    fresh_secret = "fresh-gpt-secret-access-token-0123456789"
    gpt_lines = []
    gpt_lines += _ev(
        "response.output_text.delta",
        {"type": "response.output_text.delta", "delta": "rotated"},
    )
    gpt_lines += _ev(
        "response.completed",
        {
            "type": "response.completed",
            "response": {"usage": {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}},
        },
    )
    gpt_body = "\n".join(gpt_lines)

    async def mark_rate_limited(ctx, cooldown_seconds, rate_limited_until=None, failure_reason=None):
        return True

    async def fetch_fresh(user_id):
        return GptAuthContext(
            token=fresh_secret,
            account_id="acct-fresh",
            source="pool",
            user_id=user_id,
            pool_token_id="pool-gpt",
            lineage_key="agent:lineage-1",
            mark_rate_limited=mark_rate_limited,
            fetch_fresh=None,
            max_rotations=3,
        )

    def handler(req):
        url = str(req.url)
        if "api.anthropic.com" in url:
            return httpx.Response(401, json={"error": {"message": "expired"}})
        if "chatgpt.com/backend-api/codex/responses" in url:
            return httpx.Response(200, text=gpt_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="waterfall should not be called")

    set_mock_handler(handler)
    old_dump_root = observability._DUMP_ROOT
    old_is_prod = observability._IS_PRODUCTION
    with tempfile.TemporaryDirectory() as tmp:
        observability._DUMP_ROOT = Path(tmp) / "llm-dumps"
        observability._IS_PRODUCTION = False
        try:
            chunks = []
            async for chunk in RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
                claude_auth=ClaudeAuthContext(
                    token=expired_secret,
                    source="pool",
                    user_id="user-1",
                    pool_token_id="pool-claude",
                    lineage_key="agent:lineage-1",
                    mark_rate_limited=mark_rate_limited,
                    fetch_fresh=fetch_fresh,
                    max_rotations=3,
                ),
                agent_id="agent-credential-dump",
                call_site="test-credential-dump",
            ):
                chunks.append(chunk)
            dumps = [p.read_text() for p in (Path(tmp) / "llm-dumps").rglob("*.json")]
        finally:
            observability._DUMP_ROOT = old_dump_root
            observability._IS_PRODUCTION = old_is_prod

    assert "".join(c.data.get("text", "") for c in chunks if c.kind == "content") == "rotated"
    usage = next(c for c in chunks if c.kind == "usage").data
    assert usage["compute_token_rotated"] is True
    serialized_chunks = json.dumps([c.data for c in chunks], default=str)
    assert dumps, "RoseClient must still write the local LLM dump"
    for secret in (expired_secret, fresh_secret):
        assert secret not in serialized_chunks, "completion stream serialized a compute credential"
        for dump in dumps:
            assert secret not in dump, "LLM dump persisted a compute credential"
    assert usage["compute_token_used"] == {
        "type": "gpt",
        "source": "pool",
        "poolTokenId": "pool-gpt",
        "lineageKey": "agent:lineage-1",
    }


async def test_client_rotation_preserves_native_tool_contract_across_provider_types():
    """A Claude->GPT rotation must retain AgentAction native tools."""
    AgentAction = create_agent_action_model(["spawn_agent", "attempt_completion"])
    captured_gpt_request = {}

    async def rate_limited_claude(**_kwargs):
        if False:
            yield StreamChunk(kind="done", data={})
        raise RoseRateLimitError("Claude OAuth rate limited")

    async def successful_gpt(**kwargs):
        captured_gpt_request.update(kwargs)
        yield StreamChunk(kind="metadata", data={"actual_model": "gpt-5.6-terra-gpt"})
        yield StreamChunk(
            kind="tool_call",
            data={"name": "attempt_completion", "arguments": {}, "id": "call-complete"},
        )
        yield StreamChunk(
            kind="usage",
            data={"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
        )
        yield StreamChunk(kind="done", data={})

    async def fetch_fresh(user_id):
        return GptAuthContext(
            token="fresh-gpt",
            account_id="acct-fresh",
            source="pool",
            user_id=user_id,
            pool_token_id="pool-gpt",
            fetch_fresh=None,
            max_rotations=1,
        )

    auth = ClaudeAuthContext(
        token="rate-limited-claude",
        source="pool",
        user_id="user-1",
        pool_token_id="pool-claude",
        fetch_fresh=fetch_fresh,
        max_rotations=1,
    )
    with (
        patch("providers.rose.client.claude_auth_complete", rate_limited_claude),
        patch("providers.rose.client.gpt_auth_complete", successful_gpt),
    ):
        chunks = await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "Use the browser child"}],
                response_model=AgentAction,
                claude_auth=auth,
                call_site="execute_loop",
            )
        )

    assert any(chunk.kind == "tool_call" for chunk in chunks)
    assert captured_gpt_request["response_format"] is None
    assert {tool["name"] for tool in captured_gpt_request["tools"]} == {
        "spawn_agent",
        "attempt_completion",
    }
    assert captured_gpt_request["tool_choice"] == "any"


async def test_client_waterfall_preserves_native_agent_action_tools():
    """OpenRouter must not receive AgentAction as an incompatible strict schema."""
    AgentAction = create_agent_action_model(["spawn_agent", "attempt_completion"])
    captured_waterfall_request = {}

    async def successful_waterfall(**kwargs):
        captured_waterfall_request.update(kwargs)
        yield StreamChunk(kind="metadata", data={"actual_model": "openai/gpt-5.6-sol"})
        yield StreamChunk(
            kind="tool_call",
            data={"name": "attempt_completion", "arguments": "{}", "id": "call-complete"},
        )
        yield StreamChunk(
            kind="usage",
            data={"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
        )
        yield StreamChunk(kind="done", data={})

    with (
        patch("providers.rose.client._openai_api_key", return_value=""),
        patch("providers.rose.client.waterfall_complete", single_step_waterfall(successful_waterfall)),
    ):
        chunks = await _drain(
            RoseClient(openrouter_key="ork-x").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "Finish the task"}],
                response_model=AgentAction,
                call_site="execute_loop",
                _exclude_anthropic_family=True,
            )
        )

    assert any(chunk.kind == "tool_call" for chunk in chunks)
    assert captured_waterfall_request["response_format"] is None
    assert {tool["name"] for tool in captured_waterfall_request["tools"]} == {
        "spawn_agent",
        "attempt_completion",
    }
    assert captured_waterfall_request["tool_choice"] == "any"


async def test_client_splits_pydantic_model_to_claude_native_tools():
    AgentAction = create_agent_action_model(["wait_for", "attempt_completion"])

    sse_lines = []
    sse_lines += _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 10}},
        },
    )
    sse_lines += _ev(
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {
                "type": "tool_use",
                "id": "toolu_1",
                "name": "wait_for",
                "input": {},
            },
        },
    )
    sse_lines += _ev(
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {
                "type": "input_json_delta",
                "partial_json": '{"description":"the package to ship","condition":"package ships"}',
            },
        },
    )
    sse_lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    sse_lines += _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "tool_use"},
            "usage": {"output_tokens": 5},
        },
    )
    sse_lines += _ev("message_stop", {"type": "message_stop"})
    sse_body = "\n".join(sse_lines)

    seen_body = {}

    def handler(req):
        if "api.anthropic.com" in str(req.url):
            body = json.loads(req.content.decode())
            seen_body.update(body)
            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="waterfall should not be called")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-ultra",
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
    assert wait_schema["required"] == ["description"]
    assert wait_schema["properties"]["check_interval_seconds"]["minimum"] == 60
    assert wait_schema["properties"]["check_interval_seconds"]["maximum"] == 86400

    tool_call = next(c for c in chunks if c.kind == "tool_call")
    assert tool_call.data["name"] == "wait_for"
    assert json.loads(tool_call.data["arguments"]) == {
        "description": "the package to ship",
        "condition": "package ships",
    }


async def test_client_splits_pydantic_model_to_gpt_native_tools():
    AgentAction = create_agent_action_model(["wait_for", "attempt_completion"])

    sse_lines = []
    sse_lines += _ev(
        "response.output_item.done",
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_wait",
                "name": "wait_for",
                "arguments": '{"description":"the package to ship","condition":"package ships"}',
            },
        },
    )
    sse_lines += _ev(
        "response.completed",
        {
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "total_tokens": 15,
                }
            },
        },
    )
    sse_body = "\n".join(sse_lines)

    seen_body = {}

    def handler(req):
        if "chatgpt.com/backend-api/codex/responses" in str(req.url):
            body = json.loads(req.content.decode())
            seen_body.update(body)
            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="waterfall should not be called")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-ultra",
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
    assert tools["wait_for"]["parameters"]["required"] == ["description"]

    metadata = next(c for c in chunks if c.kind == "metadata")
    assert metadata.data["actual_model"].endswith("-gpt")
    tool_call = next(c for c in chunks if c.kind == "tool_call")
    assert tool_call.data["name"] == "wait_for"
    assert json.loads(tool_call.data["arguments"]) == {
        "description": "the package to ship",
        "condition": "package ships",
    }


async def test_client_plain_pydantic_model_uses_claude_output_config():
    from pydantic import BaseModel, Field

    class ProgressScore(BaseModel):
        reasoning: str
        score: float = Field(ge=0, le=1)

    sse_lines = []
    sse_lines += _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 10}},
        },
    )
    sse_lines += _ev(
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        },
    )
    sse_lines += _ev(
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": '{"reasoning":"done","score":1}'},
        },
    )
    sse_lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    sse_lines += _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 5},
        },
    )
    sse_lines += _ev("message_stop", {"type": "message_stop"})
    sse_body = "\n".join(sse_lines)

    seen_body = {}

    def handler(req):
        if "api.anthropic.com" in str(req.url):
            body = json.loads(req.content.decode())
            seen_body.update(body)
            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="waterfall should not be called")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-ultra",
        messages=[{"role": "user", "content": "score progress"}],
        response_model=ProgressScore,
        claude_auth=claude_auth_from_token("valid-token"),
        call_site="test-pydantic-submit-tool",
    ):
        chunks.append(chunk)

    assert "tools" not in seen_body
    assert "tool_choice" not in seen_body
    assert seen_body["output_config"]["format"]["type"] == "json_schema"
    schema = seen_body["output_config"]["format"]["schema"]
    assert schema["properties"]["score"]["type"] == "number"

    content = "".join(c.data.get("text", "") for c in chunks if c.kind == "content")
    assert json.loads(content) == {"reasoning": "done", "score": 1}


async def test_client_plain_pydantic_model_uses_gpt_text_format():
    from pydantic import BaseModel, Field

    class ProgressScore(BaseModel):
        reasoning: str
        score: float = Field(ge=0, le=1)

    sse_lines = []
    sse_lines += _ev(
        "response.output_text.delta",
        {"type": "response.output_text.delta", "delta": '{"reasoning":"done","score":1}'},
    )
    sse_lines += _ev(
        "response.completed",
        {
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "total_tokens": 15,
                }
            },
        },
    )
    sse_body = "\n".join(sse_lines)

    seen_body = {}

    def handler(req):
        if "chatgpt.com/backend-api/codex/responses" in str(req.url):
            body = json.loads(req.content.decode())
            seen_body.update(body)
            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="waterfall should not be called")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-ultra",
        messages=[{"role": "user", "content": "score progress"}],
        response_model=ProgressScore,
        gpt_auth=gpt_auth_from_token("valid-token", "acct_123"),
        call_site="test-gpt-pydantic-submit-tool",
    ):
        chunks.append(chunk)

    assert "tools" not in seen_body
    assert seen_body["tool_choice"] == "auto"
    assert seen_body["text"]["format"]["type"] == "json_schema"
    assert seen_body["text"]["format"]["schema"]["properties"]["score"]["type"] == "number"

    content = "".join(c.data.get("text", "") for c in chunks if c.kind == "content")
    assert json.loads(content) == {"reasoning": "done", "score": 1}


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
            pool="rose-1-flash",
            messages=[{"role": "user", "content": "hi"}],
            call_site="test-deadline",
            deadline_s=0.5,
        ):
            pass
    except RoseError:
        raised = True
    assert raised


async def test_client_ttft_timeout_waits_for_first_productive_chunk():
    """Metadata alone does not satisfy TTFT; first content/tool/reasoning must arrive."""

    async def slow_first_productive_chunk(**kwargs):
        yield StreamChunk(kind="metadata", data={"actual_model": "test-model"})
        await asyncio.sleep(0.05)
        yield StreamChunk(kind="content", data={"text": "late"})

    client = RoseClient(openrouter_key="ork-x")
    raised = False
    with patch("providers.rose.client.waterfall_complete", single_step_waterfall(slow_first_productive_chunk)):
        try:
            async for _ in client.complete(
                pool="rose-1-flash",
                messages=[{"role": "user", "content": "hi"}],
                call_site="test-ttft",
                ttft_timeout_s=0.01,
                idle_timeout_s=0.1,
            ):
                pass
        except RoseStallError as exc:
            raised = "TTFT" in str(exc)
    assert raised


async def test_client_heartbeats_during_ttft_wait():
    """Long TTFT waits must keep Temporal heartbeats alive.

    Regression: a single wait_for(ttft_timeout_s=90) with no intermediate
    heartbeats raced reasoning's activity heartbeat_timeout=90s and cancelled
    dag_reasoning mid-call during cuda-kernel code-agent runs.
    """
    heartbeats: list[str] = []

    async def slow_ttft_then_content(**kwargs):
        await asyncio.sleep(0.35)
        yield StreamChunk(kind="content", data={"text": "hello"})
        yield StreamChunk(kind="done", data={})

    async def skip_api_key(**kwargs):
        raise RoseStallError("skip funded api key for unit test")
        yield  # pragma: no cover — make this an async generator

    client = RoseClient(openrouter_key="ork-x")
    with (
        patch("providers.rose.client._try_openai_api_key", skip_api_key),
        patch("providers.rose.client._try_anthropic_api_key", skip_api_key),
        patch("providers.rose.client.waterfall_complete", single_step_waterfall(slow_ttft_then_content)),
        patch("providers.rose.client._HEARTBEAT_INTERVAL_S", 0.05),
        patch("providers.rose.client._safe_heartbeat", side_effect=lambda msg: heartbeats.append(msg)),
    ):
        texts = []
        async for chunk in client.complete(
            pool="rose-1-flash",
            messages=[{"role": "user", "content": "hi"}],
            call_site="test-ttft-heartbeat",
            ttft_timeout_s=2.0,
            idle_timeout_s=2.0,
        ):
            if chunk.kind == "content":
                texts.append(chunk.data.get("text"))
    assert texts == ["hello"]
    waiting = [h for h in heartbeats if "waiting" in h]
    assert waiting, f"expected waiting heartbeats during TTFT, got {heartbeats!r}"


async def test_client_allows_idle_gap_within_idle_window_after_first_chunk():
    """Idle gaps shorter than `idle_timeout_s` are tolerated after first content."""

    async def slow_second_chunk(**kwargs):
        yield StreamChunk(kind="content", data={"text": "first"})
        await asyncio.sleep(0.02)
        yield StreamChunk(kind="content", data={"text": "late"})

    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    with patch("providers.rose.client.waterfall_complete", single_step_waterfall(slow_second_chunk)):
        async for chunk in client.complete(
            pool="rose-1-flash",
            messages=[{"role": "user", "content": "hi"}],
            call_site="test-idle",
            ttft_timeout_s=0.5,
            idle_timeout_s=0.5,
        ):
            chunks.append(chunk)
    assert [c.data.get("text") for c in chunks if c.kind == "content"] == ["first", "late"]


async def test_client_enforces_idle_timeout_after_first_productive_chunk():
    """A mid-stream stall longer than `idle_timeout_s` raises RoseDeadlineError.

    This is the recovery path for silent half-closed connections: without it,
    the only stop is the overall 120s deadline and the loop retries each
    stalled call after burning the full budget.
    """

    async def stall_after_first(**kwargs):
        yield StreamChunk(kind="content", data={"text": "first"})
        await asyncio.sleep(1.0)
        yield StreamChunk(kind="content", data={"text": "never-arrives"})

    client = RoseClient(openrouter_key="ork-x")
    raised = False
    with patch("providers.rose.client.waterfall_complete", single_step_waterfall(stall_after_first)):
        try:
            async for _ in client.complete(
                pool="rose-1-flash",
                messages=[{"role": "user", "content": "hi"}],
                call_site="test-idle-stall",
                ttft_timeout_s=0.5,
                idle_timeout_s=0.05,
                deadline_s=5.0,
            ):
                pass
        except RoseDeadlineError as exc:
            raised = "idle" in str(exc)
    assert raised, "expected RoseDeadlineError citing idle window"


async def test_client_waterfall_stalled_leg_uses_existing_fallback():
    from _rose_stream_progress_fixture import assert_waterfall_stalled_leg_uses_existing_fallback

    await assert_waterfall_stalled_leg_uses_existing_fallback("recover")


async def test_client_waterfall_failed_parser_leg_discards_metadata():
    from _rose_stream_progress_fixture import assert_waterfall_stalled_leg_uses_existing_fallback

    for scenario in ("empty", "buffered_arguments"):
        await assert_waterfall_stalled_leg_uses_existing_fallback(scenario)


async def test_waterfall_empty_success_keeps_metadata_before_usage_and_done():
    """Successful normalized streams preserve metadata-first even without output."""
    spec = get_pool("rose-1-browser-use")
    calls = []

    async def empty_success(**kwargs):
        calls.append(kwargs["model"])
        yield StreamChunk(kind="metadata", data={"actual_model": kwargs["model"]})
        yield StreamChunk(kind="usage", data={"prompt_tokens": 1, "completion_tokens": 0})
        yield StreamChunk(kind="done", data={})

    with patch("providers.rose.waterfall._stream_one_step", empty_success):
        chunks = await _drain(
            waterfall_complete(
                pool_spec=spec,
                messages=[{"role": "user", "content": "Offline fixture"}],
                openrouter_key="offline-fake",
                request_id="offline-empty-success",
            )
        )
    assert [chunk.kind for chunk in chunks] == ["metadata", "usage", "done"]
    assert chunks[0].data["actual_model"] == spec.waterfall[0]
    assert calls == [spec.waterfall[0]]


async def test_client_waterfall_global_deadline_preserves_error():
    from _rose_stream_progress_fixture import assert_waterfall_stalled_leg_uses_existing_fallback

    await assert_waterfall_stalled_leg_uses_existing_fallback("global_deadline")


async def test_client_waterfall_partial_idle_preserves_error():
    from _rose_stream_progress_fixture import assert_waterfall_stalled_leg_uses_existing_fallback

    await assert_waterfall_stalled_leg_uses_existing_fallback("midstream_idle")


async def test_client_buffered_tool_arguments_keep_real_progress_alive():
    """Actual parsing must not mistake 150s of incoming tool arguments for silence."""
    from _rose_stream_progress_fixture import assert_progress_case

    for protocol in ("openai", "anthropic", "responses"):
        await assert_progress_case(protocol=protocol)
        await assert_progress_case(protocol=protocol, prelude=0)
    await assert_progress_case(prelude=0, consumer_pause=100, expected_time=250.0)


async def test_client_buffered_progress_keeps_silence_and_outer_bounds():
    from _rose_stream_progress_fixture import assert_progress_case

    idle = "rose.complete idle for 120.0s (deadline 590.0s)"
    for mode in ("silence", "metadata", "comments", "empty_tool"):
        await assert_progress_case(mode=mode, expected_error=idle, expected_time=122.55)
    for protocol, mode in (
        ("anthropic", "orphan_anthropic"),
        ("responses", "orphan_responses"),
        ("anthropic", "mismatched_anthropic"),
        ("responses", "completed_responses"),
    ):
        await assert_progress_case(protocol=protocol, mode=mode, expected_error=idle, expected_time=122.55)
    await assert_progress_case(tail_silence=121, expected_error=idle, expected_time=272.55)
    await assert_progress_case(
        seconds=600, expected_error="rose.complete deadline exceeded after 590.0s", expected_time=590.0
    )
    await assert_progress_case(mode="reasoning")


async def test_client_parser_only_progress_preserves_ttft_without_idle_timeout():
    from _rose_stream_progress_fixture import assert_progress_case

    for protocol in ("openai", "anthropic", "responses"):
        await assert_progress_case(
            protocol=protocol,
            prelude=0,
            idle_timeout_s=None,
            expected_error="rose.complete TTFT exceeded 90.0s",
            expected_time=180.0 if protocol == "openai" else 90.0,
            exhausted=protocol == "openai",
        )
    # Once real output reaches the consumer, disabling the idle budget remains
    # supported; the ordinary whole-call deadline still bounds the stream.
    await assert_progress_case(idle_timeout_s=None, expected_time=152.55)


async def test_client_buffered_progress_resets_for_new_waterfall_attempt():
    from _rose_stream_progress_fixture import assert_progress_case

    await assert_progress_case(
        seconds=110,
        prelude=0,
        fallback=True,
        expected_error="rose.complete TTFT exceeded 90.0s",
        expected_time=200.0,
        exhausted=True,
    )


async def test_client_buffered_progress_isolates_siblings_and_cancellation():
    from _rose_stream_progress_fixture import assert_concurrent_progress_and_cancellation

    await assert_concurrent_progress_and_cancellation()


# =====================================================================
# Cache hit rate smoke tests
# =====================================================================


def test_cache_input_accounting_claude_auth_uses_exclusive_anthropic_counters():
    """Anthropic input_tokens excludes cache read/write tokens."""
    stats = _cache_input_accounting(
        actual_model="claude-sonnet-4-6-claude",
        prompt_tokens=500,
        cache_read=4500,
        cache_write=100,
    )

    assert stats["cache_accounting"] == "exclusive"
    assert stats["total_input"] == 5100
    assert stats["uncached_input"] == 500
    assert stats["cache_hit_pct"] == 88


def test_cache_input_accounting_gpt_uses_inclusive_openai_counters():
    """OpenAI/OpenRouter cached_tokens are part of prompt_tokens."""
    stats = _cache_input_accounting(
        actual_model="gpt-5.5-gpt",
        prompt_tokens=9859,
        cache_read=9472,
        cache_write=0,
    )

    assert stats["cache_accounting"] == "inclusive"
    assert stats["total_input"] == 9859
    assert stats["uncached_input"] == 387
    assert stats["cache_hit_pct"] == 96


def test_cache_input_accounting_openrouter_waterfall_uses_inclusive_details():
    """OpenRouter exposes prompt_tokens_details as OpenAI-compatible usage."""
    stats = _cache_input_accounting(
        actual_model="openai/gpt-4.1",
        prompt_tokens=2048,
        cache_read=1920,
        cache_write=0,
    )

    assert stats["cache_accounting"] == "inclusive"
    assert stats["total_input"] == 2048
    assert stats["uncached_input"] == 128
    assert stats["cache_hit_pct"] == 94


async def test_client_normalizes_inclusive_cache_usage_for_downstream_costing():
    """OpenAI-compatible total prompt tokens must become the Rose exclusive contract.

    Captured from spawn-sub-agents agent 8edbb0bf-aad7: OpenAI reported
    61,441 total prompt tokens, including 40,951 cache reads and 20,368 cache
    writes. Downstream cost accounting adds those cache counters separately,
    so Rose must expose only the 122-token uncached tail as prompt_tokens.
    """

    async def captured_openai_api_key(**_kwargs):
        yield StreamChunk(
            kind="metadata",
            data={"actual_model": "gpt-5.6-terra-openai"},
        )
        yield StreamChunk(
            kind="usage",
            data={
                "prompt_tokens": 61_441,
                "completion_tokens": 868,
                "total_tokens": 62_309,
                "cache_read_input_tokens": 40_951,
                "cache_creation_input_tokens": 20_368,
            },
        )
        yield StreamChunk(kind="done", data={})

    client = RoseClient(openrouter_key="ork-x")
    with (
        patch("providers.rose.client._openai_api_key", return_value="sk-test"),
        patch("providers.rose.client._try_openai_api_key", side_effect=captured_openai_api_key),
    ):
        chunks = await _drain(
            client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "captured cache accounting"}],
                call_site="cache-accounting-repro",
            )
        )

    usage = next(chunk.data for chunk in chunks if chunk.kind == "usage")
    assert usage["prompt_tokens"] == 122
    assert usage["prompt_tokens_total"] == 61_441
    assert usage["total_tokens"] == 62_309
    assert usage["cache_read_input_tokens"] == 40_951
    assert usage["cache_creation_input_tokens"] == 20_368


def test_parallel_explore_trace_stays_below_cost_limit_after_cache_normalization():
    """Replay the complete LLM usage from failed parallel-tool-calls agent 58a04e8d.

    Three native-tool explore leaves completed successfully, but legacy
    accounting double-counted the cache buckets and paused the root before
    synthesis. OpenAI's prompt counter already contains both buckets, so adding
    them again inflates the trace ~2.04x; normalizing it restores the real cost.

    Figures updated 2026-08-19. Every call here carries the `-openai` suffix
    (the DIRECT OpenAI API route), and the direct terra/luna rates were stale on
    the high side -- $2.50/$15 and $1.00/$6.00 against actual $2/$12 and
    $0.20/$1.20. Under corrected rates the same trace costs 87.89c legacy, i.e.
    it would NOT have crossed the 100c product limit; the historical 113.57c
    pause was therefore part real cache double-counting and part over-pricing.
    The double-counting is still real and still worth guarding, which is why the
    2.04x inflation ratio is asserted alongside the absolute figures -- the
    ratio is rate-table independent and keeps testing the defect itself.
    """
    # model suffix, inclusive prompt, completion, cache read, cache write
    captured_usage = [
        ("terra", 1_795, 198, 0, 1_792),
        ("sol", 6_530, 509, 0, 6_408),
        ("terra", 2_215, 271, 0, 2_093),
        ("terra", 2_217, 132, 0, 2_095),
        ("terra", 2_229, 144, 0, 2_107),
        ("terra", 11_659, 212, 2_107, 9_430),
        ("terra", 10_235, 275, 2_095, 8_018),
        ("terra", 14_582, 440, 2_093, 12_367),
        ("luna", 11_913, 964, 0, 11_910),
        ("luna", 4_148, 563, 0, 4_145),
        ("luna", 4_249, 988, 0, 4_246),
        ("luna", 500, 78, 0, 500),
        ("terra", 30_770, 325, 14_460, 16_188),
        ("terra", 20_595, 254, 11_537, 8_936),
        ("luna", 2_180, 1_147, 0, 2_177),
        ("luna", 4_147, 475, 0, 4_144),
        ("luna", 1_531, 987, 0, 1_528),
        ("luna", 4_632, 393, 0, 4_629),
        ("terra", 20_473, 1_863, 10_113, 10_238),
        ("luna", 6_679, 161, 0, 6_676),
        ("terra", 24_875, 2_161, 20_473, 4_280),
        ("terra", 34_577, 1_964, 30_648, 3_807),
    ]

    def workflow_cost_cents(model: str, usage: dict) -> float:
        pricing = get_model_pricing(model)
        assert pricing is not None
        input_rate = pricing["input_cents_per_1k"]
        output_rate = pricing["output_cents_per_1k"]
        return (
            usage["prompt_tokens"] * input_rate
            + usage["cache_read_input_tokens"] * input_rate * 0.25
            + usage["cache_creation_input_tokens"] * input_rate
            + usage["completion_tokens"] * output_rate
        ) / 1_000

    legacy_llm_cost = 0.0
    normalized_llm_cost = 0.0
    for suffix, prompt, completion, cache_read, cache_write in captured_usage:
        model = f"gpt-5.6-{suffix}-openai"
        raw_usage = {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_write,
        }
        legacy_llm_cost += workflow_cost_cents(model, raw_usage)
        normalized_llm_cost += workflow_cost_cents(model, _normalize_usage_input_tokens(model, raw_usage))

    # The same run incurred 11.5272c in web-search/fetch service usage.
    service_cost_cents = 11.5272
    legacy_trace_cost = legacy_llm_cost + service_cost_cents
    normalized_trace_cost = normalized_llm_cost + service_cost_cents

    assert abs(legacy_trace_cost - 87.890300) < 0.000001
    assert abs(normalized_trace_cost - 48.911800) < 0.000001
    assert normalized_trace_cost < 100
    # The defect itself: double-counted cache buckets inflate the LLM spend.
    # Asserted as a ratio because it is rate-table independent -- the absolute
    # figures above move whenever provider pricing is corrected, and an
    # absolute-limit assertion silently stops testing anything when they do.
    assert normalized_llm_cost < legacy_llm_cost
    assert abs(legacy_llm_cost / normalized_llm_cost - 2.0426) < 0.001


async def test_claude_auth_stream_reports_cache_hit_rate():
    """Simulated claudeAuth stream with cache metrics — validates cache_read
    tokens are reported and the hit rate is above a minimum threshold.

    This exercises the full path: build_anthropic_body (with static/dynamic
    split + message breakpoint) → claude_auth_complete → parse_anthropic_sse
    → usage chunk with cache metrics.
    """
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    # Simulate a second-turn call where most of the prompt is cached.
    # 500 input tokens, 4500 cache_read, 100 cache_creation → 90% hit rate.
    sse_lines = []
    sse_lines += _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {
                "usage": {
                    "input_tokens": 500,
                    "cache_read_input_tokens": 4500,
                    "cache_creation_input_tokens": 100,
                }
            },
        },
    )
    sse_lines += _ev(
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        },
    )
    sse_lines += _ev(
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": "cached response"},
        },
    )
    sse_lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    sse_lines += _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 10},
        },
    )
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

            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="unexpected")

    set_mock_handler(handler)

    system_content = f"Static agent instructions here{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}Current time: April 28, 2026 at 04 PM\n\nUser context: Andy"

    client = RoseClient(openrouter_key="ork-x")
    chunks = []
    async for chunk in client.complete(
        pool="rose-1-ultra",
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
    through build_anthropic_body: main, user-context, and phase blocks get
    global cache markers, and the last message gets a breakpoint."""
    from utils.prompts import build_system_prompt

    spec = get_pool("rose-1-flash")
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
    # identity + disclaimer + main + user context + phase = 5 blocks
    assert len(sys_blocks) == 5, f"Expected 5 system blocks, got {len(sys_blocks)}"

    main_block = sys_blocks[2]
    user_context_block = sys_blocks[3]
    phase_block = sys_blocks[4]

    for block in (main_block, user_context_block, phase_block):
        assert block["cache_control"] == {"type": "ephemeral", "scope": "global"}
    assert "You are a Rose Labs Agent" in main_block["text"]
    assert "Andy" not in main_block["text"]
    assert "# User Context" in user_context_block["text"]
    assert "Andy" in user_context_block["text"]
    assert "# Current Phase" in phase_block["text"]
    # Timestamp is now in message headers, not the system prompt dynamic section
    assert "Current time:" not in main_block["text"]
    assert "Current time:" not in user_context_block["text"]
    assert "Current time:" not in phase_block["text"]

    msgs = body["messages"]
    last_content = msgs[-1]["content"]
    if isinstance(last_content, list):
        assert "cache_control" in last_content[-1]
    else:
        raise AssertionError("Expected last message content to be list with cache_control")


def test_build_anthropic_body_native_tools_force_any_with_parallel():
    """When native tools are passed with tool_choice='any', the body must
    force tool_use AND keep parallel tool calls enabled. Anthropic's default
    flips disable_parallel_tool_use=True under tool_choice=any/tool, which
    would silently break DAG fan-outs (multi web_search, multi web_fetch)."""
    spec = get_pool("rose-1-flash")
    body = build_anthropic_body(
        pool_spec=spec,
        messages=[
            {"role": "system", "content": "be helpful"},
            {"role": "user", "content": "do X and Y in parallel"},
        ],
        tools=[
            {"name": "web_search", "description": "search", "input_schema": {"type": "object", "properties": {}}},
            {"name": "web_fetch", "description": "fetch", "input_schema": {"type": "object", "properties": {}}},
        ],
        tool_choice="any",
        response_format=None,
        max_tokens=128,
        skip_cache_write=False,
    )
    assert body["tool_choice"]["type"] == "any"
    assert body["tool_choice"]["disable_parallel_tool_use"] is False, (
        "tool_choice=any must explicitly keep parallel tool use enabled; "
        "Anthropic's default flips it to True under forced choice"
    )
    # And thinking must be dropped — Anthropic rejects thinking + forced choice
    assert "thinking" not in body, (
        "thinking block must be dropped when tool_choice is forced (any/tool); "
        "Anthropic rejects the combo and the structured-output parser cannot "
        "recover from a text-only response"
    )


def test_build_anthropic_body_omits_effort_for_haiku():
    """rose-1-mini claudeAuth is claude-haiku-4-5, which 400s on
    output_config.effort. summarize_web_fetch uses mini; stamping effort
    forced every fetch onto a 90s TTFT waterfall and timed out
    spawn-sub-agents (agent e6b39a7f). Non-haiku pools still stamp xhigh."""
    msgs = [
        {"role": "system", "content": "be helpful"},
        {"role": "user", "content": "hi"},
    ]
    mini = build_anthropic_body(
        pool_spec=get_pool("rose-1-mini"),
        messages=msgs,
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        effort="xhigh",
    )
    assert mini["model"] == "claude-haiku-4-5"
    oc = mini.get("output_config")
    assert oc is None or "effort" not in oc, (
        "haiku must not receive output_config.effort; Anthropic 400s with "
        "'This model does not support the effort parameter.'"
    )

    flash = build_anthropic_body(
        pool_spec=get_pool("rose-1-flash"),
        messages=msgs,
        tools=None,
        tool_choice=None,
        response_format=None,
        max_tokens=128,
    )
    assert flash["output_config"]["effort"] == "xhigh"


def test_build_anthropic_body_never_sets_thinking_by_default():
    """`thinking` is an anti-pattern: never set it by default. Adaptive thinking
    400s on claude-haiku-4-5 ('adaptive thinking is not supported on this model'),
    hangs Anthropic streams on Opus with effort=max, and is rejected with forced
    tool_choice. A caller that genuinely needs thinking can pass it explicitly."""
    spec = get_pool("rose-1-flash")
    body = build_anthropic_body(
        pool_spec=spec,
        messages=[
            {"role": "system", "content": "be helpful"},
            {"role": "user", "content": "hi"},
        ],
        tools=[
            {"name": "web_search", "description": "search", "input_schema": {"type": "object", "properties": {}}},
        ],
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        skip_cache_write=False,
    )
    assert body["tool_choice"]["type"] == "auto"
    assert "thinking" not in body, "thinking must never be set by default"
    # auto path doesn't touch disable_parallel_tool_use (Anthropic default = false)
    assert "disable_parallel_tool_use" not in body["tool_choice"]


def test_build_anthropic_body_honors_explicit_thinking():
    """If a caller explicitly passes `thinking`, honor it. We only forbid the
    default-on behavior — explicit opt-in is fine."""
    spec = get_pool("rose-1-flash")
    body = build_anthropic_body(
        pool_spec=spec,
        messages=[
            {"role": "system", "content": "be helpful"},
            {"role": "user", "content": "hi"},
        ],
        tools=[
            {"name": "web_search", "description": "search", "input_schema": {"type": "object", "properties": {}}},
        ],
        tool_choice=None,
        response_format=None,
        max_tokens=128,
        skip_cache_write=False,
        thinking={"type": "enabled", "budget_tokens": 4000},
    )
    assert body.get("thinking") == {"type": "enabled", "budget_tokens": 4000}


def test_build_anthropic_body_response_format_only_forces_any_with_parallel():
    """The response_format-only path (no explicit tools) must also synthesize
    tools, force tool_choice=any, and keep parallel enabled. This is the
    documented MEMORY.md `response_format` workaround — it must not regress."""
    spec = get_pool("rose-1-flash")
    response_format = {
        "type": "json_schema",
        "json_schema": {
            "name": "AgentAction",
            "schema": {
                "type": "object",
                "properties": {
                    "response": {"type": "string"},
                    "tool_calls": {
                        "type": "array",
                        "items": {
                            "anyOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "tool": {"const": "web_search"},
                                        "query": {"type": "string"},
                                    },
                                    "required": ["tool", "query"],
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "tool": {"const": "attempt_completion"},
                                    },
                                    "required": ["tool"],
                                },
                            ],
                        },
                    },
                },
            },
        },
    }
    body = build_anthropic_body(
        pool_spec=spec,
        messages=[
            {"role": "system", "content": "be helpful"},
            {"role": "user", "content": "search"},
        ],
        tools=None,
        tool_choice=None,
        response_format=response_format,
        max_tokens=128,
        skip_cache_write=False,
    )
    assert isinstance(body.get("tools"), list) and len(body["tools"]) == 2
    assert body["tool_choice"]["type"] == "any"
    assert body["tool_choice"]["disable_parallel_tool_use"] is False
    assert "thinking" not in body  # forced choice → thinking dropped


async def test_rose_client_synthesizes_force_any_for_response_model():
    """End-to-end: when rose_client.complete is given a response_model with
    a tool_calls union (AgentAction shape) and a claude_auth context, it must
    set claude_auth_tool_choice='any'. Captures the regression where the old
    `tool_requires_forced_choice` gate left it None and Anthropic emitted
    prose instead of tool_use blocks (the family-office wedge)."""
    from pydantic import BaseModel
    from typing import Literal

    from providers.rose.client import RoseClient
    from providers.rose.types import ClaudeAuthContext

    class _WebFetchTool(BaseModel):
        tool: Literal["web_fetch"]
        url: str

    class _AttemptCompletionTool(BaseModel):
        tool: Literal["attempt_completion"]

    class _ExploreAction(BaseModel):
        response: str = ""
        tool_calls: list[_WebFetchTool | _AttemptCompletionTool] = []

    captured: dict = {}

    async def _fake_try_claude_auth(**kwargs):
        captured["tools"] = kwargs.get("tools")
        captured["tool_choice"] = kwargs.get("tool_choice")
        captured["response_format"] = kwargs.get("response_format")
        if False:
            yield None
        raise RuntimeError("short-circuit after capturing")

    import providers.rose.client as client_mod

    original = client_mod._try_claude_auth
    client_mod._try_claude_auth = _fake_try_claude_auth
    try:
        client = RoseClient()
        auth = ClaudeAuthContext(
            token="test-token",
            source="test",
            user_id="u1",
            pool_token_id="p1",
            mark_rate_limited=None,
            fetch_fresh=None,
            max_rotations=0,
        )
        try:
            async for _ in client.complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "hi"}],
                response_model=_ExploreAction,
                claude_auth=auth,
            ):
                pass
        except Exception:
            pass
    finally:
        client_mod._try_claude_auth = original

    assert captured.get("tool_choice") == "any", (
        f"Expected claude_auth_tool_choice='any' for AgentAction-shape "
        f"response_model, got {captured.get('tool_choice')!r}. This is the "
        f"regression that caused family-office's 467s explore wedge."
    )
    assert captured.get("response_format") is None, (
        "When tools are synthesized from response_model, response_format must "
        "be suppressed so claude_auth.py uses the explicit tools path."
    )
    tool_names = {t["name"] for t in (captured.get("tools") or [])}
    assert tool_names == {"web_fetch", "attempt_completion"}


async def test_rose_client_synthesizes_native_tools_for_api_key_without_oauth():
    """Funded API-key routes must get the same real tools as OAuth routes.

    The browser-smoke regression had no OAuth context. Its first rich
    AgentAction turn was sent as a strict union response_format, rejected by
    the funded provider, and fell to a different model. The next, simpler turn
    then used the funded route, splitting an otherwise repeatable cache group.
    """
    from pydantic import BaseModel
    from typing import Literal

    class _WebFetchTool(BaseModel):
        tool: Literal["web_fetch"]
        url: str

    class _AttemptCompletionTool(BaseModel):
        tool: Literal["attempt_completion"]

    class _ExploreAction(BaseModel):
        response: str = ""
        tool_calls: list[_WebFetchTool | _AttemptCompletionTool] = []

    captured: dict = {}

    async def _fake_try_openai_api_key(**kwargs):
        captured["tools"] = kwargs.get("tools")
        captured["tool_choice"] = kwargs.get("tool_choice")
        captured["response_format"] = kwargs.get("response_format")
        if False:
            yield None
        raise RuntimeError("short-circuit after capturing")

    import providers.rose.client as client_mod

    original = client_mod._try_openai_api_key
    previous_key = os.environ.get("GPT_API_KEY")
    client_mod._try_openai_api_key = _fake_try_openai_api_key
    os.environ["GPT_API_KEY"] = "sk-proj-test"
    try:
        try:
            async for _ in RoseClient().complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "browse"}],
                response_model=_ExploreAction,
            ):
                pass
        except RuntimeError as exc:
            assert str(exc) == "short-circuit after capturing"
    finally:
        client_mod._try_openai_api_key = original
        if previous_key is None:
            os.environ.pop("GPT_API_KEY", None)
        else:
            os.environ["GPT_API_KEY"] = previous_key

    assert captured.get("tool_choice") == "any"
    assert captured.get("response_format") is None
    tool_names = {tool["name"] for tool in (captured.get("tools") or [])}
    assert tool_names == {"web_fetch", "attempt_completion"}


async def test_rose_client_synthesizes_native_tools_for_waterfall_without_oauth():
    """AgentAction tools must survive through the OpenRouter waterfall."""
    from pydantic import BaseModel
    from typing import Literal

    class _SpawnAgentTool(BaseModel):
        tool: Literal["spawn_agent"]
        goal: str

    class _AttemptCompletionTool(BaseModel):
        tool: Literal["attempt_completion"]

    class _AgentAction(BaseModel):
        response: str = ""
        tool_calls: list[_SpawnAgentTool | _AttemptCompletionTool] = []

    captured: dict = {}

    async def _fake_waterfall_complete(**kwargs):
        captured.update(kwargs)
        yield StreamChunk(kind="metadata", data={"actual_model": "anthropic/claude-opus-4.8"})
        yield StreamChunk(
            kind="tool_call",
            data={"name": "spawn_agent", "arguments": '{"goal":"browse"}', "id": "call-spawn"},
        )
        yield StreamChunk(
            kind="usage",
            data={"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
        )
        yield StreamChunk(kind="done", data={})

    async def _always_on_cooldown():
        return True

    with (
        patch("providers.rose.client._openai_api_key", return_value=""),
        patch("providers.rose.client._anthropic_api_key_on_cooldown", _always_on_cooldown),
        patch("providers.rose.client.waterfall_complete", single_step_waterfall(_fake_waterfall_complete)),
    ):
        chunks = await _drain(
            RoseClient(openrouter_key="ork-test").complete(
                pool="rose-1-ultra",
                messages=[{"role": "user", "content": "Use a browser child"}],
                response_model=_AgentAction,
                cache_namespace="agent:parent:task:explore-a:call:explore_agent",
            )
        )

    assert any(chunk.kind == "tool_call" for chunk in chunks)
    assert captured["response_format"] is None
    assert captured["tool_choice"] == "any"
    assert captured["cache_namespace"] == "agent:parent:task:explore-a:call:explore_agent"
    assert {tool["name"] for tool in captured["tools"]} == {
        "spawn_agent",
        "attempt_completion",
    }


async def test_rose_client_preserves_native_tools_for_waterfall():
    """The final OpenRouter fallback must keep AgentAction as native tools.

    Anthropic OpenRouter models reject the equivalent response_format request,
    so dropping this projection makes an exhausted funded key skip a healthy
    fallback provider.
    """
    from pydantic import BaseModel
    from typing import Literal

    class _WebFetchTool(BaseModel):
        tool: Literal["web_fetch"]
        url: str

    class _AttemptCompletionTool(BaseModel):
        tool: Literal["attempt_completion"]

    class _ExploreAction(BaseModel):
        response: str = ""
        tool_calls: list[_WebFetchTool | _AttemptCompletionTool] = []

    captured: dict = {}

    async def _fake_waterfall(**kwargs):
        captured.update(kwargs)
        yield StreamChunk(kind="metadata", data={"actual_model": "anthropic/claude-opus-4.8"})
        yield StreamChunk(
            kind="tool_call",
            data={"name": "attempt_completion", "arguments": "{}", "id": "call-complete"},
        )
        yield StreamChunk(
            kind="usage",
            data={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        )
        yield StreamChunk(kind="done", data={})

    previous_gpt = os.environ.pop("GPT_API_KEY", None)
    previous_anthropic = os.environ.pop("ANTHROPIC_API_KEY", None)
    try:
        with patch("providers.rose.client.waterfall_complete", single_step_waterfall(_fake_waterfall)):
            await _drain(
                RoseClient(openrouter_key="ork-test").complete(
                    pool="rose-1-ultra",
                    messages=[{"role": "user", "content": "browse"}],
                    response_model=_ExploreAction,
                )
            )
    finally:
        if previous_gpt is not None:
            os.environ["GPT_API_KEY"] = previous_gpt
        if previous_anthropic is not None:
            os.environ["ANTHROPIC_API_KEY"] = previous_anthropic

    assert captured.get("tool_choice") == "any"
    assert captured.get("response_format") is None
    tool_names = {tool["name"] for tool in (captured.get("tools") or [])}
    assert tool_names == {"web_fetch", "attempt_completion"}


# =====================================================================
# Test runner
# =====================================================================


async def test_wmh_native_response_model_reaches_foundry_http():
    """Sanitized WHM owning call must carry its declared native output schema."""
    import json
    import types
    import httpx
    from unittest.mock import AsyncMock, patch
    from benchmarks.wmh_outcomes import TIMED_DISTRIBUTION_PROTOCOL
    from benchmarks.wmh_rose_provider import RoseWMHProvider
    from providers.rose.client import RoseClient
    import providers.rose.client as client
    import providers.rose.foundry as foundry

    class Captured(BaseException):
        pass

    seen = []
    real_client = httpx.AsyncClient

    def handler(request):
        assert request.url.host == "offline.invalid"
        body = json.loads(request.content)
        seen.append(body)
        assert body.get("text", {}).get("format", {}).get("type") == "json_schema", (
            "Actual WHM request must carry its typed native output schema"
        )
        assert body["text"]["format"]["strict"] is False
        schema = body["text"]["format"]["schema"]
        assert schema["properties"]["schema"]["const"] == "rose.wmh_timed_outcome_distribution.v1"
        assert "outcomes" in schema["properties"]
        patches = schema["properties"]["outcomes"]["items"]["properties"]["state_patch"]["items"]["anyOf"]
        setter = next(branch for branch in patches if "value" in branch["properties"])
        remove = next(branch for branch in patches if "value" not in branch["properties"])
        assert setter["properties"]["value"] == {"title": "Value"}
        assert set(remove["required"]) == {"op", "path"}
        raise Captured()

    env = {
        "AZURE_FOUNDRY_ENDPOINT": "https://offline.invalid",
        "AZURE_FOUNDRY_API_KEY": "offline-test",
        "AZURE_FOUNDRY_DEPLOYMENTS": "gpt-6-sol",
    }
    with (
        patch.object(
            httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), trust_env=False)
        ),
        patch.object(client, "_openai_api_key", return_value=""),
        patch.object(client, "_cerebras_api_key", return_value=""),
        patch.object(
            client, "load_config", return_value=types.SimpleNamespace(anthropic=types.SimpleNamespace(api_key=""))
        ),
        patch.object(
            foundry, "os", types.SimpleNamespace(environ=env, getenv=lambda key, default=None: env.get(key, default))
        ),
        patch.object(foundry, "_auth_cooldown_until", {}),
        patch.object(foundry, "_cooldown_until", {}),
    ):
        rose = RoseClient(openrouter_key="offline-test")
        for json_mode in (False, True):
            owner = RoseWMHProvider(
                pool="rose-1-ultra",
                client=rose,
                user_id="offline",
                protocol=TIMED_DISTRIBUTION_PROTOCOL,
                json_mode=json_mode,
                prefer_azure=True,
            )
            owner._streams = None
            owner._lease_auth = AsyncMock(return_value=(None, None))
            count = len(seen)
            try:
                await owner._complete_async(
                    "Existing policy.",
                    [types.SimpleNamespace(role="user", content="Inspect unchanged fixture.")],
                    max_tokens=16384,
                )
            except Captured:
                pass
            assert len(seen) == count + 1

        # Ordinary non-WHM calls retain their original JSON object transport.
        def ordinary(request):
            body = json.loads(request.content)
            assert body["text"]["format"] == {"type": "json_object"}
            raise Captured()

        with patch.object(
            httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(ordinary), trust_env=False)
        ):
            try:
                await rose.collect(
                    pool="rose-1-ultra",
                    messages=[{"role": "user", "content": "Existing JSON request."}],
                    json_mode=True,
                    prefer_azure=True,
                    dump_context=False,
                )
            except Captured:
                pass


def test_wmh_response_schema_preserves_native_json_values():
    import json
    import math
    from benchmarks.wmh_outcomes import DISTRIBUTION_PROTOCOL, TIMED_DISTRIBUTION_PROTOCOL, parse_distribution
    from benchmarks.wmh_response_schema import (
        NativeTransition,
        OutcomeDistribution,
        TimedOutcomeDistribution,
        response_model_for_protocol,
    )
    from benchmarks.wmh_provider_capture import prediction_request
    from providers.rose.schema import build_openai_response_format

    values = [
        None,
        False,
        True,
        0,
        -1,
        1.5,
        "",
        "text",
        [],
        {},
        [None, {"nested": [False, 2]}],
        {"key/with~escape": {"all": [1, True, None]}},
    ]
    for timed, model, protocol in [
        (False, OutcomeDistribution, DISTRIBUTION_PROTOCOL),
        (True, TimedOutcomeDistribution, TIMED_DISTRIBUTION_PROTOCOL),
    ]:
        assert response_model_for_protocol(protocol) is model
        for value in values:
            item = {
                "id": "existing",
                "probability": 1,
                "description": "existing result",
                "tool_results": [{"call_id": "exact", "content": "complete observation", "is_error": False}],
                "state_patch": [{"op": "add", "path": "/value", "value": value}],
            }
            if timed:
                item["elapsed_ms"] = 0
            payload = {
                "schema": "rose.wmh_timed_outcome_distribution.v1" if timed else "rose.wmh_outcome_distribution.v1",
                "outcomes": [item],
            }
            roundtrip = model.model_validate_json(json.dumps(payload)).model_dump(mode="json")
            assert roundtrip == payload
            assert parse_distribution(
                json.dumps(roundtrip), base_state={}, expected_call_ids=("exact",), timed=timed
            ) == parse_distribution(json.dumps(payload), base_state={}, expected_call_ids=("exact",), timed=timed)
        assert build_openai_response_format(model)["json_schema"]["strict"] is False
        metadata = prediction_request({"response_model": model})
        json.dumps(metadata, allow_nan=False)
        assert metadata["response_model"] == {
            "name": model.__name__,
            "schema": model.model_json_schema(),
            "rose_openai_strict": False,
        }
    assert response_model_for_protocol("legacy") is None
    assert response_model_for_protocol("unknown") is None
    native = {
        "message": "",
        "tool_results": [{"call_id": "c", "content": "complete", "is_error": False}],
        "state": {"open": values},
        "terminal": False,
    }
    assert NativeTransition.model_validate_json(json.dumps(native)).model_dump(mode="json") == native
    assert (
        build_openai_response_format(NativeTransition)["json_schema"]["schema"]["properties"]["state"][
            "additionalProperties"
        ]
        is True
    )
    for invalid in [0, 1, None, "false"]:
        try:
            NativeTransition.model_validate({**native, "terminal": invalid})
        except ValueError:
            pass
        else:
            raise AssertionError("Native false terminal must not coerce")
    for invalid in [float("nan"), float("inf"), {"nested": [float("nan")]}]:
        try:
            NativeTransition.model_validate({**native, "state": {"invalid": invalid}})
        except ValueError:
            pass
        else:
            raise AssertionError("Nonfinite state JSON is forbidden")


async def test_wmh_foundry_preserves_requested_output_budget():
    import inspect
    import json
    import types
    import httpx
    from unittest.mock import AsyncMock, patch
    from benchmarks.wmh_rose_provider import RoseWMHProvider
    from benchmarks.wmh_outcomes import TIMED_DISTRIBUTION_PROTOCOL
    from providers.rose.client import RoseClient
    from providers.rose.pools import get_pool
    import providers.rose.client as client
    import providers.rose.foundry as foundry

    class Captured(BaseException):
        pass

    captured = []
    real = httpx.AsyncClient
    env = {
        "AZURE_FOUNDRY_ENDPOINT": "https://offline.invalid",
        "AZURE_FOUNDRY_API_KEY": "offline",
        "AZURE_FOUNDRY_DEPLOYMENTS": "gpt-5.6-luna",
    }

    def callback(request):
        captured.append(json.loads(request.content))
        raise Captured()

    with (
        patch.object(httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(callback), trust_env=False)),
        patch.object(client, "_openai_api_key", return_value=""),
        patch.object(client, "_cerebras_api_key", return_value=""),
        patch.object(
            client, "load_config", return_value=types.SimpleNamespace(anthropic=types.SimpleNamespace(api_key=""))
        ),
        patch.object(foundry, "os", types.SimpleNamespace(environ=env, getenv=lambda k, v=None: env.get(k, v))),
        patch.object(foundry, "_cooldown_until", {}),
        patch.object(foundry, "_auth_cooldown_until", {}),
    ):
        owner = RoseWMHProvider(
            pool="rose-1-flash",
            client=RoseClient(openrouter_key="offline"),
            protocol=TIMED_DISTRIBUTION_PROTOCOL,
            json_mode=True,
            prefer_azure=True,
            user_id="offline",
        )
        owner._streams = None
        owner._lease_auth = AsyncMock(return_value=(None, None))
        for requested in (16384, 32000):
            try:
                await owner._complete_async(
                    "Unchanged policy.",
                    [types.SimpleNamespace(role="user", content="Unchanged input.")],
                    max_tokens=requested,
                )
            except Captured:
                pass
            assert captured[-1].get("max_output_tokens") == requested, (
                "Actual WHM requested output budget must reach Foundry HTTP"
            )

        # None/omitted defaults are byte-identical; explicit budget is the only body difference.
        async def direct(limit="omitted"):
            kw = dict(
                pool_spec=get_pool("rose-1-flash"),
                messages=[{"role": "user", "content": "Unchanged input."}],
                response_format=None,
                tools=None,
                context_tools=None,
                tool_choice=None,
                temperature=None,
                effort=None,
                provider_fast_mode=True,
                request_id="same",
                route_key="same",
                agent_id=None,
                call_site="test",
                cache_namespace="same",
                ttft_timeout_s=90,
                idle_timeout_s=120,
            )
            if limit != "omitted" and "max_tokens" in inspect.signature(foundry.foundry_complete).parameters:
                kw["max_tokens"] = limit
            try:
                async for _ in foundry.foundry_complete(**kw):
                    pass
            except Captured:
                pass
            return captured[-1]

        default = await direct()
        none = await direct(None)
        bounded = await direct(16384)
        from providers.rose.gpt_auth import build_codex_responses_body

        reference = build_codex_responses_body(
            pool_spec=get_pool("rose-1-flash"),
            model_override="gpt-5.6-luna",
            messages=[{"role": "user", "content": "Unchanged input."}],
            response_format=None,
            request_id="same",
            cache_namespace="same",
            cache_breakpoints=True,
        )
        assert default == none == reference and "max_output_tokens" not in default
        assert bounded == {**default, "max_output_tokens": 16384}


async def test_funded_openai_preserves_requested_output_budget():
    import json
    import types
    import httpx
    from unittest.mock import AsyncMock, patch
    from providers.rose.client import RoseClient
    from providers.rose.pools import get_pool, foundry_model
    from providers.rose.gpt_auth import build_codex_responses_body
    import providers.rose.client as client
    import providers.rose.transport as transport
    import providers.rose.foundry as foundry

    class Captured(BaseException):
        pass

    messages = [{"role": "system", "content": "Unchanged policy."}, {"role": "user", "content": "Unchanged evidence."}]
    seen = []

    def callback(request):
        assert request.url.host == "api.openai.com"
        assert request.url.path == "/v1/responses"
        seen.append(json.loads(request.content))
        raise Captured()

    async with httpx.AsyncClient(transport=httpx.MockTransport(callback), trust_env=False) as mock_client:
        with (
            patch.object(transport, "get_streaming_http_client", return_value=mock_client),
            patch.object(client, "_openai_api_key", return_value="offline-only-key"),
            patch.object(client, "_cerebras_api_key", return_value=""),
            patch.object(client, "_gpt_api_key_on_cooldown", AsyncMock(return_value=False)),
            patch.object(
                client, "load_config", return_value=types.SimpleNamespace(anthropic=types.SimpleNamespace(api_key=""))
            ),
        ):
            rose = RoseClient(openrouter_key="offline")

            async def collect(limit="omitted"):
                kwargs = dict(
                    pool="rose-1-ultra",
                    messages=messages,
                    request_id="same-offline-request",
                    cache_namespace="same-offline-cache",
                    dump_context=False,
                )
                if limit != "omitted":
                    kwargs["max_tokens"] = limit
                count = len(seen)
                try:
                    await rose.collect(**kwargs)
                except Captured:
                    pass
                assert len(seen) == count + 1
                return seen[-1]

            for requested in (16384, 32000):
                body = await collect(requested)
                assert body.get("max_output_tokens") == requested, (
                    "Funded OpenAI caller output budget must reach actual Responses HTTP transport"
                )
            default = await collect()
            none = await collect(None)
            bounded = await collect(16384)
            assert default == none and "max_output_tokens" not in default
            assert bounded == {**default, "max_output_tokens": 16384}
            reference = build_codex_responses_body(
                pool_spec=get_pool("rose-1-ultra"),
                model_override=get_pool("rose-1-ultra").gpt_auth_model,
                messages=messages,
                request_id="same-offline-request",
                cache_namespace="same-offline-cache",
                cache_breakpoints=True,
            )
            assert default == reference
    # Foundry default route remains the same shared-converter body.
    seen_foundry = []
    real = httpx.AsyncClient

    def foundry_callback(request):
        assert request.url.host == "offline.invalid"
        seen_foundry.append(json.loads(request.content))
        raise Captured()

    env = {
        "AZURE_FOUNDRY_ENDPOINT": "https://offline.invalid",
        "AZURE_FOUNDRY_API_KEY": "offline",
        "AZURE_FOUNDRY_DEPLOYMENTS": foundry_model(get_pool("rose-1-ultra")),
    }
    module_httpx = types.SimpleNamespace(
        AsyncClient=lambda **kw: real(transport=httpx.MockTransport(foundry_callback), trust_env=False),
        Timeout=httpx.Timeout,
        Headers=httpx.Headers,
        TransportError=httpx.TransportError,
    )
    with (
        patch.object(foundry, "httpx", module_httpx),
        patch.object(foundry, "os", types.SimpleNamespace(environ=env, getenv=lambda k, v=None: env.get(k, v))),
        patch.object(foundry, "_auth_cooldown_until", {}),
        patch.object(foundry, "_cooldown_until", {}),
    ):
        try:
            async for _ in foundry.foundry_complete(
                pool_spec=get_pool("rose-1-ultra"),
                messages=messages,
                response_format=None,
                tools=None,
                context_tools=None,
                tool_choice=None,
                temperature=None,
                effort=None,
                provider_fast_mode=True,
                request_id="same-offline-request",
                route_key="same",
                agent_id=None,
                call_site="test",
                cache_namespace="same-offline-cache",
                ttft_timeout_s=90,
                idle_timeout_s=120,
            ):
                pass
        except Captured:
            pass
    foundry_reference = build_codex_responses_body(
        pool_spec=get_pool("rose-1-ultra"),
        model_override=foundry_model(get_pool("rose-1-ultra")),
        messages=messages,
        request_id="same-offline-request",
        cache_namespace="same-offline-cache",
        cache_breakpoints=True,
    )
    assert seen_foundry == [foundry_reference]


async def test_wmh_response_schema_binds_exact_candidate_call_ids():
    import json
    import types
    import httpx
    from unittest.mock import AsyncMock, patch
    from benchmarks.wmh_rose_provider import RoseWMHProvider
    from benchmarks.wmh_outcomes import TIMED_DISTRIBUTION_PROTOCOL
    from providers.rose.client import RoseClient
    from providers.rose.pools import get_pool, foundry_model
    import providers.rose.client as client
    import providers.rose.foundry as foundry

    expected_ids = ["call_exact_A", "call_exact_B"]
    packet = {
        "candidate_response": {"tool_calls": [{"call_id": value} for value in expected_ids]},
        "environment_state": {},
    }
    seen = []
    observed_wire = []

    class Captured(BaseException):
        pass

    def handler(request):
        body = json.loads(request.content)
        results = body["text"]["format"]["schema"]["properties"]["outcomes"]["items"]["properties"]["tool_results"]
        assert results["items"]["properties"]["call_id"] == {"title": "Call Id", "type": "string"}
        assert "maxItems" not in results
        assert body["text"]["format"]["strict"] is False
        from providers.rose.gpt_auth import build_codex_responses_body

        wire_messages, namespace = observed_wire[-1]
        reference = build_codex_responses_body(
            pool_spec=get_pool("rose-1-flash"),
            model_override=foundry_model(get_pool("rose-1-flash")),
            messages=wire_messages,
            response_format=None,
            request_id="irrelevant-to-held-cache-namespace",
            cache_namespace=namespace,
            cache_breakpoints=True,
        )
        assert body["input"] == reference["input"]
        assert body["instructions"] == reference["instructions"]
        assert body["prompt_cache_key"] == reference["prompt_cache_key"]
        seen.append(body)
        raise Captured()

    real = httpx.AsyncClient
    env = {
        "AZURE_FOUNDRY_ENDPOINT": "https://offline.invalid",
        "AZURE_FOUNDRY_API_KEY": "offline",
        "AZURE_FOUNDRY_DEPLOYMENTS": foundry_model(get_pool("rose-1-flash")),
    }
    with (
        patch.object(httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), trust_env=False)),
        patch.object(client, "_openai_api_key", return_value=""),
        patch.object(client, "_cerebras_api_key", return_value=""),
        patch.object(
            client, "load_config", return_value=types.SimpleNamespace(anthropic=types.SimpleNamespace(api_key=""))
        ),
        patch.object(foundry, "os", types.SimpleNamespace(environ=env, getenv=lambda k, v=None: env.get(k, v))),
        patch.object(foundry, "_cooldown_until", {}),
        patch.object(foundry, "_auth_cooldown_until", {}),
    ):
        owner = RoseWMHProvider(
            pool="rose-1-flash",
            client=RoseClient(openrouter_key="offline"),
            protocol=TIMED_DISTRIBUTION_PROTOCOL,
            json_mode=True,
            prefer_azure=True,
            user_id="offline",
        )
        owner._streams = None
        original_wire = owner._wire_messages

        async def inspect_wire(*args, **kwargs):
            result = await original_wire(*args, **kwargs)
            observed_wire.append(result)
            return result

        owner._wire_messages = inspect_wire
        owner._lease_auth = AsyncMock(return_value=(None, None))
        try:
            await owner._complete_async(
                "Unchanged existing policy.",
                [types.SimpleNamespace(role="user", content=json.dumps(packet))],
                max_tokens=16384,
            )
        except Captured:
            pass
        assert len(seen) == 1
        packet["candidate_response"]["tool_calls"] = [{"call_id": "different_exact"}]
        try:
            await owner._complete_async(
                "Unchanged existing policy.",
                [types.SimpleNamespace(role="user", content=json.dumps(packet))],
                max_tokens=16384,
            )
        except Captured:
            pass
        assert len(seen) == 2
        assert seen[0]["text"]["format"] == seen[1]["text"]["format"], (
            "Candidate ID/count changes must preserve the complete provider schema"
        )


def test_wmh_candidate_id_schema_preserves_native_json_contract():
    import copy
    import json
    from benchmarks.wmh_response_schema import response_model_for_protocol
    from benchmarks.wmh_outcomes import DISTRIBUTION_PROTOCOL, TIMED_DISTRIBUTION_PROTOCOL
    from providers.rose.schema import build_openai_response_format
    from benchmarks.wmh_provider_capture import prediction_request

    ids = ("call_A", "call_B")
    results = [{"call_id": value, "content": "complete original observation", "is_error": False} for value in ids]
    for protocol in (DISTRIBUTION_PROTOCOL, TIMED_DISTRIBUTION_PROTOCOL, "text-world-model-v3"):
        model = response_model_for_protocol(protocol, expected_call_ids=ids)
        for value in (None, True, 0, 1.5, "", [], {}, {"arbitrary/key": [False, None]}):
            if protocol == "text-world-model-v3":
                obj = {"message": "", "tool_results": results, "state": {"value": value}, "terminal": False}
            else:
                outcome = {
                    "id": "model_chosen",
                    "probability": 1,
                    "description": "existing possibility",
                    "tool_results": results,
                    "state_patch": [{"op": "add", "path": "/value", "value": value}],
                }
                if protocol == TIMED_DISTRIBUTION_PROTOCOL:
                    outcome["elapsed_ms"] = 0
                obj = {
                    "schema": "rose.wmh_timed_outcome_distribution.v1"
                    if protocol == TIMED_DISTRIBUTION_PROTOCOL
                    else "rose.wmh_outcome_distribution.v1",
                    "outcomes": [outcome],
                }
            assert model.model_validate_json(json.dumps(obj)).model_dump(mode="json") == obj
        for replacement in (
            [{**results[0], "call_id": "wrong"}, results[1]],
            results[:1],
            results[::-1],
            [results[0], results[0]],
        ):
            bad = copy.deepcopy(obj)
            if protocol == "text-world-model-v3":
                bad["tool_results"] = replacement
            else:
                bad["outcomes"][0]["tool_results"] = replacement
            try:
                model.model_validate_json(json.dumps(bad))
            except ValueError:
                pass
            else:
                raise AssertionError("Existing candidate identity/cardinality/order must hold")
        assert build_openai_response_format(model)["json_schema"]["strict"] is False
        metadata = prediction_request({"response_model": model})
        assert metadata["response_model"]["schema"] == model.model_json_schema()
        json.dumps(metadata)
        assert response_model_for_protocol(protocol, expected_call_ids=None) is response_model_for_protocol(protocol)
        assert response_model_for_protocol(protocol, expected_call_ids=()) is response_model_for_protocol(protocol)
    assert response_model_for_protocol("unknown", expected_call_ids=ids) is None
    assert response_model_for_protocol("legacy", expected_call_ids=ids) is None


async def test_public_responses_uses_existing_larger_limit_stage():
    import json
    import types
    import httpx
    from unittest.mock import patch, AsyncMock
    from providers.rose.client import RoseClient
    from providers.rose.pools import get_pool, foundry_model
    import providers.rose.client as client
    import providers.rose.foundry as foundry
    import providers.rose.transport as transport

    real = httpx.AsyncClient

    def sse(events):
        return "".join("data: " + json.dumps(event) + "\n\n" for event in events) + "data: [DONE]\n\n"

    for route in ("foundry", "funded"):
        requests = []
        expected_host = "offline.invalid" if route == "foundry" else "api.openai.com"

        def callback(request):
            body = json.loads(request.content)
            assert request.url.host == expected_host, (
                "Public Responses must use existing same-model larger-limit stage before fallback"
            )
            requests.append(body)
            assert body["max_output_tokens"] == (16384 if len(requests) == 1 else 32000)
            if len(requests) == 1:
                events = [
                    {"type": "response.output_text.delta", "delta": "partial fixture"},
                    {
                        "type": "response.incomplete",
                        "response": {
                            "incomplete_details": {"reason": "max_output_tokens"},
                            "usage": {"input_tokens": 1, "output_tokens": 1},
                        },
                    },
                ]
            else:
                events = [
                    {"type": "response.output_text.delta", "delta": "complete fixture"},
                    {"type": "response.completed", "response": {"usage": {"input_tokens": 1, "output_tokens": 1}}},
                ]
            return httpx.Response(200, text=sse(events))

        pool = get_pool("rose-1-ultra")
        env = {
            "AZURE_FOUNDRY_ENDPOINT": "https://offline.invalid",
            "AZURE_FOUNDRY_API_KEY": "offline",
            "AZURE_FOUNDRY_DEPLOYMENTS": foundry_model(pool),
        }
        module_httpx = types.SimpleNamespace(
            AsyncClient=lambda **kw: real(transport=httpx.MockTransport(callback), trust_env=False),
            Timeout=httpx.Timeout,
            Headers=httpx.Headers,
            TransportError=httpx.TransportError,
        )
        async with real(transport=httpx.MockTransport(callback), trust_env=False) as mock_client:
            with (
                patch.object(transport, "get_streaming_http_client", return_value=mock_client),
                patch.object(foundry, "httpx", module_httpx),
                patch.object(foundry, "os", types.SimpleNamespace(environ=env, getenv=lambda k, v=None: env.get(k, v))),
                patch.object(foundry, "_cooldown_until", {}),
                patch.object(foundry, "_auth_cooldown_until", {}),
                patch.object(client, "_openai_api_key", return_value="offline-key" if route == "funded" else ""),
                patch.object(client, "_cerebras_api_key", return_value=""),
                patch.object(client, "_gpt_api_key_on_cooldown", AsyncMock(return_value=False)),
                patch.object(
                    client,
                    "load_config",
                    return_value=types.SimpleNamespace(anthropic=types.SimpleNamespace(api_key="")),
                ),
            ):
                response = await RoseClient(openrouter_key="offline").collect(
                    pool="rose-1-ultra",
                    messages=[{"role": "user", "content": "Unchanged synthetic fixture."}],
                    max_tokens=16384,
                    result_required=True,
                    dump_context=False,
                    prefer_azure=route == "foundry",
                )
        assert [body["max_output_tokens"] for body in requests] == [16384, 32000]
        assert requests[0]["model"] == requests[1]["model"]
        assert response.content == "complete fixture"

    # Subscription backend still omits output limits and skips larger-limit recovery.
    from providers.rose.types import StreamChunk

    calls = []

    async def subscription_attempt(**kwargs):
        calls.append(kwargs)
        first = len(calls) == 1
        yield StreamChunk(kind="metadata", data={"actual_model": "same-gpt" if first else "other-openai"})
        yield StreamChunk(kind="content", data={"text": "partial" if first else "complete"})
        yield StreamChunk(
            kind="usage",
            data={"finish_reason": "length" if first else "stop", "prompt_tokens": 1, "completion_tokens": 1},
        )
        yield StreamChunk(kind="done", data={})

    chunks = [
        chunk
        async for chunk in client.recover_truncated(
            subscription_attempt, {"max_tokens": 16384, "result_required": True, "deadline_s": 590}
        )
    ]
    assert len(calls) == 2 and calls[1]["max_tokens"] == 32000
    assert calls[1].get("_skip_models")


async def test_wmh_probability_bounds_reach_provider_schema():
    import json
    import types
    import httpx
    from unittest.mock import AsyncMock, patch
    from benchmarks.wmh_rose_provider import RoseWMHProvider
    from benchmarks.wmh_outcomes import TIMED_DISTRIBUTION_PROTOCOL
    from providers.rose.client import RoseClient
    from providers.rose.pools import get_pool, foundry_model
    import providers.rose.client as client
    import providers.rose.foundry as foundry

    expected_ids = ["call_exact_A", "call_exact_B"]
    packet = {
        "candidate_response": {"tool_calls": [{"call_id": value} for value in expected_ids]},
        "environment_state": {},
    }
    seen = []
    observed_wire = []

    class Captured(BaseException):
        pass

    def handler(request):
        body = json.loads(request.content)
        results = body["text"]["format"]["schema"]["properties"]["outcomes"]["items"]["properties"]["tool_results"]
        assert results["items"]["properties"]["call_id"] == {"title": "Call Id", "type": "string"}
        assert "maxItems" not in results
        assert body["text"]["format"]["strict"] is False
        from jsonschema import Draft202012Validator

        probability = body["text"]["format"]["schema"]["properties"]["outcomes"]["items"]["properties"]["probability"]
        validator = Draft202012Validator(probability)
        assert not validator.is_valid(-1), "Serialized existing probability lower bound must reject -1"
        assert not validator.is_valid(2), "Serialized existing probability upper bound must reject 2"
        for value in (0, 1, 0.0, 0.5, 1.0):
            assert validator.is_valid(value)
        assert not validator.is_valid(True)
        assert not validator.is_valid("0.5")
        from providers.rose.gpt_auth import build_codex_responses_body

        wire_messages, namespace = observed_wire[-1]
        reference = build_codex_responses_body(
            pool_spec=get_pool("rose-1-flash"),
            model_override=foundry_model(get_pool("rose-1-flash")),
            messages=wire_messages,
            response_format=None,
            request_id="irrelevant-to-held-cache-namespace",
            cache_namespace=namespace,
            cache_breakpoints=True,
        )
        assert body["input"] == reference["input"]
        assert body["instructions"] == reference["instructions"]
        assert body["prompt_cache_key"] == reference["prompt_cache_key"]
        seen.append(body)
        raise Captured()

    real = httpx.AsyncClient
    env = {
        "AZURE_FOUNDRY_ENDPOINT": "https://offline.invalid",
        "AZURE_FOUNDRY_API_KEY": "offline",
        "AZURE_FOUNDRY_DEPLOYMENTS": foundry_model(get_pool("rose-1-flash")),
    }
    with (
        patch.object(httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), trust_env=False)),
        patch.object(client, "_openai_api_key", return_value=""),
        patch.object(client, "_cerebras_api_key", return_value=""),
        patch.object(
            client, "load_config", return_value=types.SimpleNamespace(anthropic=types.SimpleNamespace(api_key=""))
        ),
        patch.object(foundry, "os", types.SimpleNamespace(environ=env, getenv=lambda k, v=None: env.get(k, v))),
        patch.object(foundry, "_cooldown_until", {}),
        patch.object(foundry, "_auth_cooldown_until", {}),
    ):
        owner = RoseWMHProvider(
            pool="rose-1-flash",
            client=RoseClient(openrouter_key="offline"),
            protocol=TIMED_DISTRIBUTION_PROTOCOL,
            json_mode=True,
            prefer_azure=True,
            user_id="offline",
        )
        owner._streams = None
        original_wire = owner._wire_messages

        async def inspect_wire(*args, **kwargs):
            result = await original_wire(*args, **kwargs)
            observed_wire.append(result)
            return result

        owner._wire_messages = inspect_wire
        owner._lease_auth = AsyncMock(return_value=(None, None))
        try:
            await owner._complete_async(
                "Unchanged existing policy.",
                [types.SimpleNamespace(role="user", content=json.dumps(packet))],
                max_tokens=16384,
            )
        except Captured:
            pass
        assert len(seen) == 1

    from benchmarks.wmh_response_schema import response_model_for_protocol
    from benchmarks.wmh_outcomes import DISTRIBUTION_PROTOCOL
    from providers.rose.schema import build_openai_response_format
    from jsonschema import Draft202012Validator

    for protocol in (DISTRIBUTION_PROTOCOL, TIMED_DISTRIBUTION_PROTOCOL):
        for ids in (None, ("call_exact_A",)):
            model = response_model_for_protocol(protocol, expected_call_ids=ids)
            probability_schema = build_openai_response_format(model)["json_schema"]["schema"]["properties"]["outcomes"][
                "items"
            ]["properties"]["probability"]
            validator = Draft202012Validator(probability_schema)
            assert not validator.is_valid(-1), "Serialized existing probability lower bound must reject -1"
            assert not validator.is_valid(2), "Serialized existing probability upper bound must reject 2"
            assert not validator.is_valid(True)
            assert not validator.is_valid("0.5")
            for value in (0, 1, 0.0, 0.25, 1.0):
                assert validator.is_valid(value)
                result = {"call_id": "call_exact_A", "content": "fixture", "is_error": False}
                outcome = {
                    "id": "fixture",
                    "probability": value,
                    "description": "fixture",
                    "tool_results": [result],
                    "state_patch": [],
                }
                if protocol == TIMED_DISTRIBUTION_PROTOCOL:
                    outcome["elapsed_ms"] = 0
                obj = {
                    "schema": "rose.wmh_timed_outcome_distribution.v1"
                    if protocol == TIMED_DISTRIBUTION_PROTOCOL
                    else "rose.wmh_outcome_distribution.v1",
                    "outcomes": [outcome],
                }
                validated = model.model_validate_json(json.dumps(obj))
                decoded = json.loads(validated.model_dump_json())["outcomes"][0]["probability"]
                assert type(decoded) is type(value), "Preserve original JSON integer/float type"
                assert type(validated.outcomes[0].probability) is type(value)


async def test_direct_auth_honors_candidate_exclusions():
    from types import SimpleNamespace
    from providers.rose.truncation import model_key

    for kind in ("claude", "gpt"):
        pool = get_pool("rose-1-ultra")
        excluded = pool.claude_auth_model if kind == "claude" else pool.gpt_auth_model
        hosts = []

        def handler(request, hosts=hosts):
            hosts.append(request.url.host)
            assert request.url.host == "openrouter.ai", "Excluded direct candidate was requested"
            return httpx.Response(
                200,
                text="\n".join(
                    _openai_sse(
                        [
                            {"choices": [{"delta": {"content": "eligible"}, "finish_reason": "stop"}]},
                            {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
                        ]
                    )
                ),
                headers={"content-type": "text/event-stream"},
            )

        set_mock_handler(handler)
        with patch(
            "providers.rose.client.load_config", return_value=SimpleNamespace(anthropic=SimpleNamespace(api_key=""))
        ):
            chunks = await _drain(
                RoseClient(openrouter_key="offline").complete(
                    pool=pool.name,
                    messages=[{"role": "user", "content": "offline exclusion"}],
                    claude_auth=ClaudeAuthContext(token="offline", source="user", user_id="offline")
                    if kind == "claude"
                    else None,
                    gpt_auth=gpt_auth_from_token("offline", "offline") if kind == "gpt" else None,
                    _skip_models=frozenset({model_key(excluded)}),
                    dump_context=False,
                )
            )
        assert hosts == ["openrouter.ai"]
        assert any(c.kind == "content" and c.data.get("text") == "eligible" for c in chunks)


async def test_truncation_retains_incoming_candidate_exclusions():
    from providers.rose.truncation import recover_truncated

    seen = []

    async def attempt(**kwargs):
        seen.append(kwargs.get("_skip_models"))
        yield StreamChunk(kind="metadata", data={"actual_model": "candidate-b-gpt"})
        yield StreamChunk(
            kind="usage", data={"finish_reason": "length" if len(seen) == 1 else "stop", "completion_tokens": 1}
        )
        yield StreamChunk(kind="done", data={})

    await _drain(
        recover_truncated(
            attempt,
            {"messages": [], "response_model": object, "max_tokens": 100, "_skip_models": frozenset({"candidatea"})},
        )
    )
    assert len(seen) == 2
    assert all("candidatea" in excluded for excluded in seen)


async def run_all_tests():
    print("rose blackbox tests:")
    r = BlackboxResult()
    await r.record_async("rose_local_loopback_no_fallback", test_rose_local_loopback_and_no_fallback)
    await r.record_async(
        "truncation_preserves_candidate_exclusions", test_truncation_retains_incoming_candidate_exclusions
    )
    await r.record_async("direct_auth_candidate_exclusions", test_direct_auth_honors_candidate_exclusions)

    r.record("is_rose_model_variants", test_is_rose_model_variants)
    r.record("build_anthropic_body_no_input_mutation", test_build_anthropic_body_does_not_mutate_caller_messages)
    r.record("pool_for_model_fuzzy", test_pool_for_model_fuzzy)
    r.record("oss_pool_is_open_weights_only", test_oss_pool_is_open_weights_only)
    r.record("claude_auth_from_token_none", test_claude_auth_from_token_returns_none_when_falsy)
    r.record("claude_auth_from_token_builds", test_claude_auth_from_token_builds_context)
    r.record("gpt_auth_from_token_builds", test_gpt_auth_from_token_builds_context)
    r.record("classify_claude_token_error", test_classify_claude_token_error_each_branch)

    r.record("pool_registry_lookup", test_pool_registry_lookup)
    r.record("cerebras_native_tools_enforce_shapes", test_cerebras_native_tools_enforce_representable_shapes)
    r.record("cerebras_native_tools_incompatible_visible", test_cerebras_native_tools_keep_incompatible_schemas_visible)
    await r.record_async("cerebras_raw_schema_keys_native_client", test_cerebras_raw_schema_keys_reach_native_client)
    await r.record_async("cerebras_mixed_toolset_contract", test_cerebras_mixed_toolset_uses_valid_request_contract)
    await r.record_async(
        "cerebras_strict_native_parser_retry", test_cerebras_strict_native_response_retains_parser_retry
    )
    await r.record_async(
        "cerebras_tool_call_at_output_limit_escalated",
        test_cerebras_tool_call_at_output_limit_is_escalated_not_accepted,
    )
    r.record("cerebras_body_strips_cache_control", test_build_cerebras_body_strips_cache_control)
    r.record("all_pool_names_matches", test_all_pool_names_matches_registry)
    r.record("get_pool_unknown_raises", test_get_pool_unknown_raises)
    r.record(
        "every_waterfall_model_is_vision_capable",
        test_every_waterfall_model_is_vision_capable,
    )
    r.record("every_browser_route_model_sees_images", test_every_browser_route_model_sees_images)

    r.record("is_anthropic_model", test_is_anthropic_model_substring)
    r.record("transform_block_passthrough", test_transform_content_block_passthrough_for_text)
    r.record("transform_block_image_data", test_transform_content_block_image_data_uri)
    r.record("transform_block_image_url", test_transform_content_block_image_url_http)
    r.record("transform_block_file_data", test_transform_content_block_file_data_uri)
    r.record("transform_msgs_pulls_system", test_transform_messages_for_anthropic_pulls_system)
    r.record("transform_msgs_splits_boundary", test_transform_messages_for_anthropic_splits_on_boundary)
    r.record(
        "transform_msgs_preserves_repeated_boundaries_for_cache",
        test_transform_messages_for_anthropic_preserves_repeated_boundaries_for_cache_blocks,
    )
    r.record("browser_dump_messages_split_boundary", test_browser_dump_messages_split_internal_system_boundary)
    r.record("transform_msgs_strips_trailing", test_transform_messages_for_anthropic_strips_trailing_assistant)
    r.record(
        "transform_msgs_assistant_tool_calls", test_transform_messages_for_anthropic_assistant_tool_calls_to_tool_use
    )
    r.record("transform_msgs_dict_args", test_transform_messages_for_anthropic_dict_arguments)
    r.record(
        "transform_msgs_bundle_tool_results", test_transform_messages_for_anthropic_bundles_consecutive_tool_results
    )
    r.record("transform_msgs_raises_missing_id", test_transform_messages_for_anthropic_raises_on_missing_id)
    r.record("transform_msgs_raises_missing_name", test_transform_messages_for_anthropic_raises_on_missing_name)
    r.record("transform_msgs_raises_invalid_args", test_transform_messages_for_anthropic_raises_on_invalid_args_json)
    r.record("transform_msgs_raises_no_tool_id", test_transform_messages_for_anthropic_raises_on_tool_without_id)

    r.record("schema_strips_unsupported", test_transform_schema_strips_unsupported_keys)
    r.record("schema_collapses_addl_props", test_transform_schema_collapses_object_additionalProperties)
    r.record("schema_recurses_into_combinators", test_transform_schema_recurses_into_anyOf_oneOf_allOf_defs)
    r.record("schema_passthrough_non_dict", test_transform_schema_passthrough_non_dict)
    r.record(
        "pydantic_to_anthropic_native_tools",
        test_pydantic_response_model_builds_anthropic_native_tools_without_strict_by_default,
    )
    r.record("pydantic_to_anthropic_selective_strict", test_pydantic_response_model_adds_strict_only_for_opted_in_tools)
    r.record(
        "pydantic_to_anthropic_synthetic_submit_tool",
        test_pydantic_response_model_without_tool_calls_builds_synthetic_native_tool,
    )

    r.record("tool_config_explicit_tools", test_apply_tool_config_with_explicit_tools_and_choice)
    r.record("tool_config_choice_auto_specific", test_apply_tool_config_choice_auto_and_specific_tool)
    r.record("tool_config_native_lift", test_apply_tool_config_response_format_native_lift)
    r.record("browser_use_auto_tool_choice", test_browser_use_uses_auto_tool_choice_not_any)
    r.record("browser_use_advertises_request_payment_card", test_browser_use_advertises_request_payment_card)
    r.record("tool_config_structured_output_paths", test_apply_tool_config_response_format_structured_output_path)

    r.record("is_vision_capable", test_is_vision_capable_membership)
    r.record("has_screenshot_markers", test_has_screenshot_markers_detection)
    r.record("vision_expands_marker", test_transform_messages_for_vision_expands_marker)
    r.record("vision_passthrough_invalid_json", test_transform_messages_for_vision_passthrough_on_invalid_json)
    r.record("get_messages_routes_by_vision", test_get_messages_for_model_routes_by_vision)
    r.record("reconstruct_envelope", test_reconstruct_agent_response_envelope)
    r.record("reconstruct_non_dict_input", test_reconstruct_agent_response_handles_non_dict_input)
    r.record("openai_messages_cache_breakpoints", test_transform_messages_for_openai_adds_cache_breakpoints)
    r.record(
        "openai_messages_stable_conversation_cache_prefix",
        test_transform_messages_for_openai_marks_explicit_cache_conversation_prefix,
    )
    r.record(
        "openai_messages_tool_call_type_discriminator",
        test_transform_messages_for_openai_stamps_tool_call_type,
    )
    r.record(
        "openai_messages_multi_boundary_cached",
        test_transform_messages_for_openai_multi_boundary_system_blocks_are_cached,
    )
    r.record(
        "openai_messages_later_system_boundary_stripped",
        test_transform_messages_for_openai_strips_boundary_from_later_system_messages,
    )
    r.record(
        "openai_messages_normalize_tool_result_name",
        test_transform_messages_for_openai_normalizes_tool_result_name,
    )

    r.record("anthropic_body_identity_cache", test_build_anthropic_body_identity_and_cache_block)
    r.record("anthropic_body_static_dynamic_split", test_build_anthropic_body_static_dynamic_split)
    r.record("anthropic_body_multi_boundary_cached", test_build_anthropic_body_multi_boundary_system_blocks_are_cached)
    r.record("anthropic_body_cache_control_cap", test_build_anthropic_body_caps_anthropic_cache_control_blocks)
    r.record(
        "anthropic_param_populator_shared_prefix",
        test_param_populator_bodies_share_cached_conversation_prefix,
    )
    r.record("anthropic_body_message_breakpoint", test_build_anthropic_body_message_cache_breakpoint)
    r.record("anthropic_body_skip_cache_write", test_build_anthropic_body_skip_cache_write_keeps_system_markers)
    r.record("anthropic_body_provider_fast_mode", test_build_anthropic_body_provider_fast_mode_supported_opus_only)
    r.record(
        "anthropic_body_provider_fast_mode_default",
        test_build_anthropic_body_defaults_provider_fast_mode_on_for_opus,
    )
    r.record("anthropic_fast_mode_beta_header", test_anthropic_fast_mode_transport_adds_beta_header)

    await r.record_async(
        "anthropic_transport_client_version", test_anthropic_transport_accepts_captured_client_version_requirement
    )
    await r.record_async("claude_auth_client_version_rejection_surfaced", test_claude_auth_surfaces_client_version_rejection)
    await r.record_async(
        "provider_transport_error_body", test_provider_transports_preserve_error_body_for_classification
    )
    await r.record_async("claude_auth_400_no_rotate", test_claude_auth_400_raises_invalid_request_no_rotation)
    await r.record_async(
        "browser_use_dump_records_foundry_wire_effort",
        test_browser_use_dump_records_foundry_wire_effort_and_temperature,
    )
    r.record(
        "claude_body_drops_empty_context_rows",
        test_build_anthropic_body_accepts_completion_summary_context_with_empty_rows,
    )
    r.record(
        "claude_body_closes_output_format_objects",
        test_build_anthropic_body_closes_non_strict_output_format_objects,
    )
    await r.record_async("claude_auth_400_logs_provider_message", test_claude_auth_400_logs_provider_message)
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
    await r.record_async(
        "anth_sse_thinking_only_max_tokens_length",
        test_parse_anthropic_sse_thinking_only_max_tokens_reports_length,
    )
    await r.record_async("anth_sse_refusal_raises", test_parse_anthropic_sse_refusal_raises_refusal)
    await r.record_async("anth_sse_thinking_emitted", test_parse_anthropic_sse_thinking_delta_counts_as_emitted)
    await r.record_async("anth_sse_skip_bad_json", test_parse_anthropic_sse_skips_event_lines_and_bad_json)
    await r.record_async("anth_sse_in_band_rate_limit_raises", test_parse_anthropic_sse_in_band_rate_limit_raises)
    await r.record_async("anth_sse_in_band_auth_error_raises", test_parse_anthropic_sse_in_band_auth_error_raises)

    await r.record_async("openai_sse_content_finish", test_parse_openai_sse_content_and_finish_reason)
    await r.record_async("openai_sse_tool_call_assembly", test_parse_openai_sse_tool_call_assembly_across_deltas)
    await r.record_async("openai_sse_reasoning_alias", test_parse_openai_sse_reasoning_content_alias)
    await r.record_async("openai_sse_empty_stalls", test_parse_openai_sse_empty_stream_raises_stall)
    await r.record_async("openai_sse_refusal_raises", test_parse_openai_sse_refusal_raises_refusal)
    await r.record_async("responses_sse_content_usage", test_parse_responses_sse_content_and_usage)
    await r.record_async(
        "responses_sse_ignores_idle_before_first_line",
        test_parse_responses_sse_ignores_deprecated_idle_timeout_before_first_line,
    )
    await r.record_async("responses_sse_function_call_item", test_parse_responses_sse_function_call_item)
    await r.record_async("responses_sse_reasoning_delta_events", test_parse_responses_sse_reasoning_delta_events)
    await r.record_async(
        "responses_sse_encrypted_reasoning_item_is_separate",
        test_parse_responses_sse_encrypted_reasoning_item_is_separate,
    )
    await r.record_async(
        "responses_sse_failed_context_length",
        test_parse_responses_sse_failed_context_length_is_invalid_request,
    )
    await r.record_async(
        "responses_sse_in_band_credit_exhaustion",
        test_parse_responses_sse_in_band_credit_exhaustion_is_payment_required,
    )
    r.record("codex_responses_body_contract", test_build_codex_responses_body_contract)
    r.record("codex_cache_scope_session_headers", test_codex_cache_scope_uses_canonical_session_headers)
    await r.record_async(
        "gpt_auth_cache_namespace_isolates_concurrent_agent_prefixes",
        test_gpt_auth_cache_namespace_isolates_concurrent_agent_prefixes,
    )
    await r.record_async(
        "rose_client_cache_sequence_identity",
        test_rose_client_routes_and_emits_one_cache_sequence_identity,
    )
    r.record(
        "codex_body_tool_history_multimodal", test_build_codex_responses_body_preserves_tool_history_and_multimodal
    )
    r.record("codex_body_orphan_tool_context", test_build_codex_responses_body_converts_orphan_tool_rows_to_context)
    r.record(
        "openrouter_nested_response_schema",
        test_openrouter_response_format_preserves_nested_required_properties,
    )
    r.record(
        "claude_auth_nested_response_schema",
        test_claude_auth_output_config_preserves_nested_required_properties,
    )
    r.record(
        "gpt_auth_nested_response_schema",
        test_gpt_auth_text_format_preserves_nested_required_properties,
    )

    r.record("openrouter_body_optionals", test_build_openrouter_body_includes_optionals)
    r.record(
        "openrouter_body_logical_sequence_sticky_routing",
        test_build_openrouter_body_uses_logical_sequence_for_sticky_routing,
    )
    r.record(
        "openrouter_body_gemini_fixed_completed_tool_prefix",
        test_build_openrouter_body_pins_large_gemini_completed_tool_prefix,
    )
    r.record(
        "openrouter_body_gemini_2_5_explicit_prompt_cache",
        test_build_openrouter_body_keeps_gemini_2_5_explicit,
    )
    r.record(
        "openrouter_body_gemini_caller_cache_breakpoint",
        test_build_openrouter_body_preserves_caller_cache_breakpoints_for_gemini,
    )
    r.record(
        "openrouter_body_gemini_skip_cache_write",
        test_build_openrouter_body_skip_cache_write_suppresses_synthesized_gemini_marker,
    )
    r.record(
        "openrouter_body_explicit_model_cache_breakpoint",
        test_build_openrouter_body_retains_explicit_model_breakpoints,
    )
    r.record(
        "named_tool_choice_degrades_only_for_google",
        test_named_tool_choice_degrades_only_for_google_routes,
    )
    r.record("openrouter_body_provider_fast_mode", test_build_openrouter_body_provider_fast_mode)
    r.record(
        "openrouter_body_provider_fast_mode_default",
        test_build_openrouter_body_defaults_provider_fast_mode_on,
    )
    r.record("openrouter_body_minimal", test_build_openrouter_body_minimal_omits_optionals)
    r.record("haiku_body_omits_unsupported_effort", test_haiku_body_omits_unsupported_effort)
    r.record(
        "waterfall_body_builders_always_stamp_effort_xhigh",
        test_waterfall_body_builders_always_stamp_effort_xhigh_by_default,
    )
    r.record(
        "all_rose_llm_call_sites_rely_on_builder_effort_default",
        test_all_rose_llm_call_sites_rely_on_builder_effort_default,
    )
    r.record(
        "openrouter_body_no_tools_flattens_tool_history",
        test_openrouter_body_without_tools_flattens_tool_history,
    )
    r.record(
        "openrouter_body_no_tools_preserves_structured_tool_results",
        test_openrouter_body_without_tools_preserves_structured_tool_result_blocks,
    )
    r.record(
        "openrouter_body_no_tools_stringifies_non_json_structured_result",
        test_openrouter_body_without_tools_stringifies_non_json_structured_tool_result,
    )
    r.record(
        "openrouter_body_with_tools_keeps_tool_history",
        test_openrouter_body_with_tools_preserves_tool_history,
    )
    await r.record_async("waterfall_falls_through_succeeds", test_waterfall_falls_through_then_succeeds)
    await r.record_async(
        "waterfall_raw_tls_before_headers_uses_existing_next_model",
        test_waterfall_raw_tls_failure_before_headers_uses_existing_next_model,
    )
    await r.record_async(
        "waterfall_raw_tls_after_output_preserves_cause_without_replay",
        test_waterfall_raw_tls_failure_after_productive_output_preserves_cause_without_replay,
    )
    await r.record_async(
        "waterfall_raw_tls_all_models_preserves_exact_step_errors",
        test_waterfall_raw_tls_failure_on_all_models_preserves_exact_step_errors,
    )
    await r.record_async(
        "browser_qwen_cached_provider_with_fallback",
        test_browser_qwen_prefers_cached_provider_without_affecting_flash,
    )
    await r.record_async(
        "waterfall_skips_anthropic_response_format", test_waterfall_skips_anthropic_for_response_format
    )
    await r.record_async("waterfall_uses_anthropic_native_tools", test_waterfall_uses_anthropic_with_native_tools)
    await r.record_async("waterfall_excludes_anthropic_family", test_waterfall_excludes_anthropic_family_when_requested)
    await r.record_async(
        "ultra_structured_output_falls_through_second_layer_invalid_request",
        test_ultra_structured_output_falls_through_second_layer_invalid_request,
    )
    await r.record_async("waterfall_all_failed", test_waterfall_all_failed_raises_with_step_errors)
    await r.record_async("waterfall_cache_metrics", test_waterfall_reports_cache_metrics_from_openrouter)

    r.record("anthropic_apikey_headers_x_api_key", test_anthropic_api_key_headers_use_x_api_key)
    await r.record_async(
        "anthropic_apikey_402_payment_required", test_anthropic_api_key_complete_402_raises_payment_required
    )
    await r.record_async(
        "anthropic_apikey_400_credit_payment_required",
        test_anthropic_api_key_complete_400_credit_balance_raises_payment_required,
    )
    await r.record_async("anthropic_apikey_suffix", test_anthropic_api_key_complete_sets_anthropic_suffix)
    await r.record_async("anthropic_apikey_cooldown_mark", test_anthropic_api_key_cooldown_mark_then_on_cooldown)
    await r.record_async(
        "gpt_apikey_credit_cooldown_to_foundry",
        test_gpt_api_key_credit_failure_cools_all_agent_requests_before_foundry,
    )
    await r.record_async(
        "openai_apikey_before_anthropic_openrouter",
        test_client_openai_api_key_serves_before_anthropic_and_openrouter,
    )
    await r.record_async(
        "openai_apikey_preserves_tools_without_gpt_auth",
        test_client_openai_api_key_preserves_tools_without_gpt_auth,
    )
    await r.record_async(
        "openai_apikey_failure_to_anthropic",
        test_client_openai_api_key_failure_falls_through_to_anthropic_before_openrouter,
    )
    await r.record_async(
        "gpt_token_usage_limit_to_openai_apikey",
        test_client_gpt_token_usage_limit_falls_back_to_openai_api_key,
    )
    await r.record_async(
        "codex_404_falls_through_to_waterfall",
        test_client_codex_404_falls_through_to_waterfall,
    )
    await r.record_async(
        "raw_tls_before_headers_uses_funded_fallback", test_client_raw_tls_failure_before_headers_uses_funded_fallback
    )
    await r.record_async(
        "cerebras_foundry_raw_tls_become_route_errors",
        test_cerebras_and_foundry_raw_tls_failures_become_route_errors,
    )
    await r.record_async(
        "raw_tls_after_output_does_not_replay", test_client_raw_tls_failure_after_output_preserves_error_without_replay
    )
    await r.record_async(
        "anthropic_apikey_tier_402_to_waterfall", test_client_api_key_tier_402_falls_through_to_waterfall
    )
    await r.record_async(
        "client_exclude_anthropic_family", test_client_exclude_anthropic_family_skips_api_key_and_anthropic_waterfall
    )
    await r.record_async(
        "client_env_exclude_anthropic_family",
        test_client_env_exclude_anthropic_family_applies_to_every_call,
    )

    await r.record_async("client_collect_waterfall", test_client_collect_waterfall_only_path)
    await r.record_async("flash_skips_auth_hits_cerebras_qwen", test_flash_skips_auth_and_hits_cerebras_qwen)
    await r.record_async(
        "flash_cerebras_failure_falls_to_openrouter_qwen",
        test_flash_cerebras_failure_falls_to_openrouter_qwen,
    )
    r.record(
        "cerebras_cooldown_preserves_provider_reset_evidence", test_cerebras_cooldown_preserves_provider_reset_evidence
    )
    await r.record_async(
        "cerebras_cooldown_skips_known_quota_then_reopens", test_cerebras_cooldown_skips_known_quota_then_reopens
    )
    await r.record_async(
        "cerebras_shared_cooldown_singleflight_and_failures", test_cerebras_shared_cooldown_singleflight_and_failures
    )
    await r.record_async(
        "cerebras_cooldown_rpc_is_bounded_and_cancellation_isolated",
        test_cerebras_cooldown_rpc_is_bounded_and_cancellation_isolated,
    )
    await r.record_async(
        "cerebras_successful_quota_headers_do_not_wait_for_shared_mark",
        test_cerebras_successful_quota_headers_do_not_wait_for_shared_mark,
    )
    await r.record_async(
        "client_collect_multiple_unstructured_items",
        test_client_collect_preserves_multiple_unstructured_text_items,
    )
    await r.record_async(
        "client_collect_selects_final_structured_item",
        test_client_collect_selects_final_structured_output_item,
    )
    await r.record_async("client_collect_common_timing_logs", test_client_collect_emits_common_rose_timing_logs)
    await r.record_async(
        "collect_cut_off_larger_limit_then_next_model",
        test_collect_retries_a_cut_off_reply_with_a_larger_limit_then_the_next_model,
    )
    await r.record_async(
        "collect_cut_off_larger_limit_is_enough", test_collect_stops_retrying_once_the_larger_limit_is_enough
    )
    await r.record_async(
        "collect_cut_off_whole_result_reply", test_collect_recovers_a_cut_off_reply_that_is_itself_the_result
    )
    await r.record_async(
        "cut_off_recovery_skips_plain_text_and_plain_streams",
        test_cut_off_recovery_leaves_plain_text_and_non_opted_streams_alone,
    )
    r.record("cut_off_recovery_limits_keys_cache", test_cut_off_recovery_limits_model_keys_and_cache_restart)
    await r.record_async("client_fallthrough_to_waterfall", test_client_falls_through_from_claude_auth_to_waterfall)
    await r.record_async(
        "wmh_pool_uses_azure_gpt_6_1_deployment_before_openrouter",
        test_wmh_pool_uses_its_azure_gpt_6_1_deployment_before_openrouter,
    )
    await r.record_async(
        "gpt56_foundry_cache_markers_become_breakpoints_and_true_writes",
        test_gpt56_foundry_turns_cache_markers_into_breakpoints_and_reports_true_writes,
    )
    r.record(
        "responses_body_keeps_latest_50_cache_breakpoints",
        test_responses_body_keeps_at_most_the_latest_50_cache_breakpoints,
    )
    r.record(
        "responses_body_marks_completed_user_messages",
        test_responses_body_marks_every_completed_user_message_without_caller_markers,
    )
    await r.record_async(
        "client_foundry_stream_exit_closes_http_owner",
        test_client_foundry_stream_exit_closes_http_owner,
    )
    await r.record_async(
        "client_foundry_server_error_falls_through_to_openrouter",
        test_client_foundry_server_error_falls_through_to_openrouter,
    )
    await r.record_async(
        "client_foundry_region_rate_limit_fails_over_before_openrouter",
        test_client_foundry_region_rate_limit_fails_over_before_openrouter,
    )
    await r.record_async(
        "client_foundry_skips_non_https_optional_region",
        test_client_foundry_skips_non_https_optional_region_and_keeps_serving,
    )
    await r.record_async(
        "client_foundry_luna_backs_mini_and_speed_pools",
        test_client_foundry_luna_backs_mini_and_speed_pools,
    )
    await r.record_async(
        "text_only_foundry_skipped_for_image_requests",
        test_text_only_foundry_skipped_for_image_requests,
    )
    await r.record_async(
        "client_direct_auth_ttft_fallthrough",
        test_client_direct_auth_ttft_falls_through_before_first_chunk,
    )
    await r.record_async(
        "client_direct_auth_stall_falls_through",
        test_client_direct_auth_stall_falls_through_immediately,
    )
    await r.record_async(
        "client_direct_auth_stall_marks_token",
        test_client_direct_auth_stall_marks_token_before_rotation,
    )
    await r.record_async(
        "client_direct_auth_idle_timeout_marks_token",
        test_client_direct_auth_internal_idle_timeout_marks_and_rotates,
    )
    await r.record_async(
        "client_direct_auth_deadline_marks_token",
        test_client_direct_auth_outer_deadline_marks_without_burning_next_token,
    )
    await r.record_async(
        "client_rotated_gpt_direct_auth_deadline_repro",
        test_client_reproduces_rotated_gpt_direct_auth_deadline,
    )
    await r.record_async("client_no_supplied_gpt_fallback", test_client_does_not_use_supplied_gpt_auth_as_fallback)
    await r.record_async(
        "client_compute_rotates_across_providers",
        test_client_rotates_compute_token_across_providers_before_waterfall,
    )
    await r.record_async(
        "client_completion_never_serializes_compute_credentials",
        test_client_completion_never_serializes_compute_credentials,
    )
    await r.record_async(
        "client_rotation_preserves_native_tool_contract",
        test_client_rotation_preserves_native_tool_contract_across_provider_types,
    )
    await r.record_async(
        "client_waterfall_preserves_native_agent_action_tools",
        test_client_waterfall_preserves_native_agent_action_tools,
    )
    await r.record_async("client_pydantic_native_tools_split", test_client_splits_pydantic_model_to_claude_native_tools)
    await r.record_async(
        "client_gpt_pydantic_native_tools_split", test_client_splits_pydantic_model_to_gpt_native_tools
    )
    await r.record_async("client_pydantic_output_config", test_client_plain_pydantic_model_uses_claude_output_config)
    await r.record_async("client_gpt_pydantic_text_format", test_client_plain_pydantic_model_uses_gpt_text_format)
    await r.record_async("client_deadline_enforced", test_client_deadline_enforced)
    await r.record_async("client_ttft_timeout", test_client_ttft_timeout_waits_for_first_productive_chunk)
    await r.record_async(
        "client_waterfall_stalled_leg_fallback", test_client_waterfall_stalled_leg_uses_existing_fallback
    )
    await r.record_async(
        "client_waterfall_failed_parser_metadata", test_client_waterfall_failed_parser_leg_discards_metadata
    )
    await r.record_async(
        "waterfall_empty_success_metadata_order", test_waterfall_empty_success_keeps_metadata_before_usage_and_done
    )
    await r.record_async("client_waterfall_global_deadline", test_client_waterfall_global_deadline_preserves_error)
    await r.record_async("client_waterfall_partial_idle", test_client_waterfall_partial_idle_preserves_error)
    await r.record_async("client_heartbeats_during_ttft_wait", test_client_heartbeats_during_ttft_wait)
    await r.record_async(
        "client_allows_idle_within_window",
        test_client_allows_idle_gap_within_idle_window_after_first_chunk,
    )
    await r.record_async(
        "client_enforces_idle_timeout_after_first_chunk",
        test_client_enforces_idle_timeout_after_first_productive_chunk,
    )
    await r.record_async(
        "client_buffered_tool_arguments_keep_real_progress_alive",
        test_client_buffered_tool_arguments_keep_real_progress_alive,
    )
    await r.record_async(
        "client_parser_only_progress_preserves_ttft_without_idle_timeout",
        test_client_parser_only_progress_preserves_ttft_without_idle_timeout,
    )
    await r.record_async(
        "client_buffered_progress_keeps_silence_and_outer_bounds",
        test_client_buffered_progress_keeps_silence_and_outer_bounds,
    )
    await r.record_async(
        "client_buffered_progress_resets_for_new_waterfall_attempt",
        test_client_buffered_progress_resets_for_new_waterfall_attempt,
    )
    await r.record_async(
        "client_buffered_progress_isolates_siblings_and_cancellation",
        test_client_buffered_progress_isolates_siblings_and_cancellation,
    )

    r.record(
        "cache_accounting_claude_exclusive",
        test_cache_input_accounting_claude_auth_uses_exclusive_anthropic_counters,
    )
    r.record("cache_accounting_gpt_inclusive", test_cache_input_accounting_gpt_uses_inclusive_openai_counters)
    r.record(
        "cache_accounting_openrouter_inclusive",
        test_cache_input_accounting_openrouter_waterfall_uses_inclusive_details,
    )
    await r.record_async(
        "client_normalizes_inclusive_cache_usage",
        test_client_normalizes_inclusive_cache_usage_for_downstream_costing,
    )
    r.record(
        "parallel_explore_trace_cache_cost_normalization",
        test_parallel_explore_trace_stays_below_cost_limit_after_cache_normalization,
    )
    await r.record_async("cache_hit_rate_smoke", test_claude_auth_stream_reports_cache_hit_rate)
    r.record("cache_structure_real_prompt", test_build_anthropic_body_cache_structure_from_real_prompt)
    r.record(
        "anthropic_body_native_tools_force_any_with_parallel",
        test_build_anthropic_body_native_tools_force_any_with_parallel,
    )
    r.record(
        "fable_5_1_downgrades_named_tool_choice_to_auto",
        test_fable_5_1_downgrades_named_tool_choice_to_auto,
    )
    r.record(
        "fable_5_1_downgrades_any_tool_choice_to_auto",
        test_fable_5_1_downgrades_any_tool_choice_to_auto,
    )
    r.record(
        "opus_5_5_downgrades_forced_tool_choice_until_confirmed",
        test_opus_5_5_downgrades_forced_tool_choice_until_confirmed,
    )
    r.record(
        "browser_use_pool_uses_speed_tier_claude_auth",
        test_browser_use_pool_uses_speed_tier_claude_auth,
    )
    r.record(
        "sonnet_and_legacy_fable_5_keep_named_tool_choice",
        test_sonnet_and_legacy_fable_5_keep_named_tool_choice,
    )
    r.record(
        "anthropic_body_never_sets_thinking_by_default",
        test_build_anthropic_body_never_sets_thinking_by_default,
    )
    r.record(
        "anthropic_body_honors_explicit_thinking",
        test_build_anthropic_body_honors_explicit_thinking,
    )
    r.record(
        "anthropic_body_response_format_only_forces_any_with_parallel",
        test_build_anthropic_body_response_format_only_forces_any_with_parallel,
    )
    await r.record_async(
        "rose_client_synthesizes_force_any_for_response_model",
        test_rose_client_synthesizes_force_any_for_response_model,
    )
    await r.record_async(
        "rose_client_synthesizes_api_key_tools_without_oauth",
        test_rose_client_synthesizes_native_tools_for_api_key_without_oauth,
    )
    await r.record_async(
        "rose_client_synthesizes_waterfall_tools_without_oauth",
        test_rose_client_synthesizes_native_tools_for_waterfall_without_oauth,
    )
    await r.record_async(
        "rose_client_preserves_native_tools_for_waterfall",
        test_rose_client_preserves_native_tools_for_waterfall,
    )
    r.record("anthropic_body_omits_effort_for_haiku", test_build_anthropic_body_omits_effort_for_haiku)

    r.record(
        "anthropic_body_omits_effort_for_haiku",
        test_build_anthropic_body_omits_effort_for_haiku,
    )
    teardown_mock()
    r.record("build_anthropic_body_omits_effort_for_haiku", test_build_anthropic_body_omits_effort_for_haiku)

    await r.record_async(
        "wmh_native_response_model_reaches_foundry_http", test_wmh_native_response_model_reaches_foundry_http
    )
    r.record("wmh_response_schema_preserves_native_json_values", test_wmh_response_schema_preserves_native_json_values)
    await r.record_async(
        "wmh_foundry_preserves_requested_output_budget", test_wmh_foundry_preserves_requested_output_budget
    )
    await r.record_async(
        "funded_openai_preserves_requested_output_budget", test_funded_openai_preserves_requested_output_budget
    )
    await r.record_async(
        "wmh_response_schema_binds_exact_candidate_call_ids", test_wmh_response_schema_binds_exact_candidate_call_ids
    )
    r.record(
        "wmh_candidate_id_schema_preserves_native_json_contract",
        test_wmh_candidate_id_schema_preserves_native_json_contract,
    )
    await r.record_async(
        "public_responses_uses_existing_larger_limit_stage", test_public_responses_uses_existing_larger_limit_stage
    )
    await r.record_async(
        "wmh_probability_bounds_reach_provider_schema", test_wmh_probability_bounds_reach_provider_schema
    )
    return r.summary()


async def probe_cerebras_native_contract(dump_path: str, protocol: str = "native", max_tokens: int = 128) -> None:
    """Explicit paid opt-in: one bounded native request, never a waterfall."""
    from helpers.httpx_capture import install_capture, uninstall_capture
    from providers.rose.cerebras import build_cerebras_body
    from providers.rose.transport import get_error_body, post_cerebras_stream

    if not _LIVE_CEREBRAS_API_KEY:
        raise RuntimeError("Configured Cerebras credential is missing")
    dump = json.loads(Path(dump_path).read_text())
    response_model = create_agent_action_model([tool["name"] for tool in dump["tools"]])
    assert build_anthropic_tools_from_response_model(response_model) == dump["tools"], "Captured model schema differs"
    response_format = (
        None
        if protocol == "native"
        else {
            "type": "json_schema",
            "json_schema": {
                "name": response_model.__name__,
                "strict": False,
                "schema": response_model.model_json_schema(),
            },
        }
    )
    body = build_cerebras_body(
        model=get_pool("rose-1-flash").cerebras_model,
        messages=dump["messages"],
        tools=dump["tools"] if protocol == "native" else None,
        tool_choice="any",
        response_format=response_format,
        temperature=1,
        max_tokens=max_tokens,
        effort="high",
    )
    print(
        "PROBE_TOOL_CONTRACT",
        protocol,
        [(t["function"]["name"], t["function"]["strict"]) for t in body.get("tools", [])],
    )
    uninstall_capture()
    try:
        async with asyncio.timeout(30):
            async with post_cerebras_stream(
                body=body,
                cerebras_key=_LIVE_CEREBRAS_API_KEY,
                request_id="offline-owner-opt-in-native-contract",
                call_site="native_contract_probe",
            ) as response:
                print("PROBE_STATUS", response.status_code)
                if response.status_code >= 400:
                    error = json.loads(get_error_body(response))
                    print("PROBE_ERROR", json.dumps(error))
                    return
                chunks = [chunk async for chunk in parse_openai_sse(response, request_id="native-contract-probe")]
                print(
                    "PROBE_RESULT", [(c.kind, c.data.get("name")) for c in chunks if c.kind in {"tool_call", "usage"}]
                )
                print("PROBE_FINISH", [c.data.get("finish_reason") for c in chunks if c.kind == "done"])
                if protocol == "json":
                    text = "".join(c.data.get("text", "") for c in chunks if c.kind == "content")
                    try:
                        parsed = response_model.model_validate_json(text)
                    except Exception as exc:
                        print("PROBE_TYPED_RESULT", "INVALID", type(exc).__name__, "content_chars", len(text))
                        if hasattr(exc, "errors"):
                            print("PROBE_VALIDATION", [{"loc": e["loc"], "type": e["type"]} for e in exc.errors()])
                        try:
                            raw = json.loads(text)
                        except json.JSONDecodeError:
                            print("PROBE_JSON", "INVALID")
                        else:
                            print("PROBE_JSON_ROOT_TYPE", type(raw).__name__)
                            print(
                                "PROBE_ARGUMENT_TYPES",
                                [
                                    {
                                        "tool": t.get("tool"),
                                        "argument_types": {k: type(v).__name__ for k, v in t.items()},
                                    }
                                    for t in (raw.get("tool_calls", []) if isinstance(raw, dict) else [])
                                    if isinstance(t, dict)
                                ],
                            )
                    else:
                        print(
                            "PROBE_TYPED_RESULT",
                            "VALID",
                            [
                                {
                                    "tool": t.tool,
                                    "argument_types": {k: type(v).__name__ for k, v in t.model_dump().items()},
                                }
                                for t in parsed.tool_calls
                            ],
                        )

    finally:
        install_capture()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cerebras-native-contract-probe")
    parser.add_argument("--cerebras-protocol", choices=["native", "json"], default="native")
    parser.add_argument("--probe-max-tokens", type=int, choices=[128, 1024], default=128)
    args = parser.parse_args()
    if args.cerebras_native_contract_probe:
        asyncio.run(
            probe_cerebras_native_contract(
                args.cerebras_native_contract_probe, args.cerebras_protocol, args.probe_max_tokens
            )
        )
    else:
        asyncio.run(run_all_tests())
