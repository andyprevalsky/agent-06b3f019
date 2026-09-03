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


def test_read_and_delete_cookies_use_humanizer_playwright_context_not_actor_page():
    """browser-use actor Page has no ``.context``; cookie tools must use Playwright jar.

    Local repro of DoorDash grocery bench failure:
    ``Action read_cookies failed: 'Page' object has no attribute 'context'``.
    """
    import asyncio
    from types import SimpleNamespace

    from domains.spawn_browser_agent_v3 import service_actions as sa

    os.environ["BROWSER_EXPOSE_COOKIE_CONFIG_TOOLS"] = "1"

    long_value = "SESSION_" + ("B" * 12000)
    jar_state = [
        {
            "name": "ddweb_session_id",
            "value": long_value,
            "domain": ".doordash.com",
            "path": "/",
            "expires": 1893456000,
            "httpOnly": True,
            "secure": True,
            "sameSite": "None",
        },
        {
            "name": "cf_clearance",
            "value": "challenge-token",
            "domain": ".doordash.com",
            "path": "/",
            "expires": 1893456000,
            "httpOnly": False,
            "secure": True,
            "sameSite": "None",
        },
        {
            "name": "other",
            "value": "1",
            "domain": ".example.com",
            "path": "/",
            "expires": -1,
            "httpOnly": False,
            "secure": False,
            "sameSite": "Lax",
        },
    ]

    class ActorPage:
        """Mirrors browser-use actor Page: no Playwright ``context`` attribute."""

    class FakeCookieJar:
        def __init__(self) -> None:
            self.cookies_list = list(jar_state)

        async def cookies(self, urls=None):
            del urls
            return list(self.cookies_list)

        async def clear_cookies(self, name=None, domain=None, path=None):
            del path
            kept = []
            for cookie in self.cookies_list:
                name_match = name is None or cookie.get("name") == name
                domain_match = domain is None or cookie.get("domain") == domain
                if name_match and domain_match:
                    continue
                kept.append(cookie)
            self.cookies_list = kept

    class FakeSession:
        async def get_current_page(self):
            return ActorPage()

    class FakeActionHistory:
        def __init__(self) -> None:
            self.calls = []

        async def record_action(self, **kwargs):
            self.calls.append(kwargs)

    async def _run() -> None:
        jar = FakeCookieJar()
        humanizer = SimpleNamespace(input_page=SimpleNamespace(context=jar))
        history = FakeActionHistory()
        context = SimpleNamespace(
            session=FakeSession(),
            humanizer=humanizer,
            params={"domain": ".doordash.com"},
            current_url="https://www.doordash.com/",
            action_history=history,
            dom_service=object(),
            thinking="inspect cookies",
        )

        # Old code path: actor page.context → AttributeError.
        actor = await context.session.get_current_page()
        try:
            _ = actor.context
            raise AssertionError("actor page unexpectedly exposed .context")
        except AttributeError as exc:
            assert "context" in str(exc)

        read = await sa._execute_read_cookies_action(context)
        assert read["success"] is True
        assert read["cookie_count"] == 2
        by_name = {cookie["name"]: cookie for cookie in read["cookies"]}
        assert by_name["ddweb_session_id"]["value"] == long_value
        assert len(by_name["ddweb_session_id"]["value"]) == len(long_value)
        assert by_name["cf_clearance"]["value"] == "challenge-token"

        # Domain-only wipe refused (would destroy DoorDash auth).
        context.params = {"domain": ".doordash.com"}
        refused_domain = await sa._execute_delete_cookies_action(context)
        assert refused_domain["success"] is False
        assert "explicit cookie name" in refused_domain["error"]

        # Auth/session cookie delete refused.
        context.params = {"name": "ddweb_session_id", "domain": ".doordash.com"}
        refused_auth = await sa._execute_delete_cookies_action(context)
        assert refused_auth["success"] is False
        assert "auth/session cookie" in refused_auth["error"]
        assert any(c["name"] == "ddweb_session_id" for c in jar.cookies_list)

        # Named challenge cookie delete allowed.
        context.params = {"name": "cf_clearance", "domain": ".doordash.com"}
        deleted = await sa._execute_delete_cookies_action(context)
        assert deleted["success"] is True
        assert deleted["deleted_count"] == 1
        assert deleted["deleted_cookies"][0]["name"] == "cf_clearance"
        remaining = {c["name"] for c in jar.cookies_list}
        assert remaining == {"ddweb_session_id", "other"}

    asyncio.run(_run())


def test_finalize_recovery_records_actual_tool_name_not_hardcoded_recover():
    """read/set_browser_config share the recovery finalizer — must not mislabel history."""
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from domains.spawn_browser_agent_v3.handler import (
        _finalize_browser_recovery_action_result,
    )

    async def _run() -> None:
        action_history = SimpleNamespace(record_action=AsyncMock())
        browser_stream = SimpleNamespace(finish_tools=AsyncMock())
        await _finalize_browser_recovery_action_result(
            action_result={"success": True, "config_key": "steel_fixed"},
            dom_service=SimpleNamespace(),
            action_history=action_history,
            thinking="inspect config",
            recovery_reason="read_browser_config",
            browser_turn_messages=[],
            task_prompt="order groceries",
            browser_state={},
            unified_action={"action": "read_browser_config", "params": {}},
            recovery_call_id="cfg-1",
            browser_stream=browser_stream,
        )
        action_history.record_action.assert_awaited_once()
        assert (
            action_history.record_action.await_args.kwargs["action"]
            == "read_browser_config"
        )

    asyncio.run(_run())


if __name__ == "__main__":
    test_cookie_config_tools_are_registered_and_advertised_when_enabled()
    test_cookie_config_tools_can_be_hidden()
    test_serialize_cookie_does_not_truncate_values()
    test_delete_cookie_selection_and_config_allowlist()
    test_normalize_cookie_config_tool_params()
    test_read_and_delete_cookies_use_humanizer_playwright_context_not_actor_page()
    test_finalize_recovery_records_actual_tool_name_not_hardcoded_recover()
    print("cookie_config_tools.blackbox: PASS")
