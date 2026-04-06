"""Blackbox tests for send-sms domain."""

import asyncio
import json
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "/api/send-sms": {
            "status": 200,
            "json": {"success": True, "messageId": "sms-123"},
        },
    })


async def test_send_sms_happy_path():
    """send_sms_activity sends SMS via backend and returns result."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_sms import send_sms_activity

        result = await send_sms_activity(
            phone_number="+15551234567",
            message="Hello from Navi!",
        )

    assert result.get("success") is True or result.get("messageId") == "sms-123"


async def test_send_sms_boundary():
    """Verify exact HTTP request sent to backend SMS endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_sms import send_sms_activity

        await send_sms_activity(
            phone_number="+15559876543",
            message="Test message content",
        )

    call = assert_captured_call(
        url_contains="/api/send-sms",
        method="POST",
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["phone_number"] == "+15559876543"
    assert body["message"] == "Test message content"


async def run_all_tests():
    print("send-sms blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_send_sms_happy_path)
    await r.record_async("boundary", test_send_sms_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
