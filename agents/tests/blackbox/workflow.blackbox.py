"""Blackbox tests for workflow, DAG executor, and context utils."""

import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from _test_utils import BlackboxResult, teardown_mock

# ---------------------------------------------------------------------------
# Pure-logic imports (no Temporal sandbox needed)
# ---------------------------------------------------------------------------
from loop.dag_executor import (
    DAGTask,
    TaskDAG,
    TaskState,
    extract_error_message,
    extract_plan_from_context,
)
from loop.context_utils import poll_and_update_context


# ===========================================================================
# 1. DAG Executor pure-logic tests
# ===========================================================================


def test_task_dag_parallel():
    """3-task parallel plan (no deps). All ready immediately; is_complete requires all."""
    plan_data = {
        "tasks": [
            {"goal": "Task A", "tool_name": "web_search"},
            {"goal": "Task B", "tool_name": "web_fetch"},
            {"goal": "Task C", "tool_name": "grep"},
        ],
        "dependencies": {},
        "join": "all",
    }
    dag = TaskDAG(plan_data)

    ready = dag.get_ready_tasks()
    assert len(ready) == 3, f"Expected 3 ready tasks, got {len(ready)}"

    # Complete one -- not yet done (join=all)
    dag.mark_completed(0)
    assert not dag.is_complete(), "Should NOT be complete with only 1 of 3 done"

    # Complete remaining
    dag.mark_completed(1)
    dag.mark_completed(2)
    assert dag.is_complete(), "Should be complete with all 3 done"


def test_usage_model_falls_back_when_cache_provenance_is_unknown():
    """Legacy Fast Mode entries use the literal ``unknown`` provenance value.

    That sentinel must not become an unclassified benchmark usage model; the
    requested pool alias still identifies the credential path for the replay.
    """
    from workflows.agent_workflow import _resolve_usage_model

    requested = "rose-r2-archive-anthropic"
    assert _resolve_usage_model("unknown", requested) == requested
    assert _resolve_usage_model("", requested) == requested
    assert _resolve_usage_model(None, requested) == requested
    assert _resolve_usage_model("gpt-5.6-sol-gpt", requested) == "gpt-5.6-sol-gpt"


def test_task_dag_sequential():
    """3-task sequential chain (0 -> 1 -> 2). Only one ready at a time."""
    plan_data = {
        "tasks": [
            {"goal": "Step 1", "tool_name": "web_search"},
            {"goal": "Step 2", "tool_name": "web_fetch"},
            {"goal": "Step 3", "tool_name": "grep"},
        ],
        "dependencies": {"1": [0], "2": [1]},
        "join": "all",
    }
    dag = TaskDAG(plan_data)

    ready = dag.get_ready_tasks()
    assert len(ready) == 1, f"Expected 1 ready task, got {len(ready)}"
    assert ready[0].index == 0

    dag.mark_completed(0)
    ready = dag.get_ready_tasks()
    assert len(ready) == 1 and ready[0].index == 1, "Task 1 should be ready after 0 completes"

    dag.mark_completed(1)
    ready = dag.get_ready_tasks()
    assert len(ready) == 1 and ready[0].index == 2, "Task 2 should be ready after 1 completes"


def test_task_dag_join_any():
    """3-task plan with join='any'. Completing one makes DAG complete."""
    plan_data = {
        "tasks": [
            {"goal": "Race A", "tool_name": "web_search"},
            {"goal": "Race B", "tool_name": "web_fetch"},
            {"goal": "Race C", "tool_name": "grep"},
        ],
        "dependencies": {},
        "join": "any",
    }
    dag = TaskDAG(plan_data)

    assert not dag.is_complete(), "Should not be complete before any task finishes"

    dag.mark_completed(0)
    assert dag.is_complete(), "Should be complete after 1 task with join=any"


def test_task_dag_has_failed():
    """Mark a task as failed and verify has_failed() returns True."""
    plan_data = {
        "tasks": [
            {"goal": "Task A", "tool_name": "web_search"},
            {"goal": "Task B", "tool_name": "web_fetch"},
        ],
        "dependencies": {},
        "join": "all",
    }
    dag = TaskDAG(plan_data)

    assert not dag.has_failed(), "No failures yet"

    dag.mark_failed(0)
    assert dag.has_failed(), "Should have failed after marking task 0"
    assert not dag.is_complete(), "Should NOT be complete when a task failed"


def test_task_dag_diamond():
    """Diamond DAG: 0 -> (1,2) -> 3. Task 3 waits for both 1 AND 2."""
    plan_data = {
        "tasks": [
            {"goal": "Root", "tool_name": "web_search"},
            {"goal": "Left", "tool_name": "web_fetch"},
            {"goal": "Right", "tool_name": "grep"},
            {"goal": "Join", "tool_name": "web_search"},
        ],
        "dependencies": {"1": [0], "2": [0], "3": [1, 2]},
        "join": "all",
    }
    dag = TaskDAG(plan_data)

    ready = dag.get_ready_tasks()
    assert len(ready) == 1 and ready[0].index == 0, "Only root should be ready"

    dag.mark_completed(0)
    ready = dag.get_ready_tasks()
    indices = sorted(t.index for t in ready)
    assert indices == [1, 2], f"Tasks 1 and 2 should be ready, got {indices}"

    dag.mark_completed(1)
    ready = dag.get_ready_tasks()
    assert len(ready) == 0 or all(t.index != 3 for t in ready), "Task 3 should NOT be ready (task 2 still pending)"

    dag.mark_completed(2)
    ready = dag.get_ready_tasks()
    assert len(ready) == 1 and ready[0].index == 3, "Task 3 should be ready now"


def test_extract_plan_from_context():
    """Extracts plan_data from a set_plan FINISHED message."""
    plan_payload = {
        "tasks": [{"goal": "Do something", "tool_name": "web_search"}],
        "dependencies": {},
        "join": "all",
    }
    context = [
        {"role": "USER", "text": "Find info", "metadata": None},
        {
            "role": "TOOL",
            "text": "Plan created",
            "metadata": {
                "toolName": "set_plan",
                "toolStatus": "FINISHED",
                "data": plan_payload,
            },
        },
        {"role": "ASSISTANT", "text": "Executing plan", "metadata": None},
    ]
    result = extract_plan_from_context(context)
    assert result is not None, "Should find plan"
    assert result["tasks"] == plan_payload["tasks"], "Plan tasks should match"
    assert result["join"] == "all", "Join should be 'all'"


def test_extract_plan_from_context_empty():
    """Empty context returns None."""
    assert extract_plan_from_context([]) is None


def test_extract_error_message_simple():
    """Simple exception returns its message."""
    e = ValueError("something went wrong")
    msg = extract_error_message(e)
    assert "something went wrong" in msg, f"Expected error text, got: {msg}"


def test_extract_error_message_chained():
    """Exception with __cause__ returns the inner message."""
    inner = RuntimeError("actual root cause")
    outer = Exception("wrapper")
    outer.__cause__ = inner
    msg = extract_error_message(outer)
    assert "actual root cause" in msg, f"Expected inner cause text, got: {msg}"


# ===========================================================================
# 2. context_utils pure-logic tests
# ===========================================================================


async def test_poll_and_update_context():
    """poll_and_update_context merges new messages and sorts by timestamp."""
    existing_msg = {
        "role": "USER",
        "text": "Hello",
        "timestamp": "2024-01-01T00:00:01+00:00",
    }
    new_msg_1 = {
        "role": "TOOL",
        "text": "Result 1",
        "timestamp": "2024-01-01T00:00:02+00:00",
    }
    new_msg_2 = {
        "role": "ASSISTANT",
        "text": "Done",
        "timestamp": "2024-01-01T00:00:03+00:00",
    }

    context: List[Dict] = [existing_msg]
    last_checked = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    async def mock_poll(since: datetime) -> List[Dict]:
        return [new_msg_1, new_msg_2]

    updated_last_checked = await poll_and_update_context(mock_poll, context, last_checked)

    assert len(context) == 3, f"Expected 3 messages, got {len(context)}"
    # Verify sorted by timestamp
    timestamps = [m["timestamp"] for m in context]
    assert timestamps == sorted(timestamps), "Messages should be sorted by timestamp"
    # Verify last_checked was updated
    assert updated_last_checked > last_checked, "last_checked should advance"


async def test_poll_and_update_context_filters_subagent_work_and_advances_cursor():
    """Sub-agent and fanout tree rows stay out of context but still advance last_checked."""
    visible_msg = {
        "role": "TOOL",
        "text": "Aggregate parent result",
        "timestamp": "2024-01-01T00:00:02+00:00",
        "metadata": {"toolName": "spawn_general_purpose_agent_for_each", "toolCallId": "tc"},
    }
    tree_msg = {
        "role": "TOOL",
        "text": "Fanout tree row",
        "timestamp": "2024-01-01T00:00:03+00:00",
        "metadata": {"toolName": "spawn_general_purpose_agent", "toolCallId": "tc:0", "subAgentIds": ["child-1"]},
    }
    internal_msg = {
        "role": "TOOL",
        "text": "Child web search trace",
        "timestamp": "2024-01-01T00:00:04+00:00",
        "metadata": {"toolName": "web_search", "subAgentId": "child-1"},
    }

    context: List[Dict] = []
    last_checked = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    async def mock_poll(since: datetime) -> List[Dict]:
        return [visible_msg, tree_msg, internal_msg]

    updated_last_checked = await poll_and_update_context(mock_poll, context, last_checked)

    assert context == [visible_msg], f"Expected only parent-visible message, got {context}"
    assert updated_last_checked.isoformat() == "2024-01-01T00:00:04+00:00"


# ===========================================================================
# 3. AgentWorkflow signal/query tests (Temporal WorkflowEnvironment)
# ===========================================================================

# ---------------------------------------------------------------------------
# Mock activities: use @activity.defn(name="...") to register with the exact
# activity name the workflow expects, while giving the Python function a
# unique mock_ prefix to avoid import collisions with the real modules.
# ---------------------------------------------------------------------------

from temporalio import activity


@activity.defn(name="get_model_context_window")
async def mock_get_model_context_window(model: str) -> int:
    return 100_000


@activity.defn(name="update_agent_status")
async def mock_update_agent_status(
    agent_id: str,
    status: str,
    progress: float,
    status_message: str,
    token_count: int,
    context_size: int,
    message_count: int,
    tokens_in: int = 0,
    tokens_out: int = 0,
    structured_response: Optional[Dict] = None,
) -> None:
    return None


@activity.defn(name="get_agent_source")
async def mock_get_agent_source(agent_id: str) -> str:
    return "WEB"


@activity.defn(name="notify_sms_event_activity")
async def mock_notify_sms_event_activity(user_id: str, event_type: str, agent_id: str, payload: dict) -> None:
    return None


@activity.defn(name="get_user_context")
async def mock_get_user_context(user_id: str, context_gates: Optional[Dict[str, bool]] = None) -> str:
    return "Test user context"


@activity.defn(name="get_user_system_name")
async def mock_get_user_system_name(user_id: str) -> str:
    return "Rose"


@activity.defn(name="get_user_custom_system_prompt")
async def mock_get_user_custom_system_prompt(user_id: str) -> Optional[str]:
    return None


@activity.defn(name="fetch_claude_max_token_activity")
async def mock_fetch_claude_max_token_activity(user_id: str) -> Optional[str]:
    return None


@activity.defn(name="fetch_compute_token_activity")
async def mock_fetch_compute_token_activity(
    user_id: str,
    lineage_key: Optional[str] = None,
    agent_id: Optional[str] = None,
    root_agent_id: Optional[str] = None,
    fast_cache_affinity_key: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    return None


@activity.defn(name="mark_compute_token_rate_limited_activity")
async def mock_mark_compute_token_rate_limited_activity(
    token_type: str,
    source: str,
    user_id: str,
    pool_token_id: Optional[str] = None,
    cooldown_seconds: int = 5 * 60,
    rate_limited_until: Optional[str] = None,
    failure_reason: Optional[str] = None,
) -> None:
    return None


@activity.defn(name="fetch_agent_config")
async def mock_fetch_agent_config(agent_id: str) -> Dict:
    return {"context_gates": {}, "response_schema": None, "write_lock_enabled": True}


@activity.defn(name="fetch_model_pricing")
async def mock_fetch_model_pricing(model: str) -> Dict[str, float]:
    return {"input_cents_per_1k": 0.3, "output_cents_per_1k": 1.5}


@activity.defn(name="post_agent_message")
async def mock_post_agent_message(
    agent_id: str,
    text: str,
    role: str = "ASSISTANT",
    metadata: Optional[Dict[str, Any]] = None,
    file_pointer: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {"id": "msg-mock-1", "message": text, "role": role, "metadata": metadata}


@activity.defn(name="poll_new_messages")
async def mock_poll_new_messages(agent_id: str, last_checked: datetime) -> List[Dict[str, Any]]:
    return []


@activity.defn(name="check_user_usage")
async def mock_check_user_usage(user_id: str) -> dict:
    return {"has_credits": True, "remaining": 100.0, "used": 0.0, "total": 100.0}


@activity.defn(name="save_tool_usage")
async def mock_save_tool_usage(agent_id: str, user_id: str, tool_name: str, usage_items: list) -> None:
    return None


@activity.defn(name="update_agent_tree_state")
async def mock_update_agent_tree_state(
    agent_id: str,
    tools_in_use: List[str],
    bus_id: str = None,
    broadcast_payload: Dict[str, Any] = None,
) -> None:
    return None


@activity.defn(name="generate_completion_summary")
async def mock_generate_completion_summary(
    context: List[Dict[str, Any]],
    goal: str,
    model: str = "rose-labs/rose-1-lite",
    structured_response: Dict[str, Any] = None,
    output_schema: Dict[str, Any] = None,
    sub_agent_tool_counts: Dict[str, int] = None,
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    return {"summary": "Test summary", "usage": {}, "tool_counts": {}}


@activity.defn(name="mark_finished")
async def mock_mark_finished(
    agent_id: str,
    steps_taken: list,
    token_count: int = 0,
    context_size: int = 0,
    message_count: int = 0,
    tokens_in: int = 0,
    tokens_out: int = 0,
    summary: str = "",
    structured_response: Optional[Dict] = None,
) -> Dict:
    return {"summary": summary or "Done", "status": "completed"}


@activity.defn(name="compress_context")
async def mock_compress_context(
    context: list,
    iteration_count: int,
    model: str = "rose-labs/rose-1-lite",
) -> Dict:
    return {"learnings": "compressed learnings", "usage": {}}


@activity.defn(name="update_agent_tree_cost_activity")
async def mock_update_agent_tree_cost_activity(agent_id: str, tree_cost_cents: int, own_cost_cents: float = 0) -> None:
    return None


@activity.defn(name="update_agent_tokens_activity")
async def mock_update_agent_tokens_activity(agent_id: str, tokens_in: int, tokens_out: int) -> None:
    return None


# Captures the Fast Mode cache args the workflow threads into LLM activities,
# keyed by agent_id. Tests clear their agent's entry before starting.
FAST_MODE_GOAL_CAPTURE: Dict[str, List[Optional[str]]] = {}


@activity.defn(name="resolve_fast_cache_goal_activity")
async def mock_resolve_fast_cache_goal_activity(agent_id: str) -> Optional[str]:
    return "Persisted DB goal"


@activity.defn(name="call_llm_activity")
async def mock_call_llm_activity(
    messages_or_agent_id: Any,
    model: str,
    tool_names: List[str],
    reasoning_max_tokens: int = 256,
    agent_id: Optional[str] = None,
    stream_id: Optional[str] = None,
    task_id: Optional[str] = None,
    claude_token: Optional[str] = None,
    call_site: str = "unknown",
    system_prompt: Optional[str] = None,
    extra_user_message: Optional[str] = None,
    required_tool: Optional[str] = None,
    skip_cache_write: bool = False,
    llm_only_user_preamble: str = "",
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    compute_token_lineage_key: Optional[str] = None,
    compute_token_fast_cache_affinity_key: Optional[str] = None,
    user_id: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_step: Optional[int] = None,
    *args: Any,
    **kwargs: Any,
) -> Dict[str, Any]:
    """Mock LLM activity that returns an attempt_completion tool call to end the loop.

    When called for DAG param population (extra_user_message set), returns
    the required_tool so the DAG executor can extract params.
    """
    if agent_id:
        FAST_MODE_GOAL_CAPTURE.setdefault(agent_id, []).append(fast_mode_goal)
    if extra_user_message and required_tool:
        return {
            "response": "",
            "tool_calls": [{"tool": required_tool, "goal": "mock goal"}],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 50,
                "actual_model": "mock-model",
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            },
        }
    return {
        "response": "Task complete.",
        "tool_calls": [
            {
                "tool_name": "attempt_completion",
                "params": {"result": "All done"},
            }
        ],
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "actual_model": "mock-model",
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        },
    }


@activity.defn(name="check_progress")
async def mock_check_progress(
    context: List[Dict[str, Any]],
    verifier_system_prompt: str,
    model: str = "anthropic/claude-sonnet-4.5",
    response_schema: Optional[Dict[str, Any]] = None,
    claude_token: Optional[str] = None,
    call_site: str = "verifier",
    agent_id: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "score": 1.0,
        "reasoning": "Complete",
        "structured_response": None,
        # C6: usage must always be returned so callers (post-DAG verifier,
        # main-loop verifier) can route the cost through _on_tokens.
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "actual_model": None,
            "pool_name": None,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "claude_token_error": None,
        },
    }


@activity.defn(name="call_planner_llm_activity")
async def mock_call_planner_llm_activity(
    messages: List[Dict[str, Any]],
    model: str,
    tools_description: str,
    user_context: str,
    response_schema: Optional[Dict[str, Any]] = None,
    claude_max_token: Optional[str] = None,
    agent_id: Optional[str] = None,
    tool_call_id: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "plan_text": "Plan: do the thing",
        "plan_data": {
            "tasks": [{"goal": "Do the thing", "tool_name": "web_search"}],
            "dependencies": {},
            "join": "all",
        },
        "usage": {},
    }


@activity.defn(name="query_parent_state_activity")
async def mock_query_parent_state_activity(
    parent_workflow_id: str,
) -> Dict[str, Any]:
    return {"is_paused": False, "is_cost_limit_reached": False}


@activity.defn(name="resolve_attachments_activity")
async def mock_resolve_attachments_activity(file_pointers: list) -> list:
    return []


@activity.defn(name="execute_reasoning_activity")
async def mock_execute_reasoning_activity(
    goal: str, context: list, model: str, agent_id: str, stream_id: str
) -> Dict[str, Any]:
    return {"content": "Reasoning result", "usage": {}}


@activity.defn(name="populate_tool_params_activity")
async def mock_populate_tool_params_activity(
    tool_name: str,
    goal: str,
    agent_id: str,
    model: str,
    alias_name: str = "",
    claude_token: Optional[str] = None,
) -> Dict[str, Any]:
    return {"params": {}, "usage": {}}


@activity.defn(name="save_blueprint_activity")
async def mock_save_blueprint_activity(user_id: str, data: dict) -> dict:
    return {"id": "bp-1"}


@activity.defn(name="set_response_schema_activity")
async def mock_set_response_schema_activity(
    agent_id: str,
    user_messages: List[str],
    compute_auth: Any = None,
    fast_mode_cache_enabled: bool = False,
    *args: Any,
    **kwargs: Any,
) -> Optional[Dict[str, Any]]:
    return None


@activity.defn(name="send_direct_sms_activity")
async def mock_send_direct_sms_activity(user_id: str, message: str) -> Dict:
    return {"success": True}


