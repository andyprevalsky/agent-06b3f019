"""Monitor tool - migrated to event-driven architecture."""

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


class MonitorManager(ToolManager):
    """Manager for Monitor operations using Parallel AI's Monitor API."""
    
    tool_name = "monitor"
    
    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute monitor creation and post events via handle_tool_event.
        
        Args:
            execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
            tool_call: Tool call dict with 'query', 'cadence', etc.
            tool_call_id: Unique ID for this tool call
            agent_id: Agent ID for event routing
            user_id: User ID for usage tracking
            
        Returns:
            Result dict with monitor_id
        """
        query = tool_call.get("query", "")
        cadence = tool_call.get("cadence", "daily")
        # Convert enum to string if needed
        if hasattr(cadence, 'value'):
            cadence = cadence.value
        webhook_url = tool_call.get("webhook_url")
        metadata = tool_call.get("metadata")
        
        # Truncate long queries for display in title
        title_query = query if len(query) <= 50 else query[:47] + "..."
        
        # Track start time for elapsed time calculation
        start_time = _safe_time()
        
        # Truncate long queries for display in message
        display_query = query if len(query) <= 100 else query[:97] + "..."
        
        # 1. Pre-execution status with verbose title
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"📡 Creating monitor: {title_query}",
                message=f"Query: {display_query}\nCadence: {cadence}",
                status=MessageStatus.IN_PROGRESS
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="monitor",
            execute_activity=execute_activity,
            user_id=user_id,
        )
        
        # 2. Execute monitor creation activity
        try:
            logger.info("Calling monitor_activity", query_len=len(query), cadence=cadence)
            result = await execute_activity(
                monitor_activity,
                args=[query, cadence, webhook_url, metadata],
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
            # Monitor API pricing: $3 per 1,000 requests = $0.003 per request
            # Source: https://parallel.ai/pricing
            total_cost_cents = 0.3  # $0.003 per request

            # Format success message using standardized format
            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=total_cost_cents
            )
            
            # Post-execution success with verbose title
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Monitor created: {title_query}",
                    message=message,
                    status=MessageStatus.FINISHED
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="monitor",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            # Return with standardized usage for workflow cost tracking
            return {
                "result": result,
                "usage": {
                    "llm": [],
                    "service": [{"cost_cents": int(total_cost_cents), "provider": "Parallel Monitor API"}],
                }
            }
            
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
            
            # Error status with verbose title
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"❌ Monitor creation failed: {title_query}",
                    message=error_message,
                    status=MessageStatus.ERROR
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="monitor",
                execute_activity=execute_activity,
                user_id=user_id,
            )
            
            return {
                "result": {"error": str(e)},
                "usage": {"llm": [], "service": []},
            }


# ========================================
# SINGLETON
# ========================================

_manager: Optional[MonitorManager] = None


def get_manager() -> MonitorManager:
    """Get or create Monitor manager singleton."""
    global _manager
    if _manager is None:
        _manager = MonitorManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================

async def monitor(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute monitor tool.
    
    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'query', 'cadence', 'webhook_url', 'metadata'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking
        
    Returns:
        Result dict with monitor_id
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
async def monitor_activity(
    query: str,
    cadence: str = "daily",
    webhook_url: Optional[str] = None,
    metadata: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    """
    Activity: Create a monitor using Parallel AI's Monitor API.
    
    Creates a monitor that tracks the web for material changes on a schedule.
    Monitor creation is synchronous and returns immediately with a monitor_id.
    
    Args:
        query: Natural language query describing what to monitor
        cadence: Frequency of monitoring (hourly/daily/weekly)
        webhook_url: Optional URL for webhook notifications
        metadata: Optional metadata dict (keys/values must be strings)
        
    Returns:
        Dict with:
            - monitor_id: ID of the created monitor
            - status: Status information
    """
    try:
        try:
            activity.heartbeat(f"Creating monitor: {query[:50]}...")
        except RuntimeError:
            pass  # Not in activity context (testing)
        
        config = load_config()
        api_key = config.parallel.api_key
        base_url = "https://api.parallel.ai"
        
        headers = {
            "x-api-key": api_key,
            "Content-Type": "application/json"
        }
        
        # Check if beta header is needed (may vary by API version)
        # Using v1alpha endpoint based on docs
        payload = {
            "query": query,
            "cadence": cadence
        }
        
        if webhook_url:
            payload["webhook"] = webhook_url
        
        if metadata:
            payload["metadata"] = metadata
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{base_url}/v1alpha/monitors",
                headers=headers,
                json=payload
            )
            response.raise_for_status()
            data = response.json()
            
            monitor_id = data.get("monitor_id") or data.get("id")
            if not monitor_id:
                raise ValueError("No monitor_id returned from API")
            
            logger.info("Monitor created", monitor_id=monitor_id, cadence=cadence)
            
            # Handle status - could be string or dict
            status = data.get("status", {})
            if isinstance(status, str):
                status = {"status": status}
            
            return {
                "monitor_id": monitor_id,
                "status": status
            }
            
    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Monitor API error", error=error_msg, query=query)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Monitor creation failed", error=str(e), query=query)
        raise
