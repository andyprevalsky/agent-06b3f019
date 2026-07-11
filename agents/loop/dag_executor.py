"""
DAG Executor - Rigid execution of plans from set_plan.

Executes the task DAG with maximum parallelism:
- Tasks fire immediately when their dependencies complete
- Uses asyncio.wait(FIRST_COMPLETED) for efficient scheduling
- On error, breaks out to allow LLM recovery via run_agent

USAGE:
- Called from agent_workflow.py at EXECUTE phase start if a plan exists
- On success: returns completed status
- On failure: error already in context, returns needs_llm for recovery
"""

import asyncio
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Awaitable, Callable, Dict, List, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.reasoning.config import MAX_CONTEXT_MESSAGES as REASONING_MAX_CONTEXT_MESSAGES
from helpers.llm import _pending_llm_context, call_llm_activity
from loop.context_utils import poll_and_update_context
from loop.payload_guard import check_activity_payload
from tools.base import EventType, MessageStatus, ToolEvent
from utils.llm_timeouts import STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS
from utils.prompts import CONTEXT_POINTERS_RULE
from utils.tool_call_ids import spawn_group_id

logger = structlog.get_logger()

DAG_REASONING_UI_TOOL_NAME = "thought"
DAG_REASONING_IN_PROGRESS_TITLE = "Thinking"
DAG_REASONING_FINISHED_TITLE = "Thought"

# Planning-time aliases → Execution-time tool names
# Planner uses separate names (spawn_browser_agent, etc.) that map to unified spawn_agent
TOOL_ALIASES = {
    "spawn_explore_agent": "spawn_agent",
    "spawn_browser_agent": "spawn_agent",
    "spawn_code_agent": "spawn_agent",
    "spawn_general_purpose_agent": "spawn_agent",
    "spawn_general_purpose_agent_for_each": "spawn_agent",
    "wait_seconds": "wait_for",  # Backward compat for old plans
}

# When aliases resolve to spawn_agent, force the correct type param
# so the param-populator LLM can't pick the wrong agent type.
# general_purpose/for_each also REQUIRE start_phase (SpawnAgentTool validation);
# the param-populator doesn't supply it, so the alias must — otherwise the DAG
# task fails with "start_phase is required when type='general_purpose'|'for_each'".
# EXECUTE is correct here: these run pre-planned DAG sub-tasks, so the child
# doesn't need its own PLAN phase (also cheaper across a large for_each fan-out).
ALIAS_TYPE_OVERRIDES = {
    "spawn_explore_agent": {"type": "explore"},
    "spawn_browser_agent": {"type": "browser"},
    "spawn_code_agent": {"type": "code"},
    "spawn_general_purpose_agent": {"type": "general_purpose", "start_phase": "EXECUTE"},
    "spawn_general_purpose_agent_for_each": {"type": "for_each", "start_phase": "EXECUTE"},
}


def _apply_alias_override(params: Dict[str, Any], tool_name: str) -> Dict[str, Any]:
    """Merge an alias's type/start_phase override into a populated param dict.

    ``type`` is forced (the param-populator can't be trusted to pick it), but
    ``start_phase`` is a FALLBACK: a populator-chosen start_phase is preserved so
    an already-cached fan-out keeps its children on their existing cache keys;
    the alias default only fills a missing/None start_phase (the intermittent
    prod failure where the DAG for_each spawned without start_phase and was
    rejected by SpawnAgentTool). Mutates and returns ``params``.
    """
    type_override = ALIAS_TYPE_OVERRIDES.get(tool_name)
    if not type_override:
        return params
    override = dict(type_override)
    if override.get("start_phase") and params.get("start_phase"):
        override.pop("start_phase")
    params.update(override)
    return params


_PARAM_SELECTION_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "be",
    "by",
    "do",
    "for",
    "from",
    "has",
    "in",
    "is",
    "it",
    "its",
    "no",
    "not",
    "of",
    "on",
    "or",
    "only",
    "the",
    "to",
    "use",
    "with",
    "you",
}


def _param_selection_tokens(value: Any) -> set[str]:
    """Tokenize a task/candidate string for deterministic param-call disambiguation."""
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, default=str)
    return {
        token
        for token in re.findall(r"[a-z0-9]+", text.lower())
        if len(token) > 1 and token not in _PARAM_SELECTION_STOPWORDS
    }


def _tool_call_task_text(tool_call: Dict[str, Any]) -> Any:
    """Return the task-bearing field from a populated tool call."""
    for key in ("goal", "query", "url", "condition", "message"):
        value = tool_call.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return {k: v for k, v in tool_call.items() if k != "tool"}


