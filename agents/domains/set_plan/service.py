"""set-plan domain service -- business logic orchestration.

Validation, conversion, plan-building, and planner activity scheduling.
No framework types (request/response). Typed args in, typed results out.
"""

from __future__ import annotations

from collections import deque
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.set_plan.config import (
    DEFAULT_GOAL,
    MAX_RETRIES,  # noqa: F401 — re-exported for handler layer
    PLANNER_ACTIVITY_MAX_ATTEMPTS,
    PLANNER_ACTIVITY_TIMEOUT_SECONDS,
    PLANNER_MODEL,
)
from domains.set_plan.types import PlanData, TaskObject
from helpers.attachments import FilePointer
from tools.prompts import TOOL_PROMPTS
from utils.tool_schemas import EXECUTE_PHASE_TOOLS, TOOL_MODELS

PLANNER_CONTEXT_FULL_TEXT_LIMIT = 6000
PLANNER_CONTEXT_HEAD_CHARS = 3000
PLANNER_CONTEXT_TAIL_CHARS = 1500


def _strip_reference_annotation(text: str, message_id: str | None) -> str:
    if not message_id:
        return text
    ref_suffix = f"\n\nReference: @ref:message:{message_id}"
    if text.endswith(ref_suffix):
        return text[: -len(ref_suffix)]
    return text


def _compact_planner_context_text(text: str) -> str:
    """Keep planner context bounded while preserving both ends of long outputs."""
    if len(text) <= PLANNER_CONTEXT_FULL_TEXT_LIMIT:
        return text

    omitted = len(text) - PLANNER_CONTEXT_HEAD_CHARS - PLANNER_CONTEXT_TAIL_CHARS
    if omitted <= 0:
        return text

    return (
        text[:PLANNER_CONTEXT_HEAD_CHARS]
        + f"\n\n[Planner context shortened: {omitted} chars omitted from middle of {len(text)} total chars.]\n\n"
        + text[-PLANNER_CONTEXT_TAIL_CHARS:]
    )

PLANNER_MESSAGE_CHAR_LIMITS = {
    "USER": 16_000,
    "ASSISTANT": 12_000,
    "TOOL": 3_000,
    "SYSTEM": 3_000,
}
PLANNER_CONTEXT_CHAR_BUDGET = 200_000


def _validate_dep_indices(deps: dict[str, list[str]], n: int) -> str | None:
    """Validate task indices and predecessor references in the dependency graph."""
    for task_idx, predecessors in deps.items():
        if not task_idx.isdigit():
            return f"Invalid task index '{task_idx}'. Must be a numeric string (e.g., '0', '1', '2')."

        idx = int(task_idx)
        if idx < 0 or idx >= n:
            return f"Task index '{task_idx}' out of range. Valid indices: 0 to {n - 1}."

        if not isinstance(predecessors, list):
            return f"Dependencies for task '{task_idx}' must be a list, got {type(predecessors).__name__}."

        for pred in predecessors:
            if not isinstance(pred, str) or not pred.isdigit():
                return f"Task {task_idx} has invalid predecessor '{pred}'. Must be a numeric string."
            pred_idx = int(pred)
            if pred_idx < 0 or pred_idx >= n:
                return f"Task {task_idx} depends on non-existent task '{pred}'. Valid indices: 0 to {n - 1}."
            if pred_idx == idx:
                return f"Task {task_idx} cannot depend on itself."

    return None


def _detect_cycle(deps: dict[str, list[str]], n: int) -> str | None:
    """Detect cycles using Kahn's algorithm. Returns error message or None."""
    in_degree = [0] * n
    adj: dict[int, list[int]] = {i: [] for i in range(n)}

    for task_idx, predecessors in deps.items():
        idx = int(task_idx)
        for pred in predecessors:
            pred_idx = int(pred)
            adj[pred_idx].append(idx)
            in_degree[idx] += 1

    queue = deque([i for i in range(n) if in_degree[i] == 0])
    processed = 0

    while queue:
        node = queue.popleft()
        processed += 1
        for neighbor in adj[node]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    if processed != n:
        cycle_nodes = [str(i) for i in range(n) if in_degree[i] > 0]
        return (
            f"Dependency cycle detected involving tasks: {', '.join(cycle_nodes)}."
            " Ensure no task transitively depends on itself."
        )
    return None


