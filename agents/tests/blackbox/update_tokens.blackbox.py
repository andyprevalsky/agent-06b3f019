"""Blackbox tests for update-tokens domain."""

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "/api/agents/": {
            "status": 200,
            "json": {"success": True},
        },
    })


async def test_tree_cost_happy_path():
    """update_agent_tree_cost_activity sends PATCH to /api/agents/{id}."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.update_tokens import update_agent_tree_cost_activity

        await update_agent_tree_cost_activity(
            agent_id="agent-2",
            tree_cost_cents=150,
            own_cost_cents=50.0,
        )

    call = assert_captured_call(
        url_contains="/api/agents/agent-2",
        method="PATCH",
        header_present="X-API-Key",
    )


async def test_cost_update_stamps_workflow_generation():
    """Cost mutations identify the workflow generation that calculated them."""
    _setup()
    generation = "agent-accounting:replacement:generation-2"
    with (
        patch("temporalio.activity.heartbeat"),
        patch(
            "temporalio.activity.info",
            return_value=SimpleNamespace(workflow_id=generation),
        ),
    ):
        from helpers.update_tokens import update_agent_tree_cost_activity

        await update_agent_tree_cost_activity(
            agent_id="agent-accounting",
            tree_cost_cents=42,
            own_cost_cents=21.5,
        )

    cost_call = assert_captured_call(
        index=0,
        url_contains="/api/agents/agent-accounting",
        method="PATCH",
    )
    assert cost_call["requestHeaders"]["x-agent-workflow-generation"] == generation


async def test_boundary():
    """Verify the cost PATCH body uses the real Agent config endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.update_tokens import update_agent_tree_cost_activity

        await update_agent_tree_cost_activity(
            agent_id="agent-3",
            tree_cost_cents=150,
            own_cost_cents=42.5,
        )

    call = assert_captured_call(
        url_contains="/api/agents/agent-3",
        method="PATCH",
    )
    assert '"tree_cost_cents":150' in call["requestBody"]
    assert '"own_cost_cents":42.5' in call["requestBody"]


async def run_all_tests():
    print("update-tokens blackbox tests:")
    r = BlackboxResult()
    await r.record_async("tree_cost_happy_path", test_tree_cost_happy_path)
    await r.record_async(
        "cost_update_stamps_workflow_generation",
        test_cost_update_stamps_workflow_generation,
    )
    await r.record_async("boundary", test_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(run_all_tests()) else 1)
