"""Blackbox tests for messages domain."""

import asyncio
import json
import subprocess
import sys
from datetime import datetime, timezone
from types import SimpleNamespace
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
        return httpx.Response(
            201,
            json={
                "message_id": "msg-created-1",
                "role": "ASSISTANT",
                "message": "test message",
                "timestamp": "2026-04-05T12:00:00Z",
            },
        )

    # GET /api/agents/{id} (used by poll_new_messages via _fetch_agent_data_impl)
    if "/api/agents/" in url and method == "GET":
        return httpx.Response(
            200,
            json={
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
            },
        )

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


async def test_post_message_stamps_workflow_generation():
    """Every internal message carries the producing Temporal Workflow ID header."""
    _setup()
    with (
        patch("temporalio.activity.heartbeat"),
        patch("temporalio.activity.info", return_value=SimpleNamespace(workflow_id="wf-generation-2")),
    ):
        from helpers.messages import post_agent_message

        await post_agent_message(
            agent_id="agent-generation-1",
            text="Running",
            role="ASSISTANT",
            metadata={"source": "agent_loop"},
        )

    call = assert_captured_call(url_contains="/messages", method="POST")
    assert call["requestHeaders"]["x-agent-workflow-generation"] == "wf-generation-2"


async def test_post_tool_message_stamps_metadata_generation():
    """TOOL lifecycle metadata also retains its immutable generation identity."""
    _setup()
    with (
        patch("temporalio.activity.heartbeat"),
        patch("temporalio.activity.info", return_value=SimpleNamespace(workflow_id="wf-generation-3")),
    ):
        from helpers.messages import post_agent_message

        await post_agent_message(
            agent_id="agent-generation-1",
            text="Running",
            role="TOOL",
            metadata={"toolCallId": "tc-1", "toolName": "wait_for", "toolStatus": "IN_PROGRESS"},
        )

    call = assert_captured_call(url_contains="/messages", method="POST")
    body = json.loads(call["requestBody"])
    assert body["metadata"]["workflowGeneration"] == "wf-generation-3"
    assert call["requestHeaders"]["x-agent-workflow-generation"] == "wf-generation-3"


async def test_post_message_treats_stale_generation_as_terminal_fence():
    """A 409 cutover fence must KILL the old activity, not let it keep going.

    This previously asserted `result == {"fenced": True}` -- a sentinel that
    nothing ever read. Returning it meant an activity whose generation a deploy
    had replaced kept running and kept emitting tool events, each of which the
    backend fenced into a red "Tool interrupted by deployment" chip: 32-54
    accepted writes over 13s locally, 105 over 90 minutes in prod.

    Temporal terminate() does not cancel in-flight activities and the activity
    has no cancellation poll, so this 409 is the ONLY signal it ever receives
    that it is dead. It must raise.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"error": "Workflow generation is no longer current"})

    setup_mock_fn(handler)
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import post_agent_message
        from helpers.workflow_generation import WorkflowGenerationSealed

        raised = None
        try:
            await post_agent_message(
                agent_id="agent-stale-message",
                text="late response",
                role="ASSISTANT",
            )
        except WorkflowGenerationSealed as exc:
            raised = exc

    assert raised is not None, "a sealed generation must abort the activity, not return a sentinel"
    assert "agent-stale-message" in str(raised)


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


async def test_poll_messages_status_retryability():
    """Permanent 4xx polls fail non-retryable; 408/409/429/5xx stay retryable (RCA P9).

    The loop poll retries 10 times; a 404/403 will not change on retry, so it
    must not burn that schedule (claude-code-src withRetry.ts:757-785 split).
    """
    from temporalio.exceptions import ApplicationError

    for status, retryable in ((404, False), (403, False), (400, False), (408, True), (429, True), (503, True)):
        setup_mock_fn(lambda request, status=status: httpx.Response(status, json={"error": "x"}))
        with patch("temporalio.activity.heartbeat"):
            from helpers.messages import poll_new_messages

            try:
                await poll_new_messages(agent_id="agent-status-1", last_checked="2020-01-01T00:00:00Z")
            except ApplicationError as exc:
                assert not retryable and exc.non_retryable, f"{status}: unexpected non-retryable {exc!r}"
                assert str(status) in str(exc), f"{status}: error lost the real status: {exc}"
            except httpx.HTTPStatusError:
                assert retryable, f"{status}: permanent 4xx raised retryable HTTPStatusError"
            else:
                raise AssertionError(f"{status}: poll did not raise")


async def test_poll_messages_accepts_temporal_iso_string():
    """Adding a third activity arg must not crash when Temporal delivers last_checked as ISO."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import poll_new_messages

        result = await poll_new_messages(
            agent_id="agent-test-1",
            last_checked="2020-01-01T00:00:00Z",
        )

    assert isinstance(result, list)
    assert len(result) == 2
    assert result[0]["role"] == "USER"


