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
import os
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _test_utils import BlackboxResult, set_mock_handler, teardown_mock

import httpx

from providers.rose import POOL_REGISTRY, RoseClient, claude_auth_from_token, get_pool, gpt_auth_from_token
from providers.fast_cache.context import FastCacheContext, reset_context, set_context
from providers.rose.browser_use import (
    BROWSER_USE_TOOLS,
    _ACTION_NAME_MAP,
    _VALID_ACTIONS,
    _normalize_action_params,
    build_browser_use_messages,
    build_browser_use_system_prompt,
    build_browser_use_tools,
    extract_json,
    filter_browser_use_actions_for_state,
    filter_browser_turn_messages,
    generate_tool_descriptions,
    normalize_browser_use_response,
    normalize_browser_use_tool_call,
    state_has_indexed_dom_targets,
)
from tools.prompts import attempt_completion_prompt
from utils.prompts import VERIFICATION_RULES


# =====================================================================
# Pool registry
# =====================================================================


def test_browser_use_pool_registered():
    assert "rose-1-browser-use" in POOL_REGISTRY
    spec = get_pool("rose-1-browser-use")
    assert spec.name == "rose-1-browser-use"
    assert spec.claude_auth_model == "claude-fable-5"
    assert spec.gpt_auth_model == "gpt-5.6-sol"
    assert "anthropic/claude-opus-4.8" in spec.waterfall
    assert spec.waterfall[-1] == "openai/gpt-5.6-sol"
    # Legacy bu/yutori models removed; waterfall is opus → GPT-5.6 Sol.
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
    must_have = {
        "goto",
        "click",
        "input_text",
        "scroll",
        "screenshot",
        "attempt_completion",
        "request_user_assistance_for_authentication",
    }
    assert must_have.issubset(set(BROWSER_USE_TOOLS.keys()))
    assert "extract" not in BROWSER_USE_TOOLS
    assert "restart_auth_with_cookie_bundle" not in BROWSER_USE_TOOLS


def test_every_advertised_tool_is_normalizable():
    # Regression guard: every tool advertised in BROWSER_USE_TOOLS is put in
    # the model's system prompt, so the model can and will emit it. If a tool
    # is advertised but missing from _VALID_ACTIONS (after _ACTION_NAME_MAP
    # remapping), normalize_browser_use_response() raises "Unknown action" and
    # the browser step aborts 5x -> the whole browser agent dies. This is
    # exactly how rotate_ip shipped broken. Keep the allowlist in sync.
    for tool_name in BROWSER_USE_TOOLS:
        normalized = _ACTION_NAME_MAP.get(tool_name, tool_name)
        assert normalized in _VALID_ACTIONS, (
            f"Tool {tool_name!r} is advertised in BROWSER_USE_TOOLS but is not in "
            f"_VALID_ACTIONS (normalized: {normalized!r}). The model will emit it and "
            f"normalize_browser_use_response() will reject it, aborting the browser agent. "
            f"Add it to _VALID_ACTIONS or _ACTION_NAME_MAP in providers/rose/browser_use.py."
        )


def test_rotate_ip_normalizes_and_preserves_reason():
    # rotate_ip backs the mid-session IP-rotation tool. It must normalize (be in
    # the allowlist) and carry its `reason` param through to the handler, which
    # reads params.reason for telemetry.
    for completion in (
        {"thinking": "captcha wall", "action": [{"rotate_ip": {"reason": "captcha wall reappears"}}]},
        {"thinking": "429s", "action": [{"action_name": "rotate_ip", "reason": "repeated 429s on search"}]},
    ):
        result = normalize_browser_use_response(completion)
        assert result["action"] == "rotate_ip", result
        assert result["params"].get("reason"), result


def test_build_browser_use_system_prompt_uses_native_tools_not_action_list():
    prompt = build_browser_use_system_prompt(["click", "goto"])
    assert "# Role" in prompt
    assert "You are a browser automation agent. You take in a user goal" in prompt
    assert "Each turn you will receive a snapshot of the current browser environment" in prompt
    assert "Page stats" in prompt
    assert "Tab information" in prompt
    assert "A full-page screenshot if the screenshot tool was called on the previous turn" in prompt
    assert "The full prior assistant/tool turn history" not in prompt
    assert "# Available Actions" not in prompt
    assert "- click:" not in prompt
    assert "- goto:" not in prompt
    assert "call exactly one available browser action tool" in prompt
    assert "# Screenshot Tool" not in prompt
    assert "Use the `screenshot` action" not in prompt


def test_build_browser_use_system_prompt_does_not_advertise_extract():
    from browser_tools.schemas import AVAILABLE_ACTIONS

    assert "extract" not in AVAILABLE_ACTIONS
    assert "restart_auth_with_cookie_bundle" not in AVAILABLE_ACTIONS
    prompt = build_browser_use_system_prompt(AVAILABLE_ACTIONS)
    assert "- extract:" not in prompt
    assert "use `extract`" not in prompt
    assert "restart_auth_with_cookie_bundle" not in prompt
    assert "tool call" in prompt


def test_state_has_indexed_dom_targets_detects_interactive_indices():
    browser_state = {"dom_tree": "[81]<button />\n\tSchedule your order for later"}

    assert state_has_indexed_dom_targets(browser_state)


def test_filter_browser_use_actions_removes_coordinates_when_dom_has_indices():
    actions = ["click", "click_coordinates", "wait"]
    browser_state = {"dom_tree": "[92]<button aria-label=Add item to Cart />"}

    out = filter_browser_use_actions_for_state(actions, browser_state)

    assert out == ["click", "wait"]


