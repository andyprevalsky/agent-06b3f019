"""Blackbox tests for get-user-context domain."""

import asyncio
import importlib
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
        return httpx.Response(
            200,
            json={
                "name": "Alice Test",
                "email": "alice@example.com",
                "phone": "+15551234567",
                "deliveryRecipientName": "Robin Recipient",
                "systemName": "Rosie",
                "customSystemPrompt": "Always be polite.",
                "addressLine1": "123 Main St",
                "city": "Portland",
                "state": "OR",
                "postalCode": "97201",
                "country": "US",
            },
        )

    if "/api/integrations" in url:
        return httpx.Response(
            200,
            json={
                "integrations": [
                    {"name": "Gmail", "status": "CONNECTED", "emailCredentials": [{"email": "alice@example.com"}]},
                ],
                "authenticatedDomains": ["github.com", "notion.so"],
            },
        )

    if "/api/data/snapshot" in url:
        return httpx.Response(
            200,
            json={
                "snapshot": {
                    "content": {"preferences": {"writing_style": "concise"}, "work": {"focus": "agents"}},
                    "version": 3,
                    "updatedAt": "2026-07-03T12:00:00Z",
                    "revisions": [
                        {
                            "source": "chatgpt",
                            "createdAt": "2026-07-03T12:00:00Z",
                            "changes": {"preferences": ["writing_style"]},
                        },
                    ],
                },
            },
        )

    if "/api/people/messages/recent" in url:
        return httpx.Response(
            200,
            json={
                "messages": [
                    {
                        "channel": "SMS",
                        "timestamp": "2026-04-05T12:00:00Z",
                        "from": "+15559999999",
                        "to": "+15551234567",
                        "message": "Hey Alice!",
                    },
                ],
            },
        )

    if "/api/people" in url:
        return httpx.Response(
            200,
            json={
                "people": [
                    {
                        "firstName": "Bob",
                        "lastName": "Jones",
                        "phoneNumber": "+15559999999",
                        "communicationFrequency": "daily",
                        "messagesExchanged": 42,
                    },
                ],
            },
        )

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
    if hasattr(mod, "_simulation_messages_cache"):
        mod._simulation_messages_cache.clear()


def _get_user_context_module():
    """Return helpers.get_user_context module despite helpers.__init__ re-export shadowing."""
    return importlib.import_module("helpers.get_user_context")


async def test_get_user_context_happy_path():
    """get_user_context activity returns formatted user context string."""
    _setup()
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_context

        result = await get_user_context(user_id="user-test-123")

    assert isinstance(result, str)
    assert "Alice Test" in result
    # Verify sections present
    assert "## Personal Information" in result
    assert "Full Name: Alice Test" in result
    assert "Email: alice@example.com" in result
    assert "## Delivery Address" in result
    assert "Recipient Name: Robin Recipient" in result
    assert "## Distilled User Snapshot" in result
    assert "writing_style" in result
    assert "## Connected Integrations" in result


async def test_get_user_context_uses_cache_on_second_call():
    """Stable context is cached while identity refreshes with stale-on-error safety."""
    settings_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal settings_calls
        if "/api/user-settings" in str(request.url):
            settings_calls += 1
            response = _mock_handler(request)
            payload = response.json()
            if settings_calls == 2:
                payload["name"] = "Andy Updated"
            if settings_calls == 3:
                return httpx.Response(500, json={"error": "temporary settings outage"})
            return httpx.Response(200, json=payload)
        return _mock_handler(request)

    setup_mock_fn(handler)
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_context

        result1 = await get_user_context(user_id="user-cache-1")
        result2 = await get_user_context(user_id="user-cache-1")
        result3 = await get_user_context(user_id="user-cache-1")

    assert "Full Name: Alice Test" in result1
    assert "Full Name: Andy Updated" in result2
    assert "Full Name: Andy Updated" in result3
    assert settings_calls == 3
    captures = get_captured_requests()
    assert sum("/api/integrations" in call["url"] for call in captures) == 1