async def test_context_compaction_projection_keeps_checkpoint_tail():
    """Compaction checkpoints replace raw pre-checkpoint history for model context."""
    from helpers.context_compaction import (
        build_context_compaction_metadata,
        project_model_context_after_compaction,
    )

    compressed_context = [
        {"role": "USER", "text": "Original goal", "timestamp": "2026-04-05T12:00:00Z", "metadata": {}},
        {
            "role": "USER",
            "text": "Compaction summary: earlier work was summarized.",
            "timestamp": "2026-04-05T12:03:00Z",
            "metadata": {"compactionSummary": True},
        },
    ]
    raw_messages = [
        {"role": "USER", "text": "Original goal", "timestamp": "2026-04-05T12:00:00Z", "metadata": {}},
        {"role": "TOOL", "text": "Very large raw tool output", "timestamp": "2026-04-05T12:01:00Z", "metadata": {}},
        {
            "role": "TOOL",
            "text": "Context compressed — continuing with summarized history.",
            "timestamp": "2026-04-05T12:04:00Z",
            "metadata": {
                "toolName": "context_reset",
                "toolStatus": "FINISHED",
                "contextCompaction": build_context_compaction_metadata(compressed_context),
            },
        },
        {"role": "ASSISTANT", "text": "Continuing after reset", "timestamp": "2026-04-05T12:05:00Z", "metadata": {}},
    ]

    projected = project_model_context_after_compaction(raw_messages)

    assert [m["text"] for m in projected if m.get("text")] == [
        "Original goal",
        "Compaction summary: earlier work was summarized.",
        "Continuing after reset",
    ]
    assert any((m.get("metadata") or {}).get("excludeFromModel") for m in projected)
    assert all(m.get("text") != "Very large raw tool output" for m in projected)


async def test_poll_messages_projects_context_compaction_checkpoint():
    """poll_new_messages returns compacted model context when a checkpoint exists."""
    compressed_context = [
        {"role": "USER", "text": "Original goal", "timestamp": "2026-04-05T12:00:00Z", "metadata": {}},
        {
            "role": "USER",
            "text": "Compaction summary: old rows summarized.",
            "timestamp": "2026-04-05T12:03:00Z",
            "metadata": {"compactionSummary": True},
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if "/api/agents/" in str(request.url) and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "agent": {"id": "agent-compact-1", "status": "ACTIVE"},
                    "messages": [
                        {
                            "role": "USER",
                            "text": "Original goal",
                            "timestamp": "2026-04-05T12:00:00Z",
                            "metadata": {},
                        },
                        {
                            "role": "TOOL",
                            "text": "Very large raw tool output",
                            "timestamp": "2026-04-05T12:01:00Z",
                            "metadata": {},
                        },
                        {
                            "message_id": "msg-reset-1",
                            "role": "TOOL",
                            "text": "Context compressed — continuing with summarized history.",
                            "timestamp": "2026-04-05T12:04:00Z",
                            "metadata": {
                                "toolName": "context_reset",
                                "toolStatus": "FINISHED",
                                "contextCompaction": {
                                    "version": 1,
                                    "compressedContext": compressed_context,
                                    "compressedMessageCount": len(compressed_context),
                                },
                            },
                        },
                        {
                            "role": "ASSISTANT",
                            "text": "Continuing after reset",
                            "timestamp": "2026-04-05T12:05:00Z",
                            "metadata": {},
                        },
                    ],
                },
            )
        return httpx.Response(404, json={"error": "no mock"})

    setup_mock_fn(handler)
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import poll_new_messages

        result = await poll_new_messages(
            agent_id="agent-compact-1",
            last_checked=datetime(2020, 1, 1, tzinfo=timezone.utc),
        )

    assert [m["text"] for m in result if m.get("text")] == [
        "Original goal",
        "Compaction summary: old rows summarized.",
        "Continuing after reset",
    ]
    assert any((m.get("metadata") or {}).get("contextCompactionBoundary") for m in result)
    assert all(m.get("text") != "Very large raw tool output" for m in result)


