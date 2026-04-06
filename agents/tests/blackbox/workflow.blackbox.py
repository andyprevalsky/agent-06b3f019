"""Blackbox tests for workflow, DAG executor, and context utils."""

import asyncio
import json
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
    assert len(ready) == 0 or all(t.index != 3 for t in ready), (
        "Task 3 should NOT be ready (task 2 still pending)"
    )

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
) -> None:
    return None


@activity.defn(name="get_agent_source")
async def mock_get_agent_source(agent_id: str) -> str:
    return "WEB"


@activity.defn(name="notify_sms_event_activity")
async def mock_notify_sms_event_activity(
    user_id: str, event_type: str, agent_id: str, payload: dict
) -> None:
    return None


@activity.defn(name="get_user_context")
async def mock_get_user_context(
    user_id: str, context_gates: Optional[Dict[str, bool]] = None
) -> str:
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
async def mock_poll_new_messages(
    agent_id: str, last_checked: datetime
) -> List[Dict[str, Any]]:
    return []


@activity.defn(name="check_user_usage")
async def mock_check_user_usage(user_id: str) -> dict:
    return {"has_credits": True, "remaining": 100.0, "used": 0.0, "total": 100.0}


@activity.defn(name="save_tool_usage")
async def mock_save_tool_usage(
    agent_id: str, user_id: str, tool_name: str, usage_items: list
) -> None:
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
    context: list, iteration_count: int, model: str = "rose-labs/rose-1-lite"
) -> Dict:
    return {"learnings": "compressed learnings", "usage": {}}


@activity.defn(name="update_agent_tree_cost_activity")
async def mock_update_agent_tree_cost_activity(
    agent_id: str, tree_cost_cents: int, own_cost_cents: float = 0
) -> None:
    return None


@activity.defn(name="update_agent_tokens_activity")
async def mock_update_agent_tokens_activity(
    agent_id: str, tokens_in: int, tokens_out: int
) -> None:
    return None


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
) -> Dict[str, Any]:
    """Mock LLM activity that returns an attempt_completion tool call to end the loop."""
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
    phase: str = "EXECUTE",
    response_schema: Optional[Dict[str, Any]] = None,
    claude_token: Optional[str] = None,
    call_site: str = "verifier",
) -> Dict[str, Any]:
    return {"score": 1.0, "reasoning": "Complete", "structured_response": None}


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


@activity.defn(name="get_shared_memory")
async def mock_get_shared_memory(
    bus_id: str, current_hash: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    return None


@activity.defn(name="append_shared_memory")
async def mock_append_shared_memory(
    bus_id: str, entry_type: str, content: str, source_agent_id: str
) -> Dict[str, Any]:
    return {"success": True}


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
async def mock_set_response_schema_activity(agent_id: str, schema: dict) -> None:
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
    mock_get_shared_memory,
    mock_append_shared_memory,
    mock_execute_reasoning_activity,
    mock_populate_tool_params_activity,
    mock_save_blueprint_activity,
    mock_set_response_schema_activity,
    mock_send_direct_sms_activity,
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

_WORKFLOW_RUNNER = SandboxedWorkflowRunner(
    restrictions=SandboxRestrictions.default.with_passthrough_all_modules()
)

# Default workflow args matching AgentWorkflow.run() signature
DEFAULT_WF_ARGS: list = [
    "agent-test-1",  # agent_id
    "user-test-1",  # user_id
    "Test goal",  # goal
    "rose-labs/rose-1-lite",  # model
    256,  # reasoning_max_tokens
    {  # verifier
        "type": "FLOAT_LLM_JUDGE",
        "llmJudgePrompt": "Is the task complete?",
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
                assert status["goal"] == "Test goal", (
                    f"Expected goal='Test goal', got {status.get('goal')}"
                )

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
                assert cost_limited is False, (
                    f"Expected cost_limited=False after price increase, got {cost_limited}"
                )

                paused = await handle.query(AgentWorkflow.is_paused_query)
                assert paused is False, (
                    f"Expected paused=False after price increase, got {paused}"
                )

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

                response_data = json.dumps({
                    "request_id": "req-1",
                    "response": "approved",
                })
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

    return results


# ===========================================================================
# Test runner
# ===========================================================================


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

    # Async tests
    await r.record_async("poll_and_update_context", test_poll_and_update_context)

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
