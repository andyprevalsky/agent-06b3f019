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

from datetime import timedelta
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Any, Callable, Awaitable
import asyncio
import uuid

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from tools.base import ToolEvent, EventType, MessageStatus

logger = structlog.get_logger()

# Planning-time aliases → Execution-time tool names
# "sub_agent" is a planning abstraction that maps to spawn_sub_agents(1 agent)
TOOL_ALIASES = {
    "sub_agent": "spawn_sub_agents",
}


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

            self.tasks.append(DAGTask(
                index=i,
                goal=goal,
                tool_name=tool_name,
                depends_on=depends_on,
            ))

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
            deps_satisfied = all(
                self.tasks[dep_idx].state == TaskState.COMPLETED
                for dep_idx in task.depends_on
            )

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
        metadata = msg.get("metadata", {})
        if (metadata.get("toolName") == "set_plan" and
            metadata.get("toolStatus") == "FINISHED"):
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
    from activities.param_populator import populate_tool_params_activity

    # Map task index to pending asyncio.Task
    pending_tasks: Dict[int, asyncio.Task] = {}
    # Map asyncio.Task to task index for lookup
    task_to_index: Dict[asyncio.Task, int] = {}

    workflow.logger.info(f"[DAG] Starting execution with {len(dag.tasks)} tasks, join={dag.join}")

    while not dag.is_complete() and not dag.has_failed():
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
                )
                asyncio_task = asyncio.create_task(coro)
                pending_tasks[task.index] = asyncio_task
                task_to_index[asyncio_task] = task.index

        if not pending_tasks:
            # No tasks running and none ready - stuck (shouldn't happen with valid DAG)
            workflow.logger.warning("[DAG] No pending tasks and DAG not complete - breaking")
            break

        # Wait for ANY task to complete
        done, _ = await asyncio.wait(
            pending_tasks.values(),
            return_when=asyncio.FIRST_COMPLETED
        )

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
                workflow.logger.info(f"[DAG] Task {task_index} failed - canceling remaining and returning for LLM recovery")
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

    if dag.has_failed():
        return {
            "status": "needs_llm",
            "context": context,
        }

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
    from activities.param_populator import populate_tool_params_activity
    from activities.reasoning import execute_reasoning_activity

    tool_call_id = str(uuid.uuid4())
    dag.mark_in_progress(task.index, tool_call_id)

    try:
        if task.tool_name == "reasoning":
            # Reasoning task - execute via activity (streams to frontend via Supabase Realtime)
            stream_id = f"dag-reasoning-{task.index}-{uuid.uuid4()}"

            reasoning_result = await execute_activity(
                execute_reasoning_activity,
                args=[task.goal, context, model, agent_id, stream_id],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # Post reasoning to DB as ASSISTANT message
            await post_message(
                reasoning_result,
                "ASSISTANT",
                {"reasoning": True, "dagTaskIndex": task.index}
            )

            return True

        else:
            # Tool task - emit IN_PROGRESS, execute, emit FINISHED
            await handle_tool_event_fn(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=task.tool_name,
                    message=task.goal,
                    status=MessageStatus.IN_PROGRESS,
                ),
                tool_call_id,
                task.tool_name
            )

            # Resolve alias and populate params
            actual_tool = TOOL_ALIASES.get(task.tool_name, task.tool_name)
            if actual_tool != task.tool_name:
                workflow.logger.info(f"[DAG] Resolved alias: {task.tool_name} → {actual_tool}")

            params = await execute_activity(
                populate_tool_params_activity,
                args=[actual_tool, task.goal, context, model],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # Execute tool (uses existing flow - posts result to context)
            result = await execute_tool(actual_tool, params, tool_call_id)

            # Check for error status
            if result.get("status") == "error":
                return False

            return True

    except Exception as e:
        workflow.logger.error(f"[DAG] Task {task.index} error: {e}", exc_info=True)

        # Post error via handle_tool_event (adds to context)
        await handle_tool_event_fn(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title=task.tool_name,
                message=f"Error: {str(e)}",
                status=MessageStatus.ERROR,
            ),
            tool_call_id,
            task.tool_name
        )

        return False
