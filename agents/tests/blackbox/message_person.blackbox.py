"""Blackbox tests for message-person domain."""

import asyncio
import json
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "/api/people/messages/recent": {
            "status": 200,
            "json": {
                "messages": [
                    {"text": "Hey, how's the project going?", "person": "Alice", "timestamp": "2026-04-01T10:00:00Z"},
                    {"text": "Let's sync tomorrow", "person": "Bob", "timestamp": "2026-04-01T09:00:00Z"},
                ],
                "count": 2,
            },
        },
    })


async def test_fetch_recent_messages_happy_path():
    """fetch_recent_messages_activity returns messages from backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.message_person import fetch_recent_messages_activity

        result = await fetch_recent_messages_activity(
            user_id="user-42",
            limit=50,
            days=30,
        )

    assert result["count"] == 2
    assert len(result["messages"]) == 2
    assert result["messages"][0]["person"] == "Alice"


async def test_fetch_recent_messages_boundary():
    """Verify exact HTTP request sent to backend messages endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.message_person import fetch_recent_messages_activity

        await fetch_recent_messages_activity(
            user_id="user-99",
            limit=100,
            days=7,
        )

    call = assert_captured_call(
        url_contains="/api/people/messages/recent",
        method="GET",
        header_present="X-API-Key",
    )
    headers_lower = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "x-user-id" in headers_lower
    # Query params are in the URL
    assert "limit=100" in call["url"]
    assert "days=7" in call["url"]


async def test_no_httpx_from_generate_message():
    """generate_message_activity uses call_llm, not raw httpx — zero captured calls."""
    _setup()
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.llm.call_llm") as mock_llm,
    ):
        mock_llm.return_value = {
            "content": "Hey! Great to connect.",
            "usage": {"input_tokens": 100, "output_tokens": 20},
        }
        from tools.message_person import generate_message_activity

        result = await generate_message_activity(
            model="rose-1-lite",
            system_name="Navi",
            conversation_context="User asked to message Alice",
            person_name="Alice",
            messages_context="Recent thread with Alice",
            exa_context="",
            intent="Follow up on project",
            channel="sms",
        )

    assert "message" in result
    # call_llm doesn't use httpx, so no captured calls from it
    captures = get_captured_requests()
    assert len(captures) == 0


async def run_all_tests():
    print("message-person blackbox tests:")
    r = BlackboxResult()
    await r.record_async("fetch_recent_messages_happy_path", test_fetch_recent_messages_happy_path)
    await r.record_async("fetch_recent_messages_boundary", test_fetch_recent_messages_boundary)
    await r.record_async("no_httpx_from_generate_message", test_no_httpx_from_generate_message)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
