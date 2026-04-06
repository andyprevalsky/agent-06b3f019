"""Blackbox tests for update-tokens domain."""

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
        "/tokens": {
            "status": 200,
            "json": {"success": True},
        },
        "/api/agents/": {
            "status": 200,
            "json": {"success": True},
        },
    })


async def test_tokens_happy_path():
    """update_agent_tokens_activity sends PATCH to /api/agents/{id}/tokens."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.update_tokens import update_agent_tokens_activity

        await update_agent_tokens_activity(
            agent_id="agent-1",
            tokens_in=500,
            tokens_out=200,
        )

    call = assert_captured_call(
        url_contains="/api/agents/agent-1/tokens",
        method="PATCH",
        header_present="X-API-Key",
    )


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


async def test_boundary():
    """Verify correct PATCH bodies for both token and cost updates."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.update_tokens import update_agent_tokens_activity

        await update_agent_tokens_activity(
            agent_id="agent-3",
            tokens_in=1000,
            tokens_out=500,
        )

    call = assert_captured_call(
        url_contains="/api/agents/agent-3/tokens",
        method="PATCH",
    )
    body = json.loads(call["requestBody"])
    assert body["tokensIn"] == 1000
    assert body["tokensOut"] == 500
    assert body["tokenCount"] == 1500  # tokens_in + tokens_out


async def run_all_tests():
    print("update-tokens blackbox tests:")
    r = BlackboxResult()
    await r.record_async("tokens_happy_path", test_tokens_happy_path)
    await r.record_async("tree_cost_happy_path", test_tree_cost_happy_path)
    await r.record_async("boundary", test_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
