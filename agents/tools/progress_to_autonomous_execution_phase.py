"""
Progress to Autonomous Execution Phase - Plan phase tool for transitioning to execution.

This tool signals that the plan is ready for user approval.
The actual phase transition happens statelessly when the user sends a message
containing "start autonomous execution" or when this tool is called.
"""

from typing import Dict, Any, Optional, AsyncGenerator

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus


class ProgressToAutonomousExecutionPhaseManager(ToolManager):
    """Manager for progress_to_autonomous_execution_phase tool."""
    
    tool_name = "progress_to_autonomous_execution_phase"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Signal that the plan is ready for execution.
        
        This posts a message that the frontend will render with a "Start Autonomous Execution" button.
        Phase transition happens statelessly when user sends "start autonomous execution".
        
        GUARD: Requires workflow_instance.current_plan to be set (via set_plan tool).
        
        Yields:
            - Error if no plan set
            - Message indicating plan is ready for approval
        """
        # GUARD: Get plan from workflow state - error if not set
        plan = getattr(workflow_instance, 'current_plan', None)
        
        if plan is None:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Cannot Progress to Execution",
                message=(
                    "Cannot progress to execution without a plan. "
                    "You must call **set_plan** first to define what will be executed.\n\n"
                    "Use set_plan to specify:\n"
                    "- `title`: Short plan name\n"
                    "- `content`: Markdown explanation of the plan\n"
                    "- `tasks`: List of task descriptions (index = task ID)\n"
                    "- `dependencies`: Optional execution order graph (e.g., {'2': ['0', '1']})\n"
                    "- `join`: 'all' (AND) or 'any' (OR)"
                ),
                status=MessageStatus.ERROR
            )
            return
        
        # Get goal from workflow instance
        goal = getattr(workflow_instance, 'goal', 'your goal')
        
        # Yield send_message_to_user style event (is_question=false, non-blocking FYI)
        message = f"Looks like I have everything I need in order to accomplish your goal - **{goal}**\n\nWe will now proceed to fulfill your request, just sit back, relax, and let us figure out the rest :)"
        
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="FYI for User",
            message=message,
            status=MessageStatus.FINISHED,
            metadata={
                "isUserAttentionMessage": True,
                "attentionMessage": message,
                "sendMessageToUser": {
                    "isQuestion": False,
                    "attentionKind": "info",
                    "isWaitingForUser": False,
                },
            }
        )


_manager: Optional[ProgressToAutonomousExecutionPhaseManager] = None


def get_manager() -> ProgressToAutonomousExecutionPhaseManager:
    global _manager
    if _manager is None:
        _manager = ProgressToAutonomousExecutionPhaseManager()
    return _manager


async def progress_to_autonomous_execution_phase(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for progress_to_autonomous_execution_phase (event-driven system).
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict (no parameters needed)
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "progress_to_autonomous_execution_phase")