# Collect all mock activities for Worker registration
MOCK_ACTIVITIES = [
    mock_get_model_context_window,
    mock_update_agent_status,
    mock_get_agent_source,
    mock_notify_sms_event_activity,
    mock_get_user_context,
    mock_get_user_system_name,
    mock_get_user_custom_system_prompt,
    mock_fetch_claude_max_token_activity,
    mock_fetch_compute_token_activity,
    mock_mark_compute_token_rate_limited_activity,
    mock_fetch_agent_config,
    mock_fetch_model_pricing,
    mock_post_agent_message,
    mock_poll_new_messages,
    mock_check_user_usage,
    mock_save_tool_usage,
    mock_update_agent_tree_state,
    mock_generate_completion_summary,
    mock_mark_finished,
    mock_compress_context,
    mock_update_agent_tree_cost_activity,
    mock_update_agent_tokens_activity,
    mock_call_llm_activity,
    mock_check_progress,
    mock_call_planner_llm_activity,
    mock_query_parent_state_activity,
    mock_resolve_attachments_activity,
    mock_execute_reasoning_activity,
    mock_populate_tool_params_activity,
    mock_save_blueprint_activity,
    mock_set_response_schema_activity,
    mock_send_direct_sms_activity,
    mock_resolve_fast_cache_goal_activity,
]


# ---------------------------------------------------------------------------
# Workflow import: use the same unsafe passthrough pattern as production code
# so the workflow class and all its transitive imports are available.
# ---------------------------------------------------------------------------

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from workflows.agent_workflow import AgentWorkflow

# Sandbox config: bypass all module restrictions so structlog/rich/etc. work.
from temporalio.worker.workflow_sandbox import (
    SandboxedWorkflowRunner,
    SandboxRestrictions,
)

_WORKFLOW_RUNNER = SandboxedWorkflowRunner(restrictions=SandboxRestrictions.default.with_passthrough_all_modules())

# Default workflow args matching AgentWorkflow.run() signature
DEFAULT_WF_ARGS: list = [
    "agent-test-1",  # agent_id
    "user-test-1",  # user_id
    "Test goal",  # goal
    "rose-labs/rose-1-lite",  # model
    256,  # reasoning_max_tokens
    {  # verifier
        "type": "FLOAT_LLM_JUDGE",
    },
]

TASK_QUEUE = "test-workflow-queue"

# Monotonic counter to generate unique workflow IDs across tests
_wf_counter = 0


def _next_wf_id(prefix: str = "test") -> str:
    global _wf_counter
    _wf_counter += 1
    return f"{prefix}-wf-{_wf_counter}"


async def _cancel_workflow(handle) -> None:
    """Cancel a workflow handle and swallow the expected CancelledError."""
    try:
        await handle.cancel()
    except Exception:
        pass
    try:
        await asyncio.wait_for(handle.result(), timeout=5)
    except Exception:
        pass  # CancelledError, TimeoutError, etc. are all expected


# ---------------------------------------------------------------------------
# All Temporal workflow tests run inside a SINGLE shared WorkflowEnvironment
# to avoid the overhead of starting multiple test servers.
# ---------------------------------------------------------------------------


async def _run_all_workflow_tests() -> List[tuple]:
    """Run all workflow tests inside one WorkflowEnvironment.

    Returns list of (test_name, exception_or_None) tuples.
    """
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    results: List[tuple] = []

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[AgentWorkflow],
            activities=MOCK_ACTIVITIES,
            workflow_runner=_WORKFLOW_RUNNER,
        ):
            # --- test: pause/resume ---
            name = "wf_pause_resume"
            try:
                handle = await env.client.start_workflow(
                    AgentWorkflow.run,
                    args=DEFAULT_WF_ARGS,
                    id=_next_wf_id("pause-resume"),
                    task_queue=TASK_QUEUE,
                )
                await asyncio.sleep(1)

                await handle.signal(AgentWorkflow.pause)
                await asyncio.sleep(0.5)
                paused = await handle.query(AgentWorkflow.is_paused_query)
                assert paused is True, f"Expected paused=True, got {paused}"

                await handle.signal(AgentWorkflow.resume)
                await asyncio.sleep(0.5)
                paused = await handle.query(AgentWorkflow.is_paused_query)
                assert paused is False, f"Expected paused=False after resume, got {paused}"

                await _cancel_workflow(handle)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

            # --- test: query status ---
            name = "wf_query_status"
            try:
                handle = await env.client.start_workflow(
                    AgentWorkflow.run,
                    args=DEFAULT_WF_ARGS,
                    id=_next_wf_id("query-status"),
                    task_queue=TASK_QUEUE,
                )
                await asyncio.sleep(1)
                await handle.signal(AgentWorkflow.pause)
                await asyncio.sleep(0.5)

                status = await handle.query(AgentWorkflow.get_status)
                assert status["agent_id"] == "agent-test-1", (
                    f"Expected agent_id='agent-test-1', got {status.get('agent_id')}"
                )
                assert status["goal"] == "Test goal", f"Expected goal='Test goal', got {status.get('goal')}"

                await _cancel_workflow(handle)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

            # --- test: cost limit ---
            name = "wf_cost_limit"
            try:
                handle = await env.client.start_workflow(
                    AgentWorkflow.run,
                    args=DEFAULT_WF_ARGS,
                    id=_next_wf_id("cost-limit"),
                    task_queue=TASK_QUEUE,
                )
                await asyncio.sleep(1)

                await handle.signal(AgentWorkflow.cost_limit_reached)
                await asyncio.sleep(0.5)

                cost_limited = await handle.query(AgentWorkflow.is_cost_limit_reached_query)
                assert cost_limited is True, f"Expected cost_limited=True, got {cost_limited}"

                paused = await handle.query(AgentWorkflow.is_paused_query)
                assert paused is True, f"Expected paused=True after cost limit, got {paused}"

                await _cancel_workflow(handle)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

            # --- test: price limit increased ---
            name = "wf_price_limit_increased"
            try:
                handle = await env.client.start_workflow(
                    AgentWorkflow.run,
                    args=DEFAULT_WF_ARGS,
                    id=_next_wf_id("price-limit"),
                    task_queue=TASK_QUEUE,
                )
                await asyncio.sleep(1)

                await handle.signal(AgentWorkflow.cost_limit_reached)
                await asyncio.sleep(0.5)

                cost_limited = await handle.query(AgentWorkflow.is_cost_limit_reached_query)
                assert cost_limited is True, "Should be cost-limited before increase"

                await handle.signal(
                    AgentWorkflow.price_limit_increased,
                    {"new_limit_cents": 500},
                )
                await asyncio.sleep(0.5)

                cost_limited = await handle.query(AgentWorkflow.is_cost_limit_reached_query)
                assert cost_limited is False, f"Expected cost_limited=False after price increase, got {cost_limited}"

                paused = await handle.query(AgentWorkflow.is_paused_query)
                assert paused is False, f"Expected paused=False after price increase, got {paused}"

                await _cancel_workflow(handle)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

            # --- test: user response ---
            name = "wf_user_response"
            try:
                handle = await env.client.start_workflow(
                    AgentWorkflow.run,
                    args=DEFAULT_WF_ARGS,
                    id=_next_wf_id("user-response"),
                    task_queue=TASK_QUEUE,
                )
                await asyncio.sleep(1)
                await handle.signal(AgentWorkflow.pause)
                await asyncio.sleep(0.5)

                response_data = json.dumps(
                    {
                        "request_id": "req-1",
                        "response": "approved",
                    }
                )
                await handle.signal(AgentWorkflow.receive_user_response, response_data)
                await asyncio.sleep(0.5)

                status = await handle.query(AgentWorkflow.get_status)
                assert status["agent_id"] == "agent-test-1", "Workflow should still be running"

                await _cancel_workflow(handle)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

            # --- test: child completed ---
            name = "wf_child_completed"
            try:
                handle = await env.client.start_workflow(
                    AgentWorkflow.run,
                    args=DEFAULT_WF_ARGS,
                    id=_next_wf_id("child-completed"),
                    task_queue=TASK_QUEUE,
                )
                await asyncio.sleep(1)
                await handle.signal(AgentWorkflow.pause)
                await asyncio.sleep(0.5)

                await handle.signal(
                    AgentWorkflow.child_completed,
                    {
                        "child_agent_id": "child-agent-1",
                        "result": {
                            "status": "completed",
                            "summary": "Child finished successfully",
                            "goal": "Sub-task goal",
                            "tool_counts": {"web_search": 2},
                        },
                    },
                )
                await asyncio.sleep(0.5)

                status = await handle.query(AgentWorkflow.get_status)
                assert status["agent_id"] == "agent-test-1", "Workflow should still be running"

                await _cancel_workflow(handle)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

            # --- test: fast cache goal comes from the persisted agent row ---
            # Chat escalation starts the workflow with an LLM-refined goal that
            # differs from the persisted Agent row and varies run to run. Cache
            # keys namespace by exact goal hash, so keying on the workflow-input
            # goal gives every chat-originated run a fresh, empty namespace.
            # The workflow must thread the DB-row goal into LLM activities.
            name = "wf_fast_cache_goal_uses_persisted_row"
            try:
                fc_agent_id = "agent-test-fastcache"
                FAST_MODE_GOAL_CAPTURE.pop(fc_agent_id, None)
                handle = await env.client.start_workflow(
                    AgentWorkflow.run,
                    args=[
                        fc_agent_id,
                        "user-test-1",
                        "Refined chat goal (volatile, differs per run)",
                        "rose-labs/rose-1-lite",
                        256,
                        {"type": "FLOAT_LLM_JUDGE"},
                        None,  # context
                        None,  # parent_workflow_id
                        None,  # parent_agent_id
                        0,  # depth
                        None,  # bus_id
                        "plan",  # start_phase
                        None,  # max_iterations
                        100,  # price_limit_cents
                        None,  # context_gates
                        True,  # fast_mode_cache_enabled
                    ],
                    id=_next_wf_id("fast-cache-goal"),
                    task_queue=TASK_QUEUE,
                )
                # Wait until the workflow reaches its first LLM call.
                for _ in range(60):
                    if FAST_MODE_GOAL_CAPTURE.get(fc_agent_id):
                        break
                    await asyncio.sleep(0.5)

                captured_goals = FAST_MODE_GOAL_CAPTURE.get(fc_agent_id)
                assert captured_goals, "Workflow never reached an LLM call"
                assert captured_goals[0] == "Persisted DB goal", (
                    f"Fast Mode cache goal must be the persisted agent-row goal, got {captured_goals[0]!r}"
                )

                await _cancel_workflow(handle)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

    return results


# ===========================================================================
# Test runner
# ===========================================================================


# ===========================================================================
# 4. AgentWorkflow pure-method tests (bare instance, no Temporal env)
# ===========================================================================


def _bare_workflow_instance():
    """Create a bare AgentWorkflow instance without running @workflow.run."""
    from workflows.agent_workflow import AgentWorkflow

    return AgentWorkflow()


def test_workflow_get_pending_child_workflow_ids_empty():
    wf = _bare_workflow_instance()
    assert wf._get_pending_child_workflow_ids() == []


def test_workflow_get_pending_child_workflow_ids_populated():
    wf = _bare_workflow_instance()
    wf.pending_children = {"child-1", "child-2", "child-missing"}
    wf.child_workflow_ids = {"child-1": "wf-1", "child-2": "wf-2"}
    result = set(wf._get_pending_child_workflow_ids())
    # child-missing isn't in child_workflow_ids so it's skipped
    assert result == {"wf-1", "wf-2"}


def test_workflow_get_children_tokens_empty():
    wf = _bare_workflow_instance()
    assert wf._get_children_tokens() == (0, 0)


def test_workflow_get_children_tokens_sums_correctly():
    wf = _bare_workflow_instance()
    wf.children_tokens_in = {"a": 100, "b": 200, "c": 50}
    wf.children_tokens_out = {"a": 10, "b": 20}
    assert wf._get_children_tokens() == (350, 30)


def test_workflow_get_status_query():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.goal = "test goal"
    wf.token_count = 500
    status = wf.get_status()
    assert status == {"agent_id": "agent-1", "goal": "test goal", "tokens": 500}


def test_workflow_is_paused_query_default_false():
    wf = _bare_workflow_instance()
    assert wf.is_paused_query() is False


def test_workflow_is_paused_query_true():
    wf = _bare_workflow_instance()
    wf.is_paused = True
    assert wf.is_paused_query() is True


def test_workflow_is_cost_limit_reached_query_default():
    wf = _bare_workflow_instance()
    assert wf.is_cost_limit_reached_query() is False


def test_workflow_parent_state_query():
    wf = _bare_workflow_instance()
    wf.is_paused = True
    wf._cost_limit_reached = True
    assert wf.parent_state_query() == {"is_paused": True, "is_cost_limit_reached": True}


def test_workflow_parent_state_query_all_false():
    wf = _bare_workflow_instance()
    assert wf.parent_state_query() == {"is_paused": False, "is_cost_limit_reached": False}


def test_workflow_format_outputs_no_schema_returns_empty():
    wf = _bare_workflow_instance()
    wf.output_schema = None
    assert wf._format_outputs({"x": 1}) == []


def test_workflow_format_outputs_no_response_returns_empty():
    wf = _bare_workflow_instance()
    wf.output_schema = {"fields": [{"name": "x"}]}
    assert wf._format_outputs(None) == []


def test_workflow_format_outputs_maps_fields():
    wf = _bare_workflow_instance()
    wf.output_schema = {
        "fields": [
            {"name": "summary", "description": "A summary"},
            {"name": "topics"},  # No description -> fallback to Title Case
        ]
    }
    outputs = wf._format_outputs({"summary": "Hello", "topics": ["AI", "ML"], "extra": "ignored"})
    assert len(outputs) == 2
    assert outputs[0] == {"key": "summary", "label": "A summary", "value": "Hello"}
    assert outputs[1] == {"key": "topics", "label": "Topics", "value": ["AI", "ML"]}


def test_workflow_format_outputs_skips_missing_fields():
    wf = _bare_workflow_instance()
    wf.output_schema = {"fields": [{"name": "present"}, {"name": "missing"}]}
    outputs = wf._format_outputs({"present": "yes"})
    assert len(outputs) == 1
    assert outputs[0]["key"] == "present"


def test_workflow_format_outputs_field_without_name_skipped():
    wf = _bare_workflow_instance()
    wf.output_schema = {"fields": [{"description": "no name"}]}
    outputs = wf._format_outputs({"x": "y"})
    assert outputs == []


def test_workflow_extract_failure_context_empty_context():
    wf = _bare_workflow_instance()
    result = wf._extract_failure_context(context=[])
    assert result["trajectory"] == []
    assert result["last_reasoning"] is None
    assert result["last_plan"] is None
    assert result["steps_taken"] == 0
    assert result["progress_estimate"] == "No steps completed"


def test_workflow_extract_failure_context_assistant_reasoning():
    wf = _bare_workflow_instance()
    ctx = [
        {"role": "ASSISTANT", "text": "Thinking about the problem"},
        {"role": "ASSISTANT", "text": "Final conclusion"},
    ]
    result = wf._extract_failure_context(context=ctx)
    assert result["last_reasoning"] == "Final conclusion"


def test_workflow_extract_failure_context_skips_reasoning_metadata():
    wf = _bare_workflow_instance()
    ctx = [
        {"role": "ASSISTANT", "text": "hidden reasoning", "metadata": {"reasoning": True}},
        {"role": "ASSISTANT", "text": "visible response"},
    ]
    result = wf._extract_failure_context(context=ctx)
    assert result["last_reasoning"] == "visible response"


def test_workflow_extract_failure_context_truncates_reasoning():
    wf = _bare_workflow_instance()
    long_text = "x" * 1000
    ctx = [{"role": "ASSISTANT", "text": long_text}]
    result = wf._extract_failure_context(context=ctx)
    assert len(result["last_reasoning"]) == 500


def test_workflow_extract_failure_context_plan_extraction():
    wf = _bare_workflow_instance()
    ctx = [
        {
            "role": "TOOL",
            "text": "plan set",
            "metadata": {
                "toolName": "set_plan",
                "toolStatus": "FINISHED",
                "data": {
                    "tasks": [
                        {"goal": "Research topic"},
                        {"goal": "Write report"},
                    ]
                },
            },
        }
    ]
    result = wf._extract_failure_context(context=ctx)
    assert result["last_plan"] == ["Research topic", "Write report"]


def test_workflow_extract_failure_context_plan_limits_to_5_tasks():
    wf = _bare_workflow_instance()
    ctx = [
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolName": "set_plan",
                "toolStatus": "FINISHED",
                "data": {"tasks": [{"goal": f"task {i}"} for i in range(10)]},
            },
        }
    ]
    result = wf._extract_failure_context(context=ctx)
    assert len(result["last_plan"]) == 5


def test_workflow_extract_failure_context_trajectory_dedupe():
    wf = _bare_workflow_instance()
    ctx = [
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolCallId": "tc-1",
                "toolName": "web_search",
                "toolStatus": "FINISHED",
            },
        },
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolCallId": "tc-1",  # Duplicate
                "toolName": "web_search",
                "toolStatus": "FINISHED",
            },
        },
        {
            "role": "TOOL",
            "text": "error!",
            "metadata": {
                "toolCallId": "tc-2",
                "toolName": "web_fetch",
                "toolStatus": "ERROR",
            },
        },
    ]
    result = wf._extract_failure_context(context=ctx)
    assert result["steps_taken"] == 2
    assert result["trajectory"][0]["tool_name"] == "web_search"
    assert result["trajectory"][0]["success"] is True
    assert result["trajectory"][1]["tool_name"] == "web_fetch"
    assert result["trajectory"][1]["success"] is False
    assert result["trajectory"][1]["error_message"] == "error!"


def test_workflow_extract_failure_context_skips_internal_tools():
    """Verifier feedback rows (verifierMessage=True) and internal tools must
    not appear in trajectory. Verifier rows now ride under
    toolName="attempt_completion" rather than "check_progress" — filtering is
    done by the verifierMessage flag.
    """
    wf = _bare_workflow_instance()
    ctx = [
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolCallId": "tc-1",
                "toolName": "attempt_completion",
                "toolStatus": "FINISHED",
                "verifierMessage": True,
            },
        },
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolCallId": "tc-2",
                "toolName": "completion_summary",
                "toolStatus": "FINISHED",
            },
        },
    ]
    result = wf._extract_failure_context(context=ctx)
    assert result["steps_taken"] == 0


def test_workflow_extract_failure_context_skips_in_progress_tools():
    wf = _bare_workflow_instance()
    ctx = [
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolCallId": "tc-1",
                "toolName": "web_search",
                "toolStatus": "IN_PROGRESS",
            },
        },
    ]
    result = wf._extract_failure_context(context=ctx)
    assert result["steps_taken"] == 0


def test_workflow_extract_failure_context_verifier_progress():
    wf = _bare_workflow_instance()
    result = wf._extract_failure_context(context=[], verifier_progress=0.75, verifier_reasoning="mostly done")
    assert result["progress_estimate"] == "75%"
    assert result["verifier_reasoning"] == "mostly done"


def test_workflow_extract_failure_context_partial_structured_response():
    wf = _bare_workflow_instance()
    partial = {"field_a": "done"}
    result = wf._extract_failure_context(context=[], partial_structured_response=partial)
    assert result["partial_structured_response"] == partial


def test_workflow_extract_failure_context_step_based_progress():
    wf = _bare_workflow_instance()
    ctx = [
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolCallId": f"tc-{i}",
                "toolName": "web_search",
                "toolStatus": "FINISHED",
            },
        }
        for i in range(3)
    ]
    # Add one failed
    ctx.append(
        {
            "role": "TOOL",
            "text": "oops",
            "metadata": {"toolCallId": "tc-err", "toolName": "web_search", "toolStatus": "ERROR"},
        }
    )
    result = wf._extract_failure_context(context=ctx)
    assert result["steps_taken"] == 4
    assert result["progress_estimate"] == "3/4 steps succeeded"


def test_workflow_extract_failure_context_error_message_truncated():
    wf = _bare_workflow_instance()
    long_err = "x" * 500
    ctx = [
        {
            "role": "TOOL",
            "text": long_err,
            "metadata": {"toolCallId": "tc-1", "toolName": "web_search", "toolStatus": "ERROR"},
        }
    ]
    result = wf._extract_failure_context(context=ctx)
    assert len(result["trajectory"][0]["error_message"]) == 200


