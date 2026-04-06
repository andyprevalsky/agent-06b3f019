"""Blackbox tests for param_populator domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    teardown_mock,
    assert_captured_call,
    setup_mock_fn,
)


def test_build_prompt_basic():
    """_build_agent_system_prompt returns non-empty string containing the goal."""
    from activities.param_populator import _build_agent_system_prompt

    result = _build_agent_system_prompt("web_search", "Find AI trends")

    assert isinstance(result, str)
    assert len(result) > 0
    assert "Find AI trends" in result


def test_build_prompt_spawn_agent():
    """_build_agent_system_prompt with spawn_explore_agent alias includes explore instructions."""
    from activities.param_populator import _build_agent_system_prompt

    result = _build_agent_system_prompt("spawn_agent", "Research competitors", alias_hint="spawn_explore_agent")

    assert 'type="explore"' in result
    assert "explore" in result.lower()


def test_build_prompt_spawn_sub_agent():
    """_build_agent_system_prompt with spawn_sub_agent alias includes sub-agent instructions."""
    from activities.param_populator import _build_agent_system_prompt

    result = _build_agent_system_prompt("spawn_agent", "Complete the task", alias_hint="spawn_sub_agent")

    assert "verifier" in result.lower() or "output_schema" in result.lower()
    assert "sub_agent" in result or "sub-agent" in result.lower()


def test_build_prompt_contains_tool_name():
    """_build_agent_system_prompt mentions the tool name in the prompt."""
    from activities.param_populator import _build_agent_system_prompt

    result = _build_agent_system_prompt("web_search", "Find things")

    assert "web_search" in result


async def run_all_tests():
    print("param-populator blackbox tests:")
    r = BlackboxResult()
    r.record("build_prompt_basic", test_build_prompt_basic)
    r.record("build_prompt_spawn_agent", test_build_prompt_spawn_agent)
    r.record("build_prompt_spawn_sub_agent", test_build_prompt_spawn_sub_agent)
    r.record("build_prompt_contains_tool_name", test_build_prompt_contains_tool_name)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
