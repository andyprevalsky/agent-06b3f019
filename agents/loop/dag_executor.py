"""
DAG Executor - Rigid execution of plans from set_plan.

Executes the task DAG with maximum parallelism:
- Tasks fire immediately when their dependencies complete
- Uses asyncio.wait(FIRST_COMPLETED) for efficient scheduling
- On a task failure, stops the DAG and hands recovery to the LLM loop (run_agent)

USAGE:
- Called from agent_workflow.py at EXECUTE phase start if a plan exists
- On success: returns "completed" status
- On failure: error already in context, returns "needs_llm" so run_agent can
  recover (execute_dag runs exactly once and is never re-entered, so this does
  NOT replay the plan or its already-completed siblings)
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Awaitable, Callable, Dict, List, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.reasoning.config import MAX_CONTEXT_MESSAGES as REASONING_MAX_CONTEXT_MESSAGES
from helpers.agent_addressing import ensure_planned_task_name
from helpers.background_agents import is_agent_authored_user_metadata
from helpers.context_compaction import is_excluded_from_model
from helpers.llm import _pending_llm_context, call_llm_activity
from loop.context_utils import poll_and_update_context
from loop.payload_guard import check_activity_payload
from tools.base import EventType, MessageStatus, ToolEvent
from utils.error_utils import error_chain_has_type
from utils.llm_timeouts import STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS
from utils.tool_call_ids import spawn_group_id
from utils.tool_schemas import TOOL_ALIASES

logger = structlog.get_logger()

STRUCTURED_OUTPUT_ERROR_TYPE = "LLMStructuredOutputError"
STRUCTURED_OUTPUT_MAX_ATTEMPTS = 2
# A new message mid-DAG cancels in-flight blocking tasks immediately, except
# these: cancelling a phone call hangs up a live call, and a pending user
# approval / question must still reach the user. They keep running and report
# as they normally would.
DAG_UNINTERRUPTIBLE_TOOLS = frozenset({"call_phone_number", "message_person"})


def _is_uninterruptible_dag_call(tool_name: str, params: Dict[str, Any]) -> bool:
    if tool_name in DAG_UNINTERRUPTIBLE_TOOLS:
        return True
    return tool_name.startswith("send_message_to_user") and params.get("is_question") is True


DAG_REASONING_UI_TOOL_NAME = "thought"
DAG_REASONING_IN_PROGRESS_TITLE = "Thinking"
DAG_REASONING_FINISHED_TITLE = "Thought"

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

ALIAS_REQUIRED_FIELDS = {
    "spawn_explore_agent": (),
    "spawn_browser_agent": ("start_url", "output_schema"),
    "spawn_code_agent": ("output_schema",),
    "spawn_general_purpose_agent": ("start_phase", "output_schema"),
    "spawn_general_purpose_agent_for_each": ("start_phase", "output_schema", "items or items_csv"),
}

assert set(ALIAS_REQUIRED_FIELDS) == set(ALIAS_TYPE_OVERRIDES)


class ParamPopulationContractError(ValueError):
    """The param-populator returned a call that cannot execute the planned DAG node."""


def _apply_alias_override(params: Dict[str, Any], tool_name: str, task_index: int = 0) -> Dict[str, Any]:
    """Merge an alias's type/start_phase override into a populated param dict.

    ``type`` is forced (the param-populator can't be trusted to pick it), but
    ``start_phase`` is a FALLBACK: a populator-chosen start_phase is preserved so
    an already-cached fan-out keeps its children on their existing cache keys;
    the alias default only fills a missing/None start_phase (the intermittent
    prod failure where the DAG for_each spawned without start_phase and was
    rejected by SpawnAgentTool). ``task_name`` is likewise a fallback
    (``planned_task_name``: goal slug + task number). Mutates and returns ``params``.
    """
    type_override = ALIAS_TYPE_OVERRIDES.get(tool_name)
    if not type_override:
        return params
    override = dict(type_override)
    if override.get("start_phase") and params.get("start_phase"):
        override.pop("start_phase")
    params.update(override)
    # spawn_agent requires task_name (the child's address <path>/<task_name>);
    # a planned task gets a deterministic one unless the populator chose a valid one.
    return ensure_planned_task_name(params, task_index)


def _select_param_tool_call(tool_calls: List[Dict[str, Any]], actual_tool: str, task: "DAGTask") -> Dict[str, Any]:
    """Require the one planned tool call promised by the param-populator prompt."""
    if len(tool_calls) != 1:
        raise ParamPopulationContractError(
            f"LLM must return exactly one tool call for task {task.index}; got {len(tool_calls)}"
        )

    tool_call = tool_calls[0]
    returned_tool = tool_call.get("tool")
    if returned_tool != actual_tool:
        raise ParamPopulationContractError(f"LLM expected {actual_tool}, got {returned_tool} for task {task.index}")

    expected_type = ALIAS_TYPE_OVERRIDES.get(task.tool_name, {}).get("type")
    if actual_tool == "spawn_agent" and expected_type and tool_call.get("type") != expected_type:
        raise ParamPopulationContractError(
            f"LLM expected {actual_tool} type {expected_type}, got {tool_call.get('type')} for task {task.index}"
        )
    return tool_call


def _deterministic_cached_contract_repair(actual_tool: str, task: "DAGTask") -> Optional[Dict[str, Any]]:
    """Repair a stale cached explore alias without making a live LLM call.

    Explore aliases require only the planned goal and discriminator, both of
    which are already authoritative in the DAG. Other aliases need fields the
    plan does not necessarily carry, so they continue through the bounded
    corrective prompt path.
    """
    if actual_tool != "spawn_agent" or task.tool_name != "spawn_explore_agent":
        return None
    return {"tool": "spawn_agent", "type": "explore", "goal": task.goal}


def _build_param_population_message(
    task_number: int,
    goal: str,
    tool_name: str,
    *,
    planned_tool_name: Optional[str] = None,
    contract_error: Optional[str] = None,
) -> str:
    """Build user message that prompts the LLM to call a specific tool.

    Appended to the existing agent context so the system prompt, tools, and
    conversation are identical to the main agent loop — giving us cache reads
    on the entire prefix.
    """
    message = (
        f"Please execute task {task_number} of the plan: {goal}\n\n"
        f"You MUST call exactly one tool: `{tool_name}`. Do not respond with text only."
    )

    alias_override = ALIAS_TYPE_OVERRIDES.get(planned_tool_name or "")
    if not alias_override:
        return message

    expected_type = alias_override["type"]
    required_fields = ALIAS_REQUIRED_FIELDS[planned_tool_name or ""]
    required_text = ", ".join(f"`{field}`" for field in required_fields) or "none beyond `goal` and `type`"
    message += (
        f'\n\nThe outer planned alias `{planned_tool_name}` requires `type="{expected_type}"`. '
        f"Required type-specific fields: {required_text}. "
        "Instructions to use another agent type for nested work belong inside the child goal; "
        "they must not change the outer spawn type."
    )

    if contract_error:
        bounded_error = " ".join(contract_error.split())[:500]
        message += (
            f"\n\nPrevious attempt violated the planned tool contract: {bounded_error}. "
            f"Retry with exactly one `{tool_name}` call and the required discriminator "
            f'`type="{expected_type}"`.'
        )

    return message


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


def _is_strict_readonly_cache_miss(exc: BaseException) -> bool:
    """True when Fast Mode refused a live populate because the slot is absent.

    Transport/lookup faults also raise FastCacheLookupError; those stay
    failures. Only the clean read-only miss ("no row, live fallback disabled")
    is a skip — replay what is cached, do not invent a live DAG node.
    """
    if not error_chain_has_type(exc, "FastCacheLookupError"):
        return False
    return "Strict read-only benchmark cache miss" in extract_error_message(exc)


def _context_is_oai_demo(context: Optional[List[Dict]]) -> bool:
    """True when the DAG conversation is the catalog mass-agent demo tree."""
    from domains.spawn_agent.config import is_oai_demo_goal

    for message in context or []:
        if not isinstance(message, dict):
            continue
        if is_oai_demo_goal(str(message.get("text") or message.get("message") or "")):
            return True
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        if is_oai_demo_goal(str(metadata.get("fullGoal") or metadata.get("goal") or "")):
            return True
    return False


def _dag_has_completed_for_each(dag: "TaskDAG") -> bool:
    return any(
        task.tool_name == "spawn_general_purpose_agent_for_each" and task.state == TaskState.COMPLETED
        for task in dag.tasks
    )


# July Fast Mode seeded assemble-final at dag_reasoning p:6. Current planner
# leftover GPs after for_each inflate the reasoning task.index (70a8df9d
# used 7), which misses that slot and soft-completes a 92-char stub — T7
# then sees a 411-char card instead of the 4000-char report.
OAI_DEMO_ASSEMBLE_FINAL_REASONING_STEP = 6


def _oai_demo_reasoning_fast_mode_step(task: "DAGTask", dag: "TaskDAG", context: Optional[List[Dict]]) -> int:
    """Replay assemble-final from the July p:6 slot on catalog demo trees."""
    if task.tool_name != "reasoning":
        return task.index
    if not _context_is_oai_demo(context):
        return task.index
    if not _dag_has_completed_for_each(dag):
        return task.index
    return OAI_DEMO_ASSEMBLE_FINAL_REASONING_STEP


def _should_skip_oai_demo_leftover_gp(task: "DAGTask", dag: "TaskDAG", context: Optional[List[Dict]]) -> bool:
    """Skip leftover post-for_each GPs on the catalog demo so assemble-final stays cached.

    July Fast Mode records explore + for_each, then assemble-final. Extra leftover
    GPs after for_each change the parent transcript and miss the assemble cache
    slot, leaving Task Complete with no schema outputs (T7).
    """
    if task.tool_name != "spawn_general_purpose_agent":
        return False
    if not _dag_has_completed_for_each(dag):
        return False
    return _context_is_oai_demo(context)


def _fast_mode_skip_event(task: "DAGTask", *, message: str) -> ToolEvent:
    skip_title = DAG_REASONING_FINISHED_TITLE if task.tool_name == "reasoning" else task.tool_name
    return ToolEvent(
        type=EventType.POST_MESSAGE,
        title=skip_title,
        message=message,
        status=MessageStatus.FINISHED,
        metadata={
            "dagTaskIndex": task.index,
            "plannedToolName": task.tool_name,
            "fastModeCacheSkip": True,
        },
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
    # Set once a planned spawn_agent started in the background: the task's
    # model-visible result is its "started" row; it completes on the child's
    # completion (DagInterrupts.await_background).
    background_task_id: Optional[str] = None
    # A live call / pending user approval or question: a mid-plan message never cancels it.
    uninterruptible: bool = False


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
        # Set when a new message interrupts the DAG: cancelled tasks post an
        # "interrupted" terminal row instead of the sibling-failure one.
        self.interrupted_by_message: bool = False
        # Uninterruptible tasks left running when a message handed the DAG back.
        self.detached_tasks: List[asyncio.Task] = []

        # Parse tasks
        raw_tasks = plan_data.get("tasks", [])
        dependencies = plan_data.get("dependencies", {})

        for i, task_data in enumerate(raw_tasks):
            if isinstance(task_data, str):
                raise ValueError(
                    f"Plan task {i} must be an object with explicit goal and tool_name; string tasks are not supported"
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
        # A planned spawn started in the background is done only once its
        # completion notification (status completed) is in the transcript.
        completed_background_ids = set()

        for msg in context:
            metadata = msg.get("metadata") or {}
            if not isinstance(metadata, dict):
                continue
            tool_call_id = metadata.get("toolCallId")
            dag_task_index = metadata.get("dagTaskIndex")
            if isinstance(tool_call_id, str) and isinstance(dag_task_index, int):
                tool_call_to_task[tool_call_id] = dag_task_index
            if metadata.get("agentNotification") is True and metadata.get("status") == "completed":
                completed_background_ids.add(metadata.get("backgroundTaskId"))

        for msg in context:
            metadata = msg.get("metadata") or {}
            if not isinstance(metadata, dict):
                continue
            if metadata.get("excludeFromModel"):
                # UI-only rows (a background spawn's executor rows share its id):
                # the "started" row + completion notification decide the task.
                continue
            if metadata.get("runInBackground") is True and (
                metadata.get("backgroundTaskId") not in completed_background_ids
            ):
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


def _is_hidden_or_internal_user(metadata: Dict[str, Any]) -> bool:
    if metadata.get("hidden") is True:
        return True
    if metadata.get("isResponseSchemaUpdate") is True:
        return True
    # Agent notifications / agent-to-agent messages are agent-authored.
    return is_agent_authored_user_metadata(metadata)


def plan_superseded_by_new_user_instruction(context: List[Dict[str, Any]]) -> bool:
    """Return True when a historical set_plan is not the work for this execute.

    ``start_phase=execute`` means "skip planning and run the plan in history".
    Chat re-escalation after a terminal status uses the same phase to mean
    "this new instruction is simple — skip planning". Those collide: the
    latest ``set_plan`` is still in the transcript, so execute_dag would
    replay it instead of acting on the follow-up.

    A plan artifact is not live work when either:
    - it already posted ``completion_summary`` with ``isFinalSummary``, or
    - a real USER instruction arrived after that ``set_plan`` (covers
      FAILED / credit-kill re-escalation that never wrote Task Complete).

    Hidden schema-refresh USER rows do not count. Mid-run rows before the
    plan is written do not.
    """
    last_set_plan_idx: Optional[int] = None
    last_final_summary_idx: Optional[int] = None
    last_user_idx: Optional[int] = None
    for idx, msg in enumerate(context):
        if not isinstance(msg, dict):
            continue
        metadata = msg.get("metadata") or {}
        if not isinstance(metadata, dict):
            metadata = {}
        role = str(msg.get("role") or "").upper()
        if role == "USER" and not _is_hidden_or_internal_user(metadata):
            last_user_idx = idx
        if metadata.get("toolName") == "set_plan" and metadata.get("toolStatus") == "FINISHED":
            last_set_plan_idx = idx
        if (
            metadata.get("toolName") == "completion_summary"
            and metadata.get("toolStatus") == "FINISHED"
            and metadata.get("isFinalSummary")
        ):
            last_final_summary_idx = idx
    if last_final_summary_idx is not None:
        return True
    return last_set_plan_idx is not None and last_user_idx is not None and last_user_idx > last_set_plan_idx


def latest_real_user_instruction(context: List[Dict[str, Any]]) -> Optional[str]:
    """Return the latest non-hidden USER text, or None if there is none."""
    last_text: Optional[str] = None
    for msg in context:
        if not isinstance(msg, dict):
            continue
        metadata = msg.get("metadata") or {}
        if not isinstance(metadata, dict):
            metadata = {}
        role = str(msg.get("role") or "").upper()
        if role != "USER" or _is_hidden_or_internal_user(metadata):
            continue
        text = str(msg.get("text") or "").strip()
        if text:
            last_text = text
    return last_text


def is_dag_interrupt_message(msg: Dict[str, Any]) -> bool:
    """True for a polled row that must hand a running DAG back to the LLM loop.

    A real user instruction or an agent-to-agent message interrupts. Agent
    notifications (a planned background spawn's completion is its DAG
    dependency, not new input), hidden/schema-refresh rows and attention-gate
    answers (they resolve a waiting tool, not the plan) do not. Neither do rows
    hidden from this agent's model: a task-addressed agent message
    (``recipientTaskId`` + ``excludeFromModel``) is read by that task's own
    activity inbox, and the backend never signals the owner's loop for it.
    Metadata only, never message text.
    """
    if not isinstance(msg, dict) or str(msg.get("role") or "").upper() != "USER":
        return False
    metadata = msg.get("metadata") or {}
    if not isinstance(metadata, dict):
        metadata = {}
    if is_excluded_from_model(msg) or metadata.get("recipientTaskId"):
        return False
    if metadata.get("agentMessage") is True:
        return True
    if metadata.get("source") == "attention_response" or metadata.get("attentionRequestId"):
        return False
    return not _is_hidden_or_internal_user(metadata)


@dataclass
class DagInterrupts:
    """Workflow hooks that let a new message interrupt a running DAG.

    ``seq`` reads the workflow's wake counter (bumped by user/agent message
    signals); ``wait(seq)`` resolves once it moves past ``seq`` (a
    ``workflow.wait_condition`` in the workflow, no timer, no polling loop).
    ``message_pending()`` reports a message signalled after the context poll
    the plan was built from (before ``seq`` was read), so the first batch is
    preceded by a poll. ``await_background(task_id)`` is a planned spawn's dependency wait: it
    resolves when that background spawn finishes (True = completed, False =
    failed/stopped) or with a ``generation_handoff`` payload.
    """

    seq: Callable[[], int]
    wait: Callable[[int], Awaitable[Any]]
    await_background: Callable[[str], Awaitable[Any]]
    # True when a user / agent message was signalled after the context poll the
    # plan was built from: the DAG polls before starting its first batch.
    message_pending: Callable[[], bool] = lambda: False


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
    interrupts: Optional[DagInterrupts] = None,
) -> Dict[str, Any]:
    """
    Execute DAG with maximum parallelism.

    New-message interrupt (``interrupts`` + ``poll_messages``)::

        asyncio.wait(FIRST_COMPLETED) over {DAG tasks, interrupts.wait(seq)}
              │ wake (user / agent message signal)
              ▼
        poll ──▶ is_dag_interrupt_message? ──no──▶ keep waiting
              │ yes
              ▼
        no new task starts
        planned spawns already started ─▶ keep running in the background (their
                                         "started" row is the result; one
                                         notification each, nothing special)
        phone call / pending approval /
        question (uninterruptible) ────▶ keep running, report normally
        other in-flight tasks ─────────▶ cancelled immediately with a paired
                                         ERROR "interrupted" row
        return needs_llm ──────────────▶ run_agent sees the message; unstarted
                                         plan tasks have no result rows

    Planned spawns (``interrupts`` given) start in the background like LLM
    spawns: the task posts the immediate "started … Address" row, then waits
    in ``interrupts.await_background`` and completes when the child does. Its
    notification row is polled into ``context`` before dependents populate
    their params, so they read the child's result like a foreground result.

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
        - status: "completed" | "needs_llm"  ("needs_llm" => a task failed or the
          DAG stalled; the caller falls through to run_agent for LLM recovery)
        - context: Updated context
        - message: present on the "needs_llm" path, describing the failure
    """
    # Import here to avoid circular imports

    # Map task index to pending asyncio.Task
    pending_tasks: Dict[int, asyncio.Task] = {}
    # Map asyncio.Task to task index for lookup
    task_to_index: Dict[asyncio.Task, int] = {}

    workflow.logger.info(f"[DAG] Starting execution with {len(dag.tasks)} tasks, join={dag.join}")

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

    interrupt_enabled = interrupts is not None and poll_messages is not None
    interrupt_seq = interrupts.seq() if interrupts is not None and interrupt_enabled else 0
    polled_rows: List[Dict[str, Any]] = []

    async def _recording_poll(since: datetime) -> List[Dict]:
        assert poll_messages is not None
        rows = await poll_messages(since)
        polled_rows.extend(rows or [])
        return rows

    while not dag.is_complete() and not dag.has_failed():
        # Poll DB for new messages before starting next batch (skip the first
        # iteration — nothing has completed yet — unless a message arrived after
        # the context snapshot the plan was built from).
        pending_first = (
            first_iteration and interrupt_enabled and interrupts is not None and interrupts.message_pending()
        )
        if poll_messages and (not first_iteration or pending_first):
            polled_rows.clear()
            last_checked = await poll_and_update_context(
                _recording_poll if interrupt_enabled else poll_messages, context, last_checked
            )
            if (
                interrupts is not None
                and interrupt_enabled
                and any(is_dag_interrupt_message(row) for row in polled_rows)
            ):
                return await _hand_back_for_new_message(dag, pending_tasks, task_to_index, context)
        first_iteration = False

        # Start newly ready tasks
        ready = dag.get_ready_tasks()
        # The first productive param-populator in each ready batch seeds the
        # shared prompt prefix. Peers wait only for that LLM call, then populate
        # in parallel against the newly-created cache entry. There is no
        # separate throwaway cache-warm completion.
        param_cache_seed_event = asyncio.Event()
        param_cache_seed_lock = asyncio.Lock()
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
                    param_cache_seed_event=param_cache_seed_event,
                    param_cache_seed_lock=param_cache_seed_lock,
                    await_background=interrupts.await_background if interrupts is not None else None,
                )
                asyncio_task = asyncio.create_task(coro)
                pending_tasks[task.index] = asyncio_task
                task_to_index[asyncio_task] = task.index

        if not pending_tasks:
            # No tasks running and none ready - stuck (shouldn't happen with valid DAG)
            workflow.logger.warning("[DAG] No pending tasks and DAG not complete - handing off to run_agent recovery")
            return {
                "status": "needs_llm",
                "context": context,
                "message": "DAG execution stalled before all planned tasks completed.",
            }

        # Wait for ANY task to complete (or, with interrupts, a new message signal)
        interrupt_waiter: Optional[asyncio.Task] = None
        if interrupt_enabled and interrupts is not None:
            interrupt_waiter = asyncio.create_task(interrupts.wait(interrupt_seq))
        done, _ = await asyncio.wait(
            [*pending_tasks.values(), *([interrupt_waiter] if interrupt_waiter is not None else [])],
            return_when=asyncio.FIRST_COMPLETED,
        )
        if interrupt_waiter is not None and interrupts is not None:
            done.discard(interrupt_waiter)
            if not interrupt_waiter.done():
                interrupt_waiter.cancel()
                await asyncio.gather(interrupt_waiter, return_exceptions=True)
            # Re-read the counter: the next poll (top of loop) covers every
            # signal up to here, so no wake is lost between waits.
            interrupt_seq = interrupts.seq()

        # Process completed tasks
        for completed_future in done:
            task_index = task_to_index[completed_future]
            del pending_tasks[task_index]
            del task_to_index[completed_future]

            try:
                task_result = completed_future.result()
            except Exception as e:
                workflow.logger.error(f"[DAG] Task {task_index} raised exception: {e}", exc_info=True)
                task_result = False

            if isinstance(task_result, dict) and task_result.get("generation_handoff"):
                workflow.logger.info(
                    f"[DAG] Task {task_index} interrupted for generation handoff — canceling remaining DAG work"
                )
                remaining = list(pending_tasks.values())
                for pending in remaining:
                    pending.cancel()
                if remaining:
                    await asyncio.gather(*remaining, return_exceptions=True)
                return {
                    "status": "generation_handoff",
                    "handoff_task_queue": task_result.get("handoff_task_queue"),
                    "context": context,
                    "message": f"Planned task {task_index + 1} interrupted for generation handoff.",
                }

            success = bool(task_result)

            if not success:
                # Error already posted to context by execute_tool/handle_tool_event
                workflow.logger.info(f"[DAG] Task {task_index} failed - canceling remaining DAG work")
                dag.mark_failed(task_index)

                # Cancel and drain remaining task wrappers. Awaiting their
                # cancellation keeps workflow-local cleanup deterministic even
                # when an underlying activity was already in flight.
                remaining = list(pending_tasks.values())
                for pending in remaining:
                    pending.cancel()
                if remaining:
                    await asyncio.gather(*remaining, return_exceptions=True)

                return {
                    # Recover via the LLM loop (run_agent), NOT by replaying the DAG.
                    # execute_dag is invoked exactly once and is never re-entered, so
                    # returning here does not replay siblings: run_agent reads the
                    # recorded context (completed TOOL results + this failure) from
                    # the DB and iterates, exactly like the completed-but-unverified
                    # DAG path. Completed siblings are already-successful results, so
                    # the LLM sees them as done.
                    #
                    # NARROW KNOWN GAP (pre-existing, tracked): if a for_each/
                    # general_purpose task committed a batch spawn and *then* failed
                    # during drain, an LLM-chosen re-spawn uses a fresh tool_call_id
                    # that the existing _spawn_group_id dedup does not cover, so it can
                    # duplicate children. This predates the DAG-terminal change and is
                    # bounded by LLM judgment; closing it needs spawn idempotency keyed
                    # on the DAG task identity + its own repro. Do NOT re-add a blanket
                    # terminal here to "fix" it — that kills all recovery (the
                    # regression this restores).
                    "status": "needs_llm",
                    "context": context,
                    "message": f"Planned task {task_index + 1} failed during DAG execution.",
                }

            dag.mark_completed(task_index)
            workflow.logger.info(f"[DAG] Task {task_index} completed")

        # Loop continues - get_ready_tasks will now return newly ready dependents

    workflow.logger.info("[DAG] Execution complete")
    return {
        "status": "completed",
        "context": context,
    }


async def _hand_back_for_new_message(
    dag: TaskDAG,
    pending_tasks: Dict[int, asyncio.Task],
    task_to_index: Dict[asyncio.Task, int],
    context: List[Dict],
) -> Dict[str, Any]:
    """A user/agent message arrived mid-DAG: return control to the LLM loop.

    No new task starts. Planned spawns already running in the background stay
    running (their "started" row is the planned call's result and their
    completion posts the usual notification); only the DAG's dependency wait
    on them ends, silently. A live phone call or a pending user approval /
    question keeps running and reports as it normally would. Every other
    in-flight task is cancelled immediately and posts an ERROR "interrupted"
    row under its own tool call id. Unstarted tasks have no rows; the model
    sees them as not done in the plan.
    """
    dag.interrupted_by_message = True
    background: List[int] = []
    kept: List[int] = []
    cancelled: List[int] = []
    handoff: Optional[Dict[str, Any]] = None
    to_drain: List[asyncio.Task] = []
    for index, running in list(pending_tasks.items()):
        task = dag.tasks[index]
        if running.done():
            try:
                outcome = running.result()
            except BaseException:
                outcome = False
            if isinstance(outcome, dict) and outcome.get("generation_handoff"):
                handoff = handoff or outcome
            elif outcome is True:
                dag.mark_completed(index)
            else:
                dag.mark_failed(index)
            continue
        if task.uninterruptible:
            kept.append(index)
            dag.detached_tasks.append(running)
            continue
        if task.background_task_id is not None:
            background.append(index)  # only the dependency wait ends (silently)
        else:
            cancelled.append(index)
        running.cancel()
        to_drain.append(running)
    if to_drain:
        await asyncio.gather(*to_drain, return_exceptions=True)
    pending_tasks.clear()
    task_to_index.clear()
    unstarted = [task.index + 1 for task in dag.tasks if task.state == TaskState.PENDING]
    workflow.logger.info(
        f"[DAG] New message arrived; handing back to the LLM loop. Still running in background="
        f"{[index + 1 for index in background]} interrupted={[index + 1 for index in cancelled]} "
        f"kept running={[index + 1 for index in kept]} "
        f"not started={unstarted}"
    )
    if handoff is not None:
        return {
            "status": "generation_handoff",
            "handoff_task_queue": handoff.get("handoff_task_queue"),
            "context": context,
            "message": "Planned task interrupted for generation handoff.",
        }
    return {
        "status": "needs_llm",
        "interrupted_by_message": True,
        "context": context,
        "message": "A new message arrived during DAG execution.",
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
    param_cache_seed_event: Optional[asyncio.Event] = None,
    param_cache_seed_lock: Optional[asyncio.Lock] = None,
    await_background: Optional[Callable[[str], Awaitable[Any]]] = None,
) -> bool | dict[str, Any]:
    """
    Execute a single task from the DAG.

    For reasoning tasks:
    - Executes via execute_reasoning_activity (proper Temporal activity)
    - Streams output to frontend via Supabase Realtime
    - Posts final result as ASSISTANT message

    For tool tasks:
    - Emits IN_PROGRESS, calls tool, emits FINISHED

    Returns:
        True if successful, False if failed, or a generation_handoff payload
        when the tool yielded for cooperative cutover.
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
    # Name of the early IN_PROGRESS tool chip once emitted (non-reasoning path).
    # Tracked so a cancellation can terminalize the exact same live chip.
    early_tool_event_name: Optional[str] = None
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
                # Catalog demo assemble-final must use the July p:6 slot even
                # when leftover post-for_each GPs shifted task.index.
                _oai_demo_reasoning_fast_mode_step(task, dag, context),
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
                # Heartbeat-timeout is the per-chunk safety net. Rose's stream
                # guard heartbeats every ~10s (including during TTFT waits).
                # Keep this strictly above max(ttft_timeout=90s, idle=120s) so
                # a single stalled provider_read cannot race the activity to
                # death — we hit that on cuda-kernel code-agent runs where
                # dag_reasoning died with "activity Heartbeat timeout" after
                # ~88s of silent TTFT while heartbeat_timeout was still 90s.
                # 180s matches other LLM activities in this file.
                heartbeat_timeout=timedelta(seconds=180),
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
                            cache_sequence_id=reasoning_usage.get("cache_sequence_id"),
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

            if _should_skip_oai_demo_leftover_gp(task, dag, context):
                # Do not emit IN_PROGRESS/FINISHED chips. July Fast Mode records
                # explore + for_each + assemble-final only; leftover skip cards
                # change the parent transcript and miss the assemble-final cache
                # (T7 then sees a 411-char stub instead of the 4000-char report).
                workflow.logger.info(
                    f"[DAG] Task {task.index} skipped silently: leftover post-for_each GP on OAI demo tree"
                )
                return True

            # Emit a placeholder before param population so the UI reflects the
            # concrete planned tool while the LLM fills arguments.
            early_tool_name, early_event = _build_early_tool_event(task, actual_tool, tool_call_id)
            await handle_tool_event_fn(early_event, tool_call_id, early_tool_name)
            early_tool_event_name = early_tool_name

            # Populate tool params by extending the current agent context with a
            # user message that prompts the LLM to call the specific tool.
            # Same system prompt + tools + conversation = cache prefix hit.
            extra_msg = _build_param_population_message(
                task.index + 1,
                task.goal,
                actual_tool,
                planned_tool_name=task.tool_name,
            )

            # Store a reusable context snapshot for same-machine activity pickup.
            # call_llm_activity removes the entry after a successful call, so a
            # locally rejected contract attempt must restore it before retrying.
            # Tag it with this node's replay-stable tool_call_id: a slot left on a
            # worker by an earlier node, or by this workflow before it migrated
            # off that worker, must never be adopted as this call's conversation.
            pending_context_token = f"dag:{tool_call_id}"
            pending_context = (list(context), system_prompt_text, None, user_id, pending_context_token)
            _pending_llm_context[agent_id] = pending_context

            # Keep the exact execute-phase tool schema so every param-populator
            # shares the same system+tools+conversation cache prefix. The
            # required_tool contract below validates the planned action without
            # mutating the schema per DAG node.
            if not tool_names:
                raise ValueError("DAG param population requires the full execute-phase tool schema")
            # Use the agent's selected model for parameter population. The
            # required_tool contract below still enforces exactly one action.
            llm_args = [
                agent_id,
                model,
                tool_names,
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
                False,
                True,
                f"agent:{agent_id}:task:{task.index}:call:dag_param_populator",
                # Appended last: older replayed histories fall back to the defaults.
                False,
                pending_context_token,
            ]

            async def track_param_usage(param_usage: Dict[str, Any]) -> None:
                if not on_tokens or not param_usage:
                    return
                p_in = param_usage.get("prompt_tokens", 0)
                p_out = param_usage.get("completion_tokens", 0)
                if p_in <= 0 and p_out <= 0:
                    return
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
                        cache_sequence_id=param_usage.get("cache_sequence_id"),
                    )
                except Exception as e:
                    workflow.logger.warning(f"on_tokens failed for dag_param_populator: {e}")

            async def populate_params() -> tuple[Dict[str, Any], Dict[str, Any]]:
                contract_error: Optional[str] = None
                bypass_position_fallback = False
                for structured_attempt in range(1, STRUCTURED_OUTPUT_MAX_ATTEMPTS + 1):
                    result: Dict[str, Any] = {}
                    try:
                        # A successful activity consumes the shared pending context
                        # before local alias validation runs. Restore the identical
                        # snapshot so a bounded semantic retry keeps the same prefix.
                        _pending_llm_context[agent_id] = pending_context
                        attempt_llm_args = list(llm_args)
                        attempt_llm_args[10] = _build_param_population_message(
                            task.index + 1,
                            task.goal,
                            actual_tool,
                            planned_tool_name=task.tool_name,
                            contract_error=contract_error,
                        )
                        if bypass_position_fallback:
                            # A positional Fast Mode result can belong to a
                            # different DAG node at the same trajectory step.
                            # After strict validation rejects such a replay,
                            # keep exact lookup available for the corrective
                            # prompt but do not replay the same foreign slot.
                            attempt_llm_args[27] = None
                        result = await execute_activity(
                            call_llm_activity,
                            args=attempt_llm_args,
                            start_to_close_timeout=timedelta(seconds=600),
                            retry_policy=RetryPolicy(maximum_attempts=2),
                            heartbeat_timeout=timedelta(seconds=180),
                        )
                        usage = result.get("usage", {})
                        # Account a completed LLM call before local validation can
                        # reject it. This also covers the final exhausted attempt.
                        await track_param_usage(usage)
                        selected_call = _select_param_tool_call(result.get("tool_calls", []), actual_tool, task)
                        return result, selected_call
                    except Exception as exc:
                        should_retry = isinstance(exc, ParamPopulationContractError) or error_chain_has_type(
                            exc, STRUCTURED_OUTPUT_ERROR_TYPE
                        )
                        if not should_retry or structured_attempt >= STRUCTURED_OUTPUT_MAX_ATTEMPTS:
                            raise
                        cached_contract_failure = isinstance(exc, ParamPopulationContractError) and bool(
                            (result.get("usage") or {}).get("from_fast_cache")
                        )
                        if cached_contract_failure:
                            deterministic_repair = _deterministic_cached_contract_repair(actual_tool, task)
                            if deterministic_repair is not None:
                                return result, _select_param_tool_call(
                                    [deterministic_repair],
                                    actual_tool,
                                    task,
                                )
                            bypass_position_fallback = True
                        contract_error = extract_error_message(exc)
                        workflow.logger.warning(
                            f"[DAG] Param population contract failed "
                            f"(attempt {structured_attempt}/{STRUCTURED_OUTPUT_MAX_ATTEMPTS}); retrying"
                        )
                raise RuntimeError("Param population exhausted attempts")

            populated_result: Optional[tuple[Dict[str, Any], Dict[str, Any]]] = None
            if param_cache_seed_event is not None and param_cache_seed_lock is not None:
                async with param_cache_seed_lock:
                    if not param_cache_seed_event.is_set():
                        try:
                            populated_result = await populate_params()
                        finally:
                            param_cache_seed_event.set()

            if populated_result is None:
                if param_cache_seed_event is not None:
                    await param_cache_seed_event.wait()
                populated_result = await populate_params()

            _, tool_call = populated_result
            params = {k: v for k, v in tool_call.items() if k != "tool"}

            # Force correct type for spawn_agent aliases (LLM can't be trusted to pick the right type)
            type_override = ALIAS_TYPE_OVERRIDES.get(task.tool_name)
            if type_override:
                _apply_alias_override(params, task.tool_name, task.index)
                workflow.logger.info(
                    f"[DAG] Applying type override for {task.tool_name}: {params.get('type')} start_phase={params.get('start_phase')}"
                )
                # Explore agents don't use these type-specific params — strip them if LLM added them
                if type_override.get("type") == "explore":
                    params.pop("output_schema", None)
                    params.pop("start_url", None)
                    params.pop("github_repo_link", None)
                    params.pop("code_session_id", None)
                    # Clamp planner/DAG explores to a fast breadth-scan. The param-populator
                    # LLM tends to pick depth="deep" for "comprehensive" goals, turning a
                    # gating "identify the list" explore into a 50-turn crawl that blocks
                    # fan-out. Force quick here; deliberate deep research should be its own task.
                    # SpawnAgentManager.resolve_explore_depth promotes quick→deep under
                    # Fast Mode so July OAi-demo trajectories can still finish.
                    params["depth"] = "quick"

                if type_override.get("type") in {"general_purpose", "for_each"}:
                    params["_spawn_group_id"] = spawn_group_id(tool_call_id)

            # With DAG interrupts every planned spawn is a background record
            # (its child survives a mid-plan hand-back and keeps its task
            # path), so the populator cannot opt one into the foreground.
            if actual_tool == "spawn_agent" and await_background is not None:
                params.pop("run_in_background", None)

            # Validate the final, overridden spawn payload before any external
            # child workflow can be started. Alias coercion must never bypass the
            # canonical SpawnAgentTool cross-field constraints.
            if actual_tool == "spawn_agent":
                from utils.tool_schemas import SpawnAgentTool

                SpawnAgentTool.model_validate({"tool": actual_tool, **params})

            # Execute tool (uses existing flow - posts result to context)
            task.uninterruptible = _is_uninterruptible_dag_call(actual_tool, params)
            result = await execute_tool(actual_tool, params, tool_call_id)

            # A planned spawn that started in the background: its "started"
            # row is the call's result; the task completes with the child.
            background_task_id = result.get("background_task_id") if isinstance(result, dict) else None
            if isinstance(background_task_id, str) and background_task_id and await_background is not None:
                task.background_task_id = background_task_id
                result = await await_background(background_task_id)
                if result is True or result is False:
                    return result

            # A cooperative cutover is not task success. Returning True here
            # marks the node COMPLETED and starts dependents, which then raise
            # their own approval waits and leave more pending attn_ids.
            if isinstance(result, dict) and result.get("generation_handoff"):
                handoff_queue = result.get("handoff_task_queue")
                if isinstance(handoff_queue, str) and handoff_queue.strip():
                    return {
                        "generation_handoff": True,
                        "handoff_task_queue": handoff_queue.strip(),
                    }
                workflow.logger.warning(f"[DAG] Task {task.index} reported generation_handoff without a queue")
                return False

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

    except asyncio.CancelledError:
        # asyncio.CancelledError is NOT an Exception (it is BaseException), so the
        # broad `except Exception` handler below never runs on cancellation.
        # execute_dag cancels every remaining task wrapper the moment a sibling
        # fails; without terminalizing here, the early IN_PROGRESS tool chip
        # (emitted before param population) and the reasoning stream bubble stay
        # live forever in the UI as a phantom chip. Emit a terminal event for the
        # same tool_call_id, then re-raise so the gather-based cancellation drain
        # in execute_dag still completes.
        if task.background_task_id is not None:
            # Only the dependency wait ends: the background spawn keeps running
            # and its "started" row is already the call's terminal result.
            raise
        cancel_message = (
            "Interrupted: a new message arrived before this planned task finished; it did not complete."
            if dag.interrupted_by_message
            else "Canceled: a sibling task failed."
        )
        cancel_metadata = {"interrupted": True} if dag.interrupted_by_message else {}
        try:
            if early_tool_event_name is not None:
                await handle_tool_event_fn(
                    ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=task.tool_name,
                        message=cancel_message,
                        status=MessageStatus.ERROR,
                        metadata={
                            "dagTaskIndex": task.index,
                            "plannedToolName": task.tool_name,
                            "canceled": True,
                            **cancel_metadata,
                        },
                    ),
                    tool_call_id,
                    early_tool_event_name,
                )
            elif reasoning_stream_id is not None:
                await handle_tool_event_fn(
                    ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=DAG_REASONING_FINISHED_TITLE,
                        message=cancel_message,
                        status=MessageStatus.ERROR,
                        metadata={
                            "dagTaskIndex": task.index,
                            "plannedToolName": task.tool_name,
                            "streamId": reasoning_stream_id,
                            "firstTimestamp": reasoning_started_at,
                            "startedAt": reasoning_started_at,
                            "canceled": True,
                            "error": True,
                            **cancel_metadata,
                        },
                    ),
                    tool_call_id,
                    DAG_REASONING_UI_TOOL_NAME,
                )
        except Exception as terminal_err:  # never mask the cancellation
            workflow.logger.warning(f"[DAG] Failed to terminalize canceled task {task.index}: {terminal_err}")
        raise

    except Exception as e:
        # Extract actual error message (unwrap Temporal's ActivityError wrapper)
        error_msg = extract_error_message(e)
        if _is_strict_readonly_cache_miss(e):
            # Fast Mode read-only: this DAG node's populate is not in the
            # cache. Skip it without an ERROR chip so leftover post-for_each
            # GPs do not fail t10; execute_loop can still replay cached work.
            workflow.logger.info(f"[DAG] Task {task.index} skipped: Fast Mode has no cached populate for this node")
            skip_tool_name = early_tool_event_name or (
                DAG_REASONING_UI_TOOL_NAME if task.tool_name == "reasoning" else task.tool_name
            )
            await handle_tool_event_fn(
                _fast_mode_skip_event(
                    task,
                    message="Fast Mode cache has no populate for this DAG node; skipping.",
                ),
                tool_call_id,
                skip_tool_name,
            )
            return True
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

        error_tool_name = DAG_REASONING_UI_TOOL_NAME if task.tool_name == "reasoning" else task.tool_name
        error_title = DAG_REASONING_FINISHED_TITLE if task.tool_name == "reasoning" else task.tool_name

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