async def test_get_user_context_cache_hit_times_out_to_stale_profile():
    """A slow identity refresh cannot delay returning an available cached profile."""
    _setup()
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_context

        cached_result = await get_user_context(user_id="user-cache-timeout")

        module = _get_user_context_module()

        async def timeout_wait_for(awaitable, *, timeout):
            assert timeout == module.PROFILE_REFRESH_TIMEOUT_SECONDS
            awaitable.close()
            raise TimeoutError

        with patch.object(module.asyncio, "wait_for", side_effect=timeout_wait_for):
            result = await get_user_context(user_id="user-cache-timeout")

    assert "Full Name: Alice Test" in cached_result
    assert result == cached_result


async def test_get_user_context_ignores_out_of_order_profile_refresh():
    """An older refresh cannot overwrite a newer profile after finishing late."""
    _setup()
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_context

        await get_user_context(user_id="user-cache-generation")
        module = _get_user_context_module()
        older_started = asyncio.Event()
        release_older = asyncio.Event()
        refresh_calls = 0

        async def refresh_profile(_client, _config, _user_id):
            nonlocal refresh_calls
            refresh_calls += 1
            if refresh_calls == 1:
                older_started.set()
                await release_older.wait()
                return {"name": "Older Profile", "deliveryRecipientName": "Older Recipient"}, True
            if refresh_calls == 2:
                return {"name": "Newest Profile", "deliveryRecipientName": "Newest Recipient"}, True
            return {}, False

        with patch.object(module, "_fetch_user_settings_with_status", new=refresh_profile):
            older_task = asyncio.create_task(get_user_context(user_id="user-cache-generation"))
            await older_started.wait()
            newest_result = await get_user_context(user_id="user-cache-generation")
            release_older.set()
            older_result = await older_task
            failed_refresh_result = await get_user_context(user_id="user-cache-generation")

    assert "Full Name: Newest Profile" in newest_result
    assert "Recipient Name: Newest Recipient" in newest_result
    assert "Full Name: Older Profile" in older_result
    assert "Full Name: Newest Profile" in failed_refresh_result
    assert "Recipient Name: Newest Recipient" in failed_refresh_result
    assert "Older Profile" not in failed_refresh_result


async def test_get_system_name():
    """get_user_system_name returns the custom system name."""
    _setup()
    _clear_user_context_cache()
    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_system_name

        result = await get_user_system_name(user_id="user-test-456")

    assert result == "Rosie"


async def test_get_system_name_default_on_error():
    """get_user_system_name returns 'Rose' when backend fails."""

    def handler(req):
        return httpx.Response(500, json={"error": "boom"})

    setup_mock_fn(handler)
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_system_name

        result = await get_user_system_name(user_id="user-err-sn")

    assert result == "Rose"


async def test_get_system_name_outer_except():
    """get_user_system_name's outer except is triggered when load_config raises."""
    _clear_user_context_cache()

    with (
        patch("temporalio.activity.heartbeat"),
        patch.object(_get_user_context_module(), "load_config", side_effect=RuntimeError("cfg fail")),
    ):
        from helpers.get_user_context import get_user_system_name

        result = await get_user_system_name(user_id="user-outer-1")
    assert result == "Rose"


async def test_get_custom_prompt_outer_except():
    """get_user_custom_system_prompt outer except triggered when load_config raises."""
    _clear_user_context_cache()
    with (
        patch("temporalio.activity.heartbeat"),
        patch.object(_get_user_context_module(), "load_config", side_effect=RuntimeError("cfg fail")),
    ):
        from helpers.get_user_context import get_user_custom_system_prompt

        result = await get_user_custom_system_prompt(user_id="user-outer-2")
    assert result is None


async def test_get_user_context_outer_except():
    """get_user_context's outer except returns empty string when load_config raises."""
    _clear_user_context_cache()
    with (
        patch("temporalio.activity.heartbeat"),
        patch.object(_get_user_context_module(), "load_config", side_effect=RuntimeError("cfg fail")),
    ):
        from helpers.get_user_context import get_user_context

        result = await get_user_context(user_id="user-outer-3")
    assert result == ""


