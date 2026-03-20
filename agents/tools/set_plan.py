"""
Set Plan - Triggers dedicated planner LLM to generate execution plan.

When the main agent calls set_plan(), a dedicated planner LLM analyzes
the conversation context and generates an optimal task structure with
dependencies.
"""

from datetime import timedelta
from typing import Dict, Any, Optional, AsyncGenerator, List
from collections import deque

from temporalio import workflow
from temporalio.common import RetryPolicy

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus
from helpers.tool_schemas import TOOL_MODELS, PLANNER_ASSIGNABLE_TOOLS
from helpers.attachments import FilePointer, get_cached_file

# Manual descriptions for planner-facing tool names (mapped to spawn_agent via DAG aliases)
PLANNING_TOOL_DESCRIPTIONS = {
    "spawn_explore_agent": "Research agent for information gathering (web search, web fetch, message search across iMessage/email). Returns free-form summary.",
    "spawn_browser_agent": "Web automation agent for purchases, forms, JS-heavy sites. Needs start_url.",
    "spawn_code_agent": "Coding agent in ephemeral E2B sandbox. Optional github_repo_link.",
    "spawn_sub_agent": "Delegate ONE complex task to a child agent with its own planning cycle. Use for a single multi-step job (e.g., 'research and book a venue'). NOT for repeated work across a list - use spawn_sub_agent_for_each instead.",
    "spawn_sub_agent_for_each": "Apply the SAME task to MANY items (list or CSV). Spawns one sub-agent per item/row with a shared goal. Use instead of spawn_sub_agent whenever the work is repeated across a list of inputs (e.g., 'look up each company', 'email each person', 'process each row in the CSV').",
    "reasoning": "Pure thinking/analysis step with no external tool call. Use for synthesizing results or making decisions.",
    "wait_for": "Wait until a timestamp or condition is met. Timestamp mode: provide until_timestamp (ISO 8601). Condition mode: provide condition (natural language) + check_interval_seconds + max_checks. Explore agents periodically check the condition. Use for polling/monitoring tasks (e.g., 'check every 15 min if package delivered').",
}


def validate_dependencies(tasks: List[str], deps: Dict[str, List[str]]) -> Optional[str]:
    """
    Validate the dependency graph.

    Returns error message if invalid, None if valid.
    """
    n = len(tasks)

    if not deps:
        return None  # Empty deps is valid (all parallel)

    # Check for invalid task indices
    for task_idx, predecessors in deps.items():
        if not task_idx.isdigit():
            return f"Invalid task index '{task_idx}'. Must be a numeric string (e.g., '0', '1', '2')."

        idx = int(task_idx)
        if idx < 0 or idx >= n:
            return f"Task index '{task_idx}' out of range. Valid indices: 0 to {n-1}."

        if not isinstance(predecessors, list):
            return f"Dependencies for task '{task_idx}' must be a list, got {type(predecessors).__name__}."

        for pred in predecessors:
            if not isinstance(pred, str) or not pred.isdigit():
                return f"Task {task_idx} has invalid predecessor '{pred}'. Must be a numeric string."

            pred_idx = int(pred)
            if pred_idx < 0 or pred_idx >= n:
                return f"Task {task_idx} depends on non-existent task '{pred}'. Valid indices: 0 to {n-1}."

    # Check for self-references
    for task_idx, predecessors in deps.items():
        if task_idx in predecessors:
            return f"Task {task_idx} cannot depend on itself."

    # Check for cycles using Kahn's algorithm (topological sort)
    # Build adjacency list and in-degree count
    in_degree = [0] * n
    adj: Dict[int, List[int]] = {i: [] for i in range(n)}

    for task_idx, predecessors in deps.items():
        idx = int(task_idx)
        for pred in predecessors:
            pred_idx = int(pred)
            adj[pred_idx].append(idx)
            in_degree[idx] += 1

    # Find all nodes with in-degree 0
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
        # Find which nodes are in the cycle
        cycle_nodes = [str(i) for i in range(n) if in_degree[i] > 0]
        return f"Dependency cycle detected involving tasks: {', '.join(cycle_nodes)}. Ensure no task transitively depends on itself."

    return None  # Valid