def test_filter_browser_use_actions_keeps_coordinates_for_unindexed_state():
    actions = ["click", "click_coordinates", "wait"]
    browser_state = {"dom_tree": "<canvas id=game />"}

    out = filter_browser_use_actions_for_state(actions, browser_state)

    assert out == actions


def test_build_browser_use_system_prompt_auth_priority_is_numbered():
    prompt = build_browser_use_system_prompt([])

    assert "- Use the cheapest viable authentication path for this single site." in prompt
    assert "- Priority:\n  - 1. Existing Steel/cookie session" in prompt
    assert "  - 2. Passkey (if one is listed in Auth Options)" in prompt
    assert "  - 3. Saved passwords" in prompt
    assert "  - 4. Email OTP" in prompt
    assert "  - 5. SMS OTP" in prompt
    assert "OTP codes from email or SMS are automatically injected" in prompt
    assert "call request_user_assistance_for_authentication" in prompt
    assert "Do not call attempt_completion, send_message_to_user, or report a status instead." in prompt
    assert "# OTP Rules" not in prompt
    assert "Do not classify final credential failures yourself" not in prompt


def test_build_browser_use_system_prompt_reuses_main_grading_prompt():
    prompt = build_browser_use_system_prompt([])

    assert VERIFICATION_RULES.strip() in prompt
    assert "# Verification" not in prompt
    assert "Browser-specific notes:" not in prompt


def test_build_browser_use_tools_preserves_catalog_descriptions():
    tools = build_browser_use_tools(
        [
            "click",
            "request_user_assistance_for_authentication",
            "request_payment_card",
            "generate_write_lock_notification",
            "unknown_action",
        ]
    )
    assert [tool["name"] for tool in tools] == [
        "click",
        "request_user_assistance_for_authentication",
        "request_payment_card",
        "generate_write_lock_notification",
    ]

    click = tools[0]
    assert click["description"] == BROWSER_USE_TOOLS["click"]["description"]
    assert (
        click["input_schema"]["properties"]["index"]["description"]
        == (BROWSER_USE_TOOLS["click"]["params"]["index"]["description"])
    )
    assert click["input_schema"]["required"] == ["index"]

    auth_help = tools[1]
    assert auth_help["description"] == BROWSER_USE_TOOLS["request_user_assistance_for_authentication"]["description"]
    assert auth_help["input_schema"]["properties"] == {}
    assert auth_help["input_schema"]["required"] == []

    payment = tools[2]
    line_items = payment["input_schema"]["properties"]["line_items"]
    assert line_items["items"]["required"] == [
        "name",
        "product_url",
        "rating",
        "review_count",
        "unit_price_cents",
        "quantity",
        "line_total_cents",
    ]
    assert "checkout" in line_items["items"]["properties"]["product_url"]["description"]

    write_lock = tools[3]
    purchase_item = write_lock["input_schema"]["properties"]["purchase"]["properties"]["items"]["items"]
    assert purchase_item["required"] == ["title", "rating", "review_count", "product_url"]
    assert "anyOf" not in write_lock["input_schema"]
    assert "oneOf" not in write_lock["input_schema"]
    assert "allOf" not in write_lock["input_schema"]


def test_build_browser_use_tools_emits_valid_required_keywords():
    def walk_schema(value):
        if isinstance(value, dict):
            yield value
            for nested in value.values():
                yield from walk_schema(nested)
        elif isinstance(value, list):
            for nested in value:
                yield from walk_schema(nested)

    tools = build_browser_use_tools(list(BROWSER_USE_TOOLS))

    for tool in tools:
        for schema_node in walk_schema(tool["input_schema"]):
            if "required" in schema_node:
                assert isinstance(schema_node["required"], list), (
                    f"{tool['name']} emitted a non-array JSON Schema required keyword: {schema_node}"
                )


def test_write_lock_notification_tool_is_stable_internal_action_schema():
    from browser_tools.schemas import AVAILABLE_ACTIONS, create_browser_agent_action_model

    assert "generate_write_lock_notification" in AVAILABLE_ACTIONS
    assert "generate_write_lock_notification" in BROWSER_USE_TOOLS
    assert (
        "WRITE_LOCK_NOTIFICATION_FORK_REQUEST" in BROWSER_USE_TOOLS["generate_write_lock_notification"]["description"]
    )

    ActionModel = create_browser_agent_action_model()
    result = ActionModel.model_validate(
        {
            "response": "Preparing approval metadata.",
            "tool_calls": [
                {
                    "tool": "generate_write_lock_notification",
                    "trigger_type": "purchase",
                    "action": "buy item",
                    "service": {
                        "name": "Amazon",
                        "domain": "amazon.com",
                        "url": "https://www.amazon.com/dp/example",
                    },
                    "media": [
                        {
                            "url": "https://example.com/rendered-summary.png",
                            "alt": "Approval summary for Amazon purchase",
                            "kind": "rendered_summary",
                        }
                    ],
                    "purchase": {
                        "items": [
                            {
                                "title": "Amazon Basics USB-C Cable",
                                "price": "$12.99",
                                "quantity": "1",
                                "description": "6-foot braided charging cable",
                                "rating": "4.6 stars",
                                "review_count": "8,421 reviews",
                                "image_url": "https://example.com/cable.png",
                                "product_url": "https://www.amazon.com/dp/example",
                            }
                        ],
                        "totals": {
                            "subtotal": "$12.99",
                            "shipping": "Free",
                            "tax": "$1.07",
                            "total": "$14.06",
                        },
                    },
                    "payment": None,
                    "message": None,
                    "social_post": None,
                    "generic_write": None,
                }
            ],
        }
    )

    call = result.tool_calls[0]
    assert call.tool == "generate_write_lock_notification"
    assert call.trigger_type == "purchase"
    assert call.purchase.items[0].title == "Amazon Basics USB-C Cable"
    assert call.media[0].kind == "rendered_summary"


