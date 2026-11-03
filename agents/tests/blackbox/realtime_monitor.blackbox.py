"""Blackbox tests for benchmark realtime smoke invariants."""

import asyncio

from _test_utils import BlackboxResult


def _tool_record(agent_id: str, status: str, tool_call_id: str = "tc-1") -> dict:
    return {
        "agentId": agent_id,
        "id": f"msg-{status}",
        "timestamp": "2026-01-01T00:00:00Z",
        "role": "TOOL",
        "text": "",
        "metadata": {
            "toolCallId": tool_call_id,
            "toolName": "web_search",
            "toolStatus": status,
        },
    }


def _spawn_tool_record(agent_id: str, status: str, tool_call_id: str = "spawn-1") -> dict:
    record = _tool_record(agent_id, status, tool_call_id)
    record["id"] = f"spawn-{status}"
    record["metadata"]["toolName"] = "spawn_general_purpose_agent"
    record["metadata"]["spawnGroupId"] = tool_call_id
    return record


def _assistant_record(agent_id: str, timestamp: str = "2026-01-01T00:00:01Z", metadata: dict | None = None) -> dict:
    return {
        "agentId": agent_id,
        "id": "assistant-1",
        "timestamp": timestamp,
        "role": "ASSISTANT",
        "text": "next turn",
        "metadata": metadata or {},
    }


def test_no_hanging_tool_calls_flags_assistant_after_open_tool():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_tool_record("agent-1", "IN_PROGRESS"))
    invariant.handle_insert(_assistant_record("agent-1"))

    assert invariant.failure_reason is not None
    assert "unresolved tool web_search" in invariant.failure_reason


def test_output_attachment_during_wait_is_not_parent_turn():
    """A child artifact may arrive while the parent is still in wait_for."""
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    waiting = _tool_record("agent-1", "IN_PROGRESS", "wait-1")
    waiting["metadata"]["toolName"] = "wait_for"
    invariant.handle_insert(waiting)
    invariant.handle_insert(
        {
            "agentId": "agent-1",
            "id": "child-artifact",
            "timestamp": "2026-01-01T00:00:01Z",
            "role": "ASSISTANT",
            "text": "",
            "filePointer": {"mime_type": "image/png", "storage_path": "child/screenshot.png"},
            "metadata": {"artifactOnly": True, "sourceToolCallId": "spawn-1"},
        }
    )
    assert invariant.failure_reason is None
    invariant.handle_insert(_assistant_record("agent-1", "2026-01-01T00:00:02Z"))
    assert "unresolved tool wait_for" in (invariant.failure_reason or "")


def test_snapshot_reconcile_reads_api_message_shape_for_child_artifacts():
    """r004-j0049: the DB snapshot uses `message`/`file_pointer`, not realtime keys.

    The child's screenshot rows d644b589/e5e5caf9 landed between wait_for
    IN_PROGRESS and its FINISHED row; reconciliation must still see them as
    artifacts.
    """
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    wait_call = "call_28e5a1c2e820437b8a4fd2b73a9c7995"
    wait_meta = {"toolCallId": wait_call, "toolName": "wait_for"}
    messages = [
        {
            "created_at": "2026-10-23T23:16:11.630Z",
            "message": "Waiting up to 10 minutes for /root/site_palette",
            "metadata": {**wait_meta, "toolStatus": "IN_PROGRESS"},
            "role": "TOOL",
        },
        {
            "created_at": "2026-10-23T23:17:20.343Z",
            "file_pointer": {"mime_type": "image/png", "original_filename": "screenshot.png"},
            "message": "",
            "metadata": {"artifactOnly": True, "sourceToolCallId": "call_d0c89615971f4dce9ea80abe1558116c"},
            "role": "ASSISTANT",
        },
        {
            "created_at": "2026-10-23T23:17:20.419Z",
            "file_pointer": {"mime_type": "image/png", "original_filename": "screenshot_final.png"},
            "message": "",
            "metadata": {"artifactOnly": True, "sourceToolCallId": "call_d0c89615971f4dce9ea80abe1558116c"},
            "role": "ASSISTANT",
        },
        {
            "created_at": "2026-10-23T23:17:20.631Z",
            "message": "Woken by a background agent notification (/root/site_palette) after 1.1 minutes.",
            "metadata": {**wait_meta, "toolStatus": "FINISHED"},
            "role": "TOOL",
        },
        {
            "created_at": "2026-10-23T23:17:28.210Z",
            "message": "**Preparing Rose UI card**",
            "metadata": {},
            "role": "ASSISTANT",
        },
    ]

    assert NoHangingToolCallsInvariant("agent-1").reconcile_snapshot(messages) is None
    # The same snapshot shape still catches an authored turn while wait_for is open.
    authored = dict(messages[4], created_at="2026-10-23T23:17:20.500Z")
    assert "unresolved tool wait_for" in (
        NoHangingToolCallsInvariant("agent-1").reconcile_snapshot([*messages[:3], authored, messages[3]]) or ""
    )


