"""
Mark Research Finished - Phase transition marker tool.

This tool signals the transition from RESEARCH phase to ATOMIZE phase.
It doesn't perform any action - it just marks the research phase as complete.
"""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import workflow

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus


class MarkResearchFinishedManager(ToolManager):
    """Manager for mark_research_finished phase transition."""
    
    tool_name = "mark_research_finished"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Mark research phase as complete.
        
        This tool simply signals the workflow to transition to ATOMIZE phase.
        No actual work is performed.
        
        Yields:
            - Success status indicating research phase is complete
        """
        # Just emit a success event - the workflow will detect this tool call
        # and transition to ATOMIZE phase
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="✓ Research phase complete",
            message="Transitioning to atomization phase...",
            status=MessageStatus.FINISHED
        )


# ========================================
# SINGLETON
# ========================================

_manager: Optional[MarkResearchFinishedManager] = None


def get_manager() -> MarkResearchFinishedManager:
    """Get or create mark_research_finished manager singleton."""
    global _manager
    if _manager is None:
        _manager = MarkResearchFinishedManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def mark_research_finished(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for mark_research_finished (event-driven system).
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict (no parameters needed)
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "mark_research_finished")

