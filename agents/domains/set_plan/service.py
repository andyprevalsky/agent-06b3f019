"""set-plan domain service -- business logic orchestration.

Validation, conversion, plan-building, and planner activity scheduling.
No framework types (request/response). Typed args in, typed results out.
"""

from __future__ import annotations

import json
from collections import deque
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.set_plan.config import (
    DEFAULT_GOAL,
    PLANNER_ACTIVITY_HEARTBEAT_TIMEOUT_SECONDS,
    PLANNER_ACTIVITY_MAX_ATTEMPTS,
    PLANNER_ACTIVITY_TIMEOUT_SECONDS,
)
from domains.set_plan.types import PlanData, TaskObject
from helpers.attachments import FilePointer
from helpers.background_agents import model_agent_row_text
from helpers.context_compaction import is_excluded_from_model
from helpers.context_scope import is_internal_subagent_message
from providers.rose.inter_agent_context import inter_agent_message, settle_trailing_inter_agent_messages
from providers.rose.pools import PLANNER_MODEL
from tools.prompts import tool_prompts_for
from utils.simulated_clock import world_time_cursor_ms
from utils.tool_schemas import PLAN_PHASE_TOOLS, PLANNER_EXECUTE_TOOLS, ROSE_DESKTOP_TOOL_MODELS, TOOL_MODELS

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


def _serialize_planner_tool_arguments(arguments: dict[str, Any]) -> str:
    """Return valid, bounded JSON for a persisted assistant tool declaration."""
    serialized = json.dumps(arguments, default=str, ensure_ascii=False)
    if len(serialized) <= PLANNER_CONTEXT_FULL_TEXT_LIMIT:
        return serialized

    # Tool-call arguments must remain parseable JSON. Truncating the serialized
    # object directly produces an invalid function.arguments value, so retain a
    # bounded head/tail summary as a string value and serialize a new object.
    summary = _compact_planner_context_text(serialized)
    while True:
        compacted = json.dumps({"_rose_compacted_arguments": summary}, ensure_ascii=False)
        if len(compacted) <= PLANNER_CONTEXT_FULL_TEXT_LIMIT:
            return compacted
        # Escaped quotes/control characters can make the JSON encoding longer
        # than the source string. Reduce deterministically until the encoded
        # wrapper itself satisfies the provider boundary.
        overflow = len(compacted) - PLANNER_CONTEXT_FULL_TEXT_LIMIT
        keep = max(64, len(summary) - overflow - 32)
        if keep >= len(summary):
            keep = max(64, len(summary) - 64)
        head = max(1, int(keep * 0.75))
        tail = max(1, keep - head)
        summary = summary[:head] + "\n[... compacted ...]\n" + summary[-tail:]


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