# ===========================================================================
# 5. AgentWorkflow signal-handler + cost-tracking tests with fake workflow module
# ===========================================================================


class _FakeWorkflowLogger:
    def __init__(self):
        self.records: List[tuple] = []

    def info(self, msg, *args, **kwargs):
        self.records.append(("info", str(msg)))

    def warning(self, msg, *args, **kwargs):
        self.records.append(("warning", str(msg)))

    def error(self, msg, *args, **kwargs):
        self.records.append(("error", str(msg)))

    def debug(self, msg, *args, **kwargs):
        self.records.append(("debug", str(msg)))


class _FakeExternalHandle:
    def __init__(self, wf_id: str, signals: List[tuple]):
        self.wf_id = wf_id
        self._signals = signals

    async def signal(self, name, data=None):
        self._signals.append((self.wf_id, name, data))


class _FakeWorkflowModule:
    """Stand-in for temporalio.workflow inside a workflow method. Captures activities + signals."""

    def __init__(self, *, patched: bool = True):
        self.logger = _FakeWorkflowLogger()
        self.activity_calls: List[tuple] = []  # (fn_name, args)
        self.signal_calls: List[tuple] = []  # (wf_id, name, data)
        self.activity_fail_for: set = set()  # fn_names that should raise
        self.activity_returns: Dict[str, Any] = {}  # fn_name -> return value override
        self.activity_blockers: Dict[str, asyncio.Event] = {}
        self.now_value = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        self._patched = patched

    async def execute_activity(self, fn, args=None, **kwargs):
        fn_name = getattr(fn, "__name__", str(fn))
        self.activity_calls.append((fn_name, args))
        blocker = self.activity_blockers.get(fn_name)
        if blocker is not None:
            await blocker.wait()
        if fn_name in self.activity_fail_for:
            raise RuntimeError(f"{fn_name} failed")
        if fn_name in self.activity_returns:
            return self.activity_returns[fn_name]
        return None

    def start_activity(self, fn, args=None, **kwargs):
        return asyncio.create_task(self.execute_activity(fn, args=args, **kwargs))

    def get_external_workflow_handle(self, wf_id):
        return _FakeExternalHandle(wf_id, self.signal_calls)

    def now(self):
        return self.now_value

    def uuid4(self):
        return "00000000-0000-0000-0000-000000000001"

    def patched(self, patch_id):
        return self._patched


def _patch_workflow(fake: _FakeWorkflowModule):
    """Swap workflows.agent_workflow.workflow with a fake; returns original."""
    import workflows.agent_workflow as m

    original = m.workflow
    m.workflow = fake
    return original


def _restore_workflow(original):
    import workflows.agent_workflow as m

    m.workflow = original


async def test_workflow_signal_pause_sets_paused_flag():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.pause()
        assert wf.is_paused is True
        # Should have tried to broadcast tree state (via update_agent_tree_state activity)
        activity_names = [c[0] for c in fake.activity_calls]
        assert "update_agent_tree_state" in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_signal_pause_cascades_to_children():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    wf.pending_children = {"c1", "c2"}
    wf.child_workflow_ids = {"c1": "wfc1", "c2": "wfc2"}
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.pause()
        # Both children should have received "pause" signal
        cascaded = [s for s in fake.signal_calls if s[1] == "pause"]
        assert {s[0] for s in cascaded} == {"wfc1", "wfc2"}
    finally:
        _restore_workflow(original)


async def test_workflow_signal_resume_clears_paused_flag():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    wf.is_paused = True
    wf._paused_by_parent = True
    # No parent_workflow_id -> resume shouldn't be blocked
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.resume()
        assert wf.is_paused is False
        assert wf._paused_by_parent is False
    finally:
        _restore_workflow(original)


async def test_workflow_signal_receive_user_response_plain_string():
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("hello plain")
        assert wf._last_signal_response == "hello plain"
        assert wf._has_new_messages is True
        assert wf._response_schema_feedback == ["hello plain"]
        assert wf._response_schema_revision == 1
    finally:
        _restore_workflow(original)


async def test_workflow_signal_receive_user_response_with_request_id():
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response(json.dumps({"request_id": "req-123", "response": "yes"}))
        assert wf._signal_responses.get("req-123") == "yes"
        assert wf._has_new_messages is False
        assert wf._response_schema_feedback == []
        assert wf._response_schema_revision == 0
    finally:
        _restore_workflow(original)


async def test_workflow_signal_receive_user_response_json_without_request_id():
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response('{"unrelated": "data"}')
        # Falls through to plain string path
        assert wf._last_signal_response == '{"unrelated": "data"}'
        assert wf._has_new_messages is True
    finally:
        _restore_workflow(original)


async def test_workflow_signal_wakes_for_generated_schema_update_message():
    wf = _bare_workflow_instance()
    wf._response_schema_internal_signal_keys.add("schema-key-1")
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response(
            json.dumps(
                {
                    "internal_type": "response_schema_update",
                    "idempotency_key": "schema-key-1",
                }
            )
        )

        assert wf._has_new_messages is True
        assert wf._response_schema_feedback == []
        assert wf._response_schema_revision == 0
    finally:
        _restore_workflow(original)


async def test_workflow_signal_unknown_schema_envelope_is_user_feedback():
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        feedback = json.dumps(
            {
                "internal_type": "response_schema_update",
                "idempotency_key": "not-issued-by-workflow",
            }
        )
        await wf.receive_user_response(feedback)

        assert wf._has_new_messages is True
        assert wf._response_schema_feedback == [feedback]
        assert wf._response_schema_revision == 1
    finally:
        _restore_workflow(original)


async def test_workflow_signal_treats_schema_prefix_as_genuine_user_feedback():
    from workflows.agent_workflow import RESPONSE_SCHEMA_UPDATE_PREFIX

    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        feedback = f"{RESPONSE_SCHEMA_UPDATE_PREFIX}\nBut this was typed by the user"
        await wf.receive_user_response(feedback)

        assert wf._has_new_messages is True
        assert wf._response_schema_feedback == [feedback]
        assert wf._response_schema_revision == 1
    finally:
        _restore_workflow(original)


async def test_workflow_refreshes_response_schema_from_user_feedback():
    """Feedback revision runs in parallel and reaches context without delaying the next prompt."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.goal = "Research three venues"
    wf.fast_cache_goal = "Research three venues"
    wf.current_phase = "EXECUTE"
    wf.user_context_section = ""
    wf._cloud_agent_lifecycle_finished = True
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
    wf._system_prompt_output_schema = wf.output_schema
    wf._response_schema_initialized = True
    wf.context = [
        {"role": "USER", "text": "Research three venues", "metadata": None},
        {
            "role": "USER",
            "text": "Personality instructions: be concise",
            "metadata": {"hidden": True, "isCustomSystemPrompt": True},
        },
    ]

    replacement_schema = {
        "fields": [
            {"name": "venues", "type": "list[str]", "required": True},
            {"name": "venue_prices", "type": "list[int]", "required": True},
        ],
    }
    fake = _FakeWorkflowModule()
    fake.activity_returns["set_response_schema_activity"] = {
        "schema": replacement_schema,
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }
    schema_blocker = asyncio.Event()
    fake.activity_blockers["set_response_schema_activity"] = schema_blocker
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Also include the price for each venue")
        await asyncio.sleep(0)

        # Schema generation is still blocked, but main-agent prompt construction
        # must complete immediately with its stable initial system prefix.
        prompt = await asyncio.wait_for(wf.build_system_prompt(), timeout=0.1)
        assert "venues" in prompt
        assert "venue_prices" not in prompt
        assert wf.output_schema != replacement_schema

        schema_blocker.set()
        await wf._wait_for_response_schema_refresh()

        schema_calls = [c for c in fake.activity_calls if c[0] == "set_response_schema_activity"]
        assert len(schema_calls) == 1
        assert schema_calls[0][1][0] == "agent-1"
        assert schema_calls[0][1][1] == [
            "Research three venues",
            'Current output schema (preserve fields unless later user feedback changes them):\n{"fields":[{"name":"venues","required":true,"type":"list[str]"}]}',
            "Also include the price for each venue",
        ]
        assert wf.output_schema == replacement_schema
        assert wf._response_schema_applied_revision == 1
        schema_messages = [c for c in fake.activity_calls if c[0] == "post_agent_message" and c[1][2] == "USER"]
        assert len(schema_messages) == 1
        assert "venue_prices" in schema_messages[0][1][1]
        assert schema_messages[0][1][3]["isResponseSchemaUpdate"] is True
        assert schema_messages[0][1][3]["idempotencyKey"] == "00000000-0000-0000-0000-000000000001"

        # The revised schema lives at the conversation tail, so the system
        # prefix remains byte-for-byte stable for provider prompt caching.
        revised_prompt = await wf.build_system_prompt()
        assert revised_prompt == prompt
        schema_calls = [c for c in fake.activity_calls if c[0] == "set_response_schema_activity"]
        assert len(schema_calls) == 1
    finally:
        _restore_workflow(original)


async def test_workflow_verifier_refreshes_response_schema_from_user_feedback():
    """Only verification waits for a pending background schema revision."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.goal = "Research three venues"
    wf.fast_cache_goal = "Research three venues"
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
    wf._system_prompt_output_schema = wf.output_schema
    wf._response_schema_initialized = True
    replacement_schema = {
        "fields": [{"name": "venue_prices", "type": "list[int]", "required": True}],
    }
    fake = _FakeWorkflowModule()
    fake.activity_returns["set_response_schema_activity"] = {"schema": replacement_schema, "usage": {}}
    schema_blocker = asyncio.Event()
    fake.activity_blockers["set_response_schema_activity"] = schema_blocker
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Return only the venue prices")
        await asyncio.sleep(0)

        verifier_task = asyncio.create_task(wf._make_verifier_prompt_generator()())
        await asyncio.sleep(0)
        assert verifier_task.done() is False

        schema_blocker.set()
        verifier_prompt = await verifier_task
        current_schema = await wf._make_response_schema_getter()()

        assert wf.output_schema == replacement_schema
        assert current_schema == replacement_schema
        assert "venue_prices" in verifier_prompt
        schema_calls = [c for c in fake.activity_calls if c[0] == "set_response_schema_activity"]
        assert len(schema_calls) == 1
    finally:
        _restore_workflow(original)


async def test_workflow_schema_refresh_skips_context_message_when_unchanged():
    """A feedback check that preserves the schema should not add synthetic context."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.goal = "Research three venues"
    wf.fast_cache_goal = wf.goal
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
    wf._system_prompt_output_schema = wf.output_schema
    wf._response_schema_initialized = True

    fake = _FakeWorkflowModule()
    fake.activity_returns["set_response_schema_activity"] = {"schema": wf.output_schema, "usage": {}}
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Please keep going")
        await wf._wait_for_response_schema_refresh()

        schema_messages = [c for c in fake.activity_calls if c[0] == "post_agent_message" and c[1][2] == "USER"]
        assert schema_messages == []
        assert wf._response_schema_applied_revision == 1
    finally:
        _restore_workflow(original)


async def test_workflow_schema_refresh_failure_falls_back_until_new_feedback():
    """A terminal refresh failure keeps the last schema and later feedback can retry."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.goal = "Research three venues"
    wf.fast_cache_goal = wf.goal
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
    wf._system_prompt_output_schema = wf.output_schema
    wf._response_schema_initialized = True

    fake = _FakeWorkflowModule()
    fake.activity_returns["set_response_schema_activity"] = None
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Also include prices")
        await asyncio.sleep(0)

        await wf._wait_for_response_schema_refresh()

        assert wf._response_schema_applied_revision == 1
        assert wf._response_schema_revision == 1
        assert wf._response_schema_refresh_failed_revision == 1
        assert wf._response_schema_refresh_error is None
        schema_messages = [c for c in fake.activity_calls if c[0] == "post_agent_message"]
        assert schema_messages == []

        replacement_schema = {
            "fields": [{"name": "venue_prices", "type": "list[int]", "required": True}],
        }
        fake.activity_returns["set_response_schema_activity"] = {
            "schema": replacement_schema,
            "usage": {},
        }
        await wf.receive_user_response("Prices are now required")
        await wf._wait_for_response_schema_refresh()

        assert wf.output_schema == replacement_schema
        assert wf._response_schema_applied_revision == 2
    finally:
        _restore_workflow(original)


async def test_workflow_schema_refresh_message_failure_falls_back_to_last_schema():
    """A failed hidden context write keeps the last durable schema without blocking."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.goal = "Research three venues"
    wf.fast_cache_goal = wf.goal
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
    wf._system_prompt_output_schema = wf.output_schema
    wf._response_schema_initialized = True
    replacement_schema = {
        "fields": [{"name": "venue_prices", "type": "list[int]", "required": True}],
    }

    fake = _FakeWorkflowModule()
    fake.activity_returns["set_response_schema_activity"] = {"schema": replacement_schema, "usage": {}}
    fake.activity_fail_for.add("post_agent_message")
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Return venue prices")
        await asyncio.sleep(0)

        await wf._wait_for_response_schema_refresh()

        assert wf.output_schema != replacement_schema
        assert wf._response_schema_applied_revision == 1
        assert wf._response_schema_refresh_error is None
    finally:
        _restore_workflow(original)


async def test_workflow_schema_refresh_reloads_prior_feedback_after_continuation():
    """A fresh workflow run rebuilds revisions from durable USER messages."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.goal = "Research three venues"
    wf.fast_cache_goal = wf.goal
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
    wf._system_prompt_output_schema = wf.output_schema
    wf._response_schema_initialized = True

    replacement_schema = {
        "fields": [{"name": "venue_prices", "type": "list[int]", "required": True}],
    }
    fake = _FakeWorkflowModule()
    fake.activity_returns["poll_new_messages"] = [
        {
            "role": "USER",
            "text": "Earlier feedback: include addresses",
            "metadata": None,
        },
        {
            "role": "USER",
            "text": "old generated schema",
            "metadata": {"hidden": True, "isResponseSchemaUpdate": True},
        },
    ]
    fake.activity_returns["set_response_schema_activity"] = {"schema": replacement_schema, "usage": {}}
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Now include prices")
        await wf._wait_for_response_schema_refresh()

        schema_call = next(c for c in fake.activity_calls if c[0] == "set_response_schema_activity")
        assert schema_call[1][1] == [
            "Research three venues",
            'Current output schema (preserve fields unless later user feedback changes them):\n{"fields":[{"name":"venues","required":true,"type":"list[str]"}]}',
            "Earlier feedback: include addresses",
            "Now include prices",
        ]
    finally:
        _restore_workflow(original)