def test_autocomplete_indicates_payment_matches_tokens_not_exact_string():
    from browser_tools.write_lock import autocomplete_indicates_payment

    # Bare payment tokens still match.
    assert autocomplete_indicates_payment("cc-number") is True
    assert autocomplete_indicates_payment("cc-csc") is True
    # HTML autocomplete is a space-separated token list; a payment token inside
    # a multi-token value must still be detected so the field cannot evade the
    # write lock.
    assert autocomplete_indicates_payment("section-checkout billing cc-number") is True
    assert autocomplete_indicates_payment("shipping cc-exp") is True
    # Non-payment autocomplete values must not match.
    assert autocomplete_indicates_payment("email") is False
    assert autocomplete_indicates_payment("shipping street-address") is False
    assert autocomplete_indicates_payment("") is False


def test_write_lock_notification_schema_normalizes_provider_aliases():
    from browser_tools.schemas import GenerateWriteLockNotificationTool

    result = GenerateWriteLockNotificationTool.model_validate(
        {
            "tool": "generate_write_lock_notification",
            "trigger_type": "purchase",
            "action": "Buy 1 Carhartt Men's Knit Cuffed Beanie on Amazon",
            "service": {
                "name": "Amazon",
                "domain": "amazon.com",
                "current_url": "https://www.amazon.com/gp/buy/spc/handlers/display.html",
            },
            "media": [
                {
                    "type": "image",
                    "url": "https://m.media-amazon.com/images/I/example.jpg",
                    "alt": "Carhartt Men's Knit Cuffed Beanie, Black",
                }
            ],
            "purchase": {
                "items": [
                    {
                        "name": "Carhartt Men's Knit Cuffed Beanie, Black",
                        "quantity": 1,
                        "rating": 5.0,
                        "price_usd": 19.99,
                        "reviews": "167,432 ratings",
                        "product_url": "https://www.amazon.com/dp/B000000001",
                        "seller": "Amazon.com",
                        "shipping": "FREE Two Day delivery, arriving Saturday, Jun 27, 2026",
                    }
                ],
                "subtotal_usd": 19.99,
                "shipping_usd": 0,
                "estimated_tax_usd": 1.75,
                "total_usd": 21.74,
                "payment_method": "Visa ending in 9857",
                "delivery_address": "Aman Gottumukkala, 88 HOWARD ST APT 1413, SAN FRANCISCO, CA 94105",
            },
        }
    )

    dumped = result.model_dump(exclude={"tool"}, exclude_none=True)
    assert dumped["service"]["url"] == "https://www.amazon.com/gp/buy/spc/handlers/display.html"
    assert dumped["media"][0]["kind"] == "product"
    assert dumped["purchase"]["items"][0]["title"] == "Carhartt Men's Knit Cuffed Beanie, Black"
    assert dumped["purchase"]["items"][0]["price"] == "$19.99"
    assert dumped["purchase"]["items"][0]["quantity"] == "1"
    assert dumped["purchase"]["items"][0]["rating"] == "5.0 stars"
    assert dumped["purchase"]["items"][0]["review_count"] == "167,432 ratings"
    assert dumped["purchase"]["items"][0]["seller"] == "Amazon.com"
    assert dumped["purchase"]["items"][0]["shipping"] == "FREE Two Day delivery, arriving Saturday, Jun 27, 2026"
    assert dumped["purchase"]["totals"]["subtotal"] == "$19.99"
    assert dumped["purchase"]["totals"]["shipping"] == "$0.00"
    assert dumped["purchase"]["totals"]["tax"] == "$1.75"
    assert dumped["purchase"]["totals"]["total"] == "$21.74"
    assert dumped["purchase"]["payment_method"] == "Visa ending in 9857"
    assert dumped["purchase"]["delivery_address"].startswith("Aman Gottumukkala")


def test_write_lock_notification_schema_normalizes_nested_total_aliases():
    from browser_tools.schemas import GenerateWriteLockNotificationTool

    result = GenerateWriteLockNotificationTool.model_validate(
        {
            "tool": "generate_write_lock_notification",
            "trigger_type": "purchase",
            "action": "Place an Amazon order",
            "service": {
                "name": "Amazon",
                "domain": "amazon.com",
                "current_url": "https://www.amazon.com/checkout",
            },
            "purchase": {
                "items": [
                    {
                        "title": "Carhartt beanie",
                        "price": "$19.99",
                        "rating": "4.8 stars",
                        "review_count": "167,432 ratings",
                        "product_url": "https://www.amazon.com/dp/B000000001",
                    }
                ],
                "totals": {
                    "items": "$19.99",
                    "shipping_and_handling": "$0.00",
                    "estimated_tax": "$1.72",
                    "order_total": "$21.71",
                },
            },
        }
    )

    totals = result.model_dump(exclude={"tool"}, exclude_none=True)["purchase"]["totals"]
    assert totals["subtotal"] == "$19.99"
    assert totals["shipping"] == "$0.00"
    assert totals["tax"] == "$1.72"
    assert totals["total"] == "$21.71"


