"""Blackbox tests for request-user-approval domain."""

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
        "/api/attention-requests": {
            "status": 200,
            "json": {"id": "req-abc123", "status": "pending"},
        },
    })


async def test_create_approval_happy_path():
    """create_approval_request_activity returns the request ID."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.request_user_approval import create_approval_request_activity

        result = await create_approval_request_activity(
            user_id="user-42",
            agent_id="agent-1",
            workflow_id="wf-123",
            question="Do you approve sending this email?",
        )

    assert result == "req-abc123"


async def test_create_approval_boundary():
    """Verify exact HTTP request sent to backend attention-requests endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.request_user_approval import create_approval_request_activity

        await create_approval_request_activity(
            user_id="user-99",
            agent_id="agent-2",
            workflow_id="wf-456",
            question="Approve this action?",
            image_url="https://example.com/screenshot.png",
            metadata={"writePermission": True},
        )

    call = assert_captured_call(
        url_contains="/api/attention-requests",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["userId"] == "user-99"
    assert body["agentId"] == "agent-2"
    assert body["workflowId"] == "wf-456"
    assert body["question"] == "Approve this action?"
    assert body["imageUrl"] == "https://example.com/screenshot.png"
    assert body["metadata"]["writePermission"] is True


async def test_create_approval_minimal_params():
    """Activity works with only required params (no image_url or metadata)."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.request_user_approval import create_approval_request_activity

        result = await create_approval_request_activity(
            user_id="user-1",
            agent_id="agent-1",
            workflow_id="wf-1",
            question="Proceed?",
        )

    assert result == "req-abc123"
    call = assert_captured_call(url_contains="/api/attention-requests", method="POST")
    body = json.loads(call["requestBody"])
    assert "imageUrl" not in body
    assert "metadata" not in body


async def run_all_tests():
    print("request-user-approval blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_create_approval_happy_path)
    await r.record_async("boundary", test_create_approval_boundary)
    await r.record_async("minimal_params", test_create_approval_minimal_params)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
