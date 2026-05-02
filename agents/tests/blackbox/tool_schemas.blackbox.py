"""Blackbox tests for tool_schemas domain."""

import asyncio

import pytest

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def _assert_raises(fn, match):
    try:
        fn()
    except Exception as e:
        assert match in str(e), f"Expected '{match}' in error, got: {e}"
        return
    raise AssertionError(f"Expected exception containing '{match}'")


def test_tool_models_has_all_tools():
    """TOOL_MODELS dict has keys for known core tools."""
    from utils.tool_schemas import TOOL_MODELS

    expected_tools = [
        "web_search", "web_fetch", "spawn_agent", "attempt_completion",
        "send_message_to_user", "wait_for", "message_person", "set_plan",
        "grep",
    ]

    for tool_name in expected_tools:
        assert tool_name in TOOL_MODELS, f"Expected '{tool_name}' in TOOL_MODELS"


def test_plan_phase_tools_subset():
    """PLAN_PHASE_TOOLS is a subset of TOOL_MODELS keys."""
    from utils.tool_schemas import PLAN_PHASE_TOOLS, TOOL_MODELS

    for tool_name in PLAN_PHASE_TOOLS:
        assert tool_name in TOOL_MODELS, (
            f"PLAN_PHASE_TOOLS contains '{tool_name}' which is not in TOOL_MODELS"
        )


def test_execute_phase_tools_subset():
    """EXECUTE_PHASE_TOOLS is a subset of TOOL_MODELS keys."""
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, TOOL_MODELS

    for tool_name in EXECUTE_PHASE_TOOLS:
        assert tool_name in TOOL_MODELS, (
            f"EXECUTE_PHASE_TOOLS contains '{tool_name}' which is not in TOOL_MODELS"
        )


def test_all_phase_tools_superset():
    """ALL_PHASE_TOOLS contains every tool from both phases."""
    from utils.tool_schemas import ALL_PHASE_TOOLS, EXECUTE_PHASE_TOOLS, PLAN_PHASE_TOOLS, TOOL_MODELS

    for tool_name in PLAN_PHASE_TOOLS:
        assert tool_name in ALL_PHASE_TOOLS
    for tool_name in EXECUTE_PHASE_TOOLS:
        assert tool_name in ALL_PHASE_TOOLS
    for tool_name in ALL_PHASE_TOOLS:
        assert tool_name in TOOL_MODELS, (
            f"ALL_PHASE_TOOLS contains '{tool_name}' which is not in TOOL_MODELS"
        )


def test_create_agent_action_model():
    """create_agent_action_model returns a Pydantic model class."""
    from utils.tool_schemas import create_agent_action_model

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
    from utils.tool_schemas import create_agent_action_model

    Model = create_agent_action_model(["attempt_completion"])

    assert "tool_calls" in Model.model_fields
    assert "response" in Model.model_fields
    instance = Model(response="Evaluating completion", tool_calls=[])
    assert instance.tool_calls == []


def test_planner_assignable_tools():
    """PLANNER_ASSIGNABLE_TOOLS contains expected planner-specific tool names."""
    from utils.tool_schemas import PLANNER_ASSIGNABLE_TOOLS

    assert "spawn_explore_agent" in PLANNER_ASSIGNABLE_TOOLS
    assert "spawn_browser_agent" in PLANNER_ASSIGNABLE_TOOLS
    assert "spawn_code_agent" in PLANNER_ASSIGNABLE_TOOLS
    assert "reasoning" in PLANNER_ASSIGNABLE_TOOLS


# ── WaitForTool validation ─────────────────────────────────────────────


def test_wait_for_tool_mutually_exclusive_raises():
    """WaitForTool rejects both until_timestamp and condition together."""
    from utils.tool_schemas import WaitForTool

    _assert_raises(
        lambda: WaitForTool(
            tool="wait_for", until_timestamp="2026-01-01T00:00:00Z", condition="when ready"
        ),
        "mutually exclusive",
    )


def test_wait_for_tool_neither_raises():
    """WaitForTool requires either until_timestamp or condition."""
    from utils.tool_schemas import WaitForTool

    _assert_raises(lambda: WaitForTool(tool="wait_for"), "must be provided")


def test_wait_for_tool_with_timestamp_only():
    """WaitForTool accepts until_timestamp alone."""
    from utils.tool_schemas import WaitForTool

    t = WaitForTool(tool="wait_for", until_timestamp="2026-01-01T00:00:00Z")
    assert t.until_timestamp == "2026-01-01T00:00:00Z"
    assert t.condition is None


def test_wait_for_tool_with_condition_only():
    """WaitForTool accepts condition alone."""
    from utils.tool_schemas import WaitForTool

    t = WaitForTool(tool="wait_for", condition="When the user replies")
    assert t.condition == "When the user replies"
    assert t.until_timestamp is None


