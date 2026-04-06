"""Blackbox tests for send-sms-as-user domain."""

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
        "/api/imessage/queue": {
            "status": 200,
            "json": {"success": True, "queued": True, "id": "imsg-456"},
        },
    })


async def test_queue_imessage_happy_path():
    """queue_imessage_activity queues an iMessage via backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_sms_as_user import queue_imessage_activity

        result = await queue_imessage_activity(
            user_id="user-42",
            agent_id="agent-1",
            phone_number="+15551234567",
            message="Hey Alice, following up on our chat.",
        )

    assert result.get("success") is True or result.get("queued") is True


async def test_queue_imessage_boundary():
    """Verify exact HTTP request sent to backend iMessage queue endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.send_sms_as_user import queue_imessage_activity

        await queue_imessage_activity(
            user_id="user-99",
            agent_id="agent-2",
            phone_number="+15559876543",
            message="Test iMessage content",
        )

    call = assert_captured_call(
        url_contains="/api/imessage/queue",
        method="POST",
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["user_id"] == "user-99"
    assert body["agent_id"] == "agent-2"
    assert body["phone_number"] == "+15559876543"
    assert body["message"] == "Test iMessage content"


async def run_all_tests():
    print("send-sms-as-user blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_queue_imessage_happy_path)
    await r.record_async("boundary", test_queue_imessage_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
