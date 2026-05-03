"""Blackbox tests for providers/rose/browser_use.py + RoseClient.complete_browser_use().

Covers:
  - tool catalog + dynamic system prompt
  - message build (text-only and multimodal)
  - extract_json (raw, fenced, ```json fenced, embedded object/array)
  - normalize_browser_use_response (flat, nested, name remap, click-coords, errors)
  - _normalize_action_params (seconds → time_ms, down → direction+amount, typing_text → text)
  - rose-1-browser-use pool registration
  - complete_browser_use HTTP path: waterfall-only, claudeAuth happy, claudeAuth 401 fall-through
"""

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _test_utils import BlackboxResult, set_mock_handler, teardown_mock

import httpx

from providers.rose import POOL_REGISTRY, RoseClient, claude_auth_from_token, get_pool
from providers.rose.browser_use import (
    BROWSER_USE_TOOLS,
    _normalize_action_params,
    build_browser_use_messages,
    build_browser_use_system_prompt,
    extract_json,
    generate_tool_descriptions,
    normalize_browser_use_response,
)


# =====================================================================
# Pool registry
# =====================================================================


def test_browser_use_pool_registered():
    assert "rose-1-browser-use" in POOL_REGISTRY
    spec = get_pool("rose-1-browser-use")
    assert spec.name == "rose-1-browser-use"
    assert spec.claude_auth_model == "claude-opus-4-7"
    assert "anthropic/claude-opus-4.7" in spec.waterfall
    # Legacy bu/yutori models removed; waterfall is opus → gpt-5.4
    assert all("yutori" not in m and "browser-use" not in m for m in spec.waterfall)


# =====================================================================
# Tool catalog + system prompt
# =====================================================================


def test_generate_tool_descriptions_filters_and_includes_params():
    out = generate_tool_descriptions(["click", "scroll", "unknown_action"])
    assert "- click:" in out
    assert "index=integer" in out
    assert "- scroll:" in out
    assert "down=boolean" in out
    # Filtered out
    assert "unknown_action" not in out


def test_generate_tool_descriptions_no_params_for_navback():
    out = generate_tool_descriptions(["navback"])
    assert out.startswith("- navback:")
    assert "(" not in out  # no param parens


def test_browser_use_tool_catalog_completeness():
    # Sanity: all the actions referenced by the prompt-builder exist.
    must_have = {"goto", "click", "input_text", "scroll", "screenshot", "attempt_completion"}
    assert must_have.issubset(set(BROWSER_USE_TOOLS.keys()))


def test_build_browser_use_system_prompt_includes_actions():
    prompt = build_browser_use_system_prompt(["click", "goto"])
    assert "# Available Actions" in prompt
    assert "- click:" in prompt
    assert "- goto:" in prompt
    assert '"thinking"' in prompt
    assert '"action"' in prompt


# =====================================================================
# Messages build
# =====================================================================


def _browser_state(**overrides):
    state = {
        "url": "https://example.com",
        "title": "Example",
        "viewport": {"width": 1280, "height": 800},
        "scroll_position": {"x": 0, "y": 0, "pages_above": 0, "pages_below": 1},
        "page_stats": {"links": 4, "interactive": 6, "iframes": 0, "scroll_containers": 0, "total_elements": 20},
        "tabs": [{"id": "1234", "url": "https://example.com", "title": "Example"}],
        "dom_tree": "[1]<button>Submit</button>",
    }
    state.update(overrides)
    return state


def test_build_messages_text_only_when_no_screenshot():
    msgs = build_browser_use_messages(
        task="Click submit",
        browser_state=_browser_state(),
        action_history=[],
        available_actions=["click"],
        include_screenshot=True,
    )
    assert len(msgs) == 2
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "user"
    # No screenshot → user content is a plain string.
    assert isinstance(msgs[1]["content"], str)
    assert "Task: Click submit" in msgs[1]["content"]
    assert "Current URL: https://example.com - Example" in msgs[1]["content"]
    assert "[1]<button>Submit</button>" in msgs[1]["content"]


