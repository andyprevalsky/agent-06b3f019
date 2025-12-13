"""
Set Plan - Plan phase tool for defining execution plans.

This tool allows agents to set/update the plan that will be displayed to users
in the plan artifact panel.
"""

from typing import Dict, Any, Optional, AsyncGenerator, List

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus


class SubGoal:
    """A sub-goal for parallel execution."""
    goal: str
    context: str  # Research context to pass to sub-agent


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
        Set or update the execution plan.
        
        Args:
            tool_call: Contains markdown_text, is_parallelizable, sub_tasks, and optionally sub_goals
            
        Yields:
            - Message with plan data for frontend display
            - Error if is_parallelizable=true but sub_goals is empty
        """
        markdown_text = tool_call.get("markdown_text", "")
        is_parallelizable = tool_call.get("is_parallelizable", False)
        sub_tasks: List[str] = tool_call.get("sub_tasks", [])
        sub_goals: List[Dict[str, str]] = tool_call.get("sub_goals", [])
        
        # Validation: if is_parallelizable=true, sub_goals must be populated
        if is_parallelizable and not sub_goals:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Plan Validation Error",
                message=(
                    "When is_parallelizable=true, you must provide sub_goals. "
                    "Sub-goals are context-independent goals that can be executed in parallel by sub-agents. "
                    "Either:\n"
                    "1. Set is_parallelizable=false if sub-tasks are causally dependent\n"
                    "2. Provide sub_goals with goal and context for each parallel workstream"
                ),
                status=MessageStatus.ERROR
            )
            return
        
        # Build plan data structure for frontend
        plan_data = {
            "type": "plan_artifact",
            "markdown_text": markdown_text,
            "is_parallelizable": is_parallelizable,
            "sub_tasks": sub_tasks,
            "sub_goals": sub_goals,
            "status": "planning"  # planning, ready, executing, complete
        }
        
        # Build descriptive message
        if is_parallelizable:
            msg = f"Plan set with {len(sub_tasks)} steps. Will spawn {len(sub_goals)} parallel sub-agents."
        else:
            msg = f"Plan set with {len(sub_tasks)} steps. Sequential execution (causally dependent tasks)."
        
        # Yield event with plan data embedded in message
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="📋 Plan Updated",
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
        tool_call: Tool call dict with markdown_text, is_parallelizable, sub_tasks, sub_goals
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "set_plan")