def _convert_dependencies_list_to_dict(deps_list: List[Dict[str, Any]]) -> Dict[str, List[str]]:
    """
    Convert dependencies_graph from list format to dict format.

    Input:  [{"task_idx": "0", "depends_on": ["1", "2"]}, ...]
    Output: {"0": ["1", "2"], ...}
    """
    if not deps_list:
        return {}
    return {
        entry.get("task_idx", ""): entry.get("depends_on", [])
        for entry in deps_list
        if entry.get("task_idx")
    }


def _get_planner_tools_description() -> str:
    """Get description of tools the planner can assign to tasks."""
    lines = []
    for name in PLANNER_ASSIGNABLE_TOOLS:
        # Check manual descriptions first (for planning-only tools)
        if name in PLANNING_TOOL_DESCRIPTIONS:
            lines.append(f"- {name}: {PLANNING_TOOL_DESCRIPTIONS[name]}")
        elif name in TOOL_MODELS:
            model = TOOL_MODELS[name]
            doc = (model.__doc__ or "").strip()
            lines.append(f"- {name}: {doc if doc else 'No description'}")
    return "\n".join(lines) if lines else "Standard execution tools available."


def _validate_planner_result(planner_result: Dict[str, Any]) -> Optional[str]:
    """
    Validate the planner result. Returns error message if invalid, None if valid.
    """
    task_objects = planner_result.get("tasks", [])
    tasks = [t.get("goal", "") for t in task_objects]
    # Convert list format to dict format
    deps_list = planner_result.get("dependencies_graph", [])
    dependencies = _convert_dependencies_list_to_dict(deps_list)
    join = planner_result.get("join", "all")

    # Validate tasks
    if not tasks:
        return "No tasks returned. The plan must have at least one task."

    # Validate join
    if join not in ("all", "any"):
        return f"Invalid join value '{join}'. Must be 'all' or 'any'."

    # Validate dependencies_graph
    deps = dependencies or {}
    dep_error = validate_dependencies(tasks, deps)
    if dep_error:
        return dep_error

    # Verify tasks[i].depends_on matches dependencies_graph
    for i, task_obj in enumerate(task_objects):
        task_deps = task_obj.get("depends_on", [])
        graph_deps = deps.get(str(i), [])
        task_deps_str = sorted([str(d) for d in task_deps])
        graph_deps_str = sorted(graph_deps)
        if task_deps_str != graph_deps_str:
            return f"Task {i} has depends_on={task_deps} but dependencies_graph['{i}']={graph_deps}. They must match exactly."

    return None  # Valid