async def test_workflow_schema_refresh_coalesces_rapid_feedback():
    """Superseded generation results do not add obsolete schema messages."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.goal = "Research three venues"
    wf.fast_cache_goal = wf.goal
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
    wf._system_prompt_output_schema = wf.output_schema
    wf._response_schema_initialized = True

    replacement_schema = {
        "fields": [
            {"name": "venue_prices", "type": "list[int]", "required": True},
            {"name": "venue_addresses", "type": "list[str]", "required": True},
        ],
    }
    fake = _FakeWorkflowModule()
    fake.activity_returns["set_response_schema_activity"] = {"schema": replacement_schema, "usage": {}}
    schema_blocker = asyncio.Event()
    fake.activity_blockers["set_response_schema_activity"] = schema_blocker
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Include prices")
        await asyncio.sleep(0)
        await wf.receive_user_response("Also include addresses")

        schema_blocker.set()
        await wf._wait_for_response_schema_refresh()

        schema_calls = [c for c in fake.activity_calls if c[0] == "set_response_schema_activity"]
        assert len(schema_calls) == 2
        assert schema_calls[-1][1][1] == [
            "Research three venues",
            'Current output schema (preserve fields unless later user feedback changes them):\n{"fields":[{"name":"venues","required":true,"type":"list[str]"}]}',
            "Include prices",
            "Also include addresses",
        ]
        schema_messages = [c for c in fake.activity_calls if c[0] == "post_agent_message"]
        assert len(schema_messages) == 1
        assert schema_messages[0][1][3]["responseSchemaRevision"] == 2
        assert wf._response_schema_applied_revision == 2
    finally:
        _restore_workflow(original)


async def test_workflow_signal_signup_completed_and_dismissed():
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.signup_completed()
        assert wf._signup_completed is True
        await wf.signup_dismissed()
        assert wf._signup_dismissed is True
    finally:
        _restore_workflow(original)


async def test_workflow_signal_child_cost_update_aggregates():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.own_cost_cents = 10.0
    wf.tokens_in = 100
    wf.tokens_out = 50
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.child_cost_update(
            {
                "child_agent_id": "child-1",
                "subtree_cost_cents": 25.0,
                "subtree_tokens_in": 500,
                "subtree_tokens_out": 200,
            }
        )
        assert wf.children_cost_cents["child-1"] == 25.0
        assert wf.children_tokens_in["child-1"] == 500
        assert wf.children_tokens_out["child-1"] == 200
        # subtree_cost_cents should be own + children_sum
        assert wf.subtree_cost_cents == 35.0
        assert wf.tree_tokens_in == 600
        assert wf.tree_tokens_out == 250
    finally:
        _restore_workflow(original)


async def test_workflow_signal_child_progress_tracks_deltas():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.child_tool_ids = {"child-1": "tool-call-1"}
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.child_progress(
            {
                "child_agent_id": "child-1",
                "progress": 0.5,
                "tokens_in": 100,
                "tokens_out": 50,
                "token_count": 150,
                "goal": "subtask",
            }
        )
        assert wf.tokens_in == 100
        assert wf.tokens_out == 50
        assert wf.token_count == 150

        # Second progress update with higher cumulative — deltas should apply
        await wf.child_progress(
            {
                "child_agent_id": "child-1",
                "progress": 0.9,
                "tokens_in": 250,
                "tokens_out": 120,
                "token_count": 370,
                "goal": "subtask",
            }
        )
        assert wf.tokens_in == 250
        assert wf.tokens_out == 120
        assert wf.token_count == 370
    finally:
        _restore_workflow(original)


async def test_workflow_signal_child_completed_success():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.pending_children = {"child-1"}
    wf.child_tool_ids = {"child-1": "tool-call-1"}
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.child_completed(
            {
                "child_agent_id": "child-1",
                "result": {
                    "status": "completed",
                    "goal": "subtask",
                    "summary": "done",
                    "tool_counts": {"web_search": 2, "web_fetch": 1},
                    "structured_response": {"x": 1},
                },
            }
        )
        assert "child-1" not in wf.pending_children
        assert wf.child_tool_counts == {"web_search": 2, "web_fetch": 1}
        assert wf.child_results["child-1"]["status"] == "completed"
    finally:
        _restore_workflow(original)


async def test_workflow_signal_child_completed_failure():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.pending_children = {"child-1"}
    wf.child_tool_ids = {"child-1": "tool-call-1"}
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.child_completed(
            {
                "child_agent_id": "child-1",
                "result": {
                    "status": "failed",
                    "goal": "subtask",
                    "error_reason": "timeout",
                    "summary": "sub-agent failed",
                },
            }
        )
        assert "child-1" not in wf.pending_children
        # Failure path doesn't aggregate tool counts
        assert wf.child_tool_counts == {}
    finally:
        _restore_workflow(original)


async def test_workflow_signal_child_max_iterations_posts_error_with_partial_payload():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.message_count = 0
    wf.pending_children = {"child-1"}
    wf.child_tool_ids = {"child-1": "tool-call-1"}
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.child_completed(
            {
                "child_agent_id": "child-1",
                "result": {
                    "status": "max_iterations",
                    "goal": "subtask",
                    "message": "Reached max iterations (5)",
                    "best_effort_response": "partial useful result",
                    "partial_structured_response": {"answer": "partial"},
                },
            }
        )
        assert "child-1" not in wf.pending_children
        assert wf.child_tool_counts == {}
        assert wf.child_results["child-1"]["status"] == "max_iterations"

        post_calls = [call for call in fake.activity_calls if call[0] == "post_agent_message"]
        assert len(post_calls) == 1
        args = post_calls[0][1]
        assert args[1] == "partial useful result"
        assert args[2] == "TOOL"
        metadata = args[3]
        assert metadata["toolStatus"] == "ERROR"
        assert metadata["structuredResponse"] == {"answer": "partial"}
        assert metadata["structured_response"] == {"answer": "partial"}
    finally:
        _restore_workflow(original)


async def test_workflow_signal_cost_limit_reached_sets_flags():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.cost_limit_reached()
        assert wf._cost_limit_reached is True
        assert wf.is_paused is True
        assert wf._paused_by_parent is True
    finally:
        _restore_workflow(original)


async def test_workflow_signal_price_limit_increased_clears_limit():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    wf.is_paused = True
    wf._cost_limit_reached = True
    wf._paused_by_parent = True
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.price_limit_increased({"new_limit_cents": 500})
        assert wf.price_limit_cents == 500
        assert wf._cost_limit_reached is False
        assert wf.is_paused is False
        assert wf._paused_by_parent is False
    finally:
        _restore_workflow(original)


async def test_workflow_track_tokens_and_cost_updates_counters():
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._track_tokens_and_cost({"token_count": 250, "context_size": 12000})
        assert wf.token_count == 250
        assert wf.context_size == 12000

        # Subsequent call adds to token_count but replaces context_size
        await wf._track_tokens_and_cost({"token_count": 100, "context_size": 15000})
        assert wf.token_count == 350
        assert wf.context_size == 15000

        # Missing context_size leaves it unchanged
        await wf._track_tokens_and_cost({"token_count": 10})
        assert wf.token_count == 360
        assert wf.context_size == 15000
    finally:
        _restore_workflow(original)


async def test_workflow_track_llm_cost_calculates_and_persists():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.model = "claude-3-5-sonnet"
    wf.input_cents_per_1k = 0.3  # cents per 1k
    wf.output_cents_per_1k = 1.5
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._track_llm_cost(tokens_in=1000, tokens_out=500, call_site="completion_summary")
        # cost = (1000 * 0.3 / 1000) + (500 * 1.5 / 1000) = 0.3 + 0.75 = 1.05
        assert abs(wf.own_cost_cents - 1.05) < 1e-6
        assert wf.tokens_in == 1000
        assert wf.tokens_out == 500
        # save_tool_usage activity should have been invoked
        activity_names = [c[0] for c in fake.activity_calls]
        assert "save_tool_usage" in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_track_llm_cost_zero_when_no_pricing():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.input_cents_per_1k = 0.0
    wf.output_cents_per_1k = 0.0
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._track_llm_cost(tokens_in=1000, tokens_out=500, call_site="x")
        # No cost, no save_tool_usage activity
        activity_names = [c[0] for c in fake.activity_calls]
        assert "save_tool_usage" not in activity_names
        assert wf.own_cost_cents == 0.0
    finally:
        _restore_workflow(original)


async def test_workflow_track_llm_cost_fast_cache_replay_is_zero_cost():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.model = "claude-sonnet-4"
    wf.input_cents_per_1k = 0.3
    wf.output_cents_per_1k = 1.5
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._track_llm_cost(
            tokens_in=0,
            tokens_out=500,
            call_site="completion_summary",
            actual_model="claude-fable-5-anthropic",
            cache_read_input_tokens=10000,
            from_fast_cache=True,
        )
        assert wf.own_cost_cents == 0.0
        activity_names = [c[0] for c in fake.activity_calls]
        assert "save_tool_usage" in activity_names
        save_call = next(c for c in fake.activity_calls if c[0] == "save_tool_usage")
        saved_item = save_call[1][3][0]
        assert saved_item["cost_cents"] == 0
        assert saved_item["model"] == "claude-fable-5-anthropic"
        assert saved_item["cache_read_input_tokens"] == 10000
        assert saved_item["from_fast_cache"] is True
    finally:
        _restore_workflow(original)


async def test_workflow_track_usage_empty_is_no_op():
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._track_usage(None)
        await wf._track_usage({})
        assert wf.own_cost_cents == 0.0
        assert fake.activity_calls == []
    finally:
        _restore_workflow(original)


async def test_workflow_track_usage_service_cost():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        usage = {"service": [{"cost_cents": 2.5, "provider": "Exa"}]}
        await wf._track_usage(usage, tool_name="web_search")
        assert abs(wf.own_cost_cents - 2.5) < 1e-6
        activity_names = [c[0] for c in fake.activity_calls]
        assert "save_tool_usage" in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_track_usage_direct_compute_token_is_zero_cost():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        usage = {
            "llm": [
                {
                    "tokens_in": 104487,
                    "tokens_out": 539,
                    "model": "gpt-5.4-gpt",
                    "provider": "Explore Agent",
                    "cache_read_input_tokens": 8576,
                    "cache_creation_input_tokens": 7984,
                }
            ]
        }
        await wf._track_usage(usage, tool_name="spawn_sub_agent", call_site="explore_agent")
        assert wf.own_cost_cents == 0.0
        activity_names = [c[0] for c in fake.activity_calls]
        assert "save_tool_usage" in activity_names
        save_call = next(c for c in fake.activity_calls if c[0] == "save_tool_usage")
        saved_item = save_call[1][3][0]
        assert saved_item["cost_cents"] == 0
        assert saved_item["model"] == "gpt-5.4-gpt"
        assert saved_item["cache_read_input_tokens"] == 8576
        assert saved_item["cache_creation_input_tokens"] == 7984
    finally:
        _restore_workflow(original)


async def test_workflow_track_usage_fast_cache_replay_is_zero_cost():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.model = "claude-sonnet-4"
    wf.input_cents_per_1k = 0.3
    wf.output_cents_per_1k = 1.5
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        usage = {
            "llm": [
                {
                    "tokens_in": 0,
                    "tokens_out": 4646,
                    "model": "google/gemini-3.1-pro-preview",
                    "provider": "Explore Agent",
                    "cache_read_input_tokens": 7600,
                    "cache_creation_input_tokens": 0,
                    "from_fast_cache": True,
                }
            ]
        }
        await wf._track_usage(usage, tool_name="spawn_sub_agent", call_site="explore_agent")
        assert wf.own_cost_cents == 0.0
        activity_names = [c[0] for c in fake.activity_calls]
        assert "save_tool_usage" in activity_names
        save_call = next(c for c in fake.activity_calls if c[0] == "save_tool_usage")
        saved_item = save_call[1][3][0]
        assert saved_item["cost_cents"] == 0
        assert saved_item["model"] == "google/gemini-3.1-pro-preview"
        assert saved_item["tokens_out"] == 4646
        assert saved_item["cache_read_input_tokens"] == 7600
        assert saved_item["from_fast_cache"] is True
    finally:
        _restore_workflow(original)


async def test_workflow_update_cost_and_signal_parent_root_checks_limit():
    wf = _bare_workflow_instance()
    wf.agent_id = "root"
    wf.user_id = "u"
    wf.parent_workflow_id = None
    wf.own_cost_cents = 50.0
    wf.children_cost_cents = {"c1": 60.0}
    wf.tokens_in = 100
    wf.tokens_out = 50
    wf.price_limit_cents = 100  # Under 50+60=110 → should trip
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._update_cost_and_signal_parent()
        assert wf.subtree_cost_cents == 110.0
        assert wf._cost_limit_reached is True
        assert wf.is_paused is True
    finally:
        _restore_workflow(original)


async def test_workflow_update_cost_and_signal_parent_non_root_signals():
    wf = _bare_workflow_instance()
    wf.agent_id = "child"
    wf.user_id = "u"
    wf.parent_workflow_id = "parent-wf-id"
    wf.own_cost_cents = 5.0
    wf.children_cost_cents = {}
    wf.tokens_in = 100
    wf.tokens_out = 50
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._update_cost_and_signal_parent()
        # Should have sent child_cost_update to parent
        assert any(s[1] == "child_cost_update" for s in fake.signal_calls)
        assert wf._cost_limit_reached is False  # non-root doesn't check limit
    finally:
        _restore_workflow(original)


async def test_workflow_update_cost_after_finished_skips_active_broadcast():
    """Regression: completion_summary cost (or late child_cost_update from a
    sub-agent that finished after us) used to call _update_cost_and_signal_parent
    AFTER mark_finished set status=COMPLETED, broadcasting status=ACTIVE/Processing
    over the terminal status. The benchmark harness then polled forever until
    the stall threshold deleted the agent (404/DELETED at 136s, 0 messages in
    the failure JSON because the harness treats DELETED-during-poll as 0-msg).

    With _is_finished latched True at mark_complete/mark_failed, the
    broadcast block must be skipped so COMPLETED/FAILED stick.
    """
    wf = _bare_workflow_instance()
    wf.agent_id = "root"
    wf.user_id = "u"
    wf.parent_workflow_id = None
    wf.own_cost_cents = 1.0
    wf.children_cost_cents = {}
    wf.tokens_in = 10
    wf.tokens_out = 5
    wf.price_limit_cents = 100
    wf._is_finished = True  # mark_complete already ran
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._update_cost_and_signal_parent()
        # Subtree cost is recalculated either way (tree cost persistence is fine).
        assert wf.subtree_cost_cents == 1.0
        # CRITICAL: must NOT have invoked update_agent_status with status=ACTIVE
        # after we are finished. activity_calls is List[(fn_name, args)].
        # update_agent_status signature: (agent_id, status, progress, msg, ...)
        for fn_name, args in fake.activity_calls:
            if (
                fn_name == "update_agent_status"
                and isinstance(args, (list, tuple))
                and len(args) >= 2
                and args[0] == "root"
                and args[1] == "ACTIVE"
            ):
                raise AssertionError(
                    "update_agent_status was called with status=ACTIVE after "
                    "_is_finished was latched — this is the bug that caused the "
                    "smoke 404/DELETED-at-136s failures."
                )
    finally:
        _restore_workflow(original)


async def test_workflow_check_cost_limit_no_op_when_below():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.parent_workflow_id = None
    wf.subtree_cost_cents = 10.0
    wf.price_limit_cents = 100
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._check_cost_limit()
        assert wf._cost_limit_reached is False
        assert wf.is_paused is False
    finally:
        _restore_workflow(original)


async def test_workflow_check_cost_limit_skips_non_root():
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = "parent"
    wf.subtree_cost_cents = 999
    wf.price_limit_cents = 10
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._check_cost_limit()
        assert wf._cost_limit_reached is False
    finally:
        _restore_workflow(original)


async def test_workflow_update_tree_state_skips_without_bus():
    wf = _bare_workflow_instance()
    wf.bus_id = None
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._update_tree_state(status="ACTIVE")
        # No activity calls because bus_id missing
        assert fake.activity_calls == []
    finally:
        _restore_workflow(original)


async def test_workflow_update_tree_state_with_bus_broadcasts():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.bus_id = "bus-1"
    wf.goal = "do the thing"
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._update_tree_state(status="PAUSED", progress=0.5)
        activity_names = [c[0] for c in fake.activity_calls]
        assert "update_agent_tree_state" in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_persist_tree_cost_executes_activity():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.subtree_cost_cents = 7.5
    wf.own_cost_cents = 3.0
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._persist_tree_cost()
        activity_names = [c[0] for c in fake.activity_calls]
        assert "update_agent_tree_cost_activity" in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_query_parent_state_returns_empty_without_parent():
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = None
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        result = await wf._query_parent_state()
        assert result == {}
    finally:
        _restore_workflow(original)


async def test_workflow_check_paused_reflects_flag():
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = None  # Skip parent state
    wf.is_paused = True
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        assert await wf._check_paused() is True
    finally:
        _restore_workflow(original)


async def test_workflow_refresh_claude_token_still_fresh_returns_early():
    wf = _bare_workflow_instance()
    wf.claude_max_token = "existing-token"
    fake = _FakeWorkflowModule()
    wf.claude_max_token_fetched_at = fake.now_value  # Age = 0 < 5min
    original = _patch_workflow(fake)
    try:
        await wf._refresh_claude_token("user-1")
        # No activity calls because token fresh
        activity_names = [c[0] for c in fake.activity_calls]
        assert "fetch_compute_token_activity" not in activity_names
        assert wf.claude_max_token == "existing-token"
    finally:
        _restore_workflow(original)


async def test_workflow_on_tokens_calculates_cost_with_pricing():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.model = "claude-sonnet-4"
    wf.input_cents_per_1k = 0.3
    wf.output_cents_per_1k = 1.5
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._on_tokens(
            tokens_in_delta=1000,
            tokens_out_delta=500,
            actual_model=None,
            cache_read_input_tokens=0,
            cache_creation_input_tokens=0,
            call_site="test",
        )
        assert wf.tokens_in == 1000
        assert wf.tokens_out == 500
        assert wf.own_cost_cents > 0
        activity_names = [c[0] for c in fake.activity_calls]
        assert "save_tool_usage" in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_on_tokens_no_pricing_still_logs():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.input_cents_per_1k = 0.0
    wf.output_cents_per_1k = 0.0
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._on_tokens(tokens_in_delta=100, tokens_out_delta=50, actual_model=None, call_site="x")
        assert wf.tokens_in == 100
        assert wf.tokens_out == 50
        assert wf.own_cost_cents == 0.0
    finally:
        _restore_workflow(original)


async def test_workflow_on_tokens_fast_cache_replay_is_zero_cost():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.model = "claude-sonnet-4"
    wf.input_cents_per_1k = 0.3
    wf.output_cents_per_1k = 1.5
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._on_tokens(
            tokens_in_delta=0,
            tokens_out_delta=1136,
            actual_model="claude-fable-5-anthropic",
            cache_read_input_tokens=9405,
            cache_creation_input_tokens=0,
            call_site="execute_loop",
            from_fast_cache=True,
        )
        assert wf.tokens_in == 0
        assert wf.tokens_out == 1136
        assert wf.own_cost_cents == 0.0
        activity_names = [c[0] for c in fake.activity_calls]
        assert "save_tool_usage" in activity_names
        save_call = next(c for c in fake.activity_calls if c[0] == "save_tool_usage")
        saved_item = save_call[1][3][0]
        assert saved_item["cost_cents"] == 0.0
        assert saved_item["model"] == "claude-fable-5-anthropic"
        assert saved_item["cache_read_input_tokens"] == 9405
        assert saved_item["from_fast_cache"] is True
    finally:
        _restore_workflow(original)


async def test_workflow_wait_for_messages_timeout_returns_false():
    # When _wait_for_messages times out and no new messages, returns False.
    # Use a fake workflow.wait_condition that raises asyncio.TimeoutError.
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()

    async def fake_wait_condition(cond, timeout=None):
        raise asyncio.TimeoutError()

    fake.wait_condition = fake_wait_condition
    original = _patch_workflow(fake)
    try:
        result = await wf._wait_for_messages()
        assert result is False
    finally:
        _restore_workflow(original)


async def test_workflow_get_model_pricing_returns_primary_when_matches():
    wf = _bare_workflow_instance()
    wf.model = "claude-sonnet-4"
    wf.input_cents_per_1k = 0.3
    wf.output_cents_per_1k = 1.5
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        pricing = await wf._get_model_pricing("claude-sonnet-4")
        assert pricing == {"input_cents_per_1k": 0.3, "output_cents_per_1k": 1.5}
        # No fetch activity because primary pricing is cached
        activity_names = [c[0] for c in fake.activity_calls]
        assert "fetch_model_pricing" not in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_get_model_pricing_uses_cache():
    wf = _bare_workflow_instance()
    wf.model = "other-model"
    wf.model_pricing_cache["cached-model"] = {"input_cents_per_1k": 1.0, "output_cents_per_1k": 2.0}
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        pricing = await wf._get_model_pricing("cached-model")
        assert pricing == {"input_cents_per_1k": 1.0, "output_cents_per_1k": 2.0}
        activity_names = [c[0] for c in fake.activity_calls]
        assert "fetch_model_pricing" not in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_mark_failed_signals_parent_with_context():
    wf = _bare_workflow_instance()
    wf.agent_id = "child-1"
    wf.user_id = "u-1"
    wf.goal = "fail goal"
    wf.parent_workflow_id = "parent-wf"
    wf.token_count = 10
    wf.context_size = 500
    wf.tokens_in = 100
    wf.tokens_out = 50
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 0, 30, tzinfo=timezone.utc)
    original = _patch_workflow(fake)
    try:
        ctx = [{"role": "USER", "text": "orig"}]
        await wf._mark_failed(
            context=ctx,
            reason="max_iterations",
            message="Max Steps Reached",
            verifier_progress=0.5,
            verifier_reasoning="halfway",
            partial_structured_response={"answer": "best effort"},
        )
        # Should call update_agent_status and tree state
        activity_names = [c[0] for c in fake.activity_calls]
        assert "update_agent_status" in activity_names
        assert "post_agent_message" in activity_names
        # Signal to parent
        signal_names = [s[1] for s in fake.signal_calls]
        assert "child_completed" in signal_names
        child_completed = next(s[2] for s in fake.signal_calls if s[1] == "child_completed")
        assert child_completed["result"]["status"] == "failed"
        assert child_completed["result"]["structured_response"] == {"answer": "best effort"}
    finally:
        _restore_workflow(original)


async def test_workflow_mark_failed_no_parent_no_signal():
    wf = _bare_workflow_instance()
    wf.agent_id = "root-1"
    wf.user_id = "u-1"
    wf.goal = "root goal"
    wf.parent_workflow_id = None
    wf.token_count = 10
    wf.tokens_in = 50
    wf.tokens_out = 20
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._mark_failed(
            context=[],
            reason="error",
            message="Something broke",
        )
        # No child_completed signal (no parent)
        signal_names = [s[1] for s in fake.signal_calls]
        assert "child_completed" not in signal_names
    finally:
        _restore_workflow(original)


async def test_workflow_handle_incomplete_max_iterations():
    """_handle_incomplete calls _mark_failed and returns failed result for max_iterations."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.goal = "g"
    wf.parent_workflow_id = None
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        events = []

        async def wait_for_refresh():
            events.append("refresh")

        async def mark_failed(**_kwargs):
            events.append("failed")

        wf._wait_for_response_schema_refresh = wait_for_refresh
        wf._mark_failed = mark_failed
        result = await wf._handle_incomplete(
            {"status": "max_iterations", "context": [], "verifier_progress": 0.5},
            phase="EXECUTE",
        )
        assert result["status"] == "failed"
        assert result["reason"] == "max_iterations"
        assert events == ["refresh", "failed"]
    finally:
        _restore_workflow(original)