def test_write_lock_purchase_schema_rejects_missing_product_context():
    from pydantic import ValidationError

    from browser_tools.schemas import GenerateWriteLockNotificationTool

    try:
        GenerateWriteLockNotificationTool.model_validate(
            {
                "tool": "generate_write_lock_notification",
                "trigger_type": "purchase",
                "action": "buy item",
                "service": {
                    "name": "Amazon",
                    "domain": "amazon.com",
                    "url": "https://www.amazon.com/checkout",
                },
                "purchase": {"items": [{"title": "Beanie"}]},
            }
        )
    except ValidationError as error:
        message = str(error)
        assert "rating" in message
        assert "review_count" in message
        assert "product_url" in message
    else:
        raise AssertionError("purchase approval accepted an item without reviews and a product URL")


def test_write_lock_purchase_schema_rejects_current_non_product_page_as_product_link():
    from pydantic import ValidationError

    from browser_tools.schemas import GenerateWriteLockNotificationTool

    current_url = "https://shop.example/session/abc"
    try:
        GenerateWriteLockNotificationTool.model_validate(
            {
                "tool": "generate_write_lock_notification",
                "trigger_type": "purchase",
                "action": "buy item",
                "service": {
                    "name": "Example Shop",
                    "domain": "shop.example",
                    "url": current_url,
                },
                "purchase": {
                    "items": [
                        {
                            "title": "Beanie",
                            "rating": "4.8 stars",
                            "review_count": "312 reviews",
                            "product_url": current_url,
                        }
                    ]
                },
            }
        )
    except ValidationError as error:
        assert "current checkout or session page" in str(error)
    else:
        raise AssertionError("purchase approval accepted the current session URL as a product link")


def test_write_lock_purchase_schema_rejects_product_host_not_observed_by_browser():
    from pydantic import ValidationError

    from browser_tools.schemas import GenerateWriteLockNotificationTool

    payload = {
        "tool": "generate_write_lock_notification",
        "trigger_type": "purchase",
        "action": "buy item",
        "service": {
            "name": "Example Shop",
            "domain": "example.com",
            "url": "https://example.com/checkout",
        },
        "purchase": {
            "items": [
                {
                    "title": "Beanie",
                    "rating": "4.8 stars",
                    "review_count": "312 reviews",
                    "product_url": "https://phishing.example/products/beanie",
                }
            ]
        },
    }

    try:
        GenerateWriteLockNotificationTool.model_validate(
            payload,
            context={"trusted_page_urls": ["https://example.com/products/beanie", "https://example.com/checkout"]},
        )
    except ValidationError as error:
        assert "host was not observed" in str(error)
    else:
        raise AssertionError("purchase approval accepted an unobserved product host")


def test_normalize_write_lock_notification_tool_call_preserves_params():
    out = normalize_browser_use_tool_call(
        {
            "id": "call_1",
            "name": "generate_write_lock_notification",
            "arguments": json.dumps(
                {
                    "trigger_type": "purchase",
                    "action": "buy item",
                    "service": {
                        "name": "Amazon",
                        "domain": "amazon.com",
                        "url": "https://www.amazon.com/gp/buy/spc",
                    },
                    "purchase": {
                        "items": [{"title": "Beanie", "price": "$19.99"}],
                        "totals": {"total": "$21.74"},
                    },
                }
            ),
        },
        thinking="approval metadata",
    )

    assert out["action"] == "generate_write_lock_notification"
    assert out["thinking"] == "approval metadata"
    assert out["params"]["trigger_type"] == "purchase"
    assert out["params"]["service"]["domain"] == "amazon.com"
    assert out["params"]["purchase"]["items"][0]["title"] == "Beanie"


def test_browser_attempt_completion_uses_canonical_prompt_and_empty_schema():
    tools = build_browser_use_tools(["attempt_completion"])

    completion = tools[0]
    assert completion["description"] == attempt_completion_prompt.strip()
    assert "When you are in PLAN phase" not in completion["description"]
    assert "When you are in EXECUTE phase" not in completion["description"]
    assert completion["input_schema"]["properties"] == {}
    assert completion["input_schema"]["required"] == []


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


def test_build_messages_browser_state_includes_timezone_aware_timestamp():
    msgs = build_browser_use_messages(
        task="Click submit",
        browser_state=_browser_state(timestamp="2026-05-27T22:39:24Z"),
        action_history=[],
        available_actions=["click"],
        include_screenshot=False,
    )
    assert "Timestamp: 2026-05-27T22:39:24Z" in msgs[1]["content"]
    assert msgs[1]["content"].index("Timestamp:") < msgs[1]["content"].index("Current URL:")


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


def test_build_messages_appends_extra_user_messages():
    msgs = build_browser_use_messages(
        task="t",
        browser_state=_browser_state(),
        action_history=[],
        available_actions=["click"],
        include_screenshot=False,
        extra_user_messages=[{"role": "user", "content": "OTP 123456"}],
    )
    assert len(msgs) == 3
    assert msgs[2] == {"role": "user", "content": "OTP 123456"}