def _select_param_tool_call(tool_calls: List[Dict[str, Any]], actual_tool: str, task: "DAGTask") -> Dict[str, Any]:
    """Select exactly one param-populator tool call for a DAG task.

    The param-populator prompt requires exactly one tool call. If the model
    returns several matching calls anyway, choose the one whose task-bearing
    fields best match the DAG node instead of executing the first call blindly.
    """
    if not tool_calls:
        raise ValueError(f"LLM returned no tool calls for task {task.index}")

    matching = [tc for tc in tool_calls if tc.get("tool") == actual_tool]
    if not matching:
        if len(tool_calls) == 1:
            workflow.logger.warning(f"[DAG] Expected tool {actual_tool}, got {tool_calls[0].get('tool')}")
            return tool_calls[0]
        raise ValueError(f"LLM returned {len(tool_calls)} tool calls for task {task.index}, none for {actual_tool}")

    if len(matching) == 1:
        return matching[0]

    task_tokens = _param_selection_tokens(task.goal)
    ranked: list[tuple[int, int, Dict[str, Any]]] = []
    for order, tool_call in enumerate(matching):
        candidate_tokens = _param_selection_tokens(_tool_call_task_text(tool_call))
        score = len(task_tokens & candidate_tokens)
        ranked.append((score, -order, tool_call))

    ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
    best_score = ranked[0][0]
    second_score = ranked[1][0]
    if best_score > second_score:
        workflow.logger.warning(
            f"[DAG] Param populator returned {len(matching)} {actual_tool} calls for task {task.index}; "
            f"selected best task match"
        )
        return ranked[0][2]

    raise ValueError(f"LLM returned multiple ambiguous {actual_tool} tool calls for task {task.index}")


def _build_param_population_message(goal: str, tool_name: str, alias_hint: str = "") -> str:
    """Build user message that prompts the LLM to call a specific tool.

    Appended to the existing agent context so the system prompt, tools, and
    conversation are identical to the main agent loop — giving us cache reads
    on the entire prefix.
    """
    msg = (
        f"Execute this task by calling the `{tool_name}` tool with the correct parameters.\n\n"
        f"Task: {goal}\n\n"
        f"You MUST call exactly one tool: `{tool_name}`. Do not respond with text only."
    )

    if tool_name == "spawn_agent" or alias_hint.startswith("spawn_"):
        msg += (
            "\n\nThe spawned agent has NO access to your conversation or prior context. "
            "The goal string is its ONLY source of information — embed ALL relevant details. "
            "\n\n"
            f"{CONTEXT_POINTERS_RULE.strip()} "
            "Pass files via `attachments` using exact `original_filename` values. "
            "For file outputs in output_schema, use type='file_pointer'."
        )

    return msg


def _build_early_tool_event(
    task: "DAGTask",
    actual_tool: str,
    tool_call_id: str,
) -> tuple[str, ToolEvent]:
    """Build the pre-param-populator placeholder event for a DAG tool task."""
    event_tool_name = task.tool_name
    title = task.tool_name
    message = task.goal
    metadata: Dict[str, Any] = {}

    if actual_tool == "wait_for":
        event_tool_name = "wait_for"
        title = "Preparing wait"
    elif actual_tool == "spawn_agent":
        agent_type = ALIAS_TYPE_OVERRIDES.get(task.tool_name, {}).get("type")
        if agent_type == "explore":
            event_tool_name = "spawn_agent"
            title = "Exploring"
            metadata = {
                "agentType": "explore",
                "taskId": tool_call_id,
                "fullGoal": task.goal,
            }
        elif agent_type == "browser":
            event_tool_name = "spawn_browser_agent"
            title = "Starting browser agent"
        elif agent_type == "code":
            event_tool_name = "spawn_claude_code_agent"
            title = "Starting code agent"
        elif agent_type == "general_purpose":
            event_tool_name = "spawn_general_purpose_agent"
            title = "Spawning sub-agent"
            message = ""
            metadata = {"spawnGroupId": spawn_group_id(tool_call_id)}
        elif agent_type == "for_each":
            event_tool_name = "spawn_general_purpose_agent_for_each"
            title = "Spawning agent cluster"
            message = ""
            metadata = {"spawnGroupId": spawn_group_id(tool_call_id)}

    metadata["dagTaskIndex"] = task.index
    metadata["plannedToolName"] = task.tool_name

    return event_tool_name, ToolEvent(
        type=EventType.POST_MESSAGE,
        title=title,
        message=message,
        status=MessageStatus.IN_PROGRESS,
        metadata=metadata,
    )