# ── WebFetchTool validation ───────────────────────────────────────────


def test_web_fetch_tool_full_content_overrides_excerpts():
    """WebFetchTool sets excerpts=False when full_content is True."""
    from utils.tool_schemas import WebFetchTool

    t = WebFetchTool(
        tool="web_fetch",
        url="https://example.com",
        objective="get content",
        full_content=True,
        excerpts=True,
    )
    # validator silently flips excerpts to False
    assert t.excerpts is False
    assert t.full_content is True


def test_web_fetch_tool_default_mode():
    """WebFetchTool default has excerpts=True, full_content=False."""
    from utils.tool_schemas import WebFetchTool

    t = WebFetchTool(tool="web_fetch", url="https://example.com", objective="get content")
    assert t.excerpts is True
    assert t.full_content is False


# ── SpawnAgentTool model_validator ────────────────────────────────────

LONG_GOAL = (
    "Research the topic in depth and produce a structured report covering history, current state, "
    "and future outlook of the technology with citations."
)


def test_spawn_agent_browser_missing_url_raises():
    """SpawnAgentTool browser without start_url raises."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            type="browser",
            goal=LONG_GOAL,
            output_schema=schema,
        ),
        "start_url",
    )


def test_spawn_agent_subagent_missing_phase_raises():
    """SpawnAgentTool sub_agent without start_phase raises."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            type="sub_agent",
            goal=LONG_GOAL,
            output_schema=schema,
        ),
        "start_phase",
    )


def test_spawn_agent_for_each_items_and_csv_raises():
    """SpawnAgentTool for_each rejects both items and items_csv."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            type="for_each",
            goal=LONG_GOAL,
            output_schema=schema,
            start_phase="plan",
            items=["a"],
            items_csv="x,y",
        ),
        "mutually exclusive",
    )


def test_spawn_agent_for_each_no_items_raises():
    """SpawnAgentTool for_each requires items or items_csv."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            type="for_each",
            goal=LONG_GOAL,
            output_schema=schema,
            start_phase="plan",
        ),
        "items",
    )


def test_spawn_agent_browser_no_schema_raises():
    """SpawnAgentTool browser/code/sub_agent/for_each requires output_schema."""
    from utils.tool_schemas import SpawnAgentTool

    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            type="browser",
            goal=LONG_GOAL,
            start_url="https://example.com",
        ),
        "output_schema",
    )


def test_spawn_agent_explore_with_schema_raises():
    """SpawnAgentTool explore must not have output_schema."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            type="explore",
            goal=LONG_GOAL,
            output_schema=schema,
        ),
        "output_schema",
    )


def test_spawn_agent_short_goal_raises():
    """SpawnAgentTool requires goal >=50 chars for non-explore types."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            type="sub_agent",
            goal="short",
            output_schema=schema,
            start_phase="plan",
        ),
        ">=50 chars",
    )