async def test_poll_messages_keeps_explore_chips_when_include_internal():
    """Completion recovery needs subAgentId web_fetch bodies; default poll still drops them."""

    fetch_body = (
        "**Params Passed:**\n\n- **url**: https://www.youtube.com/@WesRoth\n\n"
        "**Result:**\n\nWes Roth covers AI research papers and product launches "
        "in long-form YouTube explainers. Last-90-day cadence is several videos "
        "a week with hooks that pair a lab name and a concrete capability claim. "
        "Audience promise is stay-current AI for builders."
    )
    thinking = {
        "role": "TOOL",
        "message": "",
        "timestamp": "2026-04-05T12:00:30Z",
        "metadata": {
            "toolName": "spawn_agent",
            "title": "Explore agent thinking",
            "subAgentId": "explore-wes",
            "toolStatus": "FINISHED",
        },
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if "/api/agents/" in str(request.url) and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "agent": {"id": "gp-wes", "status": "ACTIVE"},
                    "messages": [
                        {
                            "role": "TOOL",
                            "message": "Research the YouTube creator Wes Roth",
                            "timestamp": "2026-04-05T12:00:00Z",
                            "metadata": {"toolName": "spawn_agent", "title": "Exploring"},
                        },
                        thinking,
                        {
                            "role": "TOOL",
                            "message": fetch_body,
                            "timestamp": "2026-04-05T12:01:00Z",
                            "metadata": {
                                "toolName": "web_fetch",
                                "toolStatus": "FINISHED",
                                "subAgentId": "explore-wes",
                                "taskId": "explore-wes",
                            },
                        },
                    ],
                },
            )
        return httpx.Response(404, json={"error": "no mock"})

    setup_mock_fn(handler)
    epoch = datetime(2020, 1, 1, tzinfo=timezone.utc)
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import poll_new_messages

        filtered = await poll_new_messages(agent_id="gp-wes", last_checked=epoch)
        unfiltered = await poll_new_messages(
            agent_id="gp-wes",
            last_checked=epoch,
            include_internal_subagent=True,
        )

    assert len(filtered) == 1
    assert (filtered[0].get("metadata") or {}).get("toolName") == "spawn_agent"
    assert all((m.get("metadata") or {}).get("subAgentId") is None for m in filtered)
    assert len(unfiltered) == 2
    assert any((m.get("metadata") or {}).get("toolName") == "web_fetch" for m in unfiltered)
    assert all((m.get("metadata") or {}).get("title") != "Explore agent thinking" for m in unfiltered)
    assert any(fetch_body in str(m.get("message") or "") for m in unfiltered)


