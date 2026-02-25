"""
Wait/sleep tool - migrated to new event-driven architecture.
"""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import workflow
from datetime import timedelta
import structlog

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus

logger = structlog.get_logger()


def format_duration(seconds: int) -> str:
    """
    Format seconds into human-readable duration.
    Examples: "5 seconds", "2 minutes", "3 hours", "1 day"
    """
    if seconds < 60:
        return f"{seconds} second{'s' if seconds != 1 else ''}"
    elif seconds < 3600:
        minutes = seconds / 60
        if minutes == int(minutes):
            minutes = int(minutes)
            return f"{minutes} minute{'s' if minutes != 1 else ''}"
        else:
            return f"{minutes:.1f} minutes"
    elif seconds < 86400:
        hours = seconds / 3600
        if hours == int(hours):
            hours = int(hours)
            return f"{hours} hour{'s' if hours != 1 else ''}"
        else:
            return f"{hours:.1f} hours"
    else:
        days = seconds / 86400
        if days == int(days):
            days = int(days)
            return f"{days} day{'s' if days != 1 else ''}"
        else:
            return f"{days:.1f} days"


class WaitSecondsManager(ToolManager):
    """Manager for wait/sleep operations."""
    
    tool_name = "wait_seconds"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute wait and yield events.
        
        Yields:
            - Pre-execution status
            - Post-execution status
        """
        seconds = tool_call.get("seconds", 1)
        
        # Validate seconds
        if seconds < 1 or seconds > 2_678_400:  # 30 days in seconds
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Invalid wait duration",
                message=f"Wait duration must be between 1 and 3600 seconds (got {seconds})",
                status=MessageStatus.ERROR
            )
            return
        
        duration = format_duration(seconds)
        
        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"⏱️ Waiting {duration}",
            message="",
            status=MessageStatus.IN_PROGRESS
        )
        
        # 2. Execute wait using workflow.sleep (deterministic)
        try:
            await workflow.sleep(seconds)
        except Exception as e:
            # Error status
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Wait failed",
                message=str(e),
                status=MessageStatus.ERROR
            )
            return
        
        # 3. Success status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"✓ Waited {duration}",
            message="",
            status=MessageStatus.FINISHED
        )


# ========================================
# SINGLETON
# ========================================

_manager: Optional[WaitSecondsManager] = None


def get_manager() -> WaitSecondsManager:
    """Get or create wait seconds manager singleton."""
    global _manager
    if _manager is None:
        _manager = WaitSecondsManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def wait_seconds(workflow_instance, tool_call: Dict[str, Any], tool_call_id: str):
    """
    Workflow helper for wait_seconds (new event-driven system).

    This replaces the old wait_seconds function.
    Yields events instead of returning a value.
    """
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "wait_seconds")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
    return last_status

