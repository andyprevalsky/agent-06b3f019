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
            metadata={"toolName": "wait_for", "toolStatus": "FINISHED"},
        )

    call = assert_captured_call(
        url_contains="/messages",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["role"] == "TOOL"
    assert body["message"] == "Boundary test message"
    assert body["metadata"]["toolName"] == "wait_for"


async def test_post_message_with_file_pointer():
    """post_agent_message includes file_pointer in payload when provided."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import post_agent_message

        await post_agent_message(
            agent_id="agent-fp-1",
            text="File attached",
            role="ASSISTANT",
            file_pointer={
                "id": "fp-1",
                "storage_path": "user/fp.png",
                "original_filename": "fp.png",
                "mime_type": "image/png",
                "size_bytes": 100,
                "created_at": "2026-04-05T12:00:00Z",
            },
        )

    call = assert_captured_call(url_contains="/messages", method="POST")
    body = json.loads(call["requestBody"])
    assert body["file_pointer"]["id"] == "fp-1"


async def test_post_message_no_metadata():
    """post_agent_message omits metadata when None provided."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import post_agent_message

        await post_agent_message(
            agent_id="agent-no-meta",
            text="Plain msg",
        )

    call = assert_captured_call(url_contains="/messages", method="POST")
    body = json.loads(call["requestBody"])
    assert "metadata" not in body
    assert "file_pointer" not in body


async def test_post_message_raises_on_http_error():
    """post_agent_message raises when the backend returns non-201."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})
    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import post_agent_message

        raised = False
        try:
            await post_agent_message(
                agent_id="agent-err-1",
                text="will fail",
            )
        except Exception:
            raised = True

    assert raised, "Expected post_agent_message to raise on HTTP 500"


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


async def test_poll_messages_returns_empty_on_error():
    """poll_new_messages returns [] when the underlying fetch raises."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})
    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import poll_new_messages

        epoch = datetime(2020, 1, 1, tzinfo=timezone.utc)
        result = await poll_new_messages(
            agent_id="agent-err-poll",
            last_checked=epoch,
        )

    assert result == []


async def test_update_agent_tree_state_happy_path():
    """update_agent_tree_state PATCHes the agent and broadcasts to bus."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import update_agent_tree_state

        await update_agent_tree_state(
            agent_id="agent-tree-1",
            tools_in_use=["web_search", "wait_for"],
            bus_id="bus-root-1",
            broadcast_payload={
                "agentId": "agent-tree-1",
                "toolsInUse": ["web_search", "wait_for"],
                "status": "ACTIVE",
                "progress": 0.5,
                "messageCount": 3,
                "_statusExplicit": True,
            },
        )

    captures = get_captured_requests()
    urls = [c["url"] for c in captures]

    # Should have both a broadcast POST and a PATCH to agents endpoint
    assert any("/realtime/v1/api/broadcast" in u for u in urls), f"Expected broadcast call, got {urls}"
    assert any(c["method"] == "PATCH" and "/api/agents/" in c["url"] for c in captures), f"Expected PATCH to agents, got {urls}"

    # Verify PATCH body includes tools_in_use, progress, message_count, status
    patch_call = next(c for c in captures if c["method"] == "PATCH")
    body = json.loads(patch_call["requestBody"])
    assert body["tools_in_use"] == ["web_search", "wait_for"]
    assert body["progress"] == 0.5
    assert body["message_count"] == 3
    assert body["status"] == "ACTIVE"


async def test_update_agent_tree_state_no_broadcast():
    """update_agent_tree_state without bus_id only PATCHes (no broadcast)."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import update_agent_tree_state

        await update_agent_tree_state(
            agent_id="agent-no-bus",
            tools_in_use=["web_search"],
        )

    captures = get_captured_requests()
    # Only PATCH, no broadcast
    assert all("/realtime/v1/api/broadcast" not in c["url"] for c in captures)
    assert any(c["method"] == "PATCH" for c in captures)


async def test_update_agent_tree_state_handles_broadcast_failure():
    """update_agent_tree_state swallows broadcast errors but still PATCHes."""
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/realtime/v1/api/broadcast" in url:
            return httpx.Response(500, json={"error": "broadcast fail"})
        if "/api/agents/" in url and request.method == "PATCH":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)
    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import update_agent_tree_state

        # Should NOT raise
        await update_agent_tree_state(
            agent_id="agent-bf",
            tools_in_use=["wait_for"],
            bus_id="bus-err",
            broadcast_payload={"agentId": "agent-bf", "toolsInUse": ["wait_for"]},
        )

    captures = get_captured_requests()
    assert any(c["method"] == "PATCH" for c in captures)


