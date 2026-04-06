"""Blackbox tests for messages domain."""

import asyncio
import json
from datetime import datetime, timezone
from unittest.mock import patch

import httpx

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock_fn,
    teardown_mock,
)


def _mock_handler(request: httpx.Request) -> httpx.Response:
    """Route multiple endpoints used by messages helpers."""
    url = str(request.url)
    method = request.method

    # POST /api/agents/{id}/messages
    if "/messages" in url and method == "POST":
        return httpx.Response(201, json={
            "message_id": "msg-created-1",
            "role": "ASSISTANT",
            "message": "test message",
            "timestamp": "2026-04-05T12:00:00Z",
        })

    # GET /api/agents/{id} (used by poll_new_messages via _fetch_agent_data_impl)
    if "/api/agents/" in url and method == "GET":
        return httpx.Response(200, json={
            "agent": {"id": "agent-test-1", "status": "ACTIVE"},
            "messages": [
                {
                    "role": "USER",
                    "message": "Hello",
                    "timestamp": "2026-04-05T12:00:00Z",
                    "metadata": {},
                },
                {
                    "role": "ASSISTANT",
                    "message": "Hi there!",
                    "timestamp": "2026-04-05T12:01:00Z",
                    "metadata": {},
                },
            ],
        })

    # PATCH /api/agents/{id} (used by update_agent_tree_state)
    if "/api/agents/" in url and method == "PATCH":
        return httpx.Response(200, json={"ok": True})

    # POST to Supabase Realtime broadcast (used by update_agent_tree_state)
    if "/realtime/v1/api/broadcast" in url:
        return httpx.Response(200, json={})

    return httpx.Response(404, json={"error": f"No mock for {method} {url}"})


def _setup():
    setup_mock_fn(_mock_handler)


async def test_post_message_happy_path():
    """post_agent_message posts a message and returns created data."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import post_agent_message

        result = await post_agent_message(
            agent_id="agent-test-1",
            text="Hello from agent",
            role="ASSISTANT",
            metadata={"toolName": "web_search"},
        )

    assert result["message_id"] == "msg-created-1"


async def test_post_message_boundary():
    """Verify POST body contains role, message, and metadata."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import post_agent_message

        await post_agent_message(
            agent_id="agent-boundary-1",
            text="Boundary test message",
            role="TOOL",
            metadata={"toolName": "enrich", "toolStatus": "FINISHED"},
        )

    call = assert_captured_call(
        url_contains="/messages",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["role"] == "TOOL"
    assert body["message"] == "Boundary test message"
    assert body["metadata"]["toolName"] == "enrich"


async def test_poll_messages_happy_path():
    """poll_new_messages returns messages after the given timestamp."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import poll_new_messages

        # Use epoch as last_checked to get all messages
        epoch = datetime(2020, 1, 1, tzinfo=timezone.utc)
        result = await poll_new_messages(
            agent_id="agent-test-1",
            last_checked=epoch,
        )

    assert isinstance(result, list)
    assert len(result) == 2
    assert result[0]["role"] == "USER"


async def test_update_agent_tree_state_happy_path():
    """update_agent_tree_state PATCHes the agent and broadcasts to bus."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import update_agent_tree_state

        await update_agent_tree_state(
            agent_id="agent-tree-1",
            tools_in_use=["web_search", "enrich"],
            bus_id="bus-root-1",
            broadcast_payload={
                "agentId": "agent-tree-1",
                "toolsInUse": ["web_search", "enrich"],
                "status": "ACTIVE",
                "progress": 0.5,
            },
        )

    captures = get_captured_requests()
    urls = [c["url"] for c in captures]

    # Should have both a broadcast POST and a PATCH to agents endpoint
    assert any("/realtime/v1/api/broadcast" in u for u in urls), f"Expected broadcast call, got {urls}"
    assert any(c["method"] == "PATCH" and "/api/agents/" in c["url"] for c in captures), f"Expected PATCH to agents, got {urls}"

    # Verify PATCH body
    patch_call = next(c for c in captures if c["method"] == "PATCH")
    body = json.loads(patch_call["requestBody"])
    assert body["tools_in_use"] == ["web_search", "enrich"]


async def run_all_tests():
    print("messages blackbox tests:")
    r = BlackboxResult()
    await r.record_async("post_message_happy_path", test_post_message_happy_path)
    await r.record_async("post_message_boundary", test_post_message_boundary)
    await r.record_async("poll_messages_happy_path", test_poll_messages_happy_path)
    await r.record_async("update_tree_state_happy_path", test_update_agent_tree_state_happy_path)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
