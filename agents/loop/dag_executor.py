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
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Awaitable, Callable, Dict, List, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.param_populator.config import SPAWN_PARAM_REQUIREMENTS
from domains.reasoning.config import MAX_CONTEXT_MESSAGES as REASONING_MAX_CONTEXT_MESSAGES
from helpers.llm import _pending_llm_context, call_llm_activity
from loop.context_utils import poll_and_update_context
from loop.payload_guard import check_activity_payload
from tools.base import EventType, MessageStatus, ToolEvent

logger = structlog.get_logger()

# Planning-time aliases → Execution-time tool names
# Planner uses separate names (spawn_browser_agent, etc.) that map to unified spawn_agent
TOOL_ALIASES = {
    "spawn_explore_agent": "spawn_agent",
    "spawn_browser_agent": "spawn_agent",
    "spawn_code_agent": "spawn_agent",
    "spawn_sub_agent": "spawn_agent",
    "spawn_sub_agent_for_each": "spawn_agent",
    "wait_seconds": "wait_for",  # Backward compat for old plans
}

# When aliases resolve to spawn_agent, force the correct type param
# so the param-populator LLM can't pick the wrong agent type
ALIAS_TYPE_OVERRIDES = {
    "spawn_explore_agent": {"type": "explore"},
    "spawn_browser_agent": {"type": "browser"},
    "spawn_code_agent": {"type": "code"},
    "spawn_sub_agent": {"type": "sub_agent"},
    "spawn_sub_agent_for_each": {"type": "for_each"},
}


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
            "Prefer @ref:message: pointers over rewriting content. "
            "Pass files via `attachments` using exact `original_filename` values. "
            "For file outputs in output_schema, use type='file_pointer'."
        )

    if alias_hint in SPAWN_PARAM_REQUIREMENTS:
        msg += f"\n{SPAWN_PARAM_REQUIREMENTS[alias_hint]}"

    return msg


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
            # Handle both old format (string) and new format (dict)
            if isinstance(task_data, str):
                goal = task_data
                tool_name = "reasoning"  # Default if no tool specified
            else:
                goal = task_data.get("goal", "")
                tool_name = task_data.get("tool_name", "reasoning")

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

    # Warm the Anthropic prompt cache before parallel DAG tasks fire.
    # A throwaway LLM call with the execute-phase system+tools+context
    # writes the cache prefix once; subsequent parallel param-populator
    # calls all read from it without needing serialization.
    has_llm_tasks = any(
        t.tool_name != "reasoning" for t in dag.tasks
    )
    if has_llm_tasks and system_prompt_text and (claude_token or gpt_token):
        try:
            _pending_llm_context[agent_id] = (list(context), system_prompt_text, None)
            await execute_activity(
                call_llm_activity,
                args=[
                    agent_id, model, tool_names or [], 1,
                    agent_id, None, None, claude_token,
                    "dag_cache_warm", system_prompt_text,
                    None, None, False,
                    False, "",
                    claude_token_source, claude_token_pool_id, user_id,
                    gpt_token, gpt_account_id, gpt_token_source, gpt_token_pool_id, user_id,
                    user_id,
                ],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=1),
                heartbeat_timeout=timedelta(seconds=20),
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

    tool_call_id = str(uuid.uuid4())
    dag.mark_in_progress(task.index, tool_call_id)

    try:
        if task.tool_name == "reasoning":
            # Reasoning task - execute via activity (streams to frontend via Supabase Realtime)
            stream_id = f"dag-reasoning-{task.index}-{uuid.uuid4()}"

            # Emit an IN_PROGRESS DB row so external monitors (and the FE) can see
            # the reasoning task started. Without this, the parent agent appears
            # silent for the full reasoning duration — frontend/benchmark stall
            # detectors interpret that as a hung agent. The reasoning activity
            # itself only writes a single ASSISTANT row at the end.
            await handle_tool_event_fn(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Reasoning",
                    message=task.goal,
                    status=MessageStatus.IN_PROGRESS,
                ),
                tool_call_id,
                "reasoning",
            )

            # Trim context to the same window the reasoning activity will use
            # internally (MAX_CONTEXT_MESSAGES). Without this, the FULL context
            # (every TOOL result, including bloated explore-agent web search
            # output) is serialized as the activity payload — which routinely
            # exceeds Temporal's 2 MiB cap when the parent has spawned several
            # explore sub-agents (parallel-tool-calls smoke task). The activity
            # would just truncate this anyway, so trimming at the call site
            # both keeps the payload under cap AND saves serialization work.
            trimmed_context = (
                context[-REASONING_MAX_CONTEXT_MESSAGES:]
                if len(context) > REASONING_MAX_CONTEXT_MESSAGES
                else context
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
                start_to_close_timeout=timedelta(seconds=180),
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
                        )
                    except Exception as e:
                        workflow.logger.warning(f"on_tokens failed for dag_reasoning: {e}")

            # Post reasoning to DB as ASSISTANT message
            await post_message(reasoning_content, "ASSISTANT", {"reasoning": True, "dagTaskIndex": task.index})

            return True

        else:
            # Resolve alias first (needed to decide if tool manages its own events)
            actual_tool = TOOL_ALIASES.get(task.tool_name, task.tool_name)
            if actual_tool != task.tool_name:
                workflow.logger.info(f"[DAG] Resolved alias: {task.tool_name} → {actual_tool}")

            # Legacy event-driven tools manage their own IN_PROGRESS/FINISHED events
            SELF_MANAGED_TOOLS = {"wait_for", "spawn_agent"}
            if actual_tool not in SELF_MANAGED_TOOLS:
                # Tool task - emit IN_PROGRESS, execute, emit FINISHED
                await handle_tool_event_fn(
                    ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=task.tool_name,
                        message=task.goal,
                        status=MessageStatus.IN_PROGRESS,
                    ),
                    tool_call_id,
                    task.tool_name,
                )

            # Populate tool params by extending the current agent context with a
            # user message that prompts the LLM to call the specific tool.
            # Same system prompt + tools + conversation = cache prefix hit.
            extra_msg = _build_param_population_message(task.goal, actual_tool, task.tool_name)

            # Store context snapshot in shared memory for same-machine activity pickup.
            # Parallel DAG tasks share the key — same data, and worst case the
            # second task falls back to backend API after the first cleans up.
            _pending_llm_context[agent_id] = (list(context), system_prompt_text, None)

            llm_result = await execute_activity(
                call_llm_activity,
                args=[
                    agent_id,
                    model,
                    tool_names or [],
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
                    user_id,
                ],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=2),
                heartbeat_timeout=timedelta(seconds=60),
            )

            # Extract params from the matching tool call
            tool_calls = llm_result.get("tool_calls", [])
            matching = [tc for tc in tool_calls if tc.get("tool") == actual_tool]
            if matching:
                params = {k: v for k, v in matching[0].items() if k != "tool"}
            elif tool_calls:
                workflow.logger.warning(
                    f"[DAG] Expected tool {actual_tool}, got {tool_calls[0].get('tool')}"
                )
                params = {k: v for k, v in tool_calls[0].items() if k != "tool"}
            else:
                raise ValueError(f"LLM returned no tool calls for task {task.index}")

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
                        )
                    except Exception as e:
                        workflow.logger.warning(f"on_tokens failed for dag_param_populator: {e}")

            # Force correct type for spawn_agent aliases (LLM can't be trusted to pick the right type)
            type_override = ALIAS_TYPE_OVERRIDES.get(task.tool_name)
            if type_override:
                workflow.logger.info(f"[DAG] Applying type override for {task.tool_name}: {type_override}")
                params.update(type_override)
                # Explore agents don't use these type-specific params — strip them if LLM added them
                if type_override.get("type") == "explore":
                    params.pop("output_schema", None)
                    params.pop("start_url", None)
                    params.pop("github_repo_link", None)

            # Execute tool (uses existing flow - posts result to context)
            result = await execute_tool(actual_tool, params, tool_call_id)

            # Check for error status
            # _execute_tool returns {"error": True} on exception, {"success": False} on tool failure
            return not (result.get("error") or result.get("success") is False or result.get("status") == "error")

    except Exception as e:
        # Extract actual error message (unwrap Temporal's ActivityError wrapper)
        error_msg = extract_error_message(e)
        workflow.logger.error(f"[DAG] Task {task.index} error: {error_msg}", exc_info=True)

        # Post error via handle_tool_event (adds to context)
        await handle_tool_event_fn(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title=task.tool_name,
                message=f"Error: {error_msg}",
                status=MessageStatus.ERROR,
            ),
            tool_call_id,
            task.tool_name,
        )

        return False