def test_build_messages_multimodal_when_screenshot_present():
    msgs = build_browser_use_messages(
        task="t",
        browser_state=_browser_state(screenshot="AAAA"),
        action_history=[],
        available_actions=["click"],
        include_screenshot=True,
    )
    user = msgs[1]
    assert isinstance(user["content"], list)
    assert user["content"][0]["type"] == "text"
    img = user["content"][1]
    assert img["type"] == "image_url"
    # Raw base64 → wrapped in data: URL
    assert img["image_url"]["url"] == "data:image/png;base64,AAAA"


def test_build_messages_screenshot_url_passthrough_when_http():
    msgs = build_browser_use_messages(
        task="t",
        browser_state=_browser_state(screenshot="https://cdn.example/shot.png"),
        action_history=[],
        available_actions=["click"],
        include_screenshot=True,
    )
    img = msgs[1]["content"][1]
    assert img["image_url"]["url"] == "https://cdn.example/shot.png"


def test_build_messages_action_history_formatting():
    history = [
        {"step": 1, "thinking": "click submit", "action": "click", "index": 1, "result": {"success": True}},
        {"step": 2, "action": "scroll", "result": {"success": False, "error": "off-screen"}},
    ]
    msgs = build_browser_use_messages(
        task="t",
        browser_state=_browser_state(),
        action_history=history,
        available_actions=["click"],
        include_screenshot=False,
    )
    text = msgs[1]["content"]
    assert "Previous Actions:" in text
    assert "Step 1:" in text and "✓" in text
    assert "Step 2:" in text and "✗ Error: off-screen" in text


def test_build_messages_include_screenshot_false_drops_image():
    msgs = build_browser_use_messages(
        task="t",
        browser_state=_browser_state(screenshot="AAAA"),
        action_history=[],
        available_actions=["click"],
        include_screenshot=False,
    )
    assert isinstance(msgs[1]["content"], str)


# =====================================================================
# extract_json
# =====================================================================


def test_extract_json_raw_object():
    assert extract_json('{"action": [{"click": {"index": 1}}]}') == {"action": [{"click": {"index": 1}}]}


def test_extract_json_json_fenced_block():
    text = 'thinking out loud\n```json\n{"k": 1}\n```\ntrailing'
    assert extract_json(text) == {"k": 1}


def test_extract_json_unfenced_code_block():
    text = '```\n{"k": 2}\n```'
    assert extract_json(text) == {"k": 2}


def test_extract_json_embedded_object_with_prose():
    text = 'preamble {"k": 3} postamble'
    assert extract_json(text) == {"k": 3}


def test_extract_json_array():
    assert extract_json("[1, 2, 3]") == [1, 2, 3]


def test_extract_json_returns_none_on_garbage():
    assert extract_json("just words") is None
    assert extract_json("") is None
    assert extract_json(None) is None  # type: ignore[arg-type]


# =====================================================================
# normalize_browser_use_response
# =====================================================================


def test_normalize_flat_action_shape():
    out = normalize_browser_use_response({
        "thinking": "t",
        "action": [{"action_name": "click", "index": 5}],
    })
    assert out["action"] == "click"
    assert out["index"] == 5
    assert out["thinking"] == "t"


def test_normalize_nested_action_shape():
    out = normalize_browser_use_response({
        "thinking": "t",
        "action": [{"click": {"index": 7}}],
    })
    assert out["action"] == "click"
    assert out["index"] == 7


def test_normalize_remaps_navigate_to_goto():
    out = normalize_browser_use_response({
        "action": [{"navigate": {"url": "https://x.com"}}],
    })
    assert out["action"] == "goto"
    assert out["params"]["url"] == "https://x.com"


def test_normalize_remaps_done_to_attempt_completion():
    out = normalize_browser_use_response({
        "action": [{"action_name": "done", "text": "all good"}],
    })
    assert out["action"] == "attempt_completion"
    assert out["params"]["text"] == "all good"


