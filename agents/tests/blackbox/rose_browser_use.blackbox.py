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
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _test_utils import BlackboxResult, set_mock_handler, teardown_mock

import httpx

from providers.rose import POOL_REGISTRY, RoseClient, claude_auth_from_token, get_pool, gpt_auth_from_token
from providers.demo_cache.context import DemoCacheContext, reset_context, set_context
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
    normalize_browser_use_tool_calls,
    state_has_indexed_dom_targets,
)
from tools.prompts import attempt_completion_prompt
from utils.prompts import VERIFICATION_RULES

# Browser-use is a rose-fast pool. Tests that want OpenRouter must not inherit
# a live CEREBRAS_API_KEY; Cerebras-specific cases set it themselves.
os.environ.pop("CEREBRAS_API_KEY", None)


# =====================================================================
# Pool registry
# =====================================================================


def test_browser_use_pool_registered():
    assert "rose-1-browser-use" in POOL_REGISTRY
    spec = get_pool("rose-1-browser-use")
    assert spec.name == "rose-1-browser-use"
    assert spec.claude_auth_model == "claude-sonnet-5"
    assert spec.gpt_auth_model == "gpt-5.6-luna"
    assert spec.waterfall == ("qwen/qwen3.8-27b", "google/gemini-3.8-flash")
    assert spec.waterfall_reasoning_effort == "low"
    assert spec.direct_auth_enabled is False
    assert spec.cerebras_model == "qwen-3.8-27b"
    assert not any(m.startswith("anthropic/") for m in spec.waterfall)
    # Legacy bu/yutori models removed.
    assert all("yutori" not in m and "browser-use" not in m for m in spec.waterfall)


# =====================================================================
# Tool catalog + system prompt
# =====================================================================


def test_generate_tool_descriptions_filters_and_includes_params():
    out = generate_tool_descriptions(["click", "scroll", "unknown_action"])
    assert "- click:" in out
    assert "index=integer" in out
    assert "- scroll:" in out
    assert "direction=string" in out
    assert "amount=integer" in out
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


def test_recover_from_challenge_normalizes_and_preserves_reason():
    # The staged recovery tool must normalize and carry its evidence through.
    for completion in (
        {
            "thinking": "captcha wall",
            "action": [{"recover_from_challenge": {"reason": "captcha wall reappears"}}],
        },
        {
            "thinking": "429s",
            "action": [{"action_name": "recover_from_challenge", "reason": "repeated 429s on search"}],
        },
    ):
        result = normalize_browser_use_response(completion)
        assert result["action"] == "recover_from_challenge", result
        assert result["params"].get("reason"), result
        assert "auth_cookies_are_preserved" not in result["params"]


def test_recover_from_challenge_normalizes_auth_cookies_are_preserved_flag():
    """Auth-cookie preserve flag is an explicit tool param (default preserve when omitted)."""
    for raw, expected in (
        (True, True),
        (False, False),
        ("true", True),
        ("yes", True),
        ("false", False),
        (1, True),
        (0, False),
    ):
        result = normalize_browser_use_response(
            {
                "thinking": "guest captcha",
                "action": [
                    {
                        "recover_from_challenge": {
                            "reason": "Bot or Not on hotels.com search",
                            "auth_cookies_are_preserved": raw,
                        }
                    }
                ],
            }
        )
        assert result["action"] == "recover_from_challenge", result
        assert result["params"]["auth_cookies_are_preserved"] is expected, (raw, result)


def test_recovery_prompt_describes_solver_cookie_and_parallel_config_stages():
    description = BROWSER_USE_TOOLS["recover_from_challenge"]["description"]
    assert "Relatively expensive recovery to forcefully open" in description
    assert "Do not use when an alternate path can complete the goal" in description
    assert "Do not drag sliders" in description
    assert "automatic CAPTCHA solver" in description
    assert "known challenge cookies" in description
    assert "parallel cookie-group reductions" in description
    assert "auth_cookies_are_preserved=true" in description
    assert "fresh cookie state" in description
    assert "Kernel residential" in description
    assert "Kernel mobile" in description
    assert "ISP" in description
    assert "Steel managed/fixed-IP" in description
    assert "in parallel" in description
    assert "user's default" in description
    assert "rotate_ip" not in BROWSER_USE_TOOLS
    reason = BROWSER_USE_TOOLS["recover_from_challenge"]["params"]["reason"]["description"]
    assert "force-opened" in reason
    assert "alternate goal path" in reason
    preserve_flag = BROWSER_USE_TOOLS["recover_from_challenge"]["params"]["auth_cookies_are_preserved"]
    assert preserve_flag["type"] == "boolean"
    assert "authenticated state" in preserve_flag["description"]
    assert "fresh cookie state" in preserve_flag["description"]
    assert "poisoning" in preserve_flag["description"]


def test_build_browser_use_system_prompt_uses_native_tools_not_action_list():
    prompt = build_browser_use_system_prompt(["click", "goto"])
    assert "# Role" in prompt
    assert "You are a browser automation agent. You take in a user goal" in prompt
    assert "Call `read_browser_state` whenever you need" in prompt
    assert "Page stats and open tabs" in prompt
    assert "Use `screenshot` when you need a viewport image" in prompt
    assert "The full prior assistant/tool turn history" not in prompt
    assert "# Available Actions" not in prompt
    assert "- click:" not in prompt
    assert "- goto:" not in prompt
    assert "call exactly one available browser action tool" in prompt
    assert "# Screenshot Tool" not in prompt
    assert "Use the `screenshot` action" not in prompt
    assert "do not open cancellation, return, edit, or modification flows" in prompt
    assert "call attempt_completion promptly" in prompt


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


def test_filter_browser_use_actions_keeps_coordinates_when_dom_has_indices():
    actions = ["click", "click_coordinates", "wait"]
    browser_state = {"dom_tree": "[92]<button aria-label=Add item to Cart />"}

    out = filter_browser_use_actions_for_state(actions, browser_state)

    assert out == actions


def test_filter_browser_use_actions_keeps_coordinates_for_unindexed_state():
    actions = ["click", "click_coordinates", "wait"]
    browser_state = {"dom_tree": "<canvas id=game />"}

    out = filter_browser_use_actions_for_state(actions, browser_state)

    assert out == actions


def test_filter_keeps_click_coordinates_on_bot_or_not_captcha_shell():
    """Hotels.com Bot or Not mounts indexed shell nodes with no slider index.

    click_coordinates must stay in the tool list so the model can engage a
    visual-only widget after screenshot; stripping it produced
    'no interactive solve control is available' recoveries.
    """
    actions = ["click", "click_coordinates", "screenshot", "wait", "recover_from_challenge"]
    browser_state = {
        "dom_tree": (
            "[3545]<div id=app-captcha-pwa />\n"
            "\t[3582]<a />\n"
            "\tShow us your human side...\n"
            "\tWe can't tell if you're a human or a bot.\n"
            "\t[3594]<span />\n"
            "\t6d75d0d4-6be2-4c72-aa2f-af218aad299f"
        ),
        "title": "Bot or Not?",
        "url": "https://www.hotels.com/bot-or-not",
    }

    out = filter_browser_use_actions_for_state(actions, browser_state)

    assert out == actions
    assert "click_coordinates" in out


def test_screenshot_tool_desc_calls_out_misleading_captcha_dom():
    tools = build_browser_use_tools(["screenshot"])
    desc = tools[0]["description"]
    assert "misleading shell" in desc
    assert "Bot or Not" in desc
    assert "drag" in desc
    assert "recover_from_challenge" not in desc


def test_drag_tool_in_catalog_and_normalizes_coordinates():
    assert "drag" in BROWSER_USE_TOOLS
    tools = build_browser_use_tools(["drag"])
    assert tools[0]["name"] == "drag"
    assert "slider" in tools[0]["description"].lower() or "CAPTCHA" in tools[0]["description"]

    out = normalize_browser_use_response(
        {
            "thinking": "slide captcha",
            "action": [{"drag": {"start_x": 400, "start_y": 420, "end_x": 900, "end_y": 420, "steps": 30}}],
        }
    )
    assert out["action"] == "drag"
    assert out["params"]["start_x"] == 400
    assert out["params"]["end_x"] == 900
    assert out["params"]["steps"] == 30


def test_drag_tool_schema_requires_start_and_end():
    from browser_tools.schemas import DragTool

    DragTool.model_validate({"tool": "drag", "source_index": 1, "target_index": 2})
    DragTool.model_validate({"tool": "drag", "start_x": 1, "start_y": 2, "end_x": 3, "end_y": 4})
    try:
        DragTool.model_validate({"tool": "drag", "start_x": 1, "start_y": 2})
        raise AssertionError("expected validation error")
    except Exception:
        pass


def test_build_browser_use_system_prompt_auth_priority_is_numbered():
    prompt = build_browser_use_system_prompt(["recover_from_challenge"])

    assert "- Use the cheapest viable authentication path for this single site." in prompt
    assert "- Priority:\n  - 1. Existing Steel/cookie session" in prompt
    assert "  - 2. Passkey (if one is listed in Auth Options)" in prompt
    assert "  - 3. Saved passwords" in prompt
    assert "  - 4. Email OTP" in prompt
    assert "  - 5. SMS OTP" in prompt
    assert "  - 6. Guest/anonymous completion, if viable" in prompt
    assert (
        "- If members pay less than guests and membership is free, sign up with the minted account instead of checking out as a guest; if sign-up fails, check out as a guest.\n"
        in prompt
    )
    assert "  - 7. Minted account\n" in prompt
    assert "  - 8. request_user_assistance_for_authentication" in prompt
    assert "OTP codes from email or SMS are automatically injected" in prompt
    assert "call request_user_assistance_for_authentication" in prompt
    assert "Do not call attempt_completion, send_message_to_user, or report a status instead." in prompt
    assert (
        "CAPTCHA, bot challenges, 'Bot or Not' walls, and access-denied interstitials are not authentication." in prompt
    )
    assert "relatively expensive way to force-open a blocked page or service" in prompt
    assert "do not use it when an alternate path can complete the goal" in prompt
    assert "Do not drag sliders" in prompt
    assert "# OTP Rules" not in prompt
    assert "Do not classify final credential failures yourself" not in prompt


def test_auth_assistance_requires_sign_in_form_open_with_and_without_challenge_recovery():
    """A handoff preserves the current auth step, including an accepted-password challenge."""
    blocked_step = "leave the auth step you are blocked on open and visible"
    for disable_recover in ("", "1"):
        with patch.dict(os.environ, {"BROWSER_DISABLE_RECOVER_FROM_CHALLENGE": disable_recover}):
            (auth_help,) = build_browser_use_tools(["request_user_assistance_for_authentication"])
            prompt = build_browser_use_system_prompt(
                ["request_user_assistance_for_authentication", "recover_from_challenge"]
            )
        assert blocked_step in auth_help["description"], f"tool description missing rule (disable={disable_recover!r})"
        assert blocked_step in prompt, f"system prompt missing rule (disable={disable_recover!r})"
        # A pending approval is the blocked step; sending the agent back to a password form cancels it.
        assert "username/password or code entry" not in auth_help["description"]
        assert "username/password or code entry" not in prompt


def test_build_browser_use_system_prompt_reuses_main_grading_prompt():
    prompt = build_browser_use_system_prompt([])

    assert VERIFICATION_RULES.strip() in prompt
    assert "# Verification" not in prompt
    assert "Browser-specific notes:" not in prompt


def test_build_browser_use_system_prompt_requires_ordered_option_set_capture():
    """Cement: earliest/cheapest picks must leave a grounded filtered option set."""
    prompt = build_browser_use_system_prompt([])

    assert "choosing among ordered options" in prompt
    assert "earliest/latest showtime" in prompt
    assert "capture the full filtered option set" in prompt
    assert "Enumerate every option in display order" in prompt
    assert "scrollable or virtualized lists" in prompt
    assert "Do not select until the complete set and the selected option are recorded" in prompt
    assert "`extract`" not in prompt


def test_build_browser_use_tools_preserves_catalog_descriptions():
    tools = build_browser_use_tools(
        [
            "read_browser_state",
            "click",
            "request_user_assistance_for_authentication",
            "request_payment_card",
            "generate_write_lock_notification",
            "unknown_action",
        ]
    )
    assert [tool["name"] for tool in tools] == [
        "read_browser_state",
        "click",
        "request_user_assistance_for_authentication",
        "request_payment_card",
        "generate_write_lock_notification",
    ]

    read_state = tools[0]
    assert read_state["description"] == BROWSER_USE_TOOLS["read_browser_state"]["description"]
    assert "auto-injected" not in read_state["description"].lower()
    assert "NOT injected" not in read_state["description"]
    assert "# Current Browser State" in read_state["description"]

    click = tools[1]
    assert click["description"] == BROWSER_USE_TOOLS["click"]["description"]
    assert click["input_schema"]["properties"]["index"]["type"] == "integer"
    assert "Element index" in click["input_schema"]["properties"]["index"]["description"]
    assert click["input_schema"]["required"] == ["index"]

    auth_help = tools[2]
    assert auth_help["description"] == BROWSER_USE_TOOLS["request_user_assistance_for_authentication"]["description"]
    assert "Never use this for CAPTCHA" in auth_help["description"]
    assert "Bot or Not" in auth_help["description"]
    assert auth_help["input_schema"]["properties"] == {}
    assert auth_help["input_schema"]["required"] == []

    payment = tools[3]
    assert "only if checkout requires you to enter new card details" in payment["description"]
    assert "valid saved payment method is already selected" in payment["description"]
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

    write_lock = tools[4]
    purchase_item = write_lock["input_schema"]["properties"]["purchase"]["properties"]["items"]["items"]
    assert purchase_item["required"] == ["title", "rating", "review_count", "product_url"]
    review_count_description = purchase_item["properties"]["review_count"]["description"]
    assert "followed by 'reviews' or 'ratings'" in review_count_description
    assert "312 reviews" in review_count_description
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


def test_provider_tool_schemas_follow_browser_pydantic_models():
    from browser_tools.schemas import BROWSER_TOOL_MODELS

    generated = {tool["name"]: tool for tool in build_browser_use_tools(list(BROWSER_TOOL_MODELS))}

    assert set(generated) == set(BROWSER_TOOL_MODELS)
    for tool_name, model in BROWSER_TOOL_MODELS.items():
        schema_fields = set(generated[tool_name]["input_schema"]["properties"])
        model_fields = set(model.model_fields) - {"tool"}
        assert schema_fields == model_fields, (
            f"{tool_name} provider schema drifted from its Pydantic model: "
            f"provider={sorted(schema_fields)}, model={sorted(model_fields)}"
        )

    wait_schema = generated["wait"]["input_schema"]
    assert wait_schema["required"] == ["time_ms"]
    assert wait_schema["properties"]["time_ms"]["type"] == "integer"
    assert wait_schema["properties"]["time_ms"]["maximum"] == 60_000


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


