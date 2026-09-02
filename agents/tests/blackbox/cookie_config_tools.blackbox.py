"""Temporary cookie/config browser tools (DoorDash grocery A/B)."""

from __future__ import annotations

import os

from browser_tools.schemas import AVAILABLE_ACTIONS, BROWSER_TOOL_MODELS
from domains.spawn_browser_agent_v3.cookie_config_tools import (
    BROWSER_CONFIG_ALLOWLIST,
    COOKIE_CONFIG_TOOL_NAMES,
    blocked_config_keys_for_target,
    cookie_config_tools_enabled,
    describe_browser_config,
    select_cookies_for_deletion,
    serialize_cookie,
)
from providers.rose.browser_use import (
    BROWSER_USE_TOOLS,
    build_browser_use_tools,
    normalize_browser_use_response,
    recover_from_challenge_enabled,
)


def test_cookie_config_tools_are_registered_and_advertised_when_enabled():
    os.environ["BROWSER_EXPOSE_COOKIE_CONFIG_TOOLS"] = "1"
    os.environ["BROWSER_DISABLE_RECOVER_FROM_CHALLENGE"] = "1"
    assert cookie_config_tools_enabled()
    assert not recover_from_challenge_enabled()
    for name in COOKIE_CONFIG_TOOL_NAMES:
        assert name in BROWSER_USE_TOOLS
        assert name in BROWSER_TOOL_MODELS
        assert name in AVAILABLE_ACTIONS
    advertised = {tool["name"] for tool in build_browser_use_tools(list(AVAILABLE_ACTIONS))}
    assert set(COOKIE_CONFIG_TOOL_NAMES).issubset(advertised)
    assert "recover_from_challenge" not in advertised


def test_cookie_config_tools_can_be_hidden():
    os.environ["BROWSER_EXPOSE_COOKIE_CONFIG_TOOLS"] = "0"
    try:
        assert not cookie_config_tools_enabled()
        from providers.rose import browser_use as bu

        advertised = {tool["name"] for tool in bu.build_browser_use_tools(list(AVAILABLE_ACTIONS))}
        assert set(COOKIE_CONFIG_TOOL_NAMES).isdisjoint(advertised)
    finally:
        os.environ["BROWSER_EXPOSE_COOKIE_CONFIG_TOOLS"] = "1"


def test_serialize_cookie_does_not_truncate_values():
    value = "TOKEN_" + ("A" * 20000)
    serialized = serialize_cookie(
        {
            "name": "dd_session",
            "value": value,
            "domain": ".doordash.com",
            "path": "/",
            "expires": 1893456000,
            "httpOnly": True,
            "secure": True,
            "sameSite": "None",
        }
    )
    assert serialized["value"] == value
    assert serialized["domain"] == ".doordash.com"
    assert serialized["httpOnly"] is True


def test_delete_cookie_selection_and_config_allowlist():
    cookies = [
        {"name": "a", "value": "1", "domain": ".doordash.com", "path": "/"},
        {"name": "cf_clearance", "value": "x", "domain": ".doordash.com", "path": "/"},
        {"name": "cf_clearance", "value": "y", "domain": ".other.com", "path": "/"},
    ]
    deleted = select_cookies_for_deletion(cookies, name="cf_clearance", domain="doordash.com")
    assert len(deleted) == 1
    assert deleted[0]["value"] == "x"
    blocked = blocked_config_keys_for_target("steel_fixed")
    assert "steel_fixed" not in blocked
    assert set(blocked) == set(BROWSER_CONFIG_ALLOWLIST) - {"steel_fixed"}
    description = describe_browser_config(
        browser_session_metadata={"provider": "kernel", "proxy_tier": "mobile_city"},
        last_promoted_browser_config_key="kernel_mobile",
        dead_browser_config_keys=["steel_managed"],
    )
    assert description["config_key"] == "kernel_mobile"
    assert description["allowlisted_browser_configs"] == list(BROWSER_CONFIG_ALLOWLIST)


def test_normalize_cookie_config_tool_params():
    os.environ["BROWSER_EXPOSE_COOKIE_CONFIG_TOOLS"] = "1"
    read = normalize_browser_use_response(
        {"action": [{"read_cookies": {"domain": ".doordash.com"}}], "thinking": "inspect"}
    )
    assert read["action"] == "read_cookies"
    assert read["params"]["domain"] == ".doordash.com"
    delete = normalize_browser_use_response(
        {
            "action": [{"delete_cookies": {"name": "cf_clearance", "domain": ".doordash.com"}}],
            "thinking": "clear",
        }
    )
    assert delete["action"] == "delete_cookies"
    assert delete["params"] == {"name": "cf_clearance", "domain": ".doordash.com"}
    restore = normalize_browser_use_response(
        {"action": [{"restore_cookies": {}}], "thinking": "reauth"}
    )
    assert restore["action"] == "restore_cookies"
    assert restore["params"] == {}
    cfg = normalize_browser_use_response(
        {"action": [{"set_browser_config": {"config_key": "kernel_isp"}}], "thinking": "switch"}
    )
    assert cfg["action"] == "set_browser_config"
    assert cfg["params"]["config_key"] == "kernel_isp"


if __name__ == "__main__":
    test_cookie_config_tools_are_registered_and_advertised_when_enabled()
    test_cookie_config_tools_can_be_hidden()
    test_serialize_cookie_does_not_truncate_values()
    test_delete_cookie_selection_and_config_allowlist()
    test_normalize_cookie_config_tool_params()
    print("cookie_config_tools.blackbox: PASS")