def test_normalize_click_coordinates_to_click_with_coords():
    out = normalize_browser_use_response({
        "action": [{"click_coordinates": {"x": 100, "y": 200}}],
    })
    assert out["action"] == "click"
    assert out["coordinates"] == {"x": 100, "y": 200}


def test_normalize_input_text_remap():
    out = normalize_browser_use_response({
        "action": [{"input": {"index": 2, "text": "hello"}}],
    })
    assert out["action"] == "input_text"
    assert out["index"] == 2
    assert out["params"]["text"] == "hello"


def test_normalize_prefers_thinking_over_next_goal():
    # Envelope was shrunk: `thinking` is the canonical field. `next_goal` is
    # only consulted as a defensive fallback when `thinking` is absent.
    out = normalize_browser_use_response({
        "thinking": "thinking str",
        "next_goal": "next goal str",
        "action": [{"action_name": "scroll", "down": True}],
    })
    assert out["thinking"] == "thinking str"


def test_normalize_falls_back_to_next_goal_when_no_thinking():
    out = normalize_browser_use_response({
        "next_goal": "next goal str",
        "action": [{"action_name": "scroll", "down": True}],
    })
    assert out["thinking"] == "next goal str"


def test_normalize_string_completion_extracts_json():
    text = '```json\n{"action": [{"click": {"index": 9}}]}\n```'
    out = normalize_browser_use_response(text)
    assert out["action"] == "click"
    assert out["index"] == 9


def test_normalize_string_garbage_raises():
    raised = False
    try:
        normalize_browser_use_response("not json at all")
    except ValueError:
        raised = True
    assert raised


def test_normalize_empty_action_array_raises():
    raised = False
    try:
        normalize_browser_use_response({"action": []})
    except ValueError:
        raised = True
    assert raised


def test_normalize_unknown_action_raises():
    raised = False
    try:
        normalize_browser_use_response({"action": [{"action_name": "warp_drive"}]})
    except ValueError:
        raised = True
    assert raised


def test_normalize_click_without_index_raises():
    raised = False
    try:
        normalize_browser_use_response({"action": [{"action_name": "click"}]})
    except ValueError:
        raised = True
    assert raised


def test_normalize_click_coordinates_missing_y_raises():
    raised = False
    try:
        normalize_browser_use_response({"action": [{"click_coordinates": {"x": 1}}]})
    except ValueError:
        raised = True
    assert raised


def test_normalize_non_dict_action_raises():
    raised = False
    try:
        normalize_browser_use_response({"action": ["plain string"]})
    except ValueError:
        raised = True
    assert raised


# =====================================================================
# _normalize_action_params
# =====================================================================


def test_params_seconds_to_time_ms():
    out = _normalize_action_params("wait", "wait", {"seconds": 3}, {}, None)
    assert out["time_ms"] == 3000


def test_params_down_true_to_direction_and_amount():
    out = _normalize_action_params("scroll", "scroll", {"down": True, "pages": 2.0}, {}, None)
    assert out["direction"] == "down"
    assert out["amount"] == 1200  # 2.0 pages * 600


def test_params_down_false_to_direction_up():
    out = _normalize_action_params("scroll", "scroll", {"down": False}, {}, None)
    assert out["direction"] == "up"
    assert out["amount"] == 600  # 1.0 default * 600


def test_params_typing_text_yutori_alias():
    out = _normalize_action_params("input", "input_text", {"typing_text": "hi"}, {}, None)
    assert out["text"] == "hi"


def test_params_query_to_instruction():
    out = _normalize_action_params("extract", "extract", {"query": "find headlines"}, {}, None)
    assert out["instruction"] == "find headlines"


def test_params_select_dropdown_text_to_value():
    out = _normalize_action_params(
        "select_dropdown", "select_dropdown", {"text": "Option A"}, {}, None
    )
    assert out["value"] == "Option A"