async def test_update_agent_tree_state_patch_raises():
    """update_agent_tree_state swallows exceptions when PATCH raises."""
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/realtime/v1/api/broadcast" in url:
            return httpx.Response(200, json={})
        if "/api/agents/" in url and request.method == "PATCH":
            raise RuntimeError("patch failed")
        return httpx.Response(404)
    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import update_agent_tree_state

        # Should NOT raise
        await update_agent_tree_state(
            agent_id="agent-pe",
            tools_in_use=["wait_for"],
            bus_id="bus-pe",
            broadcast_payload={"agentId": "agent-pe"},
        )


async def test_stream_assistant_chunk_happy_path():
    """stream_assistant_chunk broadcasts delta to Supabase Realtime."""
    _setup()
    from helpers.messages import stream_assistant_chunk

    await stream_assistant_chunk(
        agent_id="agent-stream-1",
        stream_id="stream-1",
        delta="Hello ",
        done=False,
        sequence=1,
        sub_agent_id="sub-1",
        is_claude=True,
        is_gpt=True,
    )

    captures = get_captured_requests()
    assert any("/realtime/v1/api/broadcast" in c["url"] for c in captures)
    broadcast = next(c for c in captures if "/realtime/v1/api/broadcast" in c["url"])
    body = json.loads(broadcast["requestBody"])
    record = body["messages"][0]["payload"]["record"]
    assert record["delta"] == "Hello "
    assert record["subAgentId"] == "sub-1"
    assert record["is_claude"] is True
    assert record["is_gpt"] is True
    assert body["messages"][0]["event"] == "ASSISTANT_STREAM"


def _reset_broadcast_client():
    """Reset module-level broadcast client so mocks take effect."""
    import sys
    mod = sys.modules.get("helpers.messages")
    if mod is not None:
        mod._broadcast_client = None


async def test_stream_assistant_chunk_handles_errors():
    """stream_assistant_chunk swallows exceptions silently."""
    def handler(request: httpx.Request) -> httpx.Response:
        raise RuntimeError("network down")
    setup_mock_fn(handler)
    _reset_broadcast_client()

    from helpers.messages import stream_assistant_chunk

    # Must not raise
    await stream_assistant_chunk(
        agent_id="agent-err",
        stream_id="stream-err",
        delta="x",
    )


async def test_stream_plan_event_broadcasts():
    """stream_plan_event sends PLAN_STREAM broadcast."""
    _setup()
    from helpers.messages import stream_plan_event

    await stream_plan_event(
        agent_id="agent-plan-1",
        stream_id="stream-plan",
        tool_call_id="tc-1",
        title="Generating Plan",
        char_count=42,
    )

    captures = get_captured_requests()
    broadcast = next(c for c in captures if "/realtime/v1/api/broadcast" in c["url"])
    body = json.loads(broadcast["requestBody"])
    assert body["messages"][0]["event"] == "PLAN_STREAM"
    record = body["messages"][0]["payload"]["record"]
    assert record["title"] == "Generating Plan"
    assert record["char_count"] == 42


async def test_stream_plan_event_handles_errors():
    """stream_plan_event swallows exceptions."""
    def handler(request: httpx.Request) -> httpx.Response:
        raise RuntimeError("fail")
    setup_mock_fn(handler)
    _reset_broadcast_client()

    from helpers.messages import stream_plan_event

    # Must not raise
    await stream_plan_event(
        agent_id="a",
        stream_id="s",
        tool_call_id="t",
        title="title",
    )


async def test_stream_tool_event_broadcasts():
    """stream_tool_event sends TOOL_STREAM event."""
    _setup()
    from helpers.messages import stream_tool_event

    await stream_tool_event(
        agent_id="agent-tool-1",
        stream_id="stream-tool",
        tool_call_id="tc-2",
        tool_name="web_search",
        title="Starting web_search...",
    )

    captures = get_captured_requests()
    broadcast = next(c for c in captures if "/realtime/v1/api/broadcast" in c["url"])
    body = json.loads(broadcast["requestBody"])
    assert body["messages"][0]["event"] == "TOOL_STREAM"
    record = body["messages"][0]["payload"]["record"]
    assert record["tool_name"] == "web_search"


async def test_stream_tool_event_handles_errors():
    """stream_tool_event swallows exceptions."""
    def handler(request: httpx.Request) -> httpx.Response:
        raise RuntimeError("fail")
    setup_mock_fn(handler)
    _reset_broadcast_client()

    from helpers.messages import stream_tool_event

    await stream_tool_event(
        agent_id="a",
        stream_id="s",
        tool_call_id="t",
        tool_name="wait_for",
        title="Starting wait_for...",
    )


