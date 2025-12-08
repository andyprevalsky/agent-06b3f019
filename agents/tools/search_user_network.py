"""Search user network tool - migrated to event-driven architecture."""

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


class SearchUserNetworkManager(ToolManager):
    """Manager for search_user_network_for_people tool."""
    
    tool_name = "search_user_network_for_people"
    read_only = True  # Research phase tool
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute network search and yield events.
        
        Yields:
            - Pre-execution status with search criteria
            - Post-execution status with results
        """
        # Extract search criteria for display
        first_name = tool_call.get("first_name") or ""
        last_name = tool_call.get("last_name") or ""
        full_name = f"{first_name} {last_name}".strip()
        
        # Build display title - use name if provided, otherwise use "contacts"
        title_name = full_name if full_name else "contacts"
        if len(title_name) > 40:
            title_name = title_name[:37] + "..."
        
        # Track start time for elapsed time calculation
        start_time = time.time()
        
        # Extract user_id from workflow instance
        user_id = workflow_instance.user_id
        
        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"🔍 Searching network for {title_name}",
            message=self._format_search_criteria(tool_call),
            status=MessageStatus.IN_PROGRESS,
            metadata={"progressComplete": 0}
        )
        
        # 2. Execute search activity
        try:
            logger.info("Calling search_user_network_activity", user_id=user_id, first_name=first_name, last_name=last_name)
            
            result = await workflow.execute_activity(
                search_user_network_activity,
                args=[user_id, tool_call],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )
            
            # 3. Calculate elapsed time (no cost for internal backend call)
            elapsed_time = time.time() - start_time
            total_cost_cents = 0  # Internal backend call, no external API charges
            
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
                title=f"Network search completed: {title_name}",
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
                title=f"❌ Network search failed: {title_name}",
                message=error_message,
                status=MessageStatus.ERROR
            )
            # Don't raise - error event already posted the formatted message
    
    def _format_search_criteria(self, tool_call: Dict[str, Any]) -> str:
        """Format search criteria for display in pre-message."""
        parts = []
        
        first_name = tool_call.get("first_name", "")
        last_name = tool_call.get("last_name", "")
        if first_name or last_name:
            parts.append(f"Name: {first_name} {last_name}".strip())
        
        if tool_call.get("profession"):
            parts.append(f"Profession: {tool_call['profession']}")
        if tool_call.get("company"):
            parts.append(f"Company: {tool_call['company']}")
        if tool_call.get("title"):
            parts.append(f"Title: {tool_call['title']}")
        if tool_call.get("industry"):
            parts.append(f"Industry: {tool_call['industry']}")
        if tool_call.get("location"):
            parts.append(f"Location: {tool_call['location']}")
        if tool_call.get("relation"):
            parts.append(f"Relationship: {tool_call['relation']}")
        if tool_call.get("skills"):
            skills = tool_call['skills']
            if isinstance(skills, list):
                parts.append(f"Skills: {', '.join(skills[:5])}")
        
        return "\n".join(parts) if parts else "Searching all contacts..."


# ========================================
# SINGLETON
# ========================================

_manager: Optional[SearchUserNetworkManager] = None


def get_manager() -> SearchUserNetworkManager:
    """Get or create search user network manager singleton."""
    global _manager
    if _manager is None:
        _manager = SearchUserNetworkManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def search_user_network_for_people(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for network search (event-driven system).
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with person signals (first_name, last_name, etc.)
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "search_user_network_for_people")


# ========================================
# TEMPORAL ACTIVITY
# ========================================

@activity.defn
async def search_user_network_activity(
    user_id: str,
    tool_call: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Activity: Search user's network for people matching criteria.
    
    Calls the backend /api/people/search endpoint which performs
    semantic/embedding-based search across the user's stored contacts.
    
    Args:
        user_id: Supabase user ID
        tool_call: Dict with person signals (first_name, last_name, profession, etc.)
        
    Returns:
        Dict with:
            - results: List of matching people with similarity scores
            - count: Number of matches found
            - query: Original query signals
    """
    try:
        activity.heartbeat("Starting network search")
        
        # Extract person signals from tool_call (exclude internal fields)
        person_signals = {
            k: v for k, v in tool_call.items() 
            if k not in ('tool', 'tool_call_id') and v is not None
        }
        
        config = load_config()
        
        # Call backend API to perform semantic search
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/people/search",
                json=person_signals,
                headers={
                    "X-API-Key": config.backend.api_key,
                    "X-User-Id": user_id,
                },
            )
            
            activity.heartbeat("Search request sent")
            
            if response.status_code != 200:
                error_detail = response.text
                logger.error("Network search failed", status=response.status_code, error=error_detail)
                raise ValueError(f"Backend API error ({response.status_code}): {error_detail}")
            
            result = response.json()
            results = result.get('results', [])
            count = result.get('count', 0)
            
            activity.heartbeat(f"Found {count} matches")
            
            logger.info(
                "Network search completed",
                user_id=user_id,
                count=count,
                query_keys=list(person_signals.keys())
            )
            
            return {
                "results": results,
                "count": count,
                "query": person_signals
            }
    
    except httpx.TimeoutException:
        logger.error("Network search timeout", user_id=user_id)
        raise ValueError("Request timed out while searching network")
    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Network search HTTP error", error=error_msg, user_id=user_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Network search error", error=str(e), user_id=user_id)
        raise
