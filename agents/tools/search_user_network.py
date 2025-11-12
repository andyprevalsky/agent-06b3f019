"""Tool for searching user's network for people matching specific criteria."""

import httpx
from typing import Any, Dict, AsyncGenerator
from temporalio import activity, workflow
import structlog

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus
from config import load_config

logger = structlog.get_logger()

# ========================================
# TOOL MANAGER
# ========================================

class SearchUserNetworkManager(ToolManager):
    """Manager for search_user_network_for_people tool."""
    
    @property
    def tool_name(self) -> str:
        return "search_user_network_for_people"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Search user's network for people matching the given signals.
        
        Args:
            workflow_instance: The workflow instance
            tool_call: Dict with person signals (18-signal structure)
            tool_call_id: Unique ID for this tool call
            
        Yields:
            ToolEvent objects with search progress and results
        """
        # Extract user_id and agent_id from workflow instance
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id
        
        # Pre-message: Show what we're searching for
        pre_message = format_pre_message(tool_call)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=pre_message["title"],
            message=pre_message["message"],
            status=MessageStatus.IN_PROGRESS,
        )
        
        # Execute the search activity
        try:
            result = await workflow_instance._execute_activity(
                search_user_network_activity,
                args=[user_id, agent_id, tool_call],
                start_to_close_timeout=workflow.timedelta(seconds=30),
            )
            
            # Post-message: Show results
            post_message = format_post_message(tool_call, result)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=post_message["title"],
                message=post_message["message"],
                status=MessageStatus.FINISHED,
                metadata=result if isinstance(result, dict) else None,
            )
            
        except Exception as e:
            logger.error("Network search failed", error=str(e))
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Network Search Failed",
                message=f"Error searching network: {str(e)}",
                status=MessageStatus.ERROR,
            )


# Singleton manager instance
_manager: SearchUserNetworkManager | None = None

def get_manager() -> SearchUserNetworkManager:
    """Get or create the singleton manager instance."""
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
        tool_call: Tool call dict with person signals
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
    agent_id: str,
    tool_call: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Activity: Search user's network for people matching criteria.
    
    Args:
        user_id: Supabase user ID
        agent_id: Agent ID for tracking
        tool_call: Dict with person signals
        
    Returns:
        Dict with search results or error
    """
    try:
        activity.heartbeat("Starting network search")
        
        # Extract person signals from tool_call
        person_signals = {
            k: v for k, v in tool_call.items() 
            if k != 'tool' and v is not None
        }
        
        # Validate required fields
        if not person_signals.get('first_name') or not person_signals.get('last_name'):
            return {
                "error": "first_name and last_name are required",
                "count": 0,
                "results": []
            }
        
        config = load_config()
        
        # Call backend API to perform search
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
                return {
                    "error": f"API error: {error_detail}",
                    "count": 0,
                    "results": []
                }
            
            result = response.json()
            results = result.get('results', [])
            count = result.get('count', 0)
            
            activity.heartbeat(f"Found {count} matches")
            
            return {
                "results": results,
                "count": count,
                "query": person_signals
            }
    
    except httpx.TimeoutException:
        logger.error("Network search timeout")
        return {
            "error": "Request timed out",
            "count": 0,
            "results": []
        }
    except Exception as e:
        logger.error("Network search error", error=str(e))
        return {
            "error": str(e),
            "count": 0,
            "results": []
        }


# ========================================
# MESSAGE FORMATTERS
# ========================================