def test_write_lock_purchase_schema_accepts_current_page_as_product_link():
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
    except ValidationError as error:  # pragma: no cover - documents the removed rule
        raise AssertionError(
            f"product_url is validated for well-formedness only; the current session URL must be accepted: {error}"
        ) from error


def test_write_lock_purchase_schema_rejects_product_host_not_observed_by_browser():
    """An unobserved product host must be rejected (CWE-601).

    Replaces test_write_lock_purchase_schema_accepts_product_host_not_observed_by_browser,
    which asserted that https://phishing.example/products/beanie was accepted
    while the browser had only visited example.com. The write-lock notification
    renders product_url to the user as a clickable link, so accepting an
    arbitrary host is a destination-author primitive.

    Only the HOST is constrained; the path/query heuristics that rejected
    receipts from working checkouts stay removed.
    """
    from pydantic import ValidationError

    from browser_tools.schemas import GenerateWriteLockNotificationTool

    def payload_with(product_url: str) -> dict:
        return {
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
                        "product_url": product_url,
                    }
                ]
            },
        }

    trusted = {
        "trusted_page_urls": [
            "https://example.com/products/beanie",
            "https://example.com/checkout",
        ]
    }

    # A host the browser actually visited still validates.
    GenerateWriteLockNotificationTool.model_validate(
        payload_with("https://example.com/products/beanie"), context=trusted
    )

    # An unrelated host must now fail closed.
    try:
        GenerateWriteLockNotificationTool.model_validate(
            payload_with("https://phishing.example/products/beanie"), context=trusted
        )
    except ValidationError:
        return
    raise AssertionError("an unobserved product host must be rejected")


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
                        "items": [
                            {
                                "title": "Beanie",
                                "price": "$19.99",
                                "rating": "4.8 stars",
                                "review_count": "312 reviews",
                                "product_url": "https://www.amazon.com/dp/beanie",
                            }
                        ],
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


def test_format_browser_state_for_tool_matches_legacy_injection_text():
    from providers.rose.browser_use import build_browser_state_message_content, format_browser_state_for_tool

    state = _browser_state(timestamp="2026-08-22T20:31:00Z")
    assert format_browser_state_for_tool(state) == build_browser_state_message_content(
        task="",
        browser_state=state,
        include_screenshot=False,
        include_task=False,
    )


async def test_execute_read_browser_state_returns_formatted_snapshot():
    from domains.spawn_browser_agent_v3.service_actions import _ActionContext, _execute_read_browser_state

    dom = MagicMock()
    dom.get_browser_state = AsyncMock(
        return_value={
            "url": "https://example.com/cart",
            "title": "Cart",
            "viewport": {"width": 1280, "height": 800},
            "scroll_position": {"x": 0, "y": 0, "pages_above": 0, "pages_below": 1},
            "page_stats": {"links": 1, "interactive": 2, "iframes": 0, "scroll_containers": 0, "total_elements": 3},
            "tabs": [],
            "dom_tree": "[7]<button>Checkout</button>",
        }
    )
    action_history = MagicMock()
    action_history.record_action = AsyncMock()
    context = _ActionContext(
        dom_service=dom,
        action_history=action_history,
        session=MagicMock(),
        action_name="read_browser_state",
        index=None,
        params={},
        thinking="Need indexes",
        coords=None,
        element=None,
        available_file_paths=None,
        session_id="sess-1",
        user_id="user-1",
        config=None,
        humanizer=None,
        secret_refs=None,
        password_origins=None,
        credential_refs_by_secret_ref=None,
        current_url="https://example.com/cart",
        trusted_page_urls=None,
        write_lock_enabled=True,
        write_lock_approvals=None,
        system_name="Rose",
        browser_network_recorder=None,
        current_auth_realm="",
        prepare_credentials_for_url=None,
    )
    result = await _execute_read_browser_state(context)
    assert result["success"] is True
    assert "Interactive elements:" in result["formatted_state"]
    assert "[7]<button>Checkout</button>" in result["formatted_state"]
    assert result["dom_tree"] == "[7]<button>Checkout</button>"


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
    assert msgs[1]["content"] == "Click submit"


def test_build_messages_legacy_includes_action_history_only():
    history = [
        {"step": 1, "thinking": "click submit", "action": "click", "index": 1, "result": {"success": True}},
    ]
    msgs = build_browser_use_messages(
        task="Click submit",
        browser_state=_browser_state(),
        action_history=history,
        available_actions=["click"],
        include_screenshot=False,
    )
    assert len(msgs) == 2
    assert "Previous Actions:" in msgs[1]["content"]
    assert "Current URL:" not in msgs[1]["content"]


def test_build_messages_browser_state_available_via_read_tool_not_auto_injected():
    msgs = build_browser_use_messages(
        task="Click submit",
        browser_state=_browser_state(timestamp="2026-05-27T22:39:24Z"),
        action_history=[],
        available_actions=["click"],
        include_screenshot=False,
    )
    assert "Timestamp:" not in msgs[1]["content"]
    assert "Interactive elements:" not in msgs[1]["content"]


def test_build_messages_multimodal_when_screenshot_present():
    msgs = build_browser_use_messages(
        task="t",
        browser_state=_browser_state(screenshot="AAAA"),
        action_history=[],
        available_actions=["click"],
        include_screenshot=True,
        turn_messages=[
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "screenshot", "arguments": "{}"},
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Screenshot captured by the screenshot tool."},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ],
            },
        ],
    )
    user_messages = [message for message in msgs if message["role"] == "user"]
    screenshot_message = user_messages[-1]
    assert isinstance(screenshot_message["content"], list)
    assert screenshot_message["content"][1]["image_url"]["url"] == "data:image/png;base64,AAAA"


def test_build_messages_screenshot_url_passthrough_when_http():
    msgs = build_browser_use_messages(
        task="t",
        browser_state=_browser_state(screenshot="https://cdn.example/shot.png"),
        action_history=[],
        available_actions=["click"],
        include_screenshot=True,
        turn_messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Screenshot captured by the screenshot tool."},
                    {"type": "image_url", "image_url": {"url": "https://cdn.example/shot.png"}},
                ],
            }
        ],
    )
    screenshot_message = [message for message in msgs if message["role"] == "user"][-1]
    img = screenshot_message["content"][1]
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
    assert "Current URL:" not in text


def test_build_messages_include_screenshot_false_drops_image():
    msgs = build_browser_use_messages(
        task="t",
        browser_state=_browser_state(screenshot="AAAA"),
        action_history=[],
        available_actions=["click"],
        include_screenshot=False,
    )
    assert isinstance(msgs[1]["content"], str)
    assert "AAAA" not in msgs[1]["content"]


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


def test_build_messages_turn_history_keeps_goal_first_without_auto_state():
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
    assert [m["role"] for m in msgs] == ["system", "user", "assistant", "tool"]
    assert "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" in msgs[0]["content"]
    assert "# User Context\nDelivery address" in msgs[0]["content"]
    assert msgs[1]["content"] == "# Current Goal\nBuy socks"
    assert "Previous Actions:" not in msgs[-1]["content"]
    assert "Current URL:" not in "".join(
        message["content"] if isinstance(message.get("content"), str) else "" for message in msgs
    )


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
    assert [message["role"] for message in msgs] == ["system", "user", "assistant", "tool"]
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


def test_read_network_requests_tool_advertised_and_normalized():
    """RCA follow-up (Failure 2 / Cloudflare): the browser agent gains a
    read_network_requests tool (1:1 with Claude Code) so it can detect a
    403/challenge by status code or find the underlying API instead of fighting
    an opaque DOM. Guards the multi-file wiring: catalog entry, tool-description
    generation, and passthrough of every filter/detail param.
    """
    assert "read_network_requests" in BROWSER_USE_TOOLS
    desc = BROWSER_USE_TOOLS["read_network_requests"]["description"]
    assert "read_network_requests" in desc or "network" in desc.lower()
    # params render without raising (schema dicts, not bare strings)
    for param in (
        "url_pattern",
        "method",
        "status",
        "resource_type",
        "limit",
        "clear",
        "include_query",
        "include_headers",
        "include_bodies",
        "max_body_chars",
    ):
        assert param in desc, f"{param} missing from read_network_requests description"
    # The description must tell the model bodies ARE available; agents that read
    # only a summary row conclude "this tool doesn't return response bodies".
    assert "include_bodies" in BROWSER_USE_TOOLS["read_network_requests"]["description"]

    flat = normalize_browser_use_response(
        {
            "thinking": "inspect network",
            "action": [
                {
                    "action_name": "read_network_requests",
                    "url_pattern": "/api/",
                    "method": "POST",
                    "status": "4xx",
                    "resource_type": "XHR",
                    "limit": 50,
                    "clear": True,
                    "include_query": True,
                    "include_headers": True,
                    "include_bodies": True,
                    "max_body_chars": 8000,
                }
            ],
        }
    )
    assert flat["action"] == "read_network_requests"
    assert flat["params"] == {
        "url_pattern": "/api/",
        "method": "POST",
        "status": "4xx",
        "resource_type": "XHR",
        "limit": 50,
        "clear": True,
        "include_query": True,
        "include_headers": True,
        "include_bodies": True,
        "max_body_chars": 8000,
    }

    nested = normalize_browser_use_response({"action": [{"read_network_requests": {"url_pattern": "checkout"}}]})
    assert nested["action"] == "read_network_requests"
    assert nested["params"] == {"url_pattern": "checkout"}


def test_read_logs_tool_advertised_and_normalized():
    """Browser agents use read_logs to inspect console + network traffic together."""
    assert "read_logs" in BROWSER_USE_TOOLS
    desc = generate_tool_descriptions(["read_logs"])
    assert "read_logs" in desc
    for param in (
        "pattern",
        "limit",
        "clear",
        "sources",
        "level",
        "status",
        "url_pattern",
        "include_bodies",
    ):
        assert param in desc, f"{param} missing from read_logs description"

    flat = normalize_browser_use_response(
        {
            "thinking": "inspect logs",
            "action": [
                {
                    "action_name": "read_logs",
                    "pattern": "429|ApolloError",
                    "limit": 25,
                    "sources": ["console", "network"],
                    "status": "error",
                    "clear": True,
                }
            ],
        }
    )
    assert flat["action"] == "read_logs"
    assert flat["params"]["pattern"] == "429|ApolloError"
    assert flat["params"]["limit"] == 25
    assert flat["params"]["sources"] == ["console", "network"]
    assert flat["params"]["status"] == "error"
    assert flat["params"]["clear"] is True


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


def test_normalize_provider_printable_key_batch_as_focused_input_text():
    calls = [{"name": "press_key", "arguments": json.dumps({"key": key})} for key in "bench"]

    out = normalize_browser_use_tool_calls(calls, thinking="type naturally")

    assert out == {
        "action": "input_text",
        "thinking": "type naturally",
        "index": None,
        "coordinates": None,
        "element_description": None,
        "params": {"text": "bench", "clear": False},
    }


def test_normalize_provider_mixed_tool_batch_keeps_first_action():
    out = normalize_browser_use_tool_calls(
        [
            {"name": "press_key", "arguments": '{"key": "b"}'},
            {"name": "click", "arguments": '{"index": 7}'},
        ]
    )

    assert out["action"] == "press_key"
    assert out["params"] == {"key": "b"}


def test_normalize_provider_printable_input_text_batch_as_one_input_text():
    calls = [
        {
            "name": "input_text",
            "arguments": json.dumps({"text": key, "clear": False, "index": 1445}),
        }
        for key in "bench"
    ]

    out = normalize_browser_use_tool_calls(calls, thinking="type naturally")

    assert out == {
        "action": "input_text",
        "thinking": "type naturally",
        "index": 1445,
        "coordinates": None,
        "element_description": None,
        "params": {"text": "bench", "clear": False},
    }


def test_normalize_provider_input_text_batch_mixed_indexes_keeps_first_action():
    out = normalize_browser_use_tool_calls(
        [
            {
                "name": "input_text",
                "arguments": json.dumps({"text": "b", "clear": False, "index": 1445}),
            },
            {
                "name": "input_text",
                "arguments": json.dumps({"text": "H", "clear": False, "index": 1446}),
            },
        ]
    )

    assert out["action"] == "input_text"
    assert out["params"]["text"] == "b"
    assert out["index"] == 1445


def test_normalize_provider_special_key_batch_keeps_first_action():
    out = normalize_browser_use_tool_calls(
        [
            {"name": "press_key", "arguments": '{"key": "Tab"}'},
            {"name": "press_key", "arguments": '{"key": "Enter"}'},
        ]
    )

    assert out["action"] == "press_key"
    assert out["params"] == {"key": "Tab"}


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


def test_normalize_provider_tool_call_uses_pydantic_coercion():
    out = normalize_browser_use_tool_call(
        {
            "id": "call_wait",
            "name": "wait",
            "arguments": '{"time_ms": "8000"}',
        }
    )

    assert out["action"] == "wait"
    assert out["params"]["time_ms"] == 8000
    assert isinstance(out["params"]["time_ms"], int)


def test_normalize_provider_tool_call_rejects_invalid_arguments():
    try:
        normalize_browser_use_tool_call(
            {
                "id": "call_wait",
                "name": "wait",
                "arguments": '{"time_ms": "later"}',
            }
        )
    except ValueError as error:
        assert "time_ms" in str(error)
    else:
        raise AssertionError("browser tool validation accepted a non-numeric wait")


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
    # Index by URL, not position: the mock handler is process-global, so a stray
    # request from another test's still-draining stream can land at index 0 and
    # turn this assertion into a KeyError flake.
    openrouter_bodies = [captured_bodies[index] for index, url in enumerate(captured) if "openrouter.ai" in url]
    assert openrouter_bodies
    body = openrouter_bodies[0]
    assert body["tool_choice"] == "auto"
    assert body["max_tokens"] == 2048
    assert body["temperature"] == 0.3
    assert body["tools"][0]["function"]["name"] == "click"
    assert body["tools"][0]["function"]["description"] == BROWSER_USE_TOOLS["click"]["description"]
    assert "# Available Actions" not in body["messages"][0]["content"]