def test_build_messages_turn_history_keeps_goal_first_and_state_last():
    msgs = build_browser_use_messages(
        task="# Current Goal\nBuy socks",
        browser_state=_browser_state(),
        action_history=[{"step": 1, "action": "click", "result": {"success": True}}],
        available_actions=["click"],
        include_screenshot=False,
        dynamic_system_context="# User Context\nDelivery address",
        turn_messages=[
            {
                "role": "assistant",
                "content": "I will click submit.",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "click", "arguments": '{"index":1}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "name": "click", "content": '{"success":true}'},
        ],
    )
    assert [m["role"] for m in msgs] == ["system", "user", "assistant", "tool", "user"]
    assert "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" in msgs[0]["content"]
    assert "# User Context\nDelivery address" in msgs[0]["content"]
    assert msgs[1]["content"] == "# Current Goal\nBuy socks"
    assert "Previous Actions:" not in msgs[-1]["content"]
    assert "Current URL: https://example.com - Example" in msgs[-1]["content"]


def test_build_messages_turn_history_filters_in_progress_and_duplicate_tool_results():
    turn_messages = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": "click", "arguments": '{"index":1}'}}
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "click",
            "content": '{"success":false,"toolStatus":"IN_PROGRESS"}',
        },
        {"role": "tool", "tool_call_id": "call_1", "name": "click", "content": '{"success":false}'},
        {"role": "tool", "tool_call_id": "call_1", "name": "click", "content": '{"success":true}'},
    ]
    filtered = filter_browser_turn_messages(turn_messages)
    assert [message["role"] for message in filtered] == ["assistant", "tool"]
    assert filtered[-1]["content"] == '{"success":true}'

    msgs = build_browser_use_messages(
        task="# Current Goal\nBuy socks",
        browser_state=_browser_state(),
        action_history=[],
        available_actions=["click"],
        include_screenshot=False,
        turn_messages=turn_messages,
    )
    assert [message["role"] for message in msgs] == ["system", "user", "assistant", "tool", "user"]
    assert msgs[3]["content"] == '{"success":true}'


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
    assert extract_json(None) is None


# =====================================================================
# normalize_browser_use_response
# =====================================================================


def test_normalize_flat_action_shape():
    out = normalize_browser_use_response(
        {
            "thinking": "t",
            "action": [{"action_name": "click", "index": 5}],
        }
    )
    assert out["action"] == "click"
    assert out["index"] == 5
    assert out["thinking"] == "t"


def test_normalize_nested_action_shape():
    out = normalize_browser_use_response(
        {
            "thinking": "t",
            "action": [{"click": {"index": 7}}],
        }
    )
    assert out["action"] == "click"
    assert out["index"] == 7


def test_normalize_remaps_navigate_to_goto():
    out = normalize_browser_use_response(
        {
            "action": [{"navigate": {"url": "https://x.com"}}],
        }
    )
    assert out["action"] == "goto"
    assert out["params"]["url"] == "https://x.com"


def test_normalize_remaps_done_to_attempt_completion():
    out = normalize_browser_use_response(
        {
            "action": [{"action_name": "done", "text": "all good"}],
        }
    )
    assert out["action"] == "attempt_completion"
    assert out["params"]["text"] == "all good"


def test_normalize_click_coordinates_to_click_with_coords():
    out = normalize_browser_use_response(
        {
            "action": [{"click_coordinates": {"x": 100, "y": 200}}],
        }
    )
    assert out["action"] == "click"
    assert out["coordinates"] == {"x": 100, "y": 200}


def test_normalize_input_text_remap():
    out = normalize_browser_use_response(
        {
            "action": [{"input": {"index": 2, "text": "hello"}}],
        }
    )
    assert out["action"] == "input_text"
    assert out["index"] == 2
    assert out["params"]["text"] == "hello"


def test_normalize_request_user_assistance():
    out = normalize_browser_use_response(
        {
            "action": [{"request_user_assistance_for_authentication": {}}],
        }
    )
    assert out["action"] == "request_user_assistance_for_authentication"
    assert out["params"] == {}


def test_normalize_request_payment_card_preserves_receipt():
    out = normalize_browser_use_response(
        {
            "thinking": "checkout total is ready",
            "action": [
                {
                    "request_payment_card": {
                        "merchant": "Rose Labs Test Payment",
                        "currency": "USD",
                        "line_items": [
                            {
                                "name": "Aurora Notebook",
                                "image_url": "https://example.test/notebook.png",
                                "product_url": "https://example.test/products/aurora-notebook",
                                "rating": "4.9 stars",
                                "review_count": "217 reviews",
                                "unit_price_cents": 1200,
                                "quantity": 1,
                                "line_total_cents": 1200,
                            }
                        ],
                        "fees": [{"label": "Tax", "amount_cents": 99}],
                        "subtotal_cents": 1200,
                        "total_cents": 1299,
                    }
                }
            ],
        }
    )

    assert out["action"] == "request_payment_card"
    assert out["thinking"] == "checkout total is ready"
    assert out["params"]["merchant"] == "Rose Labs Test Payment"
    assert out["params"]["line_items"][0]["image_url"] == "https://example.test/notebook.png"
    assert out["params"]["fees"][0]["amount_cents"] == 99
    assert out["params"]["subtotal_cents"] == 1200
    assert out["params"]["total_cents"] == 1299


def test_normalize_request_payment_card_parses_tool_string_arguments():
    out = normalize_browser_use_response(
        {
            "action": [
                {
                    "request_payment_card": {
                        "merchant": "Rose Labs Test Payment",
                        "currency": "USD",
                        "line_items": '[{"name":"Aurora Notebook","image_url":"https://example.test/notebook.png","product_url":"https://example.test/products/aurora-notebook","rating":"4.9 stars","review_count":"217 reviews","unit_price_cents":1200,"quantity":1,"line_total_cents":1200}]',
                        "fees": '[{"name":"Tax","amount_cents":99}]',
                        "subtotal_cents": "1200",
                        "total_cents": "1299",
                    }
                }
            ],
        }
    )

    assert out["action"] == "request_payment_card"
    assert out["params"]["line_items"][0]["name"] == "Aurora Notebook"
    assert out["params"]["fees"][0]["amount_cents"] == 99
    assert out["params"]["subtotal_cents"] == 1200
    assert out["params"]["total_cents"] == 1299


