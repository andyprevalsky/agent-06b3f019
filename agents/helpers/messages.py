"""Activity for polling new messages from the database.

Uses _fetch_agent_data_impl from fetch_config.py (single source for GET /api/agents/{agent_id}).
"""

from temporalio import activity
from typing import List, Dict, Any, Optional
from datetime import datetime
import structlog
import httpx

from config import load_config
from helpers.fetch_config import _fetch_agent_data_impl

logger = structlog.get_logger()

# Module-level HTTP client for streaming broadcasts (connection reuse)
_broadcast_client: Optional[httpx.AsyncClient] = None


def _get_broadcast_client() -> httpx.AsyncClient:
    """Get or create the shared HTTP client for streaming broadcasts."""
    global _broadcast_client
    if _broadcast_client is None:
        _broadcast_client = httpx.AsyncClient(timeout=2.0)
    return _broadcast_client


async def stream_assistant_chunk(
    agent_id: str,
    stream_id: str,
    delta: str,
    done: bool = False,
    sequence: int = 0,
    sub_agent_id: str = None
) -> None:
    """
    Send a streaming delta DIRECTLY to Supabase Realtime (bypasses backend).
    
    This is NOT a Temporal activity - it's called directly during LLM streaming
    to minimize latency. Uses Supabase Realtime broadcast REST API with connection reuse.
    
    Args:
        agent_id: The agent ID
        stream_id: Unique ID for this streaming session
        delta: The NEW text chunk (not accumulated - just the delta)
        done: Whether this is the final chunk
        sequence: Sequence number for ordering
        sub_agent_id: Optional sub-agent ID (e.g., browser task_id) for routing to specific MessageList
    """
    try:
        config = load_config()
        
        # Broadcast directly to Supabase Realtime (skip backend for speed)
        # https://supabase.com/docs/guides/realtime/broadcast#send-messages-using-rest-api
        broadcast_url = f"{config.supabase.url}/realtime/v1/api/broadcast"
        
        record = {
            "agentId": agent_id,
            "stream_id": stream_id,
            "delta": delta,  # Send delta, not accumulated text
            "done": done,
            "sequence": sequence,
        }

        # Include sub_agent_id if provided (for routing to browser panel's MessageList)
        if sub_agent_id:
            record["subAgentId"] = sub_agent_id
        
        payload = {
            "messages": [{
                "topic": f"agent:{agent_id}",
                "event": "ASSISTANT_STREAM",
                "payload": {
                    "record": record
                },
                "private": True  # Required for broadcasting to private channels
            }]
        }
        
        # Use service role key to broadcast to private channels (DB triggers use private)
        # Fall back to anon_key if service role key not configured
        broadcast_key = config.supabase.service_role_key or config.supabase.anon_key
        
        # Use shared client for connection reuse (much faster for rapid chunks)
        client = _get_broadcast_client()
        response = await client.post(
            broadcast_url,
            json=payload,
            headers={
                "apikey": broadcast_key,
                "Authorization": f"Bearer {broadcast_key}",
                "Content-Type": "application/json"
            }
        )
        
        if response.status_code not in (200, 202):
            logger.debug(f"Stream broadcast failed: status={response.status_code}")
                
    except Exception as e:
        # Don't fail the workflow if streaming fails - it's best-effort
        logger.debug(f"Stream chunk error (non-fatal): {str(e)}")


async def stream_plan_event(
    agent_id: str,
    stream_id: str,
    tool_call_id: str,
    title: str,
    char_count: int = 0,
) -> None:
    """
    Broadcast plan streaming state DIRECTLY to Supabase Realtime (no DB insert).

    This is used to show the PlanChip with shimmer effect during LLM streaming,
    without creating a database record. The FINISHED state comes later via
    normal tool execution which does create a DB record.

    Args:
        agent_id: The agent ID
        stream_id: Unique ID for this streaming session (same as assistant stream)
        tool_call_id: The tool_call_id that will be used for the final set_plan
        title: The plan title (or "Generating Plan" initially)
        char_count: Current character count of plan content being generated
    """
    try:

        config = load_config()

        broadcast_url = f"{config.supabase.url}/realtime/v1/api/broadcast"

        payload = {
            "messages": [{
                "topic": f"agent:{agent_id}",
                "event": "PLAN_STREAM",
                "payload": {
                    "record": {
                        "agentId": agent_id,
                        "stream_id": stream_id,
                        "tool_call_id": tool_call_id,
                        "title": title,
                        "char_count": char_count,
                    }
                },
                "private": True
            }]
        }
        
        broadcast_key = config.supabase.service_role_key or config.supabase.anon_key
        
        client = _get_broadcast_client()
        response = await client.post(
            broadcast_url,
            json=payload,
            headers={
                "apikey": broadcast_key,
                "Authorization": f"Bearer {broadcast_key}",
                "Content-Type": "application/json"
            }
        )
        
        if response.status_code not in (200, 202):
            logger.debug(f"Plan stream broadcast failed: status={response.status_code}")
                
    except Exception as e:
        # Don't fail the workflow if streaming fails - it's best-effort
        logger.debug(f"Plan stream error (non-fatal): {str(e)}")