async def test_fetch_frequent_contact_messages_outer_except():
    """fetch_frequent_contact_messages outer except when load_config raises."""
    _clear_user_context_cache()
    with patch.object(_get_user_context_module(), "load_config", side_effect=RuntimeError("cfg fail")):
        from helpers.get_user_context import fetch_frequent_contact_messages

        result = await fetch_frequent_contact_messages("user-outer-4")
    assert result == []


async def test_get_system_name_fallback_when_missing():
    """get_user_system_name falls back to 'Rose' when user_settings lacks systemName."""

    def handler(req):
        if "/api/user-settings" in str(req.url):
            return httpx.Response(200, json={"name": "X"})  # no systemName
        return httpx.Response(404)

    setup_mock_fn(handler)
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_system_name

        result = await get_user_system_name(user_id="u-fallback")
    assert result == "Rose"


async def test_get_custom_prompt():
    """get_user_custom_system_prompt returns the custom prompt string."""
    _setup()
    _clear_user_context_cache()
    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_custom_system_prompt

        result = await get_user_custom_system_prompt(user_id="user-test-789")

    assert result == "Always be polite."


async def test_get_custom_prompt_none_on_error():
    """get_user_custom_system_prompt returns None on error."""

    def handler(req):
        return httpx.Response(500)

    setup_mock_fn(handler)
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_custom_system_prompt

        result = await get_user_custom_system_prompt(user_id="user-err-cp")

    assert result is None


async def test_get_custom_prompt_missing():
    """get_user_custom_system_prompt returns None when customSystemPrompt absent."""

    def handler(req):
        if "/api/user-settings" in str(req.url):
            return httpx.Response(200, json={"name": "X"})
        return httpx.Response(404)

    setup_mock_fn(handler)
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_custom_system_prompt

        assert await get_user_custom_system_prompt(user_id="u-nocust") is None


async def test_get_user_context_boundary():
    """Verify outbound HTTP calls hit the expected backend endpoints."""
    _setup()
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_context

        await get_user_context(user_id="user-boundary-001")

    captures = get_captured_requests()
    urls = [c["url"] for c in captures]

    # All backend endpoints for dynamic user context should have been called.
    assert any("/api/user-settings" in u for u in urls), f"Expected /api/user-settings call, got {urls}"
    assert any("/api/integrations" in u for u in urls), f"Expected /api/integrations call, got {urls}"
    assert any("/api/data/snapshot" in u for u in urls), f"Expected /api/data/snapshot call, got {urls}"
    assert any("/api/people/messages/recent" in u for u in urls), (
        f"Expected /api/people/messages/recent call, got {urls}"
    )
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
                "user_snapshot": False,
            },
        )

    assert result == ""
    assert len(get_captured_requests()) == 0


async def test_get_user_context_partial_gates():
    """When only some gates are open, only relevant endpoints are hit."""
    _setup()
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_context

        result = await get_user_context(
            user_id="user-partial-1",
            context_gates={
                "user_profile": True,
                "authenticated_sessions": False,
                "integrations": False,
                "recent_communications": False,
                "network": False,
            },
        )

    # User profile present
    assert "## Personal Information" in result
    # Other sections should NOT be present
    assert "## Connected Integrations" not in result
    assert "## Authenticated Browser Sessions" not in result


async def test_get_user_context_error_returns_empty():
    """When all backend calls error out, get_user_context still returns a string (possibly empty)."""

    def handler(req):
        raise RuntimeError("network down")

    setup_mock_fn(handler)
    _clear_user_context_cache()

    with patch("temporalio.activity.heartbeat"):
        from helpers.get_user_context import get_user_context

        result = await get_user_context(user_id="user-all-err")

    # The internal fetchers catch their own exceptions and return empty, so format returns ""
    assert result == ""


