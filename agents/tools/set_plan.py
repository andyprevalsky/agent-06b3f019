"""
Set Plan - Plan phase tool for defining execution plans.

This tool uses the two-axis planning framework:
1. Reducing uncertainty (ambiguity, unknown constraints, unknown strategy)
2. Reducing remaining work (executing known steps once the world is understood)

Plans can be:
- Proximate (atomic): Can be executed in one bounded step with sequential sub_tasks
- Composite: Must be expanded into sub_goals with a composition operator (AND/OR)
"""

from typing import Dict, Any, Optional, AsyncGenerator, List

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus


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
            tool_call: Contains title, content, is_proximate, and either:
                - sub_tasks (for proximate/atomic goals)
                - sub_goals + join_modifier (for composite goals)
            
        Yields:
            - Message with plan data for frontend display
            - Error if validation fails
        """
        title = tool_call.get("title", "Untitled Plan")
        content = tool_call.get("content", "")
        is_proximate = tool_call.get("is_proximate", True)
        sub_tasks: List[str] = tool_call.get("sub_tasks", [])
        sub_goals: List[str] = tool_call.get("sub_goals", [])
        join_modifier: Optional[str] = tool_call.get("join_modifier")
        
        # Validation based on is_proximate
        if is_proximate:
            # Proximate (atomic) goals need sub_tasks
            if not sub_tasks:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Plan Validation Error",
                    message=(
                        "When is_proximate=true (atomic goal), you must provide sub_tasks. "
                        "Sub-tasks are sequential steps to complete the atomic goal.\n\n"
                        "Either:\n"
                        "1. Provide sub_tasks with sequential steps\n"
                        "2. Set is_proximate=false if this goal should be decomposed into parallel sub-goals"
                    ),
                    status=MessageStatus.ERROR
                )
                return
        else:
            # Composite goals need sub_goals + join_modifier
            if not sub_goals:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Plan Validation Error",
                    message=(
                        "When is_proximate=false (composite goal), you must provide sub_goals. "
                        "Sub-goals are parallel goals that will be delegated to sub-agents.\n\n"
                        "Either:\n"
                        "1. Provide sub_goals with goal descriptions\n"
                        "2. Set is_proximate=true if this is an atomic goal with sequential steps"
                    ),
                    status=MessageStatus.ERROR
                )
                return
            
            if join_modifier not in ("&&", "||"):
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Plan Validation Error",
                    message=(
                        "When is_proximate=false, you must provide join_modifier ('&&' or '||').\n\n"
                        "- '&&' (AND): All sub-goals must complete (parallelize work)\n"
                        "- '||' (OR): Any sub-goal can satisfy the parent (reduce uncertainty via hypotheses)\n\n"
                        "Use OR when uncertainty > decomposability, AND when decomposability >= uncertainty."
                    ),
                    status=MessageStatus.ERROR
                )
                return
        
        # Build plan data structure for frontend
        plan_data = {
            "type": "plan_artifact",
            "title": title,
            "content": content,
            "is_proximate": is_proximate,
            "sub_tasks": sub_tasks if is_proximate else [],
            "sub_goals": sub_goals if not is_proximate else [],
            "join_modifier": join_modifier if not is_proximate else None,
            "status": "planning"  # planning, ready, executing, complete
        }
        
        # Store plan in workflow state (required before progress_to_execution)
        workflow_instance.current_plan = plan_data
        
        # Build descriptive message based on plan type
        if is_proximate:
            msg = f"**{title}**\n\n{len(sub_tasks)} sequential steps to complete."
        else:
            if join_modifier == "||":
                msg = f"**{title}**\n\n{len(sub_goals)} hypotheses to evaluate (OR - any one may satisfy)."
            else:
                msg = f"**{title}**\n\n{len(sub_goals)} parallel sub-goals (AND - all must complete)."
        
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
        tool_call: Tool call dict with title, content, is_proximate, sub_tasks/sub_goals, join_modifier
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "set_plan")
