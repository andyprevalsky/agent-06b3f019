"""Blackbox tests for sms-activities domain."""

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
        "/api/agents/": {
            "status": 200,
            "json": {
                "agent": {"id": "agent-1", "source": "SMS"},
                "messages": [],
            },
        },
        "/api/send-sms/direct": {
            "status": 200,
            "json": {"success": True},
        },
        "/api/send-sms/notify": {
            "status": 200,
            "json": {"success": True},
        },
    })


async def test_get_source_happy_path():
    """get_agent_source returns the agent source string."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.sms_activities import get_agent_source

        result = await get_agent_source("agent-1")

    assert result == "SMS"
    assert_captured_call(
        url_contains="/api/agents/agent-1",
        method="GET",
        header_present="X-API-Key",
    )


async def test_send_direct_sms():
    """send_direct_sms_activity sends POST to /api/send-sms/direct."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.sms_activities import send_direct_sms_activity

        result = await send_direct_sms_activity(
            user_id="user-42",
            message="Your agent completed!",
        )

    assert result["success"] is True
    call = assert_captured_call(
        url_contains="/api/send-sms/direct",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["user_id"] == "user-42"
    assert body["message"] == "Your agent completed!"


async def test_notify_event():
    """notify_sms_event_activity sends POST to /api/send-sms/notify."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.sms_activities import notify_sms_event_activity

        result = await notify_sms_event_activity(
            user_id="user-99",
            event_type="agent_started",
            agent_id="agent-5",
            payload={"goal": "Research AI trends"},
        )

    assert result["success"] is True
    call = assert_captured_call(
        url_contains="/api/send-sms/notify",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["user_id"] == "user-99"
    assert body["event_type"] == "agent_started"
    assert body["agent_id"] == "agent-5"
    assert body["payload"]["goal"] == "Research AI trends"


async def run_all_tests():
    print("sms-activities blackbox tests:")
    r = BlackboxResult()
    await r.record_async("get_source_happy_path", test_get_source_happy_path)
    await r.record_async("send_direct_sms", test_send_direct_sms)
    await r.record_async("notify_event", test_notify_event)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