def extract_error_message(e: Exception) -> str:
    """
    Extract the actual error message from an exception, unwrapping Temporal wrappers.

    Temporal wraps activity failures in ActivityError/ApplicationError which have
    generic messages like "Activity task failed". The real error is in .cause.

    Args:
        e: The exception to extract the message from

    Returns:
        The actual error message string
    """
    # Try to get the deepest cause
    current = e
    messages = []

    while current is not None:
        msg = str(current)
        # Skip generic Temporal wrapper messages
        if msg and msg not in ("Activity task failed", ""):
            messages.append(msg)

        # Traverse the cause chain
        if hasattr(current, "cause") and current.cause is not None:
            current = current.cause
        elif hasattr(current, "__cause__") and current.__cause__ is not None:
            current = current.__cause__
        else:
            break

    # Return the most specific message (last in chain), or fallback
    if messages:
        # Prefer the deepest error (most specific)
        return messages[-1] if len(messages) > 1 else messages[0]
    return str(e) or "Unknown error"


class TaskState(str, Enum):
    """State of a task in the DAG."""

    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


@dataclass
class DAGTask:
    """A single task in the DAG."""

    index: int
    goal: str
    tool_name: str
    depends_on: List[int] = field(default_factory=list)
    state: TaskState = TaskState.PENDING
    tool_call_id: Optional[str] = None


class TaskDAG:
    """
    Manages task dependencies and state for DAG execution.

    Parses plan_data from set_plan and provides:
    - get_ready_tasks(): Tasks with all dependencies satisfied
    - mark_in_progress/completed/failed(): State transitions
    - is_complete(): Check if all tasks done (respects join mode)
    """

    def __init__(self, plan_data: Dict[str, Any]):
        """
        Initialize DAG from plan_data.

        Args:
            plan_data: Dict with tasks, dependencies, join from set_plan
        """
        self.tasks: List[DAGTask] = []
        self.join: str = plan_data.get("join", "all")

        # Parse tasks
        raw_tasks = plan_data.get("tasks", [])
        dependencies = plan_data.get("dependencies", {})

        for i, task_data in enumerate(raw_tasks):
            if isinstance(task_data, str):
                raise ValueError(
                    f"Plan task {i} must be an object with explicit goal and tool_name; "
                    "string tasks are not supported"
                )
            if not isinstance(task_data, dict):
                raise ValueError(f"Plan task {i} must be an object, got {type(task_data).__name__}")

            goal = task_data.get("goal", "")
            tool_name = task_data.get("tool_name")
            if not isinstance(tool_name, str) or not tool_name.strip():
                raise ValueError(f"Plan task {i} missing required tool_name")
            tool_name = tool_name.strip()

            # Get dependencies for this task index
            deps = dependencies.get(str(i), [])
            depends_on = [int(d) for d in deps]

            self.tasks.append(
                DAGTask(
                    index=i,
                    goal=goal,
                    tool_name=tool_name,
                    depends_on=depends_on,
                )
            )

    def get_ready_tasks(self) -> List[DAGTask]:
        """
        Get tasks that are ready to execute (dependencies satisfied).

        Returns:
            List of DAGTask with state PENDING and all deps COMPLETED
        """
        ready = []
        for task in self.tasks:
            if task.state != TaskState.PENDING:
                continue

            # Check if all dependencies are completed
            deps_satisfied = all(self.tasks[dep_idx].state == TaskState.COMPLETED for dep_idx in task.depends_on)

            if deps_satisfied:
                ready.append(task)

        return ready

    def mark_in_progress(self, index: int, tool_call_id: str) -> None:
        """Mark a task as in progress."""
        self.tasks[index].state = TaskState.IN_PROGRESS
        self.tasks[index].tool_call_id = tool_call_id

    def mark_completed(self, index: int) -> None:
        """Mark a task as completed."""
        self.tasks[index].state = TaskState.COMPLETED

    def mark_failed(self, index: int) -> None:
        """Mark a task as failed."""
        self.tasks[index].state = TaskState.FAILED

    def resume_completed_tasks_from_context(self, context: List[Dict[str, Any]]) -> List[int]:
        """Mark already-finished DAG tasks from persisted messages.

        New DAG messages carry ``dagTaskIndex`` metadata. Older transcripts do
        not, so fall back to matching terminal tool rows to the first pending
        planned task with the same logical tool. Reasoning DAG tasks complete
        as normal assistant rows, because their live output uses the existing
        assistant stream path rather than a persisted synthetic tool row.
        """
        completed: List[int] = []
        tool_call_to_task: Dict[str, int] = {}

        for msg in context:
            metadata = msg.get("metadata") or {}
            if not isinstance(metadata, dict):
                continue
            tool_call_id = metadata.get("toolCallId")
            dag_task_index = metadata.get("dagTaskIndex")
            if isinstance(tool_call_id, str) and isinstance(dag_task_index, int):
                tool_call_to_task[tool_call_id] = dag_task_index

        for msg in context:
            metadata = msg.get("metadata") or {}
            if not isinstance(metadata, dict):
                continue
            is_finished_tool = metadata.get("toolStatus") == "FINISHED" and not metadata.get("error")
            is_finished_reasoning = (
                msg.get("role") == "ASSISTANT"
                and metadata.get("plannedToolName") == "reasoning"
                and isinstance(metadata.get("dagTaskIndex"), int)
                and not metadata.get("error")
            )
            if not is_finished_tool and not is_finished_reasoning:
                continue

            tool_call_id = metadata.get("toolCallId")
            task_index = metadata.get("dagTaskIndex") if is_finished_reasoning else None
            if task_index is None:
                task_index = tool_call_to_task.get(tool_call_id) if isinstance(tool_call_id, str) else None
            if task_index is None:
                task_index = self._legacy_completed_task_index(metadata)
            if task_index is None or task_index < 0 or task_index >= len(self.tasks):
                continue
            task = self.tasks[task_index]
            if task.state != TaskState.PENDING:
                continue
            if not all(self.tasks[dep_idx].state == TaskState.COMPLETED for dep_idx in task.depends_on):
                continue

            task.state = TaskState.COMPLETED
            if isinstance(tool_call_id, str):
                task.tool_call_id = tool_call_id
            completed.append(task_index)

        return completed

    def _legacy_completed_task_index(self, metadata: Dict[str, Any]) -> Optional[int]:
        """Best-effort mapping for pre-dagTaskIndex persisted messages."""
        for task in self.tasks:
            if task.state != TaskState.PENDING:
                continue
            if _metadata_matches_task(metadata, task):
                return task.index
        return None

    def is_complete(self) -> bool:
        """
        Check if DAG execution is complete.

        For join="all": All tasks must be COMPLETED
        For join="any": At least one task must be COMPLETED
        """
        if self.join == "any":
            return any(t.state == TaskState.COMPLETED for t in self.tasks)
        else:  # join="all"
            return all(t.state == TaskState.COMPLETED for t in self.tasks)

    def has_failed(self) -> bool:
        """Check if any task has failed."""
        return any(t.state == TaskState.FAILED for t in self.tasks)