def test_own_display_call_posting_its_page_is_not_a_turn():
    """spawn-sub-agents 6f893e51: the root's own display call posts its page row
    (46bef1c0) between that call's IN_PROGRESS (04:14:38) and FINISHED (04:15:00).

    The page is the tool's output, shown to the user and excluded from the model;
    the FINISHED result names it. Both the realtime and the DB snapshot shapes must
    accept it, while an authored turn during the open display call still fails.
    """
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    display_call = "a52c5f8c-151e-4410-b149-3fec062d3df0"
    page = {"id": "46bef1c0-8a18-87b7-88a6-192dc92ae17d", "kind": "page", "mime_type": "text/html"}
    caption = "The exact product is 121,362,308,052,156. The card shows both official population inputs and dates."
    page_meta = {
        "source": "display",
        "display": {"kind": "media", "placement": "inline", "media_kind": "page", "conversation": "own"},
        "excludeFromModel": True,
    }
    messages = [
        {
            "created_at": "2026-10-24T04:14:38.082Z",
            "message": "Publish a concise Rose-styled HTML scorecard through display.",
            "metadata": {"toolCallId": display_call, "toolName": "display", "toolStatus": "IN_PROGRESS"},
            "role": "TOOL",
        },
        {
            "created_at": "2026-10-24T04:15:00.555Z",
            "message": caption,
            "file_pointer": page,
            "metadata": page_meta,
            "role": "ASSISTANT",
        },
        {
            "created_at": "2026-10-24T04:15:00.785Z",
            "message": "Displayed 1 item(s) inline for the user; text/html.",
            "metadata": {"toolCallId": display_call, "toolName": "display", "toolStatus": "FINISHED"},
            "role": "TOOL",
        },
    ]
    agent = "6f893e51-1e49-41d3-a70c-8e1ba2657a45"
    assert NoHangingToolCallsInvariant(agent).reconcile_snapshot(messages) is None

    live = NoHangingToolCallsInvariant(agent)
    for message in messages:
        record = {
            "agentId": agent,
            "id": message.get("file_pointer", {}).get("id", ""),
            "timestamp": message["created_at"],
            "role": message["role"],
            "text": message["message"],
            "metadata": message["metadata"],
        }
        if "file_pointer" in message:
            record["filePointer"] = message["file_pointer"]
        live.handle_insert(record)
    assert live.failure_reason is None

    authored = {
        "created_at": "2026-10-24T04:14:50.000Z",
        "message": "**Publishing the card**",
        "metadata": {},
        "role": "ASSISTANT",
    }
    assert "unresolved tool display" in (
        NoHangingToolCallsInvariant(agent).reconcile_snapshot([messages[0], authored, *messages[1:]]) or ""
    )