def validate_dependencies(tasks: list[str], deps: dict[str, list[str]]) -> str | None:
    """Validate the dependency graph.

    Returns error message if invalid, None if valid.
    """
    if not deps:
        return None  # Empty deps is valid (all parallel)

    n = len(tasks)
    index_error = _validate_dep_indices(deps, n)
    if index_error:
        return index_error

    return _detect_cycle(deps, n)


def convert_dependencies_list_to_dict(deps_list: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Convert dependencies_graph from list format to dict format.

    Input:  [{"task_idx": "0", "depends_on": ["1", "2"]}, ...]
    Output: {"0": ["1", "2"], ...}
    """
    if not deps_list:
        return {}
    return {entry.get("task_idx", ""): entry.get("depends_on", []) for entry in deps_list if entry.get("task_idx")}


def get_planner_tools_description() -> str:
    """Get execute-tool descriptions for the planner.

    Single source of truth: execute-phase tools and their prompt fragments.
    Planner-only spawn aliases are documented in the planner prompt itself.
    """
    sections = []
    for name in EXECUTE_PHASE_TOOLS:
        if name in TOOL_PROMPTS:
            description = TOOL_PROMPTS[name].strip()
        elif name in TOOL_MODELS:
            model = TOOL_MODELS[name]
            description = (model.__doc__ or "").strip() or "No description"
        else:
            continue
        sections.append(f"### {name}\n{description}")
    return "\n\n".join(sections) if sections else "Standard execution tools available."


def validate_planner_result(planner_result: dict[str, Any]) -> str | None:
    """Validate the planner result. Returns error message if invalid, None if valid."""
    task_objects = planner_result.get("tasks", [])
    tasks = [t.get("goal", "") for t in task_objects]
    deps_list = planner_result.get("dependencies_graph", [])
    dependencies = convert_dependencies_list_to_dict(deps_list)
    join = planner_result.get("join", "all")

    if not tasks:
        return "No tasks returned. The plan must have at least one task."

    if join not in ("all", "any"):
        return f"Invalid join value '{join}'. Must be 'all' or 'any'."

    deps = dependencies or {}
    dep_error = validate_dependencies(tasks, deps)
    if dep_error:
        return dep_error

    # Verify tasks[i].depends_on matches dependencies_graph
    for i, task_obj in enumerate(task_objects):
        task_idx = task_obj.get("task_idx")
        if not isinstance(task_idx, str) or not task_idx.isdigit():
            return f"Task {i} has invalid task_idx={task_idx!r}. It must be the 0-based array index as a string."
        if task_idx != str(i):
            return f"Task {i} has task_idx={task_idx!r}. It must equal its 0-based array position '{i}'."

        task_deps = task_obj.get("depends_on", [])
        graph_deps = deps.get(str(i), [])
        task_deps_str = sorted([str(d) for d in task_deps])
        graph_deps_str = sorted(graph_deps)
        if task_deps_str != graph_deps_str:
            return (
                f"Task {i} has depends_on={task_deps} but dependencies_graph['{i}']={graph_deps}."
                " They must match exactly."
            )

    return None  # Valid


def build_plan_data(planner_result: dict[str, Any]) -> PlanData:
    """Extract validated planner result into a PlanData structure.

    Assumes planner_result has already passed validation.
    """
    task_objects = planner_result["tasks"]
    tasks: list[TaskObject] = [TaskObject(goal=t["goal"], tool_name=t["tool_name"]) for t in task_objects]
    deps = convert_dependencies_list_to_dict(planner_result.get("dependencies_graph", []))
    title: str = planner_result["title"]
    content: str = planner_result["content"]
    join: str = planner_result["join"]

    return PlanData(
        type="plan_artifact",
        title=title,
        content=content,
        tasks=tasks,
        dependencies=deps,
        join=join,
        status="planning",
    )


def build_plan_message(plan_data: PlanData) -> str:
    """Build descriptive message based on plan structure."""
    title = plan_data["title"]
    tasks = plan_data["tasks"]
    n_tasks = len(tasks)
    deps = plan_data["dependencies"]
    join = plan_data["join"]

    task_lines = ["Tasks:"]
    for idx, task in enumerate(tasks, start=1):
        tool_name = task.get("tool_name") or "unknown"
        goal = task.get("goal") or "(no goal)"
        task_lines.append(f"{idx}. {goal} [{tool_name}]")

    dependency_lines = ["Dependency Graph:"]
    if deps:
        for task_idx in sorted(deps.keys(), key=lambda value: (0, int(value)) if value.isdigit() else (1, value)):
            predecessors = deps.get(task_idx) or []
            display_idx = int(task_idx) + 1 if task_idx.isdigit() else task_idx
            if predecessors:
                display_predecessors = [
                    str(int(pred) + 1) if isinstance(pred, str) and pred.isdigit() else str(pred)
                    for pred in predecessors
                ]
                dependency_lines.append(f"- Task {display_idx} depends on: {', '.join(display_predecessors)}")
            else:
                dependency_lines.append(f"- Task {display_idx} has no dependencies.")
    else:
        dependency_lines.append("- No dependencies; all tasks can run in parallel.")

    details = "\n\n".join(["\n".join(task_lines), "\n".join(dependency_lines), f"Join: {join}"])

    if join == "any":
        summary = f"{n_tasks} hypotheses to evaluate (any one may satisfy)."
        return f"**{title}**\n\n{summary}\n\n{details}"

    if not deps:
        summary = f"{n_tasks} tasks (parallel execution)."
        return f"**{title}**\n\n{summary}\n\n{details}"

    # Determine if fully sequential or DAG
    is_sequential = all(deps.get(str(i)) == [str(i - 1)] for i in range(1, n_tasks)) and "0" not in deps

    if is_sequential:
        summary = f"{n_tasks} tasks (sequential execution)."
        return f"**{title}**\n\n{summary}\n\n{details}"
    summary = f"{n_tasks} tasks (staged execution with dependencies)."
    return f"**{title}**\n\n{summary}\n\n{details}"


# ========================================
# PLANNER ORCHESTRATION
# ========================================


def _compact_planner_text(role: str, text: str) -> str:
    """Bound individual messages before they enter the planner prompt."""
    limit = PLANNER_MESSAGE_CHAR_LIMITS.get(role, 6_000)
    if len(text) <= limit:
        return text

    head_len = max(1, int(limit * 0.75))
    tail_len = max(1, limit - head_len)
    omitted = len(text) - head_len - tail_len
    return (
        f"{text[:head_len]}\n\n"
        f"[... planner context compacted {omitted} chars ...]\n\n"
        f"{text[-tail_len:]}"
    )


def _enforce_planner_context_budget(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep planner context under a hard char budget, preserving goal + recency."""
    if sum(len(m.get("content", "")) for m in messages) <= PLANNER_CONTEXT_CHAR_BUDGET:
        return messages
    if not messages:
        return messages

    goal = messages[0]
    budget = max(0, PLANNER_CONTEXT_CHAR_BUDGET - len(goal.get("content", "")))
    kept_reversed: list[dict[str, Any]] = []
    used = 0

    for msg in reversed(messages[1:]):
        content_len = len(msg.get("content", ""))
        if used + content_len > budget:
            continue
        kept_reversed.append(msg)
        used += content_len

    kept_reversed.reverse()
    dropped = len(messages) - 1 - len(kept_reversed)
    if dropped <= 0:
        return [goal] + kept_reversed

    notice = {
        "role": "user",
        "content": f"[SYSTEM]: Planner context compacted: omitted {dropped} older message(s) to stay under budget.",
    }
    return [goal, notice] + kept_reversed


def build_planner_messages(context: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Extract conversation context and user messages for the planner.

    Args:
        context: The workflow context (list of message dicts).

    Returns:
        Tuple of (base_messages for planner, user_messages list).
    """
    user_messages: list[str] = []
    base_messages: list[dict[str, Any]] = []

    for msg in context:
        role = msg.get("role", "").upper()
        text = msg.get("text", "")
        message_id = msg.get("message_id")
        text = _strip_reference_annotation(text, message_id if isinstance(message_id, str) else None)

        if role == "USER" and text:
            user_messages.append(text)

        # Include file metadata only (not full content)
        file_pointer_data = msg.get("file_pointer") or msg.get("filePointer")
        if file_pointer_data and isinstance(file_pointer_data, dict):
            try:
                fp = FilePointer.from_dict(file_pointer_data)
                filename = fp.original_filename or "unknown"
                mime = fp.mime_type or "unknown type"
                file_label = f"[File attached: {filename} ({mime})]"
                text = f"{text}\n\n{file_label}" if text else file_label
            except Exception:
                pass  # Fall through to normal text handling

        if not text:
            continue
        if role == "USER":
            base_messages.append({"role": "user", "content": _compact_planner_text(role, text)})
        elif role == "ASSISTANT":
            base_messages.append({"role": "assistant", "content": _compact_planner_text(role, text)})
        elif role in ("TOOL", "SYSTEM"):
            text = _compact_planner_context_text(text)
            base_messages.append({"role": "user", "content": f"[{role}]: {text}"})

    # Prepend goal message
    goal = user_messages[0] if user_messages else DEFAULT_GOAL
    base_messages.insert(0, {"role": "user", "content": f"GOAL: {goal}\n\nPlan this goal into tasks."})

    return _enforce_planner_context_budget(base_messages), user_messages


async def run_planner_attempt(
    *,
    workflow_instance: Any,
    messages: list[dict[str, Any]],
    tools_description: str,
    user_context: str,
    response_schema: dict[str, Any] | None,
    claude_max_token: str | None,
    gpt_token: str | None,
    gpt_account_id: str | None,
    gpt_token_source: str | None,
    gpt_token_pool_id: str | None,
    user_messages: list[str],
    tool_call_id: str,
    attempt: int,
) -> dict[str, Any]:
    """Run a single planner attempt, optionally with parallel schema generation.

    Returns the planner result dict.
    """
    from helpers.llm import call_planner_llm_activity

    agent_id = workflow_instance.agent_id
    planner_args = [
        messages,
        PLANNER_MODEL,
        tools_description,
        user_context,
        response_schema,
        claude_max_token,
        agent_id,
        tool_call_id,
        getattr(workflow_instance, "claude_max_token_source", None),
        getattr(workflow_instance, "claude_max_token_pool_id", None),
        getattr(workflow_instance, "user_id", None),
        gpt_token,
        gpt_account_id,
        gpt_token_source,
        gpt_token_pool_id,
        getattr(workflow_instance, "user_id", None),
    ]

    # Schema generation is now done synchronously at workflow startup so the
    # prompt cache prefix is stable from the very first LLM call. The planner
    # only runs the planner LLM here.
    workflow.logger.info(
        f"[TIMING] Starting planner LLM (attempt {attempt + 1}, schema_exists={response_schema is not None})"
    )
    planner_only_start = workflow.now()
    planner_result_raw = await workflow.execute_activity(
        call_planner_llm_activity,
        args=planner_args,
        start_to_close_timeout=timedelta(seconds=PLANNER_ACTIVITY_TIMEOUT_SECONDS),
        retry_policy=RetryPolicy(maximum_attempts=PLANNER_ACTIVITY_MAX_ATTEMPTS),
    )
    planner_only_elapsed = (workflow.now() - planner_only_start).total_seconds()
    workflow.logger.info(f"[TIMING] Planner LLM completed: {planner_only_elapsed * 1000:.1f}ms")

    await workflow_instance._track_usage(planner_result_raw.get("usage"), tool_name="set_plan", call_site="planner")
    planner_result = planner_result_raw.get("result", planner_result_raw)

    return planner_result