async def test_complete_browser_use_recovers_a_step_cut_off_before_its_action():
    """A step whose thinking used the whole output limit is not re-asked unchanged.

    Repro of the hosted-auth bench timeouts: the reply ended finish=length with
    no action, and the step was retried with identical context up to 5 times.
    """
    cut_off = _openai_sse(
        [
            {"choices": [{"delta": {"content": "Let me reconsider. Wait, actually"}, "finish_reason": "length"}]},
            {"usage": {"prompt_tokens": 12, "completion_tokens": 6147, "total_tokens": 6159}},
        ]
    )
    acted = _openai_sse(
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
    seen: list[tuple[str, int]] = []

    def handler(req):
        if "openrouter.ai" not in str(req.url):
            return httpx.Response(500, text="unexpected route")
        body = json.loads(req.content.decode())
        seen.append((body["model"], body["max_tokens"]))
        text = acted if body["model"] == "google/gemini-3.8-flash" else cut_off
        return httpx.Response(200, text=text, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}):
        result = await RoseClient(openrouter_key="ork-x").complete_browser_use(
            task="click submit",
            browser_state=_browser_state(),
            action_history=[],
            available_actions=["click", "goto"],
            include_screenshot=False,
            call_site="test-bu-cut-off",
        )

    assert seen == [
        ("qwen/qwen3.8-27b", 2048),
        ("qwen/qwen3.8-27b", 16000),
        ("google/gemini-3.8-flash", 16000),
    ], seen
    assert result["action"]["action"] == "click" and result["action"]["index"] == 3, result["action"]
    assert "reconsider" not in json.dumps(result["action"]), "the abandoned attempts must not reach the action"
    assert result["actual_model"] == "google/gemini-3.8-flash", result["actual_model"]


async def test_complete_browser_use_preserves_printable_native_tool_batch():
    """A provider turn that types several characters must not discard calls 2..N."""
    tool_calls = [
        {
            "index": index,
            "id": f"call_key_{index}",
            "type": "function",
            "function": {"name": "press_key", "arguments": json.dumps({"key": key})},
        }
        for index, key in enumerate("bench")
    ]
    sse_body = _openai_sse(
        [
            {"choices": [{"delta": {"tool_calls": tool_calls}, "finish_reason": "tool_calls"}]},
            {"usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20}},
        ]
    )

    def handler(_req):
        return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}):
        result = await client.complete_browser_use(
            task="type bench into the focused field",
            browser_state=_browser_state(),
            action_history=[],
            available_actions=["input_text", "press_key"],
            include_screenshot=False,
            call_site="test-bu-printable-key-batch",
        )

    assert result["action"] == {
        "action": "input_text",
        "thinking": None,
        "index": None,
        "coordinates": None,
        "element_description": None,
        "params": {"text": "bench", "clear": False},
    }


async def test_complete_browser_use_cerebras_path_succeeds():
    """rose-fast browser-use skips Claude/GPT auth and hits Cerebras Qwen."""
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
        url = str(req.url)
        captured.append(url)
        if "api.cerebras.ai" in url:
            captured_bodies.append(json.loads(req.content.decode()))
            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        if "api.anthropic.com" in url:
            return httpx.Response(500, text="auth must be skipped")
        return httpx.Response(500, text="should not hit waterfall")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")

    with patch.dict(os.environ, {"CEREBRAS_API_KEY": "csk-test"}, clear=False):
        result = await client.complete_browser_use(
            task="click submit",
            browser_state=_browser_state(),
            action_history=[],
            available_actions=["click"],
            include_screenshot=False,
            claude_auth=claude_auth_from_token("good-token"),
            gpt_auth=gpt_auth_from_token("good-gpt-token", "acct_123"),
            call_site="test-bu-cerebras",
        )

    assert result["mode"] == "waterfall"
    assert result["actual_model"] == "qwen-3.8-27b"
    assert result["pool_name"] == "cerebras-direct"
    assert result["action"]["action"] == "click"
    assert result["claude_token_error"] is None
    assert result["gpt_token_error"] is None
    assert any("api.cerebras.ai" in u for u in captured)
    assert all("api.anthropic.com" not in u for u in captured)
    assert all("openrouter.ai" not in u for u in captured)
    assert captured_bodies
    body = captured_bodies[0]
    assert body["model"] == "qwen-3.8-27b"
    assert body["reasoning_effort"] == "high"
    assert body["tool_choice"] == "auto"
    assert body["tools"][0]["function"]["name"] == "click"
    assert body["tools"][0]["function"]["description"] == BROWSER_USE_TOOLS["click"]["description"]


async def test_complete_browser_use_dumps_cerebras_context():
    """Browser-use dumps the Cerebras hop, not a skipped GPT/Claude route."""
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

    def handler(req):
        url = str(req.url)
        captured.append(url)
        if "api.cerebras.ai" in url:
            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="should not hit waterfall")

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")
    dump_root = ROOT.parent / ".llm-dumps" / "unbound"
    for path in dump_root.glob("*test-bu-cerebras-dump.json"):
        path.unlink()

    with patch.dict(os.environ, {"CEREBRAS_API_KEY": "csk-test"}, clear=False):
        result = await client.complete_browser_use(
            task="click submit",
            browser_state=_browser_state(),
            action_history=[],
            available_actions=["click", "click_coordinates"],
            include_screenshot=False,
            gpt_auth=gpt_auth_from_token("good-gpt-token", "acct_123"),
            call_site="test-bu-cerebras-dump",
            dump_extra={
                "browser_recording_manifest_path": "/tmp/browser-recording/manifest.json",
                "iteration": 7,
            },
        )

    assert result["mode"] == "waterfall"
    assert result["actual_model"] == "qwen-3.8-27b"
    assert result["action"]["action"] == "click"
    assert result["gpt_token_error"] is None
    assert result["usage"]["total_tokens"] == 20
    assert any("api.cerebras.ai" in u for u in captured)
    assert all("chatgpt.com" not in u for u in captured)
    assert all("openrouter.ai" not in u for u in captured)

    dumps = sorted(dump_root.glob("*test-bu-cerebras-dump.json"))
    assert dumps, "complete_browser_use should dump exact LLM context"
    payload = json.loads(dumps[-1].read_text())
    assert payload["model"] == "qwen-3.8-27b"
    assert payload["message_count"] == 2
    assert [message["role"] for message in payload["messages"]] == ["system", "user"]
    assert payload["config"]["actual_model"] == "qwen-3.8-27b"
    assert payload["config"]["mode"] == "waterfall"
    assert payload["tools"][0]["name"] == "click"
    assert [tool["name"] for tool in payload["tools"]] == ["click", "click_coordinates"]
    assert payload["config"]["tool_choice"] == "auto"
    assert payload["extra"]["browser_recording_manifest_path"] == "/tmp/browser-recording/manifest.json"
    assert payload["extra"]["iteration"] == 7


async def _assert_failed_browser_context_capture(*, dump_unavailable=False, cancelled=False):
    """The actual browser method keeps its failure and captures its built inputs."""
    from helpers import observability
    from providers.rose.errors import RoseDeadlineError

    original = asyncio.CancelledError() if cancelled else RoseDeadlineError("offline stream deadline")
    client = RoseClient(openrouter_key="offline-fake")
    client.collect = AsyncMock(side_effect=original)
    agent_id = "11111111-1111-1111-1111-111111111111"
    root_id = "22222222-2222-2222-2222-222222222222"
    request_id = None if dump_unavailable else "offline-browser-request"
    call_site = "test-bu-failure-capture"
    browser_state = _browser_state()
    history = [{"step": 1, "action": "screenshot", "result": {"success": True}}]
    actual_dump = observability.dump_llm_context
    with tempfile.TemporaryDirectory() as directory:
        with (
            patch.object(observability, "_DUMP_ROOT", Path(directory)),
            patch.object(observability, "_IS_PRODUCTION", False),
            patch.object(observability, "archive_json", return_value=None),
            patch.object(observability, "current_span_id", return_value="offline-browser-span"),
            patch.object(observability, "current_root_agent_id", return_value=root_id),
            patch.object(
                observability,
                "dump_llm_context",
                **(
                    {"side_effect": OSError("offline dump unavailable")} if dump_unavailable else {"wraps": actual_dump}
                ),
            ) as dumped,
        ):
            try:
                await client.complete_browser_use(
                    task="offline capture fixture",
                    browser_state=browser_state,
                    action_history=history,
                    available_actions=["click", "goto"],
                    include_screenshot=False,
                    agent_id=agent_id,
                    request_id=request_id,
                    call_site=call_site,
                    skip_cache_write=True,
                    cache_namespace="offline-browser-sequence",
                    dump_extra={"iteration": 8},
                )
            except BaseException as observed:
                assert observed is original, "capture must preserve the original exception object"
            else:
                raise AssertionError("the original browser failure was swallowed")
            assert client.collect.await_count == 1
            if cancelled:
                assert dumped.call_count == 0, "cancellation must not start capture work"
                return
            assert dumped.call_count == 1, "the failed browser request has no input capture"
            args = client.collect.await_args.kwargs
            assert args["dump_context"] is False, "successful requests retain their existing single dump"
            assert args["request_id"] and (request_id is None or args["request_id"] == request_id)
            if dump_unavailable:
                assert not list(Path(directory).rglob("*.json"))
                return
            files = list(Path(directory).rglob("*.json"))
            assert len(files) == 1
            payload = json.loads(files[0].read_text())
            assert payload["messages"] == args["messages"] and payload["tools"] == args["tools"]
            assert payload["agent_id"] == agent_id and payload["root_agent_id"] == root_id
            assert payload["span_id"] == "offline-browser-span" and payload["call_site"] == call_site
            assert payload["model"] == "rose-1-browser-use"
            config = payload["config"]
            assert config["actual_model"] is None and config["mode"] is None
            params = config["requested_params"]
            assert params["max_tokens"] == args["max_tokens"] == 2048
            assert params["temperature"] == args["temperature"] == 0.3
            assert params["tool_choice"] == args["tool_choice"] == "auto"
            assert params["deadline_s"] == args["deadline_s"] == 590.0
            assert params["ttft_timeout_s"] == 90.0 and params["idle_timeout_s"] == 120.0
            assert params["cache_namespace"] == args["cache_namespace"] == "offline-browser-sequence"
            assert params["skip_cache_write"] is args["skip_cache_write"] is True
            assert params["reasoning_effort"] is None and params["thinking"] is None
            assert params["seed"] is None and params["response_format"] is None
            assert (
                config["pool_waterfall_reasoning_effort"] == get_pool("rose-1-browser-use").waterfall_reasoning_effort
            )
            assert payload["output"] == {
                "request_id": args["request_id"],
                "error": {"type": "RoseDeadlineError", "message": "offline stream deadline"},
            }
            assert payload["extra"]["browser_state"] == browser_state
            assert payload["extra"]["action_history"] == history and payload["extra"]["iteration"] == 8


async def test_complete_browser_use_failure_captures_exact_context():
    await _assert_failed_browser_context_capture()


async def test_complete_browser_use_capture_failure_preserves_original_error():
    await _assert_failed_browser_context_capture(dump_unavailable=True)


async def test_complete_browser_use_cancellation_skips_failure_capture():
    await _assert_failed_browser_context_capture(cancelled=True)


async def test_complete_browser_use_bypasses_demo_cache_context():
    """Browser-use LLM calls must not read or write provider demo-cache."""
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

    def handler(req):
        url = str(req.url)
        captured.append(url)
        if "fast-cache" in url:
            return httpx.Response(500, text="browser-use should bypass demo-cache")
        if "api.cerebras.ai" in url:
            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(500, text="unexpected endpoint")

    set_mock_handler(handler)
    token = set_context(DemoCacheContext(enabled=True, goal="click submit", write_enabled=True))
    try:
        client = RoseClient(openrouter_key="ork-x")
        with patch.dict(os.environ, {"CEREBRAS_API_KEY": "csk-test"}, clear=False):
            result = await client.complete_browser_use(
                task="click submit",
                browser_state=_browser_state(),
                action_history=[],
                available_actions=["click", "click_coordinates"],
                include_screenshot=False,
                gpt_auth=gpt_auth_from_token("good-gpt-token", "acct_123"),
                agent_id="agent-demo-cache-bypass",
                call_site="browser_use_step_1",
            )
    finally:
        reset_context(token)

    assert result["action"]["action"] == "click"
    assert not any("fast-cache" in url for url in captured)
    assert any("api.cerebras.ai" in url for url in captured)


async def test_complete_browser_use_cerebras_failure_preserves_tools_on_openrouter():
    """Cerebras failure -> OpenRouter still receives browser action tools."""
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
    openrouter_bodies: list[dict] = []

    def handler(req):
        url = str(req.url)
        captured.append(url)
        if "api.cerebras.ai" in url:
            return httpx.Response(503, text="cerebras down")
        if "openrouter.ai" in url:
            openrouter_bodies.append(json.loads(req.content.decode()))
            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        if "api.anthropic.com" in url or "chatgpt.com" in url:
            return httpx.Response(500, text="auth must be skipped")
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")

    with patch.dict(
        os.environ,
        {"CEREBRAS_API_KEY": "csk-test", "ANTHROPIC_API_KEY": "sk-ant-test", "GPT_API_KEY": "sk-proj-test"},
        clear=False,
    ):
        result = await client.complete_browser_use(
            task="click submit",
            browser_state=_browser_state(),
            action_history=[],
            available_actions=["click", "goto"],
            include_screenshot=False,
            gpt_auth=gpt_auth_from_token("rate-limited-gpt-token", "acct_123"),
            call_site="test-bu-cerebras-fallthrough-tools",
        )

    assert result["mode"] == "waterfall"
    assert result["actual_model"] == "qwen/qwen3.8-27b"
    assert result["action"]["action"] == "click"
    assert result["action"]["index"] == 3
    assert any("api.cerebras.ai" in u for u in captured)
    assert any("openrouter.ai" in u for u in captured)
    assert all("api.anthropic.com" not in u for u in captured)
    assert all("chatgpt.com" not in u for u in captured)
    assert openrouter_bodies
    body = openrouter_bodies[0]
    assert body["model"] == "qwen/qwen3.8-27b"
    assert body["tool_choice"] == "auto"
    assert [tool["function"]["name"] for tool in body["tools"]] == ["click", "goto"]
    assert body["tools"][0]["function"]["description"] == BROWSER_USE_TOOLS["click"]["description"]


