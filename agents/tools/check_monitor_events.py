"""Check Monitor Events tool - migrated to event-driven architecture."""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx
import time

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message

# Import config with safe imports to avoid sandbox restrictions
with workflow.unsafe.imports_passed_through():
    from config import load_config

logger = structlog.get_logger()


class CheckMonitorEventsManager(ToolManager):
    """Manager for checking Monitor events using Parallel AI's Monitor API."""
    
    tool_name = "check_monitor_events"
    read_only = True  # Research phase tool
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute event check and yield events.
        
        Yields:
            - Pre-execution status
            - Post-execution status with events
        """
        monitor_id = tool_call.get("monitor_id", "")
        limit = tool_call.get("limit", 10)
        
        # Track start time for elapsed time calculation
        start_time = time.time()
        
        # Validate monitor_id format
        if not monitor_id.startswith("monitor_"):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Check events failed",
                message=f"Invalid monitor_id format. Expected format: 'monitor_...'",
                status=MessageStatus.ERROR
            )
            return
        
        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="📋 Checking monitor events",
            message=f"Monitor ID: {monitor_id}\nLimit: {limit}",
            status=MessageStatus.IN_PROGRESS
        )
        
        # 2. Execute check events activity
        try:
            logger.info("Calling check_monitor_events_activity", monitor_id=monitor_id, limit=limit)
            result = await workflow.execute_activity(
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
            elapsed_time = time.time() - start_time
            total_cost_cents = 0  # Checking events is typically free or minimal cost
            
            # Format success message using standardized format
            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=total_cost_cents
            )
            
            # Post-execution success
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Monitor events retrieved",
                message=message,
                status=MessageStatus.FINISHED
            )
            
        except Exception as e:
            # Calculate elapsed time even on error
            elapsed_time = time.time() - start_time
            
            # Format error message using standardized format
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0
            )
            
            # Error status
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Check events failed",
                message=error_message,
                status=MessageStatus.ERROR
            )
            # Don't raise - error event already posted the formatted message


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
# WORKFLOW HELPER
# ========================================

async def check_monitor_events(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for Check Monitor Events (new event-driven system).
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'monitor_id', 'limit'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "check_monitor_events")


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

