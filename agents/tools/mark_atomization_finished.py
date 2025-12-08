"""
Mark Atomization Finished - Phase transition marker tool.

This tool signals the transition from ATOMIZE phase to either:
- EXECUTE phase (if is_proximate=True) - the goal is atomic, execute directly
- PLAN phase (if is_proximate=False) - the goal needs decomposition
"""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import workflow

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus


class MarkAtomizationFinishedManager(ToolManager):
    """Manager for mark_atomization_finished phase transition."""
    
    tool_name = "mark_atomization_finished"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Mark atomization phase as complete with decision.
        
        Args in tool_call:
            is_proximate: bool - True if goal is atomic (execute directly),
                                 False if goal needs decomposition (go to PLAN phase)
        
        Yields:
            - Success status with atomization decision
        """
        is_proximate = tool_call.get("is_proximate", False)
        
        if is_proximate:
            message = "Goal is **proximate** (atomic). Transitioning to execution phase..."
            title = "✓ Atomization complete: PROXIMATE"
        else:
            message = "Goal is **not proximate** (needs decomposition). Transitioning to planning phase..."
            title = "✓ Atomization complete: NEEDS DECOMPOSITION"
        
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=title,
            message=message,
            status=MessageStatus.FINISHED,
            metadata={"is_proximate": is_proximate}
        )


# ========================================
# SINGLETON
# ========================================

_manager: Optional[MarkAtomizationFinishedManager] = None


def get_manager() -> MarkAtomizationFinishedManager:
    """Get or create mark_atomization_finished manager singleton."""
    global _manager
    if _manager is None:
        _manager = MarkAtomizationFinishedManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def mark_atomization_finished(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for mark_atomization_finished (event-driven system).
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'is_proximate' bool
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "mark_atomization_finished")

