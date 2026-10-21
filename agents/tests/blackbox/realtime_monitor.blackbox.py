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
