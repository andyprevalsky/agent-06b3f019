"""Blackbox tests for finished domain."""

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
            "json": {"ok": True},
        },
    })


async def test_mark_finished_happy_path():
    """mark_finished updates agent status to COMPLETED and returns result dict."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.finished import mark_finished

        result = await mark_finished(
            agent_id="agent-fin-1",
            steps_taken=[
                {"role": "USER", "text": "Find AI companies"},
                {"role": "TOOL", "text": "web_search done"},
            ],
            token_count=1500,
            context_size=3000,
            message_count=5,
            tokens_in=1000,
            tokens_out=500,
            summary="Found 3 AI companies.",
        )

    assert result["agent_id"] == "agent-fin-1"
    assert result["goal"] == "Find AI companies"
    assert result["steps_count"] == 2
    assert result["summary"] == "Found 3 AI companies."
    assert "completed_at" in result


async def test_mark_finished_boundary():
    """Verify PATCH sent to /api/agents/{id}/status with correct body."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.finished import mark_finished

        await mark_finished(
            agent_id="agent-fin-2",
            steps_taken=[
                {"role": "USER", "text": "Send an email to Bob"},
            ],
            token_count=800,
            context_size=1500,
            message_count=3,
            tokens_in=600,
            tokens_out=200,
        )

    call = assert_captured_call(
        url_contains="/api/agents/agent-fin-2/status",
        method="PATCH",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["status"] == "COMPLETED"
    assert body["progress"] == 1.0
    assert body["tokenCount"] == 800
    assert body["tokensIn"] == 600
    assert body["tokensOut"] == 200
    assert body["contextSize"] == 1500
    assert body["messageCount"] == 3
    assert "Send an email to Bob" in body["statusMessage"]


async def test_mark_finished_with_structured_response():
    """Verify structured_response is included in PATCH body when provided."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.finished import mark_finished

        await mark_finished(
            agent_id="agent-fin-3",
            steps_taken=[
                {"role": "USER", "text": "Extract contact info"},
            ],
            token_count=500,
            context_size=1000,
            message_count=2,
            structured_response={"name": "Alice", "email": "alice@example.com"},
        )

    call = assert_captured_call(
        url_contains="/api/agents/agent-fin-3/status",
        method="PATCH",
    )
    body = json.loads(call["requestBody"])
    assert body["structuredResponse"] == {"name": "Alice", "email": "alice@example.com"}


async def run_all_tests():
    print("finished blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_mark_finished_happy_path)
    await r.record_async("boundary", test_mark_finished_boundary)
    await r.record_async("structured_response", test_mark_finished_with_structured_response)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