async def test_poll_messages_raises_on_error():
    """poll_new_messages raises when the underlying fetch fails."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    setup_mock_fn(handler)

    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import poll_new_messages

        epoch = datetime(2020, 1, 1, tzinfo=timezone.utc)
        raised = False
        try:
            await poll_new_messages(
                agent_id="agent-err-poll",
                last_checked=epoch,
            )
        except Exception:
            raised = True

    assert raised, "Expected poll_new_messages to raise on backend failure"


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
    await _flush_broadcasts()

    captures = get_captured_requests()
    urls = [c["url"] for c in captures]

    # Should have both a broadcast POST and a PATCH to agents endpoint
    assert any("/realtime/v1/api/broadcast" in u for u in urls), f"Expected broadcast call, got {urls}"
    assert any(c["method"] == "PATCH" and "/api/agents/" in c["url"] for c in captures), (
        f"Expected PATCH to agents, got {urls}"
    )

    # Verify PATCH body includes tools_in_use, progress, message_count, status
    patch_call = next(c for c in captures if c["method"] == "PATCH")
    body = json.loads(patch_call["requestBody"])
    assert body["tools_in_use"] == ["web_search", "wait_for"]
    assert body["progress"] == 0.5
    assert body["message_count"] == 3
    assert body["status"] == "ACTIVE"


async def test_update_agent_tree_state_stamps_workflow_generation():
    """Tree-state mutations identify the exact workflow generation producing them."""
    _setup()
    with (
        patch("temporalio.activity.heartbeat"),
        patch(
            "temporalio.activity.info",
            return_value=SimpleNamespace(workflow_id="agent-tree:replacement:generation-2"),
        ),
    ):
        from helpers.messages import update_agent_tree_state

        await update_agent_tree_state(
            agent_id="agent-tree",
            tools_in_use=["web_search"],
            broadcast_payload={
                "agentId": "agent-tree",
                "toolsInUse": ["web_search"],
                "status": "ACTIVE",
                "progress": 0.75,
                "messageCount": 9,
                "_statusExplicit": True,
            },
        )

    patch_call = assert_captured_call(url_contains="/api/agents/agent-tree", method="PATCH")
    assert patch_call["requestHeaders"]["x-agent-workflow-generation"] == ("agent-tree:replacement:generation-2")


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


async def test_update_agent_tree_state_stale_generation_does_not_broadcast():
    """A rejected generation CAS cannot leak stale tree state to realtime."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "/api/agents/" in str(request.url) and request.method == "PATCH":
            return httpx.Response(
                200,
                json={
                    "mutation_accepted": False,
                    "agent": {"temporal_workflow_id": "replacement-generation"},
                },
            )
        if "/realtime/v1/api/broadcast" in str(request.url):
            return httpx.Response(200, json={})
        return httpx.Response(404)

    setup_mock_fn(handler)
    with patch("temporalio.activity.heartbeat"):
        from helpers.messages import update_agent_tree_state

        await update_agent_tree_state(
            agent_id="agent-stale-tree",
            tools_in_use=["stale-tool"],
            bus_id="bus-stale",
            broadcast_payload={
                "agentId": "agent-stale-tree",
                "toolsInUse": ["stale-tool"],
                "progress": 1,
            },
        )
    await _flush_broadcasts()

    captures = get_captured_requests()
    assert any(c["method"] == "PATCH" for c in captures)
    assert all("/realtime/v1/api/broadcast" not in c["url"] for c in captures)


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
    await _flush_broadcasts()

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
    await _flush_broadcasts()


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
        llm_started_at_ms=1700000000000,
        clear_on_done=True,
    )
    await _flush_broadcasts()

    captures = get_captured_requests()
    assert any("/realtime/v1/api/broadcast" in c["url"] for c in captures)
    broadcast = next(c for c in captures if "/realtime/v1/api/broadcast" in c["url"])
    body = json.loads(broadcast["requestBody"])
    record = body["messages"][0]["payload"]["record"]
    assert record["delta"] == "Hello "
    assert record["subAgentId"] == "sub-1"
    assert record["is_claude"] is True
    assert record["is_gpt"] is True
    assert record["llm_started_at_ms"] == 1700000000000
    assert record["clear_on_done"] is True
    assert body["messages"][0]["event"] == "ASSISTANT_STREAM"