async def test_fetch_frequent_contact_messages_happy():
    """fetch_frequent_contact_messages returns messages via API."""

    def handler(req):
        if "/api/people/messages/recent" in str(req.url):
            return httpx.Response(
                200,
                json={
                    "messages": [
                        {
                            "channel": "SMS",
                            "timestamp": "2026-04-05T12:00:00Z",
                            "from": "me",
                            "to": "you",
                            "message": "yo",
                        },
                    ]
                },
            )
        return httpx.Response(404)

    setup_mock_fn(handler)
    _clear_user_context_cache()

    from helpers.get_user_context import fetch_frequent_contact_messages

    result = await fetch_frequent_contact_messages("user-sim-1")
    assert len(result) == 1


async def test_fetch_frequent_contact_messages_cache_hit():
    """Second call within TTL returns cached messages."""

    def handler(req):
        if "/api/people/messages/recent" in str(req.url):
            return httpx.Response(
                200, json={"messages": [{"channel": "SMS", "timestamp": "2026-04-05T12:00:00Z", "message": "yo"}]}
            )
        return httpx.Response(404)

    setup_mock_fn(handler)
    _clear_user_context_cache()

    from helpers.get_user_context import fetch_frequent_contact_messages

    await fetch_frequent_contact_messages("user-sim-cache")

    # Second call should use cache — if we tear down mock it still works
    teardown_mock()
    result = await fetch_frequent_contact_messages("user-sim-cache")
    assert len(result) == 1


async def test_fetch_frequent_contact_messages_error():
    """fetch_frequent_contact_messages returns empty list on error."""

    def handler(req):
        return httpx.Response(500, json={"error": "boom"})

    setup_mock_fn(handler)
    _clear_user_context_cache()

    from helpers.get_user_context import fetch_frequent_contact_messages

    result = await fetch_frequent_contact_messages("user-sim-err")
    assert result == []


def test_format_messages_for_simulation_empty():
    """format_messages_for_simulation returns empty string for empty input."""
    from helpers.get_user_context import format_messages_for_simulation

    assert format_messages_for_simulation([]) == ""


def test_format_messages_for_simulation_happy():
    """format_messages_for_simulation builds example conversations."""
    from helpers.get_user_context import format_messages_for_simulation

    messages = [
        {"channel": "SMS", "timestamp": "2026-04-05T12:00:00Z", "from": "user", "to": "friend", "message": "hey"},
        {"channel": "EMAIL", "timestamp": "2026-04-05T13:00:00Z", "from": "", "to": "user", "message": "hi"},
        {"channel": "SMS", "timestamp": "bad-ts", "from": "user", "to": "x", "message": ""},  # skipped: empty message
        {"channel": "SMS", "timestamp": "bad-ts", "from": "user", "to": "x", "message": "x" * 600},  # truncated
    ]
    result = format_messages_for_simulation(messages)

    # Should include the first two, skip empty, truncate long
    assert "SENT" in result
    assert "RECEIVED" in result
    assert "..." in result  # truncation marker


def test_format_user_context_empty_returns_empty():
    """_format_user_context returns empty when nothing to show."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=[],
        user_settings={},
        recent_messages=[],
        frequent_contacts=[],
        integrations=None,
    )
    assert result == ""


def test_format_user_context_integration_no_creds():
    """_format_user_context includes integration with no creds when CONNECTED."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=[],
        user_settings={},
        recent_messages=[],
        frequent_contacts=[],
        integrations=[
            {"name": "Calendar", "status": "CONNECTED", "emailCredentials": []},
        ],
    )
    assert "Calendar" in result
    assert "## Connected Integrations" in result


def test_format_user_context_snapshot():
    """_format_user_context includes distilled snapshot content and latest update."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=[],
        user_settings={},
        recent_messages=[],
        frequent_contacts=[],
        integrations=None,
        user_snapshot={
            "content": {"preferences": {"tone": "direct"}},
            "version": 2,
            "updatedAt": "2026-07-03T12:00:00Z",
            "revisions": [{"source": "obsidian", "createdAt": "2026-07-03T12:01:00Z"}],
        },
    )
    assert "## Distilled User Snapshot" in result
    assert '"tone": "direct"' in result
    assert "Latest update" in result


def test_format_user_context_skips_disconnected_no_creds():
    """Integrations not CONNECTED and without creds are skipped."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=[],
        user_settings={},
        recent_messages=[],
        frequent_contacts=[],
        integrations=[
            {"name": "Slack", "status": "DISCONNECTED", "emailCredentials": []},
        ],
    )
    # Nothing present (all else empty, integration skipped)
    assert result == ""