async def test_complete_browser_use_auth_tokens_are_ignored():
    """Claude/GPT tokens on rose-fast browser-use never open those providers."""
    sse_body = _openai_sse(
        [
            {"choices": [{"delta": {"content": _ACTION_TEXT}, "finish_reason": "stop"}]},
            {"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
        ]
    )
    captured: list[str] = []

    def handler(req):
        url = str(req.url)
        captured.append(url)
        if "api.anthropic.com" in url or "chatgpt.com" in url:
            return httpx.Response(401, json={"error": {"message": "expired"}})
        if "openrouter.ai" in url:
            return httpx.Response(200, text=sse_body, headers={"Content-Type": "text/event-stream"})
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(handler)
    client = RoseClient(openrouter_key="ork-x")

    result = await client.complete_browser_use(
        task="click submit",
        browser_state=_browser_state(),
        action_history=[],
        available_actions=["click"],
        include_screenshot=False,
        claude_auth=claude_auth_from_token("expired-token"),
        gpt_auth=gpt_auth_from_token("expired-gpt", "acct"),
        call_site="test-bu-auth-ignored",
    )

    assert result["mode"] == "waterfall"
    assert result["claude_token_error"] is None
    assert result["gpt_token_error"] is None
    assert result["action"]["action"] == "click"
    assert any("openrouter.ai" in u for u in captured)
    assert all("api.anthropic.com" not in u for u in captured)
    assert all("chatgpt.com" not in u for u in captured)


async def test_complete_browser_use_runs_on_spawning_agents_pool():
    """An ultra root's browser step uses ultra's Claude auth (Opus) with the
    screenshot, and still bypasses Fast Cache on a non-browser call site."""
    captured: list[str] = []
    anthropic_bodies: list[dict] = []

    def handler(req):
        url = str(req.url)
        captured.append(url)
        if "fast-cache" in url:
            return httpx.Response(500, text="browser-use should bypass demo-cache")
        if "api.anthropic.com" in url:
            anthropic_bodies.append(json.loads(req.content.decode()))
            return httpx.Response(
                200, text=_anthropic_tool_sse("click", '{"index": 3}'), headers={"Content-Type": "text/event-stream"}
            )
        return httpx.Response(500, text="ultra must not reach Cerebras or OpenRouter")

    set_mock_handler(handler)
    dump_root = ROOT.parent / ".llm-dumps" / "unbound"
    for path in dump_root.glob("*write_lock_notification_fork_3.json"):
        path.unlink()
    token = set_context(DemoCacheContext(enabled=True, goal="click submit", write_enabled=True))
    try:
        with patch.dict(os.environ, {"CEREBRAS_API_KEY": "csk-test", "GPT_API_KEY": ""}, clear=False):
            result = await RoseClient(openrouter_key="ork-x").complete_browser_use(
                task="click submit",
                browser_state=_browser_state(),
                action_history=[],
                available_actions=["click"],
                include_screenshot=True,
                turn_messages=[
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {"id": "call_1", "type": "function", "function": {"name": "screenshot", "arguments": "{}"}}
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Screenshot captured by the screenshot tool."},
                            {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}},
                        ],
                    },
                ],
                claude_auth=claude_auth_from_token("good-token"),
                call_site="write_lock_notification_fork_3",
                pool="rose-1-ultra",
            )
    finally:
        reset_context(token)

    assert result["mode"] == "claude"
    assert result["actual_model"] == "claude-opus-5-5-claude"
    assert result["action"]["action"] == "click"
    assert [u for u in captured if "api.anthropic.com" not in u] == []
    body = anthropic_bodies[0]
    assert body["model"] == "claude-opus-5-5"
    images = [
        block
        for message in body["messages"]
        if isinstance(message["content"], list)
        for block in message["content"]
        if block.get("type") == "image"
    ]
    assert images, "the screenshot reaches the inherited pool's model"
    payload = json.loads(sorted(dump_root.glob("*write_lock_notification_fork_3.json"))[-1].read_text())
    assert payload["config"]["pool"] == "rose-1-ultra"
    assert payload["config"]["candidate_models"]["claude_auth"] == "claude-opus-5-5"


# =====================================================================
# Test runner
# =====================================================================



async def test_completed_browser_output_validation_is_not_transport_or_completion():
    from providers.rose.errors import BrowserModelOutputValidationError, RoseStallError
    from providers.rose.types import RoseResponse
    from browser_tools.schemas import BrowserToolArgsValidationError
    from helpers.workflow_generation import WorkflowGenerationSealed
    from helpers import observability
    client = RoseClient(openrouter_key="offline-fake")
    kwargs = dict(task="Read the visible heading", browser_state=_browser_state(), action_history=[], available_actions=["wait", "request_user_assistance_for_authentication"])
    outputs = []
    with patch.object(observability, "dump_llm_context", side_effect=lambda **kw: outputs.append(kw)):
        for content in ("The page is finished.", '{"action": []}'):
            response = RoseResponse(content=content, actual_model="offline-model", request_id="actual-response", usage={"prompt_tokens": 7, "completion_tokens": 3})
            client.collect = AsyncMock(return_value=response)
            try:
                await client.complete_browser_use(**kwargs)
                raise AssertionError("invalid output must not be accepted as completion")
            except BrowserModelOutputValidationError as error:
                assert error.response is response and error.response.usage == response.usage
            assert outputs[-1]["output"]["content"] == content
            assert outputs[-1]["output"]["request_id"] == "actual-response"
            assert outputs[-1]["config"]["tool_choice"] == "auto"
        with patch.object(observability, "dump_llm_context", side_effect=OSError("offline capture failure")):
            response = RoseResponse(content="Invalid completed answer", request_id="actual-failed-capture")
            client.collect = AsyncMock(return_value=response)
            try:
                await client.complete_browser_use(**kwargs)
                raise AssertionError("capture failure must not accept invalid output")
            except BrowserModelOutputValidationError as error:
                assert error.response is response
        for original in (RoseStallError("empty stream"), ValueError("unrelated transport wrapper"), asyncio.CancelledError(), WorkflowGenerationSealed("sealed")):
            client.collect = AsyncMock(side_effect=original)
            try:
                await client.complete_browser_use(**kwargs)
                raise AssertionError("expected original transport/control error")
            except BaseException as error:
                assert error is original and not isinstance(error, BrowserModelOutputValidationError)
        typed = RoseResponse(tool_calls=[{"id": "real-tool", "name": "wait", "arguments": '{"time_ms": "not-a-number"}'}])
        client.collect = AsyncMock(return_value=typed)
        try:
            await client.complete_browser_use(**kwargs)
            raise AssertionError("invalid typed arguments must retain existing error")
        except BrowserToolArgsValidationError:
            pass
        for response in (RoseResponse(content='{"action": [{"wait": {"time_ms": 1}}]}'), RoseResponse(tool_calls=[{"id": "real-wait", "name": "wait", "arguments": '{"time_ms": 1}'}])):
            client.collect = AsyncMock(return_value=response)
            result = await client.complete_browser_use(**kwargs)
            assert result["action"]["action"] == "wait"


async def run_all_tests():
    print("rose_browser_use blackbox tests:")
    r = BlackboxResult()
    await r.record_async("declared tool admission preserves aliases and batches", test_declared_tool_admission_keeps_aliases_and_batch_semantics)
    await r.record_async("advertised coordinate-only action remains admissible", test_advertised_coordinate_only_action_is_admitted)
    await r.record_async("completed_browser_output_validation_is_not_transport_or_completion", test_completed_browser_output_validation_is_not_transport_or_completion)

    r.record("browser_use_pool_registered", test_browser_use_pool_registered)

    r.record("tool_descriptions_filters_and_params", test_generate_tool_descriptions_filters_and_includes_params)
    r.record("tool_descriptions_no_param_for_navback", test_generate_tool_descriptions_no_params_for_navback)
    r.record("tool_catalog_completeness", test_browser_use_tool_catalog_completeness)
    r.record("system_prompt_uses_native_tools", test_build_browser_use_system_prompt_uses_native_tools_not_action_list)
    r.record("system_prompt_hides_extract", test_build_browser_use_system_prompt_does_not_advertise_extract)
    r.record("state_has_indexed_dom_targets", test_state_has_indexed_dom_targets_detects_interactive_indices)
    r.record(
        "filter_actions_keeps_coordinates_when_indexed",
        test_filter_browser_use_actions_keeps_coordinates_when_dom_has_indices,
    )
    r.record(
        "filter_actions_keeps_coordinates_when_unindexed",
        test_filter_browser_use_actions_keeps_coordinates_for_unindexed_state,
    )
    r.record(
        "filter_keeps_click_coordinates_on_bot_or_not_captcha_shell",
        test_filter_keeps_click_coordinates_on_bot_or_not_captcha_shell,
    )
    r.record(
        "screenshot_tool_desc_misleading_captcha_dom",
        test_screenshot_tool_desc_calls_out_misleading_captcha_dom,
    )
    r.record("drag_tool_catalog_and_normalize", test_drag_tool_in_catalog_and_normalizes_coordinates)
    r.record("drag_tool_schema_requires_endpoints", test_drag_tool_schema_requires_start_and_end)
    r.record("native_tool_schemas_preserve_catalog", test_build_browser_use_tools_preserves_catalog_descriptions)
    r.record("native_tool_schemas_valid_required_keywords", test_build_browser_use_tools_emits_valid_required_keywords)
    r.record(
        "native_tool_schemas_follow_pydantic",
        test_provider_tool_schemas_follow_browser_pydantic_models,
    )
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
        "write_lock_notification_accepts_current_session_link",
        test_write_lock_purchase_schema_accepts_current_page_as_product_link,
    )
    r.record(
        "write_lock_notification_rejects_unobserved_product_host",
        test_write_lock_purchase_schema_rejects_product_host_not_observed_by_browser,
    )

    r.record("format_browser_state_for_tool", test_format_browser_state_for_tool_matches_legacy_injection_text)
    r.record("messages_text_only_no_screenshot", test_build_messages_text_only_when_no_screenshot)
    r.record("messages_legacy_action_history", test_build_messages_legacy_includes_action_history_only)
    r.record("messages_no_auto_state", test_build_messages_browser_state_available_via_read_tool_not_auto_injected)
    r.record("messages_multimodal_with_screenshot", test_build_messages_multimodal_when_screenshot_present)
    r.record("messages_http_screenshot_passthrough", test_build_messages_screenshot_url_passthrough_when_http)
    r.record("messages_action_history_formatting", test_build_messages_action_history_formatting)
    r.record("messages_include_screenshot_false", test_build_messages_include_screenshot_false_drops_image)
    r.record("messages_extra_user_messages", test_build_messages_appends_extra_user_messages)
    r.record("messages_turn_history", test_build_messages_turn_history_keeps_goal_first_without_auto_state)
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
    r.record(
        "normalize_provider_printable_key_batch",
        test_normalize_provider_printable_key_batch_as_focused_input_text,
    )
    r.record(
        "normalize_provider_mixed_tool_batch",
        test_normalize_provider_mixed_tool_batch_keeps_first_action,
    )
    r.record(
        "normalize_provider_special_key_batch",
        test_normalize_provider_special_key_batch_keeps_first_action,
    )
    r.record(
        "normalize_provider_printable_input_text_batch",
        test_normalize_provider_printable_input_text_batch_as_one_input_text,
    )
    r.record(
        "normalize_provider_input_text_batch_mixed_indexes",
        test_normalize_provider_input_text_batch_mixed_indexes_keeps_first_action,
    )
    r.record("normalize_request_auth_assistance", test_normalize_request_user_assistance)
    await r.record_async("native_autofill_actual_enabled_request", test_native_autofill_preference_reaches_actual_enabled_request)
    r.record("native_autofill_fixture_current_dto", test_native_autofill_control_fixture_matches_current_backend_dto)
    await r.record_async("native_autofill_fixture_real_history", test_native_autofill_control_history_matches_real_serializer)
    await r.record_async("native_autofill_control_production_transcript", test_native_autofill_control_transcript_matches_production_shape)
    await r.record_async("native_autofill_control_attempt_turns", test_native_autofill_control_scenarios_record_saved_credential_attempts_as_turns)
    await r.record_async("native_autofill_real_model_controls", test_native_autofill_real_model_synthetic_controls)
    r.record("phone_off_matches_prephone_bytes", test_phone_off_matches_prephone_bytes)
    await r.record_async("phone_off_actual_rose_request", test_phone_off_actual_rose_request)
    r.record("phone_setup_verification_targets_schema", test_phone_setup_verification_targets_schema_and_isolation)
    await r.record_async("phone_setup_settings_actual_handler", test_phone_setup_settings_actual_handler_observation)
    r.record("phone_setup_schema_and_forged_context", test_phone_setup_schema_and_forged_context)
    await r.record_async("phone_setup_actual_provider_observation", test_phone_setup_actual_provider_observation)
    r.record("native_auth_typed_schema_and_normalization", test_native_auth_typed_schema_and_normalization)
    r.record("native_auth_schema_account_isolation", test_native_auth_schema_account_isolation)
    await r.record_async("native_auth_real_provider_tool_request", test_native_auth_real_provider_tool_request)
    r.record("normalize_provider_tool_call", test_normalize_provider_tool_call)
    r.record(
        "normalize_provider_tool_call_coercion",
        test_normalize_provider_tool_call_uses_pydantic_coercion,
    )
    r.record(
        "normalize_provider_tool_call_invalid_args",
        test_normalize_provider_tool_call_rejects_invalid_arguments,
    )
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
    r.record("advertised_tools_are_normalizable", test_every_advertised_tool_is_normalizable)
    r.record(
        "recover_from_challenge_preserves_reason",
        test_recover_from_challenge_normalizes_and_preserves_reason,
    )
    r.record(
        "recover_from_challenge_auth_cookies_are_preserved_flag",
        test_recover_from_challenge_normalizes_auth_cookies_are_preserved_flag,
    )
    r.record(
        "recover_from_challenge_stages",
        test_recovery_prompt_describes_solver_cookie_and_parallel_config_stages,
    )

    r.record("params_seconds_to_time_ms", test_params_seconds_to_time_ms)
    r.record("params_down_true_direction", test_params_down_true_to_direction_and_amount)
    r.record("params_down_false_direction", test_params_down_false_to_direction_up)
    r.record("params_typing_text_alias", test_params_typing_text_yutori_alias)
    r.record("params_input_clear_false", test_params_input_text_preserves_clear_false)
    r.record("params_query_to_instruction", test_params_query_to_instruction)
    r.record("params_select_dropdown_text_value", test_params_select_dropdown_text_to_value)
    r.record(
        "read_network_requests_advertised_and_normalized",
        test_read_network_requests_tool_advertised_and_normalized,
    )
    r.record(
        "read_logs_advertised_and_normalized",
        test_read_logs_tool_advertised_and_normalized,
    )

    await r.record_async("complete_browser_use_waterfall_only", test_complete_browser_use_waterfall_only_path)
    await r.record_async(
        "complete_browser_use_recovers_cut_off_step",
        test_complete_browser_use_recovers_a_step_cut_off_before_its_action,
    )
    await r.record_async(
        "complete_browser_use_printable_native_tool_batch",
        test_complete_browser_use_preserves_printable_native_tool_batch,
    )
    await r.record_async("complete_browser_use_cerebras_path", test_complete_browser_use_cerebras_path_succeeds)
    await r.record_async(
        "complete_browser_use_dumps_cerebras_context", test_complete_browser_use_dumps_cerebras_context
    )
    await r.record_async(
        "complete_browser_use_failure_context", test_complete_browser_use_failure_captures_exact_context
    )
    await r.record_async(
        "complete_browser_use_capture_failure_original_error",
        test_complete_browser_use_capture_failure_preserves_original_error,
    )
    await r.record_async(
        "complete_browser_use_cancellation_no_capture", test_complete_browser_use_cancellation_skips_failure_capture
    )
    await r.record_async(
        "complete_browser_use_bypasses_demo_cache", test_complete_browser_use_bypasses_demo_cache_context
    )
    await r.record_async(
        "complete_browser_use_cerebras_failure_preserves_tools",
        test_complete_browser_use_cerebras_failure_preserves_tools_on_openrouter,
    )
    await r.record_async("complete_browser_use_auth_tokens_ignored", test_complete_browser_use_auth_tokens_are_ignored)
    await r.record_async(
        "complete_browser_use_runs_on_spawning_agents_pool", test_complete_browser_use_runs_on_spawning_agents_pool
    )

    await r.record_async("execute_read_browser_state", test_execute_read_browser_state_returns_formatted_snapshot)

    teardown_mock()
    r.record(
        "build_browser_use_system_prompt_auth_priority_is_numbered",
        test_build_browser_use_system_prompt_auth_priority_is_numbered,
    )
    r.record(
        "auth_assistance_requires_sign_in_form_open",
        test_auth_assistance_requires_sign_in_form_open_with_and_without_challenge_recovery,
    )
    r.record(
        "build_browser_use_system_prompt_reuses_main_grading_prompt",
        test_build_browser_use_system_prompt_reuses_main_grading_prompt,
    )
    r.record(
        "build_browser_use_system_prompt_requires_ordered_option_set_capture",
        test_build_browser_use_system_prompt_requires_ordered_option_set_capture,
    )
    r.record(
        "browser_attempt_completion_uses_canonical_prompt_and_empty_schema",
        test_browser_attempt_completion_uses_canonical_prompt_and_empty_schema,
    )
    r.record("normalize_request_payment_card_preserves_receipt", test_normalize_request_payment_card_preserves_receipt)
    r.record(
        "normalize_request_payment_card_parses_tool_string_arguments",
        test_normalize_request_payment_card_parses_tool_string_arguments,
    )
    r.record("phone_schema_and_per_invocation_capability_gate", test_phone_schema_and_per_invocation_capability_gate)
    r.record("phone_profile_guidance_is_conditional", test_phone_profile_guidance_is_conditional)
    r.record("phone_native_call_normalizes_and_observation_is_visible", test_phone_native_call_normalizes_and_observation_is_visible)
    return r.summary()