def format_pre_message(tool_call: dict[str, Any]) -> dict[str, str]:
    """
    Format the pre-execution message showing search criteria.
    
    Args:
        tool_call: Dict with person signals
        
    Returns:
        Dict with 'title' and 'message'
    """
    # Extract signals
    first_name = tool_call.get('first_name', 'Unknown')
    last_name = tool_call.get('last_name', 'Unknown')
    
    # Build criteria description
    criteria_parts = [f"**Name:** {first_name} {last_name}"]
    
    if tool_call.get('profession'):
        criteria_parts.append(f"**Profession:** {tool_call['profession']}")
    if tool_call.get('company'):
        criteria_parts.append(f"**Company:** {tool_call['company']}")
    if tool_call.get('title'):
        criteria_parts.append(f"**Title:** {tool_call['title']}")
    if tool_call.get('relation'):
        criteria_parts.append(f"**Relationship:** {tool_call['relation']}")
    if tool_call.get('skills'):
        skills = tool_call['skills']
        if isinstance(skills, list):
            criteria_parts.append(f"**Skills:** {', '.join(skills)}")
    if tool_call.get('location'):
        criteria_parts.append(f"**Location:** {tool_call['location']}")
    if tool_call.get('total_online_reach'):
        reach = tool_call['total_online_reach']
        criteria_parts.append(f"**Min Reach:** {reach:,} followers")
    
    criteria_str = "\n".join(criteria_parts)
    
    return {
        "title": "🔍 Searching Your Network",
        "message": f"Looking for people matching these criteria:\n\n{criteria_str}"
    }


def format_post_message(tool_call: dict[str, Any], result: Any) -> dict[str, str]:
    """
    Format the post-execution message with search results.
    
    Args:
        tool_call: Dict with person signals
        result: Result from activity (dict with results/error)
        
    Returns:
        Dict with 'title' and 'message'
    """
    if not isinstance(result, dict):
        return {
            "title": "❌ Network Search Error",
            "message": "Unexpected result format"
        }
    
    # Check for errors
    if result.get('error'):
        return {
            "title": "❌ Network Search Failed",
            "message": f"Error: {result['error']}"
        }
    
    count = result.get('count', 0)
    results = result.get('results', [])
    
    if count == 0:
        return {
            "title": "🔍 Network Search Complete",
            "message": "No matching people found in your network for these criteria."
        }
    
    # Format results for display
    people_list = []
    for person in results:
        first_name = person.get('firstName', 'Unknown')
        last_name = person.get('lastName', 'Unknown')
        full_name = f"{first_name} {last_name}"
        similarity = person.get('similarity', 0)
        
        # Build person summary
        person_str = f"**{full_name}** (Match: {similarity:.2%})"
        
        # Add title/company if available
        if person.get('title') and person.get('company'):
            person_str += f"\n  - {person['title']} at {person['company']}"
        elif person.get('profession'):
            person_str += f"\n  - {person['profession']}"
        
        # Add location if available
        if person.get('location'):
            person_str += f"\n  - 📍 {person['location']}"
        
        # Add relationship info if available
        if person.get('relation'):
            person_str += f"\n  - Relation: {person['relation']}"
        
        # Add contact info
        contact_info = []
        if person.get('email'):
            contact_info.append(f"📧 {person['email']}")
        if person.get('phoneNumber'):
            contact_info.append(f"📱 {person['phoneNumber']}")
        if contact_info:
            person_str += f"\n  - {' | '.join(contact_info)}"
        
        # Add skills if available
        skills = person.get('skills', [])
        if isinstance(skills, list) and skills:
            person_str += f"\n  - Skills: {', '.join(skills[:5])}"  # Top 5 skills
        
        # Add message history summary if available
        msg_counts = []
        if person.get('iMessageHistory'):
            imsg = person['iMessageHistory']
            if isinstance(imsg, list) and imsg:
                msg_counts.append(f"{len(imsg)} iMessages")
        if person.get('emailHistory'):
            emails = person['emailHistory']
            if isinstance(emails, list) and emails:
                msg_counts.append(f"{len(emails)} emails")
        if person.get('messengerHistory'):
            msgs = person['messengerHistory']
            if isinstance(msgs, list) and msgs:
                msg_counts.append(f"{len(msgs)} Messenger")
        if person.get('instagramDmHistory'):
            dms = person['instagramDmHistory']
            if isinstance(dms, list) and dms:
                msg_counts.append(f"{len(dms)} Instagram DMs")
        if msg_counts:
            person_str += f"\n  - History: {', '.join(msg_counts)}"
        
        people_list.append(person_str)
    
    # Build final message
    result_text = f"**Found {count} matching people in your network:**\n\n"
    result_text += "\n\n".join(people_list)
    
    return {
        "title": "✅ Network Search Complete",
        "message": result_text
    }