class SetPlanManager(ToolManager):
    """Manager for set_plan tool - triggers planner LLM."""

    tool_name = "set_plan"
    MAX_RETRIES = 2  # Retry once on validation failure

    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Trigger planner LLM to generate execution plan.

        The planner receives conversation context and generates tasks with dependencies.
        On validation failure, retries once with the error as context.

        Also generates the response schema in parallel if not already present (for root agents).
        Sub-agents get their schema at spawn time from the parent.

        Yields:
            - IN_PROGRESS while planner is thinking
            - Plan data on success
            - Error if validation fails after retries
        """
        import asyncio
        # Import activity here to avoid circular imports
        from helpers.llm import call_planner_llm_activity, set_response_schema_activity

        # Use workflow.now() for deterministic timing in workflows
        total_start = workflow.now()

        # 1. Yield in-progress status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Generating Plan",
            message="Analyzing context and generating execution plan",
            status=MessageStatus.IN_PROGRESS
        )

        # 2. Extract all USER messages from context
        context_start = workflow.now()
        user_messages = []
        for msg in workflow_instance.context:
            if msg.get("role") == "USER":
                text = msg.get("text", "")
                if text:
                    user_messages.append(text)

        # Use first user message as primary goal for planner prompt
        goal = user_messages[0] if user_messages else "Complete the user's request"

        # 3. Build conversation history for planner
        base_messages = [
            {"role": "user", "content": f"GOAL: {goal}\n\nPlan this goal into tasks."}
        ]
        for msg in workflow_instance.context:
            role = msg.get("role", "").upper()
            text = msg.get("text", "")

            # Resolve file attachments from cache (pre-populated by resolve_attachments_activity)
            file_pointer_data = msg.get("file_pointer") or msg.get("filePointer")
            if file_pointer_data and isinstance(file_pointer_data, dict):
                try:
                    fp = FilePointer.from_dict(file_pointer_data)
                    cached = get_cached_file(fp.id)
                    if cached:
                        file_bytes, _ = cached
                        file_text = file_bytes.decode("utf-8", errors="replace")
                        text = f"{text}\n\n[File: {fp.original_filename}]\n```\n{file_text}\n```" if text else f"[File: {fp.original_filename}]\n```\n{file_text}\n```"
                    elif not text:
                        text = f"[File attached: {fp.original_filename} ({fp.mime_type})]"
                except Exception:
                    pass  # Fall through to normal text handling

            if not text:
                continue
            if role == "USER":
                base_messages.append({"role": "user", "content": text})
            elif role == "ASSISTANT":
                base_messages.append({"role": "assistant", "content": text})
            elif role in ("TOOL", "SYSTEM"):
                base_messages.append({"role": "user", "content": f"[{role}]: {text}"})

        # 4. Build context for planner activity
        tools_description = _get_planner_tools_description()
        user_context = getattr(workflow_instance, 'user_context_section', '')
        response_schema = getattr(workflow_instance, 'output_schema', None)

        # Refresh Claude token if expired (5-min TTL)
        user_id = getattr(workflow_instance, 'user_id', None)
        if user_id and hasattr(workflow_instance, '_refresh_claude_token'):
            await workflow_instance._refresh_claude_token(user_id)
        claude_max_token = getattr(workflow_instance, 'claude_max_token', None)
        context_elapsed = (workflow.now() - context_start).total_seconds()
        workflow.logger.info(f"[TIMING] Context building: {context_elapsed*1000:.1f}ms (messages: {len(base_messages)}, has_schema: {response_schema is not None})")

        # 5. Call planner with retry on validation failure
        # Also run schema generation in parallel if schema is NULL
        planner_result = None
        last_error = None

        for attempt in range(self.MAX_RETRIES):
            attempt_start = workflow.now()
            messages_for_planner = base_messages.copy()

            # On retry, add the previous error as context
            if last_error:
                messages_for_planner.append({
                    "role": "user",
                    "content": f"[VALIDATION ERROR - Please fix]: {last_error}"
                })

            try:
                # On first attempt, run schema generation in parallel with planner
                # (only if schema is NULL - sub-agents already have schema from parent)
                if attempt == 0 and response_schema is None:
                    workflow.logger.info(f"[TIMING] Starting PARALLEL planner + schema generation (attempt {attempt + 1})")
                    # Run both activities in parallel
                    # Planner always uses rose-ultra for best DAG generation quality
                    planner_task = workflow.execute_activity(
                        call_planner_llm_activity,
                        args=[messages_for_planner, "rose-labs/rose-1-ultra", tools_description, user_context, response_schema, claude_max_token,
                              workflow_instance.agent_id, tool_call_id],
                        start_to_close_timeout=timedelta(seconds=120),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    schema_task = workflow.execute_activity(
                        set_response_schema_activity,
                        args=[workflow_instance.agent_id, user_messages],
                        start_to_close_timeout=timedelta(seconds=90),
                        retry_policy=RetryPolicy(maximum_attempts=3),
                    )

                    # Wait for both to complete
                    parallel_start = workflow.now()
                    planner_result_raw, generated_schema = await asyncio.gather(planner_task, schema_task)
                    parallel_elapsed = (workflow.now() - parallel_start).total_seconds()
                    workflow.logger.info(f"[TIMING] Parallel activities completed: {parallel_elapsed*1000:.1f}ms")

                    await workflow_instance._track_usage(planner_result_raw.get("usage"), tool_name="set_plan", call_site="planner")
                    planner_result = planner_result_raw.get("result", planner_result_raw)

                    # Unpack schema result (now returns {"schema": dict, "usage": dict} or None)
                    schema_data = None
                    if isinstance(generated_schema, dict) and "schema" in generated_schema:
                        schema_data = generated_schema["schema"]
                        schema_usage = generated_schema.get("usage", {})
                        # Track schema generation LLM cost
                        if schema_usage:
                            await workflow_instance._track_llm_cost(
                                schema_usage.get("prompt_tokens", 0),
                                schema_usage.get("completion_tokens", 0),
                                call_site="schema_generation",
                            )
                    elif generated_schema:
                        # Backwards compat: old format returned schema directly
                        schema_data = generated_schema

                    # Update workflow instance with generated schema
                    if schema_data:
                        workflow_instance.output_schema = schema_data
                        workflow.logger.info(f"✅ Generated output_schema with {len(schema_data.get('fields', []))} fields")
                else:
                    # Retry or schema already exists - just call planner
                    workflow.logger.info(f"[TIMING] Starting planner LLM only (attempt {attempt + 1}, schema_exists={response_schema is not None})")
                    planner_only_start = workflow.now()
                    # Planner always uses rose-ultra for best DAG generation quality
                    planner_result_raw = await workflow.execute_activity(
                        call_planner_llm_activity,
                        args=[messages_for_planner, "rose-labs/rose-1-ultra", tools_description, user_context, response_schema, claude_max_token,
                              workflow_instance.agent_id, tool_call_id],
                        start_to_close_timeout=timedelta(seconds=120),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    planner_only_elapsed = (workflow.now() - planner_only_start).total_seconds()
                    workflow.logger.info(f"[TIMING] Planner LLM only completed: {planner_only_elapsed*1000:.1f}ms")

                    await workflow_instance._track_usage(planner_result_raw.get("usage"), tool_name="set_plan", call_site="planner")
                    planner_result = planner_result_raw.get("result", planner_result_raw)
            except BaseException as e:
                if isinstance(e, GeneratorExit):
                    raise
                from helpers.error_utils import extract_error_message
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Planner Error",
                    message=f"Failed to generate plan: {extract_error_message(e)}",
                    status=MessageStatus.ERROR
                )
                return

            # Validate the result
            validation_start = workflow.now()
            validation_error = _validate_planner_result(planner_result)
            validation_elapsed = (workflow.now() - validation_start).total_seconds()
            attempt_elapsed = (workflow.now() - attempt_start).total_seconds()
            workflow.logger.info(f"[TIMING] Validation: {validation_elapsed*1000:.1f}ms, Total attempt {attempt + 1}: {attempt_elapsed*1000:.1f}ms")
            if validation_error is None:
                break  # Valid plan!

            last_error = validation_error
            if attempt < self.MAX_RETRIES - 1:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Retrying plan generation",
                    message=f"Validation error: {validation_error}\n\nRetrying with correction",
                    status=MessageStatus.IN_PROGRESS
                )

        # If still invalid after retries, fail
        if last_error:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Plan Validation Failed",
                message=f"Planner failed after {self.MAX_RETRIES} attempts: {last_error}",
                status=MessageStatus.ERROR
            )
            return

        # 6. Extract validated result
        task_objects = planner_result["tasks"]
        # Store full task objects with goal and tool_name (for DAG executor)
        tasks = [{"goal": t["goal"], "tool_name": t["tool_name"]} for t in task_objects]
        # Convert list format to dict format
        deps = _convert_dependencies_list_to_dict(planner_result.get("dependencies_graph", []))
        title = planner_result["title"]
        content = planner_result["content"]
        join = planner_result["join"]

        # 7. Build plan data structure for frontend and DAG executor
        plan_data = {
            "type": "plan_artifact",
            "title": title,
            "content": content,
            "tasks": tasks,
            "dependencies": deps,
            "join": join,
            "status": "planning"
        }

        # 12. Build descriptive message based on plan structure
        n_tasks = len(tasks)
        has_deps = bool(deps)

        if join == "any":
            msg = f"**{title}**\n\n{n_tasks} hypotheses to evaluate (any one may satisfy)."
        elif not has_deps:
            msg = f"**{title}**\n\n{n_tasks} tasks (parallel execution)."
        else:
            # Determine if fully sequential or DAG
            is_sequential = all(
                deps.get(str(i)) == [str(i - 1)]
                for i in range(1, n_tasks)
            ) and "0" not in deps

            if is_sequential:
                msg = f"**{title}**\n\n{n_tasks} tasks (sequential execution)."
            else:
                msg = f"**{title}**\n\n{n_tasks} tasks (staged execution with dependencies)."

        # 13. Yield event with plan data embedded in message
        total_elapsed = (workflow.now() - total_start).total_seconds()
        workflow.logger.info(f"[TIMING] ===== TOTAL set_plan execution: {total_elapsed*1000:.1f}ms ({total_elapsed:.2f}s) =====")
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=title,
            message=msg,
            status=MessageStatus.FINISHED,
            data=plan_data
        )


_manager: Optional[SetPlanManager] = None


def get_manager() -> SetPlanManager:
    global _manager
    if _manager is None:
        _manager = SetPlanManager()
    return _manager


async def set_plan(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for set_plan (event-driven system).

    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict (now empty - planner generates plan)
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    last_status = None

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "set_plan")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status

    return last_status
