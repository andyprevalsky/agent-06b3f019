"""Blackbox tests for fetch-config domain."""

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


def _setup(**agent_overrides):
    setup_mock({
        "/api/agents/": {
            "status": 200,
            "json": {
                "agent": {
                    **agent_overrides,
                    "id": "agent-1",
                    "model": "rose-1-flash",
                    "reasoning_max_tokens": 256,
                    "status": "ACTIVE",
                    "tools": [{"id": "tool-1"}, {"id": "tool-2"}],
                    "verifier": {"type": "FLOAT_LLM_JUDGE"},
                    "parentAgentId": None,
                    "response_schema": None,
                    "token_in_price_microdollars": 100,
                    "token_out_price_microdollars": 300,
                    "write_lock_enabled": False,
                },
                "messages": [],
            },
        },
    })


async def test_happy_path():
    """fetch_agent_config returns agent config dict with model, status, tool_ids."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.fetch_config import fetch_agent_config

        result = await fetch_agent_config("agent-1")

    assert result["model"] == "rose-1-flash"
    assert result["status"] == "ACTIVE"
    assert result["tool_ids"] == ["tool-1", "tool-2"]
    assert result["write_lock_enabled"] is False


async def test_boundary():
    """Verify GET to /api/agents/{agent_id} with correct headers."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from helpers.fetch_config import fetch_agent_config

        await fetch_agent_config("agent-abc-123")

    call = assert_captured_call(
        url_contains="/api/agents/agent-abc-123",
        method="GET",
        header_present="X-API-Key",
    )


async def test_project_summary_passes_through():
    """The agent's project summary reaches the workflow; a Home agent (or older backend) gets None."""
    project = {"name": "Rose", "repo_url": "https://github.com/Rose-Ai-Labs/rose", "default_branch": "main"}
    from helpers.fetch_config import fetch_agent_config

    for overrides, expected in (({"project": project}, project), ({"project": None}, None), ({}, None)):
        _setup(**overrides)
        with patch("temporalio.activity.heartbeat"):
            result = await fetch_agent_config("agent-1")
        assert result["project"] == expected, (overrides, result.get("project"))


async def run_all_tests():
    print("fetch-config blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_happy_path)
    await r.record_async("boundary", test_boundary)
    await r.record_async("project_summary_passes_through", test_project_summary_passes_through)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
