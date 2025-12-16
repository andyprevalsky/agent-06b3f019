"""Activity for polling new messages from the database.

Uses _fetch_agent_data_impl from fetch_config.py (single source for GET /api/agents/{agent_id}).
"""

from temporalio import activity
from typing import List, Dict, Any, Optional
from datetime import datetime
import structlog
import httpx

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
    sequence: int = 0
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
    """
    try:
        from config import load_config
        
        config = load_config()
        
        # Broadcast directly to Supabase Realtime (skip backend for speed)
        # https://supabase.com/docs/guides/realtime/broadcast#send-messages-using-rest-api
        broadcast_url = f"{config.supabase.url}/realtime/v1/api/broadcast"
        
        payload = {
            "messages": [{
                "topic": f"agent:{agent_id}",
                "event": "ASSISTANT_STREAM",
                "payload": {
                    "record": {
                        "stream_id": stream_id,
                        "delta": delta,  # Send delta, not accumulated text
                        "done": done,
                        "sequence": sequence,
                    }
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


@activity.defn
async def poll_new_messages(agent_id: str, last_checked: datetime) -> List[Dict[str, Any]]:
    """
    Poll for new user messages since last check.
    
    Args:
        agent_id: The agent ID
        last_checked: Timestamp of last check
        
    Returns:
        List of new messages with role=USER
    """
    try:
        activity.heartbeat(f"Polling messages for agent {agent_id}")
        
        logger.info(
            f"Polling for new messages: agent_id={agent_id}, last_checked={last_checked.isoformat()}"
        )
        
        # Use the single fetch_agent_data implementation
        data = await _fetch_agent_data_impl(agent_id)
        messages = data.get('messages', [])
        
        # Filter for USER messages after last_checked
        new_messages = [
            msg for msg in messages
            if msg['role'] == 'USER' and 
            datetime.fromisoformat(msg['timestamp'].replace('Z', '+00:00')) > last_checked
        ]
        
        if new_messages:
            logger.info(
                f"New messages found: agent_id={agent_id}, count={len(new_messages)}"
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
    metadata: Dict[str, Any] | None = None
) -> Dict[str, Any]:
    """
    Post a message from the agent back to the database.
    
    Args:
        agent_id: The agent ID
        text: Message text
        role: Message role (ASSISTANT, TOOL, SYSTEM)
        metadata: Optional JSON metadata (tool type, sub-agent ID, etc)
        
    Returns:
        Created message data
    """
    try:
        activity.heartbeat(f"Posting message for agent {agent_id}")
        
        import httpx
        from config import load_config
        
        config = load_config()
        
        payload = {
            "message": text,
            "role": role
        }
        
        # Add metadata if provided
        if metadata:
            payload["metadata"] = metadata
        
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

