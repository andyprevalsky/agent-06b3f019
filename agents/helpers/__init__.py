"""Helper activities for workflow orchestration (not exposed to LLM)."""

from temporalio import workflow

# These exports are activities and shared supporting helpers.
# Importing a pure helpers submodule also executes this package initializer;
# reuse the host definitions just as AgentWorkflow's activity import block does.
# The package itself and unlisted workflow helpers still load in the sandbox.
with workflow.unsafe.imports_passed_through():
    from .check_usage import check_user_usage
    from .child_results import fetch_child_terminal_result_activity
    from .demo_cache_goal import (
        resolve_fast_cache_context_activity,
        resolve_fast_cache_goal_activity,
        unpack_demo_cache_goal_resolution,
    )
    from .fetch_config import fetch_agent_config
    from .fetch_queue_pointer import fetch_agent_queue_pointer
    from .fetch_tools import fetch_agent_tools

    # query_blueprints and save_blueprint imported directly by worker from knowledge_base_v2
    from .finished import mark_finished
    from .get_user_context import get_user_context, get_user_custom_system_prompt, get_user_system_name
    from .messages import poll_new_messages, post_agent_message, stream_assistant_chunk
    from .model_info import get_model_context_window
    from .model_pricing import fetch_model_pricing
    from .summarize import compress_context, generate_completion_summary, summarize_tool_result
    from .update_status import update_agent_status
    from .workflow_replacement import (
        acknowledge_workflow_replacement_bootstrap,
        finalize_workflow_replacement_bootstrap,
    )

__all__ = [
    "fetch_agent_tools",
    "poll_new_messages",
    "post_agent_message",
    "stream_assistant_chunk",
    "call_llm",
    "check_progress",
    "call_llm_activity",
    "update_agent_status",
    "compress_context",
    "generate_completion_summary",
    "summarize_tool_result",
    "get_model_context_window",
    "mark_finished",
    "fetch_agent_config",
    "fetch_agent_queue_pointer",
    "fetch_child_terminal_result_activity",
    "resolve_fast_cache_goal_activity",
    "resolve_fast_cache_context_activity",
    "unpack_demo_cache_goal_resolution",
    "check_user_usage",
    "get_user_context",
    "get_user_system_name",
    "get_user_custom_system_prompt",
    "fetch_model_pricing",
    "acknowledge_workflow_replacement_bootstrap",
    "finalize_workflow_replacement_bootstrap",
]


def __getattr__(name: str):
    if name in {"call_llm", "call_llm_activity", "check_progress"}:
        from . import llm

        return getattr(llm, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