async def test_workflow_handle_incomplete_error():
    """_handle_incomplete handles error status."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.goal = "g"
    wf.parent_workflow_id = None
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        events = []

        async def wait_for_refresh():
            events.append("refresh")

        async def mark_failed(**_kwargs):
            events.append("failed")

        wf._wait_for_response_schema_refresh = wait_for_refresh
        wf._mark_failed = mark_failed
        result = await wf._handle_incomplete(
            {"status": "error", "context": [], "message": "Bad happened"},
            phase="EXECUTE",
        )
        assert result["status"] == "failed"
        assert result["reason"] == "error"
        assert events == ["refresh", "failed"]
    finally:
        _restore_workflow(original)


async def test_workflow_handle_incomplete_unknown_passthrough():
    """_handle_incomplete returns unknown status dict as-is."""
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        result = await wf._handle_incomplete({"status": "weird", "foo": "bar"}, phase="PLAN")
        assert result == {"status": "weird", "foo": "bar"}
    finally:
        _restore_workflow(original)


async def test_workflow_check_credits_no_credits_pauses():
    """_check_credits flips is_paused=True when subscribed credits are depleted."""
    wf = _bare_workflow_instance()
    wf.user_id = "u"
    fake = _FakeWorkflowModule()

    async def fake_exec(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "check_user_usage":
            return {"has_credits": False, "tier": 20}
        return None

    fake.execute_activity = fake_exec
    original = _patch_workflow(fake)
    try:
        await wf._check_credits()
        assert wf.is_paused is True
        assert wf._has_credits is False
    finally:
        _restore_workflow(original)


async def test_workflow_check_credits_free_credits_exhausted_raises_subscription_gate():
    """A no-subscription user with exhausted free credits gets a subscription gate."""
    import workflows.agent_workflow as workflow_module

    wf = _bare_workflow_instance()
    wf.user_id = "u-free-credit"
    wf.agent_id = "a-free-credit"
    fake = _FakeWorkflowModule()
    fake.activity_returns["check_user_usage"] = {
        "has_credits": False,
        "remaining": 0,
        "used": 0.01,
        "total": 0.01,
        "tier": None,
    }
    fake.activity_returns["mint_subscription_checkout_activity"] = "https://roselabs.ai/s/free-credit"
    raised = {}

    async def fake_raise_gate(workflow_instance, gate, gate_key):
        raised["workflow"] = workflow_instance
        raised["gate"] = gate
        raised["gate_key"] = gate_key
        return "resolved"

    original_workflow = _patch_workflow(fake)
    original_raise_gate = workflow_module.raise_gate_direct
    workflow_module.raise_gate_direct = fake_raise_gate
    try:
        await wf._check_credits()
        assert wf._has_credits is False
        assert wf.is_paused is False
        assert raised["workflow"] is wf
        assert raised["gate_key"] == "subscription"
        assert raised["gate"]["type"] == "subscription"
        assert raised["gate"]["action"]["url"] == "https://roselabs.ai/s/free-credit"
        assert raised["gate"]["presentation"]["title"] == "Subscribe to continue this task"
        assert raised["gate"]["presentation"]["reason"].startswith("Your free credits are exhausted")
        activity_names = [name for name, _args in fake.activity_calls]
        assert activity_names == ["check_user_usage", "mint_subscription_checkout_activity"]
    finally:
        workflow_module.raise_gate_direct = original_raise_gate
        _restore_workflow(original_workflow)


async def test_workflow_check_credits_free_credit_checkout_failure_pauses():
    """Once usage proves free credits are exhausted, checkout failures must fail closed."""
    wf = _bare_workflow_instance()
    wf.user_id = "u-free-credit"
    wf.agent_id = "a-free-credit"
    fake = _FakeWorkflowModule()

    async def fake_exec(fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "")
        if name == "check_user_usage":
            return {
                "has_credits": False,
                "remaining": 0,
                "used": 0.01,
                "total": 0.01,
                "tier": None,
            }
        if name == "mint_subscription_checkout_activity":
            raise RuntimeError("subscription checkout unavailable")
        return None

    fake.execute_activity = fake_exec
    original = _patch_workflow(fake)
    try:
        await wf._check_credits()
        assert wf._has_credits is False
        assert wf.is_paused is True
    finally:
        _restore_workflow(original)


async def test_workflow_check_credits_has_credits_no_pause():
    """_check_credits sets _has_credits=True and does not pause when credits ok."""
    wf = _bare_workflow_instance()
    wf.user_id = "u"
    fake = _FakeWorkflowModule()

    async def fake_exec(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "check_user_usage":
            return {"has_credits": True}
        return None

    fake.execute_activity = fake_exec
    original = _patch_workflow(fake)
    try:
        await wf._check_credits()
        assert wf.is_paused is False
        assert wf._has_credits is True
    finally:
        _restore_workflow(original)


async def test_workflow_check_credits_on_exception_continues():
    """_check_credits warns and continues if activity raises."""
    wf = _bare_workflow_instance()
    wf.user_id = "u"
    fake = _FakeWorkflowModule()

    async def fake_exec(fn, args=None, **kwargs):
        raise RuntimeError("credits endpoint down")

    fake.execute_activity = fake_exec
    original = _patch_workflow(fake)
    try:
        await wf._check_credits()
        # No crash - defaults unchanged
        assert wf.is_paused is False
    finally:
        _restore_workflow(original)


async def test_workflow_post_message_executes_activity():
    """_post_message forwards to post_agent_message activity."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.message_count = 0
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._post_message("hello", "ASSISTANT", {"toolCallId": "tc-1"})
        activity_names = [c[0] for c in fake.activity_calls]
        assert "post_agent_message" in activity_names
        assert wf.message_count == 1
    finally:
        _restore_workflow(original)


async def test_workflow_post_message_failure_logs_warning():
    """_post_message swallows errors from activity."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    fake = _FakeWorkflowModule()
    fake.activity_fail_for.add("post_agent_message")
    original = _patch_workflow(fake)
    try:
        # Should not raise
        await wf._post_message("x", "USER", {})
    finally:
        _restore_workflow(original)


async def test_workflow_advances_pending_cloud_agent_tool():
    """Workflow posts the approved cloud-agent lifecycle states on one tool call."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    fake = _FakeWorkflowModule()
    fake.activity_returns["poll_new_messages"] = [
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolCallId": "tc-cloud",
                "toolName": "cloud_agent",
                "toolStatus": "IN_PROGRESS",
                "title": "Creating Cloud Agent",
            },
        }
    ]
    original = _patch_workflow(fake)
    try:
        await wf._advance_cloud_agent_lifecycle("Preparing Cloud Agent", "IN_PROGRESS")
        await wf._advance_cloud_agent_lifecycle("Starting Reasoning", "IN_PROGRESS")
        await wf._advance_cloud_agent_lifecycle("Cloud Agent Ready", "FINISHED")
        posts = [c for c in fake.activity_calls if c[0] == "post_agent_message"]
        assert len(posts) == 3
        titles = [post[1][3]["title"] for post in posts]
        statuses = [post[1][3]["toolStatus"] for post in posts]
        assert titles == ["Preparing Cloud Agent", "Starting Reasoning", "Cloud Agent Ready"]
        assert statuses == ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"]
        for post in posts:
            args = post[1]
            assert args[1] == ""
            assert args[3]["toolCallId"] == "tc-cloud"
            assert args[3]["toolName"] == "cloud_agent"
    finally:
        _restore_workflow(original)


async def test_workflow_lifecycle_updates_preserve_start_phase():
    """Lifecycle updates carry the pending row's startPhase forward.

    The chat handler stamps startPhase only on the initial "Creating Cloud
    Agent" row; the front-end dedups tool messages by toolCallId keeping the
    LATEST, so an update without startPhase erases the chip's
    data-agent-start-phase attribute (prod chat-lifecycle-ratchet route
    milestone flake, 2026-07-18).
    """
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    fake = _FakeWorkflowModule()
    fake.activity_returns["poll_new_messages"] = [
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolCallId": "tc-cloud",
                "toolName": "cloud_agent",
                "toolStatus": "IN_PROGRESS",
                "title": "Creating Cloud Agent",
                "startPhase": "execute",
            },
        }
    ]
    original = _patch_workflow(fake)
    try:
        await wf._advance_cloud_agent_lifecycle("Preparing Cloud Agent", "IN_PROGRESS")
        await wf._advance_cloud_agent_lifecycle("Cloud Agent Ready", "FINISHED")
        posts = [c for c in fake.activity_calls if c[0] == "post_agent_message"]
        assert len(posts) == 2
        for post in posts:
            assert post[1][3]["startPhase"] == "execute"
    finally:
        _restore_workflow(original)


async def test_workflow_does_not_advance_terminal_cloud_agent_tool():
    """Existing terminal cloud_agent row prevents duplicate lifecycle messages."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    fake = _FakeWorkflowModule()
    fake.activity_returns["poll_new_messages"] = [
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolCallId": "tc-cloud",
                "toolName": "cloud_agent",
                "toolStatus": "IN_PROGRESS",
                "title": "Creating Cloud Agent",
            },
        },
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolCallId": "tc-cloud",
                "toolName": "cloud_agent",
                "toolStatus": "FINISHED",
                "title": "Cloud Agent Ready",
            },
        },
    ]
    original = _patch_workflow(fake)
    try:
        await wf._advance_cloud_agent_lifecycle("Preparing Cloud Agent", "IN_PROGRESS")
        posts = [c for c in fake.activity_calls if c[0] == "post_agent_message"]
        assert posts == []
    finally:
        _restore_workflow(original)


async def test_workflow_caches_missing_cloud_agent_tool():
    """No cloud_agent row means direct agent workflows should stop rescanning."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    fake = _FakeWorkflowModule()
    fake.activity_returns["poll_new_messages"] = [
        {
            "role": "TOOL",
            "text": "Agent initialization complete.",
            "metadata": {
                "toolCallId": "tc-agent-init",
                "toolName": "agent_init",
                "toolStatus": "FINISHED",
            },
        }
    ]
    original = _patch_workflow(fake)
    try:
        await wf._advance_cloud_agent_lifecycle("Preparing Cloud Agent", "IN_PROGRESS")
        await wf._advance_cloud_agent_lifecycle("Cloud Agent Ready", "FINISHED")
        polls = [c for c in fake.activity_calls if c[0] == "poll_new_messages"]
        posts = [c for c in fake.activity_calls if c[0] == "post_agent_message"]
        assert len(polls) == 1
        assert posts == []
        assert wf._cloud_agent_lifecycle_finished is True
    finally:
        _restore_workflow(original)