def test_phone_schema_and_per_invocation_capability_gate():
    from browser_tools.schemas import AVAILABLE_ACTIONS, validate_browser_tool_args, BrowserToolArgsValidationError
    from domains.spawn_browser_agent_v3.phone import phone_actions
    original = list(AVAILABLE_ACTIONS)
    assert 'phone' in phone_actions(original, {'enabled': True})
    assert 'phone' not in phone_actions(original, {'enabled': False})
    assert AVAILABLE_ACTIONS == original
    assert validate_browser_tool_args('phone', {'mode': 'status'}) == {'mode': 'status', 'args': {}}
    for key in ('user_id', 'agentId', 'browserTaskId', 'leaseId', 'cursor', 'operationId'):
        try:
            validate_browser_tool_args('phone', {'mode': 'status', key: 'forged'})
        except BrowserToolArgsValidationError:
            pass
        else:
            raise AssertionError(f'accepted routing field {key}')
    assert any(t['name'] == 'phone' for t in build_browser_use_tools(['phone']))


def test_phone_profile_guidance_is_conditional():
    from helpers.user_profile import build_user_profile_sections
    assert 'cloud iPhone' not in '\n'.join(build_user_profile_sections({}))
    assert 'cloud iPhone' in '\n'.join(build_user_profile_sections({'iphoneCapability': {'enabled': True}}))





def test_phone_native_call_normalizes_and_observation_is_visible():
    normalized = normalize_browser_use_tool_call({'id':'streamed','name':'phone','arguments':{'mode':'status'}})
    assert normalized['action'] == 'phone'
    assert normalized['params']['mode'] == 'status'
    state={'enabled':True,'interaction':{'cursor':4,'pendingOperation':{'status':'UNKNOWN','id':'input-old'},'lastOperation':{'status':'SUCCEEDED','id':'read-new'}}}
    messages=build_browser_use_messages(task='task',browser_state={'phone':state},action_history=[],available_actions=['phone'],turn_messages=[])
    content=json.dumps(messages)
    assert 'observed_phone_state' in content and 'input-old' in content and 'read-new' in content
    hidden=build_browser_use_messages(task='task',browser_state={'phone':state},action_history=[],available_actions=['wait'],turn_messages=[])
    assert 'observed_phone_state' not in json.dumps(hidden)



def test_native_auth_typed_schema_and_normalization():
    from browser_tools.schemas import validate_browser_tool_args
    name = "request_user_assistance_for_authentication"
    for reason in ("password", "verification_code", "device_passcode", "manual_verification"):
        args = {"targetKind": "iphone", "criticalReason": reason}
        for action in ({name: args}, {"action_name": name, **args}):
            assert normalize_browser_use_response({"action": [action]})["params"] == args
        assert normalize_browser_use_tool_call({"name": name, "arguments": json.dumps(args)})["params"] == args
    assert normalize_browser_use_response({"action": [{name: {}}]})["params"] == {}
    for args in ({"targetKind":"iphone"}, {"targetKind":"android","criticalReason":"password"},
                 {"targetKind":"iphone","criticalReason":"queue"},
                 {"targetKind":"iphone","criticalReason":"password","leaseId":"forged"},
                 {"targetKind":"iphone","criticalReason":"password","password":"CANARY"},
                 {"targetKind":"browser","criticalReason":"password"}):
        try:
            validate_browser_tool_args(name,args)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid or forged native assistance accepted")


def test_native_auth_schema_account_isolation():
    name = "request_user_assistance_for_authentication"
    before = json.dumps(BROWSER_USE_TOOLS, sort_keys=True)
    enabled = next(t for t in build_browser_use_tools([name,"phone"]) if t["name"]==name)
    assert enabled["input_schema"]["properties"]["targetKind"]["enum"] == ["browser","iphone"]
    assert "criticalReason" in enabled["input_schema"]["properties"]
    assert "targetKind=iphone" in enabled["description"]
    disabled = build_browser_use_tools([name])[0]
    assert "targetKind" not in disabled["input_schema"]["properties"]
    assert "criticalReason" not in disabled["input_schema"]["properties"]
    assert json.dumps(BROWSER_USE_TOOLS, sort_keys=True) == before


async def test_native_auth_real_provider_tool_request():
    name = "request_user_assistance_for_authentication"
    params = {"targetKind": "iphone", "criticalReason": "verification_code"}
    sse = _openai_sse([{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "native-decision-1", "type": "function", "function": {"name": name, "arguments": json.dumps(params)}}]}, "finish_reason": "tool_calls"}]}])
    captured = []
    def provider(request):
        assert request.url.host == "openrouter.ai", "Synthetic replay must stay on the expected mocked provider path"
        captured.append(json.loads(request.content))
        return httpx.Response(200, text=sse, headers={"Content-Type": "text/event-stream"})
    set_mock_handler(provider)
    try:
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "CEREBRAS_API_KEY": ""}):
            result = await RoseClient(openrouter_key="synthetic-native-key").complete_browser_use(
                task="Inspect the cloud phone verification screen",
                browser_state={**_browser_state(), "phone": {"enabled": True, "interaction": {"cursor": 7}}},
                action_history=[], available_actions=[name, "phone"], include_screenshot=False,
                call_site="test-native-phone-auth",
            )
        assert result["action"]["params"] == params
        assert result["action"]["action"] == name
        assert len(captured) == 1
        advertised = next(t["function"] for t in captured[0]["tools"] if t["function"]["name"] == name)
        assert advertised["parameters"]["properties"]["targetKind"]["enum"] == ["browser", "iphone"]
        assert "targetKind=iphone" in advertised["description"]
        assert "This authentication ladder applies to targetKind=browser" in json.dumps(captured[0]["messages"])
    finally:
        teardown_mock()


def test_phone_setup_schema_and_forged_context():
    import pytest
    from browser_tools.schemas import validate_browser_tool_args
    for action, extra in (("defer", {"reasonCode": "user_constraint"}), ("block", {"reasonCode": "unsupported"}), ("verify", {"evidenceOperationIds": ["observation-1"]})):
        params = {"mode": "setup", "action": action, **extra}
        normalized = normalize_browser_use_tool_call({"name": "phone", "arguments": json.dumps(params)})["params"]
        assert all(normalized[key] == value for key, value in params.items())
    for forged in ("attemptId", "expectedRevision", "setupAttemptId", "setupRevision", "expectedCursor", "requestKey", "userId", "leaseId", "expectedAccountIdentifier", "password", "ready", "verdict"):
        with pytest.raises(ValueError):
            validate_browser_tool_args("phone", {"mode": "setup", "action": "defer", "reasonCode": "user_constraint", forged: "CANARY"})
    for params in ({"mode": "setup"}, {"mode": "setup", "action": "ready"},
                   {"mode": "setup", "action": "verify", "args": {"ready": True}},
                   {"mode": "setup", "action": "verify", "operation": "input.text"},
                   {"mode": "operation", "operation": "screen.text", "action": "defer"},
                   {"mode": "status", "evidenceOperationIds": ["other"]}):
        with pytest.raises(ValueError):
            validate_browser_tool_args("phone", params)
    before = json.dumps(BROWSER_USE_TOOLS, sort_keys=True)
    assert "setup" in next(t for t in build_browser_use_tools(["phone"]) if t["name"] == "phone")["input_schema"]["properties"]["mode"]["enum"]
    assert not any(t["name"] == "phone" for t in build_browser_use_tools(["wait"]))
    assert before == json.dumps(BROWSER_USE_TOOLS, sort_keys=True)


async def test_phone_setup_actual_provider_observation():
    params = {"mode": "setup", "action": "defer", "reasonCode": "user_constraint"}
    setup = {"attemptId": "attempt-owned", "revision": 3, "state": "in_progress", "expectedAccountIdentifier": "synthetic-account@example.test"}
    state = {"enabled": True, "interaction": {"cursor": 7, "setup": setup}}
    sse = _openai_sse([{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "setup-decision", "type": "function", "function": {"name": "phone", "arguments": json.dumps(params)}}]}, "finish_reason": "tool_calls"}]}])
    captured = []
    def provider(request):
        assert request.url.host == "openrouter.ai"
        captured.append(json.loads(request.content))
        return httpx.Response(200, text=sse, headers={"Content-Type": "text/event-stream"})
    set_mock_handler(provider)
    try:
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "CEREBRAS_API_KEY": ""}):
            result = await RoseClient(openrouter_key="synthetic").complete_browser_use(task="Inspect only; do not sign in", browser_state={**_browser_state(), "phone": state}, action_history=[], available_actions=["phone"], include_screenshot=False, call_site="test-phone-setup")
        assert result["action"]["params"]["action"] == "defer"
        observed = [m for m in captured[0]["messages"] if "<observed_phone_state>" in str(m.get("content"))]
        assert len(observed) == 1 and json.dumps(setup) in observed[0]["content"]
        assert "Inspect only; do not sign in" in json.dumps(captured[0]["messages"])
    finally:
        teardown_mock()


def test_phone_off_matches_prephone_bytes():
    """Phone-off tools/system/messages must equal the pre-Phone prompt, byte for byte.

    Golden SHA256s were captured from canonical c28f801be before the Phone proposal.
    Re-pinned at 042d82196 for exactly one deliberate, mode-independent change:
    a05e1beb7 (Q3b, approved) added the shared browser_auth_contract line "Sign in or
    sign up only with identities listed in Auth Options. ..." to both modes. The tools
    hashes are unchanged; no Phone text entered the phone-off prompt. Re-pin only for
    reviewed text that also reaches phone-on mode, and record the commit here.
    Re-pinned for the approved read_tool_output browser action (Polar item 16, approved
    by Andy 2026-10-26): only the tools hash changed in both modes, and excluding that
    one action reproduces the previous tools hash exactly; system/messages are unchanged.
    """
    import hashlib
    from browser_tools.schemas import AVAILABLE_ACTIONS
    expected = {'0': ('2c9fdf3a97705cd018c06dce4c08d4981d0524889a46cfb03b5286bbf9c84515', 'e8d1ee04f73c9a08380b8e4573109ffc9ce1bf757b2120fc556ee975657bbf89', '4c0d0eb65703bdae2065193f937bf2035e919102dc5e4652916cf771a0f5527c'), '1': ('2de1338897c8e1a3749b7f5fa9a3b0a03015d50aaf779f5cd67f3a697710afa9', '5661e2684efeaf877a48c64a6f240cd0889e30517342fb0a4de5baa9823d12fa', '1dc1c6088a8ab2bb8539271e93ce1f43af4ac7ed543ce1fb624b2b4a01d3d44a')}
    actions = [a for a in AVAILABLE_ACTIONS if a != "phone"]
    for flag, hashes in expected.items():
        with patch.dict(os.environ, {"BROWSER_DISABLE_RECOVER_FROM_CHALLENGE": flag}):
            values = [build_browser_use_tools(actions), build_browser_use_system_prompt(actions), build_browser_use_messages(task="Preserve original task", browser_state={"timestamp": "2026-10-01T00:00:00Z", "url": "https://example.test", "title": "Page", "dom_tree": "[1] button", "viewport": {"width": 800, "height": 600}}, action_history=[], available_actions=actions, dynamic_system_context="Original context", turn_messages=[])]
        actual = tuple(hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest() for value in values)
        assert actual == hashes, "Phone-off provider tools/system/messages changed from canonical c28f801be+a05e1beb7"


