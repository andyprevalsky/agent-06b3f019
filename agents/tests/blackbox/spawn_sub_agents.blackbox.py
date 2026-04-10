"""Blackbox tests for spawn-sub-agents domain."""

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
        "/api/agents": {
            "status": 200,
            "json": {
                "agent_id": "sub-agent-1",
                "temporal_workflow_id": "wf-sub-1",
                "goal": "Research competitors",
                "model": "rose-labs/rose-1-lite",
                "status": "RUNNING",
            },
        },
    })


async def test_spawn_sub_agent_happy_path():
    """spawn_sub_agent_activity creates sub-agents via backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_sub_agents import spawn_sub_agent_activity

        result = await spawn_sub_agent_activity(
            user_id="user-42",
            sub_agents=[{
                "goal": "Research competitors",
                "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "Did they research?"},
            }],
            parent_agent_id="agent-parent",
            parent_workflow_id="wf-parent",
            depth=0,
            parent_is_paused=False,
            parent_model="rose-labs/rose-1-lite",
        )

    assert "agents" in result
    assert result["spawned"] == 1


async def test_spawn_sub_agent_boundary():
    """Verify POST request to backend /api/agents endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_sub_agents import spawn_sub_agent_activity

        await spawn_sub_agent_activity(
            user_id="user-99",
            sub_agents=[{
                "goal": "Find leads",
                "verifier": {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "Were leads found?"},
            }],
            parent_agent_id="agent-parent-2",
            parent_workflow_id="wf-parent-2",
            depth=1,
            parent_is_paused=False,
        )

    call = assert_captured_call(
        index=1,
        url_contains="/api/agents",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["goal"] == "Find leads"
    assert body["parent_agent_id"] == "agent-parent-2"


async def run_all_tests():
    print("spawn-sub-agents blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_spawn_sub_agent_happy_path)
    await r.record_async("boundary", test_spawn_sub_agent_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