async def stream_tool_event(
    agent_id: str,
    stream_id: str,
    tool_call_id: str,
    tool_name: str,
    title: str,
) -> None:
    """
    Broadcast early tool detection as TOOL_STREAM event (ephemeral, no DB insert).
    
    This is used to show early tool indicators during LLM streaming, before tool
    parameters are fully parsed. Uses TOOL_STREAM event (like PLAN_STREAM) so the
    frontend shows it as ephemeral state AFTER the streaming bubble, not as a
    real message that would sort before the assistant message.
    
    Args:
        agent_id: The agent ID
        stream_id: Unique ID for this streaming session
        tool_call_id: The tool_call_id that will be used for the final tool execution
        tool_name: Name of the tool being called
        title: The display title (e.g., "Starting web_search...")
    """
    try:
        config = load_config()
        
        broadcast_url = f"{config.supabase.url}/realtime/v1/api/broadcast"
        
        # Broadcast as TOOL_STREAM event (ephemeral, like PLAN_STREAM)
        # Frontend will show this as streaming indicator after thinking bubble
        payload = {
            "messages": [{
                "topic": f"agent:{agent_id}",
                "event": "TOOL_STREAM",
                "payload": {
                    "record": {
                        "agentId": agent_id,
                        "stream_id": stream_id,
                        "tool_call_id": tool_call_id,
                        "tool_name": tool_name,
                        "title": title,
                    }
                },
                "private": True
            }]
        }
        
        broadcast_key = config.supabase.service_role_key or config.supabase.anon_key
        
        client = _get_broadcast_client()
        response = await client.post(
            broadcast_url,
            json=payload,
            headers={
                "apikey": broadcast_key,
                "Authorization": f"Bearer {broadcast_key}",
                "Content-Type": "application/json"
            }
        )
        
        if response.status_code not in (200, 202):
            logger.debug(f"Tool stream broadcast failed: status={response.status_code}")
                
    except Exception as e:
        # Don't fail the workflow if streaming fails - it's best-effort
        logger.debug(f"Tool stream error (non-fatal): {str(e)}")


async def stream_attention_event(
    agent_id: str,
    stream_id: str,
    tool_call_id: str,
    message: str,
    is_question: bool = True,
    done: bool = False,
    sequence: int = 0,
) -> None:
    """
    Broadcast attention message streaming DIRECTLY to Supabase Realtime.
    
    This streams send_message_to_user content progressively so the frontend
    can show the attention message being generated.
    
    Args:
        agent_id: The agent ID
        stream_id: Unique ID for this streaming session
        tool_call_id: The tool_call_id for the send_message_to_user call
        message: The current message content (accumulated, not delta)
        is_question: Whether this is a blocking question or FYI
        done: Whether streaming is complete
        sequence: Sequence number for ordering
    """
    try:
        
        config = load_config()
        
        broadcast_url = f"{config.supabase.url}/realtime/v1/api/broadcast"
        
        payload = {
            "messages": [{
                "topic": f"agent:{agent_id}",
                "event": "ATTENTION_STREAM",
                "payload": {
                    "record": {
                        "agentId": agent_id,
                        "stream_id": stream_id,
                        "tool_call_id": tool_call_id,
                        "message": message,
                        "is_question": is_question,
                        "done": done,
                        "sequence": sequence,
                    }
                },
                "private": True
            }]
        }
        
        broadcast_key = config.supabase.service_role_key or config.supabase.anon_key
        
        client = _get_broadcast_client()
        response = await client.post(
            broadcast_url,
            json=payload,
            headers={
                "apikey": broadcast_key,
                "Authorization": f"Bearer {broadcast_key}",
                "Content-Type": "application/json"
            }
        )
        
        if response.status_code not in (200, 202):
            logger.debug(f"Attention stream broadcast failed: status={response.status_code}")
                
    except Exception as e:
        # Don't fail the workflow if streaming fails - it's best-effort
        logger.debug(f"Attention stream error (non-fatal): {str(e)}")