def test_code_agent_display_mirror_during_open_tool_is_not_parent_turn():
    """r004-j0049: a running code agent's Display is mirrored into the parent.

    Row 4011c420 is posted while spawn_claude_code_agent is still open; it is
    excluded from the model and carries the displayed file, so it is not a turn.
    """
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    code_call = "call_530ea3ca9bf640358d491ade206558b2"
    code_meta = {"toolCallId": code_call, "toolName": "spawn_claude_code_agent"}
    display_row = {
        "agentId": "agent-1",
        "id": "4011c420-e1aa-8b13-833b-df721135034d",
        "timestamp": "2026-10-23T23:18:33.775Z",
        "role": "ASSISTANT",
        "text": "Rose homepage palette — approximate hex scorecard",
        "filePointer": {"mime_type": "text/html", "storage_path": "user/display.html"},
        "metadata": {
            "source": "display",
            "display": {"placement": "inline", "kind": "media", "conversation": "parent"},
            "excludeFromModel": True,
            "displayedBy": {"kind": "code_agent", "task_id": "e84a62c6-c79b-4af6-b977-60e0176e2c24"},
        },
    }
    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(
        {
            "agentId": "agent-1",
            "id": "edabb0ae-09b4-4240-88b0-40a7d25816af",
            "timestamp": "2026-10-23T23:17:32.049Z",
            "role": "TOOL",
            "text": "Goal: Create and publish a concise, polished Rose scorecard",
            "metadata": {**code_meta, "toolStatus": "IN_PROGRESS"},
        }
    )
    invariant.handle_insert(display_row)
    assert invariant.failure_reason is None

    # The display marker alone cannot hide a model-visible authored turn.
    authored = dict(display_row, metadata={**display_row["metadata"], "excludeFromModel": False})
    invariant.handle_insert(authored)
    assert "unresolved tool spawn_claude_code_agent" in (invariant.failure_reason or "")


def test_attachment_marker_cannot_hide_authored_assistant_turn():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_tool_record("agent-1", "IN_PROGRESS"))
    message = _assistant_record("agent-1", metadata={"artifactOnly": True})
    message["filePointer"] = {"mime_type": "image/png"}
    invariant.handle_insert(message)
    assert "unresolved tool web_search" in (invariant.failure_reason or "")


def test_no_hanging_tool_calls_allows_finished_before_assistant():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_tool_record("agent-1", "IN_PROGRESS"))
    invariant.handle_insert(_tool_record("agent-1", "FINISHED"))
    invariant.handle_insert(_assistant_record("agent-1"))

    assert invariant.failure_reason is None


def test_no_hanging_tool_calls_allows_late_in_progress_after_finished():
    """Supabase realtime can deliver INSERT frames slightly out of order."""
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_tool_record("agent-1", "FINISHED"))
    invariant.handle_insert(_tool_record("agent-1", "IN_PROGRESS"))
    invariant.handle_insert(_assistant_record("agent-1"))

    assert invariant.failure_reason is None


def test_no_hanging_tool_calls_allows_assistant_while_spawn_agent_runs():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_spawn_tool_record("agent-1", "IN_PROGRESS", "spawn-1"))
    invariant.handle_insert(
        _assistant_record(
            "agent-1",
            "2026-01-01T00:00:02Z",
            {"tool_calls": [{"tool_call_id": "spawn-2", "name": "spawn_agent"}]},
        )
    )
    invariant.handle_insert(_spawn_tool_record("agent-1", "FINISHED", "spawn-1"))

    assert invariant.failure_reason is None


def test_no_hanging_tool_calls_ignores_other_agents():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_tool_record("agent-2", "IN_PROGRESS"))
    invariant.handle_insert(_assistant_record("agent-1"))

    assert invariant.failure_reason is None


def test_no_hanging_tool_calls_ignores_subagent_internal_tools():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    record = _tool_record("agent-1", "IN_PROGRESS", "tc-sub")
    record["metadata"]["subAgentId"] = "child-1"
    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(record)
    invariant.handle_insert(_assistant_record("agent-1"))

    assert invariant.failure_reason is None