def extract_plan_from_context(context: List[Dict]) -> Optional[Dict[str, Any]]:
    """
    Extract the latest plan from context messages.

    Scans backwards for the most recent set_plan FINISHED message
    and extracts the plan_data from metadata.

    Args:
        context: List of message dicts

    Returns:
        plan_data dict if found, None otherwise
    """
    for msg in reversed(context):
        metadata = msg.get("metadata") or {}
        if metadata.get("toolName") == "set_plan" and metadata.get("toolStatus") == "FINISHED":
            return metadata.get("data")
    return None


def _metadata_matches_task(metadata: Dict[str, Any], task: DAGTask) -> bool:
    """Return whether a terminal tool row represents a planned DAG task."""
    tool_name = metadata.get("toolName")
    if not isinstance(tool_name, str):
        return False
    if tool_name == task.tool_name:
        return True

    actual_tool = TOOL_ALIASES.get(task.tool_name, task.tool_name)
    if tool_name == actual_tool:
        if actual_tool == "spawn_agent":
            expected_type = ALIAS_TYPE_OVERRIDES.get(task.tool_name, {}).get("type")
            agent_type = metadata.get("agentType") or metadata.get("agent_type")
            if task.tool_name == "spawn_explore_agent":
                return agent_type in {None, "explore"}
            return agent_type == expected_type
        return True

    if task.tool_name == "spawn_code_agent" and tool_name == "spawn_claude_code_agent":
        return True
    if task.tool_name == "reasoning" and tool_name == DAG_REASONING_UI_TOOL_NAME:
        return True
    return False