def _reset_broadcast_client():
    """Reset module-level broadcast client so mocks take effect."""
    import sys

    mod = sys.modules.get("helpers.messages")
    if mod is not None:
        mod._broadcast_client = None
        mod._broadcast_queue.clear()
        mod._broadcast_coalesce_items.clear()
        mod._broadcast_idle_waiters.clear()


async def _flush_broadcasts():
    from helpers.messages import flush_realtime_broadcasts_for_tests

    await flush_realtime_broadcasts_for_tests()


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
    await _flush_broadcasts()


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
        llm_started_at_ms=1700000000000,
    )
    await _flush_broadcasts()

    captures = get_captured_requests()
    broadcast = next(c for c in captures if "/realtime/v1/api/broadcast" in c["url"])
    body = json.loads(broadcast["requestBody"])
    assert body["messages"][0]["event"] == "PLAN_STREAM"
    record = body["messages"][0]["payload"]["record"]
    assert record["title"] == "Generating Plan"
    assert record["char_count"] == 42
    assert record["llm_started_at_ms"] == 1700000000000


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
    await _flush_broadcasts()


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
        char_count=123,
        is_claude=True,
        llm_started_at_ms=1700000000000,
        sub_agent_id="browser-task-1",
        status="FINISHED",
    )
    await _flush_broadcasts()

    captures = get_captured_requests()
    broadcast = next(c for c in captures if "/realtime/v1/api/broadcast" in c["url"])
    body = json.loads(broadcast["requestBody"])
    assert body["messages"][0]["event"] == "TOOL_STREAM"
    record = body["messages"][0]["payload"]["record"]
    assert record["tool_name"] == "web_search"
    assert record["char_count"] == 123
    assert record["is_claude"] is True
    assert record["llm_started_at_ms"] == 1700000000000
    assert record["subAgentId"] == "browser-task-1"
    assert record["status"] == "FINISHED"


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
    await _flush_broadcasts()


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
    await _flush_broadcasts()

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
    await _flush_broadcasts()


async def test_stream_browser_cursor_happy_path():
    """stream_browser_cursor sends BROWSER_CURSOR event to agent topic."""
    _setup()
    _reset_broadcast_client()
    from helpers.messages import stream_browser_cursor

    await stream_browser_cursor(
        agent_id="agent-1",
        task_id="browser-task-1",
        x=123,
        y=456,
        sequence=7,
        timestamp_ms=1700000001234,
    )
    await _flush_broadcasts()

    captures = get_captured_requests()
    broadcast = next(c for c in captures if "/realtime/v1/api/broadcast" in c["url"])
    body = json.loads(broadcast["requestBody"])
    message = body["messages"][0]
    record = message["payload"]["record"]
    assert message["event"] == "BROWSER_CURSOR"
    assert message["topic"] == "agent:agent-1"
    assert record["taskId"] == "browser-task-1"
    assert record["x"] == 123
    assert record["y"] == 456
    assert record["sequence"] == 7
    assert record["timestampMs"] == 1700000001234


async def test_stream_browser_cursor_handles_errors():
    """stream_browser_cursor swallows broadcast errors."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise RuntimeError("fail")

    setup_mock_fn(handler)
    _reset_broadcast_client()

    from helpers.messages import stream_browser_cursor

    await stream_browser_cursor(agent_id="a", task_id="t", x=1, y=2)
    await _flush_broadcasts()


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
    await _flush_broadcasts()

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
    await _flush_broadcasts()


async def test_broadcast_to_bus_logs_non_success():
    """broadcast_to_bus logs warning when status is not 200/202."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="nope")

    setup_mock_fn(handler)

    from helpers.messages import broadcast_to_bus

    await broadcast_to_bus(bus_id="b", payload={"agentId": "a", "status": "IDLE"})
    await _flush_broadcasts()


