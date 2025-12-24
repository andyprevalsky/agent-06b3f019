"""
Mark Execution Complete - Phase transition marker tool.

This tool signals that the agent believes execution is complete and triggers verification.
"""

from typing import Dict, Any, Optional, AsyncGenerator

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus


class MarkExecutionCompleteManager(ToolManager):
    """Manager for mark_execution_complete phase transition."""
    
    tool_name = "mark_execution_complete"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Mark execution as complete and trigger verification.
        
        Yields:
            - Success status indicating execution is ready for verification
        """
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="✓ Execution marked complete",
            message="Running verifier to check goal completion...",
            status=MessageStatus.FINISHED
        )


_manager: Optional[MarkExecutionCompleteManager] = None


def get_manager() -> MarkExecutionCompleteManager:
    global _manager
    if _manager is None:
        _manager = MarkExecutionCompleteManager()
    return _manager


async def mark_execution_complete(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for mark_execution_complete (event-driven system).
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict (no parameters needed)
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "mark_execution_complete")


