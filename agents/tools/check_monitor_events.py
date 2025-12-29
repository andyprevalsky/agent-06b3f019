"""Check Monitor Events tool - migrated to event-driven architecture."""

from typing import Dict, Any, Optional, Callable, Awaitable
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx
import time

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message
from helpers.handle_tool_event import handle_tool_event

# Config import is safe - no side effects at import time (load_dotenv is lazy)
from config import load_config

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


class CheckMonitorEventsManager(ToolManager):
    """Manager for checking Monitor events using Parallel AI's Monitor API."""
    
    tool_name = "check_monitor_events"
    read_only = True  # Research phase tool
    
    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute event check and post events via handle_tool_event.
        
        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with 'monitor_id', 'limit'
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking
            
        Returns:
            Result dict with events
        """
        monitor_id = tool_call.get("monitor_id", "")
        limit = tool_call.get("limit", 10)
        
        # Track start time for elapsed time calculation
        start_time = _safe_time()
        
        # Validate monitor_id format
        if not monitor_id.startswith("monitor_"):
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Check events failed",
                    message=f"Invalid monitor_id format. Expected format: 'monitor_...'",
                    status=MessageStatus.ERROR
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="check_monitor_events",
                execute_activity=execute_activity,
                user_id=user_id,
            )
            return {"error": "Invalid monitor_id format", "events": []}
        
        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="📋 Checking monitor events",
                message=f"Monitor ID: {monitor_id}\nLimit: {limit}",
                status=MessageStatus.IN_PROGRESS
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="check_monitor_events",
            execute_activity=execute_activity,
            user_id=user_id,
        )
        
        # 2. Execute check events activity
        try:
            logger.info("Calling check_monitor_events_activity", monitor_id=monitor_id, limit=limit)
            result = await execute_activity(
                check_monitor_events_activity,
                args=[monitor_id, limit],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )
            
            # 3. Calculate elapsed time and cost
            elapsed_time = _safe_time() - start_time
            total_cost_cents = 0  # Checking events is typically free or minimal cost
            
            # Format success message using standardized format
            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=total_cost_cents
            )
            
            # Post-execution success
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Monitor events retrieved",
                    message=message,
                    status=MessageStatus.FINISHED
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="check_monitor_events",
                execute_activity=execute_activity,
                user_id=user_id,
            )
            
            return result
            
        except Exception as e:
            # Calculate elapsed time even on error
            elapsed_time = _safe_time() - start_time
            
            # Format error message using standardized format
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0
            )
            
            # Error status
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Check events failed",
                    message=error_message,
                    status=MessageStatus.ERROR
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="check_monitor_events",
                execute_activity=execute_activity,
                user_id=user_id,
            )
            
            return {"error": str(e), "events": []}


# ========================================
# SINGLETON
# ========================================

_manager: Optional[CheckMonitorEventsManager] = None


def get_manager() -> CheckMonitorEventsManager:
    """Get or create Check Monitor Events manager singleton."""
    global _manager
    if _manager is None:
        _manager = CheckMonitorEventsManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================

async def check_monitor_events(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute check_monitor_events tool.
    
    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'monitor_id', 'limit'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking
        
    Returns:
        Result dict with events
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )


# ========================================
# TEMPORAL ACTIVITY
# ========================================

@activity.defn
async def check_monitor_events_activity(monitor_id: str, limit: int = 10) -> Dict[str, Any]:
    """
    Activity: Check events from a monitor using Parallel AI's Monitor API.
    
    Retrieves recent events detected by a monitor.
    
    Args:
        monitor_id: ID from a previous monitor call
        limit: Maximum number of events to return
        
    Returns:
        Dict with:
            - events: List of events
    """
    try:
        try:
            activity.heartbeat(f"Checking events for monitor: {monitor_id}")
        except RuntimeError:
            pass  # Not in activity context (testing)
        
        config = load_config()
        api_key = config.parallel.api_key
        base_url = "https://api.parallel.ai"
        
        headers = {
            "x-api-key": api_key,
            "Content-Type": "application/json"
        }
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            # Get events from monitor
            # Note: API endpoint may vary - check docs for exact path
            # Assuming: GET /v1alpha/monitors/{monitor_id}/events
            response = await client.get(
                f"{base_url}/v1alpha/monitors/{monitor_id}/events",
                headers=headers,
                params={"limit": limit}
            )
            response.raise_for_status()
            data = response.json()
            
            events = data.get("events", [])
            
            logger.info("Monitor events retrieved", monitor_id=monitor_id, events_count=len(events))
            
            return {
                "events": events
            }
            
    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Check Monitor Events API error", error=error_msg, monitor_id=monitor_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Check Monitor Events failed", error=str(e), monitor_id=monitor_id)
        raise