async def test_phone_off_actual_rose_request():
    from types import SimpleNamespace
    from domains.spawn_browser_agent_v3 import handler as h, phone
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState
    captured = []
    def provider(request):
        assert request.url.host == "openrouter.ai", "off trajectory performed extra discovery HTTP"
        captured.append(json.loads(request.content))
        return httpx.Response(200, text=_openai_sse([{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "ordinary-decision", "type": "function", "function": {"name": "wait", "arguments": '{"time_ms":1}'}}]}, "finish_reason": "tool_calls"}]}]), headers={"Content-Type": "text/event-stream"})
    set_mock_handler(provider)
    try:
        client = RoseClient(openrouter_key="synthetic")
        state = {**_browser_state(), "timestamp": "2026-10-01T00:00:00Z"}
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "CEREBRAS_API_KEY": ""}), patch.object(phone, "observe_phone", AsyncMock(side_effect=AssertionError("off discovery"))) as observe, patch.object(client, "complete_browser_use", wraps=client.complete_browser_use) as actual:
            result = await h._call_browser_use_with_rotation(rose_client=client, task="Original task", dynamic_system_context="Original context", turn_messages=[], browser_state=state, action_entries=[], config=SimpleNamespace(backend=SimpleNamespace(api_url="https://backend.test", api_key="synthetic")), user_id="ordinary", agent_id="agent", iteration=1, token_state=ClaudeTokenState(), gpt_token=None, gpt_account_id=None, gpt_token_source=None, gpt_token_pool_id=None, browser_use_mode=None, browser_task_id="task")
        observe.assert_not_awaited()
        assert "_phone_snapshot" not in result and actual.call_args.kwargs["browser_state"] == state
        assert actual.call_args.kwargs["dynamic_system_context"] == "Original context"
        assert len(captured) == 1
        wire = captured[0]
        assert all(t["function"]["name"] != "phone" for t in wire["tools"])
        auth = next(t["function"] for t in wire["tools"] if t["function"]["name"] == "request_user_assistance_for_authentication")
        assert auth["parameters"] == {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
        assert "iphone" not in json.dumps(wire).lower() and "phone_snapshot" not in json.dumps(wire)
        assert "Original task" in json.dumps(wire["messages"])
    finally:
        teardown_mock()


async def test_native_autofill_preference_reaches_actual_enabled_request():
    """Instruction-delivery contract, not evidence of a model choosing an action."""
    from types import SimpleNamespace
    from domains.spawn_browser_agent_v3 import handler as h
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState
    captured = []
    def provider(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, text=_openai_sse([{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "observe-only", "type": "function", "function": {"name": "phone", "arguments": '{"mode":"status"}'}}]}, "finish_reason": "tool_calls"}]}]), headers={"Content-Type": "text/event-stream"})
    set_mock_handler(provider)
    try:
        for screen in ("Matching account AutoFill suggestion, password remains masked", "No matching credential available", "Face ID required to use saved credential", "Saved credential rejected by Apple Account", "App Store requests the configured Apple Account existing password to install Gmail; no matching native suggestion is available"):
            state = {"enabled": True, "interaction": {"cursor": 2, "lastOperation": {"operation": "screen.text", "status": "SUCCEEDED", "result": [{"text": screen}]}}}
            with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "CEREBRAS_API_KEY": ""}):
                await h._call_browser_use_with_rotation(rose_client=RoseClient(openrouter_key="synthetic"), task="Continue my authorized Apple Account sign-in", dynamic_system_context="Original context", turn_messages=[], browser_state=_browser_state(), action_entries=[], config=SimpleNamespace(backend=SimpleNamespace(api_url="https://backend.test", api_key="synthetic")), user_id="enabled", agent_id="agent", iteration=1, token_state=ClaudeTokenState(), gpt_token=None, gpt_account_id=None, gpt_token_source=None, gpt_token_pool_id=None, browser_use_mode=None, browser_task_id="task", phone_observation=state)
            prompt = json.dumps(captured[-1]["messages"])
            assert "try an already available native AutoFill suggestion" in prompt
            assert "credentials.fill_saved" in prompt and "phone_credential_unavailable" in prompt
            assert "performs its own server-side current form/account binding" in prompt
            assert "binding, which is not available yet" not in prompt
            auth_tool = next(tool["function"] for tool in captured[-1]["tools"] if tool["function"]["name"] == "request_user_assistance_for_authentication")
            assert "request password help only after matching native AutoFill is unavailable and credentials.fill_saved returned phone_credential_unavailable, or a saved credential was rejected" in auth_tool["description"]
            assert "Never reveal, extract, copy, or transcribe" in prompt
            assert "Supply no password, credential ref/ID, account, realm," in prompt
            assert "credentials.fill_saved requires a current successful screen.text result." in prompt
            assert "Before credentials.fill_saved obtain fresh screen.text." not in prompt
            assert "with empty args after fresh" not in prompt
            assert "and fresh observations before password help" not in prompt
            assert "current observation rule above" in prompt
            assert "Continue supported signed-out Apple/Google authentication" in prompt
            assert "App Store password prompt" in prompt and "same saved-credential waterfall" in prompt
            assert "distinct from the Google identity" in prompt
            assert "no caller realm, account, or credential ref" in prompt
            assert screen in prompt
    finally:
        teardown_mock()


def _native_autofill_control_state(screen, setup=None):
    import copy
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    return {"enabled": True, "interaction": {"cursor": 3, "lease": {"id": "synthetic-lease", "agentId": "synthetic-agent", "browserTaskId": "synthetic-task", "status": "ACTIVE", "queuePosition": None, "queueDeadlineAt": (now + timedelta(seconds=300)).isoformat(), "leaseExpiresAt": (now + timedelta(seconds=120)).isoformat(), "controlOwner": "agent", "attentionRequestId": None, "revision": 1}, "setup": copy.deepcopy(setup if setup is not None else _native_autofill_server_setup_projection()), "lastOperation": {"id": "synthetic-read", "cursor": 3, "operation": "screen.text", "status": "SUCCEEDED", "errorCode": None, "result": [{"text": screen, "source": "pixels", "confidence": 1, "x": 50, "y": 180, "w": 100, "h": 40}]}, "pendingOperation": None}}


def _native_autofill_server_setup_projection():
    """Call the actual pure backend DTO projector with synthetic owned state."""
    import subprocess
    script = """
import {setupDto} from './src/domains/iphone/repo.setup.ts';
const lease={id:'synthetic-lease',browserTaskId:'synthetic-task',status:'ACTIVE',releaseRequestedAt:null};
const state={version:1,profileRevision:1,claimRevision:1,expectedAppleIdentity:'synthetic@example.invalid',expectedPhone:'+15550000000',attempt:{id:'synthetic-attempt',revision:1,leaseId:lease.id,taskId:lease.browserTaskId,agentId:'synthetic-agent',workflowId:'synthetic-workflow',floorCursor:0,floorAt:'2026-10-19T00:00:00Z'}};
process.stdout.write(JSON.stringify(setupDto({setupState:'in_progress',providerEpoch:1},state,lease)));
"""
    env = dict(os.environ)
    env.update(DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:9/victoria_phone_control", DIRECT_URL="postgresql://postgres:postgres@127.0.0.1:9/victoria_phone_control", BACKEND_API_URL="http://127.0.0.1:9")
    env.pop("PHONE_HARNESS_API_KEY", None)
    result = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", script], cwd=ROOT.parent / "back-end", env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, "Synthetic pure backend DTO projection failed"
    return json.loads(result.stdout)


def test_native_autofill_control_fixture_matches_current_backend_dto():
    state = _native_autofill_control_state("Synthetic current password screen")
    view = state["interaction"]
    assert view["setup"] == _native_autofill_server_setup_projection(), "Control uses obsolete setup DTO"
    assert view["lease"]["browserTaskId"] == "synthetic-task"
    assert view["lastOperation"]["cursor"] == view["cursor"]
    assert view["lastOperation"]["errorCode"] is None


async def _native_autofill_record_read(history, chosen, receipt, *, turn_messages=None, model_result=None):
    import copy
    from types import SimpleNamespace
    from domains.spawn_browser_agent_v3.handler import _append_browser_turn_messages, _browser_action_tool_call_id
    result = {"success": True, "operation": copy.deepcopy(receipt)}
    await history.record_action(SimpleNamespace(), action=chosen["action"], thinking=chosen.get("thinking"), params=copy.deepcopy(chosen.get("params")), result=result)
    if turn_messages is not None:
        _append_browser_turn_messages(turn_messages, unified_action=chosen, result=result,
                                      tool_call_id=_browser_action_tool_call_id(model_result or {}))


_NATIVE_AUTOFILL_CONTROL_TASK = "Continue my authorized Apple Account sign-in. Use my already available matching saved credential if possible; ask me for the protected step only when needed."
_NATIVE_AUTOFILL_FILL_SAVED = {"action": "phone", "thinking": None, "params": {"mode": "operation", "operation": "credentials.fill_saved", "args": {}}}
_NATIVE_AUTOFILL_UNAVAILABLE_RESULT = {"success": False, "error": "phone_credential_unavailable", "operation": {"operation": "credentials.fill_saved", "status": "FAILED", "errorCode": "phone_credential_unavailable", "result": None}}
_NATIVE_AUTOFILL_SCREEN_TEXT = {"action": "phone", "thinking": None, "params": {"mode": "operation", "operation": "screen.text", "args": {"min_confidence": 0.3}}}
# The backend's public receipt for a SUCCEEDED fill (`publicOperation` +
# `redactResult`; cemented by back-end iphone-control.saved-credential cases):
# a private acknowledgment that the shared saved password was typed, never
# sign-in proof. The backend cannot observe Apple's verdict, so no "rejected"
# receipt exists; the model learns of a rejection only from the next read.
_NATIVE_AUTOFILL_FILLED_RESULT = {"success": True, "operation": {"id": "synthetic-fill-saved", "cursor": 2, "operation": "credentials.fill_saved", "status": "SUCCEEDED", "errorCode": None, "result": {"success": True, "private": True, "credentialStatus": "filled"}}}


def _native_autofill_control_history():
    """Both stores the production loop keeps: durable ActionHistory + next-turn transcript."""
    from browser_tools.dom_service import ActionHistory
    return ActionHistory(), []


async def _native_autofill_control_record(history, turn_messages, *, chosen, result, tool_call_id):
    """Record one executed phone action exactly as the production loop does.

    `_call_browser_use_with_rotation` passes both `action_history` (durable resume
    state) and `turn_messages` (the assistant tool call + tool result the next model
    turn actually reads). A control that records only one of them shows the model a
    different transcript than production.
    """
    import copy
    from types import SimpleNamespace
    from domains.spawn_browser_agent_v3 import handler as h
    await history.record_action(SimpleNamespace(), action=chosen["action"], thinking=chosen.get("thinking"), params=copy.deepcopy(chosen.get("params")), result=copy.deepcopy(result))
    h._append_browser_turn_messages(turn_messages, unified_action=copy.deepcopy(chosen), result=copy.deepcopy(result), tool_call_id=tool_call_id)


async def _native_autofill_control_request(client, *, name, state, history, turn_messages, **overrides):
    """The one browser-use request every Native AutoFill control sends (live or mocked)."""
    from domains.spawn_browser_agent_v3.phone import PHONE_GUIDANCE
    # Production (`_call_browser_use_with_rotation`) passes both stores; the
    # message builder renders `turn_messages`, so the model sees the executed
    # `phone` operation and its receipt instead of the lossy legacy summary.
    request = dict(task=_NATIVE_AUTOFILL_CONTROL_TASK, browser_state={**_browser_state(), "phone": state}, dynamic_system_context=PHONE_GUIDANCE, action_history=history.get_entries(), turn_messages=turn_messages, available_actions=["phone", "request_user_assistance_for_authentication"], include_screenshot=False, call_site="test-native-autofill-" + name, deadline_s=90, skip_cache_write=True)
    request.update(overrides)
    return await client.complete_browser_use(**request)


def _native_autofill_read_receipt(state, observation_round):
    """The synthetic host answers a read with the same screen under a new cursor/receipt id."""
    import copy
    receipt = copy.deepcopy(state["interaction"]["lastOperation"])
    receipt.update(id="synthetic-read-" + str(observation_round + 2), cursor=state["interaction"]["cursor"] + 1)
    return receipt


_NATIVE_AUTOFILL_CONTROL_SCREENS = {
    "available": "Apple Account synthetic@example.invalid. Password field is masked. A matching native AutoFill suggestion for synthetic@example.invalid is already visible: Use Saved Password button at center (100, 200).",
    "server_available": "Apple Account synthetic@example.invalid. Native AutoFill reports: No saved passwords found for this account. Password required to continue. No matching suggestion available.",
    "server_available_after_read": "Apple Account synthetic@example.invalid. Native AutoFill reports: No saved passwords found for this account. Password required to continue. No matching suggestion available.",
    "missing": "Apple Account synthetic@example.invalid. Native AutoFill reports: No saved passwords found for this account. Password required to continue. No matching suggestion available.",
    "presence": "Apple Account synthetic@example.invalid. Saved password selected. Face ID authentication required to use this saved password. Only the account owner can approve Face ID. No alternative autonomous approval is available.",
    # Only what a screen shows. Which credential was rejected is carried by the
    # recorded `credentials.fill_saved` -> `filled` tool turn, as in production;
    # the earlier OCR narration of a *native* AutoFill rejection left the
    # skill's "backend catalog is separate; fill_saved once before password
    # help" rule applicable, so the verdict was undetermined by the input.
    "rejected": "Apple Account synthetic@example.invalid. Alert: Incorrect password. The masked password field is empty again. No matching native AutoFill suggestion is available. Password is still required to continue.",
}
# Which saved-credential attempt each control verdict presupposes. Production
# shows the model that attempt as its own `phone` tool call plus the backend
# receipt in `turn_messages`; an OCR sentence claiming it happened is not a
# shape production can send.
_NATIVE_AUTOFILL_CONTROL_ATTEMPTS = {"available": None, "server_available": None, "server_available_after_read": None, "presence": None, "missing": "unavailable", "rejected": "filled"}


async def _native_autofill_control_scenario(name, setup_projection=None):
    """Build one control arm exactly as the production loop would have reached it.

    Returns `(state, history, turns)`: the observed phone state the decision sees
    plus both production stores (durable ActionHistory and the next-turn
    transcript) holding every action the arm's verdict depends on.
    """
    state = _native_autofill_control_state(_NATIVE_AUTOFILL_CONTROL_SCREENS[name], setup_projection)
    history, turns = _native_autofill_control_history()
    if name == "server_available_after_read":
        # Preserve the actual read decision immediately preceding the captured miss
        # in both production history stores, without substituting a desired action.
        import copy
        chosen_read = {"action": "phone", "thinking": "**Continuing with authentication**\n\nI see that I need to continue the authentication process. I should gather actual observations from the screen text, which might be provided from the last operation. But wait, can I do this on the phone? It seems like I should use the screen text for this, and then I can fill in any saved details as per the instructions. I’ll make sure to keep this organized!", "params": {"mode": "operation", "operation": "screen.text", "args": {"min_confidence": 0.3}}}
        receipt = copy.deepcopy(state["interaction"]["lastOperation"])
        receipt.update(id="synthetic-read-2", cursor=4)
        await _native_autofill_control_record(history, turns, chosen=chosen_read, result={"success": True, "operation": receipt}, tool_call_id="control-read-captured")
        state["interaction"]["cursor"] = receipt["cursor"]
        state["interaction"]["lastOperation"] = receipt
    if name == "missing":
        await _native_autofill_control_record(history, turns, chosen=_NATIVE_AUTOFILL_FILL_SAVED, result=_NATIVE_AUTOFILL_UNAVAILABLE_RESULT, tool_call_id="control-fill-saved")
    if name == "rejected":
        # Production reaches a rejection as: observe the form (cursor 1) ->
        # backend `credentials.fill_saved` reports `filled` (cursor 2) -> observe
        # again (cursor 3) and read the rejection. Record all three through the
        # production recorder so the transcript, not the OCR, says which
        # credential was tried.
        before = _native_autofill_control_state(_NATIVE_AUTOFILL_CONTROL_SCREENS["server_available"], setup_projection)["interaction"]["lastOperation"]
        before.update(id="synthetic-read-before-fill", cursor=1)
        await _native_autofill_control_record(history, turns, chosen=_NATIVE_AUTOFILL_SCREEN_TEXT, result={"success": True, "operation": before}, tool_call_id="control-read-before-fill")
        await _native_autofill_control_record(history, turns, chosen=_NATIVE_AUTOFILL_FILL_SAVED, result=_NATIVE_AUTOFILL_FILLED_RESULT, tool_call_id="control-fill-saved")
        await _native_autofill_control_record(history, turns, chosen=_NATIVE_AUTOFILL_SCREEN_TEXT, result={"success": True, "operation": state["interaction"]["lastOperation"]}, tool_call_id="control-read-after-fill")
    return state, history, turns


async def test_native_autofill_control_scenarios_record_saved_credential_attempts_as_turns():
    """Every saved-credential attempt a control verdict presupposes must be a real tool turn.

    Production (`_call_browser_use_with_rotation` + `_append_browser_turn_messages`)
    shows the model its own `phone(credentials.fill_saved)` call and the backend
    receipt (`credentialStatus: filled|unavailable`). The backend never emits a
    "rejected" receipt: a rejection is only visible in the next `screen.text`
    observation, and *which* credential was rejected is visible only through
    the prior tool turn. The 2026-10-31 00:28Z deploy-lane failure: the
    `rejected` arm sent no turns at all and narrated a *native* AutoFill
    rejection in OCR, so the model (correctly, per the skill's "native and
    backend stores are separate; fill_saved once before password help") chose
    `credentials.fill_saved` instead of requesting the protected step.
    """
    from domains.spawn_browser_agent_v3 import handler as h
    captured = []
    def provider(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, text=_openai_sse([{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "assist", "type": "function", "function": {"name": "request_user_assistance_for_authentication", "arguments": '{"targetKind":"iphone","criticalReason":"password"}'}}]}, "finish_reason": "tool_calls"}]}]), headers={"Content-Type": "text/event-stream"})
    set_mock_handler(provider)
    try:
        setup_projection = _native_autofill_server_setup_projection()
        client = RoseClient(openrouter_key="synthetic")
        for name, attempt in _NATIVE_AUTOFILL_CONTROL_ATTEMPTS.items():
            state, history, turns = await _native_autofill_control_scenario(name, setup_projection)
            expected = []
            for entry, (call, receipt) in zip(history.get_entries(), zip(turns[::2], turns[1::2])):
                h._append_browser_turn_messages(expected, unified_action={"action": entry["action"], "thinking": entry.get("thinking"), "params": entry["params"]}, result=json.loads(receipt["content"]), tool_call_id=call["tool_calls"][0]["id"])
            assert turns == expected and len(turns) == 2 * len(history.get_entries()), (name, "control bypasses the production turn recorder")
            with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "CEREBRAS_API_KEY": ""}):
                result = await _native_autofill_control_request(client, name=name, state=state, history=history, turn_messages=turns)
            assert result["action"]["action"] == "request_user_assistance_for_authentication", (name, result["action"])
            transcript = [m for m in captured[-1]["messages"] if m.get("role") != "system"]
            assert transcript[0] == {"role": "user", "content": _NATIVE_AUTOFILL_CONTROL_TASK}, (name, transcript[0])
            assert transcript[-1]["role"] == "user" and transcript[-1]["content"].startswith("<observed_phone_state>"), (name, transcript[-1])
            observed = json.loads(transcript[-1]["content"][len("<observed_phone_state>"):-len("</observed_phone_state>")])
            assert observed["interaction"]["lastOperation"] == state["interaction"]["lastOperation"], name
            calls = [m for m in transcript if m.get("role") == "assistant" and m.get("tool_calls")]
            receipts = [m for m in transcript if m.get("role") == "tool"]
            operations = [(json.loads(c["tool_calls"][0]["function"]["arguments"]).get("operation"), json.loads(r["content"])) for c, r in zip(calls, receipts)]
            fills = [receipt for operation, receipt in operations if operation == "credentials.fill_saved"]
            if attempt is None:
                assert fills == [], (name, "verdict presupposes no saved-credential attempt", fills)
                continue
            assert len(fills) == 1, (name, "control narrates a saved-credential attempt instead of recording the production tool turn", [op for op, _ in operations])
            receipt = fills[0]
            assert receipt["operation"]["operation"] == "credentials.fill_saved", (name, receipt)
            if attempt == "unavailable":
                assert receipt["success"] is False and receipt["operation"]["status"] == "FAILED" and receipt["operation"]["errorCode"] == "phone_credential_unavailable", (name, receipt)
                continue
            # A rejection is observable only after the backend reports `filled`
            # (back-end iphone-control.saved-credential: `{success, private, credentialStatus: 'filled'}`)
            # and the model then re-observes the screen under a later cursor.
            assert receipt["success"] is True and receipt["operation"]["status"] == "SUCCEEDED" and receipt["operation"]["errorCode"] is None, (name, receipt)
            assert receipt["operation"]["result"] == {"success": True, "private": True, "credentialStatus": "filled"}, (name, receipt)
            fill_index = operations.index(("credentials.fill_saved", receipt))
            later_reads = [r for op, r in operations[fill_index + 1:] if op == "screen.text"]
            assert later_reads and later_reads[-1]["operation"] == state["interaction"]["lastOperation"], (name, "rejection must be observed by a read recorded after the fill", [op for op, _ in operations])
            assert receipt["operation"]["cursor"] < later_reads[-1]["operation"]["cursor"], (name, receipt["operation"]["cursor"], later_reads[-1]["operation"]["cursor"])
            earlier_reads = [r for op, r in operations[:fill_index] if op == "screen.text"]
            assert earlier_reads and earlier_reads[-1]["operation"]["cursor"] < receipt["operation"]["cursor"], (name, "credentials.fill_saved requires a current screen.text observation before it")
    finally:
        teardown_mock()


