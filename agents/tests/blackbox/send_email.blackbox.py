"""Blackbox tests for send-email domain."""

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
        "/api/integrations/email/send": {
            "status": 200,
            "json": {
                "messageId": "msg-email-123",
                "threadId": "thread-456",
            },
        },
    })


async def test_send_email_happy_path():
    """send_email_activity returns messageId and threadId."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_email import send_email_activity

        result = await send_email_activity(
            user_id="user-42",
            to="alice@example.com",
            subject="Project Update",
            body="Hi Alice, here's the latest update...",
        )

    assert result["messageId"] == "msg-email-123"
    assert result["threadId"] == "thread-456"


async def test_send_email_boundary():
    """Verify exact HTTP request sent to backend email endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_email import send_email_activity

        await send_email_activity(
            user_id="user-99",
            to="bob@example.com",
            subject="Meeting Tomorrow",
            body="Let's sync at 2pm.",
            cc="charlie@example.com",
            from_email="user@custom.com",
        )

    call = assert_captured_call(
        url_contains="/api/integrations/email/send",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["user_id"] == "user-99"
    assert body["to"] == "bob@example.com"
    assert body["subject"] == "Meeting Tomorrow"
    assert body["body"] == "Let's sync at 2pm."
    assert body["cc"] == "charlie@example.com"
    assert body["from_email"] == "user@custom.com"


async def test_send_email_minimal_params():
    """Activity works with only required params (no cc or from_email)."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_email import send_email_activity

        result = await send_email_activity(
            user_id="user-1",
            to="test@example.com",
            subject="Test",
            body="Test body",
        )

    assert result["messageId"] == "msg-email-123"
    call = assert_captured_call(url_contains="/api/integrations/email/send", method="POST")
    body = json.loads(call["requestBody"])
    assert body["to"] == "test@example.com"


async def run_all_tests():
    print("send-email blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_send_email_happy_path)
    await r.record_async("boundary", test_send_email_boundary)
    await r.record_async("minimal_params", test_send_email_minimal_params)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