async def broadcast_to_bus(bus_id: str, payload: Dict[str, Any]) -> None:
    """
    Broadcast agent state update to the shared bus channel.

    This is used for real-time sub-agent tree updates. All agents in a tree
    share the same bus_id and broadcast their state changes to this channel.
    The frontend subscribes to the bus to get real-time updates for tree rendering.

    Args:
        bus_id: Shared bus channel ID (typically root agent's ID)
        payload: State update payload containing:
            - agentId: The agent broadcasting the update
            - parentAgentId: Parent agent ID (for tree structure)
            - goal: Agent's goal
            - status: Current agent status
            - progress: Progress value (0.0-1.0)
            - toolsInUse: List of currently active tools
            - messageCount: Total message count
    """
    try:
        config = load_config()

        broadcast_url = f"{config.supabase.url}/realtime/v1/api/broadcast"

        broadcast_payload = {
            "messages": [{
                "topic": f"bus:{bus_id}",
                "event": "AGENT_STATE_CHANGED",
                "payload": {"record": payload},
                "private": True
            }]
        }

        broadcast_key = config.supabase.service_role_key or config.supabase.anon_key

        logger.info(
            "Broadcasting to bus",
            bus_id=bus_id,
            agent_id=payload.get("agentId"),
            status=payload.get("status"),
            tools_in_use=payload.get("toolsInUse"),
        )

        client = _get_broadcast_client()
        response = await client.post(
            broadcast_url,
            json=broadcast_payload,
            headers={
                "apikey": broadcast_key,
                "Authorization": f"Bearer {broadcast_key}",
                "Content-Type": "application/json"
            }
        )

        if response.status_code not in (200, 202):
            logger.warning(f"Bus broadcast failed: status={response.status_code}, body={response.text}")
        else:
            logger.debug(f"Bus broadcast success: status={response.status_code}")

    except Exception as e:
        # Don't fail the workflow if broadcast fails - it's best-effort
        logger.warning(f"Bus broadcast error (non-fatal): {str(e)}")


@activity.defn
async def update_agent_tree_state(
    agent_id: str,
    tools_in_use: List[str],
    bus_id: str = None,
    broadcast_payload: Dict[str, Any] = None,
) -> None:
    """
    Persist tree state (toolsInUse) to the database AND broadcast to Supabase bus.

    Called from _update_tree_state in the workflow to keep the DB in sync
    and provide real-time updates to the frontend.

    Args:
        agent_id: The agent ID
        tools_in_use: List of currently active tool names
        bus_id: Optional bus channel ID for real-time broadcast
        broadcast_payload: Optional payload for bus broadcast
    """
    config = load_config()

    # 1. Broadcast to Supabase bus (real-time updates)
    if bus_id and broadcast_payload:
        try:
            broadcast_url = f"{config.supabase.url}/realtime/v1/api/broadcast"
            broadcast_key = config.supabase.service_role_key or config.supabase.anon_key

            async with httpx.AsyncClient() as client:
                response = await client.post(
                    broadcast_url,
                    json={
                        "messages": [{
                            "topic": f"bus:{bus_id}",
                            "event": "AGENT_STATE_CHANGED",
                            "payload": {"record": broadcast_payload},
                            # Private channel - matches agent: channel pattern
                            "private": True
                        }]
                    },
                    headers={
                        "apikey": broadcast_key,
                        "Authorization": f"Bearer {broadcast_key}",
                        "Content-Type": "application/json"
                    },
                    timeout=5.0
                )

                if response.status_code not in (200, 202):
                    logger.warning(f"Bus broadcast failed: status={response.status_code}")
                else:
                    logger.info(
                        f"Bus broadcast success",
                        agent_id=agent_id,
                        bus_id=bus_id,
                        topic=f"bus:{bus_id}",
                        tools=broadcast_payload.get("toolsInUse", []),
                    )

        except Exception as e:
            logger.warning(f"Bus broadcast error (non-fatal): {str(e)}")

    # 2. Persist to database (tools_in_use, progress, messageCount)
    try:
        activity.heartbeat(f"Updating tree state for agent {agent_id}")

        # Build update payload from broadcast_payload if available
        update_payload = {"tools_in_use": tools_in_use}
        if broadcast_payload:
            if "progress" in broadcast_payload:
                update_payload["progress"] = broadcast_payload["progress"]
            if "messageCount" in broadcast_payload:
                update_payload["message_count"] = broadcast_payload["messageCount"]
            # Only persist status to DB when explicitly set (not default ACTIVE/PAUSED)
            if broadcast_payload.get("_statusExplicit") and "status" in broadcast_payload:
                update_payload["status"] = broadcast_payload["status"]

        async with httpx.AsyncClient() as client:
            response = await client.patch(
                f"{config.backend.api_url}/api/agents/{agent_id}",
                json=update_payload,
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json"
                },
                timeout=10.0
            )

            if response.status_code not in (200, 204):
                logger.debug(f"Tree state update failed: status={response.status_code}")

    except Exception as e:
        # Don't fail the workflow if update fails - it's best-effort
        logger.debug(f"Tree state update error (non-fatal): {str(e)}")