async def test_workflow_run_covers_chat_agent_startup_and_completion():
    """Direct run() smoke covers startup lifecycle, context gates, schema generation, and completion."""
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    fake.activity_returns.update(
        {
            "poll_new_messages": [],
            "get_model_context_window": 200_000,
            "get_agent_source": "SMS",
            "get_user_context": "remembered context",
            "get_user_system_name": "Navi",
            "get_user_custom_system_prompt": "Prefer concise answers.",
            "fetch_compute_token_activity": {
                "type": "gpt",
                "accessToken": "gpt-token",
                "accountId": "acct-1",
                "source": "pool",
                "poolTokenId": "pool-1",
            },
            "fetch_agent_config": {
                "response_schema": None,
                "write_lock_enabled": False,
            },
            "set_response_schema_activity": {
                "schema": {"fields": [{"name": "answer", "type": "string"}]},
            },
            "generate_completion_summary": {
                "summary": "Finished cleanly.",
                "tool_counts": {"web_search": 1},
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
        }
    )

    import workflows.agent_workflow as workflow_module

    original_workflow = _patch_workflow(fake)
    original_run_agent = workflow_module.run_agent
    run_agent_calls = []

    async def fake_run_agent(**kwargs):
        run_agent_calls.append(kwargs)
        if kwargs.get("is_plan_loop"):
            return {
                "status": "completed",
                "context": [],
                "token_count": 7,
                "context_size": 100,
            }
        return {
            "status": "completed",
            "context": [{"role": "ASSISTANT", "text": "done", "metadata": None}],
            "structured_response": {"answer": "done"},
            "token_count": 11,
            "context_size": 120,
        }

    workflow_module.run_agent = fake_run_agent
    try:
        result = await wf.run(
            "agent-run-1",
            "user-run-1",
            "Complete the task",
            "anthropic/claude-sonnet-4.5",
            256,
            {"type": "FLOAT_LLM_JUDGE"},
            None,
            None,
            None,
            0,
            None,
            "plan",
            None,
            250,
            {"custom_system_prompt": True},
        )

        assert result == {"status": "completed", "goal": "Complete the task"}
        assert len(run_agent_calls) == 2
        assert run_agent_calls[0]["is_plan_loop"] is True
        assert run_agent_calls[1]["skip_blueprint_query"] is True
        assert wf.compute_token_provider == "gpt"
        assert wf.gpt_code_token == "gpt-token"
        assert wf.output_schema == {"fields": [{"name": "answer", "type": "string"}]}
        activity_names = [c[0] for c in fake.activity_calls]
        assert "notify_sms_event_activity" in activity_names
        assert "set_response_schema_activity" in activity_names
        schema_calls = [c for c in fake.activity_calls if c[0] == "set_response_schema_activity"]
        assert schema_calls[0][1][2] == {
            "type": "gpt",
            "accessToken": "gpt-token",
            "userId": "user-run-1",
            "accountId": "acct-1",
            "source": "pool",
            "poolTokenId": "pool-1",
            "lineageKey": "agent:agent-run-1",
            "agentId": "agent-run-1",
            "rootAgentId": "agent-run-1",
            "fastCacheAffinityKey": None,
        }
        assert "mark_finished" in activity_names
        init_posts = [
            c for c in fake.activity_calls if c[0] == "post_agent_message" and c[1][3].get("toolName") == "agent_init"
        ]
        assert len(init_posts) == 2
        assert init_posts[0][1][3]["toolCallId"] == "tc-agent-init"
        assert init_posts[0][1][3]["toolStatus"] == "IN_PROGRESS"
        assert init_posts[1][1][3]["toolCallId"] == "tc-agent-init"
        assert init_posts[1][1][3]["toolStatus"] == "FINISHED"
    finally:
        workflow_module.run_agent = original_run_agent
        _restore_workflow(original_workflow)


async def test_workflow_run_skips_response_schema_generation_for_subagent():
    """Sub-agents reuse parent/task schemas and do not generate their own startup schema."""
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    fake.activity_returns.update(
        {
            "poll_new_messages": [],
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Navi",
            "get_user_custom_system_prompt": None,
            "fetch_compute_token_activity": None,
            "fetch_agent_config": {
                "response_schema": None,
                "parent_agent_id": "parent-agent-1",
                "write_lock_enabled": True,
            },
            "query_parent_state_activity": {"is_paused": False, "is_cost_limit_reached": False},
            "generate_completion_summary": {
                "summary": "Finished cleanly.",
                "tool_counts": {},
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            },
        }
    )

    import workflows.agent_workflow as workflow_module

    original_workflow = _patch_workflow(fake)
    original_run_agent = workflow_module.run_agent

    async def fake_run_agent(**kwargs):
        return {
            "status": "completed",
            "context": [{"role": "ASSISTANT", "text": "done", "metadata": None}],
            "structured_response": None,
            "token_count": 1,
            "context_size": 10,
        }

    workflow_module.run_agent = fake_run_agent
    try:
        result = await wf.run(
            "child-agent-1",
            "user-run-1",
            "Complete the child task",
            "anthropic/claude-sonnet-4.5",
            256,
            {"type": "FLOAT_LLM_JUDGE"},
            None,
            "parent-workflow-1",
            "parent-agent-1",
            1,
            None,
            "execute",
            25,
            250,
            {},
        )

        assert result == {"status": "completed", "goal": "Complete the child task"}
        activity_names = [c[0] for c in fake.activity_calls]
        assert "fetch_agent_config" in activity_names
        assert "set_response_schema_activity" not in activity_names
    finally:
        workflow_module.run_agent = original_run_agent
        _restore_workflow(original_workflow)


async def test_workflow_dag_failure_recovers_via_run_agent():
    """A single failed planned task must NOT terminate the run.

    Regression guard for commit 500715a5f, which converted a recoverable DAG-task
    failure into a terminal FAILED (it stopped falling through to run_agent). A
    failed/stalled DAG must fall through to the LLM loop so the agent CONTINUES
    ITERATING from the recorded context (completed results + the failure), exactly
    like the completed-but-unverified DAG path. execute_dag runs once and is never
    re-entered, so this does not replay the plan.

    ⚠️ Inverting this assertion (run_agent must NOT run / result FAILED on a single
    task failure) is a deliberate agent-recovery behavior change and requires human
    approval via /deploy's agent-behavior guard (Step 0b). Do not flip it silently.
    """
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    fake.activity_returns.update(
        {
            "poll_new_messages": [],
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Navi",
            "get_user_custom_system_prompt": None,
            "fetch_compute_token_activity": None,
            "fetch_agent_config": {
                "response_schema": {"fields": []},
                "write_lock_enabled": True,
            },
            "generate_completion_summary": {
                "summary": "Recovered after a failed planned task.",
                "tool_counts": {},
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            },
        }
    )

    import workflows.agent_workflow as workflow_module

    original_workflow = _patch_workflow(fake)
    original_extract_plan = workflow_module.extract_plan_from_context
    original_execute_dag = workflow_module.execute_dag
    original_run_agent = workflow_module.run_agent
    run_agent_calls = []
    dag_calls = []

    workflow_module.extract_plan_from_context = lambda _context: {
        "tasks": [{"goal": "Research Tokyo", "tool_name": "spawn_general_purpose_agent"}],
        "dependencies": {},
    }

    async def fake_execute_dag(**kwargs):
        dag_calls.append(kwargs)
        # execute_dag signals a recoverable failure via "needs_llm" (never a
        # terminal status) so the workflow falls through to run_agent.
        return {
            "status": "needs_llm",
            "context": [{"role": "TOOL", "text": "failed", "metadata": {"error": True}}],
            "message": "Planned task 1 failed during DAG execution.",
        }

    async def fake_run_agent(**kwargs):
        # Reaching run_agent IS the invariant: the failed DAG handed off to the
        # LLM loop for recovery instead of terminating.
        run_agent_calls.append(kwargs)
        return {
            "status": "completed",
            "context": [{"role": "ASSISTANT", "text": "recovered", "metadata": None}],
            "structured_response": None,
            "token_count": 3,
            "context_size": 30,
        }

    workflow_module.execute_dag = fake_execute_dag
    workflow_module.run_agent = fake_run_agent
    try:
        result = await wf.run(
            "agent-dag-error",
            "user-run-1",
            "Complete the task",
            "anthropic/claude-sonnet-4.5",
            256,
            {"type": "FLOAT_LLM_JUDGE"},
            None,
            None,
            None,
            0,
            None,
            "execute",
            25,
            250,
            {},
        )

        assert len(dag_calls) == 1
        # The core regression guard: a failed planned task must reach run_agent.
        assert run_agent_calls, "failed DAG task must fall through to run_agent recovery, not terminate"
        assert result == {"status": "completed", "goal": "Complete the task"}
        failed_status_updates = [
            call for call in fake.activity_calls if call[0] == "update_agent_status" and call[1][1] == "FAILED"
        ]
        assert failed_status_updates == [], "a recoverable DAG-task failure must not mark the agent FAILED"
    finally:
        workflow_module.extract_plan_from_context = original_extract_plan
        workflow_module.execute_dag = original_execute_dag
        workflow_module.run_agent = original_run_agent
        _restore_workflow(original_workflow)


async def test_workflow_handle_tool_event_forwards_to_helper():
    """_handle_tool_event invokes handle_tool_event helper with our execute_activity."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    fake = _FakeWorkflowModule()

    import workflows.agent_workflow as m
    from tools.base import ToolEvent, EventType, MessageStatus

    orig_handle_tool_event = m.handle_tool_event
    called = {"n": 0}

    async def fake_handle(**kwargs):
        called["n"] += 1
        assert kwargs.get("agent_id") == "a"
        assert kwargs.get("user_id") == "u"

    m.handle_tool_event = fake_handle
    original = _patch_workflow(fake)
    try:
        evt = ToolEvent(
            type=EventType.POST_MESSAGE,
            message="hi",
            status=MessageStatus.IN_PROGRESS,
        )
        await wf._handle_tool_event(evt, "tc-1", "web_search")
        assert called["n"] == 1
    finally:
        _restore_workflow(original)
        m.handle_tool_event = orig_handle_tool_event


async def test_workflow_post_dag_completion_dispatches_attempt_completion_tool():
    """Post-DAG completion must be a visible attempt_completion tool call."""
    import workflows.agent_workflow as workflow_module

    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.current_phase = "EXECUTE"
    wf.output_schema = {"fields": []}
    wf.fast_mode_cache_enabled = False
    wf.fast_cache_goal = "goal"
    wf.compute_token_lineage_key = None
    wf.compute_token_fast_cache_affinity_key = None

    dispatched_tools = []
    verifier_kwargs = {}
    token_calls = []

    async def fake_execute_tool(tool_name, tool_args, tool_call_id):
        dispatched_tools.append((tool_name, tool_args, tool_call_id))
        return {"success": True}

    async def fake_refresh_compute_token(user_id):
        return None

    async def fake_run_verifier(**kwargs):
        verifier_kwargs.update(kwargs)
        return {
            "score": 1.0,
            "reasoning": "Complete",
            "structured_response": {"done": True},
            "usage": {
                "prompt_tokens": 5,
                "completion_tokens": 2,
                "total_tokens": 7,
                "cache_sequence_id": "post-dag-verifier-sequence",
            },
        }

    async def fake_on_tokens(*args, **kwargs):
        token_calls.append({"args": args, "kwargs": kwargs})

    wf._execute_tool = fake_execute_tool
    wf._refresh_compute_token = fake_refresh_compute_token
    wf._on_tokens = fake_on_tokens

    fake = _FakeWorkflowModule()
    fake.activity_returns["poll_new_messages"] = [
        {
            "role": "TOOL",
            "text": "dag result",
            "timestamp": "2025-01-01T00:00:00+00:00",
            "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
        }
    ]
    original_workflow = _patch_workflow(fake)
    original_run_verifier = workflow_module._run_verifier
    workflow_module._run_verifier = fake_run_verifier
    try:
        result = await wf._attempt_post_dag_completion(
            agent_id="agent-1",
            user_id="user-1",
            model="rose-labs/rose-1-lite",
        )
    finally:
        workflow_module._run_verifier = original_run_verifier
        _restore_workflow(original_workflow)

    expected_tool_call_id = "post-dag-attempt-completion-00000000-0000-0000-0000-000000000001"
    assert dispatched_tools == [
        (
            "attempt_completion",
            {"_verification_pending": True},
            expected_tool_call_id,
        )
    ]
    assert verifier_kwargs["tool_call_id"] == expected_tool_call_id
    assert verifier_kwargs["post_message"] == wf._post_message
    assert result["score"] == 1.0
    assert token_calls[0]["kwargs"]["cache_sequence_id"] == "post-dag-verifier-sequence"


async def test_workflow_post_dag_completion_verifier_error_closes_attempt_tool():
    """Verifier failure after post-DAG attempt_completion must close the tool row."""
    import workflows.agent_workflow as workflow_module

    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.current_phase = "EXECUTE"
    wf.output_schema = {"fields": []}
    wf.fast_mode_cache_enabled = False
    wf.fast_cache_goal = "goal"
    wf.compute_token_lineage_key = None
    wf.compute_token_fast_cache_affinity_key = None

    dispatched_tools = []
    posted_events = []

    async def fake_execute_tool(tool_name, tool_args, tool_call_id):
        dispatched_tools.append((tool_name, tool_args, tool_call_id))
        return {"success": True}

    async def fake_refresh_compute_token(user_id):
        return None

    async def fake_run_verifier(**kwargs):
        raise RuntimeError("verifier timed out")

    async def fake_handle_tool_event(event, tool_call_id, tool_name):
        posted_events.append((event, tool_call_id, tool_name))

    wf._execute_tool = fake_execute_tool
    wf._refresh_compute_token = fake_refresh_compute_token
    wf._handle_tool_event = fake_handle_tool_event

    fake = _FakeWorkflowModule()
    fake.activity_returns["poll_new_messages"] = []
    original_workflow = _patch_workflow(fake)
    original_run_verifier = workflow_module._run_verifier
    workflow_module._run_verifier = fake_run_verifier
    try:
        result = await wf._attempt_post_dag_completion(
            agent_id="agent-1",
            user_id="user-1",
            model="rose-labs/rose-1-lite",
        )
    finally:
        workflow_module._run_verifier = original_run_verifier
        _restore_workflow(original_workflow)

    expected_tool_call_id = "post-dag-attempt-completion-00000000-0000-0000-0000-000000000001"
    assert dispatched_tools == [
        (
            "attempt_completion",
            {"_verification_pending": True},
            expected_tool_call_id,
        )
    ]
    assert result["verifier_error"] is True
    assert result["score"] == 0.0
    assert posted_events
    event, tool_call_id, tool_name = posted_events[-1]
    assert tool_call_id == expected_tool_call_id
    assert tool_name == "attempt_completion"
    assert event.status.name == "ERROR"
    assert "verifier timed out" in event.message


async def test_workflow_check_parent_state_parent_paused_inherits():
    """_check_parent_state inherits pause when parent is paused."""
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = "parent-wf"
    wf.agent_id = "child"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    fake = _FakeWorkflowModule()

    async def fake_exec(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "query_parent_state_activity":
            return {"is_paused": True, "is_cost_limit_reached": False}
        return None

    fake.execute_activity = fake_exec
    original = _patch_workflow(fake)
    try:
        await wf._check_parent_state()
        assert wf.is_paused is True
        assert wf._paused_by_parent is True
    finally:
        _restore_workflow(original)


async def test_workflow_check_parent_state_parent_cost_limited_inherits():
    """_check_parent_state inherits cost limit when parent is cost-limited."""
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = "parent-wf"
    wf.agent_id = "child"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    fake = _FakeWorkflowModule()

    async def fake_exec(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "query_parent_state_activity":
            return {"is_paused": False, "is_cost_limit_reached": True}
        return None

    fake.execute_activity = fake_exec
    original = _patch_workflow(fake)
    try:
        await wf._check_parent_state()
        assert wf._cost_limit_reached is True
        assert wf.is_paused is True
        assert wf._paused_by_parent is True
    finally:
        _restore_workflow(original)


async def test_workflow_check_parent_state_parent_resumes_clears_inherit():
    """_check_parent_state unpauses a parent-paused child when parent resumes."""
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = "parent-wf"
    wf.agent_id = "child"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    wf.is_paused = True
    wf._paused_by_parent = True
    fake = _FakeWorkflowModule()

    async def fake_exec(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "query_parent_state_activity":
            return {"is_paused": False, "is_cost_limit_reached": False}
        return None

    fake.execute_activity = fake_exec
    original = _patch_workflow(fake)
    try:
        await wf._check_parent_state()
        assert wf.is_paused is False
        assert wf._paused_by_parent is False
    finally:
        _restore_workflow(original)


async def test_workflow_check_parent_state_parent_missing_orphans_child():
    """A child paused by its parent is orphaned (aborts) once the parent is gone,
    instead of staying paused forever (the busy-spin livelock)."""
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = "parent-wf"
    wf.agent_id = "child"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    wf.is_paused = True
    wf._paused_by_parent = True
    fake = _FakeWorkflowModule()

    async def fake_exec(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "query_parent_state_activity":
            return {"parent_missing": True}
        return None

    fake.execute_activity = fake_exec
    original = _patch_workflow(fake)
    try:
        await wf._check_parent_state()
        assert wf._orphaned is True
        assert wf.is_paused is False
        assert wf._paused_by_parent is False
    finally:
        _restore_workflow(original)


async def test_workflow_check_parent_state_parent_missing_ignores_manual_pause():
    """parent_missing must NOT abort a child that paused for its own reasons
    (user/credits) — only one that inherited its pause from the parent."""
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = "parent-wf"
    wf.agent_id = "child"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    wf.is_paused = True
    wf._paused_by_parent = False  # manual / credits pause, not inherited
    fake = _FakeWorkflowModule()

    async def fake_exec(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "query_parent_state_activity":
            return {"parent_missing": True}
        return None

    fake.execute_activity = fake_exec
    original = _patch_workflow(fake)
    try:
        await wf._check_parent_state()
        assert wf._orphaned is False
        assert wf.is_paused is True  # left as-is
    finally:
        _restore_workflow(original)


async def test_workflow_check_parent_state_transient_failure_backstop_orphans():
    """After N consecutive transient parent-read failures while paused-by-parent,
    the child gives up and orphans — backstop for a parent whose 'gone' state can't
    be cleanly classified."""
    from workflows.agent_workflow import _ORPHAN_TRANSIENT_FAILURE_LIMIT

    wf = _bare_workflow_instance()
    wf.parent_workflow_id = "parent-wf"
    wf.agent_id = "child"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    wf.is_paused = True
    wf._paused_by_parent = True
    fake = _FakeWorkflowModule()

    async def fake_exec(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "query_parent_state_activity":
            return {}  # transient failure every time
        return None

    fake.execute_activity = fake_exec
    original = _patch_workflow(fake)
    try:
        for _ in range(_ORPHAN_TRANSIENT_FAILURE_LIMIT - 1):
            await wf._check_parent_state()
        assert wf._orphaned is False  # not yet
        await wf._check_parent_state()  # hits the limit
        assert wf._orphaned is True
        assert wf.is_paused is False
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_happy_path():
    """_mark_complete posts summary, updates tree, signals parent."""
    wf = _bare_workflow_instance()
    wf.agent_id = "child-complete-1"
    wf.user_id = "u-mc"
    wf.goal = "finish goal"
    wf.model = "rose-1-lite"
    wf.parent_workflow_id = "parent-mc"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.token_count = 100
    wf.tokens_in = 70
    wf.tokens_out = 30
    wf.context_size = 500
    wf.child_tool_counts = {}
    wf.output_schema = {"fields": []}

    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 1, 0, tzinfo=timezone.utc)
    # Stub generate_completion_summary to return a summary dict
    fake.activity_returns["generate_completion_summary"] = {
        "summary": "All done",
        "tool_counts": {"web_search": 2},
        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(context=[{"role": "USER", "text": "go"}], structured_response={"answer": "42"})
        names = [c[0] for c in fake.activity_calls]
        assert "generate_completion_summary" in names
        assert "post_agent_message" in names
        assert "mark_finished" in names
        final_summary_index = next(
            i
            for i, (name, args) in enumerate(fake.activity_calls)
            if name == "post_agent_message"
            and len(args or []) >= 4
            and (args[3] or {}).get("toolName") == "completion_summary"
            and (args[3] or {}).get("toolStatus") == "FINISHED"
        )
        mark_finished_index = next(i for i, (name, _args) in enumerate(fake.activity_calls) if name == "mark_finished")
        assert final_summary_index < mark_finished_index
        # Child-completed signal to parent
        signal_names = [s[1] for s in fake.signal_calls]
        assert "child_completed" in signal_names
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_no_parent_no_signal():
    """_mark_complete without parent does not signal."""
    wf = _bare_workflow_instance()
    wf.agent_id = "root-mc"
    wf.user_id = "u-mc"
    wf.goal = "root goal"
    wf.model = "rose-1-lite"
    wf.parent_workflow_id = None
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.token_count = 0
    wf.tokens_in = 0
    wf.tokens_out = 0
    wf.context_size = 0
    wf.child_tool_counts = {}
    wf.output_schema = None
    wf.agent_source = "WEB"

    fake = _FakeWorkflowModule()
    fake.activity_returns["fetch_agent_config"] = {"response_schema": None}
    fake.activity_returns["generate_completion_summary"] = {
        "summary": "root done",
        "tool_counts": {},
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(context=[], structured_response=None)
        signal_names = [s[1] for s in fake.signal_calls]
        assert "child_completed" not in signal_names
    finally:
        _restore_workflow(original)


async def test_workflow_format_outputs_with_schema():
    """_format_outputs returns structured outputs array from response."""
    wf = _bare_workflow_instance()
    wf.output_schema = {
        "fields": [
            {"name": "answer", "type": "string"},
            {"name": "count", "type": "number"},
        ]
    }
    outputs = wf._format_outputs({"answer": "42", "count": 7})
    # Returns a list of {label, value, type} or similar
    assert isinstance(outputs, list)
    # Should have at least 2 entries for the two fields
    assert len(outputs) >= 1


async def test_workflow_format_outputs_empty_without_schema():
    """_format_outputs handles missing schema gracefully."""
    wf = _bare_workflow_instance()
    wf.output_schema = None
    outputs = wf._format_outputs({"answer": "anything"})
    assert isinstance(outputs, list)


async def test_workflow_format_outputs_none_response():
    """_format_outputs returns [] for None structured_response."""
    wf = _bare_workflow_instance()
    wf.output_schema = {"fields": [{"name": "x", "type": "string"}]}
    outputs = wf._format_outputs(None)
    assert outputs == []


async def test_workflow_extract_failure_context_basic():
    """_extract_failure_context extracts recent context into failure report."""
    wf = _bare_workflow_instance()
    wf.agent_id = "fc-1"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)

    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 0, 30, tzinfo=timezone.utc)
    original = _patch_workflow(fake)
    try:
        ctx = [
            {"role": "USER", "text": "goal"},
            {"role": "ASSISTANT", "text": "thinking"},
            {"role": "TOOL", "text": "result", "metadata": {"toolName": "web_search"}},
        ]
        result = wf._extract_failure_context(ctx, verifier_progress=0.4, verifier_reasoning="halfway")
        # Should return some structured failure context
        assert result is not None
    finally:
        _restore_workflow(original)


# ===========================================================================
# W3-A / W3-D additional coverage (poll_messages, execute_tool,
# refresh_claude_token, get_model_pricing, on_tokens branches)
# ===========================================================================


async def test_workflow_poll_messages_merges_and_sorts():
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    wf.context = [{"id": "m0", "timestamp": "2025-01-01T00:00:00"}]
    fake = _FakeWorkflowModule()
    fake.activity_returns["poll_new_messages"] = [
        {"id": "m2", "timestamp": "2025-01-01T00:00:02", "role": "USER"},
        {"id": "m1", "timestamp": "2025-01-01T00:00:01", "role": "USER"},
    ]
    original = _patch_workflow(fake)
    try:
        msgs = await wf._poll_messages(datetime(2025, 1, 1, tzinfo=timezone.utc))
        assert len(msgs) == 2
        # Context is sorted by timestamp ascending
        assert [m.get("id") for m in wf.context] == ["m0", "m1", "m2"]
    finally:
        _restore_workflow(original)


async def test_workflow_poll_messages_exception_raises():
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    fake = _FakeWorkflowModule()
    fake.activity_fail_for.add("poll_new_messages")
    original = _patch_workflow(fake)
    try:
        raised = False
        try:
            await wf._poll_messages(datetime(2025, 1, 1, tzinfo=timezone.utc))
        except Exception:
            raised = True
        assert raised, "Expected _poll_messages to raise on activity failure"
    finally:
        _restore_workflow(original)


async def test_workflow_execute_tool_unknown_tool_returns_error():
    """Unknown tool: returns error AND posts a TOOL event so the loop's next
    iteration sees a paired tool_result for the LLM's tool_use. Without the
    paired post, role_alternation trips (consecutive ASSISTANTs)."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    handle_calls = []

    async def fake_handle(event, tool_call_id, tool_name):
        handle_calls.append((event, tool_call_id, tool_name))

    wf._handle_tool_event = fake_handle  # type: ignore[assignment]
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        result = await wf._execute_tool("not_a_tool", {}, "call-1")
        assert result.get("error") is True
        assert "Unknown tool" in result.get("message", "")
        assert len(handle_calls) == 1, "Expected one TOOL event posted for unknown tool"
        event, tcid, tname = handle_calls[0]
        assert tcid == "call-1"
        assert tname == "not_a_tool"
        assert getattr(event, "status", None).name == "ERROR"
    finally:
        _restore_workflow(original)


async def test_plan_phase_spawn_agent_schema_rejects_non_explore_types():
    """PLAN phase: the LLM-facing schema enforces type='explore' at parse time.

    Replaces the old runtime-gate regression test: PLAN now narrows
    spawn_agent.type to a const "explore" via PLAN_TOOL_MODELS, so a
    type="browser" call never gets past create_agent_action_model parse —
    the runtime gate has been deleted as redundant.
    """
    from utils.tool_schemas import PLAN_PHASE_TOOLS, PLAN_TOOL_MODELS, create_agent_action_model

    AgentAction = create_agent_action_model(PLAN_PHASE_TOOLS, tool_registry=PLAN_TOOL_MODELS)

    valid = AgentAction.model_validate(
        {"response": "ok", "tool_calls": [{"tool": "spawn_agent", "type": "explore", "goal": "x"}]}
    )
    assert valid is not None

    rejected = 0
    for bad_type in ("browser", "code", "general_purpose", "for_each"):
        try:
            AgentAction.model_validate(
                {"response": "ok", "tool_calls": [{"tool": "spawn_agent", "type": bad_type, "goal": "x"}]}
            )
        except Exception:
            rejected += 1
    assert rejected == 4, f"PLAN AgentAction must reject all 4 non-explore types; got {rejected}/4 rejections"


async def test_workflow_execute_tool_invalid_params_returns_error_and_posts_tool_event():
    """Tools with Pydantic validators: invalid params returns error AND posts TOOL event.

    Same mechanism as the PLAN-phase block — every error return must produce
    a paired tool_result so the loop's next LLM call sees alternating turns.
    """
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    wf.current_phase = "EXECUTE"
    handle_calls = []

    async def fake_handle(event, tool_call_id, tool_name):
        handle_calls.append((event, tool_call_id, tool_name))

    wf._handle_tool_event = fake_handle  # type: ignore[assignment]
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        # spawn_agent's Pydantic model requires goal; passing only an empty type
        # triggers TOOL_MODELS validation failure.
        result = await wf._execute_tool("spawn_agent", {}, "call-1")
        assert result.get("error") is True
        assert "Invalid parameters" in result.get("message", "")
        assert len(handle_calls) == 1
        event, tcid, tname = handle_calls[0]
        assert tcid == "call-1"
        assert tname == "spawn_agent"
        assert getattr(event, "status", None).name == "ERROR"
    finally:
        _restore_workflow(original)


async def test_workflow_execute_tool_world_model_simulate_runs_agent_facing_executor():
    """World-model simulate mode must not short-circuit agent-facing tools."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.current_phase = "EXECUTE"
    wf.goal = "root goal"
    captured_kwargs: Dict[str, Any] = {}

    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    import workflows.agent_workflow as workflow_module

    async def fake_web_search_executor(**kwargs):
        captured_kwargs.update(kwargs)
        return {"content": "real executor result"}

    original_executor = workflow_module.TOOL_EXECUTORS["web_search"]
    workflow_module.TOOL_EXECUTORS["web_search"] = fake_web_search_executor
    old_env = {
        "BENCHMARK_WORLD_MODEL_MODE": os.environ.get("BENCHMARK_WORLD_MODEL_MODE"),
        "WMH_BASE_URL": os.environ.get("WMH_BASE_URL"),
        "WMH_MODEL_NAME": os.environ.get("WMH_MODEL_NAME"),
        "WMH_SESSION_ID": os.environ.get("WMH_SESSION_ID"),
    }
    try:
        os.environ["BENCHMARK_WORLD_MODEL_MODE"] = "simulate"
        os.environ["WMH_BASE_URL"] = "http://wmh.test"
        os.environ["WMH_MODEL_NAME"] = "rose-model"
        os.environ["WMH_SESSION_ID"] = "session-1"
        result = await wf._execute_tool("web_search", {"query": "rose labs"}, "tc-wmh")
        assert result["success"] is True
        assert result["result"] == {"content": "real executor result"}
        assert captured_kwargs["tool_call"]["tool"] == "web_search"
        assert captured_kwargs["tool_call_id"] == "tc-wmh"
        assert captured_kwargs["agent_id"] == "agent-1"
        assert "world_model_step_activity" not in [call[0] for call in fake.activity_calls]
    finally:
        workflow_module.TOOL_EXECUTORS["web_search"] = original_executor
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        _restore_workflow(original)


async def test_workflow_execute_tool_legacy_spawn_agent_receives_phase():
    """Legacy spawn_agent dispatch must pass current_phase to runtime validators."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    wf.user_id = "u1"
    wf.current_phase = "PLAN"
    captured: Dict[str, Any] = {}

    import workflows.agent_workflow as workflow_module
    from tools.base import MessageStatus

    async def fake_spawn_agent(workflow_instance, tool_call, tool_call_id):
        captured["workflow_instance"] = workflow_instance
        captured["tool_call"] = tool_call
        captured["tool_call_id"] = tool_call_id
        return MessageStatus.ERROR, "blocked in plan"

    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    original_executor = workflow_module.TOOL_EXECUTORS["spawn_agent"]
    workflow_module.TOOL_EXECUTORS["spawn_agent"] = fake_spawn_agent
    try:
        result = await wf._execute_tool(
            "spawn_agent",
            {
                "type": "general_purpose",
                "goal": "research city populations",
                "start_phase": "EXECUTE",
                "output_schema": {"fields": [{"name": "population", "type": "int", "required": True}]},
            },
            "tc-spawn",
        )
        assert result.get("error") is True
        assert captured["tool_call"]["_phase"] == "PLAN"
        assert captured["tool_call_id"] == "tc-spawn"
    finally:
        workflow_module.TOOL_EXECUTORS["spawn_agent"] = original_executor
        _restore_workflow(original)


async def test_workflow_execute_tool_web_fetch_preserves_fast_mode_kwargs():
    """web_fetch auth kwargs must merge with, not replace, Fast Mode cache kwargs."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    # Cache kwargs must thread the persisted-row goal, not the (possibly
    # chat-refined) workflow input goal.
    wf.goal = "refined workflow input goal"
    wf.fast_cache_goal = "root goal"
    wf.fast_mode_cache_enabled = True
    captured_kwargs: Dict[str, Any] = {}

    import workflows.agent_workflow as workflow_module

    async def fake_web_fetch_executor(**kwargs):
        captured_kwargs.update(kwargs)
        return {"content": "ok"}

    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    original_executor = workflow_module.TOOL_EXECUTORS["web_fetch"]
    workflow_module.TOOL_EXECUTORS["web_fetch"] = fake_web_fetch_executor
    try:
        result = await wf._execute_tool(
            "web_fetch",
            {"url": "https://example.com", "objective": "summarize"},
            "tc-web-fetch",
        )
        assert result["result"] == {"content": "ok"}
        assert captured_kwargs["fast_mode_cache_enabled"] is True
        assert captured_kwargs["fast_mode_goal"] == "root goal"
        assert "claude_token" in captured_kwargs
        assert "gpt_token" in captured_kwargs
    finally:
        workflow_module.TOOL_EXECUTORS["web_fetch"] = original_executor
        _restore_workflow(original)


async def test_workflow_approval_text_repopulates_same_tool_then_executes_once():
    """Approved-with-text refreshes only the pending call's params and does not gate twice."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-approval-jit"
    wf.user_id = "user-1"
    wf.current_phase = "EXECUTE"
    wf.fast_mode_cache_enabled = True
    wf.fast_cache_goal = "Call the restaurant and book dinner"
    wf._current_tools = ["call_phone_number", "web_search", "attempt_completion"]
    wf.context = [
        {
            "role": "USER",
            "text": "Call the restaurant and book dinner",
            "timestamp": "2026-07-11T20:40:00+00:00",
        }
    ]
    original_args = {
        "to": "+15555550123",
        "system_prompt": "Book dinner for 8:44 PM local time.",
        "output_schema": {
            "fields": [
                {
                    "name": "reservation_status",
                    "type": "str",
                    "required": True,
                    "description": "Whether the reservation was booked",
                }
            ]
        },
    }
    updated_args = {
        **original_args,
        "system_prompt": "Book dinner for 1:45 PM local time.",
    }
    approval_calls: List[str] = []
    executor_calls: List[Dict[str, Any]] = []
    token_calls: List[Dict[str, Any]] = []

    import workflows.agent_workflow as workflow_module

    async def fake_approval(workflow_instance, question, metadata=None, **kwargs):
        approval_calls.append(question)
        return {
            "response": "its 1:45pm local time",
            "question": question,
            "attention_request_id": "req-approval-jit",
        }

    async def fake_call_executor(**kwargs):
        executor_calls.append(kwargs)
        return {"result": {"status": "queued"}}

    async def fake_build_system_prompt():
        return "stable system prompt"

    async def fake_on_tokens(*args, **kwargs):
        token_calls.append({"args": args, "kwargs": kwargs})

    wf.build_system_prompt = fake_build_system_prompt
    wf._on_tokens = fake_on_tokens

    fake = _FakeWorkflowModule()
    fake.activity_returns["call_llm_activity"] = {
        "tool_calls": [{"tool": "call_phone_number", **updated_args}],
        "usage": {
            "prompt_tokens": 120,
            "completion_tokens": 20,
            "cache_read_input_tokens": 100,
            "cache_creation_input_tokens": 0,
            "actual_model": "anthropic/claude-sonnet-4.6",
            "cache_sequence_id": "approval-param-sequence",
        },
    }
    original_workflow = _patch_workflow(fake)
    original_approval = workflow_module.request_user_approval_direct
    original_executor = workflow_module.TOOL_EXECUTORS["call_phone_number"]
    workflow_module.request_user_approval_direct = fake_approval
    workflow_module.TOOL_EXECUTORS["call_phone_number"] = fake_call_executor
    try:
        result = await wf._execute_tool("call_phone_number", original_args, "tc-approval-jit")

        assert result["success"] is True
        assert len(approval_calls) == 1, "The already-approved refreshed call must not be gated again"
        assert len(executor_calls) == 1
        assert executor_calls[0]["tool_call"] == {"tool": "call_phone_number", **updated_args}

        llm_calls = [call for call in fake.activity_calls if call[0] == "call_llm_activity"]
        assert len(llm_calls) == 1
        llm_args = llm_calls[0][1]
        import inspect

        positional_params = [
            parameter
            for parameter in inspect.signature(workflow_module.call_llm_activity).parameters.values()
            if parameter.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
        ]
        assert len(llm_args) <= len(positional_params)
        assert llm_args[2] == wf._current_tools, "JIT must preserve the execute-phase tool schema"
        assert llm_args[8] == "approval_param_populator"
        assert llm_args[9] == "stable system prompt"
        assert "its 1:45pm local time" in llm_args[10]
        assert llm_args[11] == "call_phone_number"
        assert llm_args[12] is True, "JIT calls must read the stable prefix without writing a new cache tail"
        assert llm_args[25] is True, "JIT calls must inherit the workflow's Fast Mode setting"
        assert llm_args[26] == "Call the restaurant and book dinner"
        assert llm_args[28] is True, "JIT calls must force canonical backend context on every worker"
        assert llm_args[29] is True, "JIT must cache the stable context before its unique feedback suffix"
        assert llm_args[30] == "agent:agent-approval-jit:call:approval_param_populator"
        assert len(token_calls) == 1
        assert token_calls[0]["kwargs"]["cache_read_input_tokens"] == 100
        assert token_calls[0]["kwargs"]["call_site"] == "approval_param_populator"
        assert token_calls[0]["kwargs"]["cache_sequence_id"] == "approval-param-sequence"
    finally:
        workflow_module.request_user_approval_direct = original_approval
        workflow_module.TOOL_EXECUTORS["call_phone_number"] = original_executor
        _restore_workflow(original_workflow)


async def test_workflow_plain_approval_executes_original_params_without_jit():
    """A plain Approve click remains the direct approval -> execution path."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-plain-approval"
    wf.user_id = "user-1"
    wf.current_phase = "EXECUTE"
    original_args = {
        "to": "+15555550123",
        "system_prompt": "Confirm the restaurant's hours.",
        "output_schema": {
            "fields": [
                {
                    "name": "hours",
                    "type": "str",
                    "required": True,
                    "description": "Restaurant hours",
                }
            ]
        },
    }
    executor_calls: List[Dict[str, Any]] = []

    import workflows.agent_workflow as workflow_module

    async def fake_approval(workflow_instance, question, metadata=None, **kwargs):
        return {"response": "Approved", "question": question, "attention_request_id": "req-plain"}

    async def fake_call_executor(**kwargs):
        executor_calls.append(kwargs)
        return {"result": {"status": "queued"}}

    fake = _FakeWorkflowModule()
    original_workflow = _patch_workflow(fake)
    original_approval = workflow_module.request_user_approval_direct
    original_executor = workflow_module.TOOL_EXECUTORS["call_phone_number"]
    workflow_module.request_user_approval_direct = fake_approval
    workflow_module.TOOL_EXECUTORS["call_phone_number"] = fake_call_executor
    try:
        result = await wf._execute_tool("call_phone_number", original_args, "tc-plain-approval")

        assert result["success"] is True
        assert len(executor_calls) == 1
        assert executor_calls[0]["tool_call"] == {"tool": "call_phone_number", **original_args}
        assert not any(call[0] == "call_llm_activity" for call in fake.activity_calls)
    finally:
        workflow_module.request_user_approval_direct = original_approval
        workflow_module.TOOL_EXECUTORS["call_phone_number"] = original_executor
        _restore_workflow(original_workflow)


async def test_workflow_rejection_fails_tool_with_feedback_without_jit_or_execution():
    """Reject remains a terminal error and carries typed feedback into tool context."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-rejected-approval"
    wf.user_id = "user-1"
    wf.current_phase = "EXECUTE"
    tool_args = {
        "to": "+15555550123",
        "system_prompt": "Book dinner.",
        "output_schema": {
            "fields": [
                {
                    "name": "status",
                    "type": "str",
                    "required": True,
                    "description": "Booking status",
                }
            ]
        },
    }
    executor_calls: List[Dict[str, Any]] = []
    handled_events = []

    import workflows.agent_workflow as workflow_module

    async def fake_approval(workflow_instance, question, metadata=None, **kwargs):
        raise workflow_module.UserRejectedError(
            "User rejected the approval request",
            rejection_message="the local time is wrong",
        )

    async def fake_call_executor(**kwargs):
        executor_calls.append(kwargs)
        return {"result": {"status": "queued"}}

    async def fake_handle(event, tool_call_id, tool_name):
        handled_events.append((event, tool_call_id, tool_name))

    wf._handle_tool_event = fake_handle
    fake = _FakeWorkflowModule()
    original_workflow = _patch_workflow(fake)
    original_approval = workflow_module.request_user_approval_direct
    original_executor = workflow_module.TOOL_EXECUTORS["call_phone_number"]
    workflow_module.request_user_approval_direct = fake_approval
    workflow_module.TOOL_EXECUTORS["call_phone_number"] = fake_call_executor
    try:
        result = await wf._execute_tool("call_phone_number", tool_args, "tc-rejected-approval")

        assert result["error"] is True
        assert result["message"] == 'User rejected with feedback: "the local time is wrong"'
        assert executor_calls == []
        assert not any(call[0] == "call_llm_activity" for call in fake.activity_calls)
        assert len(handled_events) == 1
        assert handled_events[0][0].status.name == "ERROR"
        assert "the local time is wrong" in handled_events[0][0].message
    finally:
        workflow_module.request_user_approval_direct = original_approval
        workflow_module.TOOL_EXECUTORS["call_phone_number"] = original_executor
        _restore_workflow(original_workflow)


async def test_workflow_pre_patch_replay_skips_new_jit_command():
    """Old Temporal histories replay their original approval -> executor command order."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-legacy-replay"
    wf.user_id = "user-1"
    wf.current_phase = "EXECUTE"
    tool_args = {
        "to": "+15555550123",
        "system_prompt": "Book dinner at the proposed time.",
        "output_schema": {
            "fields": [
                {
                    "name": "status",
                    "type": "str",
                    "required": True,
                    "description": "Booking status",
                }
            ]
        },
    }
    executor_calls: List[Dict[str, Any]] = []

    import workflows.agent_workflow as workflow_module

    async def fake_approval(workflow_instance, question, metadata=None, **kwargs):
        return {"response": "its 1:45pm local time", "question": question}

    async def fake_call_executor(**kwargs):
        executor_calls.append(kwargs)
        return {"result": {"status": "queued"}}

    fake = _FakeWorkflowModule(patched=False)
    original_workflow = _patch_workflow(fake)
    original_approval = workflow_module.request_user_approval_direct
    original_executor = workflow_module.TOOL_EXECUTORS["call_phone_number"]
    workflow_module.request_user_approval_direct = fake_approval
    workflow_module.TOOL_EXECUTORS["call_phone_number"] = fake_call_executor
    try:
        result = await wf._execute_tool("call_phone_number", tool_args, "tc-legacy-replay")

        assert result["success"] is True
        assert len(executor_calls) == 1
        assert executor_calls[0]["tool_call"] == {"tool": "call_phone_number", **tool_args}
        assert not any(call[0] == "call_llm_activity" for call in fake.activity_calls)
    finally:
        workflow_module.request_user_approval_direct = original_approval
        workflow_module.TOOL_EXECUTORS["call_phone_number"] = original_executor
        _restore_workflow(original_workflow)


async def test_workflow_refresh_claude_token_missing_fetches_and_sets():
    wf = _bare_workflow_instance()
    wf.claude_max_token = None
    wf.claude_max_token_fetched_at = None
    fake = _FakeWorkflowModule()
    fake.activity_returns["fetch_compute_token_activity"] = {
        "type": "claude",
        "accessToken": "new-tok",
        "source": "user",
        "poolTokenId": None,
    }
    original = _patch_workflow(fake)
    try:
        await wf._refresh_claude_token("user-1")
        assert wf.claude_max_token == "new-tok"
        assert wf.claude_max_token_source == "user"
        assert wf.claude_max_token_fetched_at == fake.now_value
    finally:
        _restore_workflow(original)


async def test_workflow_refresh_compute_token_accepts_initial_gpt_token():
    wf = _bare_workflow_instance()
    wf.compute_token_provider = None
    wf.gpt_code_token = None
    fake = _FakeWorkflowModule()
    fake.activity_returns["fetch_compute_token_activity"] = {
        "type": "gpt",
        "accessToken": "gpt-initial",
        "accountId": "acct-initial",
        "source": "pool",
        "poolTokenId": "pool-gpt-initial",
    }
    original = _patch_workflow(fake)
    try:
        await wf._refresh_compute_token("user-1")
        assert wf.compute_token_provider == "gpt"
        assert wf.gpt_code_token == "gpt-initial"
        assert wf.gpt_code_account_id == "acct-initial"
        assert wf.gpt_code_token_source == "pool"
        assert wf.gpt_code_token_pool_id == "pool-gpt-initial"
        assert wf.claude_max_token is None
        assert wf.compute_token_fetched_at == fake.now_value
    finally:
        _restore_workflow(original)


async def test_workflow_refresh_claude_token_result_none_clears_token():
    wf = _bare_workflow_instance()
    wf.claude_max_token = "old-tok"
    wf.claude_max_token_source = "pool"
    wf.claude_max_token_fetched_at = None
    fake = _FakeWorkflowModule()
    fake.activity_returns["fetch_compute_token_activity"] = None
    original = _patch_workflow(fake)
    try:
        await wf._refresh_claude_token("user-1")
        assert wf.claude_max_token is None
        assert wf.claude_max_token_source is None
    finally:
        _restore_workflow(original)


async def test_workflow_refresh_claude_token_exception_logged_no_raise():
    wf = _bare_workflow_instance()
    wf.claude_max_token = None
    wf.claude_max_token_fetched_at = None
    fake = _FakeWorkflowModule()
    fake.activity_fail_for.add("fetch_compute_token_activity")
    original = _patch_workflow(fake)
    try:
        # Must not raise
        await wf._refresh_claude_token("user-1")
        # Token stays None
        assert wf.claude_max_token is None
    finally:
        _restore_workflow(original)


async def test_workflow_get_model_pricing_resolves_in_process_and_caches():
    wf = _bare_workflow_instance()
    wf.model = "workflow-primary"
    wf.input_cents_per_1k = 0.0
    wf.output_cents_per_1k = 0.0
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        pricing = await wf._get_model_pricing("anthropic/claude-opus-4.7")
        assert pricing == {"input_cents_per_1k": 0.5, "output_cents_per_1k": 2.5}
        pricing2 = await wf._get_model_pricing("anthropic/claude-opus-4.7")
        assert pricing2 == pricing
        fetches = [c for c in fake.activity_calls if c[0] == "fetch_model_pricing"]
        assert fetches == []
    finally:
        _restore_workflow(original)


async def test_workflow_get_model_pricing_unknown_uses_default():
    wf = _bare_workflow_instance()
    wf.model = "primary"
    wf.input_cents_per_1k = 0.0
    wf.output_cents_per_1k = 0.0
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        pricing = await wf._get_model_pricing("unknown-model")
        assert pricing == {"input_cents_per_1k": 0.1, "output_cents_per_1k": 0.3}
        assert not fake.activity_calls
    finally:
        _restore_workflow(original)


async def test_workflow_on_tokens_rotates_claude_token_on_auth_error():
    """When claude_token is set but actual_model is non-claude and error=auth_error,
    _on_tokens marks the token rate-limited and clears it."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    wf.user_id = "user-1"
    wf.compute_token_provider = "claude"
    wf.claude_max_token = "some-token"
    wf.claude_max_token_source = "pool"
    wf.claude_max_token_pool_id = "pool-id-1"
    wf.claude_max_token_fetched_at = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.input_cents_per_1k = 0.0
    wf.output_cents_per_1k = 0.0
    fake = _FakeWorkflowModule()
    # After rotation, refresh returns None so token stays cleared
    fake.activity_returns["fetch_compute_token_activity"] = None
    original = _patch_workflow(fake)
    try:
        await wf._on_tokens(
            tokens_in_delta=10,
            tokens_out_delta=5,
            actual_model="gemini/gemini-2.5-pro",  # non-claude
            call_site="test",
            claude_token_error="auth_error",
        )
        # Token should be cleared
        assert wf.claude_max_token is None
        assert wf.claude_max_token_source is None
        # mark activity executed
        activity_names = [c[0] for c in fake.activity_calls]
        assert "mark_compute_token_rate_limited_activity" in activity_names
        mark_call = next(c for c in fake.activity_calls if c[0] == "mark_compute_token_rate_limited_activity")
        assert mark_call[1] == ["claude", "pool", "user-1", "pool-id-1", 5 * 60, None, "auth_error"]
    finally:
        _restore_workflow(original)


async def test_workflow_on_tokens_transient_error_keeps_claude_token():
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    wf.user_id = "user-1"
    wf.compute_token_provider = "claude"
    wf.claude_max_token = "keep-me"
    wf.claude_max_token_source = "user"
    wf.input_cents_per_1k = 0.0
    wf.output_cents_per_1k = 0.0
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._on_tokens(
            tokens_in_delta=5,
            tokens_out_delta=2,
            actual_model="gemini/gemini-2.5-pro",
            call_site="test",
            claude_token_error="server_error",  # 5xx — transient, keep token
        )
        assert wf.claude_max_token == "keep-me"
        # mark activity NOT executed
        activity_names = [c[0] for c in fake.activity_calls]
        assert "mark_compute_token_rate_limited_activity" not in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_on_tokens_successful_rotation_uses_returned_compute_token():
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    wf.user_id = "user-1"
    wf.compute_token_provider = "claude"
    wf.claude_max_token = "old-token"
    wf.claude_max_token_source = "pool"
    wf.claude_max_token_pool_id = "pool-old"
    wf.claude_max_token_fetched_at = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.input_cents_per_1k = 0.0
    wf.output_cents_per_1k = 0.0
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._on_tokens(
            tokens_in_delta=5,
            tokens_out_delta=2,
            actual_model="gpt-5.4-mini-gpt",
            call_site="test",
            gpt_token_rotated=True,
            compute_token_used={
                "type": "gpt",
                "accessToken": "fresh-gpt-token",
                "accountId": "acct-fresh",
                "source": "pool",
                "poolTokenId": "pool-gpt-fresh",
            },
        )
        assert wf.compute_token_provider == "gpt"
        assert wf.gpt_code_token == "fresh-gpt-token"
        assert wf.gpt_code_account_id == "acct-fresh"
        assert wf.gpt_code_token_source == "pool"
        assert wf.gpt_code_token_pool_id == "pool-gpt-fresh"
        activity_names = [c[0] for c in fake.activity_calls]
        assert "fetch_compute_token_activity" not in activity_names
        assert "mark_compute_token_rate_limited_activity" not in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_on_tokens_rotates_gpt_token_on_auth_error():
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    wf.user_id = "user-1"
    wf.compute_token_provider = "gpt"
    wf.gpt_code_token = "gpt-token"
    wf.gpt_code_token_source = "pool"
    wf.gpt_code_token_pool_id = "gpt-pool-1"
    wf.input_cents_per_1k = 0.0
    wf.output_cents_per_1k = 0.0
    fake = _FakeWorkflowModule()
    fake.activity_returns["fetch_compute_token_activity"] = {
        "type": "claude",
        "accessToken": "next-claude-token",
        "source": "pool",
        "poolTokenId": "claude-pool-2",
    }
    original = _patch_workflow(fake)
    try:
        await wf._on_tokens(
            tokens_in_delta=5,
            tokens_out_delta=2,
            actual_model="google/gemini-3-flash-preview",
            call_site="test",
            gpt_token_error="auth_error",
        )
        assert wf.compute_token_provider == "claude"
        assert wf.claude_max_token == "next-claude-token"
        activity_names = [c[0] for c in fake.activity_calls]
        assert "mark_compute_token_rate_limited_activity" in activity_names
        mark_call = next(c for c in fake.activity_calls if c[0] == "mark_compute_token_rate_limited_activity")
        assert mark_call[1] == ["gpt", "pool", "user-1", "gpt-pool-1", 5 * 60, None, "auth_error"]
    finally:
        _restore_workflow(original)


async def test_workflow_on_tokens_transient_error_keeps_gpt_token():
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    wf.user_id = "user-1"
    wf.compute_token_provider = "gpt"
    wf.gpt_code_token = "keep-gpt"
    wf.gpt_code_token_source = "user"
    wf.input_cents_per_1k = 0.0
    wf.output_cents_per_1k = 0.0
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._on_tokens(
            tokens_in_delta=5,
            tokens_out_delta=2,
            actual_model="openai/gpt-5.4",
            call_site="test",
            gpt_token_error="server_error",  # 5xx — transient, keep token
        )
        assert wf.compute_token_provider == "gpt"
        assert wf.gpt_code_token == "keep-gpt"
        activity_names = [c[0] for c in fake.activity_calls]
        assert "mark_compute_token_rate_limited_activity" not in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_check_parent_state_no_parent_returns_early():
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = None
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        # Should return without invoking any activities
        await wf._check_parent_state()
        activity_names = [c[0] for c in fake.activity_calls]
        assert "query_parent_state_activity" not in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_query_parent_state_exception_returns_empty():
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = "parent-wf"
    fake = _FakeWorkflowModule()
    fake.activity_fail_for.add("query_parent_state_activity")
    original = _patch_workflow(fake)
    try:
        result = await wf._query_parent_state()
        assert result == {}
    finally:
        _restore_workflow(original)


async def run_all_tests():
    print("workflow blackbox tests:")
    r = BlackboxResult()

    # Pure logic tests (sync)
    r.record("task_dag_parallel", test_task_dag_parallel)
    r.record("task_dag_sequential", test_task_dag_sequential)
    r.record("task_dag_join_any", test_task_dag_join_any)
    r.record("task_dag_has_failed", test_task_dag_has_failed)
    r.record("task_dag_diamond", test_task_dag_diamond)
    r.record("extract_plan", test_extract_plan_from_context)
    r.record("extract_plan_empty", test_extract_plan_from_context_empty)
    r.record("extract_error_simple", test_extract_error_message_simple)
    r.record("extract_error_chained", test_extract_error_message_chained)
    r.record("usage_model_unknown_fallback", test_usage_model_falls_back_when_cache_provenance_is_unknown)

    # AgentWorkflow pure-method tests
    r.record("wf_pending_children_empty", test_workflow_get_pending_child_workflow_ids_empty)
    r.record("wf_pending_children_populated", test_workflow_get_pending_child_workflow_ids_populated)
    r.record("wf_children_tokens_empty", test_workflow_get_children_tokens_empty)
    r.record("wf_children_tokens_sums", test_workflow_get_children_tokens_sums_correctly)
    r.record("wf_get_status_query", test_workflow_get_status_query)
    r.record("wf_is_paused_default", test_workflow_is_paused_query_default_false)
    r.record("wf_is_paused_true", test_workflow_is_paused_query_true)
    r.record("wf_cost_limit_reached_default", test_workflow_is_cost_limit_reached_query_default)
    r.record("wf_parent_state_query", test_workflow_parent_state_query)
    r.record("wf_parent_state_all_false", test_workflow_parent_state_query_all_false)
    r.record("wf_format_outputs_no_schema", test_workflow_format_outputs_no_schema_returns_empty)
    r.record("wf_format_outputs_no_response", test_workflow_format_outputs_no_response_returns_empty)
    r.record("wf_format_outputs_maps_fields", test_workflow_format_outputs_maps_fields)
    r.record("wf_format_outputs_skips_missing", test_workflow_format_outputs_skips_missing_fields)
    r.record("wf_format_outputs_field_no_name", test_workflow_format_outputs_field_without_name_skipped)
    r.record("wf_efc_empty", test_workflow_extract_failure_context_empty_context)
    r.record("wf_efc_assistant_reasoning", test_workflow_extract_failure_context_assistant_reasoning)
    r.record("wf_efc_skips_reasoning_meta", test_workflow_extract_failure_context_skips_reasoning_metadata)
    r.record("wf_efc_truncates_reasoning", test_workflow_extract_failure_context_truncates_reasoning)
    r.record("wf_efc_plan_extraction", test_workflow_extract_failure_context_plan_extraction)
    r.record("wf_efc_plan_limit_5", test_workflow_extract_failure_context_plan_limits_to_5_tasks)
    r.record("wf_efc_trajectory_dedupe", test_workflow_extract_failure_context_trajectory_dedupe)
    r.record("wf_efc_skips_internal_tools", test_workflow_extract_failure_context_skips_internal_tools)
    r.record("wf_efc_skips_in_progress", test_workflow_extract_failure_context_skips_in_progress_tools)
    r.record("wf_efc_verifier_progress", test_workflow_extract_failure_context_verifier_progress)
    r.record("wf_efc_partial_structured", test_workflow_extract_failure_context_partial_structured_response)
    r.record("wf_efc_step_based_progress", test_workflow_extract_failure_context_step_based_progress)
    r.record("wf_efc_err_truncated", test_workflow_extract_failure_context_error_message_truncated)

    # Async tests
    await r.record_async("poll_and_update_context", test_poll_and_update_context)
    await r.record_async(
        "poll_and_update_context_filters_subagent_work",
        test_poll_and_update_context_filters_subagent_work_and_advances_cursor,
    )

    # Signal-handler + cost-tracking tests (fake workflow module)
    await r.record_async("wf_signal_pause", test_workflow_signal_pause_sets_paused_flag)
    await r.record_async("wf_signal_pause_cascade", test_workflow_signal_pause_cascades_to_children)
    await r.record_async("wf_signal_resume", test_workflow_signal_resume_clears_paused_flag)
    await r.record_async("wf_signal_recv_user_plain", test_workflow_signal_receive_user_response_plain_string)
    await r.record_async("wf_signal_recv_user_req_id", test_workflow_signal_receive_user_response_with_request_id)
    await r.record_async(
        "wf_signal_recv_user_json_no_req", test_workflow_signal_receive_user_response_json_without_request_id
    )
    await r.record_async(
        "wf_signal_wakes_schema_update",
        test_workflow_signal_wakes_for_generated_schema_update_message,
    )
    await r.record_async(
        "wf_signal_schema_prefix_is_feedback",
        test_workflow_signal_treats_schema_prefix_as_genuine_user_feedback,
    )
    await r.record_async(
        "wf_signal_unknown_schema_envelope_is_feedback",
        test_workflow_signal_unknown_schema_envelope_is_user_feedback,
    )
    await r.record_async(
        "wf_refresh_schema_from_feedback",
        test_workflow_refreshes_response_schema_from_user_feedback,
    )
    await r.record_async(
        "wf_verifier_refreshes_schema_from_feedback",
        test_workflow_verifier_refreshes_response_schema_from_user_feedback,
    )
    await r.record_async(
        "wf_schema_refresh_unchanged_no_context",
        test_workflow_schema_refresh_skips_context_message_when_unchanged,
    )
    await r.record_async(
        "wf_schema_refresh_failure_falls_back",
        test_workflow_schema_refresh_failure_falls_back_until_new_feedback,
    )
    await r.record_async(
        "wf_schema_message_failure_falls_back",
        test_workflow_schema_refresh_message_failure_falls_back_to_last_schema,
    )
    await r.record_async(
        "wf_schema_refresh_reloads_feedback",
        test_workflow_schema_refresh_reloads_prior_feedback_after_continuation,
    )
    await r.record_async(
        "wf_schema_refresh_coalesces_feedback",
        test_workflow_schema_refresh_coalesces_rapid_feedback,
    )
    await r.record_async("wf_signal_signup", test_workflow_signal_signup_completed_and_dismissed)
    await r.record_async("wf_signal_child_cost_update", test_workflow_signal_child_cost_update_aggregates)
    await r.record_async("wf_signal_child_progress", test_workflow_signal_child_progress_tracks_deltas)
    await r.record_async("wf_signal_child_completed_success", test_workflow_signal_child_completed_success)
    await r.record_async("wf_signal_child_completed_failure", test_workflow_signal_child_completed_failure)
    await r.record_async(
        "wf_signal_child_max_iterations_error_partial_payload",
        test_workflow_signal_child_max_iterations_posts_error_with_partial_payload,
    )
    await r.record_async("wf_signal_cost_limit_reached", test_workflow_signal_cost_limit_reached_sets_flags)
    await r.record_async("wf_signal_price_limit_inc", test_workflow_signal_price_limit_increased_clears_limit)
    await r.record_async("wf_track_tokens_and_cost", test_workflow_track_tokens_and_cost_updates_counters)
    await r.record_async("wf_track_llm_cost", test_workflow_track_llm_cost_calculates_and_persists)
    await r.record_async("wf_track_llm_cost_no_pricing", test_workflow_track_llm_cost_zero_when_no_pricing)
    await r.record_async(
        "wf_track_llm_cost_fast_cache_replay",
        test_workflow_track_llm_cost_fast_cache_replay_is_zero_cost,
    )
    await r.record_async("wf_track_usage_empty", test_workflow_track_usage_empty_is_no_op)
    await r.record_async("wf_track_usage_service", test_workflow_track_usage_service_cost)
    await r.record_async(
        "wf_track_usage_direct_compute_token",
        test_workflow_track_usage_direct_compute_token_is_zero_cost,
    )
    await r.record_async(
        "wf_track_usage_fast_cache_replay",
        test_workflow_track_usage_fast_cache_replay_is_zero_cost,
    )
    await r.record_async("wf_update_cost_root_limit", test_workflow_update_cost_and_signal_parent_root_checks_limit)
    await r.record_async("wf_update_cost_non_root_signal", test_workflow_update_cost_and_signal_parent_non_root_signals)
    await r.record_async(
        "wf_update_cost_after_finished_no_active",
        test_workflow_update_cost_after_finished_skips_active_broadcast,
    )
    await r.record_async("wf_check_cost_limit_below", test_workflow_check_cost_limit_no_op_when_below)
    await r.record_async("wf_check_cost_limit_non_root", test_workflow_check_cost_limit_skips_non_root)
    await r.record_async("wf_update_tree_state_no_bus", test_workflow_update_tree_state_skips_without_bus)
    await r.record_async("wf_update_tree_state_with_bus", test_workflow_update_tree_state_with_bus_broadcasts)
    await r.record_async("wf_persist_tree_cost", test_workflow_persist_tree_cost_executes_activity)
    await r.record_async("wf_query_parent_state_empty", test_workflow_query_parent_state_returns_empty_without_parent)
    await r.record_async("wf_check_paused", test_workflow_check_paused_reflects_flag)
    await r.record_async("wf_refresh_claude_token_fresh", test_workflow_refresh_claude_token_still_fresh_returns_early)
    await r.record_async("wf_on_tokens_with_pricing", test_workflow_on_tokens_calculates_cost_with_pricing)
    await r.record_async("wf_on_tokens_no_pricing", test_workflow_on_tokens_no_pricing_still_logs)
    await r.record_async("wf_on_tokens_fast_cache_replay", test_workflow_on_tokens_fast_cache_replay_is_zero_cost)
    await r.record_async("wf_wait_for_messages_timeout", test_workflow_wait_for_messages_timeout_returns_false)
    await r.record_async("wf_get_model_pricing_primary", test_workflow_get_model_pricing_returns_primary_when_matches)
    await r.record_async("wf_get_model_pricing_cache", test_workflow_get_model_pricing_uses_cache)
    await r.record_async("wf_mark_failed_signals_parent", test_workflow_mark_failed_signals_parent_with_context)
    await r.record_async("wf_mark_failed_no_parent", test_workflow_mark_failed_no_parent_no_signal)
    await r.record_async("wf_handle_incomplete_max_iterations", test_workflow_handle_incomplete_max_iterations)
    await r.record_async("wf_handle_incomplete_error", test_workflow_handle_incomplete_error)
    await r.record_async("wf_handle_incomplete_unknown", test_workflow_handle_incomplete_unknown_passthrough)
    await r.record_async("wf_check_credits_no_credits", test_workflow_check_credits_no_credits_pauses)
    await r.record_async(
        "wf_check_credits_free_credit_subscription_gate",
        test_workflow_check_credits_free_credits_exhausted_raises_subscription_gate,
    )
    await r.record_async(
        "wf_check_credits_free_credit_checkout_failure_pauses",
        test_workflow_check_credits_free_credit_checkout_failure_pauses,
    )
    await r.record_async("wf_check_credits_has_credits", test_workflow_check_credits_has_credits_no_pause)
    await r.record_async("wf_check_credits_exception", test_workflow_check_credits_on_exception_continues)
    await r.record_async("wf_post_message", test_workflow_post_message_executes_activity)
    await r.record_async("wf_post_message_failure", test_workflow_post_message_failure_logs_warning)
    await r.record_async("wf_advance_cloud_agent_tool", test_workflow_advances_pending_cloud_agent_tool)
    await r.record_async("wf_cloud_agent_lifecycle_start_phase", test_workflow_lifecycle_updates_preserve_start_phase)
    await r.record_async("wf_no_duplicate_cloud_agent_tool", test_workflow_does_not_advance_terminal_cloud_agent_tool)
    await r.record_async("wf_missing_cloud_agent_tool", test_workflow_caches_missing_cloud_agent_tool)
    await r.record_async("wf_run_startup_completion", test_workflow_run_covers_chat_agent_startup_and_completion)
    await r.record_async(
        "wf_run_skips_response_schema_for_subagent",
        test_workflow_run_skips_response_schema_generation_for_subagent,
    )
    await r.record_async(
        "wf_dag_failure_recovers_via_run_agent",
        test_workflow_dag_failure_recovers_via_run_agent,
    )
    await r.record_async("wf_handle_tool_event_forwards", test_workflow_handle_tool_event_forwards_to_helper)
    await r.record_async(
        "wf_post_dag_completion_attempt_tool",
        test_workflow_post_dag_completion_dispatches_attempt_completion_tool,
    )
    await r.record_async(
        "wf_post_dag_completion_error_closes_attempt",
        test_workflow_post_dag_completion_verifier_error_closes_attempt_tool,
    )
    await r.record_async("wf_check_parent_paused", test_workflow_check_parent_state_parent_paused_inherits)
    await r.record_async("wf_check_parent_cost_limited", test_workflow_check_parent_state_parent_cost_limited_inherits)
    await r.record_async("wf_check_parent_resumes", test_workflow_check_parent_state_parent_resumes_clears_inherit)
    await r.record_async(
        "wf_check_parent_missing_orphans", test_workflow_check_parent_state_parent_missing_orphans_child
    )
    await r.record_async(
        "wf_check_parent_missing_ignores_manual", test_workflow_check_parent_state_parent_missing_ignores_manual_pause
    )
    await r.record_async(
        "wf_check_parent_transient_backstop", test_workflow_check_parent_state_transient_failure_backstop_orphans
    )
    await r.record_async("wf_mark_complete_happy", test_workflow_mark_complete_happy_path)
    await r.record_async("wf_mark_complete_no_parent", test_workflow_mark_complete_no_parent_no_signal)
    await r.record_async("wf_format_outputs_with_schema", test_workflow_format_outputs_with_schema)
    await r.record_async("wf_format_outputs_no_schema", test_workflow_format_outputs_empty_without_schema)
    await r.record_async("wf_format_outputs_none_response", test_workflow_format_outputs_none_response)
    await r.record_async("wf_extract_failure_context", test_workflow_extract_failure_context_basic)

    # W3-A/W3-D additional coverage tests
    await r.record_async("wf_poll_messages_merges", test_workflow_poll_messages_merges_and_sorts)
    await r.record_async("wf_poll_messages_exception", test_workflow_poll_messages_exception_raises)
    await r.record_async("wf_execute_tool_unknown", test_workflow_execute_tool_unknown_tool_returns_error)
    await r.record_async(
        "wf_plan_schema_rejects_nonexplore", test_plan_phase_spawn_agent_schema_rejects_non_explore_types
    )
    await r.record_async(
        "wf_execute_tool_invalid_params_posts_event",
        test_workflow_execute_tool_invalid_params_returns_error_and_posts_tool_event,
    )
    await r.record_async(
        "wf_execute_tool_world_model_simulate_runs_agent_facing_executor",
        test_workflow_execute_tool_world_model_simulate_runs_agent_facing_executor,
    )
    await r.record_async(
        "wf_execute_tool_legacy_spawn_agent_phase",
        test_workflow_execute_tool_legacy_spawn_agent_receives_phase,
    )
    await r.record_async(
        "wf_execute_tool_web_fetch_fast_mode_kwargs",
        test_workflow_execute_tool_web_fetch_preserves_fast_mode_kwargs,
    )
    await r.record_async(
        "wf_approval_text_repopulates_same_tool",
        test_workflow_approval_text_repopulates_same_tool_then_executes_once,
    )
    await r.record_async(
        "wf_plain_approval_executes_original_params",
        test_workflow_plain_approval_executes_original_params_without_jit,
    )
    await r.record_async(
        "wf_rejection_fails_with_feedback",
        test_workflow_rejection_fails_tool_with_feedback_without_jit_or_execution,
    )
    await r.record_async(
        "wf_pre_patch_replay_skips_jit",
        test_workflow_pre_patch_replay_skips_new_jit_command,
    )
    await r.record_async("wf_refresh_claude_token_missing", test_workflow_refresh_claude_token_missing_fetches_and_sets)
    await r.record_async(
        "wf_refresh_compute_token_initial_gpt",
        test_workflow_refresh_compute_token_accepts_initial_gpt_token,
    )
    await r.record_async(
        "wf_refresh_claude_token_none_clears", test_workflow_refresh_claude_token_result_none_clears_token
    )
    await r.record_async(
        "wf_refresh_claude_token_exception", test_workflow_refresh_claude_token_exception_logged_no_raise
    )
    await r.record_async(
        "wf_get_model_pricing_in_process",
        test_workflow_get_model_pricing_resolves_in_process_and_caches,
    )
    await r.record_async("wf_get_model_pricing_default", test_workflow_get_model_pricing_unknown_uses_default)
    await r.record_async("wf_on_tokens_rotates_claude", test_workflow_on_tokens_rotates_claude_token_on_auth_error)
    await r.record_async(
        "wf_on_tokens_transient_keeps_claude", test_workflow_on_tokens_transient_error_keeps_claude_token
    )
    await r.record_async(
        "wf_on_tokens_successful_claude_rotation",
        test_workflow_on_tokens_successful_rotation_uses_returned_compute_token,
    )
    await r.record_async("wf_on_tokens_rotates_gpt", test_workflow_on_tokens_rotates_gpt_token_on_auth_error)
    await r.record_async("wf_on_tokens_transient_keeps_gpt", test_workflow_on_tokens_transient_error_keeps_gpt_token)
    await r.record_async("wf_check_parent_state_no_parent", test_workflow_check_parent_state_no_parent_returns_early)
    await r.record_async("wf_query_parent_state_exception", test_workflow_query_parent_state_exception_returns_empty)

    # Temporal workflow tests (all run inside one shared environment)
    wf_results = await _run_all_workflow_tests()
    for test_name, err in wf_results:
        if err is None:
            r.passed += 1
            print(f"  \u2705 {test_name}")
        else:
            r.failed += 1
            r.errors.append(f"{test_name}: {err}")
            print(f"  \u274c {test_name}: {err}")

    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    result = asyncio.run(run_all_tests())
    raise SystemExit(0 if result else 1)
