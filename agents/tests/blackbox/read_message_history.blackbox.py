"""Blackbox tests for read-message-history domain."""

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
        "/api/people/messages": {
            "status": 200,
            "json": {
                "person": {
                    "id": "person-1",
                    "firstName": "Alice",
                    "lastName": "Smith",
                    "phoneNumber": "+15551234567",
                    "email": "alice@example.com",
                },
                "messages": [
                    {"text": "Hey!", "direction": "inbound", "timestamp": "2026-04-01T10:00:00Z"},
                    {"text": "Hi there!", "direction": "outbound", "timestamp": "2026-04-01T10:01:00Z"},
                ],
                "count": 2,
            },
        },
    })


async def test_read_message_history_happy_path():
    """read_message_history_activity returns person info and messages."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.read_message_history import read_message_history_activity

        result = await read_message_history_activity(
            user_id="user-42",
            phone="+15551234567",
        )

    assert result["person"]["firstName"] == "Alice"
    assert result["count"] == 2
    assert len(result["messages"]) == 2


async def test_read_message_history_boundary():
    """Verify exact HTTP request sent to backend messages endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.read_message_history import read_message_history_activity

        await read_message_history_activity(
            user_id="user-99",
            email="bob@example.com",
            first_name="Bob",
            last_name="Jones",
            message_limit=25,
        )

    call = assert_captured_call(
        url_contains="/api/people/messages",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["user_id"] == "user-99"
    assert body["email"] == "bob@example.com"
    assert body["firstName"] == "Bob"
    assert body["lastName"] == "Jones"
    assert body["message_limit"] == 25


async def test_read_message_history_phone_only():
    """Activity works with phone number as only identifier."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.read_message_history import read_message_history_activity

        result = await read_message_history_activity(
            user_id="user-42",
            phone="+15559876543",
        )

    assert result["person"] is not None
    call = assert_captured_call(
        url_contains="/api/people/messages",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["phone"] == "+15559876543"
    assert "email" not in body or body.get("email") is None


async def run_all_tests():
    print("read-message-history blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_read_message_history_happy_path)
    await r.record_async("boundary", test_read_message_history_boundary)
    await r.record_async("phone_only", test_read_message_history_phone_only)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
