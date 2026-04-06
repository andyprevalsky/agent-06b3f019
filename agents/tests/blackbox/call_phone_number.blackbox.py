"""Blackbox tests for call-phone-number domain."""

import asyncio
import json
from unittest.mock import patch, AsyncMock

import httpx

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock_fn,
    teardown_mock,
)


def _mock_handler(request: httpx.Request) -> httpx.Response:
    url = str(request.url)

    if "/api/vapi/call" in url and request.method == "POST" and "/call/" not in url.split("/api/vapi/call")[1]:
        return httpx.Response(200, json={"call_id": "call-test-123"})

    if "/api/vapi/call/call-test-123" in url and request.method == "GET":
        return httpx.Response(200, json={
            "status": "ended",
            "analysis": {
                "summary": "Called and discussed project details",
                "structuredData": {"sentiment": "positive"},
            },
            "transcript": "Hello, this is a test call.",
            "endedReason": "hangup",
            "recordingUrl": "https://recordings.test/abc.mp3",
            "startedAt": "2026-01-01T00:00:00Z",
            "endedAt": "2026-01-01T00:02:30Z",
        })

    # Catch-all for messages endpoint and other calls
    if "/api/agents/" in url and "/messages" in url:
        return httpx.Response(200, json={"id": "msg-1"})

    return httpx.Response(404)


async def _noop_sleep(_seconds):
    """Instant replacement for asyncio.sleep in tests."""
    pass


async def test_initiation_boundary():
    """Verify the call initiation POST sends correct params to backend."""
    setup_mock_fn(_mock_handler)

    with (
        patch("temporalio.activity.heartbeat"),
        patch("tools.call_phone_number.save_phone_call_message", new_callable=AsyncMock),
        patch("tools.call_phone_number.asyncio.sleep", side_effect=_noop_sleep),
    ):
        from tools.call_phone_number import call_phone_number_activity

        result = await call_phone_number_activity(
            to="+15551234567",
            system_prompt="You are a helpful assistant",
            output_schema={"type": "object", "properties": {"sentiment": {"type": "string"}}},
            agent_id="agent-1",
            tool_call_id="tc-1",
            user_id="user-1",
        )

    captures = get_captured_requests()
    # First capture is the POST to initiate the call
    initiation = captures[0]
    assert "/api/vapi/call" in initiation["url"]
    assert initiation["method"] == "POST"
    body = json.loads(initiation["requestBody"])
    assert body["to"] == "+15551234567"
    assert body["system_prompt"] == "You are a helpful assistant"
    assert "properties" in body["output_schema"]

    assert result["success"] is True
    assert result["call_id"] == "call-test-123"


async def test_poll_boundary():
    """Verify the status polling GET hits the correct URL."""
    setup_mock_fn(_mock_handler)

    with (
        patch("temporalio.activity.heartbeat"),
        patch("tools.call_phone_number.save_phone_call_message", new_callable=AsyncMock),
        patch("tools.call_phone_number.asyncio.sleep", side_effect=_noop_sleep),
    ):
        from tools.call_phone_number import call_phone_number_activity

        await call_phone_number_activity(
            to="+15559876543",
            system_prompt="Test",
            output_schema={},
            agent_id="a-1",
            tool_call_id="tc-1",
        )

    captures = get_captured_requests()
    # Should have at least 2 captures: POST init + GET poll
    assert len(captures) >= 2
    poll = captures[1]
    assert "/api/vapi/call/call-test-123" in poll["url"]
    assert poll["method"] == "GET"


async def run_all_tests():
    print("call-phone-number blackbox tests:")
    r = BlackboxResult()
    await r.record_async("initiation_boundary", test_initiation_boundary)
    await r.record_async("poll_boundary", test_poll_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