def test_spawn_agent_browser_valid():
    """SpawnAgentTool browser with all required fields passes."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="result", type="str", required=True, description="d")]
    )
    t = SpawnAgentTool(
        tool="spawn_agent",
        type="browser",
        goal=LONG_GOAL,
        output_schema=schema,
        start_url="https://example.com",
    )
    assert t.type == "browser"


# ── render_tool_list ──────────────────────────────────────────────────


def test_render_tool_list_empty_registry():
    """render_tool_list returns empty string for empty registry."""
    from utils.tool_schemas import render_tool_list

    assert render_tool_list({}) == ""


def test_render_tool_list_sorted():
    """render_tool_list produces sorted, deterministic output."""
    from utils.tool_schemas import TOOL_MODELS, render_tool_list

    out = render_tool_list(TOOL_MODELS)
    lines = out.split("\n")
    # All non-empty
    assert all(line.startswith("- ") for line in lines)
    # Sorted by name
    names = [line.split(":")[0][2:] for line in lines]
    assert names == sorted(names)


def test_render_tool_list_unsorted():
    """render_tool_list with sort=False preserves insertion order."""
    from utils.tool_schemas import TOOL_MODELS, render_tool_list

    out = render_tool_list(TOOL_MODELS, sort=False)
    lines = out.split("\n")
    names = [line.split(":")[0][2:] for line in lines]
    # Insertion order is the keys order of TOOL_MODELS
    assert names == list(TOOL_MODELS.keys())


def test_render_tool_list_uses_docstring_fallback():
    """render_tool_list falls back to docstring when no PROMPT fragment."""
    from pydantic import BaseModel
    from utils.tool_schemas import render_tool_list

    class _NoDocTool(BaseModel):
        """First line of docstring is used."""

        x: int = 1

    class _NoDocstringTool(BaseModel):
        x: int = 1

    out = render_tool_list({"docked": _NoDocTool, "_silent": _NoDocstringTool}, sort=True)
    lines = out.split("\n")
    # docstring tool line includes "First line"
    assert any("First line of docstring" in line for line in lines)
    # tool with no docstring -> "No description" fallback
    assert any("No description" in line for line in lines)


def test_first_nonempty_line_handles_blank_text():
    """_first_nonempty_line returns '' when input has no non-empty lines."""
    from utils.tool_schemas import _first_nonempty_line

    assert _first_nonempty_line("") == ""
    assert _first_nonempty_line("\n\n") == ""
    assert _first_nonempty_line("   \n  hello  \n") == "hello"


# ── create_agent_action_model edge cases ─────────────────────────────


def test_create_agent_action_model_unknown_tool_skipped():
    """Unknown tool name is skipped (logger.warning), not raised."""
    from utils.tool_schemas import create_agent_action_model

    Model = create_agent_action_model(["nope_no_such_tool", "attempt_completion"])
    # Still produces a model
    instance = Model(response="ok", tool_calls=[])
    assert instance.response == "ok"


def test_create_agent_action_model_no_tools_available():
    """Empty/all-unknown tool list yields a model that accepts no tool calls."""
    from utils.tool_schemas import create_agent_action_model

    Model = create_agent_action_model(["nope_only"])
    instance = Model(response="thinking", tool_calls=[])
    assert instance.tool_calls == []


def test_create_agent_action_model_custom_registry():
    """Custom registry overrides TOOL_MODELS."""
    from pydantic import BaseModel, Field
    from typing import Literal
    from utils.tool_schemas import create_agent_action_model

    class _CustomTool(BaseModel):
        tool: Literal["custom"]
        name: str = Field(description="x")

    Model = create_agent_action_model(["custom"], tool_registry={"custom": _CustomTool})
    inst = Model(response="ok", tool_calls=[{"tool": "custom", "name": "x"}])
    assert inst.tool_calls[0].name == "x"


async def run_all_tests():
    print("tool-schemas blackbox tests:")
    r = BlackboxResult()
    r.record("tool_models_has_all_tools", test_tool_models_has_all_tools)
    r.record("plan_phase_tools_subset", test_plan_phase_tools_subset)
    r.record("execute_phase_tools_subset", test_execute_phase_tools_subset)
    r.record("create_agent_action_model", test_create_agent_action_model)
    r.record("create_agent_action_model_single_tool", test_create_agent_action_model_single_tool)
    r.record("planner_assignable_tools", test_planner_assignable_tools)
    # WaitForTool validation
    r.record("wait_for_mutually_exclusive", test_wait_for_tool_mutually_exclusive_raises)
    r.record("wait_for_neither", test_wait_for_tool_neither_raises)
    r.record("wait_for_with_timestamp", test_wait_for_tool_with_timestamp_only)
    r.record("wait_for_with_condition", test_wait_for_tool_with_condition_only)
    # WebFetchTool validation
    r.record("web_fetch_full_overrides", test_web_fetch_tool_full_content_overrides_excerpts)
    r.record("web_fetch_default", test_web_fetch_tool_default_mode)
    # SpawnAgentTool model_validator
    r.record("spawn_agent_browser_no_url", test_spawn_agent_browser_missing_url_raises)
    r.record("spawn_agent_subagent_no_phase", test_spawn_agent_subagent_missing_phase_raises)
    r.record("spawn_agent_for_each_both", test_spawn_agent_for_each_items_and_csv_raises)
    r.record("spawn_agent_for_each_neither", test_spawn_agent_for_each_no_items_raises)
    r.record("spawn_agent_browser_no_schema", test_spawn_agent_browser_no_schema_raises)
    r.record("spawn_agent_explore_with_schema", test_spawn_agent_explore_with_schema_raises)
    r.record("spawn_agent_short_goal", test_spawn_agent_short_goal_raises)
    r.record("spawn_agent_browser_valid", test_spawn_agent_browser_valid)
    # render_tool_list
    r.record("render_tool_list_empty", test_render_tool_list_empty_registry)
    r.record("render_tool_list_sorted", test_render_tool_list_sorted)
    r.record("render_tool_list_unsorted", test_render_tool_list_unsorted)
    r.record("render_tool_list_docstring", test_render_tool_list_uses_docstring_fallback)
    r.record("first_nonempty_line", test_first_nonempty_line_handles_blank_text)
    # create_agent_action_model edges
    r.record("create_action_unknown_tool", test_create_agent_action_model_unknown_tool_skipped)
    r.record("create_action_no_tools", test_create_agent_action_model_no_tools_available)
    r.record("create_action_custom_registry", test_create_agent_action_model_custom_registry)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
