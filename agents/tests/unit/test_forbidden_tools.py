"""Unit tests for benchmark forbidden_tools runtime enforcement."""

from workflows.agent_workflow import AgentWorkflow


def test_effective_forbidden_tool_name_maps_spawn_agent_aliases():
    assert (
        AgentWorkflow._effective_forbidden_tool_name("spawn_agent", {"type": "code"})
        == "spawn_claude_code_agent"
    )
    assert (
        AgentWorkflow._effective_forbidden_tool_name("spawn_agent", {"type": "general_purpose"})
        == "spawn_general_purpose_agent"
    )
    assert (
        AgentWorkflow._effective_forbidden_tool_name("spawn_agent", {"type": "for_each"})
        == "spawn_general_purpose_agent_for_each"
    )
    assert AgentWorkflow._effective_forbidden_tool_name("api_request", {}) == "api_request"