def test_no_hanging_tool_calls_closes_on_bounded_finished_notice():
    """A FINISHED row over the backend's 8 KB live cap arrives as INSERT_DEFERRED."""
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_broadcast("INSERT", {"payload": {"record": _tool_record("agent-1", "IN_PROGRESS")}})
    notice = {
        "agentId": "agent-1",
        "id": "msg-FINISHED",
        "timestamp": "2026-01-01T00:00:00Z",
        "role": "TOOL",
        "reason": "This message is too large to stream live; loading it from the server.",
        "preview": "Search results...",
        "metadata": {"toolCallId": "tc-1", "toolName": "web_search", "toolStatus": "FINISHED"},
    }
    invariant.handle_broadcast("INSERT_DEFERRED", {"payload": {"record": notice}})
    invariant.handle_broadcast("INSERT", {"payload": {"record": _assistant_record("agent-1")}})

    assert invariant.failure_reason is None, invariant.failure_reason


def test_no_hanging_tool_calls_ignores_declaring_assistant():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_tool_record("agent-1", "IN_PROGRESS", "tc-1"))
    invariant.handle_insert(
        _assistant_record(
            "agent-1",
            "2026-01-01T00:00:01Z",
            {"tool_calls": [{"tool_call_id": "tc-1", "name": "web_search"}]},
        )
    )

    assert invariant.failure_reason is None


def test_no_hanging_tool_calls_snapshot_reconcile_clears_missed_finished_frame():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_tool_record("agent-1", "IN_PROGRESS"))
    invariant.handle_insert(_assistant_record("agent-1", "2026-01-01T00:00:03Z"))
    assert invariant.failure_reason is not None

    messages = [
        _tool_record("agent-1", "IN_PROGRESS"),
        _tool_record("agent-1", "FINISHED"),
        _assistant_record("agent-1", "2026-01-01T00:00:03Z"),
    ]
    messages[1]["timestamp"] = "2026-01-01T00:00:02Z"

    assert invariant.reconcile_snapshot(messages) is None
    assert invariant.failure_reason is None


def test_no_hanging_tool_calls_ignores_late_dag_reasoning_flush():
    """Smoke11: assemble ASSISTANT INSERT after attempt_completion IN_PROGRESS."""
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(
        {
            "agentId": "agent-1",
            "id": "ac-in-progress",
            "timestamp": "2026-08-27T23:51:25.531Z",
            "role": "TOOL",
            "text": "Running verifier to check completion...",
            "metadata": {
                "toolCallId": "post-dag-attempt-completion-1",
                "toolName": "attempt_completion",
                "toolStatus": "IN_PROGRESS",
            },
        }
    )
    invariant.handle_insert(
        {
            "agentId": "agent-1",
            "id": "dag-reasoning",
            "timestamp": "2026-08-27T23:51:25.738Z",
            "role": "ASSISTANT",
            "text": "July Fast Mode assemble of the original OAi demo cache",
            "metadata": {
                "dagTaskIndex": 6,
                "plannedToolName": "reasoning",
                "streamId": "dag-reasoning-6-1",
                "firstTimestamp": "2026-08-27T23:51:25.158381+00:00",
                "startedAt": "2026-08-27T23:51:25.158381+00:00",
            },
        }
    )
    invariant.handle_insert(
        {
            "agentId": "agent-1",
            "id": "ac-finished",
            "timestamp": "2026-08-27T23:51:26.433Z",
            "role": "TOOL",
            "text": "Fast Mode cache trajectory ended",
            "metadata": {
                "toolCallId": "post-dag-attempt-completion-1",
                "toolName": "attempt_completion",
                "toolStatus": "FINISHED",
            },
        }
    )

    assert invariant.failure_reason is None


def test_no_hanging_tool_calls_ignores_older_assistant_delivered_late():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_tool_record("agent-1", "IN_PROGRESS"))
    invariant.handle_insert(_assistant_record("agent-1", "2025-12-31T23:59:59Z"))

    assert invariant.failure_reason is None


