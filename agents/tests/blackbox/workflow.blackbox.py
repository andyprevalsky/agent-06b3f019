"""Blackbox tests for workflow, DAG executor, and context utils."""

import asyncio
import json
import os
import traceback
from datetime import datetime, timezone
from types import SimpleNamespace
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


def test_workflow_policy_import_does_not_rebuild_provider_clients():
    """A pure workflow timeout policy must not load activity-side provider clients."""
    import builtins

    from helpers.workflow_sandbox import workflow_sandbox_restrictions
    from temporalio.worker.workflow_sandbox._importer import Importer
    from temporalio.worker.workflow_sandbox._restrictions import RestrictionContext

    import sys

    host_pricing = sys.modules["helpers.model_pricing"]
    importer = Importer(workflow_sandbox_restrictions(), RestrictionContext())
    with importer.applied():
        builtins.__import__("helpers.wmh_activity_policy")
        sandbox_pricing = builtins.__import__("helpers.model_pricing", fromlist=["get_default_pricing"])
    provider_modules = sorted(name for name in importer.new_modules if name.startswith("providers.rose"))
    assert not provider_modules, f"workflow policy import rebuilt activity-side provider clients: {provider_modules}"
    assert sandbox_pricing is host_pricing, "pricing module must reuse the host instance on cold workflow replay"
    assert sandbox_pricing.get_default_pricing is host_pricing.get_default_pricing


def test_workflow_helper_exports_reuse_host_activity_definitions():
    """Cold imports keep workflow isolation while reusing registered activities."""
    import builtins
    import helpers
    import sys

    from helpers.workflow_sandbox import workflow_sandbox_restrictions
    from temporalio.worker.workflow_sandbox._importer import Importer
    from temporalio.worker.workflow_sandbox._restrictions import RestrictionContext

    host_exports = {name: getattr(helpers, name) for name in helpers.__all__}
    importer = Importer(workflow_sandbox_restrictions(), RestrictionContext())
    with importer.applied():
        policy = builtins.__import__("helpers.wmh_activity_policy", fromlist=["wmh_activity_timeout_options"])
        sandbox_helpers = builtins.__import__("helpers", fromlist=list(host_exports))
    assert sandbox_helpers is not helpers, "the helpers package must remain sandbox-isolated"
    assert policy is not sys.modules["helpers.wmh_activity_policy"], (
        "pure workflow helpers must remain sandbox-isolated"
    )
    rebuilt = [name for name, value in host_exports.items() if getattr(sandbox_helpers, name) is not value]
    assert not rebuilt, f"cold replay rebuilt registered helper exports: {rebuilt}"


def test_workflow_action_model_cache_preserves_registry_and_validation():
    """Equivalent replay inputs reuse a schema without sharing different tools."""
    from typing import Literal

    from pydantic import BaseModel, ValidationError
    from utils.tool_schemas import create_agent_action_model

    class FirstTool(BaseModel):
        tool: Literal["custom"]
        first: str

    class ReplacementTool(BaseModel):
        tool: Literal["custom"]
        replacement: int

    first = create_agent_action_model(["custom"], {"custom": FirstTool})
    same = create_agent_action_model(["custom"], dict(custom=FirstTool))
    assert first is same, "identical replay tool types rebuilt the action schema"
    replacement = create_agent_action_model(["custom"], {"custom": ReplacementTool})
    assert first is not replacement, "a changed user-tool registry reused a stale schema"
    registry = {"first": FirstTool, "replacement": ReplacementTool}
    forward = create_agent_action_model(["first", "replacement"], registry)
    reverse = create_agent_action_model(["replacement", "first"], registry)
    assert forward is not reverse, "tool union ordering must remain part of the schema identity"
    assert first.model_validate({"response": "", "tool_calls": [{"tool": "custom", "first": "ok"}]}).tool_calls
    assert replacement.model_validate({"response": "", "tool_calls": [{"tool": "custom", "replacement": 3}]}).tool_calls
    try:
        replacement.model_validate({"response": "", "tool_calls": [{"tool": "custom", "first": "stale"}]})
    except ValidationError:
        pass
    else:
        raise AssertionError("the new registry accepted a payload valid only under the old schema")


def test_workflow_sandbox_keeps_worker_logging_configuration():
    """Workflow replay suppresses logs; activities retain configured structlog."""
    import logging
    import structlog
    from unittest.mock import patch
    from temporalio import workflow
    from helpers.workflow_safe import context_logger
    from helpers.workflow_sandbox import workflow_sandbox_restrictions

    assert "structlog" not in workflow_sandbox_restrictions().passthrough_modules
    previous = structlog.get_config()
    was_configured = structlog.is_configured()
    activity_events, records = [], []
    class Capture(logging.Handler):
        def emit(self, record):
            records.append(record)
    handler = Capture()
    base = workflow.logger.base_logger
    old_level = base.level
    base.addHandler(handler)
    base.setLevel(logging.DEBUG)
    def collect(logger, method, event):
        activity_events.append(event.copy())
        return event
    try:
        structlog.configure(processors=[collect], logger_factory=structlog.ReturnLoggerFactory())
        log = context_logger()
        with patch.object(workflow, "in_workflow", return_value=True):
            with patch.object(workflow.unsafe, "is_replaying_history_events", return_value=True):
                log.info("replayed", agent_id="fixture")
            assert not activity_events and not records
            with patch.object(workflow.unsafe, "is_replaying_history_events", return_value=False):
                log.info("live", agent_id="fixture")
            assert len(records) == 1 and records[0].agent_id == "fixture"
        with patch.object(workflow, "in_workflow", return_value=False):
            log.info("activity", agent_id="activity")
        assert activity_events[-1]["agent_id"] == "activity"
    finally:
        base.removeHandler(handler)
        base.setLevel(old_level)
        if was_configured:
            structlog.configure(**previous)
        else:
            structlog.reset_defaults()


async def test_blackbox_result_preserves_empty_exceptions_and_tracebacks():
    """Empty exception messages still identify the failing boundary in run logs."""
    from contextlib import redirect_stderr, redirect_stdout
    from io import StringIO

    def fail_sync():
        raise AssertionError()

    async def fail_async():
        raise TimeoutError()

    for name, invoke, exception_name, frame_name in (
        ("sync", fail_sync, "AssertionError", "fail_sync"),
        ("async", fail_async, "TimeoutError", "fail_async"),
    ):
        result = BlackboxResult()
        stdout, stderr = StringIO(), StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            if name == "sync":
                result.record(name, invoke)
            else:
                await result.record_async(name, invoke)
        assert result.summary() == {"passed": 0, "failed": 1, "total": 1}
        assert exception_name in stdout.getvalue(), stdout.getvalue()
        assert exception_name in result.errors[0], result.errors
        assert frame_name in stderr.getvalue(), stderr.getvalue()

    # Temporal cases collect errors, then report them outside the except block.
    try:
        try:
            fail_sync()
        except AssertionError as cause:
            raise TimeoutError() from cause
    except TimeoutError as caught:
        deferred_error = caught
    result = BlackboxResult()
    stdout, stderr = StringIO(), StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        result.record_result("deferred", deferred_error)
        result.record_result("passed", None)
    assert result.summary() == {"passed": 1, "failed": 1, "total": 2}
    assert "deferred: TimeoutError" in stdout.getvalue(), stdout.getvalue()
    assert "passed" in stdout.getvalue(), stdout.getvalue()
    assert result.errors == ["deferred: TimeoutError"], result.errors
    assert "AssertionError" in stderr.getvalue(), stderr.getvalue()
    assert "TimeoutError" in stderr.getvalue(), stderr.getvalue()
    assert "fail_sync" in stderr.getvalue(), stderr.getvalue()


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
    assert _resolve_usage_model("fast-cache", requested) == "fast-cache"


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


async def test_user_pause_refresh_keeps_original_result_order_and_error():
    from helpers.llm import collapse_duplicate_tool_results
    from unittest.mock import AsyncMock
    import copy
    original = {"message_id": "result", "role": "TOOL", "timestamp": "2026-01-01T00:00:00+00:00",
                "text": "Original error", "metadata": {"toolCallId": "call", "toolStatus": "ERROR",
                    "error": True, "errorCode": "ORIGINAL", "workflowGeneration": "generation"}}
    following = {"message_id": "next", "role": "ASSISTANT", "text": "Next turn",
                 "timestamp": "2026-01-01T00:00:03+00:00"}
    context = [copy.deepcopy(original), following]
    paused = copy.deepcopy(original)
    paused["text"] += "\n\n[User paused the browser agent.]"
    paused["metadata"]["userPause"] = {"reason": "user", "recordedAt": "2026-01-01T00:00:02+00:00"}
    cursor = datetime.fromisoformat(following["timestamp"])
    cursor = await poll_and_update_context(AsyncMock(return_value=[paused]), context, cursor)
    assert cursor == datetime.fromisoformat(following["timestamp"]), "late commit cannot rewind the ordinary cursor"
    assert [row["message_id"] for row in context] == ["result", "next"]
    assert context[0]["text"].startswith(paused["text"])
    assert context[0]["metadata"]["errorCode"] == "ORIGINAL"
    assert len(collapse_duplicate_tool_results(context)) == 2
    from helpers.llm import build_llm_messages
    declaration = {"role": "ASSISTANT", "text": "Browse", "timestamp": "2025-12-31T23:59:59+00:00",
                   "metadata": {"tool_calls": [{"tool": "spawn_browser_agent", "tool_call_id": "call", "goal": "Browse"}]}}
    projected = await build_llm_messages([declaration, *context], "system")
    tool_results = [m for m in projected if m.get("role") == "tool"]
    assert len(tool_results) == 1, projected
    assert "Original error" in tool_results[0]["content"]
    assert "User paused the browser agent" in tool_results[0]["content"]
    await poll_and_update_context(AsyncMock(return_value=[paused, original]), context, cursor)
    assert context[0]["metadata"].get("userPause") == paused["metadata"]["userPause"]
    assert len(context) == 2
    # The workflow maintains its own context as well as run_agent's list.
    from workflows.agent_workflow import AgentWorkflow
    from unittest.mock import MagicMock, patch
    wf = AgentWorkflow.__new__(AgentWorkflow)
    wf.agent_id = "fixture"
    wf.context = [copy.deepcopy(original), following]
    wf._admit_durable_response_schema_feedback = MagicMock()
    with patch("workflows.agent_workflow.workflow.execute_activity", AsyncMock(return_value=[paused])):
        await wf._poll_messages(cursor)
    assert wf.context[0]["metadata"]["userPause"] == paused["metadata"]["userPause"]
    assert [row["message_id"] for row in wf.context] == ["result", "next"]


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
        "metadata": {
            "toolName": "spawn_general_purpose_agent",
            "toolCallId": "tc:0",
            "subAgentIds": ["child-1"],
            "forEachChild": True,
        },
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

WORKFLOW_ENV_ACTIVITY_COUNTS: Dict[str, Dict[str, int]] = {}

# Cooperative-cutover e2e state. Opted in per agent id / workflow id so every
# other workflow test keeps the fixed mock behavior below.
CUTOVER_POINTER: Dict[str, str] = {}  # workflow_id -> live task queue
CUTOVER_POINTER_FETCHES: Dict[str, List[str]] = {}  # workflow_id -> queues that read the pointer
CUTOVER_MESSAGES: Dict[str, List[Dict[str, Any]]] = {}  # agent_id -> durable message rows
CUTOVER_LLM_SCRIPTS: Dict[str, List[Dict[str, Any]]] = {}  # agent_id -> scripted LLM responses
CUTOVER_LLM_QUEUES: Dict[str, List[str]] = {}
CUTOVER_VERIFIER_CONTEXTS: Dict[str, List[List[Dict[str, Any]]]] = {}
CUTOVER_SMS: Dict[str, List[str]] = {}
CUTOVER_USAGE: Dict[str, List[Dict[str, Any]]] = {}
CUTOVER_APPROVAL_REQUESTS: Dict[str, List[str]] = {}
CUTOVER_BROWSER: Dict[str, Dict[str, Any]] = {}  # agent_id -> scenario + recorded calls
CUTOVER_CODE: Dict[str, Dict[str, Any]] = {}  # agent_id -> scenario + recorded code-agent calls
CUTOVER_COMPLETION_REQUESTED: Dict[str, bool] = {}
CUTOVER_RESPONSE_SCHEMAS: Dict[str, Dict[str, Any]] = {}
CUTOVER_GENERATED_SCHEMAS: Dict[str, Dict[str, Any]] = {}


# agent_id -> number of poll_new_messages calls that succeed before every later
# call fails (a worker-saturation activity timeout, RCA P9).
POLL_FAILURE_AFTER: Dict[str, int] = {}
# agent_id -> (successful polls, retryable failures that follow, after which
# polls succeed again; None = never recover): a transient saturation burst.
POLL_TRANSIENT_BURST: Dict[str, tuple] = {}
# agent_id -> every status passed to update_agent_status, in order.
WORKFLOW_ENV_STATUSES: Dict[str, List[str]] = {}


def _record_workflow_env_activity(agent_id: Optional[str], activity_name: str) -> None:
    if not agent_id:
        return
    counts = WORKFLOW_ENV_ACTIVITY_COUNTS.setdefault(agent_id, {})
    counts[activity_name] = counts.get(activity_name, 0) + 1


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
    iteration_offset: Optional[int] = None,
) -> None:
    _record_workflow_env_activity(agent_id, "update_agent_status")
    WORKFLOW_ENV_STATUSES.setdefault(agent_id, []).append(status)
    return None


@activity.defn(name="acknowledge_workflow_replacement_bootstrap")
async def mock_acknowledge_workflow_replacement_bootstrap(agent_id: str) -> Dict[str, Any]:
    _record_workflow_env_activity(agent_id, "acknowledge_workflow_replacement_bootstrap")
    return {"acknowledged": True, "already_acknowledged": False}


@activity.defn(name="finalize_workflow_replacement_bootstrap")
async def mock_finalize_workflow_replacement_bootstrap(
    agent_id: str,
    status: str,
    progress: float,
    status_message: str,
    token_count: int,
    context_size: int,
    message_count: int,
    tokens_in: int,
    tokens_out: int,
    iteration_offset: int,
) -> Dict[str, Any]:
    _record_workflow_env_activity(agent_id, "finalize_workflow_replacement_bootstrap")
    return {"acknowledged": True, "already_acknowledged": False, "status": status}


@activity.defn(name="get_agent_source")
async def mock_get_agent_source(agent_id: str) -> str:
    return "WEB"


@activity.defn(name="notify_sms_event_activity")
async def mock_notify_sms_event_activity(
    user_id: str,
    event_type: str,
    agent_id: str,
    payload: dict,
    world_model_mode: str | None = None,
) -> None:
    if agent_id in CUTOVER_SMS:
        CUTOVER_SMS[agent_id].append(event_type)
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
    demo_cache_affinity_key: Optional[str] = None,
    token_type: Optional[str] = None,
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


@activity.defn(name="release_compute_token_lineage_activity")
async def mock_release_compute_token_lineage_activity(lineage_key: str) -> bool:
    return True


@activity.defn(name="fetch_agent_config")
async def mock_fetch_agent_config(agent_id: str) -> Dict:
    if agent_id in CUTOVER_RESPONSE_SCHEMAS:
        return {"context_gates": {}, "response_schema": CUTOVER_GENERATED_SCHEMAS.get(agent_id), "write_lock_enabled": True}
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
    _record_workflow_env_activity(agent_id, "post_agent_message")
    if agent_id in CUTOVER_MESSAGES:
        rows = CUTOVER_MESSAGES[agent_id]
        row = {
            "id": f"msg-{agent_id}-{len(rows) + 1}",
            "role": role,
            "text": text,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "metadata": dict(metadata or {}),
            "task_queue": activity.info().task_queue,
        }
        rows.append(row)
        return {"id": row["id"], "message": text, "role": role, "metadata": metadata}
    return {"id": "msg-mock-1", "message": text, "role": role, "metadata": metadata}


@activity.defn(name="poll_new_messages")
async def mock_poll_new_messages(
    agent_id: str,
    last_checked: datetime,
    include_internal_subagent: bool = False,
) -> List[Dict[str, Any]]:
    _record_workflow_env_activity(agent_id, "poll_new_messages")
    if agent_id in POLL_FAILURE_AFTER:
        if WORKFLOW_ENV_ACTIVITY_COUNTS[agent_id]["poll_new_messages"] > POLL_FAILURE_AFTER[agent_id]:
            from temporalio.exceptions import ApplicationError

            raise ApplicationError("Activity task timed out (simulated)", non_retryable=True)
    if agent_id in POLL_TRANSIENT_BURST:
        ok_before, burst = POLL_TRANSIENT_BURST[agent_id]
        call = WORKFLOW_ENV_ACTIVITY_COUNTS[agent_id]["poll_new_messages"]
        if call > ok_before and (burst is None or call <= ok_before + burst):
            from temporalio.exceptions import ApplicationError

            raise ApplicationError("Activity task timed out (simulated saturation burst)")
    if agent_id in CUTOVER_MESSAGES:
        # Time-skipping moves workflow time ahead of wall time, so return every
        # durable row; run_agent dedupes by message id exactly as in prod.
        return [{key: value for key, value in row.items() if key != "task_queue"} for row in CUTOVER_MESSAGES[agent_id]]
    return []


@activity.defn(name="check_user_usage")
async def mock_check_user_usage(user_id: str) -> dict:
    return {"has_credits": True, "remaining": 100.0, "used": 0.0, "total": 100.0}


@activity.defn(name="save_tool_usage")
async def mock_save_tool_usage(
    agent_id: str,
    user_id: str,
    tool_name: str,
    usage_items: list,
    accounting_checkpoint: Optional[Dict[str, Any]] = None,
) -> None:
    if agent_id in CUTOVER_USAGE:
        CUTOVER_USAGE[agent_id].append({"tool_name": tool_name, "usage_items": list(usage_items)})
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
    model: str = "rose-labs/rose-1-flash",
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
    compute_token_lineage_key: Optional[str] = None,
    compute_token_demo_cache_affinity_key: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    fast_mode_step: int = 0,
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
    iteration_offset: Optional[int] = None,
    root_agent_id: Optional[str] = None,
) -> Dict:
    return {"summary": summary or "Done", "status": "completed"}


@activity.defn(name="compress_context")
async def mock_compress_context(
    context: list,
    iteration_count: int,
    model: str = "rose-labs/rose-1-flash",
) -> Dict:
    return {"learnings": "compressed learnings", "usage": {}}


@activity.defn(name="update_agent_tree_cost_activity")
async def mock_update_agent_tree_cost_activity(agent_id: str, tree_cost_cents: int, own_cost_cents: float = 0) -> None:
    return None


# Captures the DEMO cache args the workflow threads into LLM activities,
# keyed by agent_id. Tests clear their agent's entry before starting.
FAST_MODE_GOAL_CAPTURE: Dict[str, List[Optional[str]]] = {}
FAST_MODE_ENABLED_CAPTURE: Dict[str, List[bool]] = {}
RESOLVE_DEMO_CACHE_GOAL_CALLS: List[str] = []
LEFTOVER_CHILD_AGENT_ID = "agent-test-leftover-child"
LEFTOVER_CHILD_GOAL = "Produce fresh tool-grounded evidence for Andy Prevalsky's brand task."
# A finished drafting sub-agent woken by its parent's send_message_to_agent
# (NEW_TASK). The backend wake clears Agent.responseSchema and stores the
# message as Agent.goal (tree-feedback-routing run 4, agent 7304d3f1).
WOKEN_SUBAGENT_ID = "agent-test-woken-subagent"
WOKEN_ORIGINAL_GOAL = "Draft one cold email to Garry Tan; return investor_name, investor_firm, subject, body."
WOKEN_NEW_TASK = "Correction: re-sign your draft as 'Andy Prevalskii, Founder, Rose Labs' and return it."
WOKEN_SCHEMA = {"fields": [{"name": "body", "type": "str", "required": True}]}
SCHEMA_GENERATION_CAPTURE: Dict[str, List[List[str]]] = {}
VERIFIER_SCHEMA_CAPTURE: Dict[str, List[Optional[Dict[str, Any]]]] = {}


@activity.defn(name="resolve_fast_cache_goal_activity")
async def mock_resolve_fast_cache_goal_activity(
    agent_id: str,
) -> Optional[dict[str, Optional[str]]]:
    RESOLVE_DEMO_CACHE_GOAL_CALLS.append(agent_id)
    if agent_id == LEFTOVER_CHILD_AGENT_ID:
        from utils.oai_demo import OAI_DEMO_ROOT_GOAL_PREFIX

        return {"goal": LEFTOVER_CHILD_GOAL, "root_goal": OAI_DEMO_ROOT_GOAL_PREFIX}
    # DEMO-tagged mass-agent root prompt (stable cache namespace).
    persisted = (
        "I'm building a [REDACTED] brand for health, longevity, technology, founder journey"  # pragma: allowlist secret
        " — persisted DB goal"
    )
    return {"goal": persisted, "root_goal": persisted}


@activity.defn(name="resolve_fast_cache_context_activity")
async def mock_resolve_fast_cache_context_activity(agent_id: str) -> dict:
    persisted = await mock_resolve_fast_cache_goal_activity(agent_id)
    enabled = agent_id in {"agent-test-democache", LEFTOVER_CHILD_AGENT_ID}
    return {
        "enabled": enabled,
        "goal": persisted["goal"] if enabled else None,
        "write_enabled": enabled,
        "root_agent_id": agent_id,
        "root_goal": persisted["root_goal"] if enabled else None,
        "provider_fast_mode": enabled,
    }


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
    compute_token_demo_cache_affinity_key: Optional[str] = None,
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
    activity_agent_id = agent_id or (messages_or_agent_id if isinstance(messages_or_agent_id, str) else None)
    _record_workflow_env_activity(activity_agent_id, "call_llm_activity")
    if activity_agent_id in CUTOVER_LLM_SCRIPTS:
        CUTOVER_LLM_QUEUES.setdefault(activity_agent_id, []).append(activity.info().task_queue)
        script = CUTOVER_LLM_SCRIPTS[activity_agent_id]
        tool_calls = script.pop(0) if script else [{"tool": "attempt_completion"}]
        if activity_agent_id in CUTOVER_RESPONSE_SCHEMAS and any(
            call.get("tool") == "attempt_completion" for call in tool_calls
        ):
            CUTOVER_COMPLETION_REQUESTED[activity_agent_id] = True
        return {
            "response": "",
            "tool_calls": tool_calls,
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "actual_model": "mock-model",
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            },
        }
    if agent_id:
        FAST_MODE_GOAL_CAPTURE.setdefault(agent_id, []).append(fast_mode_goal)
        FAST_MODE_ENABLED_CAPTURE.setdefault(agent_id, []).append(fast_mode_cache_enabled)
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
        # Poll-retry scenarios deliberately exercise loop exhaustion. A valid
        # already-elapsed wait keeps polling without completing or sleeping.
        "tool_calls": [{"tool": "wait_for", "until_timestamp": "2000-01-01T00:00:00Z"}]
        if activity_agent_id in POLL_TRANSIENT_BURST
        else [
            {
                "tool": "attempt_completion",
                "result": "All done",
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
    *additional_args: Any,
) -> Dict[str, Any]:
    if agent_id in CUTOVER_VERIFIER_CONTEXTS:
        CUTOVER_VERIFIER_CONTEXTS[agent_id].append(list(context))
    if agent_id in VERIFIER_SCHEMA_CAPTURE:
        VERIFIER_SCHEMA_CAPTURE[agent_id].append(response_schema)
    # These scripted cutover scenarios require the new generation to make
    # its own completion request after the delegated tool resumes.
    completion_requested = (
        agent_id not in CUTOVER_RESPONSE_SCHEMAS
        or CUTOVER_COMPLETION_REQUESTED.get(agent_id, False)
    )
    return {
        "score": 1.0 if completion_requested else 0.0,
        "reasoning": "Complete" if completion_requested else "Awaiting the scripted completion request",
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
    include_title: bool = False,
    *args: Any,
    **kwargs: Any,
) -> Optional[Dict[str, Any]]:
    if agent_id in CUTOVER_RESPONSE_SCHEMAS:
        SCHEMA_GENERATION_CAPTURE[agent_id].append(list(user_messages))
        schema = CUTOVER_RESPONSE_SCHEMAS[agent_id]
        if kwargs.get("persist", args[0] if args else True):
            CUTOVER_GENERATED_SCHEMAS[agent_id] = schema
        return {"schema": schema, "usage": {}}
    if agent_id in SCHEMA_GENERATION_CAPTURE:
        SCHEMA_GENERATION_CAPTURE[agent_id].append(list(user_messages))
        return {"schema": WOKEN_SCHEMA, "usage": {}}
    return None


@activity.defn(name="resolve_agent_address_activity")
async def mock_resolve_agent_address_activity(agent_id: str, address: str, user_id: Optional[str]) -> Dict[str, Any]:
    return {"agent_id": agent_id, "path": f"/root/{agent_id}"}


@activity.defn(name="persist_response_schema_activity")
async def mock_persist_response_schema_activity(agent_id: str, schema: Dict[str, Any]) -> None:
    if agent_id in CUTOVER_RESPONSE_SCHEMAS:
        CUTOVER_GENERATED_SCHEMAS[agent_id] = schema
    return None


@activity.defn(name="send_direct_sms_activity")
async def mock_send_direct_sms_activity(user_id: str, message: str) -> Dict:
    return {"success": True}


@activity.defn(name="fetch_agent_queue_pointer")
async def mock_fetch_agent_queue_pointer() -> Dict[str, Any]:
    """Return the test worker queue so cooperative handoff stays idle in Temporal tests."""
    info = activity.info()
    if info.workflow_id in CUTOVER_POINTER:
        CUTOVER_POINTER_FETCHES.setdefault(info.workflow_id, []).append(info.task_queue)
        return {"task_queue": CUTOVER_POINTER[info.workflow_id], "surface_hash": "cutover-e2e"}
    return {"task_queue": TASK_QUEUE, "surface_hash": "testgen"}


@activity.defn(name="create_approval_request_activity")
async def mock_create_approval_request_activity(
    user_id: str,
    agent_id: str,
    workflow_id: str,
    question: str,
    image_url: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> str:
    requests = CUTOVER_APPROVAL_REQUESTS.setdefault(agent_id, [])
    request_id = f"attn-{agent_id}-{len(requests) + 1}"
    requests.append(request_id)
    scenario = CUTOVER_BROWSER.get(agent_id) or {}
    flip_to = scenario.get("flip_pointer_on_approval")
    if flip_to:
        # A deploy lands while the user has not answered yet.
        CUTOVER_POINTER[workflow_id] = flip_to
    return request_id


def _cutover_browser_usage(model: str, tokens_in: int, tokens_out: int, service_cents: float) -> List[Dict[str, Any]]:
    return [
        {"type": "llm", "model": model, "provider": model, "input_tokens": tokens_in, "output_tokens": tokens_out},
        {"type": "service", "provider": "Steel.dev Browser", "cost_cents": service_cents},
    ]


@activity.defn(name="spawn_browser_agent_activity_v3")
async def mock_spawn_browser_agent_activity_v3(
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
    task_id: Optional[str] = None,
    session_id: Optional[str] = None,
    cdp_url: Optional[str] = None,
    is_resume: bool = False,
    output_schema: Optional[Dict[str, Any]] = None,
    attachments: Optional[List[Dict[str, Any]]] = None,
    write_lock_enabled: bool = True,
    start_url: str = "",
    write_lock_resume_state: Optional[Dict[str, Any]] = None,
    system_name: str = "Rose",
    use_claude_mode: bool = True,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    world_model_mode: Optional[str] = None,
    agent_model: Optional[str] = None,
    inbox_address: Optional[str] = None,
    await_owner_cleanup: bool = False,
) -> Dict[str, Any]:
    """Browser task that checkpoints once (drain yield or write approval), then completes.

    Returns the same payload shapes the real activity returns at those
    boundaries; the manager/workflow under test are production code.
    """
    info = activity.info()
    scenario = CUTOVER_BROWSER[agent_id]
    calls = scenario["calls"]
    calls.append(
        {
            "task_queue": info.task_queue,
            "workflow_run_id": info.workflow_run_id,
            "tool_call_id": tool_call_id,
            "task_id": task_id,
            "session_id": session_id,
            "cdp_url": cdp_url,
            "is_resume": is_resume,
            "start_url": start_url,
            "write_lock_resume_state": dict(write_lock_resume_state or {}),
            "agent_model": agent_model,
        }
    )
    continuity = {
        "action_history": [{"step": 1, "action": "click", "params": {"index": 3}}],
        "visited_urls": ["https://shop.example.com/cart"],
        "browser_turn_messages": [{"role": "assistant", "content": "clicked checkout"}],
        "reasoning_messages": ["cart has the item"],
        "action_summary": ["Opened cart"],
    }
    if len(calls) == 1:
        if scenario["mode"] == "drain":
            from domains.spawn_browser_agent_v3.config import BROWSER_DRAIN_YIELD_STATUS
            from helpers.activity_generation_drain import GENERATION_SUPERSEDED

            # The deploy moved the live pointer while this step ran; the real
            # activity sees GENERATION_SUPERSEDED at the next step boundary.
            CUTOVER_POINTER[info.workflow_id] = scenario["new_queue"]
            return {
                "status": BROWSER_DRAIN_YIELD_STATUS,
                "yield_reason": GENERATION_SUPERSEDED,
                "current_url": "https://shop.example.com/cart",
                "write_lock_approvals": {},
                "step_count": 7,
                "session_id": "steel-session-1",
                "cdp_url": "wss://steel.example/cdp/1",
                "task_id": task_id,
                "browser_url": "https://live.example/1",
                "auth_realm": "shop.example.com",
                "recorded_passkey_credential_ids": [],
                "usage_items": _cutover_browser_usage("mock-browser-gen1", 1200, 300, 2.0),
                **continuity,
            }
        return {
            "status": "awaiting_write_approval",
            "approval_type": "purchase",
            "question": "Place the $12 order on shop.example.com?",
            "current_url": "https://shop.example.com/checkout",
            "pending_action": {"action": "click", "params": {"index": 9}},
            "write_lock_approvals": {},
            "step_count": 7,
            "session_id": "steel-session-1",
            "cdp_url": "wss://steel.example/cdp/1",
            "task_id": task_id,
            "auth_realm": "shop.example.com",
            "recorded_passkey_credential_ids": [],
            **continuity,
        }
    return {
        "success": True,
        "status": "completed",
        "message": "Order placed: confirmation SHOP-4242",
        "structured_response": {"confirmation": "SHOP-4242"},
        "task_id": task_id,
        "session_id": "steel-session-1",
        "usage_items": _cutover_browser_usage("mock-browser-gen2", 800, 200, 1.0),
    }


@activity.defn(name="resolve_code_agent_provider_activity")
async def mock_resolve_code_agent_provider_activity(default_provider: str) -> str:
    return default_provider


@activity.defn(name="resolve_user_tools_activity")
async def mock_resolve_user_tools_activity(agent_id: str, user_id: str) -> dict:
    return {"version_id": None, "base_url": None, "tools": [], "skipped": [], "disabled_reason": "workflow blackbox"}


@activity.defn(name="predict_jev_progress")
async def mock_predict_jev_progress(snapshot: dict) -> None:
    return None


CUTOVER_CODE_SESSION = {
    "task_id": "cc-task-1",
    "sandbox_id": "sb-1",
    "ws_url": "wss://3000-sb-1.e2b.example",
    "code_provider": "claude",
    "started_at": 1000.0,
    "loop_started_at": 1005.0,
}


@activity.defn(name="spawn_claude_code_activity")
async def mock_spawn_claude_code_activity(
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
    output_schema: Optional[Dict[str, Any]] = None,
    attachments: Optional[List[Dict[str, Any]]] = None,
    model: str = "rose-labs/rose-1-flash",
    github_repo_url: Optional[str] = None,
    _legacy_claude_token: Optional[str] = None,
    code_provider: str = "claude",
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    resume_session: Optional[Dict[str, Any]] = None,
    code_session_request: Optional[Dict[str, Any]] = None,
    target: str = "cloud",
    local_device_id: Optional[str] = None,
    local_device_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Claude Code run that a deploy drains once mid-run, then finishes in the same sandbox.

    Returns the payloads the real activity returns at those boundaries; the
    manager/workflow under test are production code.
    """
    info = activity.info()
    scenario = CUTOVER_CODE[agent_id]
    scenario["calls"].append(
        {
            "task_queue": info.task_queue,
            "workflow_run_id": info.workflow_run_id,
            "tool_call_id": tool_call_id,
            "code_provider": code_provider,
            "resume_session": dict(resume_session) if resume_session else None,
        }
    )
    if len(scenario["calls"]) == 1:
        from domains.spawn_claude_code_agent.config import CODE_AGENT_DRAIN_YIELD_STATUS
        from helpers.activity_generation_drain import GENERATION_SUPERSEDED

        # The deploy moved the live pointer while Claude Code was working; the
        # real activity detaches from the sandbox at its next drain check.
        CUTOVER_POINTER[info.workflow_id] = scenario["new_queue"]
        return {
            "status": CODE_AGENT_DRAIN_YIELD_STATUS,
            "yield_reason": GENERATION_SUPERSEDED,
            "code_session": dict(CUTOVER_CODE_SESSION),
            "task_id": CUTOVER_CODE_SESSION["task_id"],
            "code_provider": code_provider,
        }
    return {
        "status": "completed",
        "success": True,
        "message": "answer.txt contains 42",
        "task_id": (resume_session or {}).get("task_id"),
        "structured_response": {"answer": "42"},
        "output_files": [],
        "code_provider": code_provider,
        "usage_items": [{"type": "service", "provider": "E2B Sandbox", "cost_cents": 3.0}],
    }


# Collect all mock activities for Worker registration
MOCK_ACTIVITIES = [
    mock_resolve_agent_address_activity,
    mock_get_model_context_window,
    mock_update_agent_status,
    mock_acknowledge_workflow_replacement_bootstrap,
    mock_finalize_workflow_replacement_bootstrap,
    mock_get_agent_source,
    mock_notify_sms_event_activity,
    mock_get_user_context,
    mock_get_user_system_name,
    mock_get_user_custom_system_prompt,
    mock_fetch_agent_queue_pointer,
    mock_fetch_claude_max_token_activity,
    mock_fetch_compute_token_activity,
    mock_mark_compute_token_rate_limited_activity,
    mock_release_compute_token_lineage_activity,
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
    mock_call_llm_activity,
    mock_check_progress,
    mock_call_planner_llm_activity,
    mock_query_parent_state_activity,
    mock_resolve_attachments_activity,
    mock_execute_reasoning_activity,
    mock_populate_tool_params_activity,
    mock_save_blueprint_activity,
    mock_set_response_schema_activity,
    mock_persist_response_schema_activity,
    mock_send_direct_sms_activity,
    mock_resolve_fast_cache_goal_activity,
    mock_resolve_fast_cache_context_activity,
    mock_create_approval_request_activity,
    mock_spawn_browser_agent_activity_v3,
    mock_resolve_code_agent_provider_activity,
    mock_spawn_claude_code_activity,
    mock_resolve_user_tools_activity,
    mock_predict_jev_progress,
]


# ---------------------------------------------------------------------------
# Workflow import: use the same unsafe passthrough pattern as production code
# so the workflow class and all its transitive imports are available.
# ---------------------------------------------------------------------------

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from workflows.agent_workflow import AgentWorkflow

from helpers.workflow_sandbox import production_workflow_runner

_WORKFLOW_RUNNER = production_workflow_runner()


def test_workflow_sandbox_import_does_not_initialize_activity_package():
    """Replay imports preserve the pure policy without initializing activities."""
    import sys
    from datetime import timedelta

    from helpers.wmh_activity_policy import wmh_activity_timeout_options

    initialized = []
    policies = []
    previous = sys.getprofile()

    def observe(frame, event, _arg):
        filename = frame.f_code.co_filename.replace("\\", "/")
        if frame.f_code.co_name != "<module>":
            return
        if event == "call" and filename.endswith("/helpers/__init__.py"):
            initialized.append(filename)
        if event == "return" and filename.endswith("/workflows/agent_workflow.py"):
            policies.append(frame.f_globals["wmh_activity_timeout_options"])

    sys.setprofile(observe)
    try:
        _WORKFLOW_RUNNER.prepare_workflow(workflow._Definition.must_from_class(AgentWorkflow))
    finally:
        sys.setprofile(previous)
    assert len(policies) == 1, "Expected the actual replay workflow module to execute once"
    timeout = timedelta(seconds=7)
    for mode in ("real", "simulate", "shadow", "unknown"):
        actual = policies[0](mode, timeout)
        expected = wmh_activity_timeout_options(mode, timeout)
        assert actual == expected, f"Replay changed the WMH deadline policy for {mode}"
        actual.clear()
        assert policies[0](mode, timeout) == expected, "Policy results must not share mutable state"
    assert not initialized, "Workflow replay initialized activity helpers before their import boundary"
    assert policies[0] is wmh_activity_timeout_options, "Replay must retain the immutable policy export"


# Default workflow args matching AgentWorkflow.run() signature
DEFAULT_WF_ARGS: list = [
    "agent-test-1",  # agent_id
    "user-test-1",  # user_id
    "Test goal",  # goal
    "rose-labs/rose-1-flash",  # model
    256,  # reasoning_max_tokens
    {  # verifier
        "type": "FLOAT_LLM_JUDGE",
    },
]

TASK_QUEUE = "test-workflow-queue"

# Mutable holder avoids rebinding module state across tests.
_wf_counter = [0]


def _next_wf_id(prefix: str = "test") -> str:
    _wf_counter[0] += 1
    return f"{prefix}-wf-{_wf_counter[0]}"


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


async def _test_failed_execute_poll_ends_agent_terminal(env) -> None:
    # Poll 2 is the EXECUTE-entry durable read; poll 3 is run_agent's first loop
    # poll, the call that timed out in the reproduced mass-agent stall.
    for successful_polls in (1, 2):
        await _assert_failed_poll_ends_agent_terminal(env, successful_polls)


async def _assert_failed_poll_ends_agent_terminal(env, successful_polls: int) -> None:
    """A failed EXECUTE poll must end the agent terminal, never ACTIVE (RCA P9).

    Mass-agent cloud copies stalled with a leaf ACTIVE and silent for 510s.
    Under single-worker saturation the leaf's poll_new_messages timed out; the
    ActivityError escaped AgentWorkflow.run, failing the Temporal execution
    without a terminal status, so the row stayed ACTIVE and the parent waited
    for it indefinitely.
    """
    from temporalio.client import WorkflowFailureError

    poll_fail_id = f"agent-poll-fail-p9-{successful_polls}"
    WORKFLOW_ENV_ACTIVITY_COUNTS.pop(poll_fail_id, None)
    WORKFLOW_ENV_STATUSES.pop(poll_fail_id, None)
    POLL_FAILURE_AFTER[poll_fail_id] = successful_polls
    handle = None
    try:
        handle = await env.client.start_workflow(
            AgentWorkflow.run,
            args=[
                poll_fail_id,
                "user-test-1",
                "Research one creator",
                "rose-labs/rose-1-flash",
                256,
                {"type": "FLOAT_LLM_JUDGE"},
                None,  # context
                "parent-wf-poll-fail",  # parent_workflow_id
                "parent-agent-poll-fail",  # parent_agent_id
                1,  # depth
                None,  # bus_id
                "execute",  # start_phase
            ],
            id=_next_wf_id("poll-fail-terminal"),
            task_queue=TASK_QUEUE,
        )
        workflow_error: Optional[BaseException] = None
        try:
            await asyncio.wait_for(handle.result(), timeout=60)
        except WorkflowFailureError as exc:
            workflow_error = exc
        polls = WORKFLOW_ENV_ACTIVITY_COUNTS.get(poll_fail_id, {}).get("poll_new_messages", 0)
        statuses = WORKFLOW_ENV_STATUSES.get(poll_fail_id, [])
        assert polls > POLL_FAILURE_AFTER[poll_fail_id], f"the injected poll failure never ran (polls={polls})"
        assert workflow_error is None, (
            f"a failed poll must not escape AgentWorkflow.run: {workflow_error!r} (statuses={statuses})"
        )
        assert statuses and statuses[-1] == "FAILED", (
            f"agent row left non-terminal after a failed poll: statuses={statuses}"
        )
    except BaseException:
        if handle is not None:
            await _cancel_workflow(handle)
        raise
    finally:
        POLL_FAILURE_AFTER.pop(poll_fail_id, None)


async def _run_poll_burst(env, agent_id: str, burst: Optional[int]) -> tuple:
    """Run a sub-agent whose run_agent loop poll (call 3) hits a retryable burst."""
    from temporalio.client import WorkflowFailureError

    WORKFLOW_ENV_ACTIVITY_COUNTS.pop(agent_id, None)
    WORKFLOW_ENV_STATUSES.pop(agent_id, None)
    POLL_TRANSIENT_BURST[agent_id] = (2, burst)
    handle = None
    try:
        handle = await env.client.start_workflow(
            AgentWorkflow.run,
            args=[
                agent_id,
                "user-test-1",
                "Research one creator",
                "rose-labs/rose-1-flash",
                256,
                {"type": "FLOAT_LLM_JUDGE"},
                None,  # context
                "parent-wf-poll-burst",  # parent_workflow_id
                "parent-agent-poll-burst",  # parent_agent_id
                1,  # depth
                None,  # bus_id
                "execute",  # start_phase
                3,  # max_iterations: the mock loop never completes on its own
            ],
            id=_next_wf_id("poll-burst"),
            task_queue=TASK_QUEUE,
        )
        workflow_error: Optional[BaseException] = None
        result = None
        try:
            result = await asyncio.wait_for(handle.result(), timeout=120)
        except WorkflowFailureError as exc:
            workflow_error = exc
        polls = WORKFLOW_ENV_ACTIVITY_COUNTS.get(agent_id, {}).get("poll_new_messages", 0)
        return result, workflow_error, polls, WORKFLOW_ENV_STATUSES.get(agent_id, [])
    except BaseException:
        if handle is not None:
            await _cancel_workflow(handle)
        raise
    finally:
        POLL_TRANSIENT_BURST.pop(agent_id, None)


async def _test_transient_poll_burst_recovers(env) -> None:
    """A saturation burst shorter than the poll retry schedule must not fail the agent.

    RCA P9: 30 s x 3 attempts gave up after ~94 s of worker saturation. The
    golden-ref schedule (10 attempts, 0.5 s -> 8 s backoff) rides out a burst of
    6 consecutive failures and the agent finishes normally.
    """
    result, workflow_error, polls, statuses = await _run_poll_burst(env, "agent-poll-burst-p9", 6)
    assert workflow_error is None, f"transient poll burst escaped run(): {workflow_error!r}"
    assert polls > 2 + 6 + 1, f"the loop never polled successfully after the burst (polls={polls})"
    # The mock loop ends at its iteration cap, never on the poll failure.
    assert (result or {}).get("reason") == "max_iterations", (
        f"a recoverable poll burst ended the agent: result={result} statuses={statuses[-3:]}"
    )


async def _test_poll_exhaustion_ends_agent_failed(env) -> None:
    """A poll that never recovers exhausts its bounded schedule, then ends the agent FAILED."""
    result, workflow_error, polls, statuses = await _run_poll_burst(env, "agent-poll-exhaust-p9", None)
    assert workflow_error is None, f"poll exhaustion escaped run(): {workflow_error!r} (statuses={statuses})"
    assert polls == 2 + 10, f"poll retry schedule is not the bounded 10 attempts (polls={polls})"
    assert statuses and statuses[-1] == "FAILED", f"exhausted poll left the agent non-terminal: {statuses}"
    assert (result or {}).get("reason") == "workflow_error", f"unexpected terminal result: {result}"


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
            # --- test: deployment-restored cold states use a signal-only wait ---
            name = "wf_deployment_cold_states_do_not_poll"
            cold_handles = []
            try:
                for prior_status in ("PAUSED", "COST_LIMIT_REACHED", "OUT_OF_CREDITS"):
                    cold_agent_id = f"agent-cold-{prior_status.lower()}"
                    WORKFLOW_ENV_ACTIVITY_COUNTS.pop(cold_agent_id, None)
                    resume_state = _deployment_resume_fixture(prior_status)
                    handle = await env.client.start_workflow(
                        AgentWorkflow.run,
                        args=[
                            cold_agent_id,
                            "user-test-1",
                            "Wait without polling",
                            "rose-labs/rose-1-flash",
                            256,
                            {"type": "FLOAT_LLM_JUDGE"},
                            None,
                            None,
                            None,
                            0,
                            None,
                            "resume",
                            37,
                            250,
                            None,
                            False,
                            resume_state,
                        ],
                        id=_next_wf_id(f"cold-{prior_status.lower()}"),
                        task_queue=TASK_QUEUE,
                    )
                    cold_handles.append(handle)

                    for _ in range(40):
                        counts = WORKFLOW_ENV_ACTIVITY_COUNTS.get(cold_agent_id, {})
                        if counts.get("finalize_workflow_replacement_bootstrap") == 1:
                            break
                        await asyncio.sleep(0.05)

                    paused = await handle.query(AgentWorkflow.is_paused_query)
                    assert paused is True, f"{prior_status} candidate was not cold"
                    before = dict(WORKFLOW_ENV_ACTIVITY_COUNTS.get(cold_agent_id, {}))
                    assert before.get("finalize_workflow_replacement_bootstrap") == 1
                    assert before.get("update_agent_status", 0) == 0
                    assert before.get("poll_new_messages", 0) == 0
                    assert before.get("call_llm_activity", 0) == 0
                    assert before.get("post_agent_message", 0) == 0

                    # A real wall-clock interval proves the workflow remains on
                    # the signal-only wait instead of time-skipping a polling timer.
                    await asyncio.sleep(0.25)
                    assert WORKFLOW_ENV_ACTIVITY_COUNTS.get(cold_agent_id, {}) == before

                    if prior_status == "COST_LIMIT_REACHED":
                        await handle.signal(AgentWorkflow.price_limit_increased, {"new_limit_cents": 500})
                    else:
                        await handle.signal(AgentWorkflow.resume)

                    # The valid signal crosses continue-as-new and the continued
                    # execution reaches its normal durable message poll.
                    for _ in range(80):
                        if WORKFLOW_ENV_ACTIVITY_COUNTS.get(cold_agent_id, {}).get("poll_new_messages", 0) > 0:
                            break
                        await asyncio.sleep(0.05)
                    assert WORKFLOW_ENV_ACTIVITY_COUNTS.get(cold_agent_id, {}).get("poll_new_messages", 0) > 0, (
                        f"{prior_status} did not continue after a valid resume"
                    )
                    await _cancel_workflow(handle)

                results.append((name, None))
            except Exception as e:
                for handle in cold_handles:
                    await _cancel_workflow(handle)
                results.append((name, e))

            # --- test: a failed EXECUTE poll ends the agent terminal (RCA P9) ---
            name = "wf_failed_execute_poll_ends_agent_terminal"
            try:
                await _test_failed_execute_poll_ends_agent_terminal(env)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

            # --- test: a transient poll burst recovers within the retry schedule (RCA P9) ---
            name = "wf_transient_poll_burst_recovers"
            try:
                await _test_transient_poll_burst_recovers(env)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

            # --- test: poll exhaustion ends the agent FAILED after the bounded schedule (RCA P9) ---
            name = "wf_poll_exhaustion_ends_agent_failed"
            try:
                await _test_poll_exhaustion_ends_agent_failed(env)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

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

            # --- test: DEMO cache goal comes from the persisted agent row ---
            # Chat escalation starts the workflow with an LLM-refined goal that
            # differs from the persisted Agent row and varies run to run. Cache
            # keys namespace by exact goal hash, so keying on the workflow-input
            # goal gives every chat-originated run a fresh, empty namespace.
            # The workflow must thread the DB-row goal into LLM activities.
            name = "wf_demo_cache_goal_uses_persisted_row"
            try:
                fc_agent_id = "agent-test-democache"
                FAST_MODE_GOAL_CAPTURE.pop(fc_agent_id, None)
                demo_prefix = "I'm building a [REDACTED] brand for health, longevity, technology, founder journey"  # pragma: allowlist secret
                persisted_goal = f"{demo_prefix} — persisted DB goal"
                handle = await env.client.start_workflow(
                    AgentWorkflow.run,
                    args=[
                        fc_agent_id,
                        "user-test-1",
                        f"{demo_prefix} — refined chat goal (volatile, differs per run)",
                        "rose-labs/rose-1-flash",
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
                        True,  # fast_mode_cache_enabled (button; cache still DEMO-gated)
                    ],
                    id=_next_wf_id("demo-cache-goal"),
                    task_queue=TASK_QUEUE,
                )
                # Wait until the workflow reaches its first LLM call.
                for _ in range(60):
                    if FAST_MODE_GOAL_CAPTURE.get(fc_agent_id):
                        break
                    await asyncio.sleep(0.5)

                captured_goals = FAST_MODE_GOAL_CAPTURE.get(fc_agent_id)
                assert captured_goals, "Workflow never reached an LLM call"
                assert captured_goals[0] == persisted_goal, (
                    f"Fast Mode cache goal must be the persisted agent-row goal, got {captured_goals[0]!r}"
                )

                await _cancel_workflow(handle)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

            # Leftover GP children keep a non-DEMO input goal. If the Fast Mode
            # button is off, root-goal resolution must still run so they inherit
            # DEMO wait_for / cache from the tree root.
            name = "wf_leftover_child_resolves_root_goal_when_fast_mode_off"
            try:
                leftover_id = LEFTOVER_CHILD_AGENT_ID
                FAST_MODE_GOAL_CAPTURE.pop(leftover_id, None)
                FAST_MODE_ENABLED_CAPTURE.pop(leftover_id, None)
                while leftover_id in RESOLVE_DEMO_CACHE_GOAL_CALLS:
                    RESOLVE_DEMO_CACHE_GOAL_CALLS.remove(leftover_id)
                handle = await env.client.start_workflow(
                    AgentWorkflow.run,
                    args=[
                        leftover_id,
                        "user-test-1",
                        LEFTOVER_CHILD_GOAL,
                        "rose-labs/rose-1-flash",
                        256,
                        {"type": "FLOAT_LLM_JUDGE"},
                        None,  # context
                        "parent-wf-leftover",  # parent_workflow_id
                        "parent-agent-leftover",  # parent_agent_id
                        1,  # depth
                        None,  # bus_id
                        "execute",  # start_phase
                        None,  # max_iterations
                        100,  # price_limit_cents
                        None,  # context_gates
                        False,  # fast_mode_cache_enabled (button off)
                    ],
                    id=_next_wf_id("leftover-child-root-goal"),
                    task_queue=TASK_QUEUE,
                )
                for _ in range(60):
                    if leftover_id in RESOLVE_DEMO_CACHE_GOAL_CALLS:
                        break
                    await asyncio.sleep(0.5)
                assert leftover_id in RESOLVE_DEMO_CACHE_GOAL_CALLS, (
                    "leftover child must resolve tree root_goal even when Fast Mode is off"
                )
                for _ in range(60):
                    if FAST_MODE_ENABLED_CAPTURE.get(leftover_id):
                        break
                    await asyncio.sleep(0.5)
                enabled = FAST_MODE_ENABLED_CAPTURE.get(leftover_id)
                assert enabled, "leftover child never reached an LLM call"
                assert enabled[0] is True, (
                    f"leftover child must inherit DEMO cache from root_goal, got fast_mode_cache_enabled={enabled[0]!r}"
                )
                await _cancel_workflow(handle)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))

            # A woken sub-agent's verifier must judge the NEW_TASK it was woken
            # with. The wake clears the previous run's schema; the verifier sees
            # no goal row and drops agent-message rows, so without a regenerated
            # schema it scores correct work 0% and the agent detours (run 4:
            # 10-minute browser re-verification → tree timeout at 900s).
            name = "wf_woken_subagent_verifier_judges_new_task_schema"
            try:
                woken_id = WOKEN_SUBAGENT_ID
                CUTOVER_MESSAGES[woken_id] = [
                    {
                        "id": "woken-goal",
                        "role": "USER",
                        "text": WOKEN_ORIGINAL_GOAL,
                        "timestamp": "2026-10-19T22:01:10+00:00",
                        "metadata": {},
                    },
                    {
                        "id": "woken-summary",
                        "role": "TOOL",
                        "text": "",
                        "timestamp": "2026-10-19T22:02:41+00:00",
                        "metadata": {"toolName": "completion_summary", "toolStatus": "FINISHED"},
                    },
                    {
                        "id": "woken-new-task",
                        "role": "USER",
                        "text": WOKEN_NEW_TASK,
                        "timestamp": "2026-10-19T22:02:50+00:00",
                        "metadata": {
                            "agentMessage": True,
                            "messageType": "NEW_TASK",
                            "fromAgentPath": "/root/outreach_coordinator",
                            "toAgentPath": "/root/outreach_coordinator/draft_garry_tan",
                        },
                    },
                ]
                SCHEMA_GENERATION_CAPTURE[woken_id] = []
                VERIFIER_SCHEMA_CAPTURE[woken_id] = []
                CUTOVER_LLM_SCRIPTS[woken_id] = [[{"tool": "attempt_completion", "result": "All done"}]]
                WORKFLOW_ENV_ACTIVITY_COUNTS.pop(woken_id, None)
                handle = await env.client.start_workflow(
                    AgentWorkflow.run,
                    args=[
                        woken_id,
                        "user-test-1",
                        WOKEN_NEW_TASK,
                        "rose-labs/rose-1-flash",
                        256,
                        {"type": "FLOAT_LLM_JUDGE"},
                        None,  # context
                        "parent-wf-woken",  # parent_workflow_id
                        "parent-agent-woken",  # parent_agent_id
                        2,  # depth
                        None,  # bus_id
                        "execute",  # start_phase
                    ],
                    id=f"{woken_id}:wake:woken-new-task",
                    task_queue=TASK_QUEUE,
                )
                for _ in range(60):
                    if VERIFIER_SCHEMA_CAPTURE[woken_id]:
                        break
                    await asyncio.sleep(0.5)
                judged = VERIFIER_SCHEMA_CAPTURE[woken_id]
                assert judged, "woken sub-agent never reached its verifier"
                assert any(
                    row.get("role") == "ASSISTANT"
                    and any(
                        call.get("tool") == "attempt_completion"
                        for call in (row.get("metadata") or {}).get("tool_calls", [])
                    )
                    for row in CUTOVER_MESSAGES[woken_id]
                ), "woken sub-agent reached fallback verification without dispatching its completion tool"
                # The scripted completion must reach the verifier directly;
                # exhausting the loop also verifies and would be a false pass.
                llm_calls = WORKFLOW_ENV_ACTIVITY_COUNTS.get(woken_id, {}).get("call_llm_activity", 0)
                assert llm_calls == 1, f"scripted completion must finish in one call, got {llm_calls}"
                assert judged[0] == WOKEN_SCHEMA, (
                    f"woken sub-agent verifier judged without the new task's schema: {judged[0]!r}"
                )
                generated = SCHEMA_GENERATION_CAPTURE[woken_id]
                assert len(generated) == 1, f"expected one startup schema generation, got {generated!r}"
                assert generated[0][0] == WOKEN_NEW_TASK and WOKEN_ORIGINAL_GOAL in generated[0], generated
                await _cancel_workflow(handle)
                results.append((name, None))
            except Exception as e:
                results.append((name, e))
            finally:
                for capture in (
                    CUTOVER_MESSAGES,
                    SCHEMA_GENERATION_CAPTURE,
                    VERIFIER_SCHEMA_CAPTURE,
                    CUTOVER_LLM_SCRIPTS,
                    CUTOVER_LLM_QUEUES,
                ):
                    capture.pop(WOKEN_SUBAGENT_ID, None)

    return results


CUTOVER_OLD_QUEUE = "cutover-e2e-old"
CUTOVER_NEW_QUEUE = "cutover-e2e-new"
CUTOVER_BROWSER_GOAL = "Buy the $12 item on shop.example.com and report the confirmation number"


CUTOVER_CODE_TOOL_CALL = {
    "tool": "spawn_agent",
    "type": "code",
    "task_name": "puzzle",
    "goal": "Write answer.txt containing the answer to the puzzle",
    "output_schema": {"fields": [{"name": "answer", "type": "str", "required": True}]},
    # Foreground parking contract; background cutover is covered by background_agents.
    "run_in_background": False,
}


def _opt_in_cutover_agent(
    agent_id: str,
    workflow_id: str,
    scenario: Dict[str, Any],
    tool_call: Optional[Dict[str, Any]] = None,
) -> None:
    CUTOVER_POINTER[workflow_id] = CUTOVER_OLD_QUEUE
    CUTOVER_POINTER_FETCHES[workflow_id] = []
    CUTOVER_MESSAGES[agent_id] = []
    CUTOVER_COMPLETION_REQUESTED[agent_id] = False
    CUTOVER_LLM_QUEUES[agent_id] = []
    CUTOVER_VERIFIER_CONTEXTS[agent_id] = []
    CUTOVER_SMS[agent_id] = []
    CUTOVER_USAGE[agent_id] = []
    CUTOVER_APPROVAL_REQUESTS[agent_id] = []
    CUTOVER_BROWSER[agent_id] = {**scenario, "calls": []}
    CUTOVER_CODE[agent_id] = {**scenario, "calls": []}
    CUTOVER_LLM_SCRIPTS[agent_id] = [
        [
            tool_call
            or {
                "tool": "spawn_agent",
                "type": "browser",
                "task_name": "checkout",
                "goal": CUTOVER_BROWSER_GOAL,
                "start_url": "https://shop.example.com",
                "output_schema": {"fields": [{"name": "confirmation", "type": "str", "required": True}]},
                # Foreground parking contract; background cutover is covered by background_agents.
                "run_in_background": False,
            }
        ]
    ]
    CUTOVER_RESPONSE_SCHEMAS[agent_id] = CUTOVER_LLM_SCRIPTS[agent_id][0][0]["output_schema"]
    SCHEMA_GENERATION_CAPTURE[agent_id] = []
    VERIFIER_SCHEMA_CAPTURE[agent_id] = []


# The root's schema generator returns the same declared output contract as
# its sole delegated task. Other workflow fixtures retain their no-schema path.
async def _start_cutover_workflow(client, agent_id: str, workflow_id: str):
    return await client.start_workflow(
        AgentWorkflow.run,
        args=[
            agent_id,
            "user-test-1",
            "Order the item on shop.example.com",
            "rose-labs/rose-1-flash",
            256,
            {"type": "FLOAT_LLM_JUDGE"},
            None,  # context
            None,  # parent_workflow_id
            None,  # parent_agent_id
            0,  # depth
            None,  # bus_id
            "execute",  # start_phase
        ],
        id=workflow_id,
        task_queue=CUTOVER_OLD_QUEUE,
    )


def _assert_browser_resumed_on_new_generation(agent_id: str) -> tuple:
    import inspect

    from domains.spawn_browser_agent_v3.handler import spawn_browser_agent_activity_v3

    # A drifted mock signature fails every scheduled call before it records one.
    assert list(inspect.signature(mock_spawn_browser_agent_activity_v3).parameters) == list(
        inspect.signature(spawn_browser_agent_activity_v3).parameters
    ), "mock_spawn_browser_agent_activity_v3 must mirror the real activity signature"
    assert SCHEMA_GENERATION_CAPTURE[agent_id] == [["Order the item on shop.example.com"]]
    assert CUTOVER_GENERATED_SCHEMAS[agent_id] == CUTOVER_RESPONSE_SCHEMAS[agent_id]
    assert VERIFIER_SCHEMA_CAPTURE[agent_id] and all(
        schema == CUTOVER_RESPONSE_SCHEMAS[agent_id] for schema in VERIFIER_SCHEMA_CAPTURE[agent_id]
    ), "the continued verifier must retain the generated native schema"
    calls = CUTOVER_BROWSER[agent_id]["calls"]
    assert len(calls) == 2, f"expected one interrupted + one resumed browser activity, got {len(calls)}"
    first, second = calls
    assert first["task_queue"] == CUTOVER_OLD_QUEUE and first["is_resume"] is False, first
    assert second["task_queue"] == CUTOVER_NEW_QUEUE, f"resumed browser ran on {second['task_queue']}"
    assert second["workflow_run_id"] != first["workflow_run_id"], "resume must run in the continued generation"
    assert second["tool_call_id"] == first["tool_call_id"], "resume must re-enter the same tool call"
    assert second["task_id"] == first["task_id"], "resume must keep the browser task identity"
    assert second["is_resume"] is True, "second browser activity must resume, not start fresh"
    # The browser agent runs on the root's model pool in both generations.
    assert [call["agent_model"] for call in calls] == ["rose-labs/rose-1-flash"] * 2, calls
    assert second["session_id"] == "steel-session-1", second
    assert second["cdp_url"] == "wss://steel.example/cdp/1", second
    resume = second["write_lock_resume_state"]
    assert resume.get("step_count") == 7, f"resume must continue from step 7, got {resume.get('step_count')}"
    assert resume.get("action_history") == [{"step": 1, "action": "click", "params": {"index": 3}}], resume
    assert resume.get("visited_urls") == ["https://shop.example.com/cart"], resume
    assert resume.get("browser_turn_messages") == [{"role": "assistant", "content": "clicked checkout"}], resume
    assert resume.get("reasoning_messages") == ["cart has the item"], resume
    assert resume.get("action_summary") == ["Opened cart"], resume
    return first, second


def _assert_single_browser_chip_completed(agent_id: str, tool_call_id: str) -> None:
    from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE

    rows = CUTOVER_MESSAGES[agent_id]
    assert not any(DEPLOY_INTERRUPTED_TOOL_MESSAGE in (row["text"] or "") for row in rows), (
        "a parked tool must never be closed with DEPLOY_INTERRUPTED"
    )
    tool_rows = [row for row in rows if row["metadata"].get("toolCallId") == tool_call_id]
    starting = [row for row in tool_rows if row["metadata"].get("title") == "Starting up a browser"]
    assert len(starting) == 1, f"browser startup chip posted {len(starting)} times"
    assert starting[0]["task_queue"] == CUTOVER_OLD_QUEUE
    complete = [row for row in tool_rows if row["metadata"].get("title") == "Browser automation complete"]
    assert len(complete) == 1, f"browser completion posted {len(complete)} times"
    assert complete[0]["metadata"].get("toolStatus") == "FINISHED", complete[0]["metadata"]
    assert complete[0]["task_queue"] == CUTOVER_NEW_QUEUE
    assert "SHOP-4242" in complete[0]["text"], complete[0]["text"]
    assert complete[0]["metadata"].get("structured_response") == {"confirmation": "SHOP-4242"}

    llm_queues = CUTOVER_LLM_QUEUES[agent_id]
    assert llm_queues == [CUTOVER_OLD_QUEUE, CUTOVER_NEW_QUEUE], (
        f"expected one LLM turn per generation (spawn, then complete), got {llm_queues}"
    )
    verifier_contexts = CUTOVER_VERIFIER_CONTEXTS[agent_id]
    assert verifier_contexts, "verifier never ran on the continued generation"
    assert any(
        row.get("role") == "TOOL"
        and (row.get("metadata") or {}).get("toolCallId") == tool_call_id
        and (row.get("metadata") or {}).get("toolStatus") == "FINISHED"
        and "SHOP-4242" in (row.get("text") or "")
        for row in verifier_contexts[-1]
    ), "the continued generation's context must contain the resumed browser result"


def _clear_cutover_test_state(agent_id: str, workflow_id: str) -> None:
    for capture in (
        CUTOVER_MESSAGES, CUTOVER_LLM_SCRIPTS, CUTOVER_LLM_QUEUES,
        CUTOVER_VERIFIER_CONTEXTS, CUTOVER_SMS, CUTOVER_USAGE,
        CUTOVER_APPROVAL_REQUESTS, CUTOVER_BROWSER, CUTOVER_CODE,
        CUTOVER_RESPONSE_SCHEMAS, CUTOVER_GENERATED_SCHEMAS, CUTOVER_COMPLETION_REQUESTED,
        SCHEMA_GENERATION_CAPTURE, VERIFIER_SCHEMA_CAPTURE,
    ):
        capture.pop(agent_id, None)
    CUTOVER_POINTER.pop(workflow_id, None)
    CUTOVER_POINTER_FETCHES.pop(workflow_id, None)


async def _capture_cutover_failure(client, handle, name: str, agent_id: str, error: Exception) -> None:
    """Optional bounded evidence; five seconds bounds RPC work, not local I/O."""
    directory = os.environ.get("ROSE_CUTOVER_FAILURE_DIR")
    if not directory:
        return
    observed_at = datetime.now(timezone.utc).isoformat()
    observed_monotonic = asyncio.get_running_loop().time()
    stage = "prepare"
    try:
        from collections import deque
        from datetime import timedelta
        from pathlib import Path
        import tempfile
        import math
        from temporalio.client import WorkflowHistoryEventFilterType

        losses = {}
        nodes = 0

        def bounded_text(value):
            prefix = value[:1024].encode("utf-8")[:1024].decode("utf-8", "ignore")
            if len(prefix) != len(value):
                losses["strings_truncated"] = losses.get("strings_truncated", 0) + 1
            return prefix

        def project(value, depth=0):
            nonlocal nodes
            nodes += 1
            if nodes > 2048 or depth > 5:
                losses["projection_budget_drops"] = losses.get("projection_budget_drops", 0) + 1
                return {"omitted": "projection_budget"}
            if value is None or isinstance(value, bool):
                return value
            if isinstance(value, float):
                if math.isfinite(value):
                    return value
                losses["non_finite_floats"] = losses.get("non_finite_floats", 0) + 1
                return {"omitted": "non_finite_float"}
            if isinstance(value, int):
                return value if value.bit_length() <= 64 else {"omitted": "large_integer"}
            if isinstance(value, str):
                return bounded_text(value)
            if isinstance(value, dict):
                result = {}
                for index, (key, child) in enumerate(value.items()):
                    if index == 32:
                        break
                    if isinstance(key, str):
                        bounded_key = key[:128].encode("utf-8")[:128].decode("utf-8", "ignore")
                        if bounded_key != key:
                            losses["keys_truncated"] = losses.get("keys_truncated", 0) + 1
                        if bounded_key in result:
                            losses["key_collisions_dropped"] = losses.get("key_collisions_dropped", 0) + 1
                            continue
                        result[bounded_key] = project(child, depth + 1)
                    else:
                        losses["non_string_keys_dropped"] = losses.get("non_string_keys_dropped", 0) + 1
                if len(value) > 32:
                    losses["collection_items_dropped"] = losses.get("collection_items_dropped", 0) + len(value) - 32
                return result
            if isinstance(value, (list, tuple)):
                if len(value) > 32:
                    losses["collection_items_dropped"] = losses.get("collection_items_dropped", 0) + len(value) - 32
                return [project(child, depth + 1) for child in value[-32:]]
            return {"unrepresented_type": type(value).__name__[:128]}

        def write_once(path, receipt, cap):
            raw = json.dumps(receipt, ensure_ascii=True, allow_nan=False).encode("utf-8")
            if len(raw) > cap and isinstance(receipt.get("events"), list) and receipt["events"]:
                # Trim only the remote event prefix; preserve the newest tail and pending state.
                receipt = {**receipt, "losses": dict(receipt.get("losses", {}))}
                original_events = receipt["events"]
                previous_dropped = receipt.get("events_dropped", 0)
                low, high = 1, len(original_events)
                while low < high:
                    middle = (low + high) // 2
                    receipt["events"] = original_events[middle:]
                    receipt["events_dropped"] = previous_dropped + middle
                    receipt["history_complete"] = False
                    receipt["losses"]["byte_cap_events_trimmed"] = middle
                    trial = json.dumps(receipt, ensure_ascii=True, allow_nan=False).encode("utf-8")
                    if len(trial) <= cap:
                        high = middle
                    else:
                        low = middle + 1
                receipt["events"] = original_events[low:]
                receipt["events_dropped"] = previous_dropped + low
                receipt["history_complete"] = False
                receipt["losses"]["byte_cap_events_trimmed"] = low
                raw = json.dumps(receipt, ensure_ascii=True, allow_nan=False).encode("utf-8")
            if len(raw) > cap:
                raw = json.dumps({
                    "capture_gap": "byte_cap", "projected_bytes": len(raw), "byte_cap": cap,
                    "name": bounded_text(name), "failure_observed_at": observed_at,
                    "failure_observed_monotonic": observed_monotonic,
                    "native_outcome": "failed", "error_type": type(error).__name__[:128],
                    "losses": dict(losses), "details_omitted": True,
                    "remote_summary": {key: receipt[key] for key in (
                        "workflow_id", "run_id", "status", "history_length", "events_scanned",
                        "events_dropped", "missing_tail", "history_complete", "history_scan_complete",
                        "capture_gap", "close_events", "pending_activities", "pending_activities_dropped", "pending_workflow_task",
                    ) if key in receipt},
                }).encode("utf-8")
            if len(raw) > cap:
                raw = b'{"capture_gap":"metadata_byte_cap","details_omitted":true}'
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(raw)

        root = Path(directory)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        owned = Path(tempfile.mkdtemp(prefix="cutover-", dir=root))
        # mkdtemp creates a unique directory with mode 0700.
        trace, walked, cursor = deque(maxlen=32), 0, error.__traceback__
        while cursor is not None and walked < 128:
            trace.append({"file": project(cursor.tb_frame.f_code.co_filename),
                          "function": project(cursor.tb_frame.f_code.co_name), "line": cursor.tb_lineno})
            walked += 1
            cursor = cursor.tb_next
        state = project({
            "declared_schema": CUTOVER_RESPONSE_SCHEMAS.get(agent_id),
            "persisted_schema": CUTOVER_GENERATED_SCHEMAS.get(agent_id),
            "schema_generation": SCHEMA_GENERATION_CAPTURE.get(agent_id),
            "verifier_schemas": VERIFIER_SCHEMA_CAPTURE.get(agent_id),
            "completion_requested": CUTOVER_COMPLETION_REQUESTED.get(agent_id),
            "remaining_script": CUTOVER_LLM_SCRIPTS.get(agent_id),
            "llm_queues": CUTOVER_LLM_QUEUES.get(agent_id),
            "browser": CUTOVER_BROWSER.get(agent_id), "code": CUTOVER_CODE.get(agent_id),
            "messages": CUTOVER_MESSAGES.get(agent_id),
            "verifier_contexts": (CUTOVER_VERIFIER_CONTEXTS.get(agent_id) or [])[-1:],
            "verifier_context_count": len(CUTOVER_VERIFIER_CONTEXTS.get(agent_id) or []),
            "verifier_contexts_dropped": max(0, len(CUTOVER_VERIFIER_CONTEXTS.get(agent_id) or []) - 1),
            "usage": CUTOVER_USAGE.get(agent_id), "sms": CUTOVER_SMS.get(agent_id),
        })
        initial = {"name": bounded_text(name), "agent_id": bounded_text(agent_id), "native_outcome": "failed",
                   "workflow_id": bounded_text(getattr(handle, "id", "")),
                   "requested_run_id": bounded_text(getattr(handle, "run_id", None) or ""),
                   "first_execution_run_id": bounded_text(getattr(handle, "first_execution_run_id", None) or ""),
                   "failure_observed_at": observed_at, "failure_observed_monotonic": observed_monotonic,
                   "error_type": type(error).__name__[:128], "error_args": project(error.args),
                   "traceback": list(trace), "traceback_frames_dropped": max(0, walked - 32),
                   "traceback_tail_unknown": cursor is not None, "state": state, "losses": dict(losses)}
        # New primitives only; write ONCE before any await. Later state cannot overwrite it.
        stage = "initial_write"
        write_once(owned / "failure.json", initial, 65536)
        remote = {"rpc_budget_seconds": 5, "rpc_started_at": datetime.now(timezone.utc).isoformat(),
                  "failure_observed_at": observed_at, "history_complete": False, "missing_tail": True}
        rpc_started_monotonic = asyncio.get_running_loop().time()
        events, scanned = deque(maxlen=256), 0

        def timestamp(value):
            return value.ToJsonString()[:64] if hasattr(value, "ToJsonString") else None

        def event_metadata(event):
            row = {"event_id": event.event_id, "event_type": int(event.event_type),
                   "timestamp": timestamp(event.event_time)}
            attribute = event.WhichOneof("attributes")
            row["event_type_name"] = attribute
            if attribute:
                value = getattr(event, attribute)
                for key in ("activity_id", "scheduled_event_id", "started_event_id", "timer_id", "new_execution_run_id"):
                    field = getattr(value, key, None)
                    if field is not None:
                        row[key] = bounded_text(field) if isinstance(field, str) else field
                for key in ("activity_type", "task_queue"):
                    field = getattr(value, key, None)
                    if field is not None:
                        row[key] = bounded_text(field.name)
            return row

        async def observe():
            nonlocal scanned
            if handle is None:
                remote["capture_gap"] = "no_handle"
                return
            remote["rpc_phase"] = "describe"
            description = await handle.describe(rpc_timeout=timedelta(seconds=5))
            remote.update({"workflow_id": bounded_text(description.id), "run_id": bounded_text(description.run_id),
                           "status": int(description.status), "history_length": description.history_length})
            if description.id != handle.id or not isinstance(description.run_id, str) or not description.run_id:
                remote["capture_gap"] = "unresolved_execution_identity"
                return
            raw = description.raw_description
            pending = raw.pending_activities
            remote["pending_activities"] = [{"activity_id": bounded_text(item.activity_id),
                "activity_type": bounded_text(item.activity_type.name), "state": int(item.state)} for item in pending[:16]]
            remote["pending_activities_dropped"] = max(0, len(pending) - 16)
            task = raw.pending_workflow_task
            remote["pending_workflow_task"] = {"present": raw.HasField("pending_workflow_task"),
                "state": int(task.state), "attempt": task.attempt,
                "scheduled_time": timestamp(task.scheduled_time), "started_time": timestamp(task.started_time)}
            pinned = client.get_workflow_handle(description.id, run_id=description.run_id)
            remote["rpc_phase"] = "close_event"
            close = await pinned.fetch_history(event_filter_type=WorkflowHistoryEventFilterType.CLOSE_EVENT,
                                               rpc_timeout=timedelta(seconds=5))
            remote["close_events"] = [event_metadata(event) for event in close.events[:4]]
            remote["close_events_dropped"] = max(0, len(close.events) - 4)
            remote["rpc_phase"] = "history"
            async for event in pinned.fetch_history_events(page_size=64, wait_new_event=False,
                                                          rpc_timeout=timedelta(seconds=5)):
                events.append(event_metadata(event))
                scanned += 1
                if scanned == 1024:
                    remote["capture_gap"] = "history_scan_cap"
                    break
            else:
                remote["history_scan_complete"] = True
                remote["history_complete"] = scanned <= 256
                remote["missing_tail"] = False
                remote["rpc_phase"] = "done"

        try:
            await asyncio.wait_for(observe(), timeout=5)
        except (Exception, asyncio.CancelledError) as capture_error:
            remote["capture_gap"] = type(capture_error).__name__[:128]
        remote.update({"rpc_finished_at": datetime.now(timezone.utc).isoformat(),
                       "rpc_elapsed_seconds": asyncio.get_running_loop().time() - rpc_started_monotonic,
                       "events_scanned": scanned, "events_dropped": max(0, scanned - len(events)),
                       "events": list(events), "losses": dict(losses)})
        stage = "remote_write"
        write_once(owned / "remote.json", remote, 32768)
    except (Exception, asyncio.CancelledError) as capture_error:
        try:
            os.write(2, ("cutover_capture_gap:" + stage + ":" + type(capture_error).__name__[:128] + "\n").encode())
        except Exception:
            pass


async def _run_parked_tool_cutover_tests() -> List[tuple]:
    """Real AgentWorkflow crossing a deploy cutover while a browser/code task is in flight.

    Two workers stand in for the old and new code generations. The fetched
    queue pointer moves to the new generation mid-task; the tool must park,
    ride continue_as_new, and finish on the new generation from the same
    browser step / approval request / code sandbox instead of DEPLOY_INTERRUPTED.
    """
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker

    results: List[tuple] = []

    async with await WorkflowEnvironment.start_time_skipping() as env:
        # max_cached_workflows=0 replays full history on every workflow task, as a
        # sticky-cache miss under load does; tool-call ids must survive replay.
        async with (
            Worker(
                env.client,
                task_queue=CUTOVER_OLD_QUEUE,
                workflows=[AgentWorkflow],
                activities=MOCK_ACTIVITIES,
                workflow_runner=_WORKFLOW_RUNNER,
                max_cached_workflows=0,
            ),
            Worker(
                env.client,
                task_queue=CUTOVER_NEW_QUEUE,
                workflows=[AgentWorkflow],
                activities=MOCK_ACTIVITIES,
                workflow_runner=_WORKFLOW_RUNNER,
                max_cached_workflows=0,
            ),
        ):
            name = "wf_cutover_drained_browser_resumes_same_step_on_new_generation"
            agent_id = "agent-cutover-drain"
            workflow_id = _next_wf_id("cutover-drain")
            handle = None
            try:
                _opt_in_cutover_agent(agent_id, workflow_id, {"mode": "drain", "new_queue": CUTOVER_NEW_QUEUE})
                handle = await _start_cutover_workflow(env.client, agent_id, workflow_id)
                outcome = await asyncio.wait_for(handle.result(), timeout=60)
                assert isinstance(outcome, dict) and outcome.get("status") == "completed", outcome

                first, _second = _assert_browser_resumed_on_new_generation(agent_id)
                resume = CUTOVER_BROWSER[agent_id]["calls"][1]["write_lock_resume_state"]
                assert resume.get("pending_action") is None, resume
                assert "generation_yield" not in resume, "the live generation must be allowed to yield again"
                _assert_single_browser_chip_completed(agent_id, first["tool_call_id"])

                billed_models = [
                    item.get("model")
                    for record in CUTOVER_USAGE[agent_id]
                    for item in record["usage_items"]
                    if item.get("type") == "llm"
                ]
                assert billed_models.count("mock-browser-gen1") == 1, (
                    f"pre-drain browser tokens must be billed exactly once, got {billed_models}"
                )
                assert billed_models.count("mock-browser-gen2") == 1, (
                    f"post-resume browser tokens must be billed exactly once, got {billed_models}"
                )
                results.append((name, None))
            except Exception as e:
                await _capture_cutover_failure(env.client, handle, name, agent_id, e)
                if handle is not None:
                    await _cancel_workflow(handle)
                results.append((name, e))
            finally:
                _clear_cutover_test_state(agent_id, workflow_id)

            name = "wf_cutover_parked_write_approval_rewaits_same_request_on_new_generation"
            agent_id = "agent-cutover-approval"
            workflow_id = _next_wf_id("cutover-approval")
            handle = None
            try:
                _opt_in_cutover_agent(
                    agent_id,
                    workflow_id,
                    {"mode": "write_approval", "flip_pointer_on_approval": CUTOVER_NEW_QUEUE},
                )
                handle = await _start_cutover_workflow(env.client, agent_id, workflow_id)
                for _ in range(400):
                    if CUTOVER_APPROVAL_REQUESTS[agent_id]:
                        break
                    await asyncio.sleep(0.05)
                # The deploy flipped the pointer while the approval is pending; its
                # cutover owner broadcasts the live queue to old-queue workflows.
                from helpers.wait_condition_or_handoff import GENERATION_HANDOFF_SIGNAL

                await handle.signal(GENERATION_HANDOFF_SIGNAL, CUTOVER_NEW_QUEUE)
                current_queue = None
                for _ in range(400):
                    current_queue = (await handle.describe()).task_queue
                    if current_queue == CUTOVER_NEW_QUEUE:
                        break
                    await asyncio.sleep(0.05)
                assert current_queue == CUTOVER_NEW_QUEUE, (
                    "workflow never reached the new generation while the approval was pending"
                )
                request_id = f"attn-{agent_id}-1"
                await handle.signal(
                    AgentWorkflow.receive_user_response,
                    json.dumps(
                        {
                            "request_id": request_id,
                            "response": "approve",
                            "user_message": None,
                        }
                    ),
                )
                outcome = await asyncio.wait_for(handle.result(), timeout=60)
                assert isinstance(outcome, dict) and outcome.get("status") == "completed", outcome

                assert CUTOVER_APPROVAL_REQUESTS[agent_id] == [request_id], (
                    f"resume must re-wait on the original request, got {CUTOVER_APPROVAL_REQUESTS[agent_id]}"
                )
                assert CUTOVER_SMS[agent_id].count("write_lock") == 1, (
                    f"the user must be texted once per approval, got {CUTOVER_SMS[agent_id]}"
                )
                first, second = _assert_browser_resumed_on_new_generation(agent_id)
                resume = second["write_lock_resume_state"]
                assert resume.get("pending_action") == {"action": "click", "params": {"index": 9}}, resume
                assert resume.get("approval_type") == "purchase", resume

                rows = CUTOVER_MESSAGES[agent_id]
                approval_rows = [
                    row
                    for row in rows
                    if ((row["metadata"].get("requestUserApproval") or {}).get("attentionRequestId") == request_id)
                ]
                pending = [row for row in approval_rows if row["metadata"].get("toolStatus") == "IN_PROGRESS"]
                received = [row for row in approval_rows if row["metadata"].get("title") == "✓ User approval received"]
                assert len(pending) == 1 and pending[0]["task_queue"] == CUTOVER_OLD_QUEUE, pending
                assert len(received) == 1 and received[0]["task_queue"] == CUTOVER_NEW_QUEUE, received
                assert received[0]["metadata"].get("toolCallId") == pending[0]["metadata"].get("toolCallId"), (
                    "the approval chip must close on the same tool call it opened"
                )
                granted = [row for row in rows if row["metadata"].get("title") == "✓ Write permission granted"]
                assert len(granted) == 1 and granted[0]["task_queue"] == CUTOVER_NEW_QUEUE, granted
                _assert_single_browser_chip_completed(agent_id, first["tool_call_id"])
                results.append((name, None))
            except Exception as e:
                await _capture_cutover_failure(env.client, handle, name, agent_id, e)
                if handle is not None:
                    await _cancel_workflow(handle)
                results.append((name, e))
            finally:
                _clear_cutover_test_state(agent_id, workflow_id)

            name = "wf_cutover_drained_code_agent_reattaches_same_sandbox_on_new_generation"
            agent_id = "agent-cutover-code"
            workflow_id = _next_wf_id("cutover-code")
            handle = None
            try:
                _assert_code_mock_mirrors_activity()
                _opt_in_cutover_agent(
                    agent_id, workflow_id, {"new_queue": CUTOVER_NEW_QUEUE}, tool_call=CUTOVER_CODE_TOOL_CALL
                )
                handle = await _start_cutover_workflow(env.client, agent_id, workflow_id)
                outcome = await asyncio.wait_for(handle.result(), timeout=60)
                assert isinstance(outcome, dict) and outcome.get("status") == "completed", outcome
                _assert_code_agent_reattached_on_new_generation(agent_id)
                results.append((name, None))
            except Exception as e:
                await _capture_cutover_failure(env.client, handle, name, agent_id, e)
                if handle is not None:
                    await _cancel_workflow(handle)
                results.append((name, e))
            finally:
                _clear_cutover_test_state(agent_id, workflow_id)

            name = "wf_cutover_background_browser_resumes_in_background_and_notifies_once"
            agent_id = "agent-cutover-background"
            workflow_id = _next_wf_id("cutover-background")
            handle = None
            try:
                background_spawn = {
                    "tool": "spawn_agent",
                    "type": "browser",
                    "task_name": "checkout",
                    "goal": CUTOVER_BROWSER_GOAL,
                    "start_url": "https://shop.example.com",
                    "output_schema": {"fields": [{"name": "confirmation", "type": "str", "required": True}]},
                }
                _opt_in_cutover_agent(
                    agent_id,
                    workflow_id,
                    {"mode": "drain", "new_queue": CUTOVER_NEW_QUEUE},
                    tool_call=background_spawn,
                )
                # Turn 2 ends without tool calls: the agent waits for its background browser.
                CUTOVER_LLM_SCRIPTS[agent_id].append([])
                handle = await _start_cutover_workflow(env.client, agent_id, workflow_id)
                outcome = await asyncio.wait_for(handle.result(), timeout=60)
                assert isinstance(outcome, dict) and outcome.get("status") == "completed", outcome

                first, second = _assert_browser_resumed_on_new_generation(agent_id)
                # The executor runs under the spawn's own tool-call id.
                original_id = first["tool_call_id"]
                rows = CUTOVER_MESSAGES[agent_id]
                started = [
                    row
                    for row in rows
                    if row["metadata"].get("toolCallId") == original_id and row["metadata"].get("runInBackground")
                ]
                assert [row["metadata"].get("toolStatus") for row in started] == ["FINISHED"], started
                executor_rows = [
                    row
                    for row in rows
                    if row["metadata"].get("toolCallId") == original_id and not row["metadata"].get("runInBackground")
                ]
                assert executor_rows and all(row["metadata"].get("excludeFromModel") for row in executor_rows)
                assert "Started browser agent in background" in started[0]["text"], started[0]["text"]
                assert started[0]["task_queue"] == CUTOVER_OLD_QUEUE
                notes = [row for row in rows if row["metadata"].get("agentNotification") is True]
                assert len(notes) == 1, notes
                assert notes[0]["role"] == "USER" and notes[0]["task_queue"] == CUTOVER_NEW_QUEUE, notes[0]
                # Same task id across the generation handoff, addressed by its task path.
                assert notes[0]["metadata"].get("fromAgentAddress") == "/root/checkout", notes[0]
                assert notes[0]["metadata"].get("backgroundTaskId") == first["tool_call_id"], notes[0]
                assert notes[0]["metadata"].get("status") == "completed", notes[0]
                assert "SHOP-4242" in notes[0]["text"], notes[0]["text"]
                completion_rejections = [
                    row
                    for row in rows
                    if row["metadata"].get("toolName") == "attempt_completion"
                    and row["metadata"].get("toolStatus") == "ERROR"
                ]
                assert not completion_rejections, "the agent waited instead of completing early"
                results.append((name, None))
            except Exception as e:
                await _capture_cutover_failure(env.client, handle, name, agent_id, e)
                if handle is not None:
                    await _cancel_workflow(handle)
                results.append((name, e))
            finally:
                _clear_cutover_test_state(agent_id, workflow_id)

    return results


def _assert_code_mock_mirrors_activity() -> None:
    import inspect

    from domains.spawn_claude_code_agent.service import spawn_claude_code_activity

    # A drifted mock signature raises TypeError on every attempt, and the
    # unlimited spawn retry policy retries it until the test's wait expires.
    assert list(inspect.signature(mock_spawn_claude_code_activity).parameters) == list(
        inspect.signature(spawn_claude_code_activity).parameters
    ), "mock_spawn_claude_code_activity must mirror the real activity signature"


def _assert_code_agent_reattached_on_new_generation(agent_id: str) -> None:
    from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE

    assert SCHEMA_GENERATION_CAPTURE[agent_id] == [["Order the item on shop.example.com"]]
    assert CUTOVER_GENERATED_SCHEMAS[agent_id] == CUTOVER_RESPONSE_SCHEMAS[agent_id]
    assert VERIFIER_SCHEMA_CAPTURE[agent_id] and all(
        schema == CUTOVER_RESPONSE_SCHEMAS[agent_id] for schema in VERIFIER_SCHEMA_CAPTURE[agent_id]
    ), "the continued verifier must retain the generated native schema"
    calls = CUTOVER_CODE[agent_id]["calls"]
    assert len(calls) == 2, f"expected one drained + one reattached code-agent activity, got {calls}"
    first, second = calls
    assert first["task_queue"] == CUTOVER_OLD_QUEUE and first["resume_session"] is None, first
    assert second["task_queue"] == CUTOVER_NEW_QUEUE, f"reattach ran on {second['task_queue']}"
    assert second["workflow_run_id"] != first["workflow_run_id"], "reattach must run in the continued generation"
    assert second["tool_call_id"] == first["tool_call_id"], "reattach must re-enter the same tool call"
    assert second["resume_session"] == CUTOVER_CODE_SESSION, (
        f"the live generation must reattach to the drained sandbox (and may yield again), got {second}"
    )
    assert second["code_provider"] == first["code_provider"], second

    rows = CUTOVER_MESSAGES[agent_id]
    assert not any(DEPLOY_INTERRUPTED_TOOL_MESSAGE in (row["text"] or "") for row in rows), (
        "a parked code agent must never be closed with DEPLOY_INTERRUPTED"
    )
    tool_rows = [row for row in rows if row["metadata"].get("toolCallId") == first["tool_call_id"]]
    titles = [row["metadata"].get("title") for row in tool_rows]
    starting = [row for row in tool_rows if row["metadata"].get("title") == "Starting Claude Code sandbox"]
    assert len(starting) == 1 and starting[0]["task_queue"] == CUTOVER_OLD_QUEUE, titles
    complete = [row for row in tool_rows if row["metadata"].get("title") == "✓ Task Completed"]
    assert len(complete) == 1 and complete[0]["task_queue"] == CUTOVER_NEW_QUEUE, titles
    assert complete[0]["metadata"].get("task_id") == CUTOVER_CODE_SESSION["task_id"], complete[0]["metadata"]
    assert complete[0]["metadata"].get("structured_response") == {"answer": "42"}, complete[0]["metadata"]
    assert not any(title in {"Task Incomplete", "Code session failed"} for title in titles), titles

    assert CUTOVER_LLM_QUEUES[agent_id] == [CUTOVER_OLD_QUEUE, CUTOVER_NEW_QUEUE], (
        f"expected one LLM turn per generation (spawn, then complete), got {CUTOVER_LLM_QUEUES[agent_id]}"
    )
    verifier_contexts = CUTOVER_VERIFIER_CONTEXTS[agent_id]
    assert verifier_contexts and any(
        row.get("role") == "TOOL"
        and (row.get("metadata") or {}).get("toolCallId") == first["tool_call_id"]
        and (row.get("metadata") or {}).get("toolStatus") == "FINISHED"
        for row in verifier_contexts[-1]
    ), "the continued generation's context must contain the reattached code-agent result"


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


def _deployment_resume_fixture(prior_status: str = "ACTIVE") -> Dict[str, Any]:
    return {
        "version": 1,
        "kind": "deployment",
        "prior_status": prior_status,
        "prior_status_message": "Paused by user" if prior_status == "PAUSED" else None,
        "progress": 0.4,
        "token_count": 950,
        "tokens_in": 680,
        "tokens_out": 270,
        "tree_tokens_in": 900,
        "tree_tokens_out": 350,
        "context_size": 42_000,
        "message_count": 73,
        "own_cost_cents": 17.25,
        "subtree_cost_cents": 29,
        "children_cost_cents": {"child-1": 12},
        "children_tokens_in": {"child-1": 220},
        "children_tokens_out": {"child-1": 80},
        "child_tool_counts": {"web_search": 4},
        "child_last_tokens": {
            "child-1": {"tokens_in": 220, "tokens_out": 80, "token_count": 300},
        },
        "iteration_offset": 6,
        "max_iterations": 37,
        "context_gates": {"network": False, "recent_communications": True},
    }


def test_workflow_restore_deployment_state_preserves_all_durable_counters():
    wf = _bare_workflow_instance()
    wf._restore_deployment_state(_deployment_resume_fixture())

    assert wf._deployment_resume is True
    assert wf._resume_prior_status == "ACTIVE"
    assert wf._resume_progress == 0.4
    assert (wf.token_count, wf.tokens_in, wf.tokens_out) == (950, 680, 270)
    assert (wf.tree_tokens_in, wf.tree_tokens_out) == (900, 350)
    assert (wf.context_size, wf.message_count) == (42_000, 73)
    assert (wf.own_cost_cents, wf.subtree_cost_cents) == (17.25, 29)
    assert wf.children_cost_cents == {"child-1": 12}
    assert wf.children_tokens_in == {"child-1": 220}
    assert wf.children_tokens_out == {"child-1": 80}
    assert wf.child_tool_counts == {"web_search": 4}
    assert wf.child_last_tokens["child-1"]["token_count"] == 300
    assert (wf.iteration_offset, wf.max_iterations) == (6, 37)
    assert wf.context_gates == {"network": False, "recent_communications": True}
    assert wf.is_paused is False
    assert wf._cost_limit_reached is False


def test_workflow_restore_deployment_state_preserves_pause_modes():
    paused = _bare_workflow_instance()
    paused._restore_deployment_state(_deployment_resume_fixture("PAUSED"))
    assert paused.is_paused is True
    assert paused._user_pause_active is False  # Legacy status text is not user intent proof.
    assert paused._cost_limit_reached is False
    assert paused._resume_status_message == "Paused by user"

    limited = _bare_workflow_instance()
    limited._restore_deployment_state(_deployment_resume_fixture("COST_LIMIT_REACHED"))
    assert limited.is_paused is True
    assert limited._cost_limit_reached is True
    assert limited._user_pause_active is False

    out_of_credits = _bare_workflow_instance()
    out_of_credits._restore_deployment_state(_deployment_resume_fixture("OUT_OF_CREDITS"))
    assert out_of_credits.is_paused is True
    assert out_of_credits._has_credits is False
    assert out_of_credits._cost_limit_reached is False


def test_workflow_restore_deployment_state_rejects_unknown_contract():
    wf = _bare_workflow_instance()
    try:
        wf._restore_deployment_state({"version": 2, "kind": "deployment"})
        raise AssertionError("unknown resume versions must fail closed")
    except ValueError as exc:
        assert "Unsupported workflow resume state" in str(exc)


def test_workflow_restore_candidate_validation_stops_before_llm():
    state = _deployment_resume_fixture()
    state["kind"] = "validation"
    state["workflow_started_at"] = "2025-01-01T10:00:00+00:00"
    state["runtime_state"] = {"deployment_validation": True}
    wf = _bare_workflow_instance()
    wf._restore_deployment_state(state)

    assert wf._deployment_resume is True
    assert wf._deployment_validation is True
    assert wf.start_time == datetime(2025, 1, 1, 10, 0, tzinfo=timezone.utc)


def test_workflow_continuation_state_round_trips_complete_runtime():
    """A continue-as-new boundary preserves runtime state but never credentials."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-continuation"
    wf.user_id = "user-continuation"
    wf.goal = "continue"
    wf.model = "rose-labs/rose-1-ultra"
    wf.reasoning_max_tokens = 512
    wf.verifier = {"type": "FLOAT_LLM_JUDGE"}
    wf.parent_workflow_id = "parent-workflow"
    wf.parent_agent_id = "parent-agent"
    wf.depth = 2
    wf.bus_id = "root-bus"
    wf.max_iterations = None
    wf.price_limit_cents = 500
    wf.context_gates = {"network": False}
    wf.fast_mode_cache_enabled = True
    wf.token_count = 950
    wf.tokens_in = 680
    wf.tokens_out = 270
    wf.tree_tokens_in = 900
    wf.tree_tokens_out = 350
    wf.context_size = 42_000
    wf.message_count = 73
    wf.own_cost_cents = 17.25
    wf.subtree_cost_cents = 29
    wf.children_cost_cents = {"child-1": 12}
    wf.children_tokens_in = {"child-1": 220}
    wf.children_tokens_out = {"child-1": 80}
    wf.child_last_tokens = {"child-1": {"tokens_in": 220, "tokens_out": 80, "token_count": 300}}
    wf.iteration_offset = 41
    wf._signal_responses = {"approval-1": "APPROVED"}
    wf._pending_approval_resume = {"request_id": "approval-1", "reminder_sent": True}
    wf._last_signal_response = "continue"
    wf._has_new_messages = True
    wf._response_schema_feedback = ["add total"]
    wf._response_schema_revision = 3
    wf._response_schema_applied_revision = 2
    wf._response_schema_initialized = True
    wf._has_credits = False
    wf._user_pause_active = True
    wf._last_credit_check = 40
    wf.write_lock_enabled = False
    wf._signup_completed = True
    wf.pending_children = {"child-1"}
    wf.child_tool_ids = {"child-1": "tc-child"}
    wf.child_tool_counts = {"web_search": 4}
    wf.child_results = {"child-1": {"status": "running"}}
    wf.child_workflow_ids = {"child-1": "child-workflow"}
    wf.tools_in_use = {"web_search"}
    wf.output_schema = {"fields": [{"name": "total"}]}
    wf.start_time = datetime(2025, 1, 1, 10, 0, tzinfo=timezone.utc)
    wf._last_tree_cost_emit_at = datetime(2025, 1, 1, 10, 1, tzinfo=timezone.utc)
    wf.compute_token_provider = "gpt"
    wf.gpt_code_token = "cached-token"
    wf.gpt_code_account_id = "account-1"
    wf.gpt_code_token_source = "pool"
    wf.gpt_code_token_pool_id = "pool-1"
    wf.compute_token_lineage_key = "lineage-1"
    wf.compute_token_demo_cache_affinity_key = "affinity-1"
    wf.compute_token_fetched_at = datetime(2025, 1, 1, 10, 2, tzinfo=timezone.utc)
    wf.model_pricing_cache = {"model": {"input_cents_per_1k": 1.0}}
    wf.input_cents_per_1k = 1.25
    wf.output_cents_per_1k = 5.0
    wf.actual_model = "actual-model"
    wf.system_name = "Navi"
    wf.custom_system_prompt = "Be concise"
    wf.agent_source = "SMS"
    wf.user_context_section = "cached user context"
    wf.demo_cache_goal = "stable persisted goal"
    # A simulated agent's clock reads world time (two weeks before today here).
    wf.simulated_clock_offset_seconds = -1_209_600
    context = [{"role": "USER", "text": "durable context"}]

    args = wf._continuation_args(context)
    state = args[16]
    restored = _bare_workflow_instance()
    restored.max_iterations = args[12]
    restored._restore_deployment_state(state)

    assert len(args) == 17
    assert args[6] == context
    assert args[11] == "execute_continued"
    assert args[12] is None
    assert state["kind"] == "continuation"
    assert restored._user_pause_active is True
    assert restored.iteration_offset == 41
    assert restored.max_iterations is None
    assert (restored.token_count, restored.tokens_in, restored.tokens_out) == (950, 680, 270)
    assert (restored.tree_tokens_in, restored.tree_tokens_out) == (900, 350)
    assert restored._signal_responses == {"approval-1": "APPROVED"}
    assert restored._pending_approval_resume == {
        "request_id": "approval-1",
        "question": "",
    }
    assert restored._response_schema_revision == 3
    assert restored.pending_children == {"child-1"}
    assert restored.child_workflow_ids == {"child-1": "child-workflow"}
    assert "gpt_code_token" not in state["runtime_state"]
    assert "claude_max_token" not in state["runtime_state"]
    assert restored.compute_token_provider is None
    assert restored.gpt_code_token is None
    assert restored.compute_token_fetched_at is None
    assert restored.start_time == wf.start_time
    assert restored.user_context_section == "cached user context"
    assert restored.context == context
    assert restored.simulated_clock_offset_seconds == -1_209_600
    assert restored._continuation_resume_state(context) == state
    # Button (LLM speed) must survive continue_as_new even when DEMO cache is off.
    wf.provider_fast_mode = True
    wf.fast_mode_cache_enabled = False
    button_args = wf._continuation_args(context)
    assert button_args[15] is True
    wf.provider_fast_mode = False
    button_off_args = wf._continuation_args(context)
    assert button_off_args[15] is False
    wf.world_model_mode = "simulate"
    simulated_args = wf._continuation_args(context)
    assert len(simulated_args) == 18
    assert simulated_args[16]["kind"] == "continuation"
    assert simulated_args[17] == "simulate"
    state_with_historical_counts = {
        **state,
        "child_tool_counts": {"web_search": 1, "web_fetch": 2},
    }
    merged = _bare_workflow_instance()
    merged._restore_deployment_state(state_with_historical_counts)
    assert merged.child_tool_counts == {"web_search": 4, "web_fetch": 2}
    assert restored._iteration_resume_kwargs() == {
        "iteration_offset": 41,
        "demo_cache_position_offset": 41,
    }
    restored.max_iterations = 80
    assert restored._iteration_resume_kwargs()["max_iterations"] == 80


def test_pending_tool_records_copy_args_and_respect_the_handoff_budget():
    from helpers.generation_handoff import (
        PENDING_TOOL_RESUME_MAX_BYTES,
        pending_tool_record,
        pending_tool_resumes_fit,
    )

    tool_args = {"goal": "Buy socks"}
    record = pending_tool_record("spawn_browser_agent", tool_args, "tc-1", {"phase": "activity"})
    tool_args["goal"] = "mutated after parking"
    assert record == {
        "tool_name": "spawn_browser_agent",
        "tool_args": {"goal": "Buy socks"},
        "tool_call_id": "tc-1",
        "resume": {"phase": "activity"},
    }
    assert pending_tool_resumes_fit([record]) is True
    oversized = pending_tool_record("spawn_browser_agent", {}, "tc-2", {"blob": "x" * PENDING_TOOL_RESUME_MAX_BYTES})
    assert pending_tool_resumes_fit([oversized]) is False
    assert pending_tool_resumes_fit([{"resume": object()}]) is False, "unserializable records must never park"


def test_workflow_parks_only_live_run_agent_tool_calls_within_budget():
    """Parking is opt-in per turn, scoped to running calls, and bounded by the 2MB carry."""
    from unittest.mock import patch

    with patch("workflows.agent_workflow.workflow.logger"):
        _assert_workflow_parks_only_live_run_agent_tool_calls_within_budget()


def _assert_workflow_parks_only_live_run_agent_tool_calls_within_budget():
    from helpers.generation_handoff import (
        PENDING_TOOL_RESUME_MAX_BYTES,
        park_pending_tool,
        take_tool_resume,
    )

    wf = _bare_workflow_instance()
    wf._active_tool_calls = {"tc-1": ("spawn_browser_agent", {"goal": "Buy socks"})}
    resume = {"phase": "activity", "resume_state": {"step_count": 4}}

    assert park_pending_tool(wf, "tc-1", resume) is False, "DAG turns treat any tool return as completion"
    assert wf._pending_tool_resumes == []

    wf._tool_parking_enabled = True
    assert park_pending_tool(wf, "tc-unknown", resume) is False, "only a running call can be re-entered"
    assert park_pending_tool(wf, "tc-1", {"phase": "activity"}) is True
    assert park_pending_tool(wf, "tc-1", resume) is True
    assert wf._pending_tool_resumes == [
        {
            "tool_name": "spawn_browser_agent",
            "tool_args": {"goal": "Buy socks"},
            "tool_call_id": "tc-1",
            "resume": resume,
        }
    ], "re-parking the same call keeps only its latest checkpoint"

    wf._active_tool_calls["tc-2"] = ("spawn_browser_agent", {"goal": "Huge"})
    huge = {"blob": "x" * PENDING_TOOL_RESUME_MAX_BYTES}
    assert park_pending_tool(wf, "tc-2", huge) is False, "over-budget calls take DEPLOY_INTERRUPTED instead"
    assert [record["tool_call_id"] for record in wf._pending_tool_resumes] == ["tc-1"]

    assert park_pending_tool(SimpleNamespace(), "tc-1", resume) is False
    wf._tool_resume_hints = {"tc-1": resume}
    assert take_tool_resume(wf, "tc-1") == resume
    assert take_tool_resume(wf, "tc-1") is None, "a parked resume is consumed exactly once"
    assert take_tool_resume(SimpleNamespace(), "tc-1") is None


def test_workflow_continuation_carries_parked_tools_and_drops_malformed_records():
    wf = _bare_workflow_instance()
    wf.max_iterations = None
    wf.context_gates = {}
    parked = {
        "tool_name": "spawn_browser_agent",
        "tool_args": {"goal": "Buy socks"},
        "tool_call_id": "tc-1",
        "resume": {"phase": "write_approval", "attention_request_id": "attn-1"},
    }
    wf._pending_tool_resumes = [parked]

    state = wf._continuation_resume_state([{"role": "USER", "text": "buy socks"}])
    assert state["runtime_state"]["pending_tool_resumes"] == [parked]

    state["runtime_state"]["pending_tool_resumes"] += [
        "not-a-record",
        {**parked, "tool_call_id": 7},
        {**parked, "tool_args": "goal=Buy socks"},
        {key: value for key, value in parked.items() if key != "resume"},
    ]
    restored = _bare_workflow_instance()
    restored._restore_deployment_state(state)
    assert restored._pending_tool_resumes == [parked]


def test_workflow_continuation_backfills_task_name_for_legacy_parked_spawns():
    """A spawn_agent parked by a generation without task_name re-enters validation with a stable valid name."""
    import re

    from utils.tool_schemas import TOOL_MODELS

    def _restore(records):
        wf = _bare_workflow_instance()
        wf.max_iterations = None
        wf.context_gates = {}
        wf._pending_tool_resumes = records
        restored = _bare_workflow_instance()
        restored._restore_deployment_state(wf._continuation_resume_state([{"role": "USER", "text": "buy socks"}]))
        return restored._pending_tool_resumes

    legacy = {
        "tool_name": "spawn_agent",
        "tool_args": {
            "type": "browser",
            "goal": "Buy wool socks",
            "start_url": "https://example.com",
            "output_schema": {"type": "object"},
        },
        "tool_call_id": "toolu_01LegacyBrowser",
        "resume": {"phase": "activity", "resume_state": {"step_count": 4}},
    }
    named = {**legacy, "tool_call_id": "toolu_02Named", "tool_args": {**legacy["tool_args"], "task_name": "socks"}}
    other = {"tool_name": "web_search", "tool_args": {"query": "socks"}, "tool_call_id": "tc-3", "resume": {}}
    restored = _restore([legacy, named, other])

    task_name = restored[0]["tool_args"].get("task_name")
    assert isinstance(task_name, str) and re.match(r"^[a-z][a-z0-9_]{0,39}$", task_name), restored[0]
    assert {k: v for k, v in restored[0]["tool_args"].items() if k != "task_name"} == legacy["tool_args"]
    assert restored[0]["resume"] == legacy["resume"] and restored[0]["tool_call_id"] == legacy["tool_call_id"]
    # The replay's own validation gate (_execute_tool_once) accepts it.
    TOOL_MODELS["spawn_agent"](**{"tool": "spawn_agent", **restored[0]["tool_args"]})
    assert restored[1] == named, "an existing task_name is preserved"
    assert restored[2] == other, "only spawn_agent records are touched"
    assert _restore([legacy])[0]["tool_args"]["task_name"] == task_name, "the backfill is deterministic"
    assert "task_name" not in legacy["tool_args"], "the carried record is not mutated in place"


def test_restart_safe_child_tool_counts_survive_memory_loss_without_duplication():
    from helpers.summarize import _restart_safe_child_tool_counts

    context = [
        {
            "role": "TOOL",
            "metadata": {
                "toolStatus": "FINISHED",
                "toolCallId": "spawn-1",
                "childToolCounts": {"web_search": 2},
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolStatus": "FINISHED",
                "toolCallId": "spawn-1",
                "childToolCounts": {"web_search": 2},
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolStatus": "FINISHED",
                "toolCallId": "spawn-2",
                "childToolCounts": {"web_search": 1, "web_fetch": 3},
            },
        },
    ]

    assert _restart_safe_child_tool_counts(context, {}) == {"web_search": 3, "web_fetch": 3}
    assert _restart_safe_child_tool_counts(context, {"web_search": 3, "web_fetch": 3}) == {
        "web_search": 3,
        "web_fetch": 3,
    }


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


class _FakeResumeWorkflow:
    """Minimal stand-in for the temporalio ``workflow`` module symbol."""

    def __init__(self, now):
        self._now = now
        self.logger = type("L", (), {"info": lambda *a, **k: None, "warning": lambda *a, **k: None})()

    def now(self):
        return self._now

    def uuid4(self):
        return "00000000-0000-0000-0000-000000000000"


async def _run_resume(conversation, now):
    """Call _resume_interrupted_wait with module-level wait_for/workflow patched.

    Returns the tool_call dict passed to wait_for, or None if it was not called.
    """
    import workflows.agent_workflow as awf

    captured: Dict[str, Any] = {}

    async def fake_wait_for(instance, tool_call, tool_call_id):
        captured["tool_call"] = tool_call
        captured["tool_call_id"] = tool_call_id
        return ("FINISHED", "")

    orig_wait_for = awf.wait_for
    orig_workflow = awf.workflow
    awf.wait_for = fake_wait_for
    awf.workflow = _FakeResumeWorkflow(now)
    try:
        wf = _bare_workflow_instance()
        wf.agent_id = "agent-1"
        await wf._resume_interrupted_wait(conversation)
    finally:
        awf.wait_for = orig_wait_for
        awf.workflow = orig_workflow
    return captured.get("tool_call")


def _interrupted_ts_conversation(until):
    md = {
        "toolName": "wait_for",
        "waitForMode": "timestamp",
        "toolCallId": "wf-1",
        "untilTimestamp": until,
    }
    return [
        {"role": "TOOL", "text": "", "metadata": {**md, "toolStatus": "IN_PROGRESS"}},
        {"role": "TOOL", "text": "", "metadata": {**md, "toolStatus": "FINISHED", "errorCode": "DEPLOY_INTERRUPTED"}},
    ]


async def test_workflow_resume_rearms_interrupted_future_wait():
    """On deploy resume, an interrupted future wait is re-armed with resume=True."""
    now = datetime(2026, 8, 3, 12, 0, 0, tzinfo=timezone.utc)
    tool_call = await _run_resume(_interrupted_ts_conversation("2026-08-03T17:00:00Z"), now)
    assert tool_call is not None, "expected wait_for to be re-armed"
    assert tool_call.get("until_timestamp") == "2026-08-03T17:00:00Z"
    assert tool_call.get("resume") is True


async def test_workflow_resume_rearms_elapsed_wait():
    """An elapsed interrupted wait is still re-armed (resume=True → completes now)."""
    now = datetime(2026, 8, 3, 20, 0, 0, tzinfo=timezone.utc)
    tool_call = await _run_resume(_interrupted_ts_conversation("2026-08-03T17:00:00Z"), now)
    assert tool_call is not None, "elapsed interrupted wait must still be resolved"
    assert tool_call.get("until_timestamp") == "2026-08-03T17:00:00Z"
    assert tool_call.get("resume") is True


async def test_workflow_resume_noop_without_pending_wait():
    """No timestamp wait in the conversation → no re-arm."""
    now = datetime(2026, 8, 3, 12, 0, 0, tzinfo=timezone.utc)
    convo = [{"role": "TOOL", "text": "", "metadata": {"toolName": "message_person", "toolStatus": "FINISHED"}}]
    assert await _run_resume(convo, now) is None


def test_workflow_get_status_query():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.goal = "test goal"
    wf.token_count = 500
    status = wf.get_status()
    assert status == {
        "agent_id": "agent-1",
        "goal": "test goal",
        "tokens": 500,
        "tokens_in": 0,
        "tokens_out": 0,
        "context_size": 0,
        "message_count": 0,
        "iteration_offset": 0,
        "workflow_started_at": None,
    }


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
    wf._is_finished = True
    assert wf.parent_state_query() == {
        "is_paused": True,
        "is_cost_limit_reached": True,
        "is_finished": True,
        "user_pause_active": False,
    }


def test_workflow_parent_state_query_all_false():
    wf = _bare_workflow_instance()
    assert wf.parent_state_query() == {
        "is_paused": False,
        "is_cost_limit_reached": False,
        "is_finished": False,
        "user_pause_active": False,
    }


def test_workflow_format_outputs_no_schema_emits_response_keys():
    wf = _bare_workflow_instance()
    wf.output_schema = None
    outputs = wf._format_outputs({"positioning_statement": "Engineer approach", "_skip": 1})
    assert [row["key"] for row in outputs] == ["positioning_statement"]
    assert outputs[0]["label"] == "Positioning Statement"
    assert outputs[0]["value"] == "Engineer approach"


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


def test_workflow_format_outputs_field_without_name_falls_back_to_keys():
    wf = _bare_workflow_instance()
    wf.output_schema = {"fields": [{"description": "no name"}]}
    outputs = wf._format_outputs({"x": "y"})
    assert outputs == [{"key": "x", "label": "X", "value": "y"}]


def test_structured_response_from_schema_headings_parses_assemble_final():
    from workflows.agent_workflow import structured_response_from_schema_headings

    schema = {
        "fields": [
            {"name": "top_creators_analysis", "type": "list[object]"},
            {"name": "positioning_statement", "type": "str"},
            {"name": "ninety_day_content_calendar", "type": "list[object]"},
        ]
    }
    text = (
        "July Fast Mode assemble.\n\n"
        "# top_creators_analysis\n\n"
        "1. Andrew Huberman\n\n"
        "# positioning_statement\n\n"
        "Engineer approach to longevity.\n\n"
        "# ninety_day_content_calendar\n\n"
        "Week 1: sleep audit."
    )
    parsed = structured_response_from_schema_headings(text, schema)
    assert "Huberman" in parsed["top_creators_analysis"]
    assert parsed["positioning_statement"] == "Engineer approach to longevity."
    assert "sleep audit" in parsed["ninety_day_content_calendar"]


def test_structured_response_from_schema_headings_without_schema():
    from workflows.agent_workflow import structured_response_from_schema_headings

    parsed = structured_response_from_schema_headings(
        "# positioning_statement\n\nEngineer approach.\n\n# weekly_engagement_target_creators\n\nHuberman.",
        None,
    )
    assert parsed["positioning_statement"] == "Engineer approach."
    assert parsed["weekly_engagement_target_creators"] == "Huberman."


def test_workflow_coalesce_structured_response_fills_outputs_from_headings():
    wf = _bare_workflow_instance()
    wf.output_schema = {
        "fields": [
            {"name": "positioning_statement", "description": "Positioning"},
            {"name": "weekly_engagement_target_creators"},
        ]
    }
    context = [
        {
            "role": "ASSISTANT",
            "text": (
                "# positioning_statement\n\nAman as the founder-operator.\n\n"
                "# weekly_engagement_target_creators\n\nHuberman, Attia, Johnson."
            ),
        }
    ]
    merged = wf._coalesce_structured_response(context, None)
    outputs = wf._format_outputs(merged)
    assert [row["key"] for row in outputs] == [
        "positioning_statement",
        "weekly_engagement_target_creators",
    ]
    assert outputs[0]["value"] == "Aman as the founder-operator."


async def test_workflow_verifier_schema_survives_a_failed_startup_config_fetch():
    """descend-full69 MA6: 14 of 50 cloud GPs verified without their response_schema.

    On the load-starved guest, each one's startup ``fetch_agent_config`` timed
    out ("Failed to fetch agent config for response_schema"), so the workflow ran
    with no output schema: the verifier parsed the cached verdict as a plain
    ProgressScore and dropped its output, and only completion re-fetched the
    schema. Verification must load the task's schema first; an agent whose
    config fetch succeeded with no schema pays no extra fetch.
    """
    from unittest.mock import AsyncMock, MagicMock, patch

    schema = {"fields": [{"name": "creator_name", "type": "str", "required": True}]}

    failed = _bare_workflow_instance()
    failed.agent_id = "gp-khe-hy"
    failed.output_schema = None
    failed._agent_config_unavailable = True
    fetch = AsyncMock(return_value={"response_schema": schema})
    with (
        patch("workflows.agent_workflow.workflow.execute_activity", new=fetch),
        patch("workflows.agent_workflow.workflow.logger", MagicMock()),
    ):
        getter = failed._make_response_schema_getter()
        assert await getter() == schema
        assert await getter() == schema
    assert fetch.await_count == 1, "the schema is fetched once, then kept"

    healthy = _bare_workflow_instance()
    healthy.agent_id = "agent-without-schema"
    healthy.output_schema = None
    untouched = AsyncMock(return_value={"response_schema": schema})
    with (
        patch("workflows.agent_workflow.workflow.execute_activity", new=untouched),
        patch("workflows.agent_workflow.workflow.logger", MagicMock()),
    ):
        assert await healthy._make_response_schema_getter()() is None
    assert untouched.await_count == 0


async def test_workflow_schema_reload_is_one_attempt_per_turn_with_backoff():
    """descend-full69 MA6b: the getter runs every main-loop turn, not only at verification.

    While config reads keep failing, each turn retried 5 rounds of a 10 s
    activity plus 1 s sleeps (~100 s per turn, unbounded across turns), and in a
    correlated backend outage every affected agent retried in lockstep. A turn
    makes at most one read, and failures back off exponentially (bounded,
    jittered) across turns before the next read.
    """
    from datetime import datetime, timedelta, timezone
    from unittest.mock import AsyncMock, MagicMock, patch

    schema = {"fields": [{"name": "creator_name", "type": "str", "required": True}]}
    wf = _bare_workflow_instance()
    wf.agent_id = "gp-outage"
    wf.output_schema = None
    wf._agent_config_unavailable = True
    clock = {"now": datetime(2026, 10, 26, tzinfo=timezone.utc)}
    fetch = AsyncMock(side_effect=RuntimeError("activity StartToClose timeout"))
    with (
        patch("workflows.agent_workflow.workflow.execute_activity", new=fetch),
        patch("workflows.agent_workflow.workflow.logger", MagicMock()),
        patch("workflows.agent_workflow.workflow.now", side_effect=lambda: clock["now"]),
        patch("workflows.agent_workflow.workflow.random", return_value=MagicMock(random=lambda: 0.5)),
        patch("workflows.agent_workflow.asyncio.sleep", new=AsyncMock()) as sleep,
    ):
        getter = wf._make_response_schema_getter()
        assert await getter() is None
        assert fetch.await_count == 1, "one read per turn"
        assert await getter() is None
        assert fetch.await_count == 1, "no read before the backoff deadline"
        assert sleep.await_count == 0, "the turn never sleeps for the schema"

        delays = []
        for _ in range(9):
            delays.append(wf._agent_config_retry_at - clock["now"])
            clock["now"] = wf._agent_config_retry_at
            before = fetch.await_count
            assert await getter() is None
            assert fetch.await_count == before + 1
        assert all(b > a for a, b in zip(delays[:5], delays[1:6])), delays
        assert max(delays) <= timedelta(seconds=75), "bounded backoff"

        fetch.side_effect = None
        fetch.return_value = {"response_schema": schema}
        clock["now"] = wf._agent_config_retry_at
        assert await getter() == schema
        assert wf._agent_config_unavailable is False
        assert await getter() == schema
        assert fetch.await_count == 11


def test_workflow_coalesce_fills_only_values_of_the_schema_field_type():
    """descend-full69 MA5: transcript fills turned list fields into markdown strings.

    The verifier left ungrounded list fields empty ([]); the completion fill then
    took a row item's / heading's markdown text for ``hook_formulas`` (list[str]),
    so the finished output no longer satisfied its response_schema. A fill must
    match the field's declared type; untyped fields keep the old behaviour.
    """
    import json as _json

    wf = _bare_workflow_instance()
    wf.output_schema = {
        "fields": [
            {"name": "hook_formulas", "type": "list[str]"},
            {"name": "core_content_pillars", "type": "list[str]"},
            {"name": "audience_persona", "type": "str"},
            {"name": "legacy_note"},
            {"name": "positioning_statement", "type": "list[object]"},
        ]
    }
    row_item = {
        "hook_formulas": "- First-person self-experiment framing\n- 30-day challenge titles",
        "core_content_pillars": ["fitness experiments", "nutrition"],
        "legacy_note": "kept",
    }
    persona = "Ambitious 25-40 knowledge workers who want practical, evidence-led health routines. " * 3
    context = [
        {
            "role": "TOOL",
            "text": f"Row item report: {_json.dumps(row_item)}",
            "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": f"# audience_persona\n\n{persona}\n\n# positioning_statement\n\n{persona}",
            "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
        },
    ]
    merged = wf._coalesce_structured_response(context, {"hook_formulas": [], "audience_persona": ""})

    assert merged["hook_formulas"] == [], "a markdown string must not fill a list[str] field"
    assert merged["core_content_pillars"] == ["fitness experiments", "nutrition"]
    assert merged["audience_persona"].startswith("Ambitious 25-40")
    assert merged["legacy_note"] == "kept"
    # An absent key still takes report text: a demo root materializes it into a file.
    assert merged["positioning_statement"].startswith("Ambitious 25-40")


def test_workflow_coalesce_for_each_items_fills_top_creators_analysis():
    wf = _bare_workflow_instance()
    wf.output_schema = {
        "fields": [
            {"name": "top_creators_analysis"},
            {"name": "positioning_statement"},
        ]
    }
    context = [
        {
            "role": "TOOL",
            "text": "Completed for_each delegation for 50 items.",
            "metadata": {
                "toolName": "spawn_general_purpose_agent_for_each",
                "structured_response": {
                    "items": [
                        {
                            "status": "completed",
                            "structured_response": {
                                "creator_name": "Andrew Huberman",
                                "hook_formulas": ["mechanism first"],
                            },
                        }
                    ]
                },
            },
        }
    ]
    merged = wf._coalesce_structured_response(context, None)
    outputs = wf._format_outputs(merged)
    by_key = {row["key"]: row["value"] for row in outputs}
    assert by_key["top_creators_analysis"][0]["creator_name"] == "Andrew Huberman"


def test_workflow_coalesce_structured_response_from_metadata_payload():
    wf = _bare_workflow_instance()
    wf.output_schema = {
        "fields": [
            {"name": "positioning_statement"},
            {"name": "weekly_engagement_target_creators"},
        ]
    }
    context = [
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "structured_response": {
                    "positioning_statement": "Andy as the founder-operator.",
                    "weekly_engagement_target_creators": ["Huberman"],
                }
            },
        }
    ]
    merged = wf._coalesce_structured_response(context, None)
    outputs = wf._format_outputs(merged)
    assert [row["key"] for row in outputs] == [
        "positioning_statement",
        "weekly_engagement_target_creators",
    ]
    assert outputs[0]["value"] == "Andy as the founder-operator."


def test_workflow_coalesce_structured_response_without_schema_uses_headings():
    wf = _bare_workflow_instance()
    wf.output_schema = None
    context = [
        {
            "role": "ASSISTANT",
            "text": (
                "# positioning_statement\n\nAman as the founder-operator.\n\n"
                "# weekly_engagement_target_creators\n\nHuberman, Attia, Johnson."
            ),
        }
    ]
    merged = wf._coalesce_structured_response(context, None)
    outputs = wf._format_outputs(merged)
    assert [row["key"] for row in outputs] == [
        "positioning_statement",
        "weekly_engagement_target_creators",
    ]


def test_workflow_coalesce_fills_gp_outputs_from_row_item_and_explore():
    """Fast Mode GPs often lack verifier JSON; row item + explore report still fill the card."""
    from workflows.agent_workflow import card_summary_from_evidence, is_ablated_completion_summary

    wf = _bare_workflow_instance()
    wf.output_schema = {
        "fields": [
            {"name": "creator_name"},
            {"name": "rank_from_initial_list"},
            {"name": "hook_formulas"},
            {"name": "core_content_pillars"},
        ]
    }
    explore = (
        "# Casey Winters creator-brand competitive analysis\n\n"
        "Deeply researched product and growth advice for founders, with a large newsletter "
        "and a weekly interview show that stays tactical rather than motivational.\n\n"
        "## Hook formulas / title patterns\n\n"
        "Credential plus concrete playbook: 'How X grew from 0 to Y'.\n\n"
        "## Content pillars and formats across platforms\n\n"
        "Product leadership, growth loops, and career advice for builders."
    )
    context = [
        {
            "role": "USER",
            "text": (
                'You are analyzing ONE creator for Andy Prevalsky.\nRow item:\n{"name": "Casey Winters", "rank": 22}'
            ),
        },
        {
            "role": "TOOL",
            "text": explore,
            "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
        },
    ]
    merged = wf._coalesce_structured_response(context, None)
    outputs = wf._format_outputs(merged)
    by_key = {row["key"]: row["value"] for row in outputs}
    assert by_key["creator_name"] == "Casey Winters"
    assert by_key["rank_from_initial_list"] == 22
    assert "playbook" in str(by_key["hook_formulas"])
    assert "Product leadership" in str(by_key["core_content_pillars"])
    summary = card_summary_from_evidence(context, merged)
    assert not is_ablated_completion_summary(summary)
    assert "Casey" in summary or "founders" in summary
    assert "Fast Mode" not in summary
    assert len(summary) >= 200


def test_card_summary_from_evidence_uses_long_web_fetch_not_creator_name():
    """A raw fetch must yield to a finished report; its envelope must not leak."""
    from workflows.agent_workflow import card_summary_from_evidence, is_ablated_completion_summary

    fetch_body = (
        "**Params Passed:**\n\n- **url**: https://www.youtube.com/@beerbiceps\n\n"
        "**Result:**\n\n"
        "BeerBiceps / Ranveer Allahbadia posts long-form interviews on health, "
        "business, and spirituality. Recent 90-day cadence is about three YouTube "
        "uploads a week with hook formulas that pair a celebrity guest and a "
        "concrete life question. Audience promise is Indian-English self-improvement "
        "for founders and students. Monetization mentions include Superhuman and "
        "course launches. Gaps include quantified founder-health protocols and "
        "week-in-the-life operating cadence."
    )
    assert "**params passed:**" in fetch_body.lower()
    assert is_ablated_completion_summary(fetch_body)
    context = [
        {
            "role": "TOOL",
            "text": fetch_body,
            "metadata": {"toolName": "web_fetch", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": (
                "The completed creator report identifies BeerBiceps / Ranveer Allahbadia's "
                "long-form health, business, and spirituality interviews; roughly three weekly "
                "YouTube uploads; celebrity-plus-concrete-question hooks; an Indian-English "
                "founder and student audience; sponsorship and course monetization; and an "
                "opening for quantified founder-health protocols and operating-cadence stories."
            ),
            "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": "Fast Mode cache trajectory ended; prior tool evidence is sufficient.",
            "metadata": {"toolName": "attempt_completion", "toolStatus": "FINISHED"},
        },
    ]
    structured = {"creator_name": "Ranveer Allahbadia", "rank_from_initial_list": 50}
    summary = card_summary_from_evidence(context, structured)
    assert not is_ablated_completion_summary(summary)
    assert "Fast Mode" not in summary
    assert "Params Passed" not in summary
    assert "**Result:**" not in summary
    assert "Ranveer" in summary or "BeerBiceps" in summary or "founders" in summary
    assert len(summary) >= 200


def test_card_summary_from_evidence_rejects_long_cached_search_envelope():
    """A >200-char cached web envelope must yield to a real spawn-agent report."""
    from workflows.agent_workflow import card_summary_from_evidence, is_ablated_completion_summary

    cached_search = (
        "- **query**: Figure robot White House F.03 Brett Adcock interview\n\n"
        "**Result:** Search result snippets and ranking metadata repeated from the prior "
        "web_search trajectory. This intentionally exceeds two hundred characters so it "
        "covers the bug where length alone made raw tool evidence look like a real Task "
        "Complete summary even though the card exposed query and result plumbing."
    )
    real_report = (
        "Brett Adcock's creator analysis was completed with verified channel URLs, a "
        "weekly posting cadence, repeatable robotics-demo hook formulas, core founder and "
        "automation content pillars, audience positioning, monetization paths, recent "
        "high-performing pieces, gaps, engagement opportunities, and source citations. "
        "The finished dossier gives Andy a grounded competitive reference for founder-led "
        "technical storytelling and launch content."
    )
    context = [
        {
            "role": "TOOL",
            "text": cached_search,
            "metadata": {"toolName": "web_search", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": real_report,
            "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
        },
        {
            "role": "TOOL",
            "text": "Fast Mode cache trajectory ended; prior tool evidence is sufficient.",
            "metadata": {"toolName": "attempt_completion", "toolStatus": "FINISHED"},
        },
    ]

    assert is_ablated_completion_summary(cached_search)
    assert not is_ablated_completion_summary("Fast Mode cache trajectory ended; prior tool evidence is sufficient.")
    summary = card_summary_from_evidence(context, {"creator_name": "Brett Adcock"})
    assert not is_ablated_completion_summary(summary)
    assert "Brett Adcock" in summary
    assert "**query**" not in summary


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

    def info(self, msg, *args):
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

    def __init__(self):
        self.logger = _FakeWorkflowLogger()
        self.activity_calls: List[tuple] = []  # (fn_name, args)
        self.signal_calls: List[tuple] = []  # (wf_id, name, data)
        self.activity_fail_for: set = set()  # fn_names that should raise
        self.activity_returns: Dict[str, Any] = {}  # fn_name -> return value override
        self.activity_blockers: Dict[str, asyncio.Event] = {}
        self.now_value = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

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

    def patched(self, _patch_id: str) -> bool:
        return True

    def info(self):
        class _Info:
            task_queue = "navi-agent-tasks@testgen"

        return _Info()


def _patch_workflow(fake: _FakeWorkflowModule):
    """Swap workflows.agent_workflow.workflow with a fake; returns original."""
    import workflows.agent_workflow as m

    original = m.workflow
    m.workflow = fake
    return original


def _restore_workflow(original):
    import workflows.agent_workflow as m

    m.workflow = original


async def test_pause_episode_preserves_user_intent_across_automatic_signals():
    from pause_control_provenance import prove_pause_episode_ordering
    await prove_pause_episode_ordering()


async def test_pause_intent_ends_with_recovered_episode():
    from unittest.mock import AsyncMock
    wf = _bare_workflow_instance()
    wf.agent_id = "pause-episode"
    wf._update_tree_state = AsyncMock()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.pause()
        assert wf._user_pause_active
        await wf.price_limit_increased({"new_limit_cents": 100})
        assert not wf.is_paused and not wf._user_pause_active, "B2: price recovery retained old intent"
        await wf.cost_limit_reached()
        assert wf.is_paused and not wf._user_pause_active, "B2: automatic stop inherited old user intent"
        # A stale marker in a restored ACTIVE snapshot is not a live pause episode.
        state = _deployment_resume_fixture("ACTIVE")
        state["runtime_state"] = {"user_pause_active": True}
        wf._restore_deployment_state(state)
        assert not wf.is_paused and not wf._user_pause_active
        wf._user_pause_active = True
        wf._apply_deployment_control_state({"status": "ACTIVE"})
        assert not wf._user_pause_active
        # The parent's explicit cause is inherited, never inferred from pause alone.
        for explicit in (False, True):
            wf.parent_workflow_id = "parent"
            wf.is_paused = False
            wf._paused_by_parent = False
            wf._query_parent_state = AsyncMock(return_value={"is_paused": True, "user_pause_active": explicit})
            await wf._check_parent_state()
            assert wf.is_paused and wf._user_pause_active is explicit
        # Parent recovery and orphan recovery also end inherited pause intent.
        for parent_state in ({"is_paused": False, "is_cost_limit_reached": False}, {"parent_missing": True}):
            wf.parent_workflow_id = "parent"
            wf._orphaned = False
            wf._paused_by_parent = True
            wf.is_paused = True
            wf._user_pause_active = True
            wf._query_parent_state = AsyncMock(return_value=parent_state)
            await wf._check_parent_state()
            assert not wf.is_paused and not wf._user_pause_active
        # The transient-parent orphan exit and one-shot budget wrap-up also unpause.
        import workflows.agent_workflow as module
        wf._orphaned = False
        wf._paused_by_parent = True
        wf.is_paused = True
        wf._user_pause_active = True
        wf._parent_query_failures_while_paused = module._ORPHAN_TRANSIENT_FAILURE_LIMIT - 1
        wf._query_parent_state = AsyncMock(return_value={})
        await wf._check_parent_state()
        assert not wf.is_paused and not wf._user_pause_active
        wf._cost_limit_reached = True
        wf._paused_by_parent = False
        wf.is_paused = True
        wf._user_pause_active = True
        wf.price_limit_cents = 10
        wf.subtree_cost_cents = 11
        wf._maybe_arm_cost_limit_wrapup_after_browser(tool_name="spawn_browser_agent", result={"success": True},
            paused_before=False, cost_limit_before=False)
        assert not wf.is_paused and not wf._user_pause_active
    finally:
        _restore_workflow(original)


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
        assert wf._user_pause_active is True
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
        # A user pause cascades with no argument, exactly as before the cause
        # parameter existed: a child still on a draining older generation defines
        # `pause(self)` and would fail its workflow task on any argument.
        assert all(s[2] is None for s in cascaded), cascaded
    finally:
        _restore_workflow(original)

    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    wf.pending_children = {"c1"}
    wf.child_workflow_ids = {"c1": "wfc1"}
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.pause("subscription")
        # Only the cause-aware backend produces a non-user cause; children keep it.
        assert [s for s in fake.signal_calls if s[1] == "pause"] == [("wfc1", "pause", "subscription")]
    finally:
        _restore_workflow(original)


async def test_workflow_signal_resume_clears_paused_flag():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    wf.is_paused = True
    wf._user_pause_active = True
    wf._paused_by_parent = True
    # No parent_workflow_id -> resume shouldn't be blocked
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.resume()
        assert wf.is_paused is False
        assert wf._user_pause_active is False
        assert wf._paused_by_parent is False
    finally:
        _restore_workflow(original)


async def test_workflow_out_of_credits_resume_requires_fresh_credits():
    """A migrated credit pause resumes only after the backend confirms new credit."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-credit-cold"
    wf.user_id = "user-credit-cold"
    wf._restore_deployment_state(_deployment_resume_fixture("OUT_OF_CREDITS"))
    fake = _FakeWorkflowModule()
    fake.activity_returns["check_user_usage"] = {"has_credits": False}
    original = _patch_workflow(fake)
    try:
        await wf.resume()
        assert wf.is_paused is True
        assert wf._has_credits is False

        fake.activity_returns["check_user_usage"] = {"has_credits": True}
        await wf.resume()
        assert wf.is_paused is False
        assert wf._has_credits is True
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


async def test_workflow_user_message_alone_never_lifts_a_pause():
    """The backend must follow a user's message with `resume` (prod agent 5c8b0ca4)."""
    wf = _bare_workflow_instance()
    wf.goal = "g"
    wf.is_paused = True
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Skip DoorDash entirely. Buy from Amazon instead.")
        assert wf.is_paused is True
        assert wf._has_new_messages is True
        await wf.resume()
        assert wf.is_paused is False
        assert wf._has_new_messages is True
    finally:
        _restore_workflow(original)


async def test_workflow_signal_receive_user_response_with_request_id():
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response(json.dumps({"request_id": "req-123", "response": "yes"}))
        assert wf._signal_responses.get("req-123") == "yes"
        assert wf._has_new_messages is True
        assert wf._response_schema_feedback == ["yes"]
        assert wf._response_schema_revision == 1
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


async def test_workflow_signal_control_reply_does_not_refresh_schema():
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        for index, response in enumerate(
            [
                "__AUTH_ASSISTANCE_COMPLETED__",
                "__REJECTED__",
                "RESOLVED",
                "SOURCE_CONNECTED",
                "SUBSCRIPTION_ACTIVE",
                "",
                None,
            ]
        ):
            request_id = f"control-request-{index}"
            await wf.receive_user_response(json.dumps({"request_id": request_id, "response": response}))
            assert wf._signal_responses[request_id] == response

        assert wf._has_new_messages is False
        assert wf._response_schema_feedback == []
        assert wf._response_schema_revision == 0
        assert not any(call[0] == "set_response_schema_activity" for call in fake.activity_calls)
    finally:
        _restore_workflow(original)


async def test_workflow_signal_normalized_controls_do_not_refresh_schema():
    controls = [
        "  __REJECTED__\n",
        "\t__AUTH_ASSISTANCE_COMPLETED__  ",
        " RESOLVED ",
        " SOURCE_CONNECTED\n",
        " SUBSCRIPTION_ACTIVE ",
        "",
        " \n",
    ]
    for keyed in (True, False):
        wf = _bare_workflow_instance()
        fake = _FakeWorkflowModule()
        original = _patch_workflow(fake)
        try:
            for index, response in enumerate(controls):
                value = json.dumps({"request_id": str(index), "response": response}) if keyed else response
                await wf.receive_user_response(value)
                assert wf._response_schema_feedback == [], "control or empty input became schema feedback"
                assert wf._response_schema_revision == 0
                if keyed:
                    assert wf._signal_responses[str(index)] == response
                else:
                    assert wf._last_signal_response == response
            genuine = "  Also return venue prices.\n"
            value = json.dumps({"request_id": "user", "response": genuine}) if keyed else genuine
            await wf.receive_user_response(value)
            assert wf._response_schema_feedback == [genuine], "genuine user text was changed"
            assert wf._response_schema_revision == 1
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
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        feedback = "Output schema revised from user feedback.\nBut this was typed by the user"
        await wf.receive_user_response(feedback)

        assert wf._has_new_messages is True
        assert wf._response_schema_feedback == [feedback]
        assert wf._response_schema_revision == 1
    finally:
        _restore_workflow(original)


def _user_schema_refresh_fixture():
    wf = _bare_workflow_instance()
    wf.agent_id = "schema-feedback-agent"
    wf.user_id = "schema-feedback-user"
    wf.goal = "Research three venues"
    wf.demo_cache_goal = wf.goal
    wf.current_phase = "EXECUTE"
    wf.user_context_section = ""
    wf._cloud_agent_lifecycle_finished = True
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
    wf._response_schema_initialized = True
    replacement = {
        "fields": [
            {"name": "venues", "type": "list[str]", "required": True},
            {"name": "venue_prices", "type": "list[int]", "required": True},
        ],
    }
    fake = _FakeWorkflowModule()
    fake.activity_returns["set_response_schema_activity"] = {
        "schema": replacement,
        "usage": {},
    }
    return wf, fake, replacement


async def test_workflow_legacy_approval_protocol_does_not_change_requirements():
    """Legacy approval producers have no authored-message field on the wire."""
    for value in ("approve", "Approved", " \tApPrOvEd\n"):
        for keyed in (False, True):
            wf, fake, _replacement = _user_schema_refresh_fixture()
            wf._response_schema_initialized = False
            original = _patch_workflow(fake)
            try:
                signal = json.dumps({"request_id": "approval-1", "response": value}) if keyed else value
                await wf.receive_user_response(signal)
                assert wf._response_schema_revision == 0, "approval protocol superseded a genuine verifier"
                assert wf._response_schema_feedback == []
                if keyed:
                    assert wf._signal_responses["approval-1"] == value
                else:
                    assert wf._last_signal_response == value and wf._has_new_messages
                assert not fake.activity_calls
            finally:
                _restore_workflow(original)


async def test_workflow_authored_approval_words_remain_actual_requirements():
    """Signal protocol exclusion must not become a classifier of USER text."""
    for value in ("approve", " \tApPrOvEd\n", "Approve and use Andy's account"):
        for durable in (False, True):
            wf, fake, _replacement = _user_schema_refresh_fixture()
            wf._response_schema_initialized = False
            original = _patch_workflow(fake)
            try:
                if durable:
                    wf.context = [{"id": "actual-user-row", "role": "USER", "text": value, "metadata": None}]
                    wf._admit_durable_response_schema_feedback()
                    wf._admit_durable_response_schema_feedback()
                else:
                    await wf.receive_user_response(
                        json.dumps(
                            {
                                "request_id": "actual-authored-approval",
                                "response": "RESOLVED",
                                "user_message": value,
                            }
                        )
                    )
                assert wf._response_schema_feedback == [value], "actual authored bytes were excluded or normalized"
                assert wf._response_schema_revision == 1
            finally:
                _restore_workflow(original)


async def test_workflow_keyed_user_message_updates_native_schema_without_injection():
    wf, fake, replacement = _user_schema_refresh_fixture()
    feedback = "Also include the price for each venue"
    wf.context = [
        {"role": "USER", "text": wf.goal, "metadata": None},
        {"role": "USER", "text": feedback, "metadata": None},
    ]
    original_context = json.dumps(wf.context, sort_keys=True)
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response(json.dumps({"request_id": "auth-request", "response": feedback}))
        await wf._wait_for_response_schema_refresh()

        assert wf._signal_responses["auth-request"] == feedback
        assert wf.output_schema == replacement, "keyed real user feedback left the output schema stale"
        assert json.dumps(wf.context, sort_keys=True) == original_context
        assert await wf._make_response_schema_getter()() == replacement
        assert "venue_prices" in await wf.build_system_prompt()
        assert not any(call[0] == "post_agent_message" and call[1][2] == "USER" for call in fake.activity_calls), (
            "schema refresh fabricated a USER message"
        )
    finally:
        _restore_workflow(original)


async def test_workflow_keyed_authored_message_refreshes_schema_separately_from_control():
    feedback = "  Include the price for each venue.\nKeep this authored text unchanged.  "
    for control in ("__REJECTED__", "RESOLVED", "__AUTH_ASSISTANCE_COMPLETED__"):
        wf, fake, replacement = _user_schema_refresh_fixture()
        original = _patch_workflow(fake)
        try:
            await wf.receive_user_response(
                json.dumps(
                    {
                        "request_id": "authored-control",
                        "response": control,
                        "user_message": feedback,
                    }
                )
            )
            await wf._wait_for_response_schema_refresh()
            assert wf._signal_responses["authored-control"] == control, "authored input overwrote the gate protocol"
            assert wf._response_schema_feedback == [feedback], "protocol reply dropped or rewrote actual user input"
            assert wf.output_schema == replacement, "authored input beside a protocol reply left the root schema stale"
            generation = [call for call in fake.activity_calls if call[0] == "set_response_schema_activity"]
            assert len(generation) == 1 and feedback in generation[0][1][1]
            assert not any(call[0] == "post_agent_message" and call[1][2] == "USER" for call in fake.activity_calls), (
                "schema refresh invented a USER row"
            )
        finally:
            _restore_workflow(original)


async def test_workflow_explicit_protocol_only_reply_does_not_refresh_schema():
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        for control in ("Approved", "Message sent via Mac app ✅", "Authentication complete"):
            await wf.receive_user_response(
                json.dumps(
                    {
                        "request_id": "protocol-only",
                        "response": control,
                        "user_message": None,
                    }
                )
            )
            assert wf._signal_responses["protocol-only"] == control
        assert wf._response_schema_revision == 0 and wf._response_schema_feedback == []
        assert wf._has_new_messages is False and fake.activity_calls == []
        legacy = "Also include entry notes."
        await wf.receive_user_response(json.dumps({"request_id": "legacy", "response": legacy}))
        assert wf._response_schema_feedback == [legacy]
        assert wf._signal_responses["legacy"] == legacy
    finally:
        _restore_workflow(original)


async def test_workflow_keyed_rejection_admits_already_polled_durable_feedback():
    wf, fake, replacement = _user_schema_refresh_fixture()
    wf.context = [
        {"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-14T17:21:00Z"},
        {
            "id": "rejection-feedback",
            "role": "USER",
            "text": "Use the shared account and include venue prices",
            "timestamp": "2026-10-14T17:28:00Z",
        },
    ]
    before = json.dumps(wf.context, sort_keys=True)
    fake.activity_returns["poll_new_messages"] = []
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response(json.dumps({"request_id": "rejected-request", "response": "__REJECTED__"}))
        await wf._wait_for_response_schema_refresh()
        assert wf._signal_responses["rejected-request"] == "__REJECTED__"
        assert wf.output_schema == replacement, "keyed rejection ignored its already-polled durable USER correction"
        assert json.dumps(wf.context, sort_keys=True) == before, "rejection intake manufactured context"
        assert wf._response_schema_revision == 1
        wf.max_iterations = 30
        wf.context_gates = {}
        resumed = _bare_workflow_instance()
        resumed._restore_deployment_state(wf._continuation_resume_state(wf.context))
        resumed.agent_id = wf.agent_id
        resumed.goal = wf.goal
        resumed.demo_cache_goal = wf.goal
        await resumed.receive_user_response(json.dumps({"request_id": "rejected-request", "response": "__REJECTED__"}))
        await resumed._wait_for_response_schema_refresh()
        assert resumed._response_schema_revision == 1, "continue-as-new admitted the same durable correction twice"
    finally:
        _restore_workflow(original)


async def test_workflow_keyed_rejection_polls_durable_user_feedback_without_schema_narration():
    wf, fake, replacement = _user_schema_refresh_fixture()
    wf.context = [{"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-14T17:21:00Z"}]
    correction = {
        "id": "correction",
        "role": "USER",
        "text": "Also include venue prices",
        "timestamp": "2026-10-14T17:28:00Z",
    }
    fake.activity_returns["poll_new_messages"] = [correction]
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response(json.dumps({"request_id": "rejected-request", "response": "__REJECTED__"}))
        await wf._wait_for_response_schema_refresh()
        assert wf.output_schema == replacement, "keyed rejection did not poll/admit the durable USER correction"
        assert correction in wf.context
        assert not any(call[0] == "post_agent_message" and call[1][2] == "USER" for call in fake.activity_calls)
    finally:
        _restore_workflow(original)


async def _assert_keyed_rejection_waiter_orders_feedback(*, poll_fails: bool):
    wf, fake, replacement = _user_schema_refresh_fixture()
    request_id = "ordered-rejection"
    correction = {
        "id": "ordered-correction",
        "role": "USER",
        "text": "  Use Andy's shared account.\nInclude venue prices.  ",
        "timestamp": "2026-10-14T17:28:00Z",
        "metadata": {"source": "attention_response", "attentionRequestId": request_id},
    }
    wf.context = [{"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-14T17:21:00Z"}]
    unblock_poll = asyncio.Event()
    fake.activity_blockers["poll_new_messages"] = unblock_poll
    fake.activity_returns["poll_new_messages"] = [correction]
    if poll_fails:
        fake.activity_fail_for.add("poll_new_messages")
    original = _patch_workflow(fake)

    async def await_request_response():
        # Same request-scoped predicate used by the approval wait_condition.
        while request_id not in wf._signal_responses:
            await asyncio.sleep(0)
        return wf._signal_responses[request_id], list(wf._response_schema_feedback), wf._response_schema_revision

    signal_task = asyncio.create_task(
        wf.receive_user_response(
            json.dumps(
                {
                    "request_id": request_id,
                    "response": "__REJECTED__",
                }
            )
        )
    )
    waiter = asyncio.create_task(await_request_response())
    try:
        for _ in range(20):
            if any(call[0] == "poll_new_messages" for call in fake.activity_calls):
                break
            await asyncio.sleep(0)
        assert any(call[0] == "poll_new_messages" for call in fake.activity_calls), (
            "rejection did not reach its durable poll"
        )
        await asyncio.sleep(0)
        assert not signal_task.done(), "durable poll was not blocked"
        assert request_id not in wf._signal_responses and not waiter.done(), (
            "request-scoped waiter consumed rejection before durable feedback admission"
        )
        unblock_poll.set()
        if poll_fails:
            try:
                await signal_task
                raise AssertionError("failed durable poll was hidden")
            except RuntimeError as error:
                assert str(error) == "poll_new_messages failed"
            await asyncio.sleep(0)
            assert request_id not in wf._signal_responses and not waiter.done(), "failed intake published the rejection"
            assert wf._response_schema_revision == 0 and wf._response_schema_feedback == []
        else:
            await signal_task
            response, feedback, revision = await waiter
            assert response == "__REJECTED__"
            assert feedback == [correction["text"]] and revision == 1, (
                "waiter observed rejection before its authored revision"
            )
            await wf._wait_for_response_schema_refresh()
            assert wf.output_schema == replacement
            assert correction in wf.context
            await wf.receive_user_response(json.dumps({"request_id": request_id, "response": "__REJECTED__"}))
            assert wf._response_schema_revision == 1, "retry admitted the same attention event twice"
        assert not any(call[0] == "post_agent_message" and call[1][2] == "USER" for call in fake.activity_calls)
    finally:
        unblock_poll.set()
        for task in (signal_task, waiter):
            if not task.done():
                task.cancel()
        await asyncio.gather(signal_task, waiter, return_exceptions=True)
        _restore_workflow(original)


async def test_workflow_keyed_rejection_waiter_releases_after_feedback_admission():
    await _assert_keyed_rejection_waiter_orders_feedback(poll_fails=False)


async def test_workflow_failed_rejection_intake_does_not_release_waiter():
    await _assert_keyed_rejection_waiter_orders_feedback(poll_fails=True)


def _rejection_poll_activity_error(cause=None):
    from temporalio.exceptions import ActivityError, ApplicationError, RetryState

    error = ActivityError(
        "durable USER poll exhausted retries",
        scheduled_event_id=11,
        started_event_id=12,
        identity="test-worker",
        activity_type="poll_new_messages",
        activity_id="poll-user-input",
        retry_state=RetryState.MAXIMUM_ATTEMPTS_REACHED,
    )
    error.__cause__ = cause or ApplicationError("message store unavailable", type="MessageReadUnavailable")
    return error


async def _exercise_rejection_poll_failure_custody(*, existing_feedback):
    wf, fake, _ = _user_schema_refresh_fixture()
    wf._response_schema_initialized = False
    request_id = "poll-unavailable-rejection"
    correction = {
        "id": "deferred-rejection-input",
        "role": "USER",
        "text": "  Keep the shared account.\nReturn venue prices.  ",
        "timestamp": "2026-10-15T01:01:00Z",
        "metadata": {"source": "attention_response", "attentionRequestId": request_id},
    }
    wf.context = (
        [{"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-15T01:00:00Z"}, correction]
        if existing_feedback
        else []
    )
    original_context = list(wf.context)
    fake.activity_returns["poll_new_messages"] = [correction]
    native_execute = fake.execute_activity
    fail_poll = True

    async def execute(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "poll_new_messages" and fail_poll:
            fake.activity_calls.append(("poll_new_messages", args))
            raise _rejection_poll_activity_error()
        return await native_execute(fn, args=args, **kwargs)

    fake.execute_activity = execute
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response(json.dumps({"request_id": request_id, "response": "__REJECTED__"}))
        assert wf._signal_responses[request_id] == "__REJECTED__", (
            "exhausted optional read lost the request-scoped rejection"
        )
        assert wf.context == original_context, "failed read fabricated or rewrote a USER row"
        assert wf._response_schema_feedback == ([correction["text"]] if existing_feedback else []), (
            "failed read lost already-known authored input or invented unavailable feedback"
        )
        assert wf._response_schema_revision == (1 if existing_feedback else 0)
        assert not any(name == "post_agent_message" for name, _args in fake.activity_calls)
        fail_poll = False
        await wf._poll_messages(datetime.fromtimestamp(0, tz=timezone.utc))
        await wf._poll_messages(datetime.fromtimestamp(0, tz=timezone.utc))
        assert wf._response_schema_feedback == [correction["text"]]
        assert wf._response_schema_revision == 1, (
            "later successful polling repeated or lost the deferred authored event"
        )
        assert sum(row.get("id") == correction["id"] for row in wf.context) == 1
    finally:
        _restore_workflow(original)


async def test_workflow_rejection_activity_read_failure_preserves_known_feedback_and_response():
    await _exercise_rejection_poll_failure_custody(existing_feedback=True)


async def test_workflow_rejection_activity_read_failure_defers_unknown_feedback_once():
    await _exercise_rejection_poll_failure_custody(existing_feedback=False)


async def test_workflow_rejection_read_does_not_swallow_cancellation_or_generation_fence():
    from temporalio.exceptions import ApplicationError, CancelledError as TemporalCancelledError
    from helpers.generation_handoff import GenerationHandoffRequested
    from helpers.workflow_generation import WorkflowGenerationSealed

    for failure in (
        asyncio.CancelledError(),
        WorkflowGenerationSealed("replaced generation"),
        GenerationHandoffRequested("replacement-queue"),
        _rejection_poll_activity_error(TemporalCancelledError("poll was cancelled")),
        _rejection_poll_activity_error(ApplicationError("replaced generation", type="WorkflowGenerationSealed")),
        _rejection_poll_activity_error(ApplicationError("handoff requested", type="GenerationHandoffRequested")),
    ):
        wf, fake, _ = _user_schema_refresh_fixture()
        wf._response_schema_initialized = False

        async def execute(fn, args=None, **kwargs):
            raise failure

        fake.execute_activity = execute
        original = _patch_workflow(fake)
        try:
            try:
                await wf.receive_user_response(
                    json.dumps({"request_id": "cancelled-rejection", "response": "__REJECTED__"})
                )
            except BaseException as observed:
                assert observed is failure, "lifecycle failure was replaced with another error"
            else:
                raise AssertionError("cancelled or fenced poll falsely published a successful rejection intake")
            assert "cancelled-rejection" not in wf._signal_responses
            assert wf.context == [] and wf._response_schema_feedback == []
        finally:
            _restore_workflow(original)


async def test_workflow_schema_requirements_preserve_distinct_durable_reversions():
    wf, fake, _replacement = _user_schema_refresh_fixture()
    rows = [
        {"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-14T17:21:00Z"},
        {"id": "a1", "role": "USER", "text": "Use Andy's account", "timestamp": "2026-10-14T17:22:00Z"},
        {"id": "b", "role": "USER", "text": "Use Tamara's account", "timestamp": "2026-10-14T17:23:00Z"},
        {"id": "a2", "role": "USER", "text": "Use Andy's account", "timestamp": "2026-10-14T17:24:00Z"},
    ]
    wf.context = list(rows)
    fake.activity_returns["poll_new_messages"] = rows
    original = _patch_workflow(fake)
    try:
        requirements = await wf._response_schema_user_messages()
        assert requirements[-3:] == [row["text"] for row in rows[1:]], (
            "schema intake deduplicated a distinct USER reversion by text instead of durable identity"
        )
    finally:
        _restore_workflow(original)


def _attention_authored_row(request_id, text, index):
    return {
        "id": f"attention-row-{index}",
        "role": "USER",
        "text": text,
        "timestamp": f"2026-10-14T17:2{index}:00Z",
        "metadata": {"source": "attention_response", "attentionRequestId": request_id},
    }


async def _deliver_authored_attention_signal(wf, request_id, text):
    await wf.receive_user_response(json.dumps({"request_id": request_id, "response": text, "user_message": text}))
    await wf._wait_for_response_schema_refresh()


async def test_workflow_attention_row_before_signal_is_one_requirement_event():
    wf, fake, _replacement = _user_schema_refresh_fixture()
    wf.context = [{"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-14T17:20:00Z"}]
    row = _attention_authored_row("request-A", "Also report venue prices", 1)
    fake.activity_returns["poll_new_messages"] = [row]
    original = _patch_workflow(fake)
    try:
        await wf._poll_messages(datetime.fromtimestamp(0, timezone.utc))
        await wf._wait_for_response_schema_refresh()
        assert wf._response_schema_revision == 1
        await _deliver_authored_attention_signal(wf, "request-A", row["text"])
        assert wf._response_schema_revision == 1, (
            "the durable attention row and its keyed signal generated two revisions"
        )
        assert len([call for call in fake.activity_calls if call[0] == "set_response_schema_activity"]) == 1
    finally:
        _restore_workflow(original)


async def test_workflow_attention_signal_does_not_consume_another_identical_event_row():
    wf, fake, _replacement = _user_schema_refresh_fixture()
    wf.context = [{"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-14T17:20:00Z"}]
    text = "Also report venue prices"
    original = _patch_workflow(fake)
    try:
        await _deliver_authored_attention_signal(wf, "request-A", text)
        fake.activity_returns["poll_new_messages"] = [_attention_authored_row("request-B", text, 2)]
        await wf._poll_messages(datetime.fromtimestamp(0, timezone.utc))
        await wf._wait_for_response_schema_refresh()
        assert wf._response_schema_revision == 2, (
            "text matching attributed a distinct attention event to an older pending signal"
        )
        fake.activity_returns["poll_new_messages"] += [_attention_authored_row("request-A", text, 1)]
        await wf._poll_messages(datetime.fromtimestamp(0, timezone.utc))
        await wf._wait_for_response_schema_refresh()
        assert wf._response_schema_revision == 2, "the signal's own late row was admitted again"
    finally:
        _restore_workflow(original)


async def test_workflow_attention_distinct_a_b_a_events_preserve_chronology_once():
    wf, fake, _replacement = _user_schema_refresh_fixture()
    wf.context = [{"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-14T17:20:00Z"}]
    texts = ["Use Andy's account", "Use Tamara's account", "Use Andy's account"]
    rows = []
    original = _patch_workflow(fake)
    try:
        for index, text in enumerate(texts, 1):
            request_id = f"request-{index}"
            row = _attention_authored_row(request_id, text, index)
            if index == 2:
                await _deliver_authored_attention_signal(wf, request_id, text)
            rows.append(row)
            fake.activity_returns["poll_new_messages"] = list(rows)
            await wf._poll_messages(datetime.fromtimestamp(0, timezone.utc))
            await wf._wait_for_response_schema_refresh()
            if index != 2:
                await _deliver_authored_attention_signal(wf, request_id, text)
        assert wf._response_schema_revision == 3, (
            "transport copies changed the revision count for three authored events"
        )
        assert wf._response_schema_feedback == texts
        assert (await wf._response_schema_user_messages())[-3:] == texts
    finally:
        _restore_workflow(original)


async def test_workflow_attention_event_ledger_survives_continue_as_new():
    wf, fake, _replacement = _user_schema_refresh_fixture()
    wf.context = [{"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-14T17:20:00Z"}]
    text = "Also report venue prices"
    original = _patch_workflow(fake)
    try:
        await _deliver_authored_attention_signal(wf, "request-A", text)
        row = _attention_authored_row("request-A", text, 1)
        fake.activity_returns["poll_new_messages"] = [row]
        await wf._poll_messages(datetime.fromtimestamp(0, timezone.utc))
        await wf._wait_for_response_schema_refresh()
        wf.max_iterations = 30
        wf.context_gates = {}
        resumed = _bare_workflow_instance()
        resumed._restore_deployment_state(wf._continuation_resume_state(wf.context))
        resumed.agent_id, resumed.goal, resumed.demo_cache_goal = wf.agent_id, wf.goal, wf.goal
        # A producer retry can redeliver the same event under another Message ID.
        fake.activity_returns["poll_new_messages"] = [{**row, "id": "retry-message-id"}]
        await resumed._poll_messages(datetime.fromtimestamp(0, timezone.utc))
        await resumed._wait_for_response_schema_refresh()
        await _deliver_authored_attention_signal(resumed, "request-A", text)
        assert resumed._response_schema_revision == 1, "continued workflow forgot the accepted attention event identity"
        assert resumed._response_schema_feedback == [text]
    finally:
        _restore_workflow(original)


async def test_workflow_attention_duplicate_physical_rows_in_one_batch_are_one_event():
    wf, fake, _replacement = _user_schema_refresh_fixture()
    wf.context = [{"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-14T17:20:00Z"}]
    row = _attention_authored_row("request-A", "Also report venue prices", 1)
    retry = {**row, "id": "attention-row-retry"}
    fake.activity_returns["poll_new_messages"] = [row, retry]
    original = _patch_workflow(fake)
    try:
        await wf._poll_messages(datetime.fromtimestamp(0, timezone.utc))
        await wf._wait_for_response_schema_refresh()
        assert wf._response_schema_revision == 1, (
            "two physical rows for one attention event created two revisions in one batch"
        )
        assert wf._response_schema_feedback == [row["text"]]
        assert ("attention_response", "request-A") in wf._response_schema_feedback_rows
        assert (await wf._response_schema_user_messages()).count(row["text"]) == 1
    finally:
        _restore_workflow(original)


async def test_workflow_browser_targeted_row_is_not_owner_schema_feedback():
    """A Browser-composer row (browserTaskId + excludeFromModel) is that browser's input only."""
    wf, fake, _replacement = _user_schema_refresh_fixture()
    goal = {"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-14T17:20:00Z"}
    row = {
        "id": "to-browser",
        "role": "USER",
        "text": "go to instacart instead",
        "timestamp": "2026-10-14T17:21:00Z",
        "metadata": {"browserTaskId": "task-1", "excludeFromModel": True},
    }
    wf.context = [goal, row]
    fake.activity_returns["poll_new_messages"] = [goal, row]
    original = _patch_workflow(fake)
    try:
        requirements = await wf._response_schema_user_messages()
        assert row["text"] not in requirements, "a browser-addressed row became the owner's schema feedback"
        assert wf.goal in requirements
    finally:
        _restore_workflow(original)


async def test_workflow_attention_authored_control_word_is_real_feedback_verbatim():
    wf, fake, _replacement = _user_schema_refresh_fixture()
    wf.context = [{"id": "goal", "role": "USER", "text": wf.goal, "timestamp": "2026-10-14T17:20:00Z"}]
    text = "  RESOLVED\n"
    row = _attention_authored_row("authored-control-word", text, 1)
    fake.activity_returns["poll_new_messages"] = [row]
    original = _patch_workflow(fake)
    try:
        await wf._poll_messages(datetime.fromtimestamp(0, timezone.utc))
        await wf._wait_for_response_schema_refresh()
        assert wf._response_schema_revision == 1, (
            "a protocol control word in an explicitly authored USER event was discarded"
        )
        assert wf._response_schema_feedback == [text], "authored bytes were normalized before admission"
        assert (await wf._response_schema_user_messages())[-1] == text, (
            "schema intake normalized explicitly authored bytes"
        )
        wf._record_response_schema_feedback(text, request_id="authored-control-word")
        assert wf._response_schema_revision == 1
        await wf.receive_user_response(
            json.dumps({"request_id": "protocol-only", "response": "RESOLVED", "user_message": None})
        )
        await wf.receive_user_response(json.dumps({"request_id": "legacy-control", "response": "RESOLVED"}))
        assert wf._response_schema_revision == 1, "protocol-only or legacy control transport became authored feedback"
    finally:
        _restore_workflow(original)


async def test_workflow_schema_change_updates_native_contract_without_user_row():
    wf, fake, replacement = _user_schema_refresh_fixture()
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Also include venue prices")
        await wf._wait_for_response_schema_refresh()

        assert wf.output_schema == replacement
        assert "venue_prices" in await wf.build_system_prompt(), "actor retained the old native schema"
        assert not any(call[0] == "post_agent_message" and call[1][2] == "USER" for call in fake.activity_calls), (
            "schema refresh fabricated a USER message"
        )
    finally:
        _restore_workflow(original)


async def test_workflow_new_instruction_schema_uses_native_state_without_user_row():
    wf, fake, replacement = _user_schema_refresh_fixture()
    followup = "Research venue prices"
    original = _patch_workflow(fake)
    try:
        await wf._regenerate_output_schema_for_new_instruction(
            [
                {"role": "USER", "text": followup, "metadata": None},
            ]
        )

        assert wf.output_schema == replacement
        assert "venue_prices" in await wf.build_system_prompt()
        assert not any(call[0] == "post_agent_message" and call[1][2] == "USER" for call in fake.activity_calls), (
            "new-instruction schema regeneration fabricated a USER message"
        )
    finally:
        _restore_workflow(original)


async def test_workflow_refreshes_response_schema_from_user_feedback():
    """Schema refresh stays asynchronous and updates the next native contract."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.goal = "Research three venues"
    wf.demo_cache_goal = "Research three venues"
    wf.current_phase = "EXECUTE"
    wf.user_context_section = ""
    wf._cloud_agent_lifecycle_finished = True
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
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
        # must complete immediately with the last accepted native schema.
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
        assert schema_messages == []

        revised_prompt = await wf.build_system_prompt()
        assert "venue_prices" in revised_prompt
        assert revised_prompt != prompt
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
    wf.demo_cache_goal = "Research three venues"
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
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
    wf.demo_cache_goal = wf.goal
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
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


async def test_workflow_schema_getter_refuses_old_contract_after_generation_failure():
    wf, fake, _replacement = _user_schema_refresh_fixture()
    previous_schema = wf.output_schema
    fake.activity_fail_for.add("set_response_schema_activity")
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Also include venue prices")
        try:
            await wf._wait_for_response_schema_refresh()
        except RuntimeError as error:
            assert "set_response_schema_activity failed" in str(error)
        try:
            await wf._make_response_schema_getter()()
        except RuntimeError as error:
            assert "set_response_schema_activity failed" in str(error)
        else:
            raise AssertionError("the schema getter certified the old contract after the latest generation failed")
        assert wf.output_schema == previous_schema, "generation failure overwrote the last accepted native contract"
    finally:
        _restore_workflow(original)


async def test_workflow_generation_failure_blocks_actual_verifier_provider_call():
    from loop.run_agent import _run_verifier

    wf, fake, _replacement = _user_schema_refresh_fixture()
    fake.activity_fail_for.add("set_response_schema_activity")
    fake.activity_returns["check_progress"] = {
        "score": 1.0,
        "reasoning": "Old venues satisfied",
        "structured_response": {"venues": ["Old venue"]},
    }
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Also include venue prices")
        try:
            await wf._wait_for_response_schema_refresh()
        except RuntimeError as error:
            assert "set_response_schema_activity failed" in str(error)
        try:
            await _run_verifier(
                execute_activity=fake.execute_activity,
                context=[],
                verifier_prompt_generator=wf._make_verifier_prompt_generator(),
                model="rose-labs/rose-1-flash",
                agent_id=wf.agent_id,
                task_id=None,
                post_message=None,
                get_response_schema=wf._make_response_schema_getter(),
                get_requirement_revision=lambda: wf._response_schema_revision,
            )
        except RuntimeError as error:
            assert "set_response_schema_activity failed" in str(error)
        else:
            raise AssertionError(
                "the actual verifier judged an older native contract after latest schema generation failed"
            )
        assert not any(call[0] == "check_progress" for call in fake.activity_calls)
    finally:
        _restore_workflow(original)


async def test_workflow_valid_unchanged_schema_is_accepted_before_persistence_ack():
    wf, fake, _replacement = _user_schema_refresh_fixture()
    fake.activity_returns["set_response_schema_activity"] = {"schema": wf.output_schema, "usage": {}}
    persistence_ack = asyncio.Event()
    fake.activity_blockers["persist_response_schema_activity"] = persistence_ack
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Use the shared account to inspect the same venues")

        async def wait_for_persistence():
            while not any(call[0] == "persist_response_schema_activity" for call in fake.activity_calls):
                await asyncio.sleep(0)

        await asyncio.wait_for(wait_for_persistence(), timeout=1)
        assert getattr(wf, "_response_schema_accepted_revision", None) == 1, (
            "a valid unchanged native contract was not accepted before the persistence await"
        )
        persistence_ack.set()
        await wf._wait_for_response_schema_refresh()
        assert await wf._make_response_schema_getter()() == wf.output_schema
        wf.max_iterations, wf.context_gates = 30, {}
        resumed = _bare_workflow_instance()
        resumed._restore_deployment_state(wf._continuation_resume_state(wf.context))
        assert resumed._response_schema_accepted_revision == 1, "continuation discarded native contract acceptance"
    finally:
        persistence_ack.set()
        if wf._response_schema_refresh_task is not None:
            await wf._response_schema_refresh_task
        _restore_workflow(original)


async def test_workflow_accepted_native_schema_survives_lost_persistence_ack():
    wf, fake, replacement = _user_schema_refresh_fixture()
    fake.activity_fail_for.add("persist_response_schema_activity")
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Also include venue prices")
        await wf._wait_for_response_schema_refresh()
        assert await wf._make_response_schema_getter()() == replacement, (
            "a lost DB acknowledgement invalidated a native accepted contract"
        )
        assert getattr(wf, "_response_schema_accepted_revision", None) == 1
    finally:
        _restore_workflow(original)


async def test_workflow_schema_refresh_failure_remains_pending_for_native_retry():
    """A failed call preserves the last contract and retries the same authored input."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.goal = "Research three venues"
    wf.demo_cache_goal = wf.goal
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
    wf._response_schema_initialized = True

    fake = _FakeWorkflowModule()
    fake.activity_returns["set_response_schema_activity"] = None
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Also include prices")
        await asyncio.sleep(0)

        try:
            await wf._wait_for_response_schema_refresh()
        except ValueError as error:
            assert "schema generation returned no fields" in str(error)
        else:
            raise AssertionError("failed refresh was acknowledged as accepted input")

        assert wf._response_schema_applied_revision == 0
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
        await wf._wait_for_response_schema_refresh()

        assert wf.output_schema == replacement_schema
        assert wf._response_schema_applied_revision == 1
        assert wf._response_schema_revision == 1
        assert wf._response_schema_feedback == ["Also include prices"]
        assert not wf._is_finished
    finally:
        _restore_workflow(original)


async def test_workflow_failed_schema_continuation_retries_original_input_without_new_feedback():
    """Both pending and formerly consumed failures survive JSON continuation."""
    import copy
    from datetime import timedelta
    from utils.llm_timeouts import STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS

    wf, fake, replacement = _user_schema_refresh_fixture()
    wf.max_iterations, wf.context_gates = 30, {}
    authored = "  Use Andy's account instead.\n"
    fake.activity_fail_for.add("set_response_schema_activity")
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response(authored)
        try:
            await wf._wait_for_response_schema_refresh()
        except RuntimeError as error:
            assert "set_response_schema_activity failed" in str(error)
        state = json.loads(json.dumps(wf._continuation_resume_state(wf.context)))
        assert state["runtime_state"]["response_schema_applied_revision"] == 0
        assert state["runtime_state"]["response_schema_feedback"] == [authored]
        assert "response_schema_refresh_exception" not in state["runtime_state"]
        fake.activity_fail_for.clear()
        observed_options = []
        execute_activity = fake.execute_activity

        async def observe_activity(fn, args=None, **options):
            if getattr(fn, "__name__", "") == "set_response_schema_activity":
                observed_options.append(options)
                assert args[1][-1] == authored
            return await execute_activity(fn, args=args, **options)

        fake.execute_activity = observe_activity
        for legacy_consumed_failure in (False, True):
            snapshot = copy.deepcopy(state)
            if legacy_consumed_failure:
                snapshot["runtime_state"]["response_schema_applied_revision"] = 1
                snapshot["runtime_state"].pop("response_schema_accepted_revision")
                snapshot["runtime_state"]["response_schema_refresh_error"] = None
            resumed = _bare_workflow_instance()
            resumed._restore_deployment_state(snapshot)
            assert resumed._response_schema_applied_revision == 0
            resumed.agent_id, resumed.user_id = wf.agent_id, wf.user_id
            resumed.goal, resumed.demo_cache_goal = wf.goal, wf.demo_cache_goal
            getter = resumed._make_response_schema_getter()
            assert await getter() == replacement
            assert resumed._response_schema_feedback == [authored]
            assert resumed._response_schema_applied_revision == resumed._response_schema_revision == 1
            assert not resumed._is_finished
        assert len(observed_options) == 2
        for options in observed_options:
            assert options["start_to_close_timeout"] == timedelta(seconds=STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS)
            assert options["retry_policy"].maximum_attempts == 3
        assert not any(name == "post_agent_message" for name, _ in fake.activity_calls)
    finally:
        _restore_workflow(original)


async def test_workflow_schema_refresh_lifecycle_stop_propagates_without_respawn():
    from temporalio.exceptions import ApplicationError, CancelledError

    for stop_at in ("poll_new_messages", "set_response_schema_activity"):
        for error in (
            asyncio.CancelledError(),
            CancelledError("cancelled"),
            ApplicationError("sealed", type="WorkflowGenerationSealed"),
            ApplicationError("handoff", type="GenerationHandoffRequested"),
            _rejection_poll_activity_error(CancelledError("wrapped cancellation")),
            _rejection_poll_activity_error(ApplicationError("sealed", type="WorkflowGenerationSealed")),
            _rejection_poll_activity_error(ApplicationError("handoff", type="GenerationHandoffRequested")),
        ):
            wf, fake, _replacement = _user_schema_refresh_fixture()
            calls = []
            execute_activity = fake.execute_activity

            async def stopped_activity(fn, args=None, **options):
                name = getattr(fn, "__name__", "")
                if name in ("poll_new_messages", "set_response_schema_activity"):
                    calls.append(name)
                if name == stop_at:
                    raise error
                return await execute_activity(fn, args=args, **options)

            fake.execute_activity = stopped_activity
            original = _patch_workflow(fake)
            try:
                wf._record_response_schema_feedback("Keep the authored correction")
                # The signal can finish its worker before the next actor/verifier
                # boundary. Its completed lifecycle error must remain observable.
                task = wf._response_schema_refresh_task
                while not task.done():
                    await asyncio.sleep(0)
                try:
                    await wf._make_response_schema_getter()()
                except BaseException as observed:
                    assert observed is error
                else:
                    raise AssertionError("lifecycle stop became a retryable schema failure")
                await asyncio.sleep(0)
                assert calls == (
                    ["poll_new_messages"]
                    if stop_at == "poll_new_messages"
                    else ["poll_new_messages", "set_response_schema_activity"]
                )
                assert wf._response_schema_refresh_task is None
                assert wf._response_schema_applied_revision == 0
            finally:
                _restore_workflow(original)


async def test_workflow_schema_refresh_does_not_depend_on_message_write():
    """Native schema acceptance has no synthetic-message persistence dependency."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.goal = "Research three venues"
    wf.demo_cache_goal = wf.goal
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
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

        assert wf.output_schema == replacement_schema
        assert wf._response_schema_applied_revision == 1
        assert wf._response_schema_refresh_error is None
        assert not any(c[0] == "post_agent_message" for c in fake.activity_calls)
    finally:
        _restore_workflow(original)


async def test_workflow_schema_refresh_reloads_prior_feedback_after_continuation():
    """A fresh workflow run rebuilds revisions from durable USER messages."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.goal = "Research three venues"
    wf.demo_cache_goal = wf.goal
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
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
    wf.demo_cache_goal = wf.goal
    wf.output_schema = {
        "fields": [{"name": "venues", "type": "list[str]", "required": True}],
    }
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
        assert schema_messages == []
        assert wf.output_schema == replacement_schema
        assert wf._response_schema_applied_revision == 2
    finally:
        _restore_workflow(original)


async def _exercise_schema_refresh_persistence(
    *,
    latest_fails: bool,
    feedback_during_persist: bool = False,
    persist_ack_lost: bool = False,
    persist_fails_before_commit: bool = False,
    completion_calls: Optional[List] = None,
):
    """Run real schema generation/persistence through the workflow's revision gate."""
    import copy
    import httpx
    from temporalio.testing import ActivityEnvironment
    from unittest.mock import AsyncMock, patch
    from _test_utils import setup_mock_fn
    import workflows.agent_workflow as workflow_module

    wf, _unused_fake, _unused_replacement = _user_schema_refresh_fixture()
    wf.max_iterations = 20
    wf.context_gates = {}
    initial_schema = copy.deepcopy(wf.output_schema)
    stale_schema = {"fields": [{"name": "prices", "type": "list[int]", "required": True}]}
    latest_schema = {"fields": [{"name": "addresses", "type": "list[str]", "required": True}]}
    database = {"schema": copy.deepcopy(initial_schema)}
    writes = []
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    generation_count = 0

    async def generate_schema(*_args, **_kwargs):
        nonlocal generation_count
        generation_count += 1
        if generation_count == 1:
            first_started.set()
            await release_first.wait()
            return copy.deepcopy(stale_schema), None, {"prompt_tokens": 10, "completion_tokens": 2}
        if latest_fails or generation_count > 2:
            raise RuntimeError("latest schema generation failed")
        return copy.deepcopy(latest_schema), None, {"prompt_tokens": 12, "completion_tokens": 3}

    def database_http(request):
        if request.method == "PATCH" and request.url.path == f"/api/agents/{wf.agent_id}":
            body = json.loads(request.content)
            if body["response_schema"] == latest_schema and persist_fails_before_commit:
                raise httpx.ReadError("accepted schema persistence unavailable", request=request)
            database["schema"] = copy.deepcopy(body["response_schema"])
            writes.append(copy.deepcopy(database["schema"]))
            if body["response_schema"] == latest_schema:
                if feedback_during_persist:
                    wf._record_response_schema_feedback("Also include phone numbers")
                if persist_ack_lost:
                    raise httpx.ReadError("accepted schema acknowledgement lost", request=request)
            return httpx.Response(200, json={"success": True})
        return httpx.Response(404, json={"error": "unexpected schema fixture request"})

    class SchemaActivityWorkflow(_FakeWorkflowModule):
        async def execute_activity(self, fn, args=None, **kwargs):
            name = getattr(fn, "__name__", str(fn))
            if name in {"set_response_schema_activity", "persist_response_schema_activity"}:
                self.activity_calls.append((name, args))
                return await ActivityEnvironment().run(fn, *(args or []))
            return await super().execute_activity(fn, args=args, **kwargs)

    fake = SchemaActivityWorkflow()
    fake.activity_returns["poll_new_messages"] = []
    original_workflow = _patch_workflow(fake)
    original_run_agent = workflow_module.run_agent
    observed_resume_schema = []

    async def resumed_agent(**kwargs):
        observed_resume_schema.append(copy.deepcopy(kwargs["response_schema"]))
        return {"status": "completed", "context": [], "structured_response": None, "token_count": 0, "context_size": 0}

    config = SimpleNamespace(backend=SimpleNamespace(api_url="https://schema-fixture.test", api_key="fixture-key"))
    try:
        setup_mock_fn(database_http)
        with (
            patch("helpers.llm.load_config", return_value=config),
            patch("helpers.llm._generate_response_schema_with_rose", generate_schema),
            patch(
                "providers.demo_cache.client.resolve_agent_fast_mode",
                AsyncMock(return_value=(False, "", False, "", "", False)),
            ),
        ):
            await wf.receive_user_response("Include prices")
            await asyncio.wait_for(first_started.wait(), timeout=2)
            await wf.receive_user_response("Return addresses instead")
            release_first.set()
            try:
                await wf._wait_for_response_schema_refresh()
            except RuntimeError as error:
                assert latest_fails or feedback_during_persist
                assert "latest schema generation failed" in str(error)

            accepted_schema = copy.deepcopy(wf.output_schema)
            state = wf._continuation_resume_state(wf.context)
            fake.activity_returns.update(
                {
                    "fetch_agent_config": {
                        "response_schema": copy.deepcopy(database["schema"]),
                        "write_lock_enabled": True,
                    },
                    "get_model_context_window": 200_000,
                    "get_agent_source": "WEB",
                    "get_user_context": "",
                    "get_user_system_name": "Rose",
                    "generate_completion_summary": {"summary": "done", "tool_counts": {}, "usage": {}},
                }
            )
            workflow_module.run_agent = resumed_agent
            restored = _bare_workflow_instance()
            if completion_calls is not None:

                async def observe_complete(*args, **kwargs):
                    completion_calls.append((args, kwargs))

                restored._mark_complete = observe_complete
            try:
                terminal_result = await restored.run(
                    wf.agent_id,
                    wf.user_id,
                    wf.goal,
                    "rose-labs/rose-1-flash",
                    256,
                    {"type": "FLOAT_LLM_JUDGE"},
                    context=wf.context,
                    start_phase="execute_continued",
                    resume_state=state,
                )
                assert not (latest_fails or feedback_during_persist), "unaccepted schema produced a terminal result"
            except RuntimeError as error:
                if not (latest_fails or feedback_during_persist):
                    raise
                # These cases inspect persistence/restoration after a genuine
                # later generation failure; their fake loop cannot certify it.
                assert "latest schema generation failed" in str(error)
                assert not restored._is_finished, "schema generation failure invented durable FAILED"
        return initial_schema, latest_schema, accepted_schema, database["schema"], writes, observed_resume_schema
    finally:
        release_first.set()
        if wf._response_schema_refresh_task is not None:
            await wf._response_schema_refresh_task
        workflow_module.run_agent = original_run_agent
        _restore_workflow(original_workflow)
        teardown_mock()


async def _exercise_unaccepted_schema_terminal_outcome(path):
    """Use the real workflow entry and durable failure path at completion boundaries."""
    from unittest.mock import AsyncMock, patch
    import workflows.agent_workflow as module
    from utils.oai_demo import OAI_DEMO_CHILD_GOAL_PREFIX

    wf, fake, _replacement = _user_schema_refresh_fixture()
    fake.activity_returns.update(
        {
            "poll_new_messages": [],
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Navi",
            "get_user_custom_system_prompt": None,
            "fetch_compute_token_activity": None,
            "fetch_agent_config": {"response_schema": wf.output_schema, "write_lock_enabled": True},
        }
    )
    fake.activity_fail_for.add("set_response_schema_activity")
    if path == "fast_mode":
        wf.goal = f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky — Huberman"
    failure_message = "set_response_schema_activity failed"

    async def invalidate():
        await wf.receive_user_response("Also return venue prices")
        await wf._wait_for_response_schema_refresh()

    async def loop(**kwargs):
        if path == "unrelated":
            raise RuntimeError("unrelated implementation defect")
        if path != "deferred":
            await invalidate()
        return {
            "status": "max_iterations" if path == "fast_mode" else "completed",
            "context": [],
            "structured_response": {"venues": ["Previous contract"]},
            "verifier_progress": 1.0,
            "verifier_reasoning": "Fast Mode cache trajectory ended",
            "token_count": 3,
            "context_size": 30,
        }

    async def post_dag(**kwargs):
        await invalidate()
        return {"score": 1.0, "reasoning": "Previous contract passed", "usage": {}}

    async def deferred():
        if path == "deferred":
            await invalidate()

    original = _patch_workflow(fake)
    original_loop, original_extract, original_dag = (
        module.run_agent,
        module.extract_plan_from_context,
        module.execute_dag,
    )
    module.run_agent = loop
    module.extract_plan_from_context = lambda context: (
        {"tasks": [{"goal": "Find venues", "tool_name": "spawn_explore_agent"}], "dependencies": {}}
        if path == "post_dag"
        else None
    )
    module.execute_dag = AsyncMock(return_value={"status": "completed", "context": []})
    wf._attempt_post_dag_completion = post_dag
    wf._await_deferred_startup = deferred
    try:
        try:
            if path == "fast_mode":
                with (
                    patch.object(module, "is_demo_cache_task", return_value=True),
                    patch.object(module, "is_oai_demo_mass_agent_task", return_value=True),
                ):
                    result = await wf.run(
                        wf.agent_id,
                        wf.user_id,
                        wf.goal,
                        "rose-labs/rose-1-flash",
                        256,
                        {"type": "FLOAT_LLM_JUDGE"},
                        start_phase="execute_continued",
                    )
            else:
                result = await wf.run(
                    wf.agent_id,
                    wf.user_id,
                    wf.goal,
                    "rose-labs/rose-1-flash",
                    256,
                    {"type": "FLOAT_LLM_JUDGE"},
                    start_phase="execute_continued",
                )
        except RuntimeError as error:
            if path == "unrelated":
                raise
            assert failure_message in str(error)
        else:
            raise AssertionError("schema failure manufactured a terminal workflow result")
        assert not wf._is_finished, "schema failure was mapped to durable FAILED"
        assert not any(name == "update_agent_status" and args[1] == "FAILED" for name, args in fake.activity_calls)
        assert not any(name in ("mark_finished", "generate_completion_summary") for name, args in fake.activity_calls)
        assert wf._response_schema_accepted_revision < wf._response_schema_revision
        assert wf._response_schema_applied_revision < wf._response_schema_revision
    finally:
        module.run_agent, module.extract_plan_from_context, module.execute_dag = (
            original_loop,
            original_extract,
            original_dag,
        )
        _restore_workflow(original)


async def _exercise_healthy_input_during_terminal_wait(
    *, schema_changed, boundary="sms", path="execute", feedback=True
):
    from unittest.mock import AsyncMock, patch
    import workflows.agent_workflow as module
    from domains.spawn_agent.handler import track_fast_mode_explore

    class Continued(BaseException):
        pass

    wf, fake, replacement = _user_schema_refresh_fixture()
    initial = wf.output_schema
    accepted = replacement if schema_changed else initial
    correction = "Use the updated venue evidence and include prices where available"
    fake.activity_returns.update(
        {
            "poll_new_messages": [],
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Rose",
            "get_user_custom_system_prompt": None,
            "fetch_compute_token_activity": None,
            "fetch_agent_config": {"response_schema": initial, "write_lock_enabled": True},
            "set_response_schema_activity": {"schema": accepted, "usage": {}},
            "generate_completion_summary": {"summary": "Old completion", "tool_counts": {}, "usage": {}},
        }
    )
    started, released, generation_released = asyncio.Event(), asyncio.Event(), asyncio.Event()
    fake.activity_blockers["set_response_schema_activity"] = generation_released
    continuations = []

    def continue_as_new(**kwargs):
        continuations.append(kwargs["args"])
        raise Continued()

    fake.continue_as_new = continue_as_new

    async def sms_handle():
        started.set()
        await released.wait()

    async def explore_handle():
        started.set()
        await released.wait()
        return {}

    async def deliver():
        await started.wait()
        if feedback:
            await wf.receive_user_response(correction)
        released.set()
        # Let the completion caller return from its native awaited operation
        # while a successful provider result is still pending.
        await asyncio.sleep(0)
        generation_released.set()

    recovered = []

    async def loop(**kwargs):
        if path == "post_dag":
            recovered.append(wf._response_schema_revision)
            assert wf._response_schema_accepted_revision == wf._response_schema_revision > 0
            return {
                "status": "completed",
                "context": [],
                "structured_response": {"venues": ["Current verdict"], "venue_prices": [10]},
                "_verified_user_requirement_keys": [],
                "_verified_requirement_revision": wf._response_schema_revision,
                "token_count": 3,
                "context_size": 30,
            }
        if boundary == "sms":
            wf._deferred_startup_sms_handle = sms_handle()
        else:
            track_fast_mode_explore(
                wf,
                explore_handle(),
                task_id="pending-explore",
                tool_call_id="pending-explore-call",
                ui_goal="Read venues",
            )
        return {
            "status": "max_iterations" if path == "fast_cap" else "completed",
            "context": [],
            "structured_response": {"venues": ["Old verdict"]},
            "_verified_user_requirement_keys": [],
            "_verified_requirement_revision": wf._response_schema_revision,
            "verifier_progress": 1.0,
            "verifier_reasoning": "Fast Mode cache trajectory ended",
            "token_count": 3,
            "context_size": 30,
        }

    async def post_dag(**kwargs):
        wf._deferred_startup_sms_handle = sms_handle()
        return {
            "score": 1.0,
            "structured_response": {"venues": ["Old verdict"]},
            "_verified_user_requirement_keys": [],
            "_verified_requirement_revision": wf._response_schema_revision,
        }

    original = _patch_workflow(fake)
    delivery = asyncio.create_task(deliver())
    did_continue = False
    try:
        plan = (
            {"tasks": [{"goal": "Read venues", "tool_name": "spawn_explore_agent"}], "dependencies": {}}
            if path == "post_dag"
            else None
        )
        with (
            patch.object(module, "run_agent", loop),
            patch.object(module, "extract_plan_from_context", return_value=plan),
            patch.object(module, "execute_dag", AsyncMock(return_value={"status": "completed", "context": []})),
            patch.object(wf, "_attempt_post_dag_completion", post_dag),
            patch.object(module, "is_demo_cache_task", return_value=boundary == "drain" or path == "fast_cap"),
            patch.object(module, "is_oai_demo_mass_agent_task", return_value=boundary == "drain" or path == "fast_cap"),
        ):
            try:
                result = await wf.run(
                    wf.agent_id,
                    wf.user_id,
                    wf.goal,
                    "rose-labs/rose-1-flash",
                    256,
                    {"type": "FLOAT_LLM_JUDGE"},
                    start_phase="execute" if path == "post_dag" else "execute_continued",
                )
            except Continued:
                did_continue = True
        await delivery
        await wf._wait_for_response_schema_refresh()
        terminal_writes = [
            args
            for name, args in fake.activity_calls
            if name == "update_agent_status" and args[1] in ("FAILED", "COMPLETED")
        ]
        if path == "fast_cap":
            assert result == {"status": "failed", "reason": "max_iterations", "goal": wf.goal}, (
                "pending healthy feedback was reported as schema failure instead of the existing step limit"
            )
            assert len(terminal_writes) == 1 and terminal_writes[0][3] == "Max Steps Reached", (
                "healthy late input changed the existing step-budget failure into a schema error"
            )
            assert not any(
                name in ("mark_finished", "generate_completion_summary") for name, _args in fake.activity_calls
            )
            return
        if path == "post_dag" or not feedback:
            assert result["status"] == "completed" and not any(args[1] == "FAILED" for args in terminal_writes), (
                "healthy completion or post-DAG recovery was converted to terminal failure"
            )
            assert recovered if path == "post_dag" else wf._response_schema_revision == 0
            if path == "post_dag":
                assert wf.output_schema == accepted, "post-DAG recovery lost the new contract"
            return
        assert terminal_writes == [], "healthy late input produced terminal success/failure instead of continuing"
        assert not any(
            name in ("mark_finished", "generate_completion_summary") for name, _args in fake.activity_calls
        ), "the old verdict produced completion side effects after healthy late input"
        assert did_continue and not wf._is_finished, "superseded completion did not resume native reasoning"
        state = continuations[0][16]["runtime_state"]
        assert state["output_schema"] == accepted
        assert state["response_schema_accepted_revision"] == state["response_schema_revision"] > 0
        assert correction in state["response_schema_feedback"], "continuation lost the actual late instruction"
    finally:
        released.set()
        generation_released.set()
        await delivery
        if wf._response_schema_refresh_task is not None:
            await wf._response_schema_refresh_task
        _restore_workflow(original)


async def test_workflow_healthy_feedback_during_native_sms_wait_continues_with_changed_schema():
    await _exercise_healthy_input_during_terminal_wait(schema_changed=True)


async def test_workflow_healthy_feedback_during_native_sms_wait_continues_with_unchanged_schema():
    await _exercise_healthy_input_during_terminal_wait(schema_changed=False)


async def test_workflow_healthy_feedback_during_native_explore_drain_discards_old_completion():
    await _exercise_healthy_input_during_terminal_wait(schema_changed=True, boundary="drain")


async def test_workflow_healthy_sms_feedback_post_dag_recovers_current_contract():
    await _exercise_healthy_input_during_terminal_wait(schema_changed=True, path="post_dag")


async def test_workflow_healthy_sms_feedback_keeps_fast_mode_step_budget():
    await _exercise_healthy_input_during_terminal_wait(schema_changed=True, path="fast_cap")


async def test_workflow_native_sms_completion_without_new_feedback_still_completes():
    await _exercise_healthy_input_during_terminal_wait(schema_changed=False, feedback=False)


async def test_workflow_unaccepted_schema_does_not_invent_terminal_failure():
    for path in ("execute", "post_dag", "fast_mode", "deferred"):
        await _exercise_unaccepted_schema_terminal_outcome(path)


async def test_workflow_schema_failure_handler_does_not_swallow_unrelated_errors():
    try:
        await _exercise_unaccepted_schema_terminal_outcome("unrelated")
    except RuntimeError as error:
        assert str(error) == "unrelated implementation defect"
    else:
        raise AssertionError("schema rejection boundary swallowed an unrelated RuntimeError")


async def test_workflow_direct_completion_bypass_refuses_unaccepted_latest_contract():
    completions = []
    await _exercise_schema_refresh_persistence(latest_fails=True, completion_calls=completions)
    assert completions == [], "completion UI/status writes began before native contract acceptance"


async def test_workflow_fast_mode_completion_refuses_unaccepted_latest_contract():
    from utils.oai_demo import OAI_DEMO_CHILD_GOAL_PREFIX

    wf, fake, _replacement = _user_schema_refresh_fixture()
    wf.goal = f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky — Huberman"
    wf.fast_mode_cache_enabled = True
    fake.activity_fail_for.add("set_response_schema_activity")
    completed = []

    async def mark_complete(*args, **kwargs):
        completed.append(True)

    wf._mark_complete = mark_complete
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response("Also return venue prices")
        try:
            await wf._wait_for_response_schema_refresh()
        except RuntimeError as error:
            assert "set_response_schema_activity failed" in str(error)
        result = await wf._handle_incomplete(
            {
                "status": "max_iterations",
                "context": [],
                "verifier_progress": 1.0,
                "verifier_reasoning": "Fast Mode cache trajectory ended",
            },
            phase="EXECUTE",
        )
        assert result["reason"] == "max_iterations", "pending schema replaced the existing step-cap decision"
        assert completed == []
    finally:
        _restore_workflow(original)


async def test_workflow_superseded_schema_never_persists_when_latest_generation_fails():
    initial, _latest, accepted, persisted, writes, resumed = await _exercise_schema_refresh_persistence(
        latest_fails=True
    )
    assert (accepted, persisted, resumed) == (initial, initial, [initial]), (
        "Superseded schema reached durable state or the resumed native contract: "
        f"accepted={accepted!r}, persisted={persisted!r}, resumed={resumed!r}, writes={writes!r}"
    )
    assert writes == [], "discarded schema generation must not issue a persistence write"


async def test_workflow_only_accepted_latest_schema_persists_and_resumes():
    _initial, latest, accepted, persisted, writes, resumed = await _exercise_schema_refresh_persistence(
        latest_fails=False
    )
    assert (accepted, persisted, resumed, writes) == (latest, latest, [latest], [latest]), (
        "The revision gate must persist only the accepted latest schema and preserve it across continuation"
    )


async def test_workflow_feedback_during_schema_persistence_keeps_accepted_contract():
    _initial, latest, accepted, persisted, _writes, resumed = await _exercise_schema_refresh_persistence(
        latest_fails=False,
        feedback_during_persist=True,
    )
    assert (accepted, persisted, resumed) == (latest, latest, [latest]), (
        "Input arriving during persistence discarded a schema that had already been accepted"
    )


async def test_workflow_schema_commit_with_lost_acknowledgement_keeps_accepted_contract():
    _initial, latest, accepted, persisted, _writes, resumed = await _exercise_schema_refresh_persistence(
        latest_fails=False,
        persist_ack_lost=True,
    )
    assert (accepted, persisted, resumed) == (latest, latest, [latest]), (
        "A committed schema was treated as discarded after its acknowledgement was lost"
    )


async def test_workflow_restored_accepted_schema_wins_over_stale_database_config():
    initial, latest, accepted, persisted, _writes, resumed = await _exercise_schema_refresh_persistence(
        latest_fails=False,
        persist_fails_before_commit=True,
    )
    assert (accepted, persisted, resumed) == (latest, initial, [latest]), (
        "Continuation replaced the accepted native contract with an older database snapshot"
    )


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


async def test_workflow_signal_child_progress_keeps_parent_usage_own_only():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.tokens_in = 40
    wf.tokens_out = 10
    wf.token_count = 50
    wf.max_iterations = 25
    wf.context_gates = {}
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
        assert (wf.tokens_in, wf.tokens_out, wf.token_count) == (40, 10, 50)
        assert wf.child_last_tokens["child-1"] == {
            "tokens_in": 100,
            "tokens_out": 50,
            "token_count": 150,
        }

        # A later cumulative observation replaces only the child's bookkeeping.
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
        assert (wf.tokens_in, wf.tokens_out, wf.token_count) == (40, 10, 50)
        assert wf.child_last_tokens["child-1"] == {
            "tokens_in": 250,
            "tokens_out": 120,
            "token_count": 370,
        }

        # The next parent LLM write checkpoints only the parent's own counters.
        await wf._on_tokens(
            tokens_in_delta=20,
            tokens_out_delta=5,
            call_site="execute_loop",
            iteration=3,
        )
        save_call = next(call for call in fake.activity_calls if call[0] == "save_tool_usage")
        assert save_call[1][4] == {
            "token_count": 75,
            "tokens_in": 60,
            "tokens_out": 15,
            "own_cost_cents": 0.0,
        }
        assert (wf.tree_tokens_in, wf.tree_tokens_out) == (60, 15)

        # Child subtree counters remain separate and produce the tree-only view.
        await wf.child_cost_update(
            {
                "child_agent_id": "child-1",
                "subtree_cost_cents": 0,
                "subtree_tokens_in": 250,
                "subtree_tokens_out": 120,
            }
        )
        assert (wf.tree_tokens_in, wf.tree_tokens_out) == (310, 135)

        # Continue-as-new preserves both views without folding the tree into own.
        state = wf._continuation_resume_state([])
        restored = _bare_workflow_instance()
        restored._restore_deployment_state(state)
        assert (restored.token_count, restored.tokens_in, restored.tokens_out) == (75, 60, 15)
        assert (restored.tree_tokens_in, restored.tree_tokens_out) == (310, 135)
        assert restored.children_tokens_in == {"child-1": 250}
        assert restored.children_tokens_out == {"child-1": 120}
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


async def test_workflow_track_llm_cost_demo_cache_replay_is_zero_cost():
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


async def test_workflow_track_llm_cost_foundry_is_zero_user_cost():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.model = "rose-labs/rose-1-ultra"
    wf.input_cents_per_1k = 0.3
    wf.output_cents_per_1k = 1.5
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._track_llm_cost(
            tokens_in=10_000,
            tokens_out=1_000,
            call_site="verifier_browser",
            actual_model="gpt-6-sol-foundry",
        )
        assert wf.own_cost_cents == 0.0
        saved_item = next(c for c in fake.activity_calls if c[0] == "save_tool_usage")[1][3][0]
        assert saved_item["cost_cents"] == 0
        assert saved_item["model"] == "gpt-6-sol-foundry"
        assert saved_item["from_fast_cache"] is False
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


async def test_workflow_track_usage_foundry_is_zero_user_cost():
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        usage = {
            "llm": [
                {
                    "tokens_in": 10_000,
                    "tokens_out": 1_000,
                    "model": "gpt-6-sol-foundry",
                    "provider": "Explore Agent",
                }
            ]
        }
        await wf._track_usage(usage, tool_name="spawn_sub_agent", call_site="explore_agent")
        assert wf.own_cost_cents == 0.0
        saved_item = next(c for c in fake.activity_calls if c[0] == "save_tool_usage")[1][3][0]
        assert saved_item["cost_cents"] == 0
        assert saved_item["model"] == "gpt-6-sol-foundry"
    finally:
        _restore_workflow(original)


async def test_workflow_track_usage_demo_cache_replay_is_zero_cost():
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


async def test_workflow_track_usage_browser_items_price_at_browser_pool():
    """Regression (A-02): browser tokens must price at rose-1-browser-use.

    Full seam: build_usage_items (activity) -> browser_usage_items_to_tool_usage
    (manager) -> _track_usage (workflow). Before the fix the llm row carried no
    `model`, so the workflow fell back to the ROOT pool rate and under-billed
    browser tokens that had actually raced through the browser pool.

    The root pool here is rose-1-mini. Flash and browser-use share the GLM
    speed waterfall, so a flash root would make the rate comparison vacuous.
    Mini (haiku + glm) is priced differently from browser-use (glm + gemini-3.8).
    """
    from domains.spawn_browser_agent_v3.handler import _simulated_browser_usage_items
    from domains.spawn_browser_agent_v3.service import (
        browser_usage_items_to_tool_usage,
        build_usage_items,
    )
    from providers.rose.pricing import get_model_pricing

    browser_pricing = get_model_pricing("rose-1-browser-use")
    root_pricing = get_model_pricing("rose-1-mini")
    tokens_in, tokens_out = 1_186_754, 40_000
    expected = (tokens_in / 1000) * browser_pricing["input_cents_per_1k"] + (tokens_out / 1000) * browser_pricing[
        "output_cents_per_1k"
    ]
    root_priced = (tokens_in / 1000) * root_pricing["input_cents_per_1k"] + (tokens_out / 1000) * root_pricing[
        "output_cents_per_1k"
    ]
    assert abs(root_priced - expected) > 1.0  # guard: the two rates must actually differ

    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.model = "rose-1-mini"
    wf.input_cents_per_1k = root_pricing["input_cents_per_1k"]
    wf.output_cents_per_1k = root_pricing["output_cents_per_1k"]
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        items = build_usage_items(tokens_in, tokens_out, browser_pricing, 900_000)
        await wf._track_usage(
            browser_usage_items_to_tool_usage(items),
            tool_name="spawn_browser_agent",
            call_site="browser_agent",
        )
    finally:
        _restore_workflow(original)

    save_call = next(c for c in fake.activity_calls if c[0] == "save_tool_usage")
    saved = next(i for i in save_call[1][3] if i["type"] == "llm")
    assert saved["model"] == "rose-1-browser-use", f"browser usage priced as {saved['model']!r}"
    assert abs(saved["cost_cents"] - expected) < 0.01, f"{saved['cost_cents']} != {expected} (browser pool rate)"
    assert abs(saved["cost_cents"] - root_priced) > 1.0, "browser tokens were priced at the root pool rate"

    # A direct-compute-token browser row (-claude suffix) must reach the $0 branch.
    wf2 = _bare_workflow_instance()
    wf2.agent_id = "a"
    wf2.user_id = "u"
    wf2.model = "rose-1-mini"
    wf2.input_cents_per_1k = root_pricing["input_cents_per_1k"]
    wf2.output_cents_per_1k = root_pricing["output_cents_per_1k"]
    fake2 = _FakeWorkflowModule()
    original = _patch_workflow(fake2)
    try:
        direct_items = _simulated_browser_usage_items(
            50_000,
            1_000,
            browser_pricing,
            usage_by_model={"claude-opus-4-8-claude": {"input_tokens": 50_000, "output_tokens": 1_000}},
        )
        await wf2._track_usage(
            browser_usage_items_to_tool_usage(direct_items),
            tool_name="spawn_browser_agent",
            call_site="browser_agent",
        )
    finally:
        _restore_workflow(original)

    save_call2 = next(c for c in fake2.activity_calls if c[0] == "save_tool_usage")
    direct_row = next(i for i in save_call2[1][3] if i["type"] == "llm")
    assert direct_row["model"] == "claude-opus-4-8-claude"
    assert direct_row["cost_cents"] == 0
    assert direct_row["tokens_in"] == 50_000


async def test_workflow_track_usage_browser_rows_carry_real_inference_model():
    """Browser usage must be attributed per ACTUAL model through the REAL path.

    Seam: build_usage_items (REAL activity helper, not the simulated twin)
    -> browser_usage_items_to_tool_usage -> _track_usage. A hardcoded
    `rose-1-browser-use` pool name collapses the race into one row AND can
    never match the `-claude`/`-gpt` $0 direct-compute-token branch, so steps
    that ran on the user's own token are billed as paid waterfall usage.
    """
    import inspect

    from domains.spawn_browser_agent_v3.service import (
        browser_usage_items_to_tool_usage,
        build_usage_items,
    )
    from providers.rose.pricing import get_model_pricing

    browser_pricing = get_model_pricing("rose-1-browser-use")
    root_pricing = get_model_pricing("rose-1-ultra")
    usage_by_model = {
        "claude-opus-4-8-claude": {"input_tokens": 50_000, "output_tokens": 1_000},
        "google/gemini-3.1-pro-preview": {"input_tokens": 20_000, "output_tokens": 4_000},
    }
    total_in = sum(u["input_tokens"] for u in usage_by_model.values())
    total_out = sum(u["output_tokens"] for u in usage_by_model.values())

    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.model = "rose-1-ultra"
    wf.input_cents_per_1k = root_pricing["input_cents_per_1k"]
    wf.output_cents_per_1k = root_pricing["output_cents_per_1k"]
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        # Behavioral assertion: tolerate the parameter being absent so the
        # failure is "rows lost the real model" rather than a TypeError.
        supported = "usage_by_model" in inspect.signature(build_usage_items).parameters
        items = build_usage_items(
            total_in,
            total_out,
            browser_pricing,
            900_000,
            **({"usage_by_model": usage_by_model} if supported else {}),
        )
        await wf._track_usage(
            browser_usage_items_to_tool_usage(items),
            tool_name="spawn_browser_agent",
            call_site="browser_agent",
        )
    finally:
        _restore_workflow(original)

    save_call = next(c for c in fake.activity_calls if c[0] == "save_tool_usage")
    llm_rows = [i for i in save_call[1][3] if i["type"] == "llm"]

    assert len(llm_rows) == 2, f"expected one row per actual model, got {[r['model'] for r in llm_rows]}"
    by_model = {r["model"]: r for r in llm_rows}
    assert set(by_model) == set(usage_by_model), "usage rows lost the real inference model names"
    assert "rose-1-browser-use" not in by_model, "hardcoded pool constant leaked into per-model rows"

    # The user's own compute token must reach the $0 branch through the REAL path.
    claude_row = by_model["claude-opus-4-8-claude"]
    assert claude_row["cost_cents"] == 0, f"claudeAuth browser tokens billed {claude_row['cost_cents']}c"
    assert claude_row["tokens_in"] == 50_000
    assert claude_row["tokens_out"] == 1_000

    # ...while the waterfall model is still billed.
    paid_row = by_model["google/gemini-3.1-pro-preview"]
    assert paid_row["cost_cents"] > 0
    assert paid_row["tokens_in"] == 20_000

    # Token conservation across the whole seam.
    assert sum(r["tokens_in"] for r in llm_rows) == total_in
    assert sum(r["tokens_out"] for r in llm_rows) == total_out


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
        await wf._update_tree_state(progress=0.5)
        # No bus and no status transition: nothing to broadcast or persist.
        assert fake.activity_calls == []
    finally:
        _restore_workflow(original)


async def test_workflow_update_tree_state_persists_status_without_bus():
    """A bus-less root that pauses for the user's auth help must not stay ACTIVE in the DB.

    Run e0c401c1 (browser-auth-created-account-reused): the browser handler set the
    root PAUSED awaiting authentication assistance, but the root had no bus, so the
    status never left the workflow and the fleet reported a silent ACTIVE tree stall.
    """
    wf = _bare_workflow_instance()
    wf.agent_id = "root-1"
    wf.bus_id = None
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._update_tree_state(status="PAUSED")
        calls = [c for c in fake.activity_calls if c[0] == "update_agent_tree_state"]
        assert len(calls) == 1, fake.activity_calls
        args = calls[0][1]
        assert args[0] == "root-1" and args[2] is None
        assert args[3]["status"] == "PAUSED" and args[3]["_statusExplicit"] is True
        await wf._update_tree_state(status="ACTIVE")
        calls = [c for c in fake.activity_calls if c[0] == "update_agent_tree_state"]
        assert [c[1][3]["status"] for c in calls] == ["PAUSED", "ACTIVE"]
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
            call_site="execute_loop",
            iteration=7,
        )
        assert wf.tokens_in == 1000
        assert wf.tokens_out == 500
        assert wf.iteration_offset == 7
        assert wf.own_cost_cents > 0
        activity_names = [c[0] for c in fake.activity_calls]
        assert "save_tool_usage" in activity_names
        save_call = next(call for call in fake.activity_calls if call[0] == "save_tool_usage")
        assert save_call[1][3][0]["iteration"] == 7
        await wf._on_tokens(
            tokens_in_delta=0,
            tokens_out_delta=0,
            actual_model=None,
            call_site="plan_loop",
            iteration=99,
        )
        assert wf.iteration_offset == 7, "PLAN iterations must not consume the EXECUTE budget"
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


async def test_workflow_on_tokens_demo_cache_replay_is_zero_cost():
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


async def test_simulated_agent_finishes_on_the_world_clock_before_signalling_its_parent():
    """A parent resumes at its children's finish times, so the finish lands first (V8, V10)."""
    wf = _bare_workflow_instance()
    wf.agent_id = "child-1"
    wf.parent_agent_id = "root-1"
    wf.user_id = "u-1"
    wf.goal = "fail goal"
    wf.parent_workflow_id = "parent-wf"
    wf.world_model_mode = "simulate"
    fake = _FakeWorkflowModule()
    order = []
    original_execute = fake.execute_activity

    world_start = int(datetime(2026, 9, 28, tzinfo=timezone.utc).timestamp() * 1000)

    async def execute_activity(fn, args=None, **kwargs):
        order.append(("activity", getattr(fn, "__name__", "?"), list(args or [])))
        if getattr(fn, "__name__", "") == "world_clock_activity":
            return {"agent_id": "child-1", "time_ms": world_start}
        return await original_execute(fn, args=args, **kwargs)

    fake.execute_activity = execute_activity
    original_handle = fake.get_external_workflow_handle

    def handle(wf_id):
        order.append(("signal", wf_id))
        return original_handle(wf_id)

    fake.get_external_workflow_handle = handle
    original = _patch_workflow(fake)
    try:
        await wf._world_clock_event("register")
        # The agent's own clock now reads world time (the pinned scenario date).
        assert wf.simulated_clock_offset_seconds == world_start // 1000 - int(fake.now().timestamp())
        await wf._world_clock_event("register")
        await wf._mark_failed(context=[], reason="error", message="Something broke")
    finally:
        _restore_workflow(original)
    clock = [entry for entry in order if entry[0] == "activity" and entry[1] == "world_clock_activity"]
    assert [entry[2] for entry in clock] == [["register", "child-1", "root-1"], ["finish", "child-1", None]]
    finish_at = order.index(clock[-1])
    signal_at = next(index for index, entry in enumerate(order) if entry[0] == "signal")
    assert finish_at < signal_at

    real = _bare_workflow_instance()
    real.agent_id = "root-2"
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await real._world_clock_event("register")
        await real._mark_failed(context=[], reason="error", message="Something broke")
    finally:
        _restore_workflow(original)
    assert "world_clock_activity" not in [call[0] for call in fake.activity_calls]


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


async def test_workflow_paused_continue_as_new_preserves_deployment_state():
    """Manual and cost pauses retain the deployment snapshot after resuming."""
    for prior_status in ("PAUSED", "COST_LIMIT_REACHED"):
        wf = _bare_workflow_instance()
        wf.agent_id = f"agent-{prior_status.lower()}"
        wf.user_id = "user-1"
        wf.goal = "continue safely"
        wf.model = "rose-labs/rose-1-ultra"
        wf.reasoning_max_tokens = 512
        wf.verifier = {"type": "FLOAT_LLM_JUDGE"}
        wf.max_iterations = None
        wf.price_limit_cents = 250
        wf.context_gates = {"network": False}
        wf.fast_mode_cache_enabled = True
        state = _deployment_resume_fixture(prior_status)
        state["max_iterations"] = None
        wf._restore_deployment_state(state)
        wf.iteration_offset = 19
        wf.compute_token_provider = "claude"
        wf.claude_max_token = "cached-claude"
        wf.compute_token_fetched_at = datetime(2025, 1, 1, 11, 55, tzinfo=timezone.utc)
        wf.pending_children = {"child-1"}
        wf.child_workflow_ids = {"child-1": "child-workflow"}

        fake = _FakeWorkflowModule()
        continued = []

        async def fake_wait_condition(condition, _wf=wf, **_kwargs):
            assert condition() is False
            _wf.is_paused = False
            _wf._cost_limit_reached = False

        def fake_continue_as_new(*, args, _continued=continued):
            _continued.append(args)

        async def wait_for_refresh():
            return None

        fake.wait_condition = fake_wait_condition
        fake.continue_as_new = fake_continue_as_new
        wf._wait_for_response_schema_refresh = wait_for_refresh
        original = _patch_workflow(fake)
        try:
            context = [{"role": "USER", "text": f"resume {prior_status}"}]
            result = await wf._handle_incomplete(
                {"status": "paused", "context": context},
                phase="EXECUTE",
            )
            assert result["status"] == "paused"
            assert len(continued) == 1
            args = continued[0]
            resume_state = args[16]
            assert len(args) == 17
            assert args[6] == context
            assert args[11] == "execute_continued"
            assert args[12] is None
            assert resume_state["prior_status"] == "ACTIVE"
            assert resume_state["token_count"] == 950
            assert resume_state["own_cost_cents"] == 17.25
            assert resume_state["iteration_offset"] == 19
            assert "claude_max_token" not in resume_state["runtime_state"]
            assert "gpt_code_token" not in resume_state["runtime_state"]
            assert resume_state["runtime_state"]["pending_children"] == ["child-1"]
        finally:
            _restore_workflow(original)


async def test_workflow_generation_handoff_continue_as_new_onto_live_queue():
    """Cooperative cutover moves the workflow onto the live generation queue."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-handoff"
    wf.user_id = "user-1"
    wf.goal = "hand off generations"
    wf.model = "rose-labs/rose-1-ultra"
    wf.reasoning_max_tokens = 256
    wf.verifier = {"type": "FLOAT_LLM_JUDGE"}
    wf.max_iterations = None
    wf.price_limit_cents = 100
    wf.context_gates = {}
    fake = _FakeWorkflowModule()
    continued: List[tuple] = []

    def fake_continue_as_new(*, args, task_queue=None, _continued=continued):
        _continued.append((args, task_queue))

    async def wait_for_refresh():
        return None

    fake.continue_as_new = fake_continue_as_new
    wf._wait_for_response_schema_refresh = wait_for_refresh
    original = _patch_workflow(fake)
    try:
        context = [{"role": "USER", "text": "keep going"}]
        result = await wf._handle_incomplete(
            {
                "status": "generation_handoff",
                "handoff_task_queue": "navi-agent-tasks@newgen",
                "context": context,
            },
            phase="EXECUTE",
        )
        assert result["status"] == "generation_handoff"
        assert len(continued) == 1
        args, task_queue = continued[0]
        assert task_queue == "navi-agent-tasks@newgen"
        assert args[6] == context
        assert args[11] == "execute_continued"
    finally:
        _restore_workflow(original)


async def test_workflow_generation_handoff_plan_phase_resumes_plan():
    """PLAN-phase cutover must continue_as_new with start_phase=plan, not execute."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-plan-handoff"
    wf.user_id = "user-1"
    wf.goal = "finish planning after cutover"
    wf.model = "rose-labs/rose-1-ultra"
    wf.reasoning_max_tokens = 256
    wf.verifier = {"type": "FLOAT_LLM_JUDGE"}
    wf.max_iterations = None
    wf.price_limit_cents = 100
    wf.context_gates = {}
    fake = _FakeWorkflowModule()
    continued: List[tuple] = []

    def fake_continue_as_new(*, args, task_queue=None, _continued=continued):
        _continued.append((args, task_queue))

    async def wait_for_refresh():
        return None

    fake.continue_as_new = fake_continue_as_new
    wf._wait_for_response_schema_refresh = wait_for_refresh
    original = _patch_workflow(fake)
    try:
        context = [{"role": "USER", "text": "still planning"}]
        result = await wf._handle_incomplete(
            {
                "status": "generation_handoff",
                "handoff_task_queue": "navi-agent-tasks@newgen",
                "context": context,
            },
            phase="PLAN",
        )
        assert result["status"] == "generation_handoff"
        assert len(continued) == 1
        args, task_queue = continued[0]
        assert task_queue == "navi-agent-tasks@newgen"
        assert args[6] == context
        assert args[11] == "plan"
    finally:
        _restore_workflow(original)


async def test_workflow_paused_handoff_continue_as_new_onto_live_queue():
    """Paused agents still hand off when the live pointer moves to a new generation."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-paused-handoff"
    wf.user_id = "user-1"
    wf.goal = "pause then hand off"
    wf.model = "rose-labs/rose-1-ultra"
    wf.reasoning_max_tokens = 256
    wf.verifier = {"type": "FLOAT_LLM_JUDGE"}
    wf.max_iterations = None
    wf.price_limit_cents = 100
    wf.context_gates = {}
    wf.is_paused = True
    fake = _FakeWorkflowModule()
    continued: List[tuple] = []

    async def fake_wait_for_unpause_or_handoff():
        wf.is_paused = False
        return "navi-agent-tasks@newgen"

    def fake_continue_as_new(*, args, task_queue=None, _continued=continued):
        _continued.append((args, task_queue))

    async def wait_for_refresh():
        return None

    wf._wait_for_unpause_or_handoff = fake_wait_for_unpause_or_handoff
    fake.continue_as_new = fake_continue_as_new
    wf._wait_for_response_schema_refresh = wait_for_refresh
    original = _patch_workflow(fake)
    try:
        context = [{"role": "USER", "text": "paused work"}]
        result = await wf._handle_incomplete(
            {"status": "paused", "context": context},
            phase="EXECUTE",
        )
        assert result["status"] == "paused"
        assert len(continued) == 1
        _args, task_queue = continued[0]
        assert task_queue == "navi-agent-tasks@newgen"
    finally:
        _restore_workflow(original)


async def test_workflow_wait_for_unpause_or_handoff_returns_handoff_queue():
    """Paused cold wait must return a handoff queue without unpausing first."""
    wf = _bare_workflow_instance()
    wf.is_paused = True
    fake = _FakeWorkflowModule()
    fake.activity_returns["fetch_agent_queue_pointer"] = {
        "task_queue": "navi-agent-tasks@newgen",
        "surface_hash": "newgen",
    }

    slices: List[Any] = []

    async def fake_wait_condition(condition, timeout=None):
        assert condition() is False
        slices.append(timeout)
        # No cutover signal arrived: the idle safety slice expires.
        raise asyncio.TimeoutError()

    fake.wait_condition = fake_wait_condition
    original = _patch_workflow(fake)
    try:
        handoff = await wf._wait_for_unpause_or_handoff()
        assert handoff == "navi-agent-tasks@newgen"
        assert wf.is_paused is True
        from helpers.wait_condition_or_handoff import IDLE_HANDOFF_SAFETY_SECONDS

        # No 30s polling while paused: one pointer read, after one safety slice.
        assert [t.total_seconds() for t in slices] == [IDLE_HANDOFF_SAFETY_SECONDS], slices
        assert [name for name, _ in fake.activity_calls] == ["fetch_agent_queue_pointer"]

        # A cutover signal hands a paused agent off before any slice elapses.
        signalled = _bare_workflow_instance()
        signalled.is_paused = True
        signalled.generation_handoff_available("navi-agent-tasks@newgen")
        signalled.generation_handoff_available("navi-agent-tasks@newgen")  # duplicate: no-op
        assert signalled._generation_handoff_hint_seq == 1
        slices.clear()
        assert await signalled._wait_for_unpause_or_handoff() == "navi-agent-tasks@newgen"
        assert slices == []
    finally:
        _restore_workflow(original)


async def test_workflow_generation_handoff_preserves_cost_limit_state():
    """Cooperative handoff must carry COST_LIMIT_REACHED through continue_as_new."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-handoff-cost"
    wf.user_id = "user-1"
    wf.goal = "hand off while cost limited"
    wf.model = "rose-labs/rose-1-ultra"
    wf.reasoning_max_tokens = 256
    wf.verifier = {"type": "FLOAT_LLM_JUDGE"}
    wf.max_iterations = None
    wf.price_limit_cents = 100
    wf.context_gates = {}
    wf.is_paused = True
    wf._cost_limit_reached = True
    wf._resume_prior_status = "COST_LIMIT_REACHED"
    fake = _FakeWorkflowModule()
    continued: List[tuple] = []

    def fake_continue_as_new(*, args, task_queue=None, _continued=continued):
        _continued.append((args, task_queue))

    async def wait_for_refresh():
        return None

    fake.continue_as_new = fake_continue_as_new
    wf._wait_for_response_schema_refresh = wait_for_refresh
    original = _patch_workflow(fake)
    try:
        context = [{"role": "USER", "text": "cost limited work"}]
        result = await wf._handle_incomplete(
            {
                "status": "generation_handoff",
                "handoff_task_queue": "navi-agent-tasks@newgen",
                "context": context,
            },
            phase="EXECUTE",
        )
        assert result["status"] == "generation_handoff"
        assert len(continued) == 1
        args, task_queue = continued[0]
        assert task_queue == "navi-agent-tasks@newgen"
        resume_state = args[16]
        assert resume_state["prior_status"] == "COST_LIMIT_REACHED"
    finally:
        _restore_workflow(original)


async def test_workflow_context_overflow_uses_complete_continuation_contract():
    """Context compaction carries the same runtime snapshot as pause/resume."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-overflow"
    wf.user_id = "user-1"
    wf.goal = "continue after compaction"
    wf.model = "rose-labs/rose-1-ultra"
    wf.reasoning_max_tokens = 256
    wf.verifier = {"type": "FLOAT_LLM_JUDGE"}
    wf.max_iterations = None
    wf.price_limit_cents = 100
    wf.context_gates = {}
    wf.iteration_offset = 27
    wf.token_count = 500
    wf.tokens_in = 350
    wf.tokens_out = 150
    wf.compute_token_provider = "gpt"
    wf.gpt_code_token = "cached-gpt"
    fake = _FakeWorkflowModule()
    continued = []

    def fake_continue_as_new(*, args):
        continued.append(args)

    async def wait_for_refresh():
        return None

    fake.continue_as_new = fake_continue_as_new
    wf._wait_for_response_schema_refresh = wait_for_refresh
    original = _patch_workflow(fake)
    try:
        compressed = [{"role": "SYSTEM", "text": "compressed"}]
        await wf._handle_context_overflow(compressed)
        assert len(continued) == 1
        args = continued[0]
        assert args[6] == compressed
        assert args[12] is None
        assert args[16]["iteration_offset"] == 27
        assert args[16]["token_count"] == 500
        assert "gpt_code_token" not in args[16]["runtime_state"]
        assert "claude_max_token" not in args[16]["runtime_state"]
    finally:
        _restore_workflow(original)


class _ContinuationFakeWorkflow(_FakeWorkflowModule):
    """Fake workflow module with history size and a settle-aware wait_condition."""

    def __init__(self, history_length: int = 100, history_size: int = 10_000):
        super().__init__()
        self.history_length = history_length
        self.history_size = history_size
        self.continued: List[Dict[str, Any]] = []
        self.waits: List[Any] = []
        self.on_wait: Any = None

    def info(self):
        fake = self

        class _Info:
            task_queue = "navi-agent-tasks@testgen"

            def get_current_history_length(self):
                return fake.history_length

            def get_current_history_size(self):
                return fake.history_size

        return _Info()

    async def wait_condition(self, condition, timeout=None):
        self.waits.append(timeout)
        if self.on_wait is not None:
            await self.on_wait()
        if not condition():
            raise asyncio.TimeoutError()

    def continue_as_new(self, *, args, task_queue=None):
        self.continued.append({"args": args, "task_queue": task_queue})


def _overflow_workflow_with_background(agent_type: str):
    """Bare workflow with one in-flight activity-backed background task (bg_t1)."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-overflow-bg"
    wf.user_id = "user-1"
    wf.goal = "keep the background browser"
    wf.model = "rose-labs/rose-1-flash"
    wf.reasoning_max_tokens = 256
    wf.verifier = {"type": "FLOAT_LLM_JUDGE"}
    wf.max_iterations = None
    wf.price_limit_cents = 100
    wf.context_gates = {}

    async def wait_for_refresh():
        return None

    wf._wait_for_response_schema_refresh = wait_for_refresh
    release = asyncio.Event()
    wf._background_tasks["t1"] = {
        "tool_call_id": "t1",
        "tool_args": {"type": agent_type, "goal": "checkout"},
        "agent_type": agent_type,
        "address": "/root/checkout",
        "status": "running",
        "child_agent_ids": [],
    }

    async def background_activity():
        await release.wait()
        # A drained browser parks with its step resume state before returning.
        wf._background_tasks["t1"]["resume"] = {"activity": {"step_count": 7}}

    wf._background_handles["t1"] = asyncio.create_task(background_activity())
    return wf, release


async def test_context_overflow_defers_continue_as_new_while_background_task_runs():
    """Overflow must not abandon an in-flight background browser/explore (it would restart from scratch)."""
    for agent_type in ("browser", "explore", "code"):
        wf, release = _overflow_workflow_with_background(agent_type)
        fake = _ContinuationFakeWorkflow()
        original = _patch_workflow(fake)
        try:
            compressed = [{"role": "SYSTEM", "text": "compressed"}]
            wf.context = [{"role": "USER", "text": f"uncompressed {i}"} for i in range(50)]
            await wf._handle_context_overflow(compressed)
            handle = wf._background_handles["t1"]
            assert fake.continued == [], f"{agent_type}: continue_as_new abandoned the in-flight task"
            # The run keeps going on the compressed context, exactly as the continued run
            # would: later continue_as_new(self.context) paths must not carry the old history.
            assert wf.context == compressed and wf.context is not compressed, agent_type
            assert not handle.done() and not handle.cancelled(), agent_type
            assert fake.waits == [], f"{agent_type}: deferral must not block the LLM loop"
            assert any(name == "post_agent_message" for name, _ in fake.activity_calls), "context reset chip"
            # Once the task has finished, the next overflow continues as new normally.
            release.set()
            await handle
            wf._background_handles.pop("t1", None)
            await wf._handle_context_overflow(compressed)
            assert len(fake.continued) == 1 and fake.continued[0]["args"][6] == compressed, agent_type
        finally:
            _restore_workflow(original)
            release.set()


async def test_context_overflow_at_history_limit_settles_background_task_then_continues():
    """History pressure forces continue_as_new, but only after a bounded settle for in-flight tasks."""
    from workflows.agent_workflow import CONTINUATION_BACKGROUND_SETTLE_SECONDS, OVERFLOW_DEFER_MAX_HISTORY_EVENTS

    wf, release = _overflow_workflow_with_background("browser")
    fake = _ContinuationFakeWorkflow(history_length=OVERFLOW_DEFER_MAX_HISTORY_EVENTS)
    handle = wf._background_handles["t1"]

    async def task_parks_during_settle():
        release.set()
        await handle
        wf._background_handles.pop("t1", None)

    fake.on_wait = task_parks_during_settle
    original = _patch_workflow(fake)
    try:
        await wf._handle_context_overflow([{"role": "SYSTEM", "text": "compressed"}])
        assert [t.total_seconds() for t in fake.waits] == [CONTINUATION_BACKGROUND_SETTLE_SECONDS]
        assert len(fake.continued) == 1
        snapshot = fake.continued[0]["args"][16]["runtime_state"]["background_agents"]["tasks"]["t1"]
        assert snapshot.get("resume") == {"activity": {"step_count": 7}}, snapshot
    finally:
        _restore_workflow(original)
        release.set()


async def test_generation_handoff_settles_in_flight_background_task_before_continue_as_new():
    """Root handoff racing a background browser's park must carry its resume state (flake root cause)."""
    from workflows.agent_workflow import CONTINUATION_BACKGROUND_SETTLE_SECONDS

    wf, release = _overflow_workflow_with_background("browser")
    fake = _ContinuationFakeWorkflow()
    handle = wf._background_handles["t1"]

    async def task_parks_during_settle():
        release.set()
        await handle
        wf._background_handles.pop("t1", None)

    fake.on_wait = task_parks_during_settle
    original = _patch_workflow(fake)
    try:
        await wf._handle_incomplete(
            {"status": "generation_handoff", "handoff_task_queue": "navi-agent-tasks@newgen", "context": []},
            "EXECUTE",
        )
        assert [t.total_seconds() for t in fake.waits] == [CONTINUATION_BACKGROUND_SETTLE_SECONDS]
        assert len(fake.continued) == 1 and fake.continued[0]["task_queue"] == "navi-agent-tasks@newgen"
        snapshot = fake.continued[0]["args"][16]["runtime_state"]["background_agents"]["tasks"]["t1"]
        assert snapshot.get("resume") == {"activity": {"step_count": 7}}, (
            f"handoff continued before the background browser parked: {snapshot}"
        )
    finally:
        _restore_workflow(original)
        release.set()


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


async def test_workflow_handle_incomplete_max_iterations_fast_mode_completes():
    """Demo Fast Mode + 100% verifier after a cached trajectory must COMPLETE, not FAIL."""
    from utils.oai_demo import OAI_DEMO_CHILD_GOAL_PREFIX

    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.goal = f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky — Huberman"
    wf.parent_workflow_id = None
    wf.fast_mode_cache_enabled = True
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        events = []

        async def wait_for_refresh():
            events.append("refresh")

        async def mark_failed(**_kwargs):
            events.append("failed")

        async def mark_complete(*_args, **_kwargs):
            events.append("complete")

        wf._wait_for_response_schema_refresh = wait_for_refresh
        wf._mark_failed = mark_failed
        wf._mark_complete = mark_complete
        result = await wf._handle_incomplete(
            {
                "status": "max_iterations",
                "context": [],
                "verifier_progress": 1.0,
                "verifier_reasoning": ("Fast Mode cache trajectory ended; prior tool evidence is sufficient"),
            },
            phase="EXECUTE",
        )
        assert result["status"] == "completed"
        assert events == ["refresh", "complete"]
    finally:
        _restore_workflow(original)


async def test_workflow_handle_incomplete_max_iterations_fast_mode_fails_outside_demo():
    """Live Fast Mode hitting the step cap must still FAIL."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.user_id = "u"
    wf.goal = "Order a Vanilla Bean Shakerato from Blue Bottle"
    wf.parent_workflow_id = None
    wf.fast_mode_cache_enabled = True
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        events = []

        async def wait_for_refresh():
            events.append("refresh")

        async def mark_failed(**_kwargs):
            events.append("failed")

        async def mark_complete(*_args, **_kwargs):
            events.append("complete")

        wf._wait_for_response_schema_refresh = wait_for_refresh
        wf._mark_failed = mark_failed
        wf._mark_complete = mark_complete
        result = await wf._handle_incomplete(
            {
                "status": "max_iterations",
                "context": [],
                "verifier_progress": 1.0,
                "verifier_reasoning": ("Fast Mode cache trajectory ended; prior tool evidence is sufficient"),
            },
            phase="EXECUTE",
        )
        assert result["status"] == "failed"
        assert result["reason"] == "max_iterations"
        assert events == ["refresh", "failed"]
    finally:
        _restore_workflow(original)


async def test_workflow_handle_incomplete_error():
    """Canonical retry exhaustion reaches its existing outcome without another call."""
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
            raise AssertionError("error outcome retried an already exhausted schema call")

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
        assert events == ["failed"]
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
    checks = 0

    async def fake_exec(fn, args=None, **kwargs):
        nonlocal checks
        name = getattr(fn, "__name__", "")
        fake.activity_calls.append((name, args))
        if name == "check_user_usage":
            checks += 1
            if checks == 2:
                return None  # transient post-Checkout read; the workflow must recheck
            return {
                "has_credits": checks > 2,
                "remaining": 30 if checks > 2 else 0,
                "used": 0.01,
                "total": 30.01 if checks > 2 else 0.01,
                "tier": 30 if checks > 2 else None,
            }
        if name == "mint_subscription_checkout_activity":
            return "https://roselabs.ai/s/free-credit"
        return None

    fake.execute_activity = fake_exec
    fake.activity_returns["mint_subscription_checkout_activity"] = "https://roselabs.ai/s/free-credit"
    raised = {}

    async def fake_raise_gate(workflow_instance, gate, gate_key):
        raised["workflow"] = workflow_instance
        raised["gate"] = gate
        raised["gate_key"] = gate_key
        raised["paused_at_raise"] = workflow_instance.is_paused
        return "resolved"

    original_workflow = _patch_workflow(fake)
    original_raise_gate = workflow_module.raise_gate_direct
    workflow_module.raise_gate_direct = fake_raise_gate
    try:
        await wf._check_credits()
        assert wf._has_credits is True
        assert wf.is_paused is False
        assert raised["paused_at_raise"] is False
        assert raised["workflow"] is wf
        assert raised["gate_key"] == "subscription"
        assert raised["gate"]["type"] == "subscription"
        assert raised["gate"]["action"]["url"] == "https://roselabs.ai/s/free-credit"
        assert raised["gate"]["presentation"]["title"] == "Subscribe to continue this task"
        assert raised["gate"]["presentation"]["reason"].startswith("Your free credits are exhausted")
        activity_names = [name for name, _args in fake.activity_calls]
        assert activity_names == [
            "check_user_usage",
            "mint_subscription_checkout_activity",
            "check_user_usage",
            "check_user_usage",
        ]
    finally:
        workflow_module.raise_gate_direct = original_raise_gate
        _restore_workflow(original_workflow)


async def test_subscription_credit_recheck_preserves_concurrent_pause():
    import workflows.agent_workflow as workflow_module

    wf = _bare_workflow_instance()
    wf.user_id = "u-free-credit"
    wf.agent_id = "a-free-credit"
    fake = _FakeWorkflowModule()
    checks = 0

    async def fake_exec(fn, args=None, **kwargs):
        nonlocal checks
        name = getattr(fn, "__name__", "")
        if name == "check_user_usage":
            checks += 1
            if checks == 2:
                wf.is_paused = True  # pause signal while the post-Checkout activity is pending
            return {"has_credits": checks > 1, "tier": 30 if checks > 1 else None}
        if name == "mint_subscription_checkout_activity":
            return "https://roselabs.ai/s/free-credit"
        return None

    fake.execute_activity = fake_exec

    async def fake_raise_gate(workflow_instance, gate, gate_key):
        return "resolved"

    original_workflow = _patch_workflow(fake)
    original_raise_gate = workflow_module.raise_gate_direct
    workflow_module.raise_gate_direct = fake_raise_gate
    try:
        await wf._check_credits()
        assert checks == 2
        assert wf._has_credits is True
        assert wf.is_paused is True
    finally:
        workflow_module.raise_gate_direct = original_raise_gate
        _restore_workflow(original_workflow)


async def test_workflow_check_credits_free_credit_checkout_failure_pauses():
    """Checkout URL failures still raise the blocking subscription gate with its default action."""
    import workflows.agent_workflow as workflow_module

    wf = _bare_workflow_instance()
    wf.user_id = "u-free-credit"
    wf.agent_id = "a-free-credit"
    fake = _FakeWorkflowModule()
    raised = {}

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

    async def fake_raise_gate(workflow_instance, gate, gate_key):
        raised["workflow"] = workflow_instance
        raised["gate"] = gate
        raised["gate_key"] = gate_key
        raised["paused_at_raise"] = workflow_instance.is_paused
        return "resolved"

    fake.execute_activity = fake_exec
    original = _patch_workflow(fake)
    original_raise_gate = workflow_module.raise_gate_direct
    workflow_module.raise_gate_direct = fake_raise_gate
    try:
        await wf._check_credits()
        assert wf._has_credits is False
        assert wf.is_paused is True
        assert raised["workflow"] is wf
        assert raised["gate_key"] == "subscription"
        assert raised["paused_at_raise"] is False
        assert raised["gate"]["type"] == "subscription"
        assert raised["gate"]["severity"] == "blocking"
        assert raised["gate"]["action"]["url"] == "https://roselabs.ai/subscribe"
    finally:
        workflow_module.raise_gate_direct = original_raise_gate
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


async def test_workflow_synthesizes_root_cloud_agent_lifecycle_without_chip():
    """Root workflows without a chat cloud_agent chip synthesize lifecycle updates."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.parent_workflow_id = None
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
        assert len(posts) == 2
        assert posts[0][1][3]["toolCallId"] == "tc-cloud-agent-a"
        assert posts[0][1][3]["toolName"] == "cloud_agent"
        assert posts[0][1][3]["title"] == "Preparing Cloud Agent"
        assert posts[1][1][3]["title"] == "Cloud Agent Ready"
        assert posts[1][1][3]["toolStatus"] == "FINISHED"
        assert wf._cloud_agent_lifecycle_finished is True
    finally:
        _restore_workflow(original)


async def test_workflow_caches_missing_cloud_agent_tool():
    """Sub-agents without a cloud_agent row should stop rescanning after one miss."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a"
    wf.parent_workflow_id = "parent-wf"
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
        assert all(call["check_aborted"] == wf._check_orphaned for call in run_agent_calls)
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
        assert schema_calls[0][1][4] is True
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


async def test_workflow_run_deployment_resume_skips_startup_replay_and_restores_iteration():
    """A deployment replacement resumes the LLM loop without replaying startup, PLAN, or DAG."""
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    fake.activity_returns.update(
        {
            "poll_new_messages": [
                {
                    "role": "TOOL",
                    "text": "Historical plan",
                    "metadata": {
                        "toolName": "set_plan",
                        "toolStatus": "FINISHED",
                        "data": {
                            "tasks": [{"goal": "must not replay", "tool_name": "web_search"}],
                            "dependencies": {},
                            "join": "all",
                        },
                    },
                }
            ],
            "get_model_context_window": 200_000,
            "get_agent_source": "SMS",
            "get_user_context": "remembered context",
            "get_user_system_name": "Navi",
            "get_user_custom_system_prompt": "Do not inject this twice.",
            "fetch_compute_token_activity": None,
            "fetch_agent_config": {
                "response_schema": {"fields": []},
                "write_lock_enabled": True,
            },
            "finalize_workflow_replacement_bootstrap": {
                "acknowledged": True,
                "already_acknowledged": False,
                "status": "ACTIVE",
            },
            "generate_completion_summary": {
                "summary": "Resumed and finished.",
                "tool_counts": {},
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            },
        }
    )

    import workflows.agent_workflow as workflow_module

    original_workflow = _patch_workflow(fake)
    original_run_agent = workflow_module.run_agent
    run_agent_calls = []

    async def fake_run_agent(**kwargs):
        run_agent_calls.append(kwargs)
        return {
            "status": "completed",
            "context": [{"role": "ASSISTANT", "text": "done", "metadata": None}],
            "structured_response": None,
            "token_count": 0,
            "context_size": 42_000,
        }

    workflow_module.run_agent = fake_run_agent
    try:
        result = await wf.run(
            "agent-resume-1",
            "user-run-1",
            "Continue the task",
            "anthropic/claude-sonnet-4.5",
            256,
            {"type": "FLOAT_LLM_JUDGE"},
            None,
            None,
            None,
            0,
            "agent-resume-1",
            "resume",
            37,
            250,
            {"network": True},
            False,
            _deployment_resume_fixture(),
        )

        assert result == {"status": "completed", "goal": "Continue the task"}
        assert len(run_agent_calls) == 1
        assert run_agent_calls[0]["iteration_offset"] == 6
        assert run_agent_calls[0]["max_iterations"] == 37
        assert run_agent_calls[0]["check_aborted"] == wf._check_orphaned
        assert "is_plan_loop" not in run_agent_calls[0]

        activity_names = [call[0] for call in fake.activity_calls]
        assert activity_names[:2] == [
            "fetch_agent_config",
            "finalize_workflow_replacement_bootstrap",
        ]
        started_sms = [
            call
            for call in fake.activity_calls
            if call[0] == "notify_sms_event_activity" and call[1][1] == "agent_started"
        ]
        init_posts = [
            call
            for call in fake.activity_calls
            if call[0] == "post_agent_message" and (call[1][3] or {}).get("toolName") == "agent_init"
        ]
        hidden_prompt_posts = [
            call
            for call in fake.activity_calls
            if call[0] == "post_agent_message" and (call[1][3] or {}).get("isCustomSystemPrompt")
        ]
        startup_status = next(
            call for call in fake.activity_calls if call[0] == "finalize_workflow_replacement_bootstrap"
        )
        persisted_startup = next(call for call in fake.activity_calls if call[0] == "update_agent_status")
        assert startup_status[1][1] == "ACTIVE"
        assert startup_status[1][2] == 0.4
        assert startup_status[1][4:9] == [950, 42_000, 73, 680, 270]
        assert persisted_startup[1][4:9] == [950, 42_000, 73, 680, 270]
        assert started_sms == []
        assert init_posts == []
        assert hidden_prompt_posts == []
        assert "set_response_schema_activity" not in activity_names
        assert wf.context_gates == {"network": False, "recent_communications": True}
        assert wf.own_cost_cents == 17.25
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


async def test_workflow_run_missing_parent_stops_before_agent_loop():
    """A child whose parent is already gone fails locally without LLM or tool work."""
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
                "parent_agent_id": "dead-parent-agent",
                "write_lock_enabled": True,
            },
            "query_parent_state_activity": {"parent_missing": True},
        }
    )

    import workflows.agent_workflow as workflow_module

    original_workflow = _patch_workflow(fake)
    original_run_agent = workflow_module.run_agent
    run_agent_calls = []

    async def fake_run_agent(**kwargs):
        run_agent_calls.append(kwargs)
        raise AssertionError("orphan must stop before run_agent")

    workflow_module.run_agent = fake_run_agent
    try:
        result = await wf.run(
            "orphan-child",
            "user-run-1",
            "Must not continue",
            "anthropic/claude-sonnet-4.5",
            256,
            {"type": "FLOAT_LLM_JUDGE"},
            None,
            "dead-parent-workflow",
            "dead-parent-agent",
            1,
            None,
            "execute",
            25,
            250,
            {},
        )

        assert result == {"status": "failed", "reason": "orphaned", "goal": "Must not continue"}
        assert wf._orphaned is True
        assert wf._is_finished is True
        assert run_agent_calls == []
        assert fake.signal_calls == []
    finally:
        workflow_module.run_agent = original_run_agent
        _restore_workflow(original_workflow)


async def test_workflow_dag_user_message_interrupt_reaches_run_agent():
    """A user message mid-DAG: the run wires the interrupt hooks and falls through to run_agent.

    RCA (root 439c77dd): a user correction sat unread >5 min while planned GP
    spawns ran in the foreground. execute_dag now returns needs_llm on the
    first message wake; the workflow must pass its signal-driven hooks and the
    LLM loop must then read the message from the DB.
    """
    from loop.dag_executor import DagInterrupts

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
            "fetch_agent_config": {"response_schema": {"fields": []}, "write_lock_enabled": True},
            # The correction is ordinary feedback: the schema refresh runs as usual.
            "set_response_schema_activity": {
                "schema": {"fields": [{"name": "investors", "type": "str", "required": True}]}
            },
            "generate_completion_summary": {
                "summary": "Handled the correction.",
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
    run_agent_seen = []
    user_row = {
        "message_id": "msg-correction",
        "role": "USER",
        "text": "Only funds that lead pre-seed rounds.",
        "metadata": {},
        "timestamp": "2026-10-19T03:01:57+00:00",
    }

    workflow_module.extract_plan_from_context = lambda _context: {
        "tasks": [{"goal": "Research investors", "tool_name": "spawn_general_purpose_agent"}],
        "dependencies": {},
    }

    async def fake_execute_dag(**kwargs):
        interrupts = kwargs["interrupts"]
        assert isinstance(interrupts, DagInterrupts)
        assert interrupts.await_background == wf._await_dag_background_spawn
        assert interrupts.wait == wf._wait_for_dag_interrupt
        # Planned spawns start in the background during the DAG (like LLM spawns).
        assert wf._background_spawns_enabled is True
        seq = interrupts.seq()
        fake.activity_returns["poll_new_messages"] = [user_row]  # backend wrote the row
        await wf.receive_user_response(user_row["text"])  # then signaled
        assert interrupts.seq() != seq, "a user message must wake the DAG wait"
        return {"status": "needs_llm", "interrupted_by_message": True, "context": kwargs["context"]}

    async def fake_run_agent(**kwargs):
        rows = await kwargs["poll_messages"](datetime.fromtimestamp(0, tz=timezone.utc))
        run_agent_seen.append(rows)
        assert "wait_for_background_agents" not in kwargs  # no idle wait; wait_for owns waiting
        return {
            "status": "completed",
            "context": [{"role": "ASSISTANT", "text": "Updated the plan.", "metadata": None}],
            "structured_response": None,
            "token_count": 3,
            "context_size": 30,
        }

    workflow_module.execute_dag = fake_execute_dag
    workflow_module.run_agent = fake_run_agent
    try:
        result = await wf.run(
            "agent-dag-interrupt",
            "user-run-1",
            "Research investors",
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
        assert run_agent_seen, "an interrupted DAG must fall through to run_agent"
        assert any(row.get("message_id") == "msg-correction" for row in run_agent_seen[0]), run_agent_seen
        assert result == {"status": "completed", "goal": "Research investors"}
    finally:
        workflow_module.extract_plan_from_context = original_extract_plan
        workflow_module.execute_dag = original_execute_dag
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


def _completed_plan_followup_context(*, followup_text: str | None) -> List[Dict[str, Any]]:
    """Prod-shaped transcript: completed DoorDash order plan, optional later USER."""
    plan_payload = {
        "type": "plan_artifact",
        "join": "all",
        "tasks": [
            {
                "goal": "Research the public DoorDash shopping route for ordering one package of Oral-B Glide dental floss.",
                "tool_name": "spawn_explore_agent",
            },
            {
                "goal": "Order one package of Oral-B Glide traditional dental floss through DoorDash.",
                "tool_name": "spawn_browser_agent",
            },
        ],
        "dependencies": {"1": [0]},
    }
    messages: List[Dict[str, Any]] = [
        {
            "role": "USER",
            "text": "order me glide floss from doordash",
            "metadata": None,
        },
        {
            "role": "TOOL",
            "text": "Plan created",
            "metadata": {
                "toolName": "set_plan",
                "toolStatus": "FINISHED",
                "data": plan_payload,
            },
        },
        {
            "role": "TOOL",
            "text": "Explore findings",
            "metadata": {
                "toolName": "spawn_agent",
                "toolStatus": "FINISHED",
                "agentType": "explore",
                "dagTaskIndex": 0,
                "toolCallId": "explore-1",
            },
        },
        {
            "role": "TOOL",
            "text": "Order confirmed dff187de-9b01-45a1-84f7-d9d493a4b070",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "toolStatus": "FINISHED",
                "dagTaskIndex": 1,
                "toolCallId": "browser-1",
            },
        },
        {
            "role": "TOOL",
            "text": "Your DoorDash order is confirmed.",
            "metadata": {
                "toolName": "completion_summary",
                "toolStatus": "FINISHED",
                "isFinalSummary": True,
                "title": "Task Complete",
            },
        },
    ]
    if followup_text is not None:
        messages.append(
            {
                "role": "USER",
                "text": followup_text,
                "metadata": None,
            }
        )
    return messages


def _compacted_completed_plan_followup_context(followup_text: str) -> List[Dict[str, Any]]:
    """What poll_new_messages returns after projecting the last context_reset."""
    return [
        {
            "role": "USER",
            "text": "order me glide floss from doordash",
            "metadata": {},
        },
        {
            "role": "USER",
            "text": "Compaction summary: ordered Oral-B Glide floss on DoorDash; confirmation dff187de.",
            "metadata": {"compactionSummary": True},
        },
        {
            "role": "TOOL",
            "text": "Plan created",
            "metadata": {
                "toolName": "set_plan",
                "toolStatus": "FINISHED",
                "data": {
                    "type": "plan_artifact",
                    "join": "all",
                    "tasks": [
                        {
                            "goal": "Research the public DoorDash shopping route for ordering floss.",
                            "tool_name": "spawn_explore_agent",
                        },
                        {
                            "goal": "Order one package of Oral-B Glide traditional dental floss through DoorDash.",
                            "tool_name": "spawn_browser_agent",
                        },
                    ],
                    "dependencies": {"1": [0]},
                },
            },
        },
        {
            "role": "SYSTEM",
            "text": "",
            "metadata": {
                "toolName": "context_reset",
                "contextCompactionBoundary": True,
                "excludeFromModel": True,
            },
        },
        {
            "role": "TOOL",
            "text": "Your DoorDash order is confirmed.",
            "metadata": {
                "toolName": "completion_summary",
                "toolStatus": "FINISHED",
                "isFinalSummary": True,
            },
        },
        {
            "role": "USER",
            "text": followup_text,
            "metadata": None,
        },
    ]


async def test_workflow_fresh_task_poll_and_reload_exclude_prior_requirements():
    import workflows.agent_workflow as module

    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    followup = "Get a refund for the wrong delivery"
    prior = "Previous task: collect restaurant address and order confirmation"
    history = _completed_plan_followup_context(followup_text=followup)
    history.insert(1, {"id": "previous-correction", "role": "USER", "text": prior})
    replacement = {"fields": [{"name": "refund_status", "type": "str", "required": True}]}
    fake.activity_returns.update(
        {
            "poll_new_messages": history,
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Rose",
            "fetch_agent_config": {
                "response_schema": {"fields": [{"name": "order_id", "type": "str"}]},
                "write_lock_enabled": True,
            },
            "set_response_schema_activity": {"schema": replacement, "usage": {}},
            "generate_completion_summary": {"summary": "Refund handled", "tool_counts": {}, "usage": {}},
        }
    )
    original = _patch_workflow(fake)
    original_run_agent = module.run_agent

    async def execute(**kwargs):
        await kwargs["poll_messages"](datetime.fromtimestamp(0, tz=timezone.utc))
        await wf._wait_for_response_schema_refresh()
        generations = [args[1] for name, args in fake.activity_calls if name == "set_response_schema_activity"]
        assert generations == [[followup]], "fresh execute poll readmitted previous-task requirements"
        # Seeding admission alone is insufficient: durable reload has its own
        # requirement builder and must use this fresh task's authored base.
        requirements = await wf._response_schema_user_messages()
        assert requirements[0] == followup
        assert prior not in requirements and "order me glide floss from doordash" not in requirements
        return {
            "status": "completed",
            "context": history,
            "structured_response": {"refund_status": "refunded"},
            "token_count": 3,
            "context_size": 30,
        }

    module.run_agent = execute
    try:
        result = await wf.run(
            "fresh-boundary-agent",
            "user-1",
            "order me glide floss from doordash",
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
        assert result["status"] == "completed"
    finally:
        module.run_agent = original_run_agent
        _restore_workflow(original)


async def test_workflow_fresh_task_boundary_preserves_source_identity_and_continuation():
    wf, fake, _ = _user_schema_refresh_fixture()
    wf.max_iterations = None
    wf.context_gates = {}
    wf._response_schema_initialized = False
    stamp = "2026-10-15T00:00:00+00:00"
    base = "Return the refund status"
    previous = {
        "id": "prior",
        "role": "USER",
        "text": "Find restaurant address",
        "timestamp": stamp,
        "metadata": {"source": "attention_response", "attentionRequestId": "prior-request"},
    }
    initial = {"id": "base", "role": "USER", "text": base, "timestamp": stamp}
    wf._establish_response_schema_task_boundary([previous, initial])
    assert wf._response_schema_revision == 0
    # A physical retry of a past canonical event is historical, while a new
    # event with identical text can intentionally restore A after B.
    retry = {**previous, "id": "prior-physical-retry", "timestamp": "2026-10-15T00:00:02+00:00"}
    delayed = {
        "id": "late-commit",
        "role": "USER",
        "text": "Keep the receipt",
        "timestamp": "2026-10-14T23:59:59+00:00",
    }
    changes = [
        {
            "id": "change-B",
            "role": "USER",
            "text": "Return the refund amount",
            "timestamp": stamp,
            "metadata": {"source": "attention_response", "attentionRequestId": "request-B"},
        },
        {
            "id": "change-A",
            "role": "USER",
            "text": base,
            "timestamp": stamp,
            "metadata": {"source": "attention_response", "attentionRequestId": "request-A"},
        },
    ]
    wf.context = [previous, initial, delayed, *changes, retry]
    wf._admit_durable_response_schema_feedback()
    assert wf._response_schema_feedback == [delayed["text"], changes[0]["text"], base]
    revision = wf._response_schema_revision
    wf._record_response_schema_feedback(previous["text"], request_id="prior-request", authored=True)
    assert wf._response_schema_revision == revision, "past attention signal retry became fresh feedback"
    carried = wf._continuation_resume_state(wf.context)
    restored = _bare_workflow_instance()
    restored._restore_deployment_state(carried)
    assert restored._response_schema_task_base == base
    assert restored._response_schema_task_baseline_rows == wf._response_schema_task_baseline_rows
    fake.activity_returns["poll_new_messages"] = wf.context
    original = _patch_workflow(fake)
    try:
        requirements = await restored._response_schema_user_messages()
        assert requirements[0] == base
        assert requirements[2:] == [delayed["text"], changes[0]["text"], base], (
            "fresh-task boundary dropped a delayed/same-timestamp source or A -> B -> A reversion"
        )
        restored.context = [previous, initial, {**initial, "id": "repeat-base"}]
        restored._response_schema_feedback = []
        fake.activity_returns["poll_new_messages"] = restored.context
        repeated_base = await restored._response_schema_user_messages()
        assert repeated_base[2:] == [base], (
            "a later real instruction repeating the task base was mistaken for the initial row"
        )
        normal = _bare_workflow_instance()
        normal.goal = "Original task"
        normal.context = [previous, initial]
        fake.activity_returns["poll_new_messages"] = normal.context
        unchanged = await normal._response_schema_user_messages()
        assert unchanged == [normal.goal, previous["text"], base], (
            "ordinary resume unexpectedly acquired a fresh-task boundary"
        )
    finally:
        _restore_workflow(original)


async def test_workflow_fresh_boundary_filters_only_proven_queued_feedback_sources():
    import copy

    wf, fake, _ = _user_schema_refresh_fixture()
    wf.max_iterations = None
    wf.context_gates = {}
    wf._response_schema_initialized = False
    base = "Return the refund status"
    text_a, text_b = "Find restaurant address", "Return the refund amount"
    old = {
        "id": "old-row",
        "role": "USER",
        "text": text_a,
        "metadata": {"source": "attention_response", "attentionRequestId": "old-request"},
    }
    initial = {"id": "fresh-base", "role": "USER", "text": base}
    future = [
        {
            "id": f"future-row-{index}",
            "role": "USER",
            "text": text,
            "metadata": {"source": "attention_response", "attentionRequestId": f"future-request-{index}"},
        }
        for index, text in enumerate((text_a, text_b, text_a))
    ]
    original = _patch_workflow(fake)
    try:
        # All signals can be queued during startup before its durable snapshot
        # establishes a task boundary. Only the old source is in that prefix.
        for row in [old, *future]:
            await wf.receive_user_response(
                json.dumps(
                    {
                        "request_id": row["metadata"]["attentionRequestId"],
                        "response": "RESOLVED",
                        "user_message": row["text"],
                    }
                )
            )
        wf._establish_response_schema_task_boundary([old, initial])
        wf.context = [old, initial, *future]
        fake.activity_returns["poll_new_messages"] = wf.context
        requirements = await wf._response_schema_user_messages()
        assert requirements[0] == base
        assert requirements[2:] == [text_a, text_b, text_a], (
            "a known pre-boundary signal consumed current-source coverage or reintroduced historical requirements"
        )
        revision = wf._response_schema_revision
        await wf.receive_user_response(
            json.dumps({"request_id": "old-request", "response": "RESOLVED", "user_message": text_a})
        )
        assert wf._response_schema_revision == revision
        carried = wf._continuation_resume_state(wf.context)
        restored = _bare_workflow_instance()
        restored._restore_deployment_state(carried)
        assert await restored._response_schema_user_messages() == requirements
        assert restored._response_schema_feedback_sources == wf._response_schema_feedback_sources
        # Older/manual snapshots have no proven source for their text. Preserve
        # those occurrences instead of guessing which historical row they mean.
        legacy = _bare_workflow_instance()
        legacy._response_schema_feedback = [text_a]
        legacy._record_response_schema_feedback(text_b, request_id="new-source", authored=True)
        assert legacy._response_schema_feedback_sources == [None, ("attention_response", "new-source")]
        malformed = copy.deepcopy(carried)
        malformed["runtime_state"]["response_schema_feedback"] = [text_a, 17, text_b]
        malformed["runtime_state"]["response_schema_feedback_sources"] = [
            "unknown",
            ["id", "invalid-text"],
            ["attention_response", "new-source"],
        ]
        legacy._restore_deployment_state(malformed)
        assert legacy._response_schema_feedback == [text_a, text_b]
        assert legacy._response_schema_feedback_sources == [None, ("attention_response", "new-source")]
        legacy._response_schema_initialized = False
        legacy.context = [{"id": "later-row", "role": "USER", "text": "Keep the receipt"}]
        legacy._admit_durable_response_schema_feedback()
        assert legacy._response_schema_feedback_sources[-1] == ("id", "later-row")
    finally:
        _restore_workflow(original)


async def _exercise_fresh_start_schema_acceptance(
    *, generation_fails=False, invalid_schema=False, persistence_fails=False
):
    """Run the real fresh-start and terminal paths against a stale database row."""
    import workflows.agent_workflow as module

    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    followup = "get a refund, the doordasher delivered to the wrong location"
    stale_schema = {"fields": [{"name": "order_confirmation_id", "type": "str", "required": True}]}
    replacement = {"fields": [{"name": "refund_status", "type": "str", "required": True}]}
    fake.activity_returns.update(
        {
            "poll_new_messages": _completed_plan_followup_context(followup_text=followup),
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Navi",
            "fetch_agent_config": {"response_schema": stale_schema, "write_lock_enabled": True},
            "set_response_schema_activity": {"schema": {"fields": []} if invalid_schema else replacement, "usage": {}},
            "generate_completion_summary": {"summary": "Refund handled", "tool_counts": {}, "usage": {}},
        }
    )
    if generation_fails:
        fake.activity_fail_for.add("set_response_schema_activity")
    if persistence_fails:
        fake.activity_fail_for.add("persist_response_schema_activity")
    original = _patch_workflow(fake)
    original_run_agent = module.run_agent

    async def completed_turn(**kwargs):
        return {
            "status": "completed",
            "context": _completed_plan_followup_context(followup_text=followup),
            "structured_response": {"refund_status": "refunded"},
            "token_count": 3,
            "context_size": 30,
        }

    module.run_agent = completed_turn
    error = None
    result = None
    try:
        try:
            result = await wf.run(
                "fresh-schema-agent",
                "fresh-schema-user",
                "order me glide floss from doordash",
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
        except RuntimeError as exc:
            error = exc
        if generation_fails or invalid_schema:
            assert isinstance(error, RuntimeError), "fake completion accepted ungenerated requirements"
            assert result is None
            assert wf.output_schema is None, "completion restored a schema from the completed prior task"
            assert not wf._is_finished, "schema prerequisite invented a new terminal-failure policy"
            assert wf._response_schema_applied_revision < wf._response_schema_revision
            assert not any(name == "update_agent_status" and args[1] == "FAILED" for name, args in fake.activity_calls)
            assert not any(
                name in ("mark_finished", "generate_completion_summary") for name, _args in fake.activity_calls
            )
            assert sum(name == "fetch_agent_config" for name, _args in fake.activity_calls) == 1, (
                "completion reloaded the stale schema"
            )
        else:
            assert error is None, (
                f"accepted fresh-start contract failed after lost persistence acknowledgement: {error}"
            )
            assert result["status"] == "completed"
            assert wf.output_schema == replacement
            assert wf._response_schema_accepted_revision == wf._response_schema_revision > 0
            assert await wf._make_response_schema_getter()() == replacement
            assert any(name == "persist_response_schema_activity" for name, _args in fake.activity_calls)
            assert sum(name == "fetch_agent_config" for name, _args in fake.activity_calls) == 1
        return wf, fake
    finally:
        module.run_agent = original_run_agent
        _restore_workflow(original)


async def test_workflow_fresh_start_generation_failure_cannot_restore_completed_task_schema():
    await _exercise_fresh_start_schema_acceptance(generation_fails=True)


async def test_workflow_fresh_start_empty_schema_cannot_restore_completed_task_schema():
    await _exercise_fresh_start_schema_acceptance(invalid_schema=True)


async def test_workflow_fresh_start_accepted_schema_survives_lost_persistence_ack():
    await _exercise_fresh_start_schema_acceptance(persistence_fails=True)


async def test_workflow_fresh_start_unchanged_schema_is_accepted_before_persistence():
    wf, fake, replacement = _user_schema_refresh_fixture()
    wf._response_schema_initialized = False
    wf.output_schema = replacement
    wf.max_iterations, wf.context_gates = 30, {}
    persistence_ack = asyncio.Event()
    fake.activity_blockers["persist_response_schema_activity"] = persistence_ack
    original = _patch_workflow(fake)
    task = None
    try:
        task = asyncio.create_task(
            wf._regenerate_output_schema_for_new_instruction(
                [
                    {"role": "USER", "text": "Research venue prices"},
                ]
            )
        )
        await asyncio.sleep(0)
        assert wf._response_schema_accepted_revision == wf._response_schema_revision > 0, (
            "unchanged fresh-start schema was not accepted natively"
        )
        assert wf.output_schema is replacement
        assert any(name == "persist_response_schema_activity" for name, _args in fake.activity_calls)
        restored = _bare_workflow_instance()
        restored._restore_deployment_state(wf._continuation_resume_state(wf.context))
        assert restored.output_schema == replacement
        assert restored._response_schema_accepted_revision == wf._response_schema_accepted_revision
        persistence_ack.set()
        await task
        assert await wf._make_response_schema_getter()() == replacement
    finally:
        persistence_ack.set()
        if task is not None:
            await task
        _restore_workflow(original)


async def test_workflow_mark_complete_refuses_failed_fresh_start_before_terminal_effects():
    wf, fake, _replacement = _user_schema_refresh_fixture()
    wf._response_schema_initialized = False
    wf.output_schema = None
    fake.activity_fail_for.add("set_response_schema_activity")
    fake.activity_returns["fetch_agent_config"] = {"response_schema": {"fields": [{"name": "old_task", "type": "str"}]}}
    original = _patch_workflow(fake)
    try:
        await wf._regenerate_output_schema_for_new_instruction([{"role": "USER", "text": "Research venue prices"}])
        try:
            await wf._mark_complete([], {"old_task": "done"})
        except RuntimeError:
            pass
        else:
            raise AssertionError("direct terminal path accepted failed fresh-start schema generation")
        assert not wf._is_finished
        assert not any(
            name in ("fetch_agent_config", "generate_completion_summary", "mark_finished")
            for name, _args in fake.activity_calls
        )
    finally:
        _restore_workflow(original)


async def test_workflow_fresh_start_discards_schema_superseded_during_generation():
    wf, fake, replacement = _user_schema_refresh_fixture()
    wf._response_schema_initialized = False
    wf.output_schema = None
    blocker = asyncio.Event()
    fake.activity_blockers["set_response_schema_activity"] = blocker
    original = _patch_workflow(fake)
    try:
        task = asyncio.create_task(
            wf._regenerate_output_schema_for_new_instruction([{"role": "USER", "text": "Research venue prices"}])
        )
        await asyncio.sleep(0)
        await wf.receive_user_response("Actually, return only venue opening hours")
        blocker.set()
        await task
        assert wf.output_schema is None, "fresh-start adopted a candidate superseded while generating"
        assert wf._response_schema_accepted_revision < wf._response_schema_revision
        assert not any(name == "persist_response_schema_activity" for name, _args in fake.activity_calls)
        generation_args = next(args for name, args in fake.activity_calls if name == "set_response_schema_activity")
        assert generation_args[5] is False, "superseded generation was allowed to persist before native acceptance"
    finally:
        blocker.set()
        _restore_workflow(original)


async def test_workflow_fresh_start_keeps_feedback_received_before_generation_pending():
    wf, fake, replacement = _user_schema_refresh_fixture()
    wf._response_schema_initialized = False
    wf.output_schema = None
    followup = "Research venue prices"
    correction = "Actually, return only venue opening hours"
    fake.activity_returns["poll_new_messages"] = [
        {"id": "followup", "role": "USER", "text": followup},
        {"id": "correction", "role": "USER", "text": correction},
    ]
    original = _patch_workflow(fake)
    try:
        await wf.receive_user_response(correction)
        await wf._regenerate_output_schema_for_new_instruction([{"role": "USER", "text": followup}])
        wf._response_schema_initialized = True
        wf._start_response_schema_refresh()
        await wf._wait_for_response_schema_refresh()
        generation_inputs = [args[1] for name, args in fake.activity_calls if name == "set_response_schema_activity"]
        assert any(correction in messages for messages in generation_inputs), (
            "fresh-start acceptance consumed earlier queued feedback without generating from it"
        )
        assert wf._response_schema_accepted_revision == wf._response_schema_revision
        assert wf.output_schema == replacement
        assert wf._response_schema_feedback == [correction]
    finally:
        _restore_workflow(original)


async def test_workflow_execute_skips_stale_plan_after_completion_followup():
    """Post-completion follow-up must not replay the completed DAG.

    RCA agent 601d673f: after Task Complete, "get a refund..." re-escalated with
    start_phase=execute. extract_plan_from_context still found the original
    set_plan, and execute_dag re-ran explore+order instead of the refund.
    """
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    followup = "get a refund, the doordasher delivered to the wrong location"
    fake.activity_returns.update(
        {
            "poll_new_messages": _completed_plan_followup_context(followup_text=followup),
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Navi",
            "get_user_custom_system_prompt": None,
            "fetch_compute_token_activity": None,
            "fetch_agent_config": {
                "response_schema": {
                    "fields": [
                        {"name": "order_confirmation_id", "type": "str", "required": True},
                        {"name": "product_name", "type": "str", "required": True},
                        {"name": "platform", "type": "str", "required": True},
                    ]
                },
                "write_lock_enabled": True,
            },
            "set_response_schema_activity": {
                "schema": {
                    "fields": [
                        {"name": "refund_confirmation_id", "type": "str", "required": True},
                        {"name": "refund_status", "type": "str", "required": True},
                    ]
                },
                "usage": {},
            },
            "generate_completion_summary": {
                "summary": "Refund follow-up should not replay the order DAG.",
                "tool_counts": {},
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            },
        }
    )

    import workflows.agent_workflow as workflow_module

    original_workflow = _patch_workflow(fake)
    original_execute_dag = workflow_module.execute_dag
    original_run_agent = workflow_module.run_agent
    dag_calls = []
    run_agent_calls = []

    async def fake_execute_dag(**kwargs):
        dag_calls.append(kwargs)
        return {"status": "completed", "context": kwargs.get("context") or []}

    async def fake_run_agent(**kwargs):
        # run_agent polls the DB itself (initial_context is intentionally None
        # after DAG skip). The poll fixture already contains the refund USER row.
        run_agent_calls.append(kwargs)
        return {
            "status": "completed",
            "context": _completed_plan_followup_context(followup_text=followup),
            "structured_response": None,
            "token_count": 3,
            "context_size": 30,
        }

    workflow_module.execute_dag = fake_execute_dag
    workflow_module.run_agent = fake_run_agent
    try:
        result = await wf.run(
            "agent-stale-plan-followup",
            "user-run-1",
            "order me glide floss from doordash",
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

        assert dag_calls == [], (
            "a USER message after completion_summary must not re-run the completed DAG; "
            f"execute_dag was called {len(dag_calls)} time(s)"
        )
        assert run_agent_calls, "stale completed plan must fall through to run_agent with the new USER instruction"
        assert result == {"status": "completed", "goal": "order me glide floss from doordash"}
        schema_calls = [c for c in fake.activity_calls if c[0] == "set_response_schema_activity"]
        assert schema_calls, "superseded execute must regenerate output_schema from the new USER instruction"
        assert schema_calls[0][1][1] == [followup], (
            "schema generation must use the latest USER follow-up, not the persisted Agent.goal"
        )
        assert schema_calls[0][1][4] is False
        assert wf.output_schema == {
            "fields": [
                {"name": "refund_confirmation_id", "type": "str", "required": True},
                {"name": "refund_status", "type": "str", "required": True},
            ]
        }
        assert "refund_confirmation_id" in await wf.build_system_prompt()
        schema_messages = [
            c
            for c in fake.activity_calls
            if c[0] == "post_agent_message" and (c[1][3] or {}).get("isResponseSchemaUpdate") is True
        ]
        assert not schema_messages, "schema regeneration must use native state without a fabricated USER row"
    finally:
        workflow_module.execute_dag = original_execute_dag
        workflow_module.run_agent = original_run_agent
        _restore_workflow(original_workflow)


async def test_workflow_execute_nulled_schema_does_not_regenerate_from_old_goal():
    """Backend-nulled schema must not be rebuilt from Agent.goal on execute follow-up."""
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    followup = "get a refund, the doordasher delivered to the wrong location"
    fake.activity_returns.update(
        {
            "poll_new_messages": _completed_plan_followup_context(followup_text=followup),
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Navi",
            "get_user_custom_system_prompt": None,
            "fetch_compute_token_activity": None,
            "fetch_agent_config": {
                "response_schema": None,
                "write_lock_enabled": True,
            },
            "set_response_schema_activity": {
                "schema": {
                    "fields": [
                        {"name": "refund_status", "type": "str", "required": True},
                    ]
                },
                "usage": {},
            },
            "generate_completion_summary": {
                "summary": "Refund follow-up should not replay the order DAG.",
                "tool_counts": {},
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            },
        }
    )

    import workflows.agent_workflow as workflow_module

    original_workflow = _patch_workflow(fake)
    original_execute_dag = workflow_module.execute_dag
    original_run_agent = workflow_module.run_agent
    dag_calls = []

    async def fake_execute_dag(**kwargs):
        dag_calls.append(kwargs)
        return {"status": "completed", "context": kwargs.get("context") or []}

    async def fake_run_agent(**kwargs):
        return {
            "status": "completed",
            "context": _completed_plan_followup_context(followup_text=followup),
            "structured_response": None,
            "token_count": 3,
            "context_size": 30,
        }

    workflow_module.execute_dag = fake_execute_dag
    workflow_module.run_agent = fake_run_agent
    try:
        await wf.run(
            "agent-nulled-schema-followup",
            "user-run-1",
            "order me glide floss from doordash",
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
        assert dag_calls == []
        schema_calls = [c for c in fake.activity_calls if c[0] == "set_response_schema_activity"]
        assert schema_calls, "nulled schema must regenerate from the latest USER instruction"
        assert all(c[1][1] == [followup] for c in schema_calls), (
            "startup must not rebuild output_schema from the persisted Agent.goal"
        )
        assert wf.output_schema == {
            "fields": [
                {"name": "refund_status", "type": "str", "required": True},
            ]
        }
    finally:
        workflow_module.execute_dag = original_execute_dag
        workflow_module.run_agent = original_run_agent
        _restore_workflow(original_workflow)


async def test_workflow_plan_followup_does_not_regenerate_schema_from_old_goal():
    """start_phase=plan after a completed run must still ignore Agent.goal schema."""
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    followup = "get a refund, the doordasher delivered to the wrong location"
    fake.activity_returns.update(
        {
            "poll_new_messages": _completed_plan_followup_context(followup_text=followup),
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Navi",
            "get_user_custom_system_prompt": None,
            "fetch_compute_token_activity": None,
            "fetch_agent_config": {
                "response_schema": None,
                "write_lock_enabled": True,
            },
            "set_response_schema_activity": {
                "schema": {
                    "fields": [
                        {"name": "refund_status", "type": "str", "required": True},
                    ]
                },
                "usage": {},
            },
            "generate_completion_summary": {
                "summary": "Refund follow-up should plan against the new USER instruction.",
                "tool_counts": {},
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            },
        }
    )

    import workflows.agent_workflow as workflow_module

    original_workflow = _patch_workflow(fake)
    original_execute_dag = workflow_module.execute_dag
    original_run_agent = workflow_module.run_agent
    dag_calls = []

    async def fake_execute_dag(**kwargs):
        dag_calls.append(kwargs)
        return {"status": "completed", "context": kwargs.get("context") or []}

    async def fake_run_agent(**kwargs):
        return {
            "status": "completed",
            "context": _completed_plan_followup_context(followup_text=followup),
            "structured_response": None,
            "token_count": 3,
            "context_size": 30,
        }

    workflow_module.execute_dag = fake_execute_dag
    workflow_module.run_agent = fake_run_agent
    try:
        await wf.run(
            "agent-plan-followup-schema",
            "user-run-1",
            "order me glide floss from doordash",
            "anthropic/claude-sonnet-4.5",
            256,
            {"type": "FLOAT_LLM_JUDGE"},
            None,
            None,
            None,
            0,
            None,
            "plan",
            25,
            250,
            {},
        )
        schema_calls = [c for c in fake.activity_calls if c[0] == "set_response_schema_activity"]
        assert schema_calls, "plan follow-up must generate output_schema from the latest USER"
        assert all(c[1][1] == [followup] for c in schema_calls), (
            "startup must not rebuild output_schema from the persisted Agent.goal"
        )
        assert dag_calls == [], "a superseded historical set_plan must not run during plan follow-up"
        assert wf.output_schema == {
            "fields": [
                {"name": "refund_status", "type": "str", "required": True},
            ]
        }
    finally:
        workflow_module.execute_dag = original_execute_dag
        workflow_module.run_agent = original_run_agent
        _restore_workflow(original_workflow)


async def test_workflow_execute_followup_reuses_last_context_compaction():
    """A later root run must start from the last context_reset, not raw history."""
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    followup = "get a refund, the doordasher delivered to the wrong location"
    projected = _compacted_completed_plan_followup_context(followup)
    fake.activity_returns.update(
        {
            "poll_new_messages": projected,
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Navi",
            "get_user_custom_system_prompt": None,
            "fetch_compute_token_activity": None,
            "fetch_agent_config": {
                "response_schema": None,
                "write_lock_enabled": True,
            },
            "set_response_schema_activity": {
                "schema": {
                    "fields": [
                        {"name": "refund_status", "type": "str", "required": True},
                    ]
                },
                "usage": {},
            },
            "generate_completion_summary": {
                "summary": "Refund follow-up should resume the last compaction.",
                "tool_counts": {},
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            },
        }
    )

    import workflows.agent_workflow as workflow_module

    original_workflow = _patch_workflow(fake)
    original_execute_dag = workflow_module.execute_dag
    original_run_agent = workflow_module.run_agent
    dag_calls = []
    run_agent_calls = []

    async def fake_execute_dag(**kwargs):
        dag_calls.append(kwargs)
        return {"status": "completed", "context": kwargs.get("context") or []}

    async def fake_run_agent(**kwargs):
        run_agent_calls.append(kwargs)
        return {
            "status": "completed",
            "context": projected,
            "structured_response": None,
            "token_count": 3,
            "context_size": 30,
        }

    workflow_module.execute_dag = fake_execute_dag
    workflow_module.run_agent = fake_run_agent
    try:
        await wf.run(
            "agent-compaction-followup",
            "user-run-1",
            "order me glide floss from doordash",
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
        assert dag_calls == [], "compacted completed plan must not replay the first-run DAG"
        assert run_agent_calls, "follow-up must fall through to run_agent on the projected tail"
        schema_calls = [c for c in fake.activity_calls if c[0] == "set_response_schema_activity"]
        assert schema_calls
        assert all(c[1][1] == [followup] for c in schema_calls)
        poll_calls = [c for c in fake.activity_calls if c[0] == "poll_new_messages"]
        assert poll_calls, "fresh start must poll so the last context_reset can be projected"
        assert any((m.get("metadata") or {}).get("compactionSummary") for m in projected)
        assert any((m.get("metadata") or {}).get("contextCompactionBoundary") for m in projected)
        assert wf.output_schema == {
            "fields": [
                {"name": "refund_status", "type": "str", "required": True},
            ]
        }
    finally:
        workflow_module.execute_dag = original_execute_dag
        workflow_module.run_agent = original_run_agent
        _restore_workflow(original_workflow)


async def test_workflow_execute_still_runs_live_plan_without_later_user():
    """A completed-looking transcript without a later USER still executes the plan.

    start_phase=execute on a live plan (no post-completion follow-up) must keep
    using extract_plan_from_context + execute_dag.
    """
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    live_plan_context = [
        {
            "role": "USER",
            "text": "order me glide floss from doordash",
            "metadata": None,
        },
        {
            "role": "TOOL",
            "text": "Plan created",
            "metadata": {
                "toolName": "set_plan",
                "toolStatus": "FINISHED",
                "data": {
                    "type": "plan_artifact",
                    "join": "all",
                    "tasks": [{"goal": "Order floss", "tool_name": "spawn_browser_agent"}],
                    "dependencies": {},
                },
            },
        },
    ]
    fake.activity_returns.update(
        {
            "poll_new_messages": live_plan_context,
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
        }
    )

    import workflows.agent_workflow as workflow_module

    original_workflow = _patch_workflow(fake)
    original_execute_dag = workflow_module.execute_dag
    original_run_agent = workflow_module.run_agent
    dag_calls = []

    async def fake_execute_dag(**kwargs):
        dag_calls.append(kwargs)
        return {"status": "needs_llm", "context": kwargs.get("context") or [], "message": "continue"}

    async def fake_run_agent(**kwargs):
        return {
            "status": "completed",
            "context": kwargs.get("context") or [],
            "structured_response": None,
            "token_count": 1,
            "context_size": 10,
        }

    workflow_module.execute_dag = fake_execute_dag
    workflow_module.run_agent = fake_run_agent
    try:
        await wf.run(
            "agent-live-plan",
            "user-run-1",
            "order me glide floss from doordash",
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
        assert len(dag_calls) == 1, "a live plan with no later USER must still run execute_dag"
        assert not any(c[0] == "set_response_schema_activity" for c in fake.activity_calls), (
            "a live plan must keep the persisted output_schema"
        )
    finally:
        workflow_module.execute_dag = original_execute_dag
        workflow_module.run_agent = original_run_agent
        _restore_workflow(original_workflow)


async def test_workflow_execute_skips_plan_after_user_followup_without_summary():
    """Terminal re-escalation without Task Complete must not replay the old DAG."""
    wf = _bare_workflow_instance()
    fake = _FakeWorkflowModule()
    followup = "get a refund, the doordasher delivered to the wrong location"
    fake.activity_returns.update(
        {
            "poll_new_messages": [
                msg
                for msg in _completed_plan_followup_context(followup_text=followup)
                if (msg.get("metadata") or {}).get("toolName") != "completion_summary"
            ],
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Navi",
            "get_user_custom_system_prompt": None,
            "fetch_compute_token_activity": None,
            "fetch_agent_config": {
                "response_schema": {
                    "fields": [
                        {"name": "order_confirmation_id", "type": "str", "required": True},
                    ]
                },
                "write_lock_enabled": True,
            },
            "set_response_schema_activity": {
                "schema": {
                    "fields": [
                        {"name": "refund_status", "type": "str", "required": True},
                    ]
                },
                "usage": {},
            },
        }
    )

    import workflows.agent_workflow as workflow_module

    original_workflow = _patch_workflow(fake)
    original_execute_dag = workflow_module.execute_dag
    original_run_agent = workflow_module.run_agent
    dag_calls = []

    async def fake_execute_dag(**kwargs):
        dag_calls.append(kwargs)
        return {"status": "completed", "context": kwargs.get("context") or []}

    async def fake_run_agent(**kwargs):
        return {
            "status": "completed",
            "context": [],
            "structured_response": None,
            "token_count": 1,
            "context_size": 10,
        }

    workflow_module.execute_dag = fake_execute_dag
    workflow_module.run_agent = fake_run_agent
    try:
        await wf.run(
            "agent-failed-plan-followup",
            "user-run-1",
            "order me glide floss from doordash",
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
        assert dag_calls == [], "a USER message after set_plan without completion_summary must not replay the DAG"
        schema_calls = [c for c in fake.activity_calls if c[0] == "set_response_schema_activity"]
        assert schema_calls, "a USER follow-up after set_plan must regenerate output_schema"
        assert schema_calls[0][1][1] == [followup]
        assert wf.output_schema == {
            "fields": [
                {"name": "refund_status", "type": "str", "required": True},
            ]
        }
    finally:
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
    wf.demo_cache_goal = "goal"
    wf.compute_token_lineage_key = None
    wf.compute_token_demo_cache_affinity_key = None

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
            model="rose-labs/rose-1-flash",
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


async def test_workflow_post_dag_verdict_detects_keyed_feedback_without_user_row():
    import workflows.agent_workflow as workflow_module

    wf, fake, replacement = _user_schema_refresh_fixture()
    wf.fast_mode_cache_enabled = False
    wf.compute_token_lineage_key = None
    wf.compute_token_demo_cache_affinity_key = None
    wf.context = []

    async def execute_tool(*args, **kwargs):
        return {"success": True}

    async def refresh_token(*args, **kwargs):
        return None

    async def verify(**kwargs):
        return {
            "score": 1.0,
            "reasoning": "The original venues requirement is satisfied",
            "structured_response": {"venues": ["Old result"]},
            "usage": {"prompt_tokens": 5, "completion_tokens": 2},
            "_verified_user_requirement_keys": set(),
            "_verified_requirement_revision": 0,
        }

    async def account_tokens(*args, **kwargs):
        # /attention-requests/respond sends actual_response in the keyed signal
        # without creating a USER Message row. Revision is the durable boundary.
        await wf.receive_user_response(json.dumps({"request_id": "request-1", "response": "Also return venue prices"}))
        await wf._wait_for_response_schema_refresh()

    wf._execute_tool = execute_tool
    wf._refresh_compute_token = refresh_token
    wf._on_tokens = account_tokens
    fake.activity_returns["poll_new_messages"] = []
    original = _patch_workflow(fake)
    original_verifier = workflow_module._run_verifier
    workflow_module._run_verifier = verify
    try:
        result = await wf._attempt_post_dag_completion(
            agent_id=wf.agent_id, user_id=wf.user_id, model="rose-labs/rose-1-flash"
        )
        assert wf.output_schema == replacement and wf._response_schema_revision == 1
        assert wf.context == [], "keyed feedback manufactured a USER row"
        assert result.get("superseded_by_user_feedback") is True, (
            "post-DAG verdict accepted old requirements after keyed feedback changed the native revision without a USER row"
        )
        assert result["score"] == 1.0 and result["structured_response"] == {"venues": ["Old result"]}
    finally:
        workflow_module._run_verifier = original_verifier
        _restore_workflow(original)


async def test_workflow_all_loop_phases_forward_live_requirement_revision():
    import workflows.agent_workflow as workflow_module

    wf = _bare_workflow_instance()
    captured = {}

    async def loop(**kwargs):
        captured.update(kwargs)
        return {"status": "completed"}

    original = workflow_module.run_agent
    workflow_module.run_agent = loop
    try:
        await wf._run_agent_turns()
        callback = captured.get("get_requirement_revision")
        assert callable(callback), "the shared PLAN/EXECUTE loop wrapper did not forward live requirement revision"
        assert callback() == 0
        wf._response_schema_revision = 3
        assert callback() == 3, "the loop captured a frozen revision instead of the live native revision"
    finally:
        workflow_module.run_agent = original


async def _exercise_completion_schema_wait_race(path: str):
    """A real authored update lands during the caller's final schema await."""
    import workflows.agent_workflow as workflow_module
    from utils.oai_demo import OAI_DEMO_CHILD_GOAL_PREFIX

    wf, fake, replacement = _user_schema_refresh_fixture()
    fake.activity_returns.update(
        {
            "poll_new_messages": [],
            "get_model_context_window": 200_000,
            "get_agent_source": "WEB",
            "get_user_context": "",
            "get_user_system_name": "Navi",
            "get_user_custom_system_prompt": None,
            "fetch_compute_token_activity": None,
            "fetch_agent_config": {"response_schema": wf.output_schema, "write_lock_enabled": True},
        }
    )
    original_wait = wf._wait_for_response_schema_refresh
    armed = False
    injected = False
    completions = []
    continued = []
    failures = []
    loop_calls = []
    old_output = {"venues": ["Original requirement only"]}
    new_output = {"venues": ["Updated result"], "venue_prices": [12]}
    verdict = {
        "score": 1.0,
        "reasoning": "Original requirement is satisfied",
        "structured_response": old_output,
        "_verified_user_requirement_keys": set(),
        "_verified_requirement_revision": 0,
    }

    async def wait_with_new_feedback():
        nonlocal injected, armed
        if armed and not injected:
            injected = True
            armed = False
            await wf.receive_user_response(
                json.dumps(
                    {
                        "request_id": "caller-wait-update",
                        "response": "RESOLVED",
                        "user_message": "Also return venue prices",
                    }
                )
            )
        await original_wait()

    async def mark_complete(_context, response):
        completions.append(response)

    async def mark_failed(**kwargs):
        failures.append(kwargs)

    async def loop(**kwargs):
        nonlocal armed
        loop_calls.append(kwargs)
        if path == "execute":
            armed = True
            return dict(verdict, status="completed", context=[], token_count=0, context_size=0)
        return {
            "status": "completed",
            "context": [],
            "structured_response": new_output,
            "_verified_user_requirement_keys": set(),
            "_verified_requirement_revision": 1,
            "token_count": 0,
            "context_size": 0,
        }

    async def completed_dag(**kwargs):
        return {"status": "completed", "context": []}

    async def post_dag(**kwargs):
        nonlocal armed
        armed = True
        return verdict

    wf._wait_for_response_schema_refresh = wait_with_new_feedback
    wf._mark_complete = mark_complete
    wf._mark_failed = mark_failed
    wf._attempt_post_dag_completion = post_dag
    fake.continue_as_new = lambda **kwargs: continued.append(kwargs["args"])
    original_workflow = _patch_workflow(fake)
    original_loop = workflow_module.run_agent
    original_extract_plan = workflow_module.extract_plan_from_context
    original_execute_dag = workflow_module.execute_dag
    workflow_module.run_agent = loop
    workflow_module.execute_dag = completed_dag
    workflow_module.extract_plan_from_context = lambda _context: (
        {"tasks": [{"goal": "Research venues", "tool_name": "spawn_explore_agent"}], "dependencies": {}}
        if path == "post_dag"
        else None
    )
    try:
        if path == "fast_mode":
            wf.goal = f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky — Huberman"
            wf.fast_mode_cache_enabled = True
            armed = True
            await wf._handle_incomplete(
                dict(
                    verdict,
                    status="max_iterations",
                    context=[],
                    verifier_progress=1.0,
                    verifier_reasoning="Fast Mode cache trajectory ended",
                    partial_structured_response=old_output,
                ),
                phase="EXECUTE",
            )
        else:
            await wf.run(
                wf.agent_id,
                wf.user_id,
                wf.goal,
                "rose-labs/rose-1-flash",
                256,
                {"type": "FLOAT_LLM_JUDGE"},
                start_phase="execute",
            )
        assert injected and wf._response_schema_revision == wf._response_schema_accepted_revision == 1
        assert wf.output_schema == replacement
        assert not any(row.get("role") == "USER" for row in wf.context), (
            "keyed authored feedback manufactured a USER row"
        )
        assert verdict["score"] == 1.0 and verdict["structured_response"] == old_output
        if path == "post_dag":
            assert completions == [new_output], (
                "post-DAG completion accepted the verdict superseded during its final schema await"
            )
            assert len(loop_calls) == 1, "the stale DAG verdict did not reach existing loop recovery"
        else:
            assert completions == [], (
                f"{path} accepted an old verdict after current requirements changed during the final schema await"
            )
        if path == "execute":
            assert len(continued) == 1 and continued[0][11] == "execute_continued"
        elif path == "fast_mode":
            assert len(failures) == 1 and failures[0]["reason"] == "max_iterations"
    finally:
        workflow_module.run_agent = original_loop
        workflow_module.extract_plan_from_context = original_extract_plan
        workflow_module.execute_dag = original_execute_dag
        _restore_workflow(original_workflow)


async def test_workflow_execute_completion_rechecks_verdict_after_schema_wait():
    await _exercise_completion_schema_wait_race("execute")


async def test_workflow_post_dag_completion_rechecks_verdict_after_schema_wait():
    await _exercise_completion_schema_wait_race("post_dag")


async def test_workflow_fast_mode_completion_rechecks_verdict_after_schema_wait():
    await _exercise_completion_schema_wait_race("fast_mode")


async def test_workflow_post_dag_completion_verifier_error_closes_attempt_tool():
    """Verifier failure after post-DAG attempt_completion must close the tool row."""
    import workflows.agent_workflow as workflow_module

    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.current_phase = "EXECUTE"
    wf.output_schema = {"fields": []}
    wf.fast_mode_cache_enabled = False
    wf.demo_cache_goal = "goal"
    wf.compute_token_lineage_key = None
    wf.compute_token_demo_cache_affinity_key = None

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
            model="rose-labs/rose-1-flash",
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


async def test_workflow_check_parent_state_parent_missing_orphans_manual_pause():
    """A manually paused child must also stop once its parent is confirmed gone."""
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
        assert wf._orphaned is True
        assert wf.is_paused is False
    finally:
        _restore_workflow(original)


async def test_workflow_check_parent_state_parent_missing_orphans_active_child():
    """An active descendant cannot keep spending after root replacement."""
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = "parent-wf"
    wf.agent_id = "active-child"
    wf.bus_id = "bus-1"
    wf.goal = "g"
    wf.is_paused = False
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
        assert await wf._check_orphaned() is True
    finally:
        _restore_workflow(original)


async def test_workflow_orphan_failure_never_signals_dead_parent():
    """Terminal orphan bookkeeping is local; the dead root receives no completion signal."""
    wf = _bare_workflow_instance()
    wf.agent_id = "orphan-child"
    wf.user_id = "user-1"
    wf.goal = "orphaned work"
    wf.parent_workflow_id = "dead-parent"
    wf._orphaned = True
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._mark_failed(
            context=[],
            reason="orphaned",
            message="Parent agent ended; orphaned sub-agent stopped.",
        )
        assert fake.signal_calls == []
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


async def test_workflow_final_value_presentation():
    """The actual publisher delivers the selected value, not summary narration."""
    from pathlib import Path
    original_data = json.loads(Path(__file__).with_name("final_presentation_original.json").read_text())
    wf = _bare_workflow_instance()
    wf.agent_id = "final-value-root"
    wf.user_id = "u"
    wf.goal = original_data["goal"]
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.output_schema = {**original_data["schema"], "presentation": {"version": 1, "mode": "value", "field": "wikipedia_access_day", "encoding": "text"}}
    fake = _FakeWorkflowModule()
    fake.activity_returns["generate_completion_summary"] = {"summary": "This must not replace the value"}
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(context=[{"role": "USER", "text": wf.goal}], structured_response=original_data["output"])
        assert "generate_completion_summary" not in [name for name, _ in fake.activity_calls]
        final = [(i, args) for i, (name, args) in enumerate(fake.activity_calls)
                 if name == "post_agent_message" and len(args or []) >= 4
                 and args[3].get("isFinalSummary")]
        assert len(final) == 1
        index, args = final[0]
        assert args[1] == "4", args
        assert args[3]["completionSummary"]["answerText"] == "4"
        assert args[3]["completionSummary"]["outputs"][0]["value"] == 4
        notifications = [args for name, args in fake.activity_calls if name == "notify_sms_event_activity"]
        assert len(notifications) == 1
        assert notifications[0][3]["answerText"] == "4"
        assert notifications[0][3]["presentation"] == wf.output_schema["presentation"]
        assert index < next(i for i, (name, _) in enumerate(fake.activity_calls) if name == "mark_finished")
    finally:
        _restore_workflow(original)


def test_browser_execution_restore_rejects_malformed_values():
    valid = {"browser_execution_mode": True, "browser_execution_task_id": "task",
             "browser_execution_contract": "contract",
             "browser_execution_requirement_keys": [["message", "id"]],
             "browser_execution_pending_input_ids": ["id"]}
    fields = {"browser_execution_task_id": None, "browser_execution_contract": None,
              "browser_execution_requirement_keys": [], "browser_execution_pending_input_ids": []}
    for name, fallback in fields.items():
        for malformed in (12, {}, [12], [["message", 12]], None):
            if name.endswith("task_id") or name.endswith("contract"):
                if malformed is None:
                    continue
            wf = _bare_workflow_instance()
            wf._restore_deployment_state({"version": 1, "kind": "deployment", "runtime_state": {**valid, name: malformed}})
            assert getattr(wf, "_" + name) == fallback, (name, malformed)
    wf = _bare_workflow_instance()
    wf._restore_deployment_state({"version": 1, "kind": "deployment", "runtime_state": valid})
    assert wf._browser_execution_requirement_keys == valid["browser_execution_requirement_keys"]
    assert wf._browser_execution_pending_input_ids == ["id"]


async def test_completion_caller_routes_late_revision_and_invalid_presentation():
    """Actual completion admission continues on late input and fails invalid values."""
    from unittest.mock import AsyncMock, patch

    class Continued(BaseException):
        pass

    for mode, path in ([(mode, path) for mode in ("late_revision", "invalid_value") for path in ("execute", "fast_cap")]
                       + [("unaccepted_entry", path) for path in ("execute", "direct")]):
        wf = _bare_workflow_instance()
        wf.agent_id, wf.user_id, wf.goal, wf.model = "completion-route", "user", "Only the day", "rose-1-flash"
        wf.max_iterations = 25
        wf.context_gates = {}
        wf.fast_mode_cache_enabled = path == "fast_cap"
        if mode == "unaccepted_entry":
            wf._response_schema_revision = 1
            wf._response_schema_accepted_revision = 0
            wf._response_schema_refresh_failure_reason = "schema refresh unavailable"
        wf.output_schema = {"fields": [{"name": "day", "type": "int", "required": True}],
                            "presentation": {"version": 1, "mode": "value", "field": "day", "encoding": "text"}}
        wf._track_tokens_and_cost = AsyncMock()
        wf._await_deferred_startup = AsyncMock()
        wf._drain_fast_mode_explores = AsyncMock()
        wf._prepare_response_schema_continuation = AsyncMock()
        wf._flush_pending_messages = AsyncMock()
        failed = AsyncMock(wraps=wf._mark_failed)
        wf._mark_failed = failed
        async def load(**kwargs):
            if mode == "late_revision":
                wf._response_schema_revision += 1
                wf._response_schema_accepted_revision = wf._response_schema_revision
        wf._load_output_schema = load
        fake = _FakeWorkflowModule()
        continuations = []
        def continue_as_new(**kwargs):
            continuations.append(kwargs)
            raise Continued()
        fake.continue_as_new = continue_as_new
        original = _patch_workflow(fake)
        try:
            try:
                payload = {"status": "completed" if path == "execute" else "max_iterations", "context": [],
                           "structured_response": {} if mode == "invalid_value" else {"day": 4},
                           "verifier_progress": 1.0}
                with patch("workflows.agent_workflow.is_oai_demo_mass_agent_task", return_value=True):
                    result = (await wf._finish_execute_result(payload) if path == "execute"
                              else await wf._finish_verified_completion([], payload["structured_response"]) if path == "direct"
                              else await wf._handle_incomplete(payload, "EXECUTE"))
            except Continued:
                assert mode in ("late_revision", "unaccepted_entry")
            else:
                assert mode == "invalid_value" and result["status"] == "failed", result
            assert bool(continuations) is (mode in ("late_revision", "unaccepted_entry"))
            if continuations:
                args = continuations[0]["args"]
                assert args[11] == "execute_continued"
                assert args[16]["runtime_state"]["response_schema_revision"] == 1
            assert failed.await_count == (mode == "invalid_value")
            if mode == "invalid_value":
                assert any(name == "update_agent_status" and args[1] == "FAILED" for name, args in fake.activity_calls)
            assert not any(name == "mark_finished" for name, args in fake.activity_calls)
        finally:
            _restore_workflow(original)


async def test_completion_feedback_during_mark_finished_continues_current_requirement():
    from unittest.mock import AsyncMock
    class Continued(BaseException): pass
    for child in (False, True):
        for accepted in (False, True):
            wf = _bare_workflow_instance()
            wf.agent_id, wf.user_id, wf.goal, wf.model = 'terminal-feedback', 'user', 'Only the day', 'rose-1-flash'
            wf.max_iterations, wf.context_gates = 25, {}
            wf.parent_workflow_id = 'parent' if child else None
            wf.output_schema = {'fields': [{'name': 'day', 'type': 'int', 'required': True}],
                                'presentation': {'version': 1, 'mode': 'value', 'field': 'day', 'encoding': 'text'}}
            wf._start_response_schema_refresh = lambda: None
            wf._wake_background_waiters = lambda: None
            wf._note_wait_wake = lambda *args: None
            wf._flush_pending_messages = AsyncMock()
            fake = _FakeWorkflowModule()
            execute = fake.execute_activity
            async def inject(fn, args=None, **kwargs):
                result = await execute(fn, args=args, **kwargs)
                if getattr(fn, '__name__', '') == 'mark_finished':
                    await wf.receive_user_response('Instead give the month')
                    if accepted:
                        wf._response_schema_accepted_revision = wf._response_schema_revision
                return result
            fake.execute_activity = inject
            continuations = []
            def continue_as_new(**kwargs):
                continuations.append(kwargs)
                raise Continued()
            fake.continue_as_new = continue_as_new
            original = _patch_workflow(fake)
            try:
                try:
                    await wf._finish_verified_completion([], {'day': 4})
                except Continued:
                    pass
                else:
                    raise AssertionError('feedback during terminal write was completed without re-verification')
                assert not wf._is_finished and wf._response_schema_revision == 1
                assert 'Instead give the month' in wf._response_schema_feedback
                assert len(continuations) == 1 and continuations[0]['args'][11] == 'execute_continued'
                assert continuations[0]['args'][16]['runtime_state']['response_schema_revision'] == 1
                statuses = [args[3]['status'] for name, args in fake.activity_calls
                            if name == 'update_agent_tree_state' and 'status' in args[3]]
                assert statuses and statuses[-1] == 'ACTIVE' and 'COMPLETED' not in statuses, statuses
                assert not any(name == 'notify_sms_event_activity' for name, _ in fake.activity_calls)
                assert not any(call[1] == 'child_completed' for call in fake.signal_calls)
            finally:
                _restore_workflow(original)


async def test_completion_routing_preserves_unrelated_failures():
    from unittest.mock import AsyncMock
    for error in (RuntimeError("publication transport failed"), ValueError("unrelated validation"), asyncio.CancelledError()):
        wf = _bare_workflow_instance()
        wf._mark_complete = AsyncMock(side_effect=error)
        wf._mark_failed = AsyncMock()
        wf._track_tokens_and_cost = AsyncMock()
        wf._await_deferred_startup = AsyncMock()
        wf._drain_fast_mode_explores = AsyncMock()
        wf._prepare_response_schema_continuation = AsyncMock()
        try:
            await wf._finish_execute_result({"status": "completed", "context": []})
        except BaseException as actual:
            assert actual is error
        else:
            raise AssertionError("unrelated completion exception was swallowed")
        wf._mark_failed.assert_not_awaited()


async def test_budget_stop_is_not_user_pause_and_cascades_cause():
    from helpers.browser_budget_stop import finish_budget_stop
    from unittest.mock import AsyncMock
    wf = _bare_workflow_instance()
    wf._update_tree_state = AsyncMock()
    wf._get_pending_child_workflow_ids = lambda: ["child"]
    ticket = {"tool_id": "tool"}
    wf._browser_finalizers = {"tool": {"ticket": ticket, "accepted": True}}
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await finish_budget_stop(wf, ticket, {"status": "max_iterations"})
        assert wf.is_paused and not wf._user_pause_active
        assert fake.signal_calls == [("child", "pause", "budget")], fake.signal_calls
        child = _bare_workflow_instance()
        child._update_tree_state = AsyncMock()
        child._get_pending_child_workflow_ids = lambda: []
        await child.pause(fake.signal_calls[0][2])
        assert child.is_paused and not child._user_pause_active
    finally:
        _restore_workflow(original)


async def test_workflow_final_value_rejects_stale_or_invalid():
    for kind in ("stale", "missing", "cancel"):
        wf = _bare_workflow_instance()
        wf.agent_id = "final-invalid"
        wf.parent_workflow_id = None
        wf.output_schema = {"fields": [{"name": "day", "type": "int", "required": True}],
                            "presentation": {"version": 1, "mode": "value", "field": "day", "encoding": "text"}}
        async def drain():
            if kind == "stale":
                wf._response_schema_revision = wf._response_schema_accepted_revision + 1
            if kind == "cancel":
                raise asyncio.CancelledError()
        wf._drain_fast_mode_explores = drain
        fake = _FakeWorkflowModule()
        original = _patch_workflow(fake)
        try:
            try:
                await wf._mark_complete([], {} if kind == "missing" else {"day": 4})
            except (ValueError, RuntimeError, asyncio.CancelledError):
                pass
            else:
                raise AssertionError(kind)
            assert not wf._is_finished
            assert not fake.activity_calls
        finally:
            _restore_workflow(original)


async def test_workflow_final_value_late_feedback():
    for accepted in (False, True):
        wf = _bare_workflow_instance()
        wf.agent_id = "late-value"
        wf.user_id = "u"
        wf.goal = "Only the requested result"
        wf.model = "rose-1-flash"
        wf.parent_workflow_id = None
        wf.output_schema = {"fields": [{"name": "day", "type": "int", "required": True}],
                            "presentation": {"version": 1, "mode": "value", "field": "day", "encoding": "text"}}
        wf._start_response_schema_refresh = lambda: None
        wf._wake_background_waiters = lambda: None
        wf._note_wait_wake = lambda *args: None
        async def delayed():
            await wf.receive_user_response("Instead provide a full report")
            if accepted:
                # Even a new accepted schema cannot reuse the old verification.
                wf._response_schema_accepted_revision = wf._response_schema_revision
        wf._stop_pending_background_agents = delayed
        fake = _FakeWorkflowModule()
        original = _patch_workflow(fake)
        try:
            try:
                await wf._mark_complete([], {"day": 4})
            except RuntimeError:
                pass
            else:
                raise AssertionError("late feedback published a stale final answer")
            assert wf._response_schema_revision == 1
            assert "Instead provide a full report" in wf._response_schema_feedback
            assert wf._is_finished is False
            assert not any(name == "mark_finished" for name, args in fake.activity_calls)
            assert not any(name == "post_agent_message" and len(args or []) >= 4
                           and args[3].get("isFinalSummary") for name, args in fake.activity_calls)
        finally:
            _restore_workflow(original)


async def test_workflow_final_value_late_schema_matrix():
    failures = []
    for stage in ("transcript", "final_post"):
        for accepted in (False, True):
            wf = _bare_workflow_instance()
            wf.agent_id = "late-field-change"
            wf.user_id = "u"
            wf.goal = "Only the day"
            wf.model = "rose-1-flash"
            wf.parent_workflow_id = None
            wf.output_schema = {"fields": [{"name": "day", "type": "int", "required": True}],
                                "presentation": {"version": 1, "mode": "value", "field": "day", "encoding": "text"}}
            wf._start_response_schema_refresh = lambda: None
            wf._wake_background_waiters = lambda: None
            wf._note_wait_wake = lambda *args: None
            async def feedback():
                await wf.receive_user_response("Instead give the month")
                if accepted:
                    wf._response_schema_accepted_revision = wf._response_schema_revision
                    wf.output_schema = {"fields": [{"name": "month", "type": "str", "required": True}],
                                        "presentation": {"version": 1, "mode": "value", "field": "month", "encoding": "text"}}
            if stage == "transcript":
                async def transcript(context):
                    await feedback()
                    return context
                wf._completion_transcript = transcript
            else:
                original_post = wf._post_message
                async def post(*args, **kwargs):
                    result = await original_post(*args, **kwargs)
                    if len(args) > 2 and args[2].get("isFinalSummary"):
                        await feedback()
                    return result
                wf._post_message = post
            fake = _FakeWorkflowModule()
            original = _patch_workflow(fake)
            error = None
            try:
                try:
                    await wf._mark_complete([], {"day": 4})
                except Exception as caught:
                    error = caught
                finals = [args for name, args in fake.activity_calls
                          if name == "post_agent_message" and len(args or []) >= 4
                          and args[3].get("isFinalSummary")]
                if not isinstance(error, RuntimeError) or wf._is_finished:
                    failures.append(f"{stage}/{accepted}: {type(error).__name__}, finished={wf._is_finished}")
                if any(name == "mark_finished" for name, _ in fake.activity_calls):
                    failures.append(f"{stage}/{accepted}: persisted stale completion")
                assert wf._response_schema_revision == 1
                assert "Instead give the month" in wf._response_schema_feedback
                assert len(finals) == (1 if stage == "final_post" else 0)
                if finals:
                    assert finals[0][1] == "4", "already written history must not be rewritten"
            finally:
                _restore_workflow(original)
    assert not failures, "; ".join(failures)


async def test_workflow_final_value_loaded_schema():
    for value_mode in (True, False):
        wf = _bare_workflow_instance()
        wf.agent_id = "late-load"
        wf.user_id = "u"
        wf.goal = "Only the requested result"
        wf.model = "rose-1-flash"
        wf.parent_workflow_id = None
        wf.output_schema = None
        schema = {"fields": [{"name": "day", "type": "int", "required": True}]}
        if value_mode:
            schema["presentation"] = {"version": 1, "mode": "value", "field": "day", "encoding": "text"}
        fake = _FakeWorkflowModule()
        fake.activity_returns["fetch_agent_config"] = {"response_schema": schema}
        fake.activity_returns["generate_completion_summary"] = {"summary": "Legacy report"}
        original = _patch_workflow(fake)
        try:
            await wf._mark_complete([], {"day": 4})
            assert wf.output_schema == schema
            final = next(args for name, args in fake.activity_calls if name == "post_agent_message"
                         and len(args or []) >= 4 and args[3].get("isFinalSummary"))
            calls = [name for name, _ in fake.activity_calls]
            if value_mode:
                assert "generate_completion_summary" not in calls
                assert final[1] == "4"
                assert final[3]["completionSummary"]["answerText"] == "4"
            else:
                assert "generate_completion_summary" in calls
                assert final[1] == ""
                assert "answerText" not in final[3]["completionSummary"]
        finally:
            _restore_workflow(original)


async def test_workflow_final_value_feedback_during_schema_load():
    wf = _bare_workflow_instance()
    wf.agent_id = "load-feedback"
    wf.user_id = "u"
    wf.goal = "Only the day"
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.output_schema = None
    wf._start_response_schema_refresh = lambda: None
    wf._wake_background_waiters = lambda: None
    wf._note_wait_wake = lambda *args: None
    fake = _FakeWorkflowModule()
    execute = fake.execute_activity
    async def with_feedback(fn, args=None, **kwargs):
        if getattr(fn, "__name__", "") == "fetch_agent_config":
            await wf.receive_user_response("Instead give the month")
            return {"response_schema": {"fields": [{"name": "day", "type": "int", "required": True}],
                    "presentation": {"version": 1, "mode": "value", "field": "day", "encoding": "text"}}}
        return await execute(fn, args=args, **kwargs)
    fake.execute_activity = with_feedback
    original = _patch_workflow(fake)
    try:
        try:
            await wf._mark_complete([], {"day": 4})
        except RuntimeError:
            pass
        else:
            raise AssertionError("unaccepted loaded schema finalized")
        assert not wf._is_finished
        assert wf._response_schema_revision == 1
        assert "Instead give the month" in wf._response_schema_feedback
        assert not any(name == "mark_finished" for name, _ in fake.activity_calls)
    finally:
        _restore_workflow(original)


async def test_workflow_final_verification_entry_revision_matrix():
    # Same-shaped accepted schemas are deliberately included: schema acceptance
    # must never be mistaken for re-verification of the old result.
    for stage in ("initial", "deferred", "drain", "load", "stop", "transcript", "post"):
        for accepted in (False, True):
            for changed_shape in (False, True):
                wf = _bare_workflow_instance()
                wf.agent_id = "entry-revision"
                wf.user_id = "u"
                wf.goal = "Only the day"
                wf.model = "rose-1-flash"
                wf.parent_workflow_id = None
                schema = {"fields": [{"name": "day", "type": "int", "required": True}],
                          "presentation": {"version": 1, "mode": "value", "field": "day", "encoding": "text"}}
                wf.output_schema = None if stage == "load" else schema
                wf._start_response_schema_refresh = lambda: None
                wf._wake_background_waiters = lambda: None
                wf._note_wait_wake = lambda *args: None
                async def feedback():
                    await wf.receive_user_response("Instead give the next result")
                    if accepted:
                        wf._response_schema_accepted_revision = wf._response_schema_revision
                        if changed_shape:
                            wf.output_schema = {"fields": [{"name": "month", "type": "str", "required": True}],
                                "presentation": {"version": 1, "mode": "value", "field": "month", "encoding": "text"}}
                fake = _FakeWorkflowModule()
                if stage == "initial":
                    # An accepted entry revision is legitimate; its next change
                    # must still be caught at the first suspended phase.
                    if accepted:
                        wf._await_deferred_startup = feedback
                elif stage in ("deferred", "drain", "stop"):
                    setattr(wf, {"deferred": "_await_deferred_startup", "drain": "_drain_fast_mode_explores",
                                 "stop": "_stop_pending_background_agents"}[stage], feedback)
                elif stage == "load":
                    execute = fake.execute_activity
                    async def load(fn, args=None, **kwargs):
                        if getattr(fn, "__name__", "") == "fetch_agent_config":
                            await feedback()
                            return {"response_schema": schema}
                        return await execute(fn, args=args, **kwargs)
                    fake.execute_activity = load
                elif stage == "transcript":
                    async def transcript(context):
                        await feedback()
                        return context
                    wf._completion_transcript = transcript
                else:
                    original_post = wf._post_message
                    async def post(*args, **kwargs):
                        result = await original_post(*args, **kwargs)
                        if len(args) > 2 and args[2].get("isFinalSummary"):
                            await feedback()
                        return result
                    wf._post_message = post
                original = _patch_workflow(fake)
                try:
                    if stage == "initial":
                        await feedback()
                    try:
                        await wf._mark_complete([], {"day": 4})
                    except RuntimeError:
                        pass
                    else:
                        raise AssertionError(f"stale completion: {stage}/{accepted}/{changed_shape}")
                    assert not wf._is_finished, (stage, accepted, changed_shape)
                    assert "Instead give the next result" in wf._response_schema_feedback
                    assert not any(name == "mark_finished" for name, _ in fake.activity_calls)
                    finals = [args for name, args in fake.activity_calls if name == "post_agent_message"
                              and len(args or []) >= 4 and args[3].get("isFinalSummary")]
                    assert len(finals) == (1 if stage == "post" else 0)
                    if finals:
                        assert finals[0][1] == "4"  # Retain the real prior write.
                finally:
                    _restore_workflow(original)


def test_workflow_final_presentation_resume():
    wf = _bare_workflow_instance()
    wf.agent_id = "final-resume"
    wf.context_gates = {}
    wf.max_iterations = None
    wf.user_id = "u"
    wf.goal = "Only the requested number"
    wf.output_schema = {"fields": [{"name": "day", "type": "int", "required": True}],
                        "presentation": {"version": 1, "mode": "value", "field": "day", "encoding": "text"}}
    wf._response_schema_revision = 3
    wf._response_schema_accepted_revision = 3
    wf._response_schema_applied_revision = 3
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        state = wf._continuation_resume_state([])
        restored = _bare_workflow_instance()
        restored._restore_deployment_state(state)
        assert restored.output_schema == wf.output_schema
        assert restored._response_schema_accepted_revision == 3
        restored._require_current_response_schema_acceptance()
    finally:
        _restore_workflow(original)


def test_final_presentation_contract():
    from utils.final_presentation import render_final_answer, validate_presentation
    from utils.tool_schemas import ResponseSchemaConfig
    from helpers.llm import _GeneratedResponseSchema, _schema_from_generated_model
    field = {"name": "answer", "type": "int", "required": True}
    policy = {"version": 1, "mode": "value", "field": "answer", "encoding": "text"}
    schema = {"fields": [field], "presentation": policy}
    assert render_final_answer(schema, {"answer": 0}) == "0"
    assert render_final_answer({"fields": [field]}, {"answer": 4}) is None
    assert ResponseSchemaConfig.model_validate(schema).presentation.field == "answer"
    from utils.response_schema_wire import decode_wire
    legacy = ResponseSchemaConfig.model_validate({"fields": [field]}).model_dump()
    assert "presentation" not in legacy
    report = ResponseSchemaConfig.model_validate({"fields": [field], "presentation": {"version": 1, "mode": "report"}}).model_dump()
    assert report["presentation"] == {"version": 1, "mode": "report"}
    native = {"nodes": [{"id": "answer", "parent_id": None, "position": 0,
                         "name": "answer", "type": "int", "required": True,
                         "nullable": False, "description": "Number", "constraints": []}],
              "presentation": policy, "reasoning": "Number"}
    decoded = decode_wire(native, internal=True, reasoning=True)
    assert decoded["presentation"] == policy
    assert _schema_from_generated_model(_GeneratedResponseSchema.model_validate(native))["presentation"] == policy

    generated = _GeneratedResponseSchema.model_validate({**schema, "reasoning": "A number"})
    assert _schema_from_generated_model(generated)["presentation"] == policy
    for bad in [
        {**schema, "presentation": {**policy, "field": "missing"}},
        {**schema, "fields": [{**field, "nullable": True}]},
        {**schema, "fields": [{**field, "required": False}]},
        {**schema, "fields": [field, {"name": "notice", "type": "str", "required": True}]},
        {**schema, "fields": [{**field, "type": "file_pointer"}]},
        {**schema, "presentation": {**policy, "version": 2}},
    ]:
        try:
            validate_presentation(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(bad)
    for value in [True, None, "4"]:
        try:
            render_final_answer(schema, {"answer": value})
        except ValueError:
            pass
        else:
            raise AssertionError(value)
    text_schema = {**schema, "fields": [{**field, "type": "str"}]}
    assert render_final_answer(text_schema, {"answer": "<script>4</script>"}) == "<script>4</script>"
    assert render_final_answer(text_schema, {"answer": ""}) == ""
    bool_schema = {**schema, "fields": [{**field, "type": "bool"}]}
    assert render_final_answer(bool_schema, {"answer": False}) == "false"
    json_schema = {**schema, "fields": [{**field, "type": "list[str]"}],
                   "presentation": {**policy, "encoding": "json"}}
    assert render_final_answer(json_schema, {"answer": ["a", "b"]}) == '["a","b"]'


async def test_workflow_mark_complete_happy_path():
    """_mark_complete posts summary, updates tree, signals parent."""
    wf = _bare_workflow_instance()
    wf.agent_id = "child-complete-1"
    wf.user_id = "u-mc"
    wf.goal = "finish goal"
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = "parent-mc"
    wf.root_agent_id = "root-complete-1"
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
        mark_finished_args = fake.activity_calls[mark_finished_index][1]
        assert mark_finished_args[-1] == "root-complete-1"
        # Child-completed signal to parent
        signal_names = [s[1] for s in fake.signal_calls]
        assert "child_completed" in signal_names
        assert not any(
            name == "notify_sms_event_activity" and args[1] == "completion" for name, args in fake.activity_calls
        )
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_does_not_forward_full_context():
    """Huge Fast Mode context must not ride the mark_finished Temporal payload.

    ed9a3b6e scheduled mark_finished with a 638092-byte payload (TMPRL1103
    limit 524288). The activity sat 17 minutes, timed out, and the verified
    root stayed ACTIVE until the 900s smoke cap. mark_finished only reads the
    first USER text as the goal; message_count still records the real length.
    """
    wf = _bare_workflow_instance()
    wf.agent_id = "root-slim-finished"
    wf.user_id = "u-slim"
    wf.goal = "Analyze the top 50 creators"
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.root_agent_id = "root-slim-finished"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.token_count = 100
    wf.tokens_in = 70
    wf.tokens_out = 30
    wf.context_size = 500
    wf.child_tool_counts = {}
    wf.output_schema = {"fields": []}

    huge_context = [{"role": "USER", "text": wf.goal}] + [{"role": "ASSISTANT", "text": "x" * 2000} for _ in range(400)]
    assert len(json.dumps(huge_context)) > 512 * 1024

    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 1, 0, tzinfo=timezone.utc)
    fake.activity_returns["generate_completion_summary"] = {
        "summary": "All done",
        "tool_counts": {},
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(context=huge_context, structured_response={"ok": True})
        mark_finished_args = next(args for name, args in fake.activity_calls if name == "mark_finished")
        steps = mark_finished_args[1]
        payload = json.dumps(steps)
        assert steps == [{"role": "USER", "text": wf.goal}]
        assert len(payload) < 4096, (
            f"mark_finished steps_taken is {len(payload)} bytes; "
            "full conversation must not be forwarded (ed9a3b6e leftover-ACTIVE)"
        )
        assert mark_finished_args[4] == len(huge_context)
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_no_parent_no_signal():
    """A WEB-source root sends one completion SMS with verified outputs."""
    wf = _bare_workflow_instance()
    wf.agent_id = "root-mc"
    wf.user_id = "u-mc"
    wf.goal = "root goal"
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.token_count = 0
    wf.tokens_in = 0
    wf.tokens_out = 0
    wf.context_size = 0
    wf.child_tool_counts = {}
    wf.output_schema = {
        "fields": [
            {"name": "pickup_time", "type": "str"},
            {"name": "order_total_usd", "type": "float"},
        ]
    }
    wf.agent_source = "WEB"

    fake = _FakeWorkflowModule()
    fake.activity_returns["generate_completion_summary"] = {
        "summary": "root done",
        "tool_counts": {},
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(
            context=[],
            structured_response={"pickup_time": "7:41 AM", "order_total_usd": 11.25},
        )
        signal_names = [s[1] for s in fake.signal_calls]
        assert "child_completed" not in signal_names
        completion_notifications = [
            args
            for name, args in fake.activity_calls
            if name == "notify_sms_event_activity" and args[1] == "completion"
        ]
        assert len(completion_notifications) == 1
        assert completion_notifications[0][2] == "root-mc"
        assert completion_notifications[0][3] == {
            "summary": "root done",
            "outputs": [
                {"key": "pickup_time", "label": "Pickup Time", "value": "7:41 AM"},
                {"key": "order_total_usd", "label": "Order Total Usd", "value": 11.25},
            ],
        }
        assert ("info", "Sent completion SMS notification: agent=root-mc") in fake.logger.records
        assert not any(
            level == "warning" and message.startswith("Failed to send completion SMS notification")
            for level, message in fake.logger.records
        )
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_survives_summary_generation_failure():
    """A verified-complete root must still reach COMPLETED when the
    non-critical completion_summary LLM call fails.

    Recurrence of 2026-07-11-completion-gated-behind-final-summary-message-post.
    That case moved the durable terminal write ahead of the summary *message
    post*, but the summary *LLM generation* stayed on the critical path inside
    the same try/raise block. Evidence: benchmark
    browser-bing-search-single-result, agent
    f79ad255-85a0-4254-9913-152dceba3381 — the browser child returned the
    correct result, attempt_completion's verifier scored 100%
    ("⚖️ Progress: 100%" at 23:36:48.961Z), then the transcript stops at
    completion_summary IN_PROGRESS (23:36:51.432Z) and the run record reports
    "Agent status: ACTIVE (expected COMPLETED)".

    Presentation work may degrade; it may never abort or discard an
    already-verified lifecycle transition.
    """
    wf = _bare_workflow_instance()
    wf.agent_id = "root-summary-fail"
    wf.user_id = "u-mc"
    wf.goal = "return one bing result"
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.agent_source = "WEB"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.child_tool_counts = {}
    wf.output_schema = {"fields": [{"name": "search_result_title", "type": "str"}]}

    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 1, 0, tzinfo=timezone.utc)
    # The summary LLM activity exhausts its retries and raises.
    fake.activity_fail_for.add("generate_completion_summary")
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(
            context=[{"role": "USER", "text": "go"}],
            structured_response={"search_result_title": "OpenAI | Research & Deployment"},
        )
        activity_names = [c[0] for c in fake.activity_calls]
        assert "generate_completion_summary" in activity_names
        assert "mark_finished" in activity_names, (
            "mark_finished was never called: a failed completion_summary LLM call "
            "aborted the durable terminal transition of a verifier-100% agent."
        )
        completed_broadcasts = [
            args
            for name, args in fake.activity_calls
            if name == "update_agent_tree_state" or name == "update_agent_status"
        ]
        # The final summary message must still be posted so COMPLETED keeps
        # implying an observable summary row.
        assert any(
            name == "post_agent_message"
            and len(args or []) >= 4
            and (args[3] or {}).get("toolName") == "completion_summary"
            and (args[3] or {}).get("toolStatus") == "FINISHED"
            for name, args in fake.activity_calls
        ), "no FINISHED completion_summary message was posted after the summary LLM failed"
        assert completed_broadcasts is not None
    finally:
        _restore_workflow(original)


def test_strip_fast_mode_card_narration_keeps_extracted_output():
    """T7 3452c32c: Fast Mode prefix + extracted report must publish the report only."""
    from workflows.agent_workflow import (
        completion_card_has_fast_mode_markers,
        strip_fast_mode_card_narration,
    )

    published = (
        "Fast Mode cache trajectory ended; prior tool evidence is sufficient to "
        "treat the goal as complete. **Extracted Output:** - **Audience Persona:** "
        "Ambitious self-improvement audience: entrepreneurs, operators, creators "
        "and professionals seeking high-agency life/career advice, health "
        "optimization, business lessons, and mainstream celebrity interviews."
    )
    assert completion_card_has_fast_mode_markers(published)
    stripped = strip_fast_mode_card_narration(published)
    assert "Fast Mode" not in stripped
    assert "cached trajectory" not in stripped.lower()
    assert "Audience Persona" in stripped
    assert len(stripped) >= 200


async def test_workflow_mark_complete_replaces_fast_mode_ablation_with_real_summary():
    """Fast Mode traj-end completion_summary must not land on the Task Complete card."""
    wf = _bare_workflow_instance()
    wf.agent_id = "gp-huberman-summary"
    wf.user_id = "u-mc"
    wf.goal = "You are analyzing ONE creator for Andy Prevalsky."
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.agent_source = "WEB"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.child_tool_counts = {}
    wf.output_schema = {
        "fields": [
            {"name": "creator_name", "type": "str"},
            {"name": "posting_cadence_by_platform", "type": "str"},
        ]
    }

    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 1, 0, tzinfo=timezone.utc)
    fake.activity_returns["generate_completion_summary"] = {
        "summary": ("Fast Mode cache trajectory ended; the task completed successfully based on prior tool evidence."),
        "tool_counts": {"spawn_agent": 3},
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "from_fast_cache": True,
            "actual_model": "fast-mode-soft-complete",
        },
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(
            context=[
                {"role": "USER", "text": "analyze Huberman"},
                {
                    "role": "TOOL",
                    "text": (
                        "# creator_name\nAndrew Huberman\n\n"
                        "# posting_cadence_by_platform\n"
                        "YouTube ~2 episodes/week; Instagram ~3 posts/week.\n\n"
                        "Huberman Lab 90-day cadence pairs lab-guest interviews with "
                        "protocol recaps. Hooks name a hormone or sleep lever plus a "
                        "concrete action. Audience is founder-operators who want "
                        "operating systems, not wellness slogans. Monetization is "
                        "sponsorships and a premium newsletter. Gaps include weekly "
                        "founder-recovery operating cadence Andy can own."
                    ),
                    "metadata": {
                        "toolName": "attempt_completion",
                        "toolStatus": "FINISHED",
                    },
                },
            ],
            structured_response=None,
        )
        finished = next(
            args[3]
            for name, args in fake.activity_calls
            if name == "post_agent_message"
            and len(args or []) >= 4
            and (args[3] or {}).get("toolName") == "completion_summary"
            and (args[3] or {}).get("toolStatus") == "FINISHED"
        )
        card = (finished or {}).get("completionSummary") or {}
        summary = str(card.get("summary") or "")
        assert "Fast Mode" not in summary
        assert "cached trajectory" not in summary.lower()
        assert "Huberman" in summary
        outputs = card.get("outputs") or []
        assert outputs, "Task Complete must show schema outputs"
        keys = {item.get("key") for item in outputs}
        assert "creator_name" in keys
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_strips_fast_mode_prefix_from_long_extracted_output():
    """A 200+ char Fast Mode-prefixed Extracted Output must not fail T7."""
    wf = _bare_workflow_instance()
    wf.agent_id = "gp-steven-bartlett-summary"
    wf.user_id = "u-mc"
    wf.goal = (
        "You are analyzing ONE creator for Andy Prevalsky, a technology founder "
        "building a brand at the intersection of health, longevity, technology, "
        "and founder journey. Last 90 days are 2026-04-04 through 2026-07-03."
    )
    wf.root_goal = "I'm building a [REDACTED] brand for health, longevity, technology, founder journey"
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = "root-demo"
    wf.agent_source = "WEB"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.child_tool_counts = {}
    wf.output_schema = {
        "fields": [
            {"name": "creator_name", "type": "str"},
            {"name": "audience_persona", "type": "str"},
        ]
    }

    extracted = (
        "**Extracted Output:** - **Audience Persona:** Ambitious self-improvement "
        "audience: entrepreneurs, operators, creators and professionals seeking "
        "high-agency life/career advice, health optimization, business lessons, "
        "and mainstream celebrity/political/business interviews. Official "
        "positioning emphasizes diary-style interviews with operators."
    )
    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 1, 0, tzinfo=timezone.utc)
    fake.activity_returns["generate_completion_summary"] = {
        "summary": (
            "Fast Mode cache trajectory ended; prior tool evidence is sufficient "
            f"to treat the goal as complete. {extracted}"
        ),
        "tool_counts": {"web_search": 4},
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "from_fast_cache": True,
            "actual_model": "fast-mode-soft-complete",
        },
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(
            context=[
                {"role": "USER", "text": "analyze Steven Bartlett"},
                {
                    "role": "TOOL",
                    "text": (
                        "Fast Mode cache trajectory ended; prior tool evidence is "
                        f"sufficient to treat the goal as complete.\n\n{extracted}"
                    ),
                    "metadata": {
                        "toolName": "attempt_completion",
                        "toolStatus": "FINISHED",
                    },
                },
            ],
            structured_response={"creator_name": "Steven Bartlett", "audience_persona": extracted},
        )
        finished = next(
            args[3]
            for name, args in fake.activity_calls
            if name == "post_agent_message"
            and len(args or []) >= 4
            and (args[3] or {}).get("toolName") == "completion_summary"
            and (args[3] or {}).get("toolStatus") == "FINISHED"
        )
        card = (finished or {}).get("completionSummary") or {}
        summary = str(card.get("summary") or "")
        assert "Fast Mode" not in summary
        assert "cached trajectory" not in summary.lower()
        assert "based on prior tool evidence" not in summary.lower()
        assert "Audience Persona" in summary or "Steven Bartlett" in summary
        assert len(summary) >= 200
        outputs = card.get("outputs") or []
        assert outputs, "Task Complete must keep schema outputs after Fast Mode strip"
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_never_persists_raw_tool_envelope_for_any_task():
    """The final Task Complete write enforces the shared narration contract globally."""
    wf = _bare_workflow_instance()
    wf.agent_id = "ordinary-agent-raw-summary"
    wf.user_id = "u-mc"
    wf.goal = "Research a robotics founder and summarize the findings."
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = "ordinary-parent"
    wf.root_agent_id = "ordinary-root"
    wf.agent_source = "WEB"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.child_tool_counts = {}
    wf.output_schema = {"fields": [{"name": "founder", "type": "str"}]}
    cached_search = (
        "- **query**: Figure robot Brett Adcock interview\n\n"
        "**Result:** Search result snippets and ranking metadata replayed verbatim from the "
        "web-search tool. This payload deliberately exceeds two hundred characters and is "
        "tool I/O, not user-facing narration, so the final persistence boundary must reject it."
    )
    report = (
        "The research identified Brett Adcock as Figure's founder and summarized his public "
        "discussion of humanoid-robot deployment, manufacturing scale, and the Figure 03 "
        "platform. The finished report separates sourced claims from interpretation and gives "
        "the parent a concise foundation for its robotics-founder comparison."
    )
    fake = _FakeWorkflowModule()
    fake.activity_returns["generate_completion_summary"] = {
        "summary": cached_search,
        "tool_counts": {"web_search": 1},
        "usage": {"from_fast_cache": True, "actual_model": "fast-cache"},
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(
            context=[
                {
                    "role": "TOOL",
                    "text": report,
                    "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED"},
                }
            ],
            structured_response={"founder": "Brett Adcock"},
        )
        finished = next(
            args[3]
            for name, args in fake.activity_calls
            if name == "post_agent_message"
            and len(args or []) >= 4
            and (args[3] or {}).get("toolName") == "completion_summary"
            and (args[3] or {}).get("toolStatus") == "FINISHED"
        )
        summary = str(((finished or {}).get("completionSummary") or {}).get("summary") or "")
        assert "Brett Adcock" in summary
        assert "**query**" not in summary
        assert "**Result:**" not in summary
        mark_finished_args = next(args for name, args in fake.activity_calls if name == "mark_finished")
        assert mark_finished_args[7] == summary
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_materializes_oai_demo_root_report_files():
    """Root OAI demo Task Complete outputs become HTML/CSV file_pointers."""
    from utils.oai_demo import OAI_DEMO_ROOT_GOAL_PREFIX

    wf = _bare_workflow_instance()
    wf.agent_id = "oai-demo-root"
    wf.user_id = "u-demo"
    wf.goal = OAI_DEMO_ROOT_GOAL_PREFIX
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.agent_source = "WEB"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.child_tool_counts = {}
    wf.output_schema = {
        "fields": [
            {"name": "positioning_statement", "type": "str"},
            {"name": "ninety_day_content_calendar", "type": "list[object]"},
        ]
    }
    pointer = {
        "id": "fp-pos",
        "storage_path": "u-demo/positioning-statement.html",
        "original_filename": "positioning-statement.html",
        "mime_type": "text/html",
        "size_bytes": 12,
        "created_at": "2026-09-03T00:00:00Z",
    }
    calendar_pointer = {
        **pointer,
        "id": "fp-cal",
        "storage_path": "u-demo/90-day-content-calendar.csv",
        "original_filename": "90-day-content-calendar.csv",
        "mime_type": "text/csv",
    }
    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 1, 0, tzinfo=timezone.utc)
    fake.activity_returns["generate_completion_summary"] = {
        "summary": "x" * 200,
        "tool_counts": {},
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }
    fake.activity_returns["materialize_oai_demo_report_files_activity"] = {
        "structured_response": {
            "positioning_statement": pointer,
            "ninety_day_content_calendar": calendar_pointer,
        },
        "output_schema": {
            "fields": [
                {"name": "positioning_statement", "type": "file_pointer"},
                {"name": "ninety_day_content_calendar", "type": "file_pointer"},
            ]
        },
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(
            context=[],
            structured_response={
                "positioning_statement": "Longevity OS for founders.",
                "ninety_day_content_calendar": "Week 1 / Substack",
            },
        )
        names = [name for name, _args in fake.activity_calls]
        assert "materialize_oai_demo_report_files_activity" in names
        materialize_args = next(
            args for name, args in fake.activity_calls if name == "materialize_oai_demo_report_files_activity"
        )
        assert materialize_args[0] == "u-demo"
        assert materialize_args[3] == "oai-demo-root"
        summary_args = next(
            args
            for name, args in fake.activity_calls
            if name == "post_agent_message"
            and len(args or []) >= 4
            and (args[3] or {}).get("toolName") == "completion_summary"
            and (args[3] or {}).get("toolStatus") == "FINISHED"
        )
        outputs = (summary_args[3] or {}).get("completionSummary", {}).get("outputs") or []
        by_key = {item["key"]: item["value"] for item in outputs}
        assert by_key["positioning_statement"]["original_filename"] == "positioning-statement.html"
        assert by_key["ninety_day_content_calendar"]["original_filename"] == "90-day-content-calendar.csv"
        assert wf.output_schema["fields"][0]["type"] == "file_pointer"
        finished_args = next(args for name, args in fake.activity_calls if name == "mark_finished")
        assert finished_args[8]["positioning_statement"]["original_filename"] == "positioning-statement.html"
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_skips_report_files_for_oai_demo_child():
    """Per-creator children keep structured fields; only the root report becomes files."""
    from utils.oai_demo import OAI_DEMO_CHILD_GOAL_PREFIX

    wf = _bare_workflow_instance()
    wf.agent_id = "oai-demo-child"
    wf.user_id = "u-demo"
    wf.goal = f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky"
    wf.parent_workflow_id = "oai-demo-root"
    wf.agent_source = "WEB"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.child_tool_counts = {}
    wf.output_schema = {"fields": [{"name": "creator_name", "type": "str"}]}
    fake = _FakeWorkflowModule()
    fake.activity_returns["generate_completion_summary"] = {
        "summary": "x" * 200,
        "tool_counts": {},
        "usage": {},
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(context=[], structured_response={"creator_name": "Huberman"})
        assert "materialize_oai_demo_report_files_activity" not in [name for name, _args in fake.activity_calls]
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_recovers_explore_web_fetch_on_unfiltered_poll():
    """Explore chips are subAgentId-tagged; Task Complete still needs their bodies."""
    wf = _bare_workflow_instance()
    wf.agent_id = "gp-wes-roth-summary"
    wf.user_id = "u-mc"
    wf.goal = "You are analyzing ONE creator for Andy Prevalsky."
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.agent_source = "WEB"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.child_tool_counts = {}
    wf.output_schema = {
        "fields": [
            {"name": "creator_name", "type": "str"},
            {"name": "rank_from_initial_list", "type": "int"},
        ]
    }
    fetch_body = (
        "**Params Passed:**\n\n- **url**: https://www.youtube.com/@WesRoth\n\n"
        "**Result:**\n\n"
        "Wes Roth covers AI research papers and product launches in long-form "
        "YouTube explainers. Last-90-day cadence is several videos a week with "
        "hooks that pair a lab name and a concrete capability claim. Audience "
        "promise is stay-current AI for builders. Monetization is sponsorships "
        "and course mentions. Gaps include founder-health operating cadence."
    )
    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 1, 0, tzinfo=timezone.utc)
    fake.activity_returns["generate_completion_summary"] = {
        "summary": "The task completed successfully; verified results are included below.",
        "tool_counts": {"spawn_agent": 2},
        "usage": {"from_fast_cache": True, "actual_model": "fast-mode-soft-complete"},
    }
    fake.activity_returns["poll_new_messages"] = [
        {
            "role": "TOOL",
            "message": "Research the YouTube creator Wes Roth",
            "metadata": {
                "toolName": "spawn_agent",
                "toolStatus": "IN_PROGRESS",
                "title": "Exploring",
            },
        },
        {
            "role": "TOOL",
            "message": fetch_body,
            "metadata": {
                "toolName": "web_fetch",
                "toolStatus": "FINISHED",
                "title": "Fetched https://www.youtube.com/@WesRoth",
                "subAgentId": "explore-wes",
                "taskId": "explore-wes",
            },
        },
        {
            "role": "TOOL",
            "message": (
                "The completed Wes Roth creator report covers his frequent long-form YouTube "
                "explainers on AI research and launches, lab-name-plus-capability hooks, a "
                "stay-current promise for builders, sponsorship and course monetization, and "
                "the open opportunity for founder-health operating-cadence content. It gives "
                "the parent concrete positioning evidence without exposing raw fetch syntax."
            ),
            "metadata": {
                "toolName": "spawn_agent",
                "toolStatus": "FINISHED",
                "subAgentId": "explore-wes",
                "taskId": "explore-wes",
            },
        },
    ]
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(
            context=[{"role": "USER", "text": "analyze Wes Roth"}],
            structured_response={"creator_name": "Wes Roth", "rank_from_initial_list": 49},
        )
        poll_calls = [args for name, args in fake.activity_calls if name == "poll_new_messages"]
        assert poll_calls and len(poll_calls[0] or []) >= 3 and poll_calls[0][2] is True
        finished = next(
            args[3]
            for name, args in fake.activity_calls
            if name == "post_agent_message"
            and len(args or []) >= 4
            and (args[3] or {}).get("toolName") == "completion_summary"
            and (args[3] or {}).get("toolStatus") == "FINISHED"
        )
        summary = str(((finished or {}).get("completionSummary") or {}).get("summary") or "")
        assert "Fast Mode" not in summary
        assert "verified results are included below" not in summary.lower()
        assert len(summary) >= 200
        assert "Wes Roth" in summary or "AI" in summary or "YouTube" in summary
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_polls_assemble_for_schema_outputs():
    """Root DAG assemble is posted after execute_context snapshot; poll it onto the card."""
    wf = _bare_workflow_instance()
    wf.agent_id = "root-oai-assemble"
    wf.user_id = "u-mc"
    wf.goal = "Analyze the top 50 creators for Andy Prevalsky."
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.agent_source = "WEB"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.child_tool_counts = {}
    wf.output_schema = {
        "fields": [
            {"name": "top_creators_analysis", "type": "str"},
            {"name": "positioning_statement", "type": "str"},
            {"name": "ninety_day_content_calendar", "type": "str"},
        ]
    }
    assemble = (
        "July cache assemble of Andy Prevalsky's creator brief.\n\n"
        "# top_creators_analysis\n\n"
        "1. Andrew Huberman — Huberman Lab cadence, hooks, and coverage gaps.\n\n"
        "# positioning_statement\n\n"
        "Andy as the founder-operator who translates longevity science into operating systems.\n\n"
        "# ninety_day_content_calendar\n\n"
        "Week 1: sleep audit. Week 2: training block. Week 3: founder recovery."
    )
    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 1, 0, tzinfo=timezone.utc)
    fake.activity_returns["poll_new_messages"] = [
        {
            "role": "ASSISTANT",
            "message": assemble,
            "metadata": {"plannedToolName": "reasoning", "dagTaskIndex": 6},
        }
    ]
    fake.activity_returns["generate_completion_summary"] = {
        "summary": (
            "Completed a 50-creator competitive analysis across health, longevity, "
            "technology, and founder-journey niches, then synthesized Andy's "
            "differentiated positioning, a 90-day multi-platform content calendar, "
            "and a weekly engagement list of creators to get on his radar."
        ),
        "tool_counts": {"spawn_agent": 50},
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "from_fast_cache": True,
        },
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(context=[], structured_response=None)
        finished = next(
            args[3]
            for name, args in fake.activity_calls
            if name == "post_agent_message"
            and len(args or []) >= 4
            and (args[3] or {}).get("toolName") == "completion_summary"
            and (args[3] or {}).get("toolStatus") == "FINISHED"
        )
        card = (finished or {}).get("completionSummary") or {}
        summary = str(card.get("summary") or "")
        assert "Fast Mode" not in summary
        assert "50-creator" in summary
        outputs = card.get("outputs") or []
        keys = {item.get("key") for item in outputs}
        assert keys == {
            "top_creators_analysis",
            "positioning_statement",
            "ninety_day_content_calendar",
        }
        values = " ".join(str(item.get("value") or "") for item in outputs)
        assert "Huberman" in values
        assert "90-day" in values or "Week 1" in values
    finally:
        _restore_workflow(original)


async def test_workflow_check_cost_limit_skipped_after_finished():
    """The cost limit authorizes future spend; it must not re-open a finished agent.

    _mark_complete latches _is_finished first, then tracks the completion
    summary's own LLM cost (agent_workflow.py:_mark_complete -> _track_llm_cost
    -> _update_cost_and_signal_parent -> _check_cost_limit). A late
    child_cost_update signal from a sub-agent lands on the same path. Without
    an _is_finished guard, that check writes COST_LIMIT_REACHED over an agent
    whose verifier already scored 100% — the exact
    "Agent status: COST_LIMIT_REACHED (expected COMPLETED)" verdict the
    benchmark records, because COST_LIMIT_REACHED is a terminal status for
    every poller.
    """
    wf = _bare_workflow_instance()
    wf.agent_id = "root-finished"
    wf.user_id = "u"
    wf.parent_workflow_id = None
    wf.subtree_cost_cents = 500.0
    wf.price_limit_cents = 50
    wf._is_finished = True  # _mark_complete already latched the terminal flag
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._check_cost_limit()
        assert wf._cost_limit_reached is False, "_check_cost_limit flipped a finished agent to cost-limited"
        assert wf.is_paused is False, "_check_cost_limit paused a finished agent"
        for fn_name, args in fake.activity_calls:
            if (
                fn_name == "update_agent_status"
                and isinstance(args, (list, tuple))
                and len(args) >= 2
                and args[1] == "COST_LIMIT_REACHED"
            ):
                raise AssertionError(
                    "update_agent_status wrote COST_LIMIT_REACHED after _is_finished "
                    "was latched — a verified-complete root is reported as cost-limited."
                )
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_summary_cost_does_not_cost_limit_root():
    """End-to-end at the boundary: the completion summary's own cost must not
    flip the completing root to COST_LIMIT_REACHED."""
    wf = _bare_workflow_instance()
    wf.agent_id = "root-summary-cost"
    wf.user_id = "u"
    wf.goal = "g"
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.agent_source = "WEB"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.child_tool_counts = {}
    wf.output_schema = {"fields": []}
    # Already just under the cap when the verifier passed.
    wf.own_cost_cents = 49.0
    wf.price_limit_cents = 50
    wf.input_cents_per_1k = 1.0
    wf.output_cents_per_1k = 1.0

    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 1, 0, tzinfo=timezone.utc)
    fake.activity_returns["generate_completion_summary"] = {
        "summary": "done",
        "tool_counts": {},
        # 5k tokens at 1c/1k tips the subtree over the 50c cap.
        "usage": {"prompt_tokens": 5000, "completion_tokens": 0, "total_tokens": 5000},
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(context=[], structured_response=None)
        assert "mark_finished" in [c[0] for c in fake.activity_calls]
        for fn_name, args in fake.activity_calls:
            if (
                fn_name == "update_agent_status"
                and isinstance(args, (list, tuple))
                and len(args) >= 2
                and args[1] == "COST_LIMIT_REACHED"
            ):
                raise AssertionError(
                    "the completion summary's own cost flipped the completing root to COST_LIMIT_REACHED"
                )
        assert wf._cost_limit_reached is False
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_persists_summary_cost():
    """Letting a verified root resolve must not drop the summary's cost.

    `_mark_complete` latches `_is_finished` and persists the tree cost BEFORE
    `generate_completion_summary` runs, then charges that call's own LLM cost via
    `_track_llm_cost`. That charge routes through
    `_update_cost_and_signal_parent`, whose persist is debounced to one emit per
    3s — so the terminal persist that just ran swallows it and the summary's cost
    is tracked in memory but never written. Every downstream consumer (agent row,
    FE cost display, benchmark `cost_cents`) then under-reports the run.
    """
    wf = _bare_workflow_instance()
    wf.agent_id = "root-summary-cost-persist"
    wf.user_id = "u"
    wf.goal = "g"
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.agent_source = "WEB"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.child_tool_counts = {}
    wf.output_schema = {"fields": []}
    wf.own_cost_cents = 10.0
    wf.children_cost_cents = {}
    wf.price_limit_cents = 500
    wf.input_cents_per_1k = 1.0
    wf.output_cents_per_1k = 1.0

    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 1, 0, tzinfo=timezone.utc)
    fake.activity_returns["generate_completion_summary"] = {
        "summary": "done",
        "tool_counts": {},
        # 5k prompt tokens at 1c/1k = 5c of real spend on the summary itself.
        "usage": {"prompt_tokens": 5000, "completion_tokens": 0, "total_tokens": 5000},
    }
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(context=[], structured_response=None)
        assert wf.own_cost_cents == 15.0, f"summary cost was not charged: {wf.own_cost_cents}"
        persisted = [args for name, args in fake.activity_calls if name == "update_agent_tree_cost_activity"]
        assert persisted, "terminal transition persisted no tree cost at all"
        # args = [agent_id, subtree_cost_cents, ...]
        last_persisted = persisted[-1][1]
        assert last_persisted == 15.0, (
            f"last persisted tree cost was {last_persisted}c but the run actually "
            f"cost {wf.own_cost_cents}c — the completion summary's spend was dropped"
        )
    finally:
        _restore_workflow(original)


async def test_workflow_cost_limit_flushes_tree_cost_before_pausing():
    """A cost-limited run must not report 0c.

    `_update_cost_and_signal_parent` debounces its persist to one emit per 3s,
    and the cost-limit transition is terminal — the agent pauses right after —
    so a suppressed emit leaves the pre-trip value as the last number written.
    Agent a67ef234-e1d8-4e72-adda-020cdcab6059 tripped a 50c cap and its run
    record still reported `cost_cents: 0`, which made the trip impossible to
    reconcile from the record alone.
    """
    wf = _bare_workflow_instance()
    wf.agent_id = "root-cost-flush"
    wf.user_id = "u"
    wf.parent_workflow_id = None
    wf.own_cost_cents = 54.0
    wf.children_cost_cents = {}
    wf.subtree_cost_cents = 54.0
    wf.price_limit_cents = 50
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._check_cost_limit()
        assert wf._cost_limit_reached is True
        cost_persists = [args for name, args in fake.activity_calls if name == "update_agent_tree_cost_activity"]
        assert cost_persists, (
            "no tree-cost persist accompanied the cost-limit transition — every "
            "consumer keeps reading the stale pre-trip cost"
        )
        assert cost_persists[-1][1] == 54, f"persisted stale tree cost {cost_persists[-1][1]}c, expected 54c"
        status_calls = [
            args
            for name, args in fake.activity_calls
            if name == "update_agent_status" and len(args or []) >= 4 and args[1] == "COST_LIMIT_REACHED"
        ]
        assert status_calls, "no COST_LIMIT_REACHED status write"
        message = status_calls[-1][3]
        assert "54.0c" in message and "50c" in message, (
            f"cost-limit status message must carry the decision inputs, got: {message}"
        )
    finally:
        _restore_workflow(original)


async def test_workflow_mark_complete_degraded_summary_keeps_notification():
    """A failed summary must degrade the narration, never drop the notification.

    The root completion SMS is gated on `summary` being truthy and the parent's
    child_completed handler falls back to a goal restatement, so an empty
    summary silently cancels a successful run's notification.
    """
    wf = _bare_workflow_instance()
    wf.agent_id = "root-degraded-summary"
    wf.user_id = "u"
    wf.goal = "return one bing result"
    wf.model = "rose-1-flash"
    wf.parent_workflow_id = None
    wf.agent_source = "WEB"
    wf.start_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.child_tool_counts = {}
    wf.output_schema = {"fields": []}

    fake = _FakeWorkflowModule()
    fake.now_value = datetime(2025, 1, 1, 0, 1, 0, tzinfo=timezone.utc)
    fake.activity_fail_for.add("generate_completion_summary")
    original = _patch_workflow(fake)
    try:
        await wf._mark_complete(context=[], structured_response={"answer": "42"})
        completion_notifications = [
            args
            for name, args in fake.activity_calls
            if name == "notify_sms_event_activity" and len(args or []) >= 2 and args[1] == "completion"
        ]
        assert completion_notifications, (
            "a successful run lost its completion notification because the summary LLM failed"
        )
        final_summary = next(
            args[3]
            for name, args in fake.activity_calls
            if name == "post_agent_message"
            and len(args or []) >= 4
            and (args[3] or {}).get("toolStatus") == "FINISHED"
            and (args[3] or {}).get("toolName") == "completion_summary"
        )
        assert final_summary["completionSummary"]["summaryError"], (
            "the summary failure must stay visible on the final message"
        )
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
    """_format_outputs still returns outputs when schema gen missed."""
    wf = _bare_workflow_instance()
    wf.output_schema = None
    outputs = wf._format_outputs({"answer": "anything"})
    assert outputs == [{"key": "answer", "label": "Answer", "value": "anything"}]


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


async def test_workflow_retained_output_dispatch_and_error_pairing():
    import re
    from unittest.mock import AsyncMock, patch
    from _test_utils import retained_tool_output_fixture
    from helpers.tool_output import preview_tool_text
    from tools.read_tool_output import read_tool_output_activity
    import tools.read_tool_output as reader
    from helpers.llm import build_llm_messages

    import ast
    from pathlib import Path
    from tools.read_tool_output import preview_tool_output_activity

    registry_tree = ast.parse((Path(__file__).resolve().parents[2] / "worker.py").read_text())
    registry = next(node.value for node in ast.walk(registry_tree) if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == "registered_activities" for target in node.targets))
    registered_names = {node.id for node in registry.elts if isinstance(node, ast.Name)}
    for fn in (read_tool_output_activity, preview_tool_output_activity):
        assert fn.__temporal_activity_definition.name in registered_names

    wf = _bare_workflow_instance()
    wf.agent_id, wf.user_id = "agent", "user"
    wf._update_tree_state = AsyncMock()
    receipts = []

    async def handle(event, call_id, name):
        receipts.append({"role": "TOOL", "text": event.message, "metadata": {
            "toolCallId": call_id, "toolName": name, "toolStatus": event.status.value}})
    wf._handle_tool_event = handle

    async def execute_activity(fn, *, args, **kwargs):
        assert fn is read_tool_output_activity
        return await fn(*args)

    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        with retained_tool_output_fixture(), patch.object(reader.workflow, "execute_activity", execute_activity):
            preview = await preview_tool_text("body " * 25000 + "MAIN_TAIL", user_id="user", agent_id="agent")
            output_id = re.search(r'output_id="([a-f0-9]{32})"', preview)[1]
            result = await wf._execute_tool("read_tool_output", {"output_id": output_id, "query": "MAIN_TAIL", "user_id": "attacker"}, "read-main")
            assert not result.get("error"), result
            context = [{"role": "ASSISTANT", "text": "", "metadata": {"tool_calls": [
                {"tool": "read_tool_output", "tool_call_id": "read-main", "output_id": output_id}]}}, receipts[-1]]
            messages = await build_llm_messages(context, "system", user_id="user", agent_id="agent")
            assert "MAIN_TAIL" in messages[-1]["content"]
            for args in ({"output_id": "invalid"}, {"output_id": "f" * 32}):
                result = await wf._execute_tool("read_tool_output", args, "bad-read")
                assert result.get("error"), result
                assert receipts[-1]["metadata"]["toolStatus"] == "ERROR"
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

    setattr(wf, "_handle_tool_event", fake_handle)
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
        {"response": "ok", "tool_calls": [{"tool": "spawn_agent", "type": "explore", "task_name": "x", "goal": "x"}]}
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

    setattr(wf, "_handle_tool_event", fake_handle)
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
                "task_name": "population",
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


async def test_workflow_generic_browser_result_gets_existing_budget_wrapup():
    """Generic browser dispatch retains the completed result across its usage charge."""
    from unittest.mock import AsyncMock, patch

    import workflows.agent_workflow as workflow_module
    import domains.spawn_agent.handler as spawn_module
    from tools.base import EventType, MessageStatus, ToolEvent

    wf = _bare_workflow_instance()
    wf.agent_id = "root-browser-budget"
    wf.user_id = "user-browser-budget"
    wf.current_phase = "EXECUTE"
    wf.agent_source = "WEB"
    wf.own_cost_cents = 119.0
    wf.price_limit_cents = 120
    wf._handle_tool_event = AsyncMock()

    class CompletedBrowser:
        async def execute_tool(self, workflow_instance, tool_call, tool_call_id):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                status=MessageStatus.FINISHED,
                message="Browser returned the observed result",
                metadata={
                    "action_type": "task_complete",
                    "success": True,
                    "structured_response": {"answer": "Observed result"},
                },
                data={"usage": {"service": [{"provider": "browser", "cost_cents": 2.0}]}},
            )

    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        with (
            patch.object(spawn_module, "workflow", fake),
            patch.object(spawn_module, "get_manager", return_value=CompletedBrowser()),
            patch.object(
                workflow_module,
                "TOOL_EXECUTORS",
                {**workflow_module.TOOL_EXECUTORS, "spawn_agent": spawn_module.spawn_agent},
            ),
        ):
            result = await wf._execute_tool(
                "spawn_agent",
                {
                    "type": "browser",
                    "task_name": "observe",
                    "goal": "Observe the page",
                    "start_url": "https://example.com",
                    "output_schema": {"fields": []},
                },
                "browser-call",
            )
        assert result == {"success": True, "message": "spawn_agent completed"}, result
        assert wf.own_cost_cents == 121.0 and wf.subtree_cost_cents == 121.0
        assert wf.price_limit_cents == 120, "completion must not raise the cap"
        assert wf._cost_limit_wrapup_pending, "completed generic browser never reached the existing wrap-up lifecycle"
        assert not await wf._check_paused(), "completed result cannot reach root completion"
        terminal_cost_writes = [
            args
            for name, args in fake.activity_calls
            if name == "update_agent_status" and args[1] == "COST_LIMIT_REACHED"
        ]
        assert not terminal_cost_writes, "pollers can observe a terminal budget status before wrap-up"
        assert not await wf._check_paused_before_turn()
        for _ in range(3):
            assert not await wf._check_paused(), "stream checks consumed the one admitted turn"
        wf.goal = "Observe the page"
        wf.start_time = fake.now_value
        wf.output_schema = {"fields": [{"name": "answer", "type": "str"}]}
        await wf._mark_complete(context=[], structured_response={"answer": "Observed result"})
        assert wf._is_finished
        assert any(name == "mark_finished" for name, _ in fake.activity_calls)
        assert wf.own_cost_cents == 121.0
        assert not any(
            name == "update_agent_status" and args[1] == "COST_LIMIT_REACHED" for name, args in fake.activity_calls
        )
    finally:
        _restore_workflow(original)


async def test_workflow_browser_usage_arms_before_child_cost_interleaving():
    wf = _bare_workflow_instance()
    wf.agent_id, wf.user_id, wf.agent_source = "settlement-race", "budget-user", "WEB"
    wf.own_cost_cents, wf.price_limit_cents = 119.0, 120
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    persist = wf._persist_tree_cost
    interleaved = False

    async def persist_with_signal():
        nonlocal interleaved
        if not interleaved:
            interleaved = True
            await wf.child_cost_update({"child_agent_id": "already-running-child", "subtree_cost_cents": 0.5})
        await persist()

    wf._persist_tree_cost = persist_with_signal
    try:
        await wf._track_usage(
            {"service": [{"provider": "browser", "cost_cents": 2.0}]},
            tool_name="spawn_agent",
            browser_completed=True,
        )
        assert interleaved
        assert wf.own_cost_cents == 121.0 and wf.subtree_cost_cents == 121.5
        assert wf._cost_limit_wrapup_pending and not wf.is_paused
        assert not any(
            name == "update_agent_status" and args[1] == "COST_LIMIT_REACHED" for name, args in fake.activity_calls
        ), "child signal published terminal cost stop during verified browser settlement"
    finally:
        _restore_workflow(original)


async def test_workflow_browser_pricing_cannot_reopen_an_intervening_cost_stop():
    wf = _bare_workflow_instance()
    wf.agent_id, wf.user_id, wf.agent_source = "pricing-race", "budget-user", "WEB"
    wf.own_cost_cents, wf.price_limit_cents = 119.0, 120
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)

    async def pricing_with_signal(model):
        await wf.child_cost_update({"child_agent_id": "already-running-child", "subtree_cost_cents": 2.0})
        return {"input_cents_per_1k": 2.0, "output_cents_per_1k": 0.0}

    wf._get_model_pricing = pricing_with_signal
    try:
        await wf._track_usage(
            {"llm": [{"model": "priced-browser-model", "provider": "browser", "tokens_in": 1000}]},
            tool_name="spawn_agent",
            browser_completed=True,
        )
        assert wf.own_cost_cents == 121.0 and wf.subtree_cost_cents == 123.0
        assert wf.is_paused and wf._cost_limit_reached
        assert not wf._cost_limit_wrapup_pending, "terminal usage reopened an unrelated cost stop"
        stops = [
            args
            for name, args in fake.activity_calls
            if name == "update_agent_status" and args[1] == "COST_LIMIT_REACHED"
        ]
        assert len(stops) == 1
    finally:
        _restore_workflow(original)


async def test_workflow_inflight_refusal_preserves_unadmitted_browser_wrapup():
    from unittest.mock import AsyncMock, patch
    import workflows.agent_workflow as workflow_module

    wf = _bare_workflow_instance()
    wf.agent_id, wf.user_id, wf.agent_source = "inflight-wrapup", "budget-user", "WEB"
    wf.own_cost_cents = wf.subtree_cost_cents = 121.0
    wf.price_limit_cents = 120
    wf._cost_limit_reached = wf._cost_limit_wrapup_pending = True
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    executor = AsyncMock()
    try:
        with patch.dict(workflow_module.TOOL_EXECUTORS, {"web_search": executor}):
            results = await asyncio.gather(
                wf._execute_tool("web_search", {"query": "old turn one"}, "inflight-one"),
                wf._execute_tool("web_search", {"query": "old turn two"}, "inflight-two"),
            )
        assert all(result.get("error") is True for result in results)
        executor.assert_not_awaited()
        assert wf._cost_limit_wrapup_pending, "old in-flight work consumed the future completion allowance"
        assert not wf._cost_limit_wrapup_consumed and not wf.is_paused
        assert not any(
            name == "update_agent_status" and args[1] == "COST_LIMIT_REACHED" for name, args in fake.activity_calls
        )
        assert not await wf._check_paused_before_turn()
        assert wf._cost_limit_wrapup_consumed
        wf.goal = "Report the returned browser result"
        wf.start_time = fake.now_value
        wf.output_schema = {"fields": [{"name": "answer", "type": "str"}]}
        await wf._mark_complete(context=[], structured_response={"answer": "Observed result"})
        assert wf._is_finished
        assert any(name == "mark_finished" for name, _ in fake.activity_calls)
    finally:
        _restore_workflow(original)


async def test_workflow_browser_pricing_preserves_intervening_credit_pause(credit_restored=False):
    wf = _bare_workflow_instance()
    wf.agent_id, wf.user_id, wf.agent_source = "credit-pause-wrapup", "budget-user", "WEB"
    wf.own_cost_cents, wf.price_limit_cents = 119.0, 120
    fake = _FakeWorkflowModule()
    fake.activity_returns["check_user_usage"] = {"has_credits": False, "tier": "paid"}
    original = _patch_workflow(fake)

    async def pricing_after_credit_check(model):
        await wf._check_credits()
        if credit_restored:
            fake.activity_returns["check_user_usage"] = {"has_credits": True, "tier": "paid"}
            await wf._check_credits()
        return {"input_cents_per_1k": 2.0, "output_cents_per_1k": 0.0}

    wf._get_model_pricing = pricing_after_credit_check
    try:
        await wf._track_usage(
            {"llm": [{"model": "priced-browser-model", "provider": "browser", "tokens_in": 1000}]},
            tool_name="spawn_agent",
            browser_completed=True,
        )
        assert wf.own_cost_cents == 121.0 and wf._has_credits is credit_restored
        assert wf.is_paused and not wf._cost_limit_wrapup_pending, "terminal browser accounting bypassed a credit pause"
        assert await wf._check_paused_before_turn()
    finally:
        _restore_workflow(original)


async def test_workflow_browser_wrapup_restore_preserves_cached_credit_pause():
    wf = _bare_workflow_instance()
    state = _deployment_resume_fixture("COST_LIMIT_REACHED")
    state["runtime_state"] = {
        "cost_limit_wrapup_pending": True,
        "cost_limit_wrapup_consumed": False,
        "has_credits": False,
    }
    wf._restore_deployment_state(state)
    assert not wf._has_credits
    assert wf.is_paused, "restoring an unused completion allowance bypassed cached credit pause"
    assert await wf._check_paused_before_turn()
    assert not wf._cost_limit_wrapup_consumed


async def test_workflow_browser_pricing_preserves_credit_pause_after_refresh():
    await test_workflow_browser_pricing_preserves_intervening_credit_pause(credit_restored=True)


async def test_workflow_armed_browser_wrapup_keeps_refreshed_credit_pause_across_continuation():
    import json

    wf = _bare_workflow_instance()
    wf.agent_id, wf.user_id, wf.agent_source = "armed-credit-continuation", "budget-user", "WEB"
    wf.own_cost_cents, wf.price_limit_cents = 119.0, 120
    wf.max_iterations = 500
    wf.context_gates = {}
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._track_usage(
            {"service": [{"provider": "browser", "cost_cents": 2.0}]},
            tool_name="spawn_agent",
            browser_completed=True,
        )
        assert wf._cost_limit_wrapup_pending and not wf._cost_limit_wrapup_consumed and not wf.is_paused
        fake.activity_returns["check_user_usage"] = {"has_credits": False, "tier": "paid"}
        await wf._check_credits()
        fake.activity_returns["check_user_usage"] = {"has_credits": True, "tier": "paid"}
        await wf._check_credits()
        assert wf._has_credits and wf.is_paused and wf._cost_limit_wrapup_pending
        state = json.loads(json.dumps(wf._continuation_resume_state(wf.context)))
        restored = _bare_workflow_instance()
        restored._restore_deployment_state(state)
        assert restored._has_credits and restored._cost_limit_wrapup_pending
        assert restored.is_paused, "continuation restore cleared a financial pause after credit refresh"
        assert await restored._check_paused_before_turn()
        assert not restored._cost_limit_wrapup_consumed
        await restored.resume()
        assert not await restored._check_paused_before_turn()
        assert restored._cost_limit_wrapup_consumed
    finally:
        _restore_workflow(original)


async def test_workflow_browser_wrapup_restore_requires_unpaused_continuation_provenance():
    for value in (None, True, "false", 0):
        state = _deployment_resume_fixture("COST_LIMIT_REACHED")
        state["runtime_state"] = {
            "cost_limit_wrapup_pending": True,
            "cost_limit_wrapup_consumed": False,
            "has_credits": True,
        }
        if value is not None:
            state["runtime_state"]["cost_limit_wrapup_paused"] = value
        restored = _bare_workflow_instance()
        restored._restore_deployment_state(state)
        assert restored.is_paused, "missing or invalid pause provenance authorized completion admission"
        assert not restored._cost_limit_wrapup_consumed


async def test_workflow_background_browser_budget_keeps_native_notification_and_result():
    from unittest.mock import AsyncMock, patch
    import workflows.background_agents as background_module
    import workflows.agent_workflow as workflow_module
    import domains.spawn_agent.handler as spawn_module
    from tools.base import EventType, MessageStatus, ToolEvent

    wf = _bare_workflow_instance()
    wf.agent_id, wf.user_id, wf.agent_source = "background-budget", "user-budget", "WEB"
    wf.own_cost_cents, wf.price_limit_cents = 119.0, 120
    wf.current_phase = "EXECUTE"
    args = {
        "type": "browser",
        "task_name": "observe",
        "goal": "Observe",
        "start_url": "https://example.com",
        "output_schema": {"fields": [{"name": "answer", "type": "str", "required": True}]},
    }
    wf._background_tasks["browser-call"] = {
        "agent_type": "browser",
        "address": "/root/observe",
        "path": "/root/observe",
        "tool_args": args,
    }
    wf._notification_recipient = AsyncMock(return_value="/root")
    wf._post_message = AsyncMock()

    async def record_event(event, tool_call_id, tool_name):
        wf._record_background_event(event, tool_call_id)

    wf._handle_tool_event = record_event

    class CompletedBrowser:
        async def execute_tool(self, workflow_instance, tool_call, tool_call_id):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                status=MessageStatus.FINISHED,
                message="Observed",
                metadata={
                    "action_type": "task_complete",
                    "success": True,
                    "structured_response": {"answer": "Observed"},
                },
                data={"usage": {"service": [{"provider": "browser", "cost_cents": 2.0}]}},
            )

    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        with (
            patch.object(background_module, "workflow", fake),
            patch.object(spawn_module, "workflow", fake),
            patch.object(spawn_module, "get_manager", return_value=CompletedBrowser()),
            patch.dict(workflow_module.TOOL_EXECUTORS, {"spawn_agent": spawn_module.spawn_agent}),
        ):
            await wf._run_background_task("browser-call", 0)
        assert wf._background_finished["browser-call"]["status"] == "completed", (
            wf._background_finished,
            fake.logger.records,
        )
        assert "browser-call" in wf._background_settled
        assert wf._post_message.await_count == 1
        notification = wf._post_message.call_args.args[0]
        assert "Observed" in notification and "answer" in notification
        assert wf._cost_limit_wrapup_pending and not wf.is_paused
        assert not any(
            name == "update_agent_status" and args[1] == "COST_LIMIT_REACHED" for name, args in fake.activity_calls
        )
    finally:
        _restore_workflow(original)


async def test_workflow_unverified_browser_and_other_usage_do_not_get_wrapup():
    from unittest.mock import AsyncMock, patch
    import workflows.agent_workflow as workflow_module
    import domains.spawn_agent.handler as spawn_module
    from tools.base import EventType, MessageStatus, ToolEvent

    for kind, status, success in (
        ("browser", MessageStatus.ERROR, False),
        ("browser", MessageStatus.FINISHED, False),
        ("explore", MessageStatus.FINISHED, True),
    ):
        wf = _bare_workflow_instance()
        wf.agent_id, wf.user_id, wf.agent_source = "noncompletion", "user-budget", "WEB"
        wf.current_phase = "EXECUTE"
        wf.own_cost_cents, wf.price_limit_cents = 119.0, 120
        wf._handle_tool_event = AsyncMock()

        class TerminalManager:
            async def execute_tool(self, workflow_instance, tool_call, tool_call_id):
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    status=status,
                    metadata={"action_type": "task_complete", "success": success},
                    data={"usage": {"service": [{"provider": "browser", "cost_cents": 2.0}]}},
                )

        fake = _FakeWorkflowModule()
        original = _patch_workflow(fake)
        try:
            with (
                patch.object(spawn_module, "workflow", fake),
                patch.object(spawn_module, "get_manager", return_value=TerminalManager()),
                patch.dict(workflow_module.TOOL_EXECUTORS, {"spawn_agent": spawn_module.spawn_agent}),
            ):
                result = await wf._execute_tool(
                    "spawn_agent",
                    {
                        "type": kind,
                        "task_name": "observe",
                        "goal": "Observe",
                        "start_url": "https://example.com",
                        "output_schema": {"fields": []},
                    },
                    "terminal-call",
                )
            assert wf.own_cost_cents == 121.0, (kind, result)
            assert wf.is_paused and wf._cost_limit_reached
            assert not wf._cost_limit_wrapup_pending
            assert any(
                name == "update_agent_status" and args[1] == "COST_LIMIT_REACHED" for name, args in fake.activity_calls
            )
        finally:
            _restore_workflow(original)


async def test_workflow_browser_budget_wrapup_stops_after_one_turn_and_keeps_pauses():
    for pause_kind in ("none", "user_before", "parent_before", "limited_before", "user_during"):
        wf = _bare_workflow_instance()
        wf.agent_id = "budget-control"
        wf.user_id = "budget-user"
        wf.agent_source = "WEB"
        wf.own_cost_cents = 119.0
        wf.price_limit_cents = 120
        wf.is_paused = pause_kind in {"user_before", "parent_before", "limited_before"}
        wf._user_pause_active = pause_kind == "user_before"
        wf._paused_by_parent = pause_kind == "parent_before"
        wf._cost_limit_reached = pause_kind == "limited_before"
        fake = _FakeWorkflowModule()
        original = _patch_workflow(fake)
        execute_activity = fake.execute_activity
        interrupted = False

        async def activity_with_pause(fn, args=None, **kwargs):
            nonlocal interrupted
            if pause_kind == "user_during" and not interrupted:
                interrupted = True
                await wf.pause()
            return await execute_activity(fn, args=args, **kwargs)

        fake.execute_activity = activity_with_pause
        try:
            await wf._track_usage(
                {"service": [{"provider": "browser", "cost_cents": 2.0}]},
                tool_name="spawn_agent",
                browser_completed=True,
            )
            assert wf.own_cost_cents == 121.0 and wf.price_limit_cents == 120
            if pause_kind != "none":
                if pause_kind != "user_during":
                    assert not wf._cost_limit_wrapup_pending, pause_kind
                assert wf.is_paused, pause_kind
                assert await wf._check_paused_before_turn(), "an explicit pause must block admission"
                assert not wf._cost_limit_wrapup_consumed, "a paused turn cannot consume the allowance"
                if pause_kind.startswith("user"):
                    assert wf._user_pause_active
                continue
            assert not await wf._check_paused_before_turn()
            for _ in range(3):
                assert not await wf._check_paused()
            assert await wf._check_paused_before_turn(), "a second turn escaped the original cap"
            assert wf._cost_limit_reached and not wf._cost_limit_wrapup_pending
            stops = [
                args
                for name, args in fake.activity_calls
                if name == "update_agent_status" and args[1] == "COST_LIMIT_REACHED"
            ]
            assert len(stops) == 1
        finally:
            _restore_workflow(original)


async def test_workflow_browser_wrapup_cannot_start_productive_work_or_renew_after_restore():
    from unittest.mock import AsyncMock, patch
    import workflows.agent_workflow as workflow_module

    wf = _bare_workflow_instance()
    wf.agent_id = "budget-stop"
    wf.user_id = "budget-user"
    wf.agent_source = "WEB"
    wf.own_cost_cents = wf.subtree_cost_cents = 121.0
    wf.price_limit_cents = 120
    wf._cost_limit_reached = wf._cost_limit_wrapup_pending = True
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    executor = AsyncMock()
    try:
        assert not await wf._check_paused_before_turn()
        assert wf._cost_limit_wrapup_consumed
        with patch.dict(workflow_module.TOOL_EXECUTORS, {"web_search": executor}):
            results = await asyncio.gather(
                wf._execute_tool("web_search", {"query": "new work one"}, "new-work-one"),
                wf._execute_tool("web_search", {"query": "new work two"}, "new-work-two"),
            )
            results.append(await wf._execute_tool("web_search", {"query": "new work three"}, "new-work-three"))
        assert all(result.get("error") is True for result in results), results
        executor.assert_not_awaited()
        assert wf.is_paused
        for consumed in (False, True):
            restored = _bare_workflow_instance()
            state = _deployment_resume_fixture("COST_LIMIT_REACHED")
            state["runtime_state"] = {
                "cost_limit_wrapup_pending": True,
                "cost_limit_wrapup_consumed": consumed,
                "cost_limit_wrapup_paused": False,
            }
            restored._restore_deployment_state(state)
            assert await restored._check_paused_before_turn() is consumed
            if not consumed:
                assert not await restored._check_paused()
    finally:
        _restore_workflow(original)


async def test_workflow_execute_tool_handoff_includes_task_queue():
    """_execute_tool must pass the live queue through so run_agent can CAN now."""
    from helpers.generation_handoff import DEPLOY_INTERRUPTED_TOOL_MESSAGE, GenerationHandoffRequested

    wf = _bare_workflow_instance()
    wf.agent_id = "a-handoff"
    wf.user_id = "u1"
    wf.current_phase = "EXECUTE"

    import workflows.agent_workflow as workflow_module

    async def fake_spawn_agent(workflow_instance, tool_call, tool_call_id):
        raise GenerationHandoffRequested("navi-agent-tasks@new")

    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    original_executor = workflow_module.TOOL_EXECUTORS["spawn_agent"]
    workflow_module.TOOL_EXECUTORS["spawn_agent"] = fake_spawn_agent
    try:
        result = await wf._execute_tool(
            "spawn_agent",
            {"type": "explore", "task_name": "parked", "goal": "parked child"},
            "tc-handoff",
        )
        assert result.get("success") is True
        assert result.get("generation_handoff") is True
        assert result.get("handoff_task_queue") == "navi-agent-tasks@new"
        assert result.get("message") == DEPLOY_INTERRUPTED_TOOL_MESSAGE
        assert result.get("error") is not True
    finally:
        workflow_module.TOOL_EXECUTORS["spawn_agent"] = original_executor
        _restore_workflow(original)


async def test_workflow_execute_tool_web_fetch_preserves_fast_mode_kwargs():
    """web_fetch auth kwargs must merge with, not replace, Fast Mode cache kwargs."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.compute_token_lineage_key = "agent:lineage-1"
    # Cache kwargs must thread the persisted-row goal, not the (possibly
    # chat-refined) workflow input goal.
    wf.goal = "refined workflow input goal"
    wf.demo_cache_goal = "root goal"
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
        assert captured_kwargs["compute_token_lineage_key"] == "agent:lineage-1"
    finally:
        workflow_module.TOOL_EXECUTORS["web_fetch"] = original_executor
        _restore_workflow(original)


async def test_workflow_attempt_completion_drains_fast_mode_explores():
    """attempt_completion still drains leftover tracked explores if any exist."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-1"
    wf.user_id = "user-1"
    wf.fast_mode_cache_enabled = True
    wf.current_phase = "EXECUTE"

    class _Pending:
        def __init__(self):
            self.awaited = False
            self._done = False

        def done(self):
            return self._done

        def __await__(self):
            async def _inner():
                self.awaited = True
                self._done = True
                return {"result": "explore done"}

            return _inner().__await__()

    pending = _Pending()
    wf._fm_explore_handles = [{"handle": pending, "task_id": "t1", "tool_call_id": "tc", "ui_goal": "g"}]

    async def fake_complete(**_kwargs):
        return {"result": "done"}

    async def fake_tree():
        return None

    wf._update_tree_state = fake_tree

    import workflows.agent_workflow as workflow_module

    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    original_executor = workflow_module.TOOL_EXECUTORS["attempt_completion"]
    workflow_module.TOOL_EXECUTORS["attempt_completion"] = fake_complete
    try:
        result = await wf._execute_tool("attempt_completion", {}, "tc-complete")
        assert result.get("success") is True
        assert pending.awaited is True
        assert not wf._fm_explore_handles
    finally:
        workflow_module.TOOL_EXECUTORS["attempt_completion"] = original_executor
        _restore_workflow(original)


async def test_workflow_approval_text_repopulates_same_tool_then_executes_once():
    """Approved-with-text refreshes only the pending call's params and does not gate twice."""
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-approval-jit"
    wf.user_id = "user-1"
    wf.model = "rose-labs/rose-1-flash"
    wf.current_phase = "EXECUTE"
    wf.fast_mode_cache_enabled = True
    wf.demo_cache_goal = "Call the restaurant and book dinner"
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
        assert llm_args[1] == wf.model
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


async def test_workflow_rotate_compute_token_releases_lineage_and_refetches():
    wf = _bare_workflow_instance()
    wf.agent_id = "agent-rotate"
    wf.user_id = "user-1"
    wf.compute_token_provider = "claude"
    wf.claude_max_token = "stale-token"
    wf.claude_max_token_source = "pool"
    wf.compute_token_lineage_key = "agent:agent-rotate"
    fake = _FakeWorkflowModule()
    fake.activity_returns["fetch_compute_token_activity"] = {
        "type": "gpt",
        "accessToken": "fresh-gpt",
        "accountId": "acct-1",
        "source": "pool",
        "poolTokenId": "pool-gpt-1",
    }
    original = _patch_workflow(fake)
    try:
        await wf._rotate_compute_token("user-1")
        assert wf.compute_token_provider == "gpt"
        assert wf.gpt_code_token == "fresh-gpt"
        activity_names = [c[0] for c in fake.activity_calls]
        assert "release_compute_token_lineage_activity" in activity_names
        release_call = next(c for c in fake.activity_calls if c[0] == "release_compute_token_lineage_activity")
        assert release_call[1] == ["agent:agent-rotate"]
        fetch_call = next(c for c in fake.activity_calls if c[0] == "fetch_compute_token_activity")
        assert fetch_call[1][-1] == "gpt"
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
    wf.compute_token_lineage_key = "agent:a1"
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
        assert "release_compute_token_lineage_activity" in activity_names
        fetch_call = next(c for c in fake.activity_calls if c[0] == "fetch_compute_token_activity")
        assert fetch_call[1][-1] == "gpt"
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


async def test_workflow_on_tokens_successful_rotation_rereads_lineage_lease():
    """An in-call rotation reports only the lease identity; the workflow re-reads the lease."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    wf.user_id = "user-1"
    wf.compute_token_provider = "claude"
    wf.claude_max_token = "old-token"
    wf.claude_max_token_source = "pool"
    wf.claude_max_token_pool_id = "pool-old"
    wf.claude_max_token_fetched_at = datetime(2025, 1, 1, tzinfo=timezone.utc)
    wf.compute_token_lineage_key = "agent:a1"
    wf.input_cents_per_1k = 0.0
    wf.output_cents_per_1k = 0.0
    fake = _FakeWorkflowModule()
    fake.activity_returns["fetch_compute_token_activity"] = {
        "type": "gpt",
        "accessToken": "fresh-gpt-token",
        "accountId": "acct-fresh",
        "source": "pool",
        "poolTokenId": "pool-gpt-fresh",
        "lineageKey": "agent:a1",
    }
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
                "source": "pool",
                "poolTokenId": "pool-gpt-fresh",
                "lineageKey": "agent:a1",
            },
        )
        assert wf.compute_token_provider == "gpt"
        assert wf.gpt_code_token == "fresh-gpt-token"
        assert wf.gpt_code_account_id == "acct-fresh"
        assert wf.gpt_code_token_source == "pool"
        assert wf.gpt_code_token_pool_id == "pool-gpt-fresh"
        fetches = [c for c in fake.activity_calls if c[0] == "fetch_compute_token_activity"]
        assert len(fetches) == 1
        assert fetches[0][1][1] == "agent:a1"
        assert fetches[0][1][5] == "gpt"
        activity_names = [c[0] for c in fake.activity_calls]
        assert "release_compute_token_lineage_activity" not in activity_names
        assert "mark_compute_token_rate_limited_activity" not in activity_names
    finally:
        _restore_workflow(original)


async def test_workflow_on_tokens_unchanged_lease_identity_schedules_no_activity():
    """Calls without an in-call rotation must not add any compute-token activity."""
    wf = _bare_workflow_instance()
    wf.agent_id = "a1"
    wf.user_id = "user-1"
    wf.compute_token_provider = "claude"
    wf.claude_max_token = "cached-token"
    wf.claude_max_token_source = "pool"
    wf.claude_max_token_pool_id = "pool-1"
    wf.compute_token_lineage_key = "agent:a1"
    wf.input_cents_per_1k = 0.0
    wf.output_cents_per_1k = 0.0
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._on_tokens(
            tokens_in_delta=5,
            tokens_out_delta=2,
            actual_model="claude-opus-4-8-claude",
            call_site="test",
            compute_token_used={"type": "claude", "source": "pool", "poolTokenId": "pool-1", "lineageKey": "agent:a1"},
        )
        # A late result from a call issued with an older workflow token
        # (no in-call rotation) must not refetch or clear the cache either.
        await wf._on_tokens(
            tokens_in_delta=5,
            tokens_out_delta=2,
            actual_model="claude-opus-4-8-claude",
            call_site="test",
            compute_token_used={"type": "claude", "source": "pool", "poolTokenId": "pool-0", "lineageKey": "agent:a1"},
        )
        assert wf.claude_max_token == "cached-token"
        assert [c[0] for c in fake.activity_calls if "compute_token" in c[0]] == []
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
    wf.compute_token_lineage_key = "agent:a1"
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
        assert "release_compute_token_lineage_activity" in activity_names
        fetch_call = next(c for c in fake.activity_calls if c[0] == "fetch_compute_token_activity")
        assert fetch_call[1][-1] == "claude"
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


async def test_workflow_query_parent_state_throttles_repeat_queries():
    """Children must not query the parent on every loop tick under fan-out."""
    from datetime import timedelta

    from workflows.agent_workflow import _PARENT_STATE_QUERY_MIN_INTERVAL, _QUERY_PARENT_STATE_TIMEOUT

    wf = _bare_workflow_instance()
    wf.parent_workflow_id = "parent-wf"
    fake = _FakeWorkflowModule()
    fake.activity_returns["query_parent_state_activity"] = {"is_paused": False, "is_cost_limit_reached": False}
    original = _patch_workflow(fake)
    try:
        first = await wf._query_parent_state()
        second = await wf._query_parent_state()
        assert first == {"is_paused": False, "is_cost_limit_reached": False}
        assert second == first
        assert [c[0] for c in fake.activity_calls] == ["query_parent_state_activity"]
        fake.now_value = fake.now_value + _PARENT_STATE_QUERY_MIN_INTERVAL
        third = await wf._query_parent_state()
        assert third == first
        assert [c[0] for c in fake.activity_calls] == [
            "query_parent_state_activity",
            "query_parent_state_activity",
        ]
        assert _QUERY_PARENT_STATE_TIMEOUT >= timedelta(seconds=60)
    finally:
        _restore_workflow(original)


async def test_workflow_query_parent_state_skips_throttle_when_paused_by_parent():
    wf = _bare_workflow_instance()
    wf.parent_workflow_id = "parent-wf"
    wf._paused_by_parent = True
    fake = _FakeWorkflowModule()
    fake.activity_returns["query_parent_state_activity"] = {"is_paused": True, "is_cost_limit_reached": False}
    original = _patch_workflow(fake)
    try:
        await wf._query_parent_state()
        await wf._query_parent_state()
        assert [c[0] for c in fake.activity_calls] == [
            "query_parent_state_activity",
            "query_parent_state_activity",
        ]
    finally:
        _restore_workflow(original)


async def test_workflow_fast_mode_post_message_does_not_block_loop():
    """Demo Fast Mode replay must not await each post_message activity."""
    from utils.oai_demo import OAI_DEMO_CHILD_GOAL_PREFIX

    wf = _bare_workflow_instance()
    wf.agent_id = "fm-child"
    wf.goal = f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky — Huberman"
    wf.fast_mode_cache_enabled = True
    fake = _FakeWorkflowModule()
    blocker = asyncio.Event()
    fake.activity_blockers["post_agent_message"] = blocker
    original = _patch_workflow(fake)
    try:
        await wf._post_message("one", "ASSISTANT", {})
        await wf._post_message("two", "TOOL", {"toolCallId": "tc-1"})
        assert wf.message_count == 2
        await asyncio.sleep(0)
        posts = [c for c in fake.activity_calls if c[0] == "post_agent_message"]
        assert len(posts) == 2, posts
        assert not blocker.is_set()
        blocker.set()
        await wf._flush_pending_messages()
        assert wf._pending_message_handles == []
    finally:
        _restore_workflow(original)


async def test_workflow_post_message_throttles_tree_updates():
    """Per-message tree broadcasts under 50-way demo fan-out must coalesce."""
    from datetime import timedelta

    from utils.oai_demo import OAI_DEMO_CHILD_GOAL_PREFIX
    from workflows.agent_workflow import _TREE_STATE_EMIT_MIN_INTERVAL

    wf = _bare_workflow_instance()
    wf.agent_id = "child-1"
    wf.bus_id = "bus-1"
    wf.parent_agent_id = "root-1"
    wf.goal = f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky — Huberman"
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._post_message("first", "ASSISTANT", {"toolCallId": "tc-1"})
        await wf._post_message("second", "TOOL", {"toolCallId": "tc-1"})
        tree_calls = [c for c in fake.activity_calls if c[0] == "update_agent_tree_state"]
        assert len(tree_calls) == 1
        fake.now_value = fake.now_value + _TREE_STATE_EMIT_MIN_INTERVAL
        await wf._post_message("third", "ASSISTANT", {})
        tree_calls = [c for c in fake.activity_calls if c[0] == "update_agent_tree_state"]
        assert len(tree_calls) == 2
        await wf._update_tree_state(status="COMPLETED")
        tree_calls = [c for c in fake.activity_calls if c[0] == "update_agent_tree_state"]
        assert len(tree_calls) == 3
        assert _TREE_STATE_EMIT_MIN_INTERVAL == timedelta(seconds=3)
    finally:
        _restore_workflow(original)


async def test_workflow_post_message_does_not_throttle_tree_outside_demo():
    """Live Fast Mode trees must keep per-message tree broadcasts."""
    wf = _bare_workflow_instance()
    wf.agent_id = "child-1"
    wf.bus_id = "bus-1"
    wf.parent_agent_id = "root-1"
    wf.goal = "Order a Vanilla Bean Shakerato from Blue Bottle"
    fake = _FakeWorkflowModule()
    original = _patch_workflow(fake)
    try:
        await wf._post_message("first", "ASSISTANT", {"toolCallId": "tc-1"})
        await wf._post_message("second", "TOOL", {"toolCallId": "tc-1"})
        tree_calls = [c for c in fake.activity_calls if c[0] == "update_agent_tree_state"]
        assert len(tree_calls) == 2
    finally:
        _restore_workflow(original)


async def run_all_tests():
    print("workflow blackbox tests:")
    r = BlackboxResult()
    r.record("final_presentation_contract", test_final_presentation_contract)
    r.record("workflow_final_presentation_resume", test_workflow_final_presentation_resume)
    await r.record_async("workflow_final_value_presentation", test_workflow_final_value_presentation)
    r.record("browser_execution_restore_rejects_malformed_values", test_browser_execution_restore_rejects_malformed_values)
    await r.record_async("completion_caller_routes_late_revision_and_invalid_presentation", test_completion_caller_routes_late_revision_and_invalid_presentation)
    await r.record_async("completion_feedback_during_mark_finished_continues_current_requirement", test_completion_feedback_during_mark_finished_continues_current_requirement)
    await r.record_async("completion_routing_preserves_unrelated_failures", test_completion_routing_preserves_unrelated_failures)
    await r.record_async("budget_stop_is_not_user_pause_and_cascades_cause", test_budget_stop_is_not_user_pause_and_cascades_cause)
    await r.record_async("workflow_final_value_rejects_stale_or_invalid", test_workflow_final_value_rejects_stale_or_invalid)
    await r.record_async("workflow_final_value_late_feedback", test_workflow_final_value_late_feedback)
    await r.record_async("workflow_final_value_late_schema_matrix", test_workflow_final_value_late_schema_matrix)
    await r.record_async("workflow_final_value_loaded_schema", test_workflow_final_value_loaded_schema)
    await r.record_async("workflow_final_value_feedback_during_schema_load", test_workflow_final_value_feedback_during_schema_load)
    await r.record_async("workflow_final_verification_entry_revision_matrix", test_workflow_final_verification_entry_revision_matrix)



    await r.record_async("wf_generic_browser_budget_wrapup", test_workflow_generic_browser_result_gets_existing_budget_wrapup)
    await r.record_async("wf_background_browser_budget_notification", test_workflow_background_browser_budget_keeps_native_notification_and_result)
    await r.record_async("browser_usage_child_cost_interleaving", test_workflow_browser_usage_arms_before_child_cost_interleaving)
    await r.record_async("browser_pricing_preserves_intervening_cost_stop", test_workflow_browser_pricing_cannot_reopen_an_intervening_cost_stop)
    await r.record_async("inflight_refusal_preserves_unadmitted_browser_wrapup", test_workflow_inflight_refusal_preserves_unadmitted_browser_wrapup)
    await r.record_async("browser_pricing_preserves_intervening_credit_pause", test_workflow_browser_pricing_preserves_intervening_credit_pause)
    await r.record_async("browser_pricing_preserves_pause_after_credit_refresh", test_workflow_browser_pricing_preserves_credit_pause_after_refresh)
    await r.record_async("browser_wrapup_restore_preserves_cached_credit_pause", test_workflow_browser_wrapup_restore_preserves_cached_credit_pause)
    await r.record_async("armed_wrapup_keeps_refreshed_credit_pause_through_continuation", test_workflow_armed_browser_wrapup_keeps_refreshed_credit_pause_across_continuation)
    await r.record_async("browser_wrapup_restore_requires_unpaused_provenance", test_workflow_browser_wrapup_restore_requires_unpaused_continuation_provenance)
    await r.record_async("wf_unverified_browser_budget_stop", test_workflow_unverified_browser_and_other_usage_do_not_get_wrapup)
    await r.record_async("wf_browser_budget_wrapup_pause_controls", test_workflow_browser_budget_wrapup_stops_after_one_turn_and_keeps_pauses)
    await r.record_async("wf_browser_budget_wrapup_work_and_restore", test_workflow_browser_wrapup_cannot_start_productive_work_or_renew_after_restore)
    await r.record_async("wf_retained_output_dispatch", test_workflow_retained_output_dispatch_and_error_pairing)

    await r.record_async(
        "blackbox_result_empty_exception_diagnostics", test_blackbox_result_preserves_empty_exceptions_and_tracebacks
    )

    r.record("wf_policy_import_avoids_provider_clients", test_workflow_policy_import_does_not_rebuild_provider_clients)
    r.record("wf_helper_exports_reuse_host_activities", test_workflow_helper_exports_reuse_host_activity_definitions)
    r.record(
        "wf_action_model_cache_preserves_registry", test_workflow_action_model_cache_preserves_registry_and_validation
    )
    r.record("wf_logging_keeps_worker_configuration", test_workflow_sandbox_keeps_worker_logging_configuration)

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
    r.record("wf_restore_deploy_state", test_workflow_restore_deployment_state_preserves_all_durable_counters)
    r.record("wf_restore_deploy_pause", test_workflow_restore_deployment_state_preserves_pause_modes)
    r.record("wf_restore_deploy_version", test_workflow_restore_deployment_state_rejects_unknown_contract)
    r.record(
        "wf_restore_candidate_validation",
        test_workflow_restore_candidate_validation_stops_before_llm,
    )
    r.record(
        "wf_continuation_state_round_trip",
        test_workflow_continuation_state_round_trips_complete_runtime,
    )
    r.record("pending_tool_records_budget", test_pending_tool_records_copy_args_and_respect_the_handoff_budget)
    r.record("wf_parks_only_live_run_agent_calls", test_workflow_parks_only_live_run_agent_tool_calls_within_budget)
    r.record(
        "wf_continuation_carries_parked_tools",
        test_workflow_continuation_carries_parked_tools_and_drops_malformed_records,
    )
    r.record(
        "wf_continuation_backfills_legacy_spawn_task_name",
        test_workflow_continuation_backfills_task_name_for_legacy_parked_spawns,
    )
    r.record(
        "wf_restart_safe_child_counts",
        test_restart_safe_child_tool_counts_survive_memory_loss_without_duplication,
    )
    r.record("wf_pending_children_empty", test_workflow_get_pending_child_workflow_ids_empty)
    r.record("wf_pending_children_populated", test_workflow_get_pending_child_workflow_ids_populated)
    r.record("wf_children_tokens_empty", test_workflow_get_children_tokens_empty)
    r.record("wf_children_tokens_sums", test_workflow_get_children_tokens_sums_correctly)
    await r.record_async("wf_resume_rearms_future_wait", test_workflow_resume_rearms_interrupted_future_wait)
    await r.record_async("wf_resume_rearms_elapsed_wait", test_workflow_resume_rearms_elapsed_wait)
    await r.record_async("wf_resume_noop_no_wait", test_workflow_resume_noop_without_pending_wait)
    r.record("wf_get_status_query", test_workflow_get_status_query)
    r.record("wf_is_paused_default", test_workflow_is_paused_query_default_false)
    r.record("wf_is_paused_true", test_workflow_is_paused_query_true)
    r.record("wf_cost_limit_reached_default", test_workflow_is_cost_limit_reached_query_default)
    r.record("wf_parent_state_query", test_workflow_parent_state_query)
    r.record("wf_parent_state_all_false", test_workflow_parent_state_query_all_false)
    r.record("wf_format_outputs_no_schema", test_workflow_format_outputs_no_schema_emits_response_keys)
    r.record("wf_format_outputs_no_response", test_workflow_format_outputs_no_response_returns_empty)
    r.record("wf_format_outputs_maps_fields", test_workflow_format_outputs_maps_fields)
    r.record("wf_format_outputs_skips_missing", test_workflow_format_outputs_skips_missing_fields)
    r.record("wf_format_outputs_field_no_name", test_workflow_format_outputs_field_without_name_falls_back_to_keys)
    r.record(
        "wf_schema_headings_parse_assemble_final",
        test_structured_response_from_schema_headings_parses_assemble_final,
    )
    r.record(
        "wf_schema_headings_without_schema",
        test_structured_response_from_schema_headings_without_schema,
    )
    r.record(
        "wf_coalesce_structured_response_from_headings",
        test_workflow_coalesce_structured_response_fills_outputs_from_headings,
    )
    r.record(
        "wf_coalesce_fills_only_values_of_the_schema_field_type",
        test_workflow_coalesce_fills_only_values_of_the_schema_field_type,
    )
    await r.record_async(
        "wf_verifier_schema_survives_a_failed_startup_config_fetch",
        test_workflow_verifier_schema_survives_a_failed_startup_config_fetch,
    )
    await r.record_async(
        "wf_schema_reload_is_one_attempt_per_turn_with_backoff",
        test_workflow_schema_reload_is_one_attempt_per_turn_with_backoff,
    )
    r.record(
        "wf_coalesce_for_each_items_fills_top_creators_analysis",
        test_workflow_coalesce_for_each_items_fills_top_creators_analysis,
    )
    r.record(
        "wf_coalesce_structured_response_from_metadata_payload",
        test_workflow_coalesce_structured_response_from_metadata_payload,
    )
    r.record(
        "wf_coalesce_structured_response_without_schema",
        test_workflow_coalesce_structured_response_without_schema_uses_headings,
    )
    r.record(
        "wf_coalesce_gp_outputs_from_explore_evidence",
        test_workflow_coalesce_fills_gp_outputs_from_row_item_and_explore,
    )
    r.record(
        "wf_card_summary_uses_long_web_fetch_not_creator_name",
        test_card_summary_from_evidence_uses_long_web_fetch_not_creator_name,
    )
    r.record(
        "wf_card_summary_rejects_cached_search_envelope",
        test_card_summary_from_evidence_rejects_long_cached_search_envelope,
    )
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
    await r.record_async("user_pause_refresh", test_user_pause_refresh_keeps_original_result_order_and_error)
    await r.record_async(
        "poll_and_update_context_filters_subagent_work",
        test_poll_and_update_context_filters_subagent_work_and_advances_cursor,
    )

    # Signal-handler + cost-tracking tests (fake workflow module)
    await r.record_async("wf_signal_pause", test_workflow_signal_pause_sets_paused_flag)
    await r.record_async("pause_intent_ends_with_recovered_episode", test_pause_intent_ends_with_recovered_episode)
    await r.record_async("pause_episode_ordering", test_pause_episode_preserves_user_intent_across_automatic_signals)
    await r.record_async("wf_signal_pause_cascade", test_workflow_signal_pause_cascades_to_children)
    await r.record_async("wf_signal_resume", test_workflow_signal_resume_clears_paused_flag)
    await r.record_async(
        "wf_out_of_credits_resume_requires_fresh_credits",
        test_workflow_out_of_credits_resume_requires_fresh_credits,
    )
    await r.record_async("wf_signal_recv_user_plain", test_workflow_signal_receive_user_response_plain_string)
    await r.record_async(
        "wf_user_message_alone_never_lifts_pause",
        test_workflow_user_message_alone_never_lifts_a_pause,
    )
    await r.record_async("wf_signal_recv_user_req_id", test_workflow_signal_receive_user_response_with_request_id)
    await r.record_async(
        "wf_signal_recv_user_json_no_req", test_workflow_signal_receive_user_response_json_without_request_id
    )
    await r.record_async(
        "wf_signal_control_reply_no_schema",
        test_workflow_signal_control_reply_does_not_refresh_schema,
    )
    await r.record_async(
        "wf_signal_normalized_controls_no_schema",
        test_workflow_signal_normalized_controls_do_not_refresh_schema,
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
        "wf_keyed_rejection_already_polled_feedback",
        test_workflow_keyed_rejection_admits_already_polled_durable_feedback,
    )
    await r.record_async(
        "wf_keyed_rejection_durable_feedback",
        test_workflow_keyed_rejection_polls_durable_user_feedback_without_schema_narration,
    )
    await r.record_async(
        "wf_keyed_rejection_waiter_after_feedback",
        test_workflow_keyed_rejection_waiter_releases_after_feedback_admission,
    )
    await r.record_async(
        "wf_failed_rejection_intake_keeps_waiter", test_workflow_failed_rejection_intake_does_not_release_waiter
    )
    await r.record_async(
        "wf_rejection_activity_failure_known_feedback",
        test_workflow_rejection_activity_read_failure_preserves_known_feedback_and_response,
    )
    await r.record_async(
        "wf_rejection_activity_failure_deferred_feedback",
        test_workflow_rejection_activity_read_failure_defers_unknown_feedback_once,
    )
    await r.record_async(
        "wf_rejection_read_lifecycle_fences",
        test_workflow_rejection_read_does_not_swallow_cancellation_or_generation_fence,
    )
    await r.record_async(
        "wf_schema_durable_reversions", test_workflow_schema_requirements_preserve_distinct_durable_reversions
    )
    await r.record_async(
        "wf_attention_row_before_signal_event_identity",
        test_workflow_attention_row_before_signal_is_one_requirement_event,
    )
    await r.record_async(
        "wf_attention_signal_distinct_identical_row",
        test_workflow_attention_signal_does_not_consume_another_identical_event_row,
    )
    await r.record_async(
        "wf_attention_a_b_a_event_chronology", test_workflow_attention_distinct_a_b_a_events_preserve_chronology_once
    )
    await r.record_async(
        "wf_attention_event_ledger_continue_as_new", test_workflow_attention_event_ledger_survives_continue_as_new
    )
    await r.record_async(
        "workflow_browser_targeted_row_not_owner_schema_feedback",
        test_workflow_browser_targeted_row_is_not_owner_schema_feedback,
    )
    await r.record_async(
        "wf_attention_duplicate_batch_physical_rows",
        test_workflow_attention_duplicate_physical_rows_in_one_batch_are_one_event,
    )
    await r.record_async(
        "wf_attention_authored_control_word_verbatim",
        test_workflow_attention_authored_control_word_is_real_feedback_verbatim,
    )
    await r.record_async(
        "wf_keyed_user_native_schema",
        test_workflow_keyed_user_message_updates_native_schema_without_injection,
    )
    await r.record_async(
        "wf_keyed_authored_message_separate_from_control",
        test_workflow_keyed_authored_message_refreshes_schema_separately_from_control,
    )
    await r.record_async(
        "wf_explicit_protocol_only_reply_no_schema",
        test_workflow_explicit_protocol_only_reply_does_not_refresh_schema,
    )
    await r.record_async(
        "wf_schema_change_native_contract",
        test_workflow_schema_change_updates_native_contract_without_user_row,
    )
    await r.record_async(
        "wf_new_instruction_native_schema",
        test_workflow_new_instruction_schema_uses_native_state_without_user_row,
    )
    await r.record_async(
        "wf_fresh_task_poll_reload_excludes_prior_requirements",
        test_workflow_fresh_task_poll_and_reload_exclude_prior_requirements,
    )
    await r.record_async(
        "wf_fresh_task_source_boundary_survives_continuation",
        test_workflow_fresh_task_boundary_preserves_source_identity_and_continuation,
    )
    await r.record_async(
        "wf_fresh_boundary_proven_queued_feedback_sources",
        test_workflow_fresh_boundary_filters_only_proven_queued_feedback_sources,
    )
    await r.record_async(
        "wf_fresh_start_failed_generation_no_stale_schema",
        test_workflow_fresh_start_generation_failure_cannot_restore_completed_task_schema,
    )
    await r.record_async(
        "wf_fresh_start_empty_generation_no_stale_schema",
        test_workflow_fresh_start_empty_schema_cannot_restore_completed_task_schema,
    )
    await r.record_async(
        "wf_fresh_start_native_acceptance_lost_db_ack",
        test_workflow_fresh_start_accepted_schema_survives_lost_persistence_ack,
    )
    await r.record_async(
        "wf_fresh_start_unchanged_native_acceptance",
        test_workflow_fresh_start_unchanged_schema_is_accepted_before_persistence,
    )
    await r.record_async(
        "wf_mark_complete_rejects_failed_fresh_contract",
        test_workflow_mark_complete_refuses_failed_fresh_start_before_terminal_effects,
    )
    await r.record_async(
        "wf_fresh_start_superseded_generation_not_persisted",
        test_workflow_fresh_start_discards_schema_superseded_during_generation,
    )
    await r.record_async(
        "wf_fresh_start_preexisting_feedback_not_consumed",
        test_workflow_fresh_start_keeps_feedback_received_before_generation_pending,
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
        "wf_schema_refresh_failure_native_retry",
        test_workflow_schema_refresh_failure_remains_pending_for_native_retry,
    )
    await r.record_async(
        "wf_schema_failure_continuation_native_retry",
        test_workflow_failed_schema_continuation_retries_original_input_without_new_feedback,
    )
    await r.record_async(
        "wf_schema_refresh_lifecycle_no_respawn", test_workflow_schema_refresh_lifecycle_stop_propagates_without_respawn
    )
    await r.record_async(
        "wf_legacy_approval_protocol_no_schema_feedback",
        test_workflow_legacy_approval_protocol_does_not_change_requirements,
    )
    await r.record_async(
        "wf_authored_approval_words_preserved", test_workflow_authored_approval_words_remain_actual_requirements
    )
    await r.record_async(
        "wf_schema_getter_refuses_failed_generation",
        test_workflow_schema_getter_refuses_old_contract_after_generation_failure,
    )
    await r.record_async(
        "wf_generation_failure_blocks_verifier_provider",
        test_workflow_generation_failure_blocks_actual_verifier_provider_call,
    )
    await r.record_async(
        "wf_unchanged_contract_accepted_before_db_ack",
        test_workflow_valid_unchanged_schema_is_accepted_before_persistence_ack,
    )
    await r.record_async(
        "wf_native_acceptance_survives_lost_db_ack", test_workflow_accepted_native_schema_survives_lost_persistence_ack
    )
    await r.record_async(
        "wf_direct_completion_requires_native_acceptance",
        test_workflow_direct_completion_bypass_refuses_unaccepted_latest_contract,
    )
    await r.record_async(
        "wf_unaccepted_schema_no_invented_terminal_failure",
        test_workflow_unaccepted_schema_does_not_invent_terminal_failure,
    )
    await r.record_async(
        "wf_healthy_native_sms_changed_schema",
        test_workflow_healthy_feedback_during_native_sms_wait_continues_with_changed_schema,
    )
    await r.record_async(
        "wf_healthy_native_sms_unchanged_schema",
        test_workflow_healthy_feedback_during_native_sms_wait_continues_with_unchanged_schema,
    )
    await r.record_async(
        "wf_healthy_native_explore_drain",
        test_workflow_healthy_feedback_during_native_explore_drain_discards_old_completion,
    )
    await r.record_async(
        "wf_healthy_sms_post_dag_recovery", test_workflow_healthy_sms_feedback_post_dag_recovers_current_contract
    )
    await r.record_async(
        "wf_healthy_sms_fast_mode_budget", test_workflow_healthy_sms_feedback_keeps_fast_mode_step_budget
    )
    await r.record_async(
        "wf_native_sms_no_new_feedback", test_workflow_native_sms_completion_without_new_feedback_still_completes
    )
    await r.record_async(
        "wf_schema_failure_preserves_unrelated_error",
        test_workflow_schema_failure_handler_does_not_swallow_unrelated_errors,
    )
    await r.record_async(
        "wf_fast_mode_completion_requires_native_acceptance",
        test_workflow_fast_mode_completion_refuses_unaccepted_latest_contract,
    )
    await r.record_async(
        "wf_schema_refresh_no_message_dependency",
        test_workflow_schema_refresh_does_not_depend_on_message_write,
    )
    await r.record_async(
        "wf_schema_refresh_reloads_feedback",
        test_workflow_schema_refresh_reloads_prior_feedback_after_continuation,
    )
    await r.record_async(
        "wf_schema_refresh_coalesces_feedback",
        test_workflow_schema_refresh_coalesces_rapid_feedback,
    )
    await r.record_async(
        "wf_superseded_schema_never_persists_on_latest_failure",
        test_workflow_superseded_schema_never_persists_when_latest_generation_fails,
    )
    await r.record_async(
        "wf_only_accepted_schema_persists_and_resumes",
        test_workflow_only_accepted_latest_schema_persists_and_resumes,
    )
    await r.record_async(
        "wf_feedback_during_schema_persistence_keeps_accepted_contract",
        test_workflow_feedback_during_schema_persistence_keeps_accepted_contract,
    )
    await r.record_async(
        "wf_schema_commit_lost_ack_keeps_accepted_contract",
        test_workflow_schema_commit_with_lost_acknowledgement_keeps_accepted_contract,
    )
    await r.record_async(
        "wf_restored_accepted_schema_wins_stale_config",
        test_workflow_restored_accepted_schema_wins_over_stale_database_config,
    )
    await r.record_async("wf_signal_signup", test_workflow_signal_signup_completed_and_dismissed)
    await r.record_async("wf_signal_child_cost_update", test_workflow_signal_child_cost_update_aggregates)
    await r.record_async(
        "wf_signal_child_progress",
        test_workflow_signal_child_progress_keeps_parent_usage_own_only,
    )
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
        "wf_track_llm_cost_foundry_zero_user_cost",
        test_workflow_track_llm_cost_foundry_is_zero_user_cost,
    )
    await r.record_async(
        "wf_track_llm_cost_demo_cache_replay",
        test_workflow_track_llm_cost_demo_cache_replay_is_zero_cost,
    )
    await r.record_async("wf_track_usage_empty", test_workflow_track_usage_empty_is_no_op)
    await r.record_async("wf_track_usage_service", test_workflow_track_usage_service_cost)
    await r.record_async(
        "wf_track_usage_direct_compute_token",
        test_workflow_track_usage_direct_compute_token_is_zero_cost,
    )
    await r.record_async(
        "wf_track_usage_foundry",
        test_workflow_track_usage_foundry_is_zero_user_cost,
    )
    await r.record_async(
        "wf_track_usage_demo_cache_replay",
        test_workflow_track_usage_demo_cache_replay_is_zero_cost,
    )
    await r.record_async(
        "wf_track_usage_browser_pool_pricing",
        test_workflow_track_usage_browser_items_price_at_browser_pool,
    )
    await r.record_async(
        "wf_track_usage_browser_real_inference_model",
        test_workflow_track_usage_browser_rows_carry_real_inference_model,
    )
    await r.record_async("wf_update_cost_root_limit", test_workflow_update_cost_and_signal_parent_root_checks_limit)
    await r.record_async("wf_update_cost_non_root_signal", test_workflow_update_cost_and_signal_parent_non_root_signals)
    await r.record_async(
        "wf_update_cost_after_finished_no_active",
        test_workflow_update_cost_after_finished_skips_active_broadcast,
    )
    await r.record_async("wf_check_cost_limit_below", test_workflow_check_cost_limit_no_op_when_below)
    await r.record_async("wf_check_cost_limit_non_root", test_workflow_check_cost_limit_skips_non_root)
    await r.record_async(
        "wf_check_cost_limit_after_finished",
        test_workflow_check_cost_limit_skipped_after_finished,
    )
    await r.record_async(
        "wf_cost_limit_flushes_tree_cost",
        test_workflow_cost_limit_flushes_tree_cost_before_pausing,
    )
    await r.record_async("wf_update_tree_state_no_bus", test_workflow_update_tree_state_skips_without_bus)
    await r.record_async(
        "wf_update_tree_state_no_bus_persists_status", test_workflow_update_tree_state_persists_status_without_bus
    )
    await r.record_async("wf_update_tree_state_with_bus", test_workflow_update_tree_state_with_bus_broadcasts)
    await r.record_async("wf_persist_tree_cost", test_workflow_persist_tree_cost_executes_activity)
    await r.record_async("wf_query_parent_state_empty", test_workflow_query_parent_state_returns_empty_without_parent)
    await r.record_async("wf_check_paused", test_workflow_check_paused_reflects_flag)
    await r.record_async("wf_refresh_claude_token_fresh", test_workflow_refresh_claude_token_still_fresh_returns_early)
    await r.record_async("wf_on_tokens_with_pricing", test_workflow_on_tokens_calculates_cost_with_pricing)
    await r.record_async("wf_on_tokens_no_pricing", test_workflow_on_tokens_no_pricing_still_logs)
    await r.record_async("wf_on_tokens_demo_cache_replay", test_workflow_on_tokens_demo_cache_replay_is_zero_cost)
    await r.record_async("wf_wait_for_messages_timeout", test_workflow_wait_for_messages_timeout_returns_false)
    await r.record_async("wf_get_model_pricing_primary", test_workflow_get_model_pricing_returns_primary_when_matches)
    await r.record_async("wf_get_model_pricing_cache", test_workflow_get_model_pricing_uses_cache)
    await r.record_async("wf_mark_failed_signals_parent", test_workflow_mark_failed_signals_parent_with_context)
    await r.record_async("wf_mark_failed_no_parent", test_workflow_mark_failed_no_parent_no_signal)
    await r.record_async(
        "wf_simulated_agent_finishes_on_world_clock_before_parent_signal",
        test_simulated_agent_finishes_on_the_world_clock_before_signalling_its_parent,
    )
    await r.record_async(
        "wf_paused_continuation_preserves_state",
        test_workflow_paused_continue_as_new_preserves_deployment_state,
    )
    await r.record_async(
        "wf_generation_handoff_continue_as_new",
        test_workflow_generation_handoff_continue_as_new_onto_live_queue,
    )
    await r.record_async(
        "wf_generation_handoff_plan_resumes_plan",
        test_workflow_generation_handoff_plan_phase_resumes_plan,
    )
    await r.record_async(
        "wf_paused_handoff_continue_as_new",
        test_workflow_paused_handoff_continue_as_new_onto_live_queue,
    )
    await r.record_async(
        "wf_wait_for_unpause_or_handoff",
        test_workflow_wait_for_unpause_or_handoff_returns_handoff_queue,
    )
    await r.record_async(
        "wf_generation_handoff_preserves_cost_limit",
        test_workflow_generation_handoff_preserves_cost_limit_state,
    )
    await r.record_async(
        "wf_context_overflow_continuation_preserves_state",
        test_workflow_context_overflow_uses_complete_continuation_contract,
    )
    await r.record_async(
        "wf_context_overflow_defers_while_background_task_runs",
        test_context_overflow_defers_continue_as_new_while_background_task_runs,
    )
    await r.record_async(
        "wf_context_overflow_history_limit_settles_background_task",
        test_context_overflow_at_history_limit_settles_background_task_then_continues,
    )
    await r.record_async(
        "wf_generation_handoff_settles_in_flight_background_task",
        test_generation_handoff_settles_in_flight_background_task_before_continue_as_new,
    )
    await r.record_async("wf_handle_incomplete_max_iterations", test_workflow_handle_incomplete_max_iterations)
    await r.record_async(
        "wf_handle_incomplete_max_iterations_fast_mode_completes",
        test_workflow_handle_incomplete_max_iterations_fast_mode_completes,
    )
    await r.record_async(
        "wf_handle_incomplete_max_iterations_fast_mode_fails_outside_demo",
        test_workflow_handle_incomplete_max_iterations_fast_mode_fails_outside_demo,
    )
    await r.record_async("wf_handle_incomplete_error", test_workflow_handle_incomplete_error)
    await r.record_async("wf_handle_incomplete_unknown", test_workflow_handle_incomplete_unknown_passthrough)
    await r.record_async("wf_check_credits_no_credits", test_workflow_check_credits_no_credits_pauses)
    await r.record_async(
        "wf_check_credits_free_credit_subscription_gate",
        test_workflow_check_credits_free_credits_exhausted_raises_subscription_gate,
    )
    await r.record_async(
        "wf_subscription_credit_recheck_preserves_concurrent_pause",
        test_subscription_credit_recheck_preserves_concurrent_pause,
    )
    await r.record_async(
        "wf_check_credits_free_credit_checkout_failure_pauses",
        test_workflow_check_credits_free_credit_checkout_failure_pauses,
    )
    await r.record_async(
        "wf_subscription_credit_recheck_preserves_concurrent_pause",
        test_subscription_credit_recheck_preserves_concurrent_pause,
    )
    await r.record_async("wf_check_credits_has_credits", test_workflow_check_credits_has_credits_no_pause)
    await r.record_async("wf_check_credits_exception", test_workflow_check_credits_on_exception_continues)
    await r.record_async("wf_post_message", test_workflow_post_message_executes_activity)
    await r.record_async("wf_post_message_failure", test_workflow_post_message_failure_logs_warning)
    await r.record_async("wf_advance_cloud_agent_tool", test_workflow_advances_pending_cloud_agent_tool)
    await r.record_async("wf_cloud_agent_lifecycle_start_phase", test_workflow_lifecycle_updates_preserve_start_phase)
    await r.record_async("wf_no_duplicate_cloud_agent_tool", test_workflow_does_not_advance_terminal_cloud_agent_tool)
    await r.record_async(
        "wf_synthesize_root_cloud_agent_lifecycle",
        test_workflow_synthesizes_root_cloud_agent_lifecycle_without_chip,
    )
    await r.record_async("wf_missing_cloud_agent_tool", test_workflow_caches_missing_cloud_agent_tool)
    await r.record_async("wf_run_startup_completion", test_workflow_run_covers_chat_agent_startup_and_completion)
    await r.record_async(
        "wf_run_deployment_resume",
        test_workflow_run_deployment_resume_skips_startup_replay_and_restores_iteration,
    )
    await r.record_async(
        "wf_run_skips_response_schema_for_subagent",
        test_workflow_run_skips_response_schema_generation_for_subagent,
    )
    await r.record_async(
        "wf_run_missing_parent_stops_before_agent_loop",
        test_workflow_run_missing_parent_stops_before_agent_loop,
    )
    await r.record_async(
        "wf_dag_failure_recovers_via_run_agent",
        test_workflow_dag_failure_recovers_via_run_agent,
    )
    await r.record_async(
        "workflow_dag_user_message_interrupt_reaches_run_agent",
        test_workflow_dag_user_message_interrupt_reaches_run_agent,
    )
    await r.record_async(
        "wf_execute_skips_stale_plan_after_completion_followup",
        test_workflow_execute_skips_stale_plan_after_completion_followup,
    )
    await r.record_async(
        "wf_execute_nulled_schema_does_not_regenerate_from_old_goal",
        test_workflow_execute_nulled_schema_does_not_regenerate_from_old_goal,
    )
    await r.record_async(
        "wf_plan_followup_does_not_regenerate_schema_from_old_goal",
        test_workflow_plan_followup_does_not_regenerate_schema_from_old_goal,
    )
    await r.record_async(
        "wf_execute_followup_reuses_last_context_compaction",
        test_workflow_execute_followup_reuses_last_context_compaction,
    )
    await r.record_async(
        "wf_execute_still_runs_live_plan_without_later_user",
        test_workflow_execute_still_runs_live_plan_without_later_user,
    )
    await r.record_async(
        "wf_execute_skips_plan_after_user_followup_without_summary",
        test_workflow_execute_skips_plan_after_user_followup_without_summary,
    )
    await r.record_async("wf_handle_tool_event_forwards", test_workflow_handle_tool_event_forwards_to_helper)
    await r.record_async(
        "wf_post_dag_completion_attempt_tool",
        test_workflow_post_dag_completion_dispatches_attempt_completion_tool,
    )
    await r.record_async(
        "wf_post_dag_keyed_revision_race", test_workflow_post_dag_verdict_detects_keyed_feedback_without_user_row
    )
    await r.record_async(
        "wf_loop_live_requirement_revision", test_workflow_all_loop_phases_forward_live_requirement_revision
    )
    await r.record_async(
        "wf_execute_verdict_schema_wait_race", test_workflow_execute_completion_rechecks_verdict_after_schema_wait
    )
    await r.record_async(
        "wf_post_dag_verdict_schema_wait_race", test_workflow_post_dag_completion_rechecks_verdict_after_schema_wait
    )
    await r.record_async(
        "wf_fast_mode_verdict_schema_wait_race", test_workflow_fast_mode_completion_rechecks_verdict_after_schema_wait
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
        "wf_check_parent_missing_orphans_manual",
        test_workflow_check_parent_state_parent_missing_orphans_manual_pause,
    )
    await r.record_async(
        "wf_check_parent_missing_orphans_active",
        test_workflow_check_parent_state_parent_missing_orphans_active_child,
    )
    await r.record_async(
        "wf_orphan_never_signals_dead_parent",
        test_workflow_orphan_failure_never_signals_dead_parent,
    )
    await r.record_async(
        "wf_check_parent_transient_backstop", test_workflow_check_parent_state_transient_failure_backstop_orphans
    )
    await r.record_async("wf_mark_complete_happy", test_workflow_mark_complete_happy_path)
    await r.record_async(
        "wf_mark_complete_does_not_forward_full_context",
        test_workflow_mark_complete_does_not_forward_full_context,
    )
    await r.record_async(
        "wf_mark_complete_materializes_oai_demo_report_files",
        test_workflow_mark_complete_materializes_oai_demo_root_report_files,
    )
    await r.record_async(
        "wf_mark_complete_skips_report_files_for_oai_demo_child",
        test_workflow_mark_complete_skips_report_files_for_oai_demo_child,
    )
    await r.record_async("wf_mark_complete_no_parent", test_workflow_mark_complete_no_parent_no_signal)
    await r.record_async(
        "wf_mark_complete_survives_summary_failure",
        test_workflow_mark_complete_survives_summary_generation_failure,
    )
    r.record(
        "wf_strip_fast_mode_card_narration_keeps_extracted_output",
        test_strip_fast_mode_card_narration_keeps_extracted_output,
    )
    await r.record_async(
        "wf_mark_complete_replaces_fast_mode_ablation",
        test_workflow_mark_complete_replaces_fast_mode_ablation_with_real_summary,
    )
    await r.record_async(
        "wf_mark_complete_strips_fast_mode_prefix_from_long_extracted_output",
        test_workflow_mark_complete_strips_fast_mode_prefix_from_long_extracted_output,
    )
    await r.record_async(
        "wf_mark_complete_rejects_raw_tool_envelope_globally",
        test_workflow_mark_complete_never_persists_raw_tool_envelope_for_any_task,
    )
    await r.record_async(
        "wf_mark_complete_recovers_explore_web_fetch_on_unfiltered_poll",
        test_workflow_mark_complete_recovers_explore_web_fetch_on_unfiltered_poll,
    )
    await r.record_async(
        "wf_mark_complete_polls_assemble_for_schema_outputs",
        test_workflow_mark_complete_polls_assemble_for_schema_outputs,
    )
    await r.record_async(
        "wf_mark_complete_summary_cost_no_cost_limit",
        test_workflow_mark_complete_summary_cost_does_not_cost_limit_root,
    )
    await r.record_async(
        "wf_mark_complete_persists_summary_cost",
        test_workflow_mark_complete_persists_summary_cost,
    )
    await r.record_async(
        "wf_mark_complete_degraded_summary_keeps_notification",
        test_workflow_mark_complete_degraded_summary_keeps_notification,
    )
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
        "wf_execute_tool_handoff_includes_task_queue",
        test_workflow_execute_tool_handoff_includes_task_queue,
    )
    await r.record_async(
        "wf_execute_tool_web_fetch_fast_mode_kwargs",
        test_workflow_execute_tool_web_fetch_preserves_fast_mode_kwargs,
    )
    await r.record_async(
        "wf_attempt_completion_drains_fast_mode_explores",
        test_workflow_attempt_completion_drains_fast_mode_explores,
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
        "wf_rotate_compute_token_releases_lineage",
        test_workflow_rotate_compute_token_releases_lineage_and_refetches,
    )
    await r.record_async(
        "wf_on_tokens_transient_keeps_claude", test_workflow_on_tokens_transient_error_keeps_claude_token
    )
    await r.record_async(
        "wf_on_tokens_successful_claude_rotation",
        test_workflow_on_tokens_successful_rotation_rereads_lineage_lease,
    )
    await r.record_async(
        "wf_on_tokens_unchanged_lease_no_activity",
        test_workflow_on_tokens_unchanged_lease_identity_schedules_no_activity,
    )
    await r.record_async("wf_on_tokens_rotates_gpt", test_workflow_on_tokens_rotates_gpt_token_on_auth_error)
    await r.record_async("wf_on_tokens_transient_keeps_gpt", test_workflow_on_tokens_transient_error_keeps_gpt_token)
    await r.record_async("wf_check_parent_state_no_parent", test_workflow_check_parent_state_no_parent_returns_early)
    await r.record_async("wf_query_parent_state_exception", test_workflow_query_parent_state_exception_returns_empty)
    await r.record_async("wf_query_parent_state_throttles", test_workflow_query_parent_state_throttles_repeat_queries)
    await r.record_async(
        "wf_query_parent_state_skips_throttle_when_paused",
        test_workflow_query_parent_state_skips_throttle_when_paused_by_parent,
    )
    await r.record_async("wf_post_message_throttles_tree", test_workflow_post_message_throttles_tree_updates)
    await r.record_async(
        "wf_post_message_no_throttle_outside_demo",
        test_workflow_post_message_does_not_throttle_tree_outside_demo,
    )
    await r.record_async(
        "wf_fast_mode_post_message_nonblocking",
        test_workflow_fast_mode_post_message_does_not_block_loop,
    )

    r.record(
        "wf_sandbox_import_avoids_activity_initialization",
        test_workflow_sandbox_import_does_not_initialize_activity_package,
    )

    # Temporal workflow tests (all run inside one shared environment)
    wf_results = await _run_all_workflow_tests()
    wf_results += await _run_parked_tool_cutover_tests()
    for test_name, err in wf_results:
        r.record_result(test_name, err)

    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    result = asyncio.run(run_all_tests())
    raise SystemExit(0 if result else 1)
