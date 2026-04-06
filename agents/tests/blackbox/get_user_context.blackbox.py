"""Blackbox tests for get-user-context domain."""

import asyncio
import json
from unittest.mock import patch

import httpx

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock_fn,
    teardown_mock,
)


def _mock_handler(request: httpx.Request) -> httpx.Response:
    """Route multiple backend endpoints used by get_user_context."""
    url = str(request.url)

    if "/api/user-settings" in url:
        return httpx.Response(200, json={
            "name": "Alice Test",
            "phone": "+15551234567",
            "systemName": "Rosie",
            "customSystemPrompt": "Always be polite.",
            "addressLine1": "123 Main St",
            "city": "Portland",
            "state": "OR",
            "postalCode": "97201",
            "country": "US",
        })

    if "/api/integrations" in url:
        return httpx.Response(200, json={
            "integrations": [
                {"name": "Gmail", "status": "CONNECTED", "emailCredentials": [{"email": "alice@example.com"}]},
            ],
            "authenticatedDomains": ["github.com", "notion.so"],
        })

    if "/api/people/messages/recent" in url:
        return httpx.Response(200, json={
            "messages": [
                {"channel": "SMS", "timestamp": "2026-04-05T12:00:00Z", "from": "+15559999999", "to": "+15551234567", "message": "Hey Alice!"},
            ],
        })

    if "/api/people" in url:
        return httpx.Response(200, json={
            "people": [
                {"firstName": "Bob", "lastName": "Jones", "phoneNumber": "+15559999999", "communicationFrequency": "daily", "messagesExchanged": 42},
            ],
        })

    return httpx.Response(404, json={"error": f"No mock for {url}"})


def _setup():
    setup_mock_fn(_mock_handler)


def _clear_user_context_cache():
    """Clear the module-level cache so tests make real HTTP calls."""
    import sys
    # Must access via sys.modules since helpers.__init__.py shadows the module name
    mod = sys.modules.get("helpers.get_user_context")
    if mod is None:
        import importlib
        mod = importlib.import_module("helpers.get_user_context")
    mod._user_context_cache.clear()


async def test_get_user_context_happy_path():
    """get_user_context activity returns formatted user context string."""
    _setup()
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_context

        result = await get_user_context(user_id="user-test-123")

    assert isinstance(result, str)
    assert "Alice Test" in result
    assert "USER CONTEXT:" in result
    # Verify sections present
    assert "USER PROFILE" in result
    assert "CONNECTED INTEGRATIONS" in result


async def test_get_system_name():
    """get_user_system_name returns the custom system name."""
    _setup()
    _clear_user_context_cache()
    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_system_name

        result = await get_user_system_name(user_id="user-test-456")

    assert result == "Rosie"


async def test_get_custom_prompt():
    """get_user_custom_system_prompt returns the custom prompt string."""
    _setup()
    _clear_user_context_cache()
    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_custom_system_prompt

        result = await get_user_custom_system_prompt(user_id="user-test-789")

    assert result == "Always be polite."


async def test_get_user_context_boundary():
    """Verify outbound HTTP calls hit the expected backend endpoints."""
    _setup()
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_context

        await get_user_context(user_id="user-boundary-001")

    captures = get_captured_requests()
    urls = [c["url"] for c in captures]

    # All four backend endpoints should have been called
    assert any("/api/user-settings" in u for u in urls), f"Expected /api/user-settings call, got {urls}"
    assert any("/api/integrations" in u for u in urls), f"Expected /api/integrations call, got {urls}"
    assert any("/api/people/messages/recent" in u for u in urls), f"Expected /api/people/messages/recent call, got {urls}"
    assert any("/api/people" in u for u in urls), f"Expected /api/people call, got {urls}"

    # Verify X-API-Key header present on all calls
    for c in captures:
        headers_lower = {k.lower() for k in c["requestHeaders"]}
        assert "x-api-key" in headers_lower, f"Missing X-API-Key header on {c['url']}"


async def test_get_user_context_gates_closed():
    """When all gates are closed, no HTTP calls are made."""
    _setup()
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_context

        result = await get_user_context(
            user_id="user-gated-001",
            context_gates={
                "user_profile": False,
                "authenticated_sessions": False,
                "integrations": False,
                "recent_communications": False,
                "network": False,
            },
        )

    assert result == ""
    assert len(get_captured_requests()) == 0


async def run_all_tests():
    print("get-user-context blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_get_user_context_happy_path)
    await r.record_async("get_system_name", test_get_system_name)
    await r.record_async("get_custom_prompt", test_get_custom_prompt)
    await r.record_async("boundary", test_get_user_context_boundary)
    await r.record_async("gates_closed", test_get_user_context_gates_closed)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