async def test_native_autofill_control_transcript_matches_production_shape():
    """The control must show the model the executed-action transcript production sends.

    Production passes `turn_messages`: the assistant `phone` tool call with its
    `operation` argument and the `tool` result carrying the receipt. The legacy
    `Previous Actions` summary (`Step 1: phone ✗ Error: phone_credential_unavailable`)
    drops the operation name, so the `missing` control (fill_saved already failed)
    read exactly like `server_available` (fill_saved not yet tried) apart from an
    opaque error code — the 2026-10-30 22:42Z deploy-lane failure retried fill_saved.
    """
    from domains.spawn_browser_agent_v3 import handler as h
    captured = []
    def provider(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, text=_openai_sse([{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "observe", "type": "function", "function": {"name": "phone", "arguments": '{"mode":"operation","operation":"screen.text","args":{"min_confidence":0.3}}'}}]}, "finish_reason": "tool_calls"}]}]), headers={"Content-Type": "text/event-stream"})
    set_mock_handler(provider)
    try:
        state = _native_autofill_control_state("Synthetic current password screen")
        history, turns = _native_autofill_control_history()
        await _native_autofill_control_record(history, turns, chosen=_NATIVE_AUTOFILL_FILL_SAVED, result=_NATIVE_AUTOFILL_UNAVAILABLE_RESULT, tool_call_id="control-fill-saved")
        expected = []
        h._append_browser_turn_messages(expected, unified_action=_NATIVE_AUTOFILL_FILL_SAVED, result=_NATIVE_AUTOFILL_UNAVAILABLE_RESULT, tool_call_id="control-fill-saved")
        assert turns == expected, "Control bypasses the production turn recorder"
        assert history.get_entries()[0]["params"]["operation"] == "credentials.fill_saved"
        client = RoseClient(openrouter_key="synthetic")
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "CEREBRAS_API_KEY": ""}):
            result = await _native_autofill_control_request(client, name="transcript", state=state, history=history, turn_messages=turns)
        transcript = [m for m in captured[-1]["messages"] if m.get("role") != "system"]
        assert transcript[0] == {"role": "user", "content": _NATIVE_AUTOFILL_CONTROL_TASK}, ("legacy lossy history suffix", transcript[0])
        calls = [m for m in transcript if m.get("role") == "assistant" and m.get("tool_calls")]
        assert [(c["tool_calls"][0]["function"]["name"], json.loads(c["tool_calls"][0]["function"]["arguments"])) for c in calls] == [("phone", _NATIVE_AUTOFILL_FILL_SAVED["params"])], transcript
        tool_results = [m for m in transcript if m.get("role") == "tool"]
        assert len(tool_results) == 1 and tool_results[0]["tool_call_id"] == calls[0]["tool_calls"][0]["id"] == "control-fill-saved", transcript
        receipt = json.loads(tool_results[0]["content"])
        assert receipt["success"] is False and receipt["error"] == "phone_credential_unavailable"
        assert receipt["operation"] == _NATIVE_AUTOFILL_UNAVAILABLE_RESULT["operation"]
        assert transcript[-1]["content"].startswith("<observed_phone_state>") and '"cursor": 3' in transcript[-1]["content"]
        # The model asked for a read: the synthetic host's receipt must reach the next
        # request the same way, without rewriting the earlier fill_saved turn.
        chosen = result["action"]
        assert chosen["action"] == "phone" and chosen["params"]["operation"] == "screen.text", chosen
        read = _native_autofill_read_receipt(state, 0)
        await _native_autofill_control_record(history, turns, chosen=chosen, result={"success": True, "operation": read}, tool_call_id="control-read-1")
        state["interaction"]["cursor"] = read["cursor"]
        state["interaction"]["lastOperation"] = read
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "CEREBRAS_API_KEY": ""}):
            await _native_autofill_control_request(client, name="transcript", state=state, history=history, turn_messages=turns)
        transcript = [m for m in captured[-1]["messages"] if m.get("role") != "system"]
        names = [(m["role"], json.loads(m["tool_calls"][0]["function"]["arguments"])["operation"] if m.get("tool_calls") else json.loads(m["content"])["operation"]["operation"]) for m in transcript if m.get("role") in ("assistant", "tool")]
        assert names == [("assistant", "credentials.fill_saved"), ("tool", "credentials.fill_saved"), ("assistant", "screen.text"), ("tool", "screen.text")], names
        assert json.loads(transcript[-2]["content"])["operation"]["id"] == "synthetic-read-2" and '"cursor": 4' in transcript[-1]["content"]
        assert transcript[0] == {"role": "user", "content": _NATIVE_AUTOFILL_CONTROL_TASK}
    finally:
        teardown_mock()


async def test_native_autofill_control_history_matches_real_serializer():
    import copy
    from browser_tools.dom_service import ActionHistory
    from providers.rose.browser_use import _format_action_history
    chosen = {"action": "phone", "thinking": None, "params": {"mode": "operation", "operation": "screen.text", "args": {}}}
    receipt = {"id": "read-1", "cursor": 1, "operation": "screen.text", "status": "SUCCEEDED", "result": [{"text": "Synthetic"}]}
    history = ActionHistory()
    turn_messages = []
    await _native_autofill_record_read(history, chosen, receipt, turn_messages=turn_messages, model_result={"tool_call_id": "read-tool-1"})
    actual = ActionHistory()
    from types import SimpleNamespace
    await actual.record_action(SimpleNamespace(), action="phone", thinking=None, params=chosen["params"], result={"success": True, "operation": copy.deepcopy(receipt)})
    assert history.get_entries() == actual.get_entries(), "Control bypasses real ActionHistory serialization"
    receipt["id"] = "read-2"
    assert history.get_entries()[0]["result"]["operation"]["id"] == "read-1", "Prior receipt mutated with current observation"
    rendered = _format_action_history(history.get_entries())
    assert "Step 1: phone" in rendered and "Step None" not in rendered
    assert turn_messages[0]["tool_calls"][0]["id"] == turn_messages[1]["tool_call_id"] == "read-tool-1"
    assert json.loads(turn_messages[0]["tool_calls"][0]["function"]["arguments"]) == chosen["params"]
    assert json.loads(turn_messages[1]["content"])["operation"] == history.get_entries()[0]["result"]["operation"]
    assert json.loads(turn_messages[1]["content"])["operation"]["id"] == "read-1"


async def test_native_autofill_real_model_synthetic_controls():
    """Real canonical decisions on synthetic OCR; no device execution or secrets."""
    from _test_utils import live_funded_azure
    setup_projection = _native_autofill_server_setup_projection()
    async def decide(name):
        state, history, turns = await _native_autofill_control_scenario(name, setup_projection)
        served = {}
        for observation_round in range(3):
            result = await _native_autofill_control_request(RoseClient(), name=name, state=state, history=history, turn_messages=turns)
            # Bind the verdict to the leg that actually answered: the pool's primary
            # legs (Cerebras, Foundry) are unavailable in coverage, so every control
            # is answered by the OpenRouter waterfall and the failure must say so.
            served = {"actual_model": result.get("actual_model"), "mode": result.get("mode"), "request_id": result.get("request_id")}
            chosen = result.get("action", {})
            print("Native AutoFill actual choice:", name, observation_round, json.dumps(served), json.dumps(chosen), flush=True)
            if chosen.get("action") != "phone" or chosen.get("params", {}).get("operation") != "screen.text":
                break
            # The real model requested a read; the synthetic host exposes the same
            # screen. Preserve its chosen action and returned observation, never
            # substitute a desired tap/attention decision.
            receipt = _native_autofill_read_receipt(state, observation_round)
            await _native_autofill_control_record(history, turns, chosen=chosen, result={"success": True, "operation": receipt}, tool_call_id="control-read-" + str(observation_round + 1))
            state["interaction"]["cursor"] = receipt["cursor"]
            state["interaction"]["lastOperation"] = receipt
        action = result.get("action", {})
        params = action.get("params", {})
        verdict = (name, served, action)
        assert not (action.get("action") == "phone" and params.get("operation") == "input.text"), verdict
        if name in {"server_available", "server_available_after_read"}:
            assert action.get("action") == "phone" and params.get("operation") == "credentials.fill_saved" and params.get("args") == {}, verdict
        elif name == "available":
            assert action.get("action") == "phone" and params.get("operation") == "input.tap", verdict
            assert params.get("args") == {"x": 100, "y": 200}, verdict
        else:
            assert action.get("action") == "request_user_assistance_for_authentication" and params.get("targetKind") == "iphone", verdict
            assert params.get("criticalReason") == ("manual_verification" if name == "presence" else "password"), verdict
        usage = result.get("usage", {})
        print("Native AutoFill real synthetic control:", name, "model:", result.get("actual_model"), "usage:", json.dumps(usage), flush=True)
    teardown_mock()
    with live_funded_azure():
        outcomes = await asyncio.wait_for(asyncio.gather(*(decide(name) for name in _NATIVE_AUTOFILL_CONTROL_SCREENS), return_exceptions=True), timeout=120)
        errors = [str(value) for value in outcomes if isinstance(value, BaseException)]
        assert not errors, errors