def test_broadcast_shutdown_does_not_spawn_an_unowned_drainer():
    """Runner shutdown must cancel the sender without starting a new batch."""
    code = """
import asyncio
from types import SimpleNamespace
from helpers import messages

entered = asyncio.Event()
class Client:
    async def post(self, *args, **kwargs):
        entered.set()
        await asyncio.Event().wait()
messages._get_broadcast_client = lambda: Client()
messages.load_config = lambda: SimpleNamespace(supabase=SimpleNamespace(
    service_role_key="test", anon_key="", url="https://example.invalid"))
async def main():
    await messages._queue_realtime_record("test", "TEST", {"id": 1})
    messages._schedule_broadcast_flush(0)
    await entered.wait()
    await messages._queue_realtime_record("test", "TEST", {"id": 2})
asyncio.run(main())
assert messages._broadcast_flush_task is None, "shutdown spawned an unowned drainer"
"""
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "different Context" not in result.stderr, result.stderr
    assert "closing of asynchronous generator" not in result.stderr, result.stderr
    assert "Task was destroyed" not in result.stderr, result.stderr


def test_broadcast_flush_preserves_owner_and_recovers_cancelled_queue():
    """A live flush retains its sender; a cancelled sender wakes existing flushers."""
    code = """
import asyncio
import sys
from types import SimpleNamespace
from helpers import messages

entered = asyncio.Event()
release = asyncio.Event()
sent = []
class Client:
    async def post(self, *args, **kwargs):
        ids = [item["payload"]["record"]["id"] for item in kwargs["json"]["messages"]]
        if ids == [1]:
            entered.set()
            await release.wait()
        sent.extend(ids)
        return SimpleNamespace(status_code=200)
messages._get_broadcast_client = lambda: Client()
messages.load_config = lambda: SimpleNamespace(supabase=SimpleNamespace(
    service_role_key="test", anon_key="", url="https://example.invalid"))
async def main():
    await messages._queue_realtime_record("test", "TEST", {"id": 1})
    messages._schedule_broadcast_flush(0)
    await entered.wait()
    owner = messages._broadcast_flush_task
    await messages._queue_realtime_record("test", "TEST", {"id": 2})
    flusher = asyncio.create_task(messages.flush_realtime_broadcasts_for_tests())
    await asyncio.sleep(0)
    if sys.argv[1] == "live":
        assert not owner.cancelling(), "flush cancelled its active sender"
        assert messages._broadcast_flush_task is owner, "flush replaced its active sender"
        release.set()
    else:
        owner.cancel()
        try:
            await owner
        except asyncio.CancelledError:
            pass
    await asyncio.wait_for(flusher, 0.5)
    assert sent == ([1, 2] if sys.argv[1] == "live" else [2]), sent
    assert not messages._broadcast_queue
    assert not messages._broadcast_idle_waiters
    assert messages._broadcast_flush_task is None
asyncio.run(main())
"""
    for mode in ("live", "cancelled"):
        result = subprocess.run([sys.executable, "-c", code, mode], capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, mode + "\n" + result.stdout + result.stderr



async def test_browser_instruction_poll_retains_only_user_sources_and_exact_task_start():
    from unittest.mock import AsyncMock, patch
    from helpers.messages import poll_new_messages
    from datetime import datetime, timezone

    from _test_utils import native_browser_start_source
    user = {"id": "user", "role": "USER", "text": "Actual authored correction", "metadata": None}
    start = await native_browser_start_source("2026-10-14T00:00:00+00:00", tool_call_id="tool-1")
    other = {"id": "other", "role": "TOOL", "text": "Other task", "metadata": {"task_id": "task-2", "subAgentId": "task-2", "action_type": "task_started"}}
    internal = {"id": "internal", "role": "TOOL", "text": "Large browser state", "metadata": {"task_id": "task-1", "subAgentId": "task-1", "action_type": "read_browser_state"}}
    # Execute the actual OTP credential writer. Its USER role is internal
    # machine context, distinguished by native subAgentId provenance.
    from types import SimpleNamespace
    from domains.spawn_browser_agent_v3.repo import save_browser_credential_ref_message
    post = AsyncMock(return_value=SimpleNamespace(status_code=200, is_error=False))
    with (
        patch("config.load_config", return_value=SimpleNamespace(backend=SimpleNamespace(api_url="http://fixture", api_key="fixture"))),
        patch("domains.spawn_browser_agent_v3.repo.get_http_client", return_value=SimpleNamespace(post=post)),
    ):
        assert await save_browser_credential_ref_message(agent_id="agent-1", task_id="other-browser", message="OTP fixture context", role="USER", credential_ref={"kind": "otp", "id": "fixture"})
    payload = post.await_args.kwargs["json"]
    otp = {"id": "otp", "role": payload["role"], "text": payload["message"], "metadata": payload["metadata"]}
    with (
        patch("helpers.messages._fetch_agent_data_impl", AsyncMock(return_value={"messages": [user, start, other, internal, otp]})) as fetch,
        patch("helpers.messages.activity.heartbeat"),
    ):
        rows = await poll_new_messages("agent-1", datetime(2026, 10, 14, tzinfo=timezone.utc), browser_tool_call_id="tool-1")
    assert rows == [user, start], "native start was filtered or unrelated internal work became user input"
    fetch.assert_awaited_once_with("agent-1", since="2026-10-14T00:00:00+00:00", browser_tool_call_id="tool-1")


async def test_browser_instruction_poll_projects_at_http_boundary():
    """The existing GET carries the role projection before any large response."""
    observed = []
    def respond(request):
        observed.append(request)
        return httpx.Response(200, json={"messages": []})
    setup_mock_fn(respond)
    try:
        from helpers.messages import poll_new_messages
        with patch("helpers.messages.activity.heartbeat"):
            await poll_new_messages("agent-1", datetime(2026, 10, 14, tzinfo=timezone.utc), browser_tool_call_id="tool/&1")
            await poll_new_messages("agent-1", datetime(2026, 10, 14, tzinfo=timezone.utc))
        assert len(observed) == 2
        assert observed[0].url.params.get("browserToolCallId") == "tool/&1", "browser read still downloads the full root transcript"
        assert observed[0].url.params.get("since") == "2026-10-14T00:00:00+00:00"
        assert "browserToolCallId" not in observed[1].url.params, "ordinary root replay was narrowed"
    finally:
        teardown_mock()


async def test_browser_attention_feedback_is_task_scoped_and_root_input_is_global():
    from unittest.mock import AsyncMock
    from helpers.messages import poll_new_messages
    rows = [
        {"id": "global", "role": "USER", "text": "  Global correction\n", "metadata": None},
        {"id": "a", "role": "USER", "text": "  Only browser A\n", "metadata": {"source": "attention_response", "attentionRequestId": "req-a", "browserTaskId": "task-a"}},
        {"id": "b", "role": "USER", "text": "  Only browser B\n", "metadata": {"source": "attention_response", "attentionRequestId": "req-b", "browserTaskId": "task-b"}},
    ]
    with patch("helpers.messages._fetch_agent_data_impl", AsyncMock(return_value={"messages": rows})), patch("helpers.messages.activity.heartbeat"):
        a = await poll_new_messages("agent-1", datetime(2026, 10, 14, tzinfo=timezone.utc), browser_tool_call_id="tool-a", browser_task_id="task-a")
        b = await poll_new_messages("agent-1", datetime(2026, 10, 14, tzinfo=timezone.utc), browser_tool_call_id="tool-b", browser_task_id="task-b")
        root = await poll_new_messages("agent-1", datetime(2026, 10, 14, tzinfo=timezone.utc))
    assert a == rows[:2], "browser A consumed a sibling's authored reply"
    assert b == [rows[0], rows[2]], "browser B consumed a sibling's authored reply"
    assert root == rows, "parent lost actual authored feedback"

async def run_all_tests():
    print("messages blackbox tests:")
    r = BlackboxResult()
    r.record("broadcast_shutdown_owns_drainer", test_broadcast_shutdown_does_not_spawn_an_unowned_drainer)
    r.record(
        "broadcast_flush_owner_and_cancelled_queue", test_broadcast_flush_preserves_owner_and_recovers_cancelled_queue
    )
    await r.record_async("browser_instruction_poll_projects_at_http_boundary", test_browser_instruction_poll_projects_at_http_boundary)
    await r.record_async("browser_attention_feedback_is_task_scoped_and_root_input_is_global", test_browser_attention_feedback_is_task_scoped_and_root_input_is_global)
    await r.record_async("browser_instruction_poll_retains_only_user_sources_and_exact_task_start", test_browser_instruction_poll_retains_only_user_sources_and_exact_task_start)
    await r.record_async("post_message_happy_path", test_post_message_happy_path)
    await r.record_async("post_message_boundary", test_post_message_boundary)
    await r.record_async("post_message_stamps_workflow_generation", test_post_message_stamps_workflow_generation)
    await r.record_async(
        "post_tool_message_stamps_metadata_generation",
        test_post_tool_message_stamps_metadata_generation,
    )
    await r.record_async(
        "post_message_treats_stale_generation_as_terminal_fence",
        test_post_message_treats_stale_generation_as_terminal_fence,
    )
    await r.record_async("post_message_with_file_pointer", test_post_message_with_file_pointer)
    await r.record_async("post_message_no_metadata", test_post_message_no_metadata)
    await r.record_async("post_message_raises_on_http_error", test_post_message_raises_on_http_error)
    await r.record_async("poll_messages_happy_path", test_poll_messages_happy_path)
    await r.record_async("poll_messages_status_retryability", test_poll_messages_status_retryability)
    await r.record_async(
        "poll_messages_accepts_temporal_iso_string",
        test_poll_messages_accepts_temporal_iso_string,
    )
    await r.record_async(
        "poll_messages_keeps_explore_chips_when_include_internal",
        test_poll_messages_keeps_explore_chips_when_include_internal,
    )
    await r.record_async(
        "context_compaction_projection_keeps_checkpoint_tail", test_context_compaction_projection_keeps_checkpoint_tail
    )
    await r.record_async(
        "poll_messages_projects_context_compaction_checkpoint",
        test_poll_messages_projects_context_compaction_checkpoint,
    )
    await r.record_async("poll_messages_raises_on_error", test_poll_messages_raises_on_error)
    await r.record_async("update_tree_state_happy_path", test_update_agent_tree_state_happy_path)
    await r.record_async(
        "update_tree_state_stamps_workflow_generation",
        test_update_agent_tree_state_stamps_workflow_generation,
    )
    await r.record_async("update_tree_state_no_broadcast", test_update_agent_tree_state_no_broadcast)
    await r.record_async(
        "update_tree_state_stale_generation_does_not_broadcast",
        test_update_agent_tree_state_stale_generation_does_not_broadcast,
    )
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
    await r.record_async("stream_browser_cursor_happy", test_stream_browser_cursor_happy_path)
    await r.record_async("stream_browser_cursor_errors", test_stream_browser_cursor_handles_errors)
    await r.record_async("broadcast_to_bus_happy", test_broadcast_to_bus_happy_path)
    await r.record_async("broadcast_to_bus_errors", test_broadcast_to_bus_handles_errors)
    await r.record_async("broadcast_to_bus_non_success", test_broadcast_to_bus_logs_non_success)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(run_all_tests()) else 1)