def test_normalize_provider_tool_call():
    out = normalize_browser_use_tool_call(
        {"id": "call_1", "name": "click", "arguments": '{"index": 4}'},
        thinking="saw submit button",
    )
    assert out["action"] == "click"
    assert out["index"] == 4
    assert out["thinking"] == "saw submit button"


def test_normalize_prefers_thinking_over_next_goal():
    # Envelope was shrunk: `thinking` is the canonical field. `next_goal` is
    # only consulted as a defensive fallback when `thinking` is absent.
    out = normalize_browser_use_response(
        {
            "thinking": "thinking str",
            "next_goal": "next goal str",
            "action": [{"action_name": "scroll", "down": True}],
        }
    )
    assert out["thinking"] == "thinking str"


def test_normalize_falls_back_to_next_goal_when_no_thinking():
    out = normalize_browser_use_response(
        {
            "next_goal": "next goal str",
            "action": [{"action_name": "scroll", "down": True}],
        }
    )
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


def test_params_input_text_preserves_clear_false():
    out = _normalize_action_params("input_text", "input_text", {"text": "hi", "clear": False}, {}, 4)
    assert out["text"] == "hi"
    assert out["clear"] is False
    assert out["index"] == 4


def test_params_query_to_instruction():
    out = _normalize_action_params("extract", "extract", {"query": "find headlines"}, {}, None)
    assert out["instruction"] == "find headlines"


def test_params_select_dropdown_text_to_value():
    out = _normalize_action_params("select_dropdown", "select_dropdown", {"text": "Option A"}, {}, None)
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
    lines += _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 5}},
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
            "delta": {"type": "text_delta", "text": text},
        },
    )
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 4},
        },
    )
    lines += _ev("message_stop", {"type": "message_stop"})
    return "\n".join(lines)


def _anthropic_tool_sse(name: str, arguments: str) -> str:
    lines: list[str] = []
    lines += _ev(
        "message_start",
        {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 5}},
        },
    )
    lines += _ev(
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "tool_use", "id": "toolu_1", "name": name, "input": {}},
        },
    )
    lines += _ev(
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "input_json_delta", "partial_json": arguments},
        },
    )
    lines += _ev("content_block_stop", {"type": "content_block_stop", "index": 0})
    lines += _ev(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "tool_use"},
            "usage": {"output_tokens": 4},
        },
    )
    lines += _ev("message_stop", {"type": "message_stop"})
    return "\n".join(lines)


_ACTION_TEXT = '{"thinking": "x", "action": [{"action_name": "click", "index": 3}]}'


async def test_complete_browser_use_waterfall_only_path():
    """No claudeAuth → goes straight to openrouter → returns waterfall mode."""
    sse_body = _openai_sse(
        [
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call_click",
                                    "type": "function",
                                    "function": {"name": "click", "arguments": '{"index": 3}'},
                                }
                            ]
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
            {"usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20}},
        ]
    )

    captured: list[str] = []
    captured_bodies: list[dict] = []

    def handler(req):
        captured.append(str(req.url))
        captured_bodies.append(json.loads(req.content.decode()))
        return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")

    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}):
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
    assert captured_bodies
    body = captured_bodies[0]
    assert body["tool_choice"] == "auto"
    assert body["tools"][0]["function"]["name"] == "click"
    assert body["tools"][0]["function"]["description"] == BROWSER_USE_TOOLS["click"]["description"]
    assert "# Available Actions" not in body["messages"][0]["content"]