def test_realtime_log_collector_records_and_filters_frames():
    from benchmarks.logs import SupabaseRealtimeLogCollector

    collector = SupabaseRealtimeLogCollector(private=False)
    collector.record_broadcast(
        "agent-1",
        "ASSISTANT_STREAM",
        {"payload": {"record": {"agentId": "agent-1", "stream_id": "s1", "delta": "thinking", "is_gpt": True}}},
    )
    collector.record_broadcast(
        "agent-2",
        "TOOL_STREAM",
        {"payload": {"record": {"agentId": "agent-2", "tool_call_id": "tc-2"}}},
    )

    logs = collector.get_logs_for_agent("agent-1")
    assert len(logs) == 1
    assert '"event":"ASSISTANT_STREAM"' in logs[0]
    assert '"is_gpt":true' in logs[0]
    assert "agent-2" not in logs[0]


async def run_all_tests():
    print("realtime_monitor blackbox tests:")
    r = BlackboxResult()
    r.record(
        "no_hanging_tool_calls_flags_assistant_after_open_tool",
        test_no_hanging_tool_calls_flags_assistant_after_open_tool,
    )
    r.record("output_attachment_during_wait_is_not_parent_turn", test_output_attachment_during_wait_is_not_parent_turn)
    r.record(
        "snapshot_reconcile_reads_api_message_shape_for_child_artifacts",
        test_snapshot_reconcile_reads_api_message_shape_for_child_artifacts,
    )
    r.record(
        "code_agent_display_mirror_during_open_tool_is_not_parent_turn",
        test_code_agent_display_mirror_during_open_tool_is_not_parent_turn,
    )
    r.record(
        "own_display_call_posting_its_page_is_not_a_turn",
        test_own_display_call_posting_its_page_is_not_a_turn,
    )
    r.record("attachment_marker_cannot_hide_authored_assistant_turn", test_attachment_marker_cannot_hide_authored_assistant_turn)
    r.record(
        "no_hanging_tool_calls_allows_finished_before_assistant",
        test_no_hanging_tool_calls_allows_finished_before_assistant,
    )
    r.record(
        "no_hanging_tool_calls_allows_late_in_progress_after_finished",
        test_no_hanging_tool_calls_allows_late_in_progress_after_finished,
    )
    r.record(
        "no_hanging_tool_calls_allows_assistant_while_spawn_agent_runs",
        test_no_hanging_tool_calls_allows_assistant_while_spawn_agent_runs,
    )
    r.record("no_hanging_tool_calls_ignores_other_agents", test_no_hanging_tool_calls_ignores_other_agents)
    r.record(
        "no_hanging_tool_calls_ignores_subagent_internal_tools",
        test_no_hanging_tool_calls_ignores_subagent_internal_tools,
    )
    r.record(
        "no_hanging_tool_calls_closes_on_bounded_finished_notice",
        test_no_hanging_tool_calls_closes_on_bounded_finished_notice,
    )
    r.record(
        "no_hanging_tool_calls_ignores_declaring_assistant",
        test_no_hanging_tool_calls_ignores_declaring_assistant,
    )
    r.record(
        "no_hanging_tool_calls_snapshot_reconcile_clears_missed_finished_frame",
        test_no_hanging_tool_calls_snapshot_reconcile_clears_missed_finished_frame,
    )
    r.record(
        "no_hanging_tool_calls_ignores_older_assistant_delivered_late",
        test_no_hanging_tool_calls_ignores_older_assistant_delivered_late,
    )
    r.record(
        "no_hanging_tool_calls_ignores_late_dag_reasoning_flush",
        test_no_hanging_tool_calls_ignores_late_dag_reasoning_flush,
    )
    r.record(
        "realtime_log_collector_records_and_filters_frames",
        test_realtime_log_collector_records_and_filters_frames,
    )
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