# =====================================================================
# RoseClient.complete_browser_use — HTTP roundtrips
# =====================================================================


def _openai_sse(payloads: list[dict]) -> str:
    lines = []
    for p in payloads:
        lines.append(f"data: {json.dumps(p)}")
        lines.append("")
    lines.append("data: [DONE]")
    return "\n".join(lines)


def _ev(event: str, data: dict) -> list[str]:
    return [f"event: {event}", f"data: {json.dumps(data)}", ""]


def _anthropic_text_sse(text: str) -> str:
    """Build a minimal Anthropic SSE stream that emits `text` as one block."""
    lines: list[str] = []
    lines += _ev("message_start", {
        "type": "message_start",
        "message": {"usage": {"input_tokens": 5}},
    })
    lines += _ev("content_block_start", {
        "type": "content_block_start", "index": 0,
        "content_block": {"type": "text", "text": ""},
    })
    lines += _ev("content_block_delta", {
        "type": "content_block_delta", "index": 0,
        "delta": {"type": "text_delta", "text": text},
    })
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn"},
        "usage": {"output_tokens": 4},
    })
    lines += _ev("message_stop", {"type": "message_stop"})
    return "\n".join(lines)


_ACTION_TEXT = '{"thinking": "x", "action": [{"action_name": "click", "index": 3}]}'