async def test_stream_attention_event_broadcasts():
    """stream_attention_event sends ATTENTION_STREAM event."""
    _setup()
    from helpers.messages import stream_attention_event

    await stream_attention_event(
        agent_id="agent-att-1",
        stream_id="stream-att",
        tool_call_id="tc-3",
        message="Please confirm",
        is_question=True,
        done=False,
        sequence=1,
    )

    captures = get_captured_requests()
    broadcast = next(c for c in captures if "/realtime/v1/api/broadcast" in c["url"])
    body = json.loads(broadcast["requestBody"])
    assert body["messages"][0]["event"] == "ATTENTION_STREAM"
    record = body["messages"][0]["payload"]["record"]
    assert record["message"] == "Please confirm"
    assert record["is_question"] is True


async def test_stream_attention_event_handles_errors():
    """stream_attention_event swallows exceptions."""
    def handler(request: httpx.Request) -> httpx.Response:
        raise RuntimeError("fail")
    setup_mock_fn(handler)
    _reset_broadcast_client()

    from helpers.messages import stream_attention_event

    await stream_attention_event(
        agent_id="a",
        stream_id="s",
        tool_call_id="t",
        message="m",
    )


async def test_broadcast_to_bus_happy_path():
    """broadcast_to_bus sends AGENT_STATE_CHANGED event to bus topic."""
    _setup()
    from helpers.messages import broadcast_to_bus

    await broadcast_to_bus(
        bus_id="bus-root-x",
        payload={
            "agentId": "agent-1",
            "status": "ACTIVE",
            "toolsInUse": ["web_search"],
        },
    )

    captures = get_captured_requests()
    broadcast = next(c for c in captures if "/realtime/v1/api/broadcast" in c["url"])
    body = json.loads(broadcast["requestBody"])
    assert body["messages"][0]["event"] == "AGENT_STATE_CHANGED"
    assert body["messages"][0]["topic"] == "bus:bus-root-x"


async def test_broadcast_to_bus_handles_errors():
    """broadcast_to_bus swallows exceptions (non-fatal)."""
    def handler(request: httpx.Request) -> httpx.Response:
        raise RuntimeError("fail")
    setup_mock_fn(handler)
    _reset_broadcast_client()

    from helpers.messages import broadcast_to_bus

    await broadcast_to_bus(bus_id="b", payload={})


async def test_broadcast_to_bus_logs_non_success():
    """broadcast_to_bus logs warning when status is not 200/202."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="nope")
    setup_mock_fn(handler)

    from helpers.messages import broadcast_to_bus

    await broadcast_to_bus(bus_id="b", payload={"agentId": "a", "status": "IDLE"})


async def run_all_tests():
    print("messages blackbox tests:")
    r = BlackboxResult()
    await r.record_async("post_message_happy_path", test_post_message_happy_path)
    await r.record_async("post_message_boundary", test_post_message_boundary)
    await r.record_async("post_message_with_file_pointer", test_post_message_with_file_pointer)
    await r.record_async("post_message_no_metadata", test_post_message_no_metadata)
    await r.record_async("post_message_raises_on_http_error", test_post_message_raises_on_http_error)
    await r.record_async("poll_messages_happy_path", test_poll_messages_happy_path)
    await r.record_async("poll_messages_returns_empty_on_error", test_poll_messages_returns_empty_on_error)
    await r.record_async("update_tree_state_happy_path", test_update_agent_tree_state_happy_path)
    await r.record_async("update_tree_state_no_broadcast", test_update_agent_tree_state_no_broadcast)
    await r.record_async("update_tree_state_broadcast_failure", test_update_agent_tree_state_handles_broadcast_failure)
    await r.record_async("update_tree_state_patch_raises", test_update_agent_tree_state_patch_raises)
    await r.record_async("stream_assistant_chunk_happy", test_stream_assistant_chunk_happy_path)
    await r.record_async("stream_assistant_chunk_errors", test_stream_assistant_chunk_handles_errors)
    await r.record_async("stream_plan_event_broadcasts", test_stream_plan_event_broadcasts)
    await r.record_async("stream_plan_event_errors", test_stream_plan_event_handles_errors)
    await r.record_async("stream_tool_event_broadcasts", test_stream_tool_event_broadcasts)
    await r.record_async("stream_tool_event_errors", test_stream_tool_event_handles_errors)
    await r.record_async("stream_attention_event_broadcasts", test_stream_attention_event_broadcasts)
    await r.record_async("stream_attention_event_errors", test_stream_attention_event_handles_errors)
    await r.record_async("broadcast_to_bus_happy", test_broadcast_to_bus_happy_path)
    await r.record_async("broadcast_to_bus_errors", test_broadcast_to_bus_handles_errors)
    await r.record_async("broadcast_to_bus_non_success", test_broadcast_to_bus_logs_non_success)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
