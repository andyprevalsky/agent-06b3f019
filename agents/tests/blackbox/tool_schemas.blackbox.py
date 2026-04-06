"""Blackbox tests for tool_schemas domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_tool_models_has_all_tools():
    """TOOL_MODELS dict has keys for known core tools."""
    from helpers.tool_schemas import TOOL_MODELS

    expected_tools = [
        "web_search", "web_fetch", "spawn_agent", "attempt_completion",
        "send_message_to_user", "wait_for", "message_person", "set_plan",
        "deep_research", "grep", "add_memory", "read_memories",
    ]

    for tool_name in expected_tools:
        assert tool_name in TOOL_MODELS, f"Expected '{tool_name}' in TOOL_MODELS"


def test_plan_phase_tools_subset():
    """PLAN_PHASE_TOOLS is a subset of TOOL_MODELS keys."""
    from helpers.tool_schemas import PLAN_PHASE_TOOLS, TOOL_MODELS

    for tool_name in PLAN_PHASE_TOOLS:
        assert tool_name in TOOL_MODELS, (
            f"PLAN_PHASE_TOOLS contains '{tool_name}' which is not in TOOL_MODELS"
        )


def test_execute_phase_tools_subset():
    """EXECUTE_PHASE_TOOLS is a subset of TOOL_MODELS keys."""
    from helpers.tool_schemas import EXECUTE_PHASE_TOOLS, TOOL_MODELS

    for tool_name in EXECUTE_PHASE_TOOLS:
        assert tool_name in TOOL_MODELS, (
            f"EXECUTE_PHASE_TOOLS contains '{tool_name}' which is not in TOOL_MODELS"
        )


def test_create_agent_action_model():
    """create_agent_action_model returns a Pydantic model class."""
    from helpers.tool_schemas import create_agent_action_model

    Model = create_agent_action_model(["web_search", "attempt_completion"])

    # Should be a class with tool_calls field
    assert hasattr(Model, "model_fields")
    assert "tool_calls" in Model.model_fields

    # Should be instantiable with response and empty tool_calls
    instance = Model(response="Thinking about next steps", tool_calls=[])
    assert instance.tool_calls == []
    assert instance.response == "Thinking about next steps"


def test_create_agent_action_model_single_tool():
    """create_agent_action_model works with a single tool."""
    from helpers.tool_schemas import create_agent_action_model

    Model = create_agent_action_model(["attempt_completion"])

    assert "tool_calls" in Model.model_fields
    assert "response" in Model.model_fields
    instance = Model(response="Evaluating completion", tool_calls=[])
    assert instance.tool_calls == []


def test_planner_assignable_tools():
    """PLANNER_ASSIGNABLE_TOOLS contains expected planner-specific tool names."""
    from helpers.tool_schemas import PLANNER_ASSIGNABLE_TOOLS

    assert "spawn_explore_agent" in PLANNER_ASSIGNABLE_TOOLS
    assert "spawn_browser_agent" in PLANNER_ASSIGNABLE_TOOLS
    assert "spawn_code_agent" in PLANNER_ASSIGNABLE_TOOLS
    assert "reasoning" in PLANNER_ASSIGNABLE_TOOLS


async def run_all_tests():
    print("tool-schemas blackbox tests:")
    r = BlackboxResult()
    r.record("tool_models_has_all_tools", test_tool_models_has_all_tools)
    r.record("plan_phase_tools_subset", test_plan_phase_tools_subset)
    r.record("execute_phase_tools_subset", test_execute_phase_tools_subset)
    r.record("create_agent_action_model", test_create_agent_action_model)
    r.record("create_agent_action_model_single_tool", test_create_agent_action_model_single_tool)
    r.record("planner_assignable_tools", test_planner_assignable_tools)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
