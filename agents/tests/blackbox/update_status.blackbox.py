"""Blackbox tests for update-status domain."""

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
        "/status": {
            "status": 200,
            "json": {"success": True},
        },
    })


async def test_happy_path():
    """update_agent_status sends PATCH to /api/agents/{id}/status."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.update_status import update_agent_status

        await update_agent_status(
            agent_id="agent-1",
            status="ACTIVE",
            progress=0.5,
            status_message="Processing",
            token_count=1000,
            context_size=5000,
            message_count=10,
            tokens_in=600,
            tokens_out=400,
        )

    call = assert_captured_call(
        url_contains="/api/agents/agent-1/status",
        method="PATCH",
        header_present="X-API-Key",
    )


async def test_boundary():
    """Verify PATCH body contains status, progress, tokenCount, contextSize fields."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.update_status import update_agent_status

        await update_agent_status(
            agent_id="agent-2",
            status="COMPLETED",
            progress=1.0,
            status_message="Done",
            token_count=2000,
            context_size=8000,
            message_count=20,
            tokens_in=1200,
            tokens_out=800,
        )

    call = assert_captured_call(
        url_contains="/api/agents/agent-2/status",
        method="PATCH",
    )
    body = json.loads(call["requestBody"])
    assert body["status"] == "COMPLETED"
    assert body["progress"] == 1.0
    assert body["statusMessage"] == "Done"
    assert body["tokenCount"] == 2000
    assert body["contextSize"] == 8000
    assert body["messageCount"] == 20
    assert body["tokensIn"] == 1200
    assert body["tokensOut"] == 800


async def run_all_tests():
    print("update-status blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_happy_path)
    await r.record_async("boundary", test_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
