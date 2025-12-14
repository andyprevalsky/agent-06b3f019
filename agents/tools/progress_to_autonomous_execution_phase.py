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
        
        Yields:
            - Message indicating plan is ready for approval
        """
        # Yield event with data for frontend to render Execute button
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="✓ Plan Ready",
            message="Plan is ready for execution. Click 'Start Autonomous Execution' to proceed.",
            status=MessageStatus.FINISHED,
            data={
                "type": "execute_phase_request",
                "awaiting_approval": True
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