def test_phone_setup_verification_targets_schema_and_isolation():
    import pytest
    from browser_tools.schemas import validate_browser_tool_args
    targets = ["apple_account", "icloud_messages", "icloud_keychain", "icloud_contacts", "imessage", "receive_address", "portrait_lock", "device_passcode", "gmail", "google_passcode_exception", "runtime"]
    from browser_tools.schemas import PhoneBrowserTool
    schema = PhoneBrowserTool.model_json_schema()["properties"]
    assert schema["evidenceOperationIds"].get("description") == "Use only for mode=setup and action=verify: 1..8 current observation IDs. Omit or null for block, defer, and all other modes."
    assert schema["verificationTarget"].get("description") == "Use only for mode=setup and action=verify. Omit or null for block, defer, and all other modes."
    with pytest.raises(ValueError):
        validate_browser_tool_args("phone", {"mode": "setup", "action": "block", "reasonCode": "configuration_unavailable", "verificationTarget": "google_passcode_exception", "evidenceOperationIds": ["no_admin-read-1"]})
    before = json.dumps(BROWSER_USE_TOOLS, sort_keys=True)
    for target in targets:
        params = {"mode": "setup", "action": "verify", "evidenceOperationIds": ["owned-read"], "verificationTarget": target}
        normalized = normalize_browser_use_tool_call({"name": "phone", "arguments": json.dumps(params)})["params"]
        assert normalized["verificationTarget"] == target
    for params in (
        {"mode": "setup", "action": "verify", "evidenceOperationIds": ["owned-read"], "verificationTarget": "messages_delivered"},
        {"mode": "setup", "action": "defer", "reasonCode": "user_constraint", "verificationTarget": "imessage"},
        {"mode": "setup", "action": "block", "reasonCode": "unsupported", "verificationTarget": "imessage"},
        {"mode": "operation", "operation": "screen.text", "verificationTarget": "runtime"},
        {"mode": "status", "verificationTarget": "runtime"},
        {"mode": "release", "verificationTarget": "runtime"},
    ):
        with pytest.raises(ValueError):
            validate_browser_tool_args("phone", params)
    for proof_field in ("enabled", "orientation", "controlState", "requirementsVersion", "expectedGoogleAccountIdentifier", "expectedGoogleIdentity", "installed", "signedIn", "googlePasscodeExceptionAllowed", "securityDisposition", "adminPermission"):
        with pytest.raises(ValueError):
            validate_browser_tool_args("phone", {"mode": "setup", "action": "verify", "verificationTarget": "portrait_lock", "evidenceOperationIds": ["read"], proof_field: True})
    nullable_block = normalize_browser_use_tool_call({"name": "phone", "arguments": json.dumps({"mode": "setup", "action": "block", "reasonCode": "configuration_unavailable", "verificationTarget": None})})["params"]
    omitted_block = normalize_browser_use_tool_call({"name": "phone", "arguments": json.dumps({"mode": "setup", "action": "block", "reasonCode": "configuration_unavailable"})})["params"]
    assert nullable_block == omitted_block and "verificationTarget" not in nullable_block, "Declared nullable target must normalize like omission"
    legacy = validate_browser_tool_args("phone", {"mode": "setup", "action": "verify", "evidenceOperationIds": ["read"]})
    assert "verificationTarget" not in legacy, "Legacy default must remain omitted on the wire"
    assert not any(tool["name"] == "phone" for tool in build_browser_use_tools(["wait"]))
    assert before == json.dumps(BROWSER_USE_TOOLS, sort_keys=True)


async def test_phone_setup_settings_actual_handler_observation():
    from types import SimpleNamespace
    from domains.spawn_browser_agent_v3 import handler as h
    from domains.spawn_browser_agent_v3.types import ClaudeTokenState
    verification = {"requirementsVersion": 6, "checks": {"gmail": {"status": "unknown", "current": True}, "icloud_messages": {"status": "confirmed", "observedAt": "2026-10-19T00:00:00Z", "current": False}, "imessage": {"status": "unknown", "current": True}, "portrait_lock": {"status": "unknown", "current": True}}, "configurationReady": False, "operationalStatus": "degraded", "securityDisposition": "blocked", "expectedReceiveAddress": "+15550000000"}
    setup = {"identityVerified": True, "state": "in_progress", "attemptId": "owned-attempt", "revision": 7, "expectedGoogleAccountIdentifier": "synthetic-google@example.test", "googlePasscodeExceptionAllowed": True, "verification": verification}
    captured = []
    def provider(request):
        captured.append(json.loads(request.content))
        args = {"mode": "setup", "action": "verify", "verificationTarget": "portrait_lock", "evidenceOperationIds": ["owned-read"]}
        return httpx.Response(200, text=_openai_sse([{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "settings-decision", "type": "function", "function": {"name": "phone", "arguments": json.dumps(args)}}]}, "finish_reason": "tool_calls"}]}]), headers={"Content-Type": "text/event-stream"})
    set_mock_handler(provider)
    try:
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "CEREBRAS_API_KEY": ""}):
            result = await h._call_browser_use_with_rotation(rose_client=RoseClient(openrouter_key="synthetic"), task="Preserve the original authorized phone task", dynamic_system_context="Original context", turn_messages=[], browser_state=_browser_state(), action_entries=[], config=SimpleNamespace(backend=SimpleNamespace(api_url="https://backend.test", api_key="synthetic")), user_id="enabled", agent_id="agent", iteration=1, token_state=ClaudeTokenState(), gpt_token=None, gpt_account_id=None, gpt_token_source=None, gpt_token_pool_id=None, browser_use_mode=None, browser_task_id="task", phone_observation={"enabled": True, "interaction": {"cursor": 12, "setup": setup}})
        assert result["action"]["params"]["verificationTarget"] == "portrait_lock"
        observed = [m for m in captured[0]["messages"] if "<observed_phone_state>" in str(m.get("content"))]
        assert len(observed) == 1 and json.dumps(verification) in observed[0]["content"]
        wire = json.dumps(captured[0]["messages"])
        assert "Labels alone" in wire and "configurationReady" in wire and "operationalStatus" in wire
        assert "Portrait Orientation Lock" in wire and "portrait frame alone" in wire
        assert "iCloud Contacts" in wire and "contact names or counts" in wire
        assert "expectedGoogleAccountIdentifier" in wire and "synthetic-google@example.test" in wire
        assert "App Store" in wire and "install Gmail" in wire
        assert "verificationTarget=gmail" in wire
        assert "credentials.fill_device_passcode" in wire and "verificationTarget=device_passcode" in wire
        assert "Passcode Options" in wire and "4-Digit Numeric Code" in wire
        assert "acknowledged" in wire and "standard weak-code warning" in wire
        assert "never enterprise or provider policy" in wire
        assert "Do not change an existing passcode" in wire
        assert "Do not remove or weaken provider/MDM profiles" in wire
        assert "current Gmail passcode conflict and provider-blocked passcode creation" in wire
        assert "verified required admin privilege" in wire
        assert "Open https://admin.google.com/ in the ordinary browser when not already at the" in wire
        assert "user-authorized scope" in wire
        assert "Admin privilege alone is not authorization" in wire
        assert "preserve all other security settings" in wire
        assert "policy exception is not proof that a device passcode is enabled" in wire
        assert "googlePasscodeExceptionAllowed" in wire and "google_passcode_exception" in wire
        assert "securityDisposition" in wire
        assert "if this marker is absent or false, report setup" in wire
        assert "Repeated unchanged reads" in wire and "cannot grant authorization" in wire
        assert "does not prove admin policy authority or a policy write" in wire
        assert "configuration_unavailable" in wire and "passcode modification is restricted" in wire
        assert "never guess, reset, or bypass" in wire
        assert "private acknowledgment alone is not enabled-state proof" in wire
        assert "1234" not in wire
        assert "Supported bindings are Apple Account and Google sign-in" in wire
        assert "actual Google form" in wire and "separately configured Google identity" in wire
        assert "supports Apple Account binding only" not in wire
        assert "installation alone" in wire and "device approval" in wire
        assert "Apple Account identifier is not the Google account" in wire
        assert "current sign-in challenge" in wire and "return to the browser" in wire
        assert "unrelated or ambiguous" in wire
        assert "current matching Messages" in wire and "current challenge timestamp" in wire
        assert "browser or native phone SMS/OTP challenges" in wire
        assert "including during boot setup" in wire
        assert "before starting Gmail sign-in that may need SMS" in wire
        assert "Do not wait for historical message downloads" in wire
        assert "do not consume codes for unrelated tasks" in wire
        assert "verify continuation on the original browser or phone screen" in wire
        assert "Never submit an ambiguous, stale, unrelated, or already used code" in wire
        assert "never" in wire and "old or unrelated code" in wire
        assert "Text Message Forwarding" in wire and "generic assistance" in wire
        assert "Do not disable iCloud" in wire and "Historical download completion" in wire
        assert "Do not wait for configurationReady to sign in" in wire
        assert "latest successful operation is screen.text for the current interaction" in wire
        assert "Preserve the original authorized phone task" in wire
        import hashlib
        from domains.spawn_browser_agent_v3.phone import PHONE_GUIDANCE
        # Combined reviewed current-screen guidance and upstream server-side credential binding.
        assert hashlib.sha256(PHONE_GUIDANCE.encode()).hexdigest() == "5b12790d07335aafac6eefd6ccda75487065e3b1272189afcbfc36bc7c7dff71", "Ordinary enabled guide must match the saved-credential binding contract"
        for marker in (None, False, "true"):
            plain_setup = {key: value for key, value in setup.items() if key != "googlePasscodeExceptionAllowed"}
            if marker is not None:
                plain_setup["googlePasscodeExceptionAllowed"] = marker
            with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "CEREBRAS_API_KEY": ""}):
                await h._call_browser_use_with_rotation(rose_client=RoseClient(openrouter_key="synthetic"), task="Ordinary enabled phone task", dynamic_system_context="Original context", turn_messages=[], browser_state=_browser_state(), action_entries=[], config=SimpleNamespace(backend=SimpleNamespace(api_url="https://backend.test", api_key="synthetic")), user_id="enabled", agent_id="agent", iteration=1, token_state=ClaudeTokenState(), gpt_token=None, gpt_account_id=None, gpt_token_source=None, gpt_token_pool_id=None, browser_use_mode=None, browser_task_id="task", phone_observation={"enabled": True, "interaction": {"cursor": 12, "setup": plain_setup}})
            systems = [message["content"] if isinstance(message["content"], str) else "".join(block.get("text", "") for block in message["content"]) for message in captured[-1]["messages"] if message["role"] == "system"]
            assert any(("Original context\n\n" + PHONE_GUIDANCE).rstrip() in content for content in systems), "Provider may merge system messages but must preserve exact ordinary dynamic bytes"
            assert not any("Open https://admin.google.com/" in content or "Admin privilege alone is not authorization" in content for content in systems)

    finally:
        teardown_mock()


if __name__ == "__main__":
    asyncio.run(run_all_tests())


async def test_advertised_coordinate_only_action_is_admitted():
    from providers.rose.types import RoseResponse
    from providers.rose.errors import BrowserModelOutputValidationError
    from helpers import observability
    responses = [
        RoseResponse(tool_calls=[{"id": "coordinate-call", "name": "click_coordinates", "arguments": '{"x": 12, "y": 34}'}]),
        RoseResponse(content='{"action": [{"click_coordinates": {"x": 12, "y": 34}}]}'),
    ]
    client = RoseClient(openrouter_key="offline-unused")
    with patch.object(observability, "dump_llm_context"):
        for response in responses:
            client.collect = AsyncMock(return_value=response)
            try:
                result = await client.complete_browser_use(task="Click the visible target", browser_state=_browser_state(), action_history=[], available_actions=["click_coordinates"])
            except BrowserModelOutputValidationError as error:
                raise AssertionError("the advertised coordinate-only action was rejected after normalization") from error
            advertised = client.collect.await_args.kwargs["tools"]
            assert [tool["name"] for tool in advertised] == ["click_coordinates"]
            assert result["action"]["action"] == "click"
            assert result["action"]["coordinates"] == {"x": 12, "y": 34}


async def test_declared_tool_admission_keeps_aliases_and_batch_semantics():
    from providers.rose.types import RoseResponse
    from providers.rose.errors import BrowserModelOutputValidationError
    from helpers import observability
    client = RoseClient(openrouter_key="offline-unused")
    async def complete(response, available):
        client.collect = AsyncMock(return_value=response)
        return await client.complete_browser_use(task="Use the offered action", browser_state=_browser_state(), action_history=[], available_actions=available)
    with patch.object(observability, "dump_llm_context"):
        for response in (
            RoseResponse(tool_calls=[{"id": "hidden", "name": "screenshot", "arguments": "{}"}]),
            RoseResponse(content='{"action": [{"screenshot": {}}]}'),
            RoseResponse(tool_calls=[{"id": "unoffered-index", "name": "click", "arguments": '{"index": 3}'}]),
            RoseResponse(content='{"action": [{"click": {"index": 3}}]}'),
        ):
            try:
                await complete(response, ["click_coordinates"])
            except BrowserModelOutputValidationError:
                pass
            else:
                raise AssertionError("an action absent from the request grammar was admitted")
        result = await complete(RoseResponse(tool_calls=[{"id": "nested", "function": {"name": "click_coordinates", "arguments": '{"x": 12, "y": 34}'}}]), ["click_coordinates"])
        assert result["action"]["coordinates"] == {"x": 12, "y": 34}
        result = await complete(RoseResponse(content='{"action": [{"done": {"text": "Finished"}}]}'), ["attempt_completion"])
        assert result["action"]["action"] == "attempt_completion"
        result = await complete(RoseResponse(tool_calls=[{"id": "key-" + key, "name": "press_key", "arguments": json.dumps({"key": key})} for key in "ab"]), ["press_key"])
        assert result["action"]["action"] == "input_text"
        assert result["action"]["params"]["text"] == "ab"