def test_format_user_context_sync_failed_uses_config_connected_emails():
    """SYNC_FAILED Gmail still lists send-from addresses from config.connectedEmails."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=[],
        user_settings={},
        recent_messages=[],
        frequent_contacts=[],
        integrations=[
            {
                "name": "gmail",
                "status": "SYNC_FAILED",
                "emailCredentials": None,
                "config": {
                    "connectedEmail": "a@roselabs.ai",
                    "connectedEmails": ["a@roselabs.ai", "andyprevalsky111@gmail.com"],
                },
            },
        ],
    )
    assert "## Connected Integrations" in result
    assert "gmail: a@roselabs.ai, andyprevalsky111@gmail.com" in result


def test_format_user_context_null_email_credentials_does_not_raise():
    """Null emailCredentials must not abort the whole user-context format path."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=["amazon.com"],
        user_settings={},
        recent_messages=[],
        frequent_contacts=[],
        integrations=[
            {"name": "gmail", "status": "SYNC_FAILED", "emailCredentials": None},
            {"name": "imessage", "status": "CONNECTED", "emailCredentials": None},
        ],
    )
    assert "## Authenticated Browser Sessions" in result
    assert "imessage" in result
    assert "gmail" not in result


def test_format_user_context_malformed_email_credentials_does_not_raise():
    """Non-list containers and non-string emails must not abort formatting."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=[],
        user_settings={},
        recent_messages=[],
        frequent_contacts=[],
        integrations=[
            {"name": "gmail", "status": "CONNECTED", "emailCredentials": 1},
            {
                "name": "yahoo",
                "status": "CONNECTED",
                "emailCredentials": [{"email": 123}, {"email": "ok@example.com"}, "skip"],
            },
        ],
    )
    assert "## Connected Integrations" in result
    assert "yahoo: ok@example.com" in result
    assert "gmail" in result


def test_format_user_context_bad_timestamp():
    """Bad timestamp is handled gracefully."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=[],
        user_settings={},
        recent_messages=[
            {"channel": "SMS", "timestamp": "not-a-timestamp", "from": "a", "to": "b", "message": "hi"},
        ],
        frequent_contacts=[],
    )
    assert "## Recent Communications" in result


def test_format_user_context_recent_message_truncation():
    """Long recent messages are truncated with ellipsis."""
    from helpers.get_user_context import _format_user_context

    long_msg = "y" * 400
    result = _format_user_context(
        authenticated_sites=[],
        user_settings={},
        recent_messages=[
            {"channel": "SMS", "timestamp": "2026-04-05T12:00:00Z", "from": "a", "to": "b", "message": long_msg},
        ],
        frequent_contacts=[],
    )
    assert "..." in result


def test_format_user_context_address_variants():
    """Address lines assemble correctly even with partial fields."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=[],
        user_settings={
            "name": "Z",
            "city": "Paris",
            "state": "",
            "postalCode": "",
            "country": "France",
        },
        recent_messages=[],
        frequent_contacts=[],
    )
    assert "Paris" in result
    assert "France" in result
    assert "Delivery Address" in result


def test_format_user_context_separates_personal_identity_from_delivery_recipient():
    """Personal identity never inherits the delivery recipient's name."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=[],
        user_settings={
            "name": "Andy",
            "email": "andy@roselabs.ai",
            "phone": "+19729777432",
            "deliveryRecipientName": "Aman Gottumukkala",
            "addressLine1": "88 Howard St",
            "addressLine2": "Apt 1413",
            "city": "San Francisco",
            "state": "CA",
            "postalCode": "94105",
            "country": "US",
        },
        recent_messages=[],
        frequent_contacts=[],
    )

    assert "## Personal Information" in result
    assert "Full Name: Andy" in result
    assert "Email: andy@roselabs.ai" in result
    assert "Phone: +19729777432" in result
    assert "## Delivery Address" in result
    assert "Recipient Name: Aman Gottumukkala" in result
    assert result.index("Full Name: Andy") < result.index("Recipient Name: Aman Gottumukkala")