async def test_complete_browser_use_waterfall_only_path():
    """No claudeAuth → goes straight to openrouter → returns waterfall mode."""
    sse_body = _openai_sse([
        {"choices": [{"delta": {"content": _ACTION_TEXT}, "finish_reason": "stop"}]},
        {"usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20}},
    ])

    captured: list[str] = []

    def handler(req):
        captured.append(str(req.url))
        return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")

    result = await client.complete_browser_use(
        task="click submit",
        browser_state=_browser_state(),
        action_history=[],
        available_actions=["click", "goto"],
        include_screenshot=False,
        call_site="test-bu-waterfall",
    )

    assert result["mode"] == "waterfall"
    assert result["action"]["action"] == "click"
    assert result["action"]["index"] == 3
    assert result["pool_name"] == "rose-1-browser-use"
    assert result["claude_token_error"] is None
    assert result["usage"]["total_tokens"] == 20
    # No anthropic call, only openrouter.
    assert all("api.anthropic.com" not in u for u in captured)
    assert any("openrouter.ai" in u for u in captured)


async def test_complete_browser_use_claude_path_succeeds():
    """Valid claudeAuth → Anthropic returns JSON in text → mode=claude."""

    def handler(req):
        url = str(req.url)
        if "api.anthropic.com" in url:
            return httpx.Response(
                200, text=_anthropic_text_sse(_ACTION_TEXT),
                headers={"Content-Type": "text/event-stream"},
            )
        return httpx.Response(500, text="should not hit waterfall")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")

    result = await client.complete_browser_use(
        task="click submit",
        browser_state=_browser_state(),
        action_history=[],
        available_actions=["click"],
        include_screenshot=False,
        claude_auth=claude_auth_from_token("good-token"),
        call_site="test-bu-claude",
    )

    assert result["mode"] == "claude"
    assert result["action"]["action"] == "click"
    assert result["claude_token_error"] is None


async def test_complete_browser_use_claude_401_falls_through_to_waterfall():
    """Anthropic 401 → fall through to openrouter; claude_token_error=auth_error."""
    sse_body = _openai_sse([
        {"choices": [{"delta": {"content": _ACTION_TEXT}, "finish_reason": "stop"}]},
        {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
    ])

    def handler(req):
        url = str(req.url)
        if "api.anthropic.com" in url:
            return httpx.Response(401, json={"error": {"message": "expired"}})
        return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")

    result = await client.complete_browser_use(
        task="click submit",
        browser_state=_browser_state(),
        action_history=[],
        available_actions=["click"],
        include_screenshot=False,
        claude_auth=claude_auth_from_token("expired-token"),
        call_site="test-bu-fallthrough",
    )

    assert result["mode"] == "waterfall"
    assert result["claude_token_error"] == "auth_error"
    assert result["action"]["action"] == "click"


# =====================================================================
# Test runner
# =====================================================================


async def run_all_tests():
    print("rose_browser_use blackbox tests:")
    r = BlackboxResult()

    r.record("browser_use_pool_registered", test_browser_use_pool_registered)

    r.record("tool_descriptions_filters_and_params", test_generate_tool_descriptions_filters_and_includes_params)
    r.record("tool_descriptions_no_param_for_navback", test_generate_tool_descriptions_no_params_for_navback)
    r.record("tool_catalog_completeness", test_browser_use_tool_catalog_completeness)
    r.record("system_prompt_includes_actions", test_build_browser_use_system_prompt_includes_actions)

    r.record("messages_text_only_no_screenshot", test_build_messages_text_only_when_no_screenshot)
    r.record("messages_multimodal_with_screenshot", test_build_messages_multimodal_when_screenshot_present)
    r.record("messages_http_screenshot_passthrough", test_build_messages_screenshot_url_passthrough_when_http)
    r.record("messages_action_history_formatting", test_build_messages_action_history_formatting)
    r.record("messages_include_screenshot_false", test_build_messages_include_screenshot_false_drops_image)

    r.record("extract_json_raw_object", test_extract_json_raw_object)
    r.record("extract_json_json_fenced", test_extract_json_json_fenced_block)
    r.record("extract_json_unfenced_code", test_extract_json_unfenced_code_block)
    r.record("extract_json_embedded_object", test_extract_json_embedded_object_with_prose)
    r.record("extract_json_array", test_extract_json_array)
    r.record("extract_json_returns_none", test_extract_json_returns_none_on_garbage)

    r.record("normalize_flat_action", test_normalize_flat_action_shape)
    r.record("normalize_nested_action", test_normalize_nested_action_shape)
    r.record("normalize_remap_navigate", test_normalize_remaps_navigate_to_goto)
    r.record("normalize_remap_done", test_normalize_remaps_done_to_attempt_completion)
    r.record("normalize_click_coordinates", test_normalize_click_coordinates_to_click_with_coords)
    r.record("normalize_input_text_remap", test_normalize_input_text_remap)
    r.record("normalize_prefers_thinking", test_normalize_prefers_thinking_over_next_goal)
    r.record("normalize_falls_back_to_next_goal", test_normalize_falls_back_to_next_goal_when_no_thinking)
    r.record("normalize_string_completion", test_normalize_string_completion_extracts_json)
    r.record("normalize_string_garbage_raises", test_normalize_string_garbage_raises)
    r.record("normalize_empty_action_raises", test_normalize_empty_action_array_raises)
    r.record("normalize_unknown_action_raises", test_normalize_unknown_action_raises)
    r.record("normalize_click_no_index_raises", test_normalize_click_without_index_raises)
    r.record("normalize_click_coords_missing_y_raises", test_normalize_click_coordinates_missing_y_raises)
    r.record("normalize_non_dict_action_raises", test_normalize_non_dict_action_raises)

    r.record("params_seconds_to_time_ms", test_params_seconds_to_time_ms)
    r.record("params_down_true_direction", test_params_down_true_to_direction_and_amount)
    r.record("params_down_false_direction", test_params_down_false_to_direction_up)
    r.record("params_typing_text_alias", test_params_typing_text_yutori_alias)
    r.record("params_query_to_instruction", test_params_query_to_instruction)
    r.record("params_select_dropdown_text_value", test_params_select_dropdown_text_to_value)

    await r.record_async("complete_browser_use_waterfall_only", test_complete_browser_use_waterfall_only_path)
    await r.record_async("complete_browser_use_claude_path", test_complete_browser_use_claude_path_succeeds)
    await r.record_async("complete_browser_use_claude_401_fallthrough", test_complete_browser_use_claude_401_falls_through_to_waterfall)

    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
