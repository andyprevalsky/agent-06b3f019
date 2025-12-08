"""
Mark Planning Finished - Phase transition marker tool.

This tool signals the transition from PLAN phase to SPAWN phase.
It includes the planned subtasks that will be spawned as sub-agents.
"""

from typing import Dict, Any, Optional, AsyncGenerator, List
from temporalio import workflow

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus


class MarkPlanningFinishedManager(ToolManager):
    """Manager for mark_planning_finished phase transition."""
    
    tool_name = "mark_planning_finished"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Mark planning phase as complete with subtasks.
        
        Args in tool_call:
            subtasks: List[Dict] - List of subtask configurations for sub-agents
                Each subtask should have:
                - goal: str - The goal for this sub-agent
                - context: str - Context from parent's research to pass to sub-agent
                - verifier: Dict - Verifier config for this sub-agent
        
        Yields:
            - Success status with planned subtasks summary
        """
        subtasks = tool_call.get("subtasks", [])
        
        if not subtasks:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Planning failed: No subtasks",
                message="At least one subtask is required for decomposition.",
                status=MessageStatus.ERROR
            )
            return
        
        # Validate subtask count (3-5 is recommended)
        subtask_count = len(subtasks)
        if subtask_count < 2:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="⚠️ Planning warning: Too few subtasks",
                message=f"Only {subtask_count} subtask(s) defined. Consider if the goal is actually atomic.",
                status=MessageStatus.FINISHED,
                metadata={"subtasks": subtasks, "subtask_count": subtask_count}
            )
            return
        
        if subtask_count > 7:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="⚠️ Planning warning: Many subtasks",
                message=f"{subtask_count} subtasks defined. Consider consolidating for efficiency.",
                status=MessageStatus.FINISHED,
                metadata={"subtasks": subtasks, "subtask_count": subtask_count}
            )
            return
        
        # Format subtasks for display
        subtask_summaries = []
        for i, subtask in enumerate(subtasks, 1):
            goal = subtask.get("goal", "No goal specified")
            # Truncate long goals
            if len(goal) > 80:
                goal = goal[:77] + "..."
            subtask_summaries.append(f"{i}. {goal}")
        
        message = f"**Planned {subtask_count} parallel subtasks:**\n\n" + "\n".join(subtask_summaries)
        message += "\n\nTransitioning to spawn phase..."
        
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"✓ Planning complete: {subtask_count} subtasks",
            message=message,
            status=MessageStatus.FINISHED,
            metadata={"subtasks": subtasks, "subtask_count": subtask_count}
        )


# ========================================
# SINGLETON
# ========================================

_manager: Optional[MarkPlanningFinishedManager] = None


def get_manager() -> MarkPlanningFinishedManager:
    """Get or create mark_planning_finished manager singleton."""
    global _manager
    if _manager is None:
        _manager = MarkPlanningFinishedManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def mark_planning_finished(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for mark_planning_finished (event-driven system).
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'subtasks' list
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "mark_planning_finished")