def dependencies_from_tasks(task_objects: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Derive the executable dependency graph from tasks[].depends_on."""
    deps: dict[str, list[str]] = {}
    for i, task_obj in enumerate(task_objects):
        task_deps = task_obj.get("depends_on", [])
        deps[str(i)] = [str(dep) for dep in task_deps]
    return deps


def _resolve_schema_ref(root: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    ref = schema.get("$ref")
    if not isinstance(ref, str) or not ref.startswith("#/$defs/"):
        return schema
    return root.get("$defs", {}).get(ref.removeprefix("#/$defs/"), schema)


def _compact_schema_type(root: dict[str, Any], schema: dict[str, Any], depth: int = 0) -> str:
    schema = _resolve_schema_ref(root, schema)

    if "const" in schema:
        return f"literal[{json.dumps(schema['const'], ensure_ascii=True)}]"
    if "enum" in schema and isinstance(schema["enum"], list):
        return "enum[" + ", ".join(json.dumps(value, ensure_ascii=True) for value in schema["enum"]) + "]"

    variants = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(variants, list):
        null_allowed = any(item.get("type") == "null" for item in variants if isinstance(item, dict))
        non_null = [item for item in variants if isinstance(item, dict) and item.get("type") != "null"]
        rendered = [_compact_schema_type(root, item, depth + 1) for item in non_null]
        type_text = " | ".join(dict.fromkeys(rendered)) if rendered else "any"
        return f"{type_text} | null" if null_allowed else type_text

    schema_type = schema.get("type")
    if schema_type == "array":
        items = schema.get("items")
        item_type = _compact_schema_type(root, items, depth + 1) if isinstance(items, dict) else "any"
        return f"list[{item_type}]"
    if schema_type == "object":
        return "object"
    if isinstance(schema_type, list):
        return " | ".join(str(item) for item in schema_type)
    if isinstance(schema_type, str):
        return schema_type
    return "any"


def _compact_schema_field(
    root: dict[str, Any],
    schema: dict[str, Any],
    *,
    required: bool,
    depth: int = 0,
) -> dict[str, Any]:
    schema = _resolve_schema_ref(root, schema)
    field: dict[str, Any] = {
        "type": _compact_schema_type(root, schema, depth),
        "required": required,
    }

    description = schema.get("description")
    if isinstance(description, str) and description.strip():
        field["description"] = description.strip()

    if depth >= 2:
        return field

    variants = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(variants, list):
        object_variant = next(
            (
                _resolve_schema_ref(root, item)
                for item in variants
                if isinstance(item, dict)
                and _resolve_schema_ref(root, item).get("type") == "object"
                and _resolve_schema_ref(root, item).get("properties")
            ),
            None,
        )
        if object_variant:
            schema = object_variant

    if schema.get("type") == "array":
        items = schema.get("items")
        if isinstance(items, dict):
            resolved_items = _resolve_schema_ref(root, items)
            if resolved_items.get("type") == "object" and resolved_items.get("properties"):
                item_required = set(resolved_items.get("required", []))
                field["items"] = {
                    sub_name: _compact_schema_field(
                        root,
                        sub_schema,
                        required=sub_name in item_required,
                        depth=depth + 1,
                    )
                    for sub_name, sub_schema in resolved_items.get("properties", {}).items()
                }

    if schema.get("type") == "object" and schema.get("properties"):
        nested_required = set(schema.get("required", []))
        field["fields"] = {
            sub_name: _compact_schema_field(
                root,
                sub_schema,
                required=sub_name in nested_required,
                depth=depth + 1,
            )
            for sub_name, sub_schema in schema.get("properties", {}).items()
        }

    return field


def _render_llm_tool_schema(name: str, description: str, model: Any) -> str:
    schema = model.model_json_schema()
    required = set(schema.get("required", []))
    arguments: dict[str, Any] = {}
    for field_name, field_schema in schema.get("properties", {}).items():
        if field_name == "output_schema":
            resolved = _resolve_schema_ref(schema, field_schema)
            description_text = resolved.get("description") or field_schema.get("description") or ""
            arguments[field_name] = {
                "type": "response_schema",
                "required": field_name in required,
                "description": (
                    description_text.strip()
                    + " Shape: {fields: [{name, type, required, description, nested_fields?}]}."
                    if description_text
                    else "Expected structured response fields. Shape: {fields: [{name, type, required, description, nested_fields?}]}."
                ),
            }
            continue
        arguments[field_name] = _compact_schema_field(schema, field_schema, required=field_name in required)
    rendered = {
        "tool": name,
        "arguments": arguments,
    }
    return (
        f"Purpose:\n{description}\n\n"
        "LLM-facing Pydantic arguments:\n"
        f"```json\n{json.dumps(rendered, indent=2, ensure_ascii=True)}\n```"
    )


def get_planner_tools_description(*, rose_desktop: bool = False) -> str:
    """Get compact execute-tool schemas and descriptions for the planner.

    Single source of truth: the execute tools a DAG task can be assigned
    (PLANNER_EXECUTE_TOOLS), their prompt fragments, and their Pydantic
    schemas. Planner-only spawn aliases are documented in the planner prompt.
    ``rose_desktop`` (``utils.rose_desktop``) renders the Rose Desktop schemas
    and fragments; the default is the stock text.
    """
    models = {**TOOL_MODELS, **ROSE_DESKTOP_TOOL_MODELS} if rose_desktop else TOOL_MODELS
    prompts = tool_prompts_for(rose_desktop=rose_desktop)
    sections = []
    for name in PLANNER_EXECUTE_TOOLS:
        model = models.get(name)
        if name in prompts:
            description = prompts[name].strip()
        elif model:
            description = (model.__doc__ or "").strip() or "No description"
        else:
            continue

        if model:
            sections.append(f"### {name}\n{_render_llm_tool_schema(name, description, model)}")
        else:
            sections.append(f"### {name}\n{description}")
    return "\n\n".join(sections) if sections else "Standard execution tools available."


def validate_planner_result(planner_result: dict[str, Any]) -> str | None:
    """Validate the planner result. Returns error message if invalid, None if valid."""
    task_objects = planner_result.get("tasks", [])
    tasks = [t.get("goal", "") for t in task_objects]
    join = planner_result.get("join", "all")

    if not tasks:
        return "No tasks returned. The plan must have at least one task."

    if join not in ("all", "any"):
        return f"Invalid join value '{join}'. Must be 'all' or 'any'."

    for i, task_obj in enumerate(task_objects):
        task_idx = task_obj.get("task_idx")
        if not isinstance(task_idx, str) or not task_idx.isdigit():
            return f"Task {i} has invalid task_idx={task_idx!r}. It must be the 0-based array index as a string."
        if task_idx != str(i):
            return f"Task {i} has task_idx={task_idx!r}. It must equal its 0-based array position '{i}'."

        task_deps = task_obj.get("depends_on", [])
        if not isinstance(task_deps, list):
            return f"Task {i} has invalid depends_on={task_deps!r}. It must be a list of task indices."

    dep_error = validate_dependencies(tasks, dependencies_from_tasks(task_objects))
    if dep_error:
        return dep_error

    return None  # Valid


def build_plan_data(planner_result: dict[str, Any]) -> PlanData:
    """Extract validated planner result into a PlanData structure.

    Assumes planner_result has already passed validation.
    """
    task_objects = planner_result["tasks"]
    tasks: list[TaskObject] = [TaskObject(goal=t["goal"], tool_name=t["tool_name"]) for t in task_objects]
    deps = dependencies_from_tasks(task_objects)
    title: str = planner_result["title"]
    content: str = planner_result.get("content") or ""
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
    return f"{text[:head_len]}\n\n[... planner context compacted {omitted} chars ...]\n\n{text[-tail_len:]}"


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


def _planner_tool_declarations(msg: dict[str, Any]) -> list[dict[str, Any]]:
    """Assistant tool declarations persisted in message metadata -> OpenAI-shape tool_calls."""
    metadata = msg.get("metadata") if isinstance(msg.get("metadata"), dict) else {}
    calls: list[dict[str, Any]] = []
    for call in metadata.get("tool_calls") or []:
        if not isinstance(call, dict):
            continue
        name = call.get("tool")
        call_id = call.get("tool_call_id")
        if not isinstance(name, str) or not name or not isinstance(call_id, str) or not call_id:
            continue
        # Only plan-phase calls may survive as native history. Execute-only
        # declarations (for example wait_for) are not present in the planner's
        # tool boundary and would make Anthropic reject the replayed history.
        if name not in PLAN_PHASE_TOOLS:
            continue
        arguments = {k: v for k, v in call.items() if k not in ("tool", "tool_call_id")}
        calls.append(
            {
                "id": call_id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": _serialize_planner_tool_arguments(arguments),
                },
            }
        )
    return calls


def build_planner_messages(context: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Extract conversation context and user messages for the planner.

    Tool history keeps its real roles: assistant declarations become
    ``tool_calls`` and their results become ``role: tool`` messages paired by
    tool_call_id (providers that declare no tools flatten these to text, see
    ``flatten_tool_history_to_text``). Undeclared TOOL/SYSTEM rows are
    workflow notices and are passed as ``[SYSTEM]:`` user text.

    Args:
        context: The workflow context (list of message dicts).

    Returns:
        Tuple of (base_messages for planner, user_messages list).
    """
    user_messages: list[str] = []
    base_messages: list[dict[str, Any]] = []
    declared_calls: dict[str, str] = {}

    for msg in context:
        if is_internal_subagent_message(msg) or is_excluded_from_model(msg):
            continue

        role = msg.get("role", "").upper()
        text = msg.get("text", "")
        message_id = msg.get("message_id")
        text = _strip_reference_annotation(text, message_id if isinstance(message_id, str) else None)
        metadata = msg.get("metadata") if isinstance(msg.get("metadata"), dict) else {}

        agent_text = model_agent_row_text(msg) if role == "USER" else None
        if agent_text is not None:
            # Agent-to-agent content: assistant-role (Codex), never the user's goal.
            base_messages.append(inter_agent_message(_compact_planner_text("ASSISTANT", agent_text)))
            continue

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

        if role == "ASSISTANT":
            tool_calls = _planner_tool_declarations(msg)
            unique_tool_calls: list[dict[str, Any]] = []
            for call in tool_calls:
                call_id = call["id"]
                if call_id in declared_calls:
                    continue
                declared_calls[call_id] = call["function"]["name"]
                unique_tool_calls.append(call)
            tool_calls = unique_tool_calls
            if not text and not tool_calls:
                continue
            assistant: dict[str, Any] = {"role": "assistant", "content": _compact_planner_text(role, text)}
            if tool_calls:
                assistant["tool_calls"] = tool_calls
            base_messages.append(assistant)
            continue

        if not text:
            continue
        if role == "USER":
            base_messages.append({"role": "user", "content": _compact_planner_text(role, text)})
        elif role == "TOOL":
            tool_call_id = str(metadata.get("toolCallId") or "")
            content = _compact_planner_context_text(text)
            if metadata.get("title"):
                content = f"{metadata['title']}: {content}"
            if tool_call_id and tool_call_id in declared_calls:
                base_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "name": declared_calls[tool_call_id],
                        "content": content,
                    }
                )
            else:
                base_messages.append({"role": "user", "content": f"[SYSTEM]: {content}"})
        elif role == "SYSTEM":
            base_messages.append({"role": "user", "content": f"[SYSTEM]: {_compact_planner_context_text(text)}"})

    # Prepend goal message
    goal = user_messages[0] if user_messages else DEFAULT_GOAL
    base_messages.insert(0, {"role": "user", "content": f"GOAL: {goal}\n\nPlan this goal into tasks."})

    # Budget trimming can split a native tool-use/result pair. Repair after the
    # trim so provider history contains no orphan or duplicate tool-call IDs.
    from helpers.llm import _ensure_tool_result_pairing

    bounded = _enforce_planner_context_budget(base_messages)
    repaired = _ensure_tool_result_pairing(bounded)
    repaired = [
        message
        for message in repaired
        if not (message.get("role") == "assistant" and not message.get("content") and not message.get("tool_calls"))
    ]
    # The str marker does not survive the activity boundary, so a trailing
    # inter-agent message is settled to user role here (RoseClient does the
    # same for in-activity callers).
    return settle_trailing_inter_agent_messages(repaired), user_messages


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
        (
            "rose-labs/rose-local"
            if getattr(workflow_instance, "model", None) == "rose-labs/rose-local"
            else PLANNER_MODEL
        ),
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
        getattr(workflow_instance, "compute_token_lineage_key", None),
        getattr(workflow_instance, "compute_token_demo_cache_affinity_key", None),
        getattr(workflow_instance, "fast_mode_cache_enabled", False),
        # Prefer the durable Agent-row goal (demo_cache_goal) so chat-escalation
        # refined workflow input goals do not open a fresh empty cache namespace.
        getattr(workflow_instance, "demo_cache_goal", None) or getattr(workflow_instance, "goal", None),
        attempt,  # Fast Mode position step — planner attempt index (deterministic across runs)
        bool(getattr(workflow_instance, "memory_enabled", False)),  # Planner memory (get_memories fork)
    ]
    # Simulate mode: the agent's last known world time, used if a mid-run world
    # clock read returns nothing. Absent outside a WMH world (args unchanged).
    world_cursor = world_time_cursor_ms(workflow_instance)
    if world_cursor is not None:
        planner_args.append(world_cursor)

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
        heartbeat_timeout=timedelta(seconds=PLANNER_ACTIVITY_HEARTBEAT_TIMEOUT_SECONDS),
        retry_policy=RetryPolicy(maximum_attempts=PLANNER_ACTIVITY_MAX_ATTEMPTS),
    )
    planner_only_elapsed = (workflow.now() - planner_only_start).total_seconds()
    workflow.logger.info(f"[TIMING] Planner LLM completed: {planner_only_elapsed * 1000:.1f}ms")

    await workflow_instance._track_usage(planner_result_raw.get("usage"), tool_name="set_plan", call_site="planner")
    planner_result = planner_result_raw.get("result", planner_result_raw)

    return planner_result
