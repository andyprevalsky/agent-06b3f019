"""Blackbox tests for save-tool-usage domain."""

import asyncio
import json
from types import SimpleNamespace
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
        "/api/tool-usage": {
            "status": 200,
            "json": {"success": True},
        },
    })


async def test_happy_path():
    """save_tool_usage sends POST to /api/tool-usage."""
    _setup()
    with (
        patch("temporalio.activity.heartbeat"),
        patch(
            "temporalio.activity.info",
            return_value=SimpleNamespace(
                workflow_id="workflow-1",
                workflow_run_id="run-1",
                activity_id="activity-1",
            ),
        ),
    ):
        from helpers.save_tool_usage import save_tool_usage

        await save_tool_usage(
            agent_id="agent-1",
            user_id="user-42",
            tool_name="web_search",
            usage_items=[
                {"description": "Web search API call", "cost_cents": 5},
            ],
        )

    call = assert_captured_call(
        url_contains="/api/tool-usage",
        method="POST",
        header_present="X-API-Key",
    )


async def test_boundary():
    """Verify POST body contains agent_id, user_id, tool_name, usage_items, total_cost_cents."""
    _setup()
    with (
        patch("temporalio.activity.heartbeat"),
        patch(
            "temporalio.activity.info",
            return_value=SimpleNamespace(
                workflow_id="workflow-2",
                workflow_run_id="run-2",
                activity_id="activity-2",
            ),
        ),
    ):
        from helpers.save_tool_usage import save_tool_usage

        await save_tool_usage(
            agent_id="agent-99",
            user_id="user-77",
            tool_name="web_search",
            usage_items=[
                {"description": "Search call 1", "cost_cents": 3},
                {"description": "Search call 2", "cost_cents": 7},
            ],
            accounting_checkpoint={
                "token_count": 120,
                "tokens_in": 90,
                "tokens_out": 30,
                "own_cost_cents": 10.5,
            },
        )

    call = assert_captured_call(
        url_contains="/api/tool-usage",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["agent_id"] == "agent-99"
    assert body["user_id"] == "user-77"
    assert body["tool_name"] == "web_search"
    assert body["total_cost_cents"] == 10  # 3 + 7
    assert len(body["usage_items"]) == 2
    assert body["operation_key"] == "workflow-2:run-2:activity-2"
    assert body["accounting_checkpoint"] == {
        "token_count": 120,
        "tokens_in": 90,
        "tokens_out": 30,
        "own_cost_cents": 10.5,
    }


async def test_stamps_workflow_generation():
    """The billing insert identifies the exact workflow generation that produced it."""
    _setup()
    generation = "agent-usage:replacement:generation-2"
    with (
        patch("temporalio.activity.heartbeat"),
        patch(
            "temporalio.activity.info",
            return_value=SimpleNamespace(
                workflow_id=generation,
                workflow_run_id="usage-run",
                activity_id="usage-activity",
            ),
        ),
    ):
        from helpers.save_tool_usage import save_tool_usage

        await save_tool_usage(
            agent_id="agent-usage",
            user_id="user-usage",
            tool_name="execute_loop",
            usage_items=[
                {"type": "llm", "cost_cents": 3, "iteration": 17},
            ],
        )

    call = assert_captured_call(url_contains="/api/tool-usage", method="POST")
    assert call["requestHeaders"]["x-agent-workflow-generation"] == generation


async def run_all_tests():
    print("save-tool-usage blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_happy_path)
    await r.record_async("boundary", test_boundary)
    await r.record_async("stamps_workflow_generation", test_stamps_workflow_generation)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(run_all_tests()) else 1)
