"""
Set Plan - Plan phase tool for defining execution plans.

This tool uses the two-axis planning framework:
1. Reducing uncertainty (ambiguity, unknown constraints, unknown strategy)
2. Reducing remaining work (executing known steps once the world is understood)

Plans use explicit dependency graphs to define execution order:
- tasks: List of task descriptions (index = task ID)
- dependencies: DAG specifying which tasks must complete before others
- join: How to combine results ('all' for AND, 'any' for OR)
"""

from typing import Dict, Any, Optional, AsyncGenerator, List
from collections import deque

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus


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


class SetPlanManager(ToolManager):
    """Manager for set_plan tool."""
    
    tool_name = "set_plan"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Set or update the execution plan using the two-axis framework.
        
        Args:
            tool_call: Contains title, content, tasks, dependencies, join
            
        Yields:
            - Message with plan data for frontend display
            - Error if validation fails
        """
        title = tool_call.get("title", "Untitled Plan")
        content = tool_call.get("content", "")
        tasks: List[str] = tool_call.get("tasks", [])
        dependencies: Optional[Dict[str, List[str]]] = tool_call.get("dependencies")
        join: str = tool_call.get("join", "all")
        
        # Validate tasks
        if not tasks:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Plan Validation Error",
                message=(
                    "You must provide at least one task in the 'tasks' field.\n\n"
                    "Example:\n"
                    "```\n"
                    "tasks: ['Research competitors', 'Analyze findings', 'Write report']\n"
                    "```"
                ),
                status=MessageStatus.ERROR
            )
            return
        
        # Validate join modifier
        if join not in ("all", "any"):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Plan Validation Error",
                message=(
                    f"Invalid join value '{join}'. Must be 'all' or 'any'.\n\n"
                    "- 'all' (AND): All tasks must complete; results are merged.\n"
                    "- 'any' (OR): First successful task satisfies the goal (hypotheses).\n\n"
                    "Use 'any' when uncertainty > decomposability, 'all' when decomposability >= uncertainty."
                ),
                status=MessageStatus.ERROR
            )
            return
        
        # Validate dependencies
        deps = dependencies or {}
        validation_error = validate_dependencies(tasks, deps)
        if validation_error:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Dependency Validation Error",
                message=validation_error,
                status=MessageStatus.ERROR
            )
            return
        
        # Build plan data structure for frontend
        plan_data = {
            "type": "plan_artifact",
            "title": title,
            "content": content,
            "tasks": tasks,
            "dependencies": deps,
            "join": join,
            "status": "planning"  # planning, ready, executing, complete
        }
        
        # Store plan in workflow state (required before progress_to_execution)
        workflow_instance.current_plan = plan_data
        
        # Build descriptive message based on plan structure
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
        
        # Yield event with plan data embedded in message
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
        tool_call: Tool call dict with title, content, tasks, dependencies, join
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "set_plan")
