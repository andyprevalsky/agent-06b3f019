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


def test_no_hanging_tool_calls_flags_assistant_after_open_tool():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_tool_record("agent-1", "IN_PROGRESS"))
    invariant.handle_insert(
        {
            "agentId": "agent-1",
            "id": "assistant-1",
            "timestamp": "2026-01-01T00:00:01Z",
            "role": "ASSISTANT",
            "text": "next turn",
        }
    )

    assert invariant.failure_reason is not None
    assert "unresolved tool web_search" in invariant.failure_reason


def test_no_hanging_tool_calls_allows_finished_before_assistant():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_tool_record("agent-1", "IN_PROGRESS"))
    invariant.handle_insert(_tool_record("agent-1", "FINISHED"))
    invariant.handle_insert(
        {
            "agentId": "agent-1",
            "id": "assistant-1",
            "timestamp": "2026-01-01T00:00:01Z",
            "role": "ASSISTANT",
            "text": "next turn",
        }
    )

    assert invariant.failure_reason is None


def test_no_hanging_tool_calls_ignores_other_agents():
    from benchmarks.realtime_monitor import NoHangingToolCallsInvariant

    invariant = NoHangingToolCallsInvariant("agent-1")
    invariant.handle_insert(_tool_record("agent-2", "IN_PROGRESS"))
    invariant.handle_insert(
        {
            "agentId": "agent-1",
            "id": "assistant-1",
            "timestamp": "2026-01-01T00:00:01Z",
            "role": "ASSISTANT",
            "text": "next turn",
        }
    )

    assert invariant.failure_reason is None


async def run_all_tests():
    print("realtime_monitor blackbox tests:")
    r = BlackboxResult()
    r.record(
        "no_hanging_tool_calls_flags_assistant_after_open_tool",
        test_no_hanging_tool_calls_flags_assistant_after_open_tool,
    )
    r.record(
        "no_hanging_tool_calls_allows_finished_before_assistant",
        test_no_hanging_tool_calls_allows_finished_before_assistant,
    )
    r.record("no_hanging_tool_calls_ignores_other_agents", test_no_hanging_tool_calls_ignores_other_agents)
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
