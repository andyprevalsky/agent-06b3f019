"""
Attempt Completion - Universal completion tool for all agent loops.

This tool signals that the agent believes its current phase/task is complete
and triggers verification. Used by:
- PLAN loop: Agent believes plan is ready
- EXECUTE loop: Agent believes goal is accomplished
- BROWSER loop: Agent believes browser task is done

Replaces:
- progress_to_autonomous_execution_phase (PLAN phase)
- mark_execution_complete (EXECUTE phase)
- close (browser agent)
"""

from typing import Dict, Any, Optional, Callable, Awaitable

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus
from helpers.handle_tool_event import handle_tool_event

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class AttemptCompletionManager(ToolManager):
    """Manager for attempt_completion - universal phase/task completion."""
    
    tool_name = "attempt_completion"
    
    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Signal that the agent believes its task/phase is complete.
        
        The workflow/activity will run the verifier after this to confirm.
        If verification passes, the loop exits. If not, the agent continues.
        
        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Dict with optional 'reasoning' field
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking
            
        Returns:
            Dict indicating completion was attempted
        """
        reasoning = tool_call.get("reasoning", "")
        
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="✓ Attempting completion",
                message=reasoning or "Running verifier to check completion...",
                status=MessageStatus.FINISHED
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="attempt_completion",
            execute_activity=execute_activity,
            user_id=user_id,
        )
        
        return {"attempted": True, "reasoning": reasoning}


_manager: Optional[AttemptCompletionManager] = None


def get_manager() -> AttemptCompletionManager:
    global _manager
    if _manager is None:
        _manager = AttemptCompletionManager()
    return _manager


async def attempt_completion(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute attempt_completion tool.
    
    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with optional 'reasoning' parameter
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking
        
    Returns:
        Dict indicating completion was attempted
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
