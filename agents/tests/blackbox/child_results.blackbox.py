"""Blackbox tests for child terminal-result reconstruction helpers."""

import asyncio
from unittest.mock import patch

from _test_utils import BlackboxResult, teardown_mock

from helpers.child_results import (
    _best_effort_text,
    _latest_completion_summary,
    _tool_counts,
    fetch_child_terminal_result_activity,
)


def _summary_message(summary, **metadata):
    return {"metadata": {"completionSummary": summary, **metadata}}


async def test_latest_completion_summary_picks_final():
    messages = [
        _summary_message({"summary": "old"}, isFinalSummary=True),
        {"metadata": None},
        {"metadata": "not-a-dict"},
        _summary_message({"summary": "mid"}),  # no final/tool marker → skipped
        _summary_message({"summary": "new"}, toolName="completion_summary"),
    ]
    assert _latest_completion_summary(messages) == {"summary": "new"}


async def test_latest_completion_summary_empty_when_absent():
    assert _latest_completion_summary([]) == {}
    assert _latest_completion_summary([{"metadata": {"completionSummary": "str"}}]) == {}


async def test_tool_counts_filters_malformed_entries():
    summary = {
        "toolUsage": [
            {"name": "web_search", "count": 3},
            {"name": "web_fetch", "count": "2"},  # non-int count → skipped
            {"name": 7, "count": 1},  # non-str name → skipped
            "not-a-dict",
            {"name": "grep", "count": 1},
        ]
    }
    assert _tool_counts(summary) == {"web_search": 3, "grep": 1}
    assert _tool_counts({}) == {}
    assert _tool_counts({"toolUsage": "nope"}) == {}


async def test_best_effort_text_priority_order():
    agent = {"status_message": "status text", "goal": "the goal"}
    messages = [{"text": "message text"}]
    # 1) completion summary wins
    assert _best_effort_text(agent, messages, {"summary": " summary text "}) == "summary text"
    # 2) then agent status_message
    assert _best_effort_text(agent, messages, {}) == "status text"
    # 3) then latest message text
    assert _best_effort_text({"goal": "g"}, messages, {}) == "message text"
    # 4) then goal fallback
    assert _best_effort_text({"goal": "the goal"}, [], {}) == "Completed: the goal"
    # 5) empty when nothing available
    assert _best_effort_text({}, [{"text": "  "}], {"summary": 42}) == ""


def _agent_data(status, **agent_extra):
    return {
        "agent": {"status": status, "goal": "child goal", **agent_extra},
        "messages": [
            _summary_message(
                {"summary": "did the thing", "toolUsage": [{"name": "web_search", "count": 2}]},
                isFinalSummary=True,
            )
        ],
    }


async def test_activity_returns_none_for_non_terminal():
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.child_results._fetch_agent_data_impl", return_value=_agent_data("ACTIVE")),
    ):
        assert await fetch_child_terminal_result_activity("child-1") is None


async def test_activity_completed_child():
    data = _agent_data("COMPLETED", structured_output={"k": "v"})
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.child_results._fetch_agent_data_impl", return_value=data),
    ):
        result = await fetch_child_terminal_result_activity("child-2")
    assert result == {
        "status": "completed",
        "goal": "child goal",
        "summary": "did the thing",
        "structured_response": {"k": "v"},
        "tool_counts": {"web_search": 2},
    }


async def test_activity_failed_child_merges_partial_structured():
    data = _agent_data(
        "FAILED",
        status_message="Sandbox crashed",
        structured_output={"partial": True},
        failure_context={"reason": "crash"},
    )
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.child_results._fetch_agent_data_impl", return_value=data),
    ):
        result = await fetch_child_terminal_result_activity("child-3")
    assert result["status"] == "failed"
    assert result["error_reason"] == "Sandbox crashed"
    assert result["failure_context"] == {
        "reason": "crash",
        "partial_structured_response": {"partial": True},
    }
    assert result["structured_response"] == {"partial": True}


async def test_activity_returns_none_for_paused_resumable():
    """COST_LIMIT_REACHED / OUT_OF_CREDITS are paused-and-resumable, NOT terminal
    failures. Reporting them as terminal made the parent's for_each fail and
    re-spawn a fresh fan-out on resume, orphaning the paused children. They must
    reconcile to None so the parent keeps waiting until the resumed child finishes."""
    for paused_status in ("COST_LIMIT_REACHED", "OUT_OF_CREDITS"):
        data = _agent_data(
            paused_status,
            status_message="paused: limit reached",
            structured_output={"partial": True},
        )
        with (
            patch("temporalio.activity.heartbeat"),
            patch("helpers.child_results._fetch_agent_data_impl", return_value=data),
        ):
            result = await fetch_child_terminal_result_activity("child-paused")
        assert result is None, f"{paused_status} must reconcile to None (paused, not terminal), got {result}"


async def test_activity_failed_child_defaults():
    data = {"agent": {"status": "FAILED", "goal": "g", "failure_context": "bad-type"}, "messages": None}
    with (
        patch("temporalio.activity.heartbeat"),
        patch("helpers.child_results._fetch_agent_data_impl", return_value=data),
    ):
        result = await fetch_child_terminal_result_activity("child-4")
    assert result["status"] == "failed"
    assert result["error_reason"] == "FAILED"
    assert result["failure_context"] == {}
    assert result["summary"] == "Completed: g"


async def run_all_tests():
    print("child-results blackbox tests:")
    r = BlackboxResult()
    await r.record_async("latest_completion_summary_picks_final", test_latest_completion_summary_picks_final)
    await r.record_async("latest_completion_summary_empty", test_latest_completion_summary_empty_when_absent)
    await r.record_async("tool_counts_filters_malformed", test_tool_counts_filters_malformed_entries)
    await r.record_async("best_effort_text_priority", test_best_effort_text_priority_order)
    await r.record_async("activity_non_terminal_none", test_activity_returns_none_for_non_terminal)
    await r.record_async("activity_completed_child", test_activity_completed_child)
    await r.record_async("activity_failed_merges_partial", test_activity_failed_child_merges_partial_structured)
    await r.record_async("activity_paused_resumable_none", test_activity_returns_none_for_paused_resumable)
    await r.record_async("activity_failed_defaults", test_activity_failed_child_defaults)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