def test_format_user_context_recent_msg_to_direction():
    """Message with no 'from' uses 'To:' direction."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=[],
        user_settings={},
        recent_messages=[
            {"channel": "SMS", "timestamp": "2026-04-05T12:00:00Z", "from": "", "to": "b@example.com", "message": "hi"},
        ],
        frequent_contacts=[],
    )
    assert "To:" in result


def test_format_user_context_recent_msg_preserves_timezone():
    """Recent communications retain their offset instead of presenting UTC as local time."""
    from helpers.get_user_context import _format_user_context

    result = _format_user_context(
        authenticated_sites=[],
        user_settings={},
        recent_messages=[
            {
                "channel": "SMS",
                "timestamp": "2026-07-11T13:45:00-07:00",
                "from": "+15555550123",
                "to": "",
                "message": "The local time is 1:45pm",
            },
        ],
        frequent_contacts=[],
    )

    assert "2026-07-11T13:45-07:00" in result


def test_format_user_context_contacts_variants():
    """Network section handles contacts with/without phone/email/relation."""
    from helpers.get_user_context import _format_user_context

    contacts = [
        # Fully-populated
        {
            "firstName": "A",
            "lastName": "B",
            "phoneNumber": "+1",
            "communicationFrequency": "daily",
            "messagesExchanged": 10,
            "relation": "friend",
            "company": "Acme",
            "email": "a@b.com",
        },
        # Phone only, no name
        {"phoneNumber": "+2"},
        # Name only, no phone, with email
        {"firstName": "C", "email": "c@d.com"},
        # No identifier — skipped
        {},
    ]
    result = _format_user_context(
        authenticated_sites=[],
        user_settings={},
        recent_messages=[],
        frequent_contacts=contacts,
    )
    assert "## User Network" in result
    assert "A B" in result
    assert "friend" in result
    assert "Acme" in result
    # Email included only for name-only contact with no phone
    assert "c@d.com" in result
    # Name-and-phone user does NOT include email (phone present)
    assert "a@b.com" not in result


async def test_fetch_integrations_error_returns_empty_lists():
    """_fetch_integrations_and_auth_domains returns ([], []) on 500."""

    def handler(req):
        return httpx.Response(500)

    setup_mock_fn(handler)

    import httpx as _httpx
    from helpers.get_user_context import _fetch_integrations_and_auth_domains
    from config import load_config

    async with _httpx.AsyncClient() as client:
        integs, auths = await _fetch_integrations_and_auth_domains(client, load_config(), "u")
    assert integs == []
    assert auths == []


async def test_fetch_user_settings_error_returns_empty():
    """_fetch_user_settings returns {} on error."""

    def handler(req):
        return httpx.Response(500)

    setup_mock_fn(handler)

    import httpx as _httpx
    from helpers.get_user_context import _fetch_user_settings
    from config import load_config

    async with _httpx.AsyncClient() as client:
        result = await _fetch_user_settings(client, load_config(), "u")
    assert result == {}


async def test_fetch_recent_messages_error_returns_empty():
    """_fetch_recent_messages returns [] on error."""

    def handler(req):
        return httpx.Response(500)

    setup_mock_fn(handler)

    import httpx as _httpx
    from helpers.get_user_context import _fetch_recent_messages
    from config import load_config

    async with _httpx.AsyncClient() as client:
        result = await _fetch_recent_messages(client, load_config(), "u")
    assert result == []


async def test_fetch_top_contacts_error_returns_empty():
    """_fetch_top_contacts returns [] on error."""

    def handler(req):
        return httpx.Response(500)

    setup_mock_fn(handler)

    import httpx as _httpx
    from helpers.get_user_context import _fetch_top_contacts
    from config import load_config

    async with _httpx.AsyncClient() as client:
        result = await _fetch_top_contacts(client, load_config(), "u")
    assert result == []


async def test_fetch_messages_for_simulation_error_returns_empty():
    """_fetch_messages_for_simulation returns [] on error."""

    def handler(req):
        return httpx.Response(500)

    setup_mock_fn(handler)

    import httpx as _httpx
    from helpers.get_user_context import _fetch_messages_for_simulation
    from config import load_config

    async with _httpx.AsyncClient() as client:
        result = await _fetch_messages_for_simulation(client, load_config(), "u")
    assert result == []


def test_normalize_domain():
    """_normalize_domain strips leading dot and www."""
    from helpers.get_user_context import _normalize_domain

    assert _normalize_domain(".example.com") == "example.com"
    assert _normalize_domain("www.example.com") == "example.com"
    assert _normalize_domain(".www.example.com") == "example.com"


def test_get_base_domain():
    """_get_base_domain extracts last 2 labels."""
    from helpers.get_user_context import _get_base_domain

    assert _get_base_domain("mail.google.com") == "google.com"
    assert _get_base_domain("example.com") == "example.com"
    assert _get_base_domain("localhost") == "localhost"


def test_is_false_positive_cookie():
    """_is_false_positive_cookie matches known analytics cookie names."""
    from helpers.get_user_context import _is_false_positive_cookie

    assert _is_false_positive_cookie("_ga") is True
    assert _is_false_positive_cookie("cf_clearance") is True
    assert _is_false_positive_cookie("session_id") is False


def test_is_auth_cookie():
    """_is_auth_cookie detects auth-like cookie names."""
    from helpers.get_user_context import _is_auth_cookie

    assert _is_auth_cookie({"name": "session_id"}) is True
    assert _is_auth_cookie({"name": "auth_token"}) is True
    assert _is_auth_cookie({"name": "jwt"}) is True
    # False positive: has "session" but is in false-positive list
    assert _is_auth_cookie({"name": "_hjSession"}) is False
    # No auth pattern at all
    assert _is_auth_cookie({"name": "lang"}) is False


async def test_readable_inbox_scope_transport_and_formatter():
    from types import SimpleNamespace
    from helpers.get_user_context import _fetch_integrations_and_auth_domains, _format_user_context

    captured = []

    class Client:
        async def get(self, url, **kwargs):
            captured.append((url, kwargs))
            return httpx.Response(200, request=httpx.Request("GET", url), json={
                "integrations": [{"name": "gmail", "status": "CONNECTED", "emailCredentials": [],
                                  "config": {"connectedEmails": ["configured@example.test"]},
                                  "readableInboxEmails": []}],
                "authenticatedDomains": [],
            })

    config = SimpleNamespace(backend=SimpleNamespace(api_url="https://backend.invalid", api_key="offline-unused"))
    integrations, domains = await _fetch_integrations_and_auth_domains(Client(), config, "user-owned")
    assert captured[0][1]["headers"]["X-User-Id"] == "user-owned"
    assert integrations[0]["readableInboxEmails"] == []
    def formatted(rows):
        return _format_user_context([], {}, [], [], integrations=rows)
    result = formatted(integrations)
    assert "gmail" not in result, "an unreadable Gmail is not a connected integration"
    integrations[0]["readableInboxEmails"] = ["readable@example.test"]
    result = formatted(integrations)
    assert "- gmail: readable@example.test" in result, "Gmail lists exactly the readable inboxes"
    assert "configured@example.test" not in result
    del integrations[0]["readableInboxEmails"]
    assert "- gmail: configured@example.test" in formatted(integrations), "legacy absent keeps the configured listing"
    integrations[0]["readableInboxEmails"] = None
    assert "- gmail: configured@example.test" in formatted(integrations)
    assert domains == []


async def run_all_tests():
    print("get-user-context blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_get_user_context_happy_path)
    await r.record_async("uses_cache", test_get_user_context_uses_cache_on_second_call)
    await r.record_async("cache_timeout_uses_stale", test_get_user_context_cache_hit_times_out_to_stale_profile)
    await r.record_async("cache_ignores_out_of_order_refresh", test_get_user_context_ignores_out_of_order_profile_refresh)
    await r.record_async("get_system_name", test_get_system_name)
    await r.record_async("get_system_name_error", test_get_system_name_default_on_error)
    await r.record_async("get_system_name_outer_except", test_get_system_name_outer_except)
    await r.record_async("get_custom_prompt_outer_except", test_get_custom_prompt_outer_except)
    await r.record_async("get_user_context_outer_except", test_get_user_context_outer_except)
    await r.record_async("fetch_freq_outer_except", test_fetch_frequent_contact_messages_outer_except)
    await r.record_async("get_system_name_fallback", test_get_system_name_fallback_when_missing)
    await r.record_async("get_custom_prompt", test_get_custom_prompt)
    await r.record_async("get_custom_prompt_error", test_get_custom_prompt_none_on_error)
    await r.record_async("get_custom_prompt_missing", test_get_custom_prompt_missing)
    await r.record_async("boundary", test_get_user_context_boundary)
    await r.record_async("gates_closed", test_get_user_context_gates_closed)
    await r.record_async("partial_gates", test_get_user_context_partial_gates)
    await r.record_async("error_returns_empty", test_get_user_context_error_returns_empty)
    await r.record_async("fetch_freq_happy", test_fetch_frequent_contact_messages_happy)
    await r.record_async("fetch_freq_cache", test_fetch_frequent_contact_messages_cache_hit)
    await r.record_async("fetch_freq_error", test_fetch_frequent_contact_messages_error)
    r.record("format_sim_empty", test_format_messages_for_simulation_empty)
    r.record("format_sim_happy", test_format_messages_for_simulation_happy)
    r.record("fmt_ctx_empty", test_format_user_context_empty_returns_empty)
    r.record("fmt_ctx_integ_no_creds", test_format_user_context_integration_no_creds)
    r.record("fmt_ctx_snapshot", test_format_user_context_snapshot)
    r.record("fmt_ctx_skips_disconnected", test_format_user_context_skips_disconnected_no_creds)
    r.record(
        "fmt_ctx_sync_failed_config_emails",
        test_format_user_context_sync_failed_uses_config_connected_emails,
    )
    r.record(
        "fmt_ctx_null_email_credentials",
        test_format_user_context_null_email_credentials_does_not_raise,
    )
    r.record(
        "fmt_ctx_malformed_email_credentials",
        test_format_user_context_malformed_email_credentials_does_not_raise,
    )
    r.record("fmt_ctx_bad_ts", test_format_user_context_bad_timestamp)
    r.record("fmt_ctx_msg_truncate", test_format_user_context_recent_message_truncation)
    r.record("fmt_ctx_address", test_format_user_context_address_variants)
    r.record(
        "fmt_ctx_identity_delivery_split",
        test_format_user_context_separates_personal_identity_from_delivery_recipient,
    )
    r.record("fmt_ctx_to_direction", test_format_user_context_recent_msg_to_direction)
    r.record("fmt_ctx_timezone", test_format_user_context_recent_msg_preserves_timezone)
    r.record("fmt_ctx_contacts", test_format_user_context_contacts_variants)
    await r.record_async("fetch_integrations_err", test_fetch_integrations_error_returns_empty_lists)
    await r.record_async("fetch_settings_err", test_fetch_user_settings_error_returns_empty)
    await r.record_async("fetch_recent_err", test_fetch_recent_messages_error_returns_empty)
    await r.record_async("fetch_top_contacts_err", test_fetch_top_contacts_error_returns_empty)
    await r.record_async("fetch_sim_err", test_fetch_messages_for_simulation_error_returns_empty)
    r.record("normalize_domain", test_normalize_domain)
    r.record("get_base_domain", test_get_base_domain)
    r.record("is_false_positive_cookie", test_is_false_positive_cookie)
    r.record("is_auth_cookie", test_is_auth_cookie)
    await r.record_async("readable_inbox_scope_transport_formatter", test_readable_inbox_scope_transport_and_formatter)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