async def test_complete_browser_use_claude_path_succeeds():
    """Valid claudeAuth receives native tools and returns a native tool call."""
    captured_bodies: list[dict] = []

    def handler(req):
        url = str(req.url)
        if "api.anthropic.com" in url:
            captured_bodies.append(json.loads(req.content.decode()))
            return httpx.Response(
                200,
                text=_anthropic_tool_sse("click", '{"index": 3}'),
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
    assert captured_bodies
    body = captured_bodies[0]
    assert body["tool_choice"]["type"] == "auto"
    assert body["tools"][0]["name"] == "click"
    assert body["tools"][0]["description"] == BROWSER_USE_TOOLS["click"]["description"]


async def test_complete_browser_use_gpt_path_succeeds():
    """Valid gptAuth -> Codex Responses returns a native tool call -> mode=gpt."""
    sse_lines = []
    sse_lines += _ev(
        "response.output_item.done",
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_click",
                "name": "click",
                "arguments": '{"index": 3}',
            },
        },
    )
    sse_lines += _ev(
        "response.completed",
        {
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 8,
                    "total_tokens": 20,
                }
            },
        },
    )
    sse_body = "\n".join(sse_lines)

    captured: list[str] = []
    captured_bodies: list[dict] = []

    def handler(req):
        url = str(req.url)
        captured.append(url)
        if "chatgpt.com/backend-api/codex/responses" in url:
            captured_bodies.append(json.loads(req.content.decode()))
            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="should not hit waterfall")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    dump_root = ROOT.parent / ".llm-dumps" / "unbound"
    for path in dump_root.glob("*test-bu-gpt.json"):
        path.unlink()

    result = await client.complete_browser_use(
        task="click submit",
        browser_state=_browser_state(),
        action_history=[],
        available_actions=["click", "click_coordinates"],
        include_screenshot=False,
        gpt_auth=gpt_auth_from_token("good-gpt-token", "acct_123"),
        call_site="test-bu-gpt",
        dump_extra={
            "browser_recording_manifest_path": "/tmp/browser-recording/manifest.json",
            "iteration": 7,
        },
    )

    assert result["mode"] == "gpt"
    assert result["actual_model"] == "gpt-5.6-sol-gpt"
    assert result["action"]["action"] == "click"
    assert result["gpt_token_error"] is None
    assert result["usage"]["total_tokens"] == 20
    assert any("chatgpt.com/backend-api/codex/responses" in u for u in captured)
    assert all("openrouter.ai" not in u for u in captured)
    assert captured_bodies
    body = captured_bodies[0]
    assert body["tool_choice"] == "auto"
    assert body["tools"][0]["name"] == "click"
    assert [tool["name"] for tool in body["tools"]] == ["click"]
    assert body["tools"][0]["description"] == BROWSER_USE_TOOLS["click"]["description"]
    assert "# Available Actions" not in body["instructions"]

    dumps = sorted(dump_root.glob("*test-bu-gpt.json"))
    assert dumps, "complete_browser_use should dump exact LLM context"
    payload = json.loads(dumps[-1].read_text())
    assert payload["model"] == "gpt-5.6-sol"
    assert payload["message_count"] == 2
    assert [message["role"] for message in payload["messages"]] == ["system", "user"]
    assert payload["config"]["actual_model"] == "gpt-5.6-sol"
    assert payload["config"]["actual_model_raw"] == "gpt-5.6-sol-gpt"
    assert payload["config"]["mode"] == "gpt"
    assert payload["config"]["effective_params"]["model"] == "gpt-5.6-sol"
    assert payload["config"]["effective_params"]["temperature"] is None
    assert payload["config"]["effective_params"]["max_tokens"] is None
    assert payload["config"]["requested_params"]["temperature"] == 1.0
    assert payload["config"]["requested_params"]["max_tokens"] == 16000
    assert payload["tools"][0]["name"] == "click"
    assert [tool["name"] for tool in payload["tools"]] == ["click"]
    assert payload["config"]["tool_choice"] == "auto"
    assert payload["extra"]["browser_recording_manifest_path"] == "/tmp/browser-recording/manifest.json"
    assert payload["extra"]["iteration"] == 7


async def test_complete_browser_use_bypasses_fast_cache_context():
    """Browser-use LLM calls must not read or write provider fast-cache."""
    sse_lines = []
    sse_lines += _ev(
        "response.output_item.done",
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_click",
                "name": "click",
                "arguments": '{"index": 3}',
            },
        },
    )
    sse_lines += _ev(
        "response.completed",
        {
            "type": "response.completed",
            "response": {"usage": {"input_tokens": 12, "output_tokens": 8, "total_tokens": 20}},
        },
    )
    sse_body = "\n".join(sse_lines)
    captured: list[str] = []

    def handler(req):
        url = str(req.url)
        captured.append(url)
        if "fast-cache" in url:
            return httpx.Response(500, text="browser-use should bypass fast-cache")
        if "chatgpt.com/backend-api/codex/responses" in url:
            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="unexpected endpoint")

    set_mock_handler(handler)
    token = set_context(FastCacheContext(enabled=True, goal="click submit", write_enabled=True))
    try:
        client = RoseClient(openrouter_key="ork-x")
        result = await client.complete_browser_use(
            task="click submit",
            browser_state=_browser_state(),
            action_history=[],
            available_actions=["click", "click_coordinates"],
            include_screenshot=False,
            gpt_auth=gpt_auth_from_token("good-gpt-token", "acct_123"),
            agent_id="agent-fast-cache-bypass",
            call_site="browser_use_step_1",
        )
    finally:
        reset_context(token)

    assert result["action"]["action"] == "click"
    assert not any("fast-cache" in url for url in captured)
    assert any("chatgpt.com/backend-api/codex/responses" in url for url in captured)


async def test_complete_browser_use_gpt_rate_limit_preserves_tools_for_anthropic_api_key():
    """GPT rate-limit -> Anthropic API-key fallback still receives browser action tools."""
    import providers.rose.client as rc

    rc._reset_anthropic_api_key_cooldown_cache()
    captured: list[str] = []
    anthropic_bodies: list[dict] = []

    def handler(req):
        url = str(req.url)
        if req.url.path.endswith("/anthropic-key/cooldown"):
            return httpx.Response(200, json={"onCooldown": False})
        captured.append(url)
        if "chatgpt.com/backend-api/codex/responses" in url:
            return httpx.Response(
                429,
                json={
                    "error": {
                        "type": "usage_limit_reached",
                        "message": "The usage limit has been reached",
                    }
                },
            )
        if "api.anthropic.com" in url:
            anthropic_bodies.append(json.loads(req.content.decode()))
            return httpx.Response(
                200,
                text=_anthropic_tool_sse("click", '{"index": 3}'),
                headers={"Content-Type": "text/event-stream"},
            )
        return httpx.Response(500, text="should not hit openrouter")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")

    try:
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-test"}):
            result = await client.complete_browser_use(
                task="click submit",
                browser_state=_browser_state(),
                action_history=[],
                available_actions=["click", "goto"],
                include_screenshot=False,
                gpt_auth=gpt_auth_from_token("rate-limited-gpt-token", "acct_123"),
                call_site="test-bu-gpt-rate-limit-api-key-tools",
            )
    finally:
        rc._reset_anthropic_api_key_cooldown_cache()

    assert result["mode"] == "waterfall"
    assert result["actual_model"] == "claude-fable-5-anthropic"
    assert result["gpt_token_error"] == "rate_limit"
    assert result["action"]["action"] == "click"
    assert result["action"]["index"] == 3
    assert any("chatgpt.com/backend-api/codex/responses" in u for u in captured)
    assert any("api.anthropic.com" in u for u in captured)
    assert all("openrouter.ai" not in u for u in captured)
    assert anthropic_bodies
    body = anthropic_bodies[0]
    assert body["tool_choice"]["type"] == "auto"
    assert [tool["name"] for tool in body["tools"]] == ["click", "goto"]
    assert body["tools"][0]["description"] == BROWSER_USE_TOOLS["click"]["description"]