async def execute_dag(
    dag: TaskDAG,
    agent_id: str,
    user_id: str,
    model: str,
    context: List[Dict],
    execute_activity: Callable,
    post_message: Callable[[str, str, Optional[Dict]], Awaitable[None]],
    execute_tool: Callable[[str, Dict, str], Awaitable[Dict]],
    handle_tool_event_fn: Callable[[ToolEvent, str, str], Awaitable[None]],
    poll_messages: Optional[Callable[[datetime], Awaitable[List[Dict]]]] = None,
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    on_tokens: Optional[Callable[..., Awaitable[None]]] = None,
    system_prompt_text: Optional[str] = None,
    tool_names: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Execute DAG with maximum parallelism.

    Fires tasks immediately when their dependencies complete.
    Uses asyncio.wait(FIRST_COMPLETED) for efficient scheduling.

    Args:
        dag: TaskDAG instance
        agent_id: Agent ID for context
        user_id: User ID for context
        model: Model name for reasoning tasks
        context: Current message context (mutable - tools add to it)
        execute_activity: workflow.execute_activity for calling activities
        post_message: Callback to post messages to DB
        execute_tool: Callback to execute tools (existing flow)
        handle_tool_event_fn: Callback to handle tool events (IN_PROGRESS, etc)

    Returns:
        Dict with:
        - status: "completed" | "needs_llm"
        - context: Updated context
    """
    # Import here to avoid circular imports

    # Map task index to pending asyncio.Task
    pending_tasks: Dict[int, asyncio.Task] = {}
    # Map asyncio.Task to task index for lookup
    task_to_index: Dict[asyncio.Task, int] = {}

    workflow.logger.info(f"[DAG] Starting execution with {len(dag.tasks)} tasks, join={dag.join}")

    cache_warm_complete = False

    async def warm_cache_before_tool_tasks() -> None:
        nonlocal cache_warm_complete
        if cache_warm_complete:
            return
        cache_warm_complete = True
        if not system_prompt_text or not (claude_token or gpt_token):
            return
        try:
            _pending_llm_context[agent_id] = (list(context), system_prompt_text, None)
            await execute_activity(
                call_llm_activity,
                args=[
                    agent_id,
                    model,
                    tool_names or [],
                    1,
                    agent_id,
                    None,
                    None,
                    claude_token,
                    "dag_cache_warm",
                    system_prompt_text,
                    None,
                    None,
                    False,
                    "",
                    claude_token_source,
                    claude_token_pool_id,
                    user_id,
                    gpt_token,
                    gpt_account_id,
                    gpt_token_source,
                    gpt_token_pool_id,
                    user_id,
                    None,
                    None,
                    user_id,
                    # Fast Mode: cache-warm keys by canonical request fingerprint;
                    # enabled+goal auto-resolve from the agent row.
                    False,
                    None,
                    0,
                ],
                start_to_close_timeout=timedelta(seconds=STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=1),
                heartbeat_timeout=timedelta(seconds=60),
            )
            workflow.logger.info("[DAG] Cache warm complete")
        except Exception as e:
            workflow.logger.warning(f"[DAG] Cache warm failed (non-fatal): {e}")

    first_iteration = True
    # Seed last_checked from existing context to avoid fetching entire message history
    last_checked = datetime.fromtimestamp(0, tz=timezone.utc)
    for msg in context:
        ts_str = msg.get("timestamp", "")
        if ts_str:
            try:
                msg_ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                if msg_ts > last_checked:
                    last_checked = msg_ts
            except Exception:
                pass

    while not dag.is_complete() and not dag.has_failed():
        # Poll DB for new messages before starting next batch
        # (skip first iteration — nothing has completed yet)
        if poll_messages and not first_iteration:
            last_checked = await poll_and_update_context(poll_messages, context, last_checked)
        first_iteration = False

        # Start newly ready tasks
        ready = dag.get_ready_tasks()
        if any(task.tool_name != "reasoning" for task in ready):
            # Warm immediately before the first concrete tool batch needs a
            # param-populator prefix. This preserves cache behavior for tool
            # nodes without blocking earlier reasoning-only DAG steps from
            # streaming to the frontend.
            await warm_cache_before_tool_tasks()
        for task in ready:
            if task.index not in pending_tasks:
                workflow.logger.info(f"[DAG] Starting task {task.index}: {task.tool_name} - {task.goal[:50]}...")

                coro = _execute_single_task(
                    task=task,
                    dag=dag,
                    agent_id=agent_id,
                    model=model,
                    context=context,
                    execute_activity=execute_activity,
                    post_message=post_message,
                    execute_tool=execute_tool,
                    handle_tool_event_fn=handle_tool_event_fn,
                    claude_token=claude_token,
                    claude_token_source=claude_token_source,
                    claude_token_pool_id=claude_token_pool_id,
                    gpt_token=gpt_token,
                    gpt_account_id=gpt_account_id,
                    gpt_token_source=gpt_token_source,
                    gpt_token_pool_id=gpt_token_pool_id,
                    user_id=user_id,
                    on_tokens=on_tokens,
                    system_prompt_text=system_prompt_text,
                    tool_names=tool_names,
                )
                asyncio_task = asyncio.create_task(coro)
                pending_tasks[task.index] = asyncio_task
                task_to_index[asyncio_task] = task.index

        if not pending_tasks:
            # No tasks running and none ready - stuck (shouldn't happen with valid DAG)
            workflow.logger.warning("[DAG] No pending tasks and DAG not complete - returning for LLM recovery")
            return {
                "status": "needs_llm",
                "context": context,
            }

        # Wait for ANY task to complete
        done, _ = await asyncio.wait(pending_tasks.values(), return_when=asyncio.FIRST_COMPLETED)

        # Process completed tasks
        for completed_future in done:
            task_index = task_to_index[completed_future]
            del pending_tasks[task_index]
            del task_to_index[completed_future]

            try:
                success = completed_future.result()
            except Exception as e:
                workflow.logger.error(f"[DAG] Task {task_index} raised exception: {e}", exc_info=True)
                success = False

            if not success:
                # Error already posted to context by execute_tool/handle_tool_event
                workflow.logger.info(
                    f"[DAG] Task {task_index} failed - canceling remaining and returning for LLM recovery"
                )
                dag.mark_failed(task_index)

                # Cancel remaining pending tasks
                for pending in pending_tasks.values():
                    pending.cancel()

                return {
                    "status": "needs_llm",
                    "context": context,
                }

            dag.mark_completed(task_index)
            workflow.logger.info(f"[DAG] Task {task_index} completed")

        # Loop continues - get_ready_tasks will now return newly ready dependents

    workflow.logger.info("[DAG] Execution complete")
    return {
        "status": "completed",
        "context": context,
    }


async def _execute_single_task(
    task: DAGTask,
    dag: TaskDAG,
    agent_id: str,
    model: str,
    context: List[Dict],
    execute_activity: Callable,
    post_message: Callable[[str, str, Optional[Dict]], Awaitable[None]],
    execute_tool: Callable[[str, Dict, str], Awaitable[Dict]],
    handle_tool_event_fn: Callable[[ToolEvent, str, str], Awaitable[None]],
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    user_id: Optional[str] = None,
    on_tokens: Optional[Callable[..., Awaitable[None]]] = None,
    system_prompt_text: Optional[str] = None,
    tool_names: Optional[List[str]] = None,
) -> bool:
    """
    Execute a single task from the DAG.

    For reasoning tasks:
    - Executes via execute_reasoning_activity (proper Temporal activity)
    - Streams output to frontend via Supabase Realtime
    - Posts final result as ASSISTANT message

    For tool tasks:
    - Emits IN_PROGRESS, calls tool, emits FINISHED

    Returns:
        True if successful, False if failed
    """
    from activities.reasoning import execute_reasoning_activity

    # MUST be workflow.uuid4() (not uuid.uuid4()): this id runs in workflow
    # scope and is recorded in Temporal history. Raw uuid.uuid4() is recomputed
    # on every replay, so a worker migration/restart mid-fan-out regenerates the
    # id — IN_PROGRESS child events land under the pre-replay id and FINISHED
    # events under the post-replay id, splitting one for_each into two bubbles
    # (the pre-replay one spins forever, never receiving a matching FINISHED).
    tool_call_id = str(workflow.uuid4())
    reasoning_stream_id: Optional[str] = None
    reasoning_started_at: Optional[str] = None
    dag.mark_in_progress(task.index, tool_call_id)

    try:
        if task.tool_name == "reasoning":
            # Reasoning task - execute via activity (streams to frontend via Supabase Realtime)
            # workflow.uuid4() for replay-stability (see tool_call_id note above).
            stream_id = f"dag-reasoning-{task.index}-{workflow.uuid4()}"
            reasoning_stream_id = stream_id
            reasoning_started_at = workflow.now().isoformat()

            # Trim context to the same window the reasoning activity will use
            # internally (MAX_CONTEXT_MESSAGES). Without this, the FULL context
            # (every TOOL result, including bloated explore-agent web search
            # output) is serialized as the activity payload — which routinely
            # exceeds Temporal's 2 MiB cap when the parent has spawned several
            # explore sub-agents (parallel-tool-calls smoke task). The activity
            # would just truncate this anyway, so trimming at the call site
            # both keeps the payload under cap AND saves serialization work.
            trimmed_context = (
                context[-REASONING_MAX_CONTEXT_MESSAGES:] if len(context) > REASONING_MAX_CONTEXT_MESSAGES else context
            )
            reasoning_args = [
                task.goal,
                trimmed_context,
                model,
                agent_id,
                stream_id,
                claude_token,
                claude_token_source,
                claude_token_pool_id,
                user_id,
                gpt_token,
                gpt_account_id,
                gpt_token_source,
                gpt_token_pool_id,
                user_id,
                # Fast Mode: reasoning keys by canonical request fingerprint.
                task.index,
                system_prompt_text,
            ]
            # Fail fast if context has grown past Temporal's 2 MiB payload limit —
            # otherwise the workflow-task encoder loops silently on replay.
            check_activity_payload("execute_reasoning_activity", reasoning_args)

            reasoning_result = await execute_activity(
                execute_reasoning_activity,
                args=reasoning_args,
                # Reasoning streams from a thinking-mode model on synthesis-heavy
                # contexts (parallel-tool-calls smoke task: 3-city comparison
                # over ~30 prior messages of explore-agent output). End-to-end
                # cost is consistently 80-110 s — start-to-close has to clear
                # 90 s of streaming + post-processing, otherwise Temporal kills
                # the activity mid-stream and the retry hits the same wall.
                start_to_close_timeout=timedelta(seconds=STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=2),
                # Heartbeat-timeout is the per-chunk safety net. The LLM stream
                # heartbeats every chunk via _safe_heartbeat; a 90 s gap means
                # the stream is dead. Setting too-tight a value (e.g. 60 s)
                # causes premature failures during legitimate model thinking
                # pauses, which we observed in smoke 15 — the LLM call landed
                # cleanly at 82 s, but heartbeat_timeout=60s killed the
                # activity before the result could be returned.
                heartbeat_timeout=timedelta(seconds=90),
            )

            # Unpack result (reasoning activity returns {"content": str, "usage": dict})
            if isinstance(reasoning_result, dict):
                reasoning_content = reasoning_result.get("content", "")
                reasoning_usage = reasoning_result.get("usage", {})
            else:
                reasoning_content = reasoning_result
                reasoning_usage = {}

            # Track reasoning LLM cost
            if on_tokens and reasoning_usage:
                r_in = reasoning_usage.get("prompt_tokens", 0)
                r_out = reasoning_usage.get("completion_tokens", 0)
                if r_in > 0 or r_out > 0:
                    try:
                        await on_tokens(
                            r_in,
                            r_out,
                            reasoning_usage.get("actual_model"),
                            cache_read_input_tokens=reasoning_usage.get("cache_read_input_tokens", 0),
                            cache_creation_input_tokens=reasoning_usage.get("cache_creation_input_tokens", 0),
                            call_site="dag_reasoning",
                            claude_token_rotated=reasoning_usage.get("claude_token_rotated", False),
                            claude_token_error=reasoning_usage.get("claude_token_error"),
                            gpt_token_error=reasoning_usage.get("gpt_token_error"),
                            gpt_token_rotated=reasoning_usage.get("gpt_token_rotated", False),
                            compute_token_used=reasoning_usage.get("compute_token_used"),
                            from_fast_cache=reasoning_usage.get("from_fast_cache", False),
                        )
                    except Exception as e:
                        workflow.logger.warning(f"on_tokens failed for dag_reasoning: {e}")

            await post_message(
                reasoning_content,
                "ASSISTANT",
                {
                    "dagTaskIndex": task.index,
                    "plannedToolName": task.tool_name,
                    "streamId": stream_id,
                    "firstTimestamp": reasoning_started_at,
                    "startedAt": reasoning_started_at,
                },
            )

            return True

        else:
            # Resolve alias first (needed to decide if tool manages its own events)
            actual_tool = TOOL_ALIASES.get(task.tool_name, task.tool_name)
            if actual_tool != task.tool_name:
                workflow.logger.info(f"[DAG] Resolved alias: {task.tool_name} → {actual_tool}")

            # Emit a placeholder before param population so the UI reflects the
            # concrete planned tool while the LLM fills arguments.
            early_tool_name, early_event = _build_early_tool_event(task, actual_tool, tool_call_id)
            await handle_tool_event_fn(early_event, tool_call_id, early_tool_name)

            # Populate tool params by extending the current agent context with a
            # user message that prompts the LLM to call the specific tool.
            # Same system prompt + tools + conversation = cache prefix hit.
            extra_msg = _build_param_population_message(task.goal, actual_tool, task.tool_name)

            # Store context snapshot in shared memory for same-machine activity pickup.
            # Parallel DAG tasks share the key — same data, and worst case the
            # second task falls back to backend API after the first cleans up.
            _pending_llm_context[agent_id] = (list(context), system_prompt_text, None)

            # Constrain the param-population schema to ONLY the required tool.
            # call_llm_activity uses structured output (create_agent_action_model),
            # so passing the full tool-set lets a weak model (e.g. rose-1-lite)
            # emit send_message instead of the planned tool — which fails the
            # required_tool check and silently kills the DAG node (e.g. a for_each
            # that never fans out). A single-tool union forces the right call.
            llm_result = await execute_activity(
                call_llm_activity,
                args=[
                    agent_id,
                    model,
                    [actual_tool],
                    256,
                    agent_id,
                    None,
                    None,
                    claude_token,
                    "dag_param_populator",
                    system_prompt_text,
                    extra_msg,
                    actual_tool,
                    True,
                    "",
                    claude_token_source,
                    claude_token_pool_id,
                    user_id,
                    gpt_token,
                    gpt_account_id,
                    gpt_token_source,
                    gpt_token_pool_id,
                    user_id,
                    None,
                    None,
                    user_id,
                    # Fast Mode: DAG node keys by canonical request fingerprint.
                    False,
                    None,
                    task.index,
                ],
                start_to_close_timeout=timedelta(seconds=600),
                retry_policy=RetryPolicy(maximum_attempts=2),
                heartbeat_timeout=timedelta(seconds=180),
            )

            # Extract params from the matching tool call
            tool_calls = llm_result.get("tool_calls", [])
            tool_call = _select_param_tool_call(tool_calls, actual_tool, task)
            params = {k: v for k, v in tool_call.items() if k != "tool"}

            # Track param population LLM cost
            param_usage = llm_result.get("usage", {})
            if on_tokens and param_usage:
                p_in = param_usage.get("prompt_tokens", 0)
                p_out = param_usage.get("completion_tokens", 0)
                if p_in > 0 or p_out > 0:
                    try:
                        await on_tokens(
                            p_in,
                            p_out,
                            param_usage.get("actual_model"),
                            cache_read_input_tokens=param_usage.get("cache_read_input_tokens", 0),
                            cache_creation_input_tokens=param_usage.get("cache_creation_input_tokens", 0),
                            call_site="dag_param_populator",
                            claude_token_rotated=param_usage.get("claude_token_rotated", False),
                            claude_token_error=param_usage.get("claude_token_error"),
                            gpt_token_error=param_usage.get("gpt_token_error"),
                            gpt_token_rotated=param_usage.get("gpt_token_rotated", False),
                            compute_token_used=param_usage.get("compute_token_used"),
                            from_fast_cache=param_usage.get("from_fast_cache", False),
                        )
                    except Exception as e:
                        workflow.logger.warning(f"on_tokens failed for dag_param_populator: {e}")

            # Force correct type for spawn_agent aliases (LLM can't be trusted to pick the right type)
            type_override = ALIAS_TYPE_OVERRIDES.get(task.tool_name)
            if type_override:
                _apply_alias_override(params, task.tool_name)
                workflow.logger.info(
                    f"[DAG] Applying type override for {task.tool_name}: {params.get('type')} start_phase={params.get('start_phase')}"
                )
                # Explore agents don't use these type-specific params — strip them if LLM added them
                if type_override.get("type") == "explore":
                    params.pop("output_schema", None)
                    params.pop("start_url", None)
                    params.pop("github_repo_link", None)
                    # Clamp planner/DAG explores to a fast breadth-scan. The param-populator
                    # LLM tends to pick depth="deep" for "comprehensive" goals, turning a
                    # gating "identify the list" explore into a 50-turn crawl that blocks
                    # fan-out. Force quick here; deliberate deep research should be its own task.
                    params["depth"] = "quick"

                if type_override.get("type") in {"general_purpose", "for_each"}:
                    params["_spawn_group_id"] = spawn_group_id(tool_call_id)

            # Execute tool (uses existing flow - posts result to context)
            result = await execute_tool(actual_tool, params, tool_call_id)

            # Check for error status
            # _execute_tool returns {"error": True} on exception, {"success": False} on tool failure
            failed = bool(result.get("error") or result.get("success") is False or result.get("status") == "error")
            if failed:
                # Surface the swallowed tool-result error — without this, a DAG task
                # failure shows only "[DAG] Task N failed" with no reason, making
                # e.g. a for_each spawn validation failure invisible.
                workflow.logger.warning(
                    f"[DAG] Task {task.index} tool '{actual_tool}' returned failure: "
                    f"{str(result.get('message') or result.get('error') or result)[:300]} "
                    f"| type={params.get('type')} start_phase={params.get('start_phase')} "
                    f"items={len(params.get('items')) if isinstance(params.get('items'), list) else params.get('items')}"
                )
            return not failed

    except Exception as e:
        # Extract actual error message (unwrap Temporal's ActivityError wrapper)
        error_msg = extract_error_message(e)
        workflow.logger.error(f"[DAG] Task {task.index} error: {error_msg}", exc_info=True)
        if task.tool_name == "reasoning":
            await post_message(
                f"Error: {error_msg}",
                "ASSISTANT",
                {
                    "dagTaskIndex": task.index,
                    "plannedToolName": task.tool_name,
                    "streamId": reasoning_stream_id,
                    "firstTimestamp": reasoning_started_at,
                    "startedAt": reasoning_started_at,
                    "error": True,
                },
            )
            await handle_tool_event_fn(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=DAG_REASONING_FINISHED_TITLE,
                    message=f"Error: {error_msg}",
                    status=MessageStatus.ERROR,
                    metadata={"dagTaskIndex": task.index, "plannedToolName": task.tool_name},
                ),
                tool_call_id,
                DAG_REASONING_UI_TOOL_NAME,
            )
            return False

        error_tool_name = (
            DAG_REASONING_UI_TOOL_NAME if task.tool_name == "reasoning" else task.tool_name
        )
        error_title = (
            DAG_REASONING_FINISHED_TITLE if task.tool_name == "reasoning" else task.tool_name
        )

        # Post error via handle_tool_event (adds to context)
        await handle_tool_event_fn(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title=error_title,
                message=f"Error: {error_msg}",
                status=MessageStatus.ERROR,
                metadata={"dagTaskIndex": task.index, "plannedToolName": task.tool_name},
            ),
            tool_call_id,
            error_tool_name,
        )

        return False