@activity.defn
async def poll_new_messages(agent_id: str, last_checked: datetime) -> List[Dict[str, Any]]:
    """
    Poll for ALL new messages (USER, ASSISTANT, TOOL) since last check.
    
    This allows the agent to rebuild context from DB, including tool messages
    that were posted via handle_tool_event.
    
    Args:
        agent_id: The agent ID
        last_checked: Timestamp of last check (use epoch 0 for first poll)
        
    Returns:
        List of new messages (all roles) after last_checked
    """
    try:
        activity.heartbeat(f"Polling messages for agent {agent_id}")
        
        logger.info(
            f"Polling for new messages: agent_id={agent_id}, last_checked={last_checked.isoformat()}"
        )
        
        # Use the single fetch_agent_data implementation
        data = await _fetch_agent_data_impl(agent_id)
        messages = data.get('messages', [])
        
        # Filter for ALL messages after last_checked (not just USER)
        new_messages = [
            msg for msg in messages
            if datetime.fromisoformat(msg['timestamp'].replace('Z', '+00:00')) > last_checked
        ]
        
        if new_messages:
            logger.info(
                f"New messages found: agent_id={agent_id}, count={len(new_messages)}, roles={set(m['role'] for m in new_messages)}"
            )
        
        return new_messages
        
    except Exception as e:
        logger.error(
            f"Failed to poll messages: agent_id={agent_id}, error={str(e)}"
        )
        return []


@activity.defn
async def post_agent_message(
    agent_id: str,
    text: str,
    role: str = "ASSISTANT",
    metadata: Dict[str, Any] | None = None,
    file_pointer: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """
    Post a message from the agent back to the database.

    Args:
        agent_id: The agent ID
        text: Message text
        role: Message role (ASSISTANT, TOOL, SYSTEM)
        metadata: Optional JSON metadata (tool type, sub-agent ID, etc)
        file_pointer: Optional FilePointer dict for file attachment messages

    Returns:
        Created message data
    """
    try:
        activity.heartbeat(f"Posting message for agent {agent_id}")

        config = load_config()

        payload = {
            "message": text,
            "role": role
        }

        # Add metadata if provided
        if metadata:
            payload["metadata"] = metadata

        # Add file_pointer for file attachment messages (OAI-style)
        if file_pointer:
            payload["file_pointer"] = file_pointer
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                json=payload,
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json"
                },
                timeout=30.0
            )
            if response.status_code != 201:
                logger.error(
                    f"Failed to post message - HTTP error: agent_id={agent_id}, status_code={response.status_code}, response_body={response.text}, payload={payload}"
                )
            
            response.raise_for_status()
            
            message = response.json()
            
            logger.info(
                f"Message posted: agent_id={agent_id}, message_id={message.get('message_id')}, role={role}, has_metadata={metadata is not None}"
            )
            
            return message
            
    except Exception as e:
        logger.error(
            f"Failed to post message: agent_id={agent_id}, error={str(e)}"
        )
        raise