async def test_complete_browser_use_claude_401_falls_through_to_waterfall():
    """Anthropic 401 → fall through to openrouter; claude_token_error=auth_error."""
    sse_body = _openai_sse(
        [
            {"choices": [{"delta": {"content": _ACTION_TEXT}, "finish_reason": "stop"}]},
            {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
        ]
    )

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
    r.record("system_prompt_uses_native_tools", test_build_browser_use_system_prompt_uses_native_tools_not_action_list)
    r.record("system_prompt_hides_extract", test_build_browser_use_system_prompt_does_not_advertise_extract)
    r.record("state_has_indexed_dom_targets", test_state_has_indexed_dom_targets_detects_interactive_indices)
    r.record(
        "filter_actions_removes_coordinates_when_indexed",
        test_filter_browser_use_actions_removes_coordinates_when_dom_has_indices,
    )
    r.record(
        "filter_actions_keeps_coordinates_when_unindexed",
        test_filter_browser_use_actions_keeps_coordinates_for_unindexed_state,
    )
    r.record("native_tool_schemas_preserve_catalog", test_build_browser_use_tools_preserves_catalog_descriptions)
    r.record("native_tool_schemas_valid_required_keywords", test_build_browser_use_tools_emits_valid_required_keywords)
    r.record("write_lock_notification_schema", test_write_lock_notification_tool_is_stable_internal_action_schema)
    r.record(
        "autocomplete_indicates_payment_token_match",
        test_autocomplete_indicates_payment_matches_tokens_not_exact_string,
    )
    r.record(
        "write_lock_notification_alias_schema",
        test_write_lock_notification_schema_normalizes_provider_aliases,
    )
    r.record(
        "write_lock_notification_nested_totals",
        test_write_lock_notification_schema_normalizes_nested_total_aliases,
    )
    r.record(
        "write_lock_notification_requires_product_context",
        test_write_lock_purchase_schema_rejects_missing_product_context,
    )
    r.record(
        "write_lock_notification_rejects_current_session_link",
        test_write_lock_purchase_schema_rejects_current_non_product_page_as_product_link,
    )
    r.record(
        "write_lock_notification_rejects_unobserved_product_host",
        test_write_lock_purchase_schema_rejects_product_host_not_observed_by_browser,
    )

    r.record("messages_text_only_no_screenshot", test_build_messages_text_only_when_no_screenshot)
    r.record("messages_timezone_timestamp", test_build_messages_browser_state_includes_timezone_aware_timestamp)
    r.record("messages_multimodal_with_screenshot", test_build_messages_multimodal_when_screenshot_present)
    r.record("messages_http_screenshot_passthrough", test_build_messages_screenshot_url_passthrough_when_http)
    r.record("messages_action_history_formatting", test_build_messages_action_history_formatting)
    r.record("messages_include_screenshot_false", test_build_messages_include_screenshot_false_drops_image)
    r.record("messages_extra_user_messages", test_build_messages_appends_extra_user_messages)
    r.record("messages_turn_history", test_build_messages_turn_history_keeps_goal_first_and_state_last)
    r.record(
        "messages_turn_history_filters_tools",
        test_build_messages_turn_history_filters_in_progress_and_duplicate_tool_results,
    )

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
    r.record("normalize_request_auth_assistance", test_normalize_request_user_assistance)
    r.record("normalize_provider_tool_call", test_normalize_provider_tool_call)
    r.record(
        "normalize_write_lock_notification_tool_call",
        test_normalize_write_lock_notification_tool_call_preserves_params,
    )
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
    r.record("params_input_clear_false", test_params_input_text_preserves_clear_false)
    r.record("params_query_to_instruction", test_params_query_to_instruction)
    r.record("params_select_dropdown_text_value", test_params_select_dropdown_text_to_value)

    await r.record_async("complete_browser_use_waterfall_only", test_complete_browser_use_waterfall_only_path)
    await r.record_async("complete_browser_use_claude_path", test_complete_browser_use_claude_path_succeeds)
    await r.record_async("complete_browser_use_gpt_path", test_complete_browser_use_gpt_path_succeeds)
    await r.record_async(
        "complete_browser_use_bypasses_fast_cache", test_complete_browser_use_bypasses_fast_cache_context
    )
    await r.record_async(
        "complete_browser_use_gpt_rate_limit_api_key_tools",
        test_complete_browser_use_gpt_rate_limit_preserves_tools_for_anthropic_api_key,
    )
    await r.record_async(
        "complete_browser_use_claude_401_fallthrough", test_complete_browser_use_claude_401_falls_through_to_waterfall
    )

    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
