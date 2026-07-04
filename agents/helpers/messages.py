"""Activity for polling new messages from the database.

Uses _fetch_agent_data_impl from fetch_config.py (single source for GET /api/agents/{agent_id}).
"""

import asyncio
import os
from contextlib import suppress
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

import httpx
import structlog
from temporalio import activity

from config import load_config
from helpers.context_compaction import project_model_context_after_compaction
from helpers.context_scope import filter_internal_subagent_messages
from helpers.fetch_config import _fetch_agent_data_impl
from helpers.tracing import span

logger = structlog.get_logger()

# In dev (non-production), use public channels since agents live in a local DB
_is_production = os.environ.get("FLY_APP_NAME") is not None

# How often the coalescing broadcaster flushes accumulated stream deltas.
# Decouples token reading from the Supabase round-trip (see da938195 diagnosis:
# per-chunk inline broadcasts collapsed per-stream throughput under fan-out).
_STREAM_COALESCE_INTERVAL_S = float(os.getenv("STREAM_COALESCE_INTERVAL_S", "0.15"))

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
    sub_agent_id: str = None,
    is_claude: bool = False,
    is_gpt: bool = False,
    llm_started_at_ms: int | None = None,
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
        is_claude: Whether the model is a Claude/Anthropic model
        is_gpt: Whether the model is direct GPT/Codex
        llm_started_at_ms: Epoch ms when the LLM request started
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

        # Include is_claude marker for frontend thinking animation theming
        if is_claude:
            record["is_claude"] = True
        if is_gpt:
            record["is_gpt"] = True
        if llm_started_at_ms is not None:
            record["llm_started_at_ms"] = llm_started_at_ms

        payload = {
            "messages": [{
                "topic": f"agent:{agent_id}",
                "event": "ASSISTANT_STREAM",
                "payload": {
                    "record": record
                },
                "private": _is_production  # Required for broadcasting to private channels
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


class CoalescingStreamBroadcaster:
    """Decouples LLM token reading from Supabase stream broadcasting.

    The original path awaited a Supabase broadcast inside the token-read loop on
    every ~18 chars (run_agent.on_chunk → handle_tool_event → stream_assistant_chunk).
    Under high agent fan-out (e.g. 50 sub-agents) those inline awaits funnelled
    through one shared httpx client and, when contended, blocked token reading —
    collapsing per-stream throughput from ~60 tok/s to ~1-3 tok/s while TTFT
    stayed flat (root-caused on agent da938195).

    This broadcaster fixes that: ``update()`` is non-blocking — it only appends to
    a pending buffer and ensures a background drainer is running. The drainer
    flushes the accumulated delta at most once per ``interval_s``. Token reading
    therefore never waits on a broadcast. Broadcasts are best-effort UI updates;
    the authoritative message is persisted separately, so dropping/merging
    intermediate deltas is safe (the FE appends deltas, so concatenation is
    equivalent to sending each delta individually).

    Lifecycle: create before streaming, ``update()`` per chunk, ``reset()`` if the
    stream restarts (parse retry), and ``await aclose(...)`` exactly once when the
    stream finishes (sends the final delta + done marker synchronously).
    """

    def __init__(
        self,
        *,
        agent_id: str,
        stream_id: str,
        sub_agent_id: Optional[str] = None,
        llm_started_at_ms: Optional[int] = None,
        is_claude: "bool | Callable[[], bool]" = False,
        is_gpt: "bool | Callable[[], bool]" = False,
        interval_s: float = _STREAM_COALESCE_INTERVAL_S,
    ) -> None:
        self._agent_id = agent_id
        self._stream_id = stream_id
        self._sub_agent_id = sub_agent_id
        self._llm_started_at_ms = llm_started_at_ms
        # bool or zero-arg callable — model flags are detected mid-stream, so the
        # caller can pass a ref (lambda) read at flush time, not construction.
        self._is_claude = is_claude
        self._is_gpt = is_gpt
        self._interval_s = interval_s
        self._pending: List[str] = []
        self._sequence = 0
        self._drainer: Optional[asyncio.Task] = None
        self._closed = False

    def update(self, delta: str, sequence: int) -> None:
        """Record a new delta. Non-blocking — never awaits a broadcast."""
        if self._closed or not delta:
            return
        self._pending.append(delta)
        self._sequence = sequence
        if self._drainer is None:
            self._drainer = asyncio.create_task(self._drain_loop())

    def reset(self) -> None:
        """Drop buffered deltas when the stream restarts (e.g. parse retry)."""
        self._pending.clear()
        self._sequence = 0

    async def adispose(self) -> None:
        """Stop the drainer without sending a done marker. Idempotent — safe to
        call in a finally to guarantee the background task never leaks on error."""
        self._closed = True
        if self._drainer is not None:
            self._drainer.cancel()
            with suppress(asyncio.CancelledError):
                await self._drainer
            self._drainer = None

    async def _drain_loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(self._interval_s)
                await self._flush()
        except asyncio.CancelledError:
            pass

    def _flags(self) -> "tuple[bool, bool]":
        ic = self._is_claude() if callable(self._is_claude) else self._is_claude
        ig = self._is_gpt() if callable(self._is_gpt) else self._is_gpt
        return bool(ic), bool(ig)

    async def _flush(self) -> None:
        if not self._pending:
            return
        delta = "".join(self._pending)
        self._pending.clear()
        is_claude, is_gpt = self._flags()
        async with span(
            "stream.broadcast",
            agent_id=self._agent_id,
            stream_id=self._stream_id,
            chars=len(delta),
            coalesced=True,
        ):
            await stream_assistant_chunk(
                agent_id=self._agent_id,
                stream_id=self._stream_id,
                delta=delta,
                done=False,
                sequence=self._sequence,
                sub_agent_id=self._sub_agent_id,
                is_claude=is_claude,
                is_gpt=is_gpt,
                llm_started_at_ms=self._llm_started_at_ms,
            )

    async def aclose(self, *, final_delta: str = "", final_sequence: Optional[int] = None) -> None:
        """Stop the drainer, flush any remainder, then send the done marker."""
        self._closed = True
        if self._drainer is not None:
            self._drainer.cancel()
            with suppress(asyncio.CancelledError):
                await self._drainer
            self._drainer = None
        # Flush whatever the drainer hadn't sent yet (best-effort).
        with suppress(Exception):
            await self._flush()
        done_seq = final_sequence if final_sequence is not None else self._sequence + 1
        is_claude, is_gpt = self._flags()
        with suppress(Exception):
            async with span(
                "stream.broadcast",
                agent_id=self._agent_id,
                stream_id=self._stream_id,
                done=True,
            ):
                await stream_assistant_chunk(
                    agent_id=self._agent_id,
                    stream_id=self._stream_id,
                    delta=final_delta,
                    done=True,
                    sequence=done_seq,
                    sub_agent_id=self._sub_agent_id,
                    is_claude=is_claude,
                    is_gpt=is_gpt,
                    llm_started_at_ms=self._llm_started_at_ms,
                )


async def stream_plan_event(
    agent_id: str,
    stream_id: str,
    tool_call_id: str,
    title: str,
    char_count: int = 0,
    llm_started_at_ms: int | None = None,
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
        llm_started_at_ms: Epoch ms when the planner LLM request started
    """
    try:

        config = load_config()

        broadcast_url = f"{config.supabase.url}/realtime/v1/api/broadcast"

        record = {
            "agentId": agent_id,
            "stream_id": stream_id,
            "tool_call_id": tool_call_id,
            "title": title,
            "char_count": char_count,
        }
        if llm_started_at_ms is not None:
            record["llm_started_at_ms"] = llm_started_at_ms

        payload = {
            "messages": [{
                "topic": f"agent:{agent_id}",
                "event": "PLAN_STREAM",
                "payload": {
                    "record": record
                },
                "private": _is_production
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
    char_count: int = 0,
    is_claude: bool = False,
    is_gpt: bool = False,
    llm_started_at_ms: int | None = None,
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
        char_count: Current raw character count streamed while forming the tool call
        is_claude: Whether the model is a Claude/Anthropic model
        is_gpt: Whether the model is direct GPT/Codex
        llm_started_at_ms: Epoch ms when the LLM request started
    """
    try:
        config = load_config()
        
        broadcast_url = f"{config.supabase.url}/realtime/v1/api/broadcast"
        
        # Broadcast as TOOL_STREAM event (ephemeral, like PLAN_STREAM)
        # Frontend will show this as streaming indicator after thinking bubble
        record = {
            "agentId": agent_id,
            "stream_id": stream_id,
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "title": title,
            "char_count": char_count,
        }
        if is_claude:
            record["is_claude"] = True
        if is_gpt:
            record["is_gpt"] = True
        if llm_started_at_ms is not None:
            record["llm_started_at_ms"] = llm_started_at_ms

        payload = {
            "messages": [{
                "topic": f"agent:{agent_id}",
                "event": "TOOL_STREAM",
                "payload": {
                    "record": record
                },
                "private": _is_production
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
                "private": _is_production
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


async def stream_browser_cursor(
    agent_id: str,
    task_id: str,
    x: int,
    y: int,
    sequence: int = 0,
    timestamp_ms: int | None = None,
) -> None:
    """
    Broadcast browser cursor position DIRECTLY to Supabase Realtime.

    This is intentionally ephemeral like ASSISTANT_STREAM/TOOL_STREAM: the durable
    browser action messages still carry coordinates for replay/fallback, while this
    stream keeps the live React cursor synced to synthesized mouse motion.
    """
    try:
        config = load_config()
        broadcast_url = f"{config.supabase.url}/realtime/v1/api/broadcast"
        record = {
            "agentId": agent_id,
            "taskId": task_id,
            "x": int(x),
            "y": int(y),
            "sequence": sequence,
        }
        if timestamp_ms is not None:
            record["timestampMs"] = timestamp_ms

        payload = {
            "messages": [{
                "topic": f"agent:{agent_id}",
                "event": "BROWSER_CURSOR",
                "payload": {"record": record},
                "private": _is_production
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
            logger.debug(f"Browser cursor stream broadcast failed: status={response.status_code}")
    except Exception as e:
        logger.debug(f"Browser cursor stream error (non-fatal): {str(e)}")


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
                "private": _is_production
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
                            "private": _is_production
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
                        "Bus broadcast success",
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
        
        # Use the single fetch_agent_data implementation with server-side filtering
        data = await _fetch_agent_data_impl(agent_id, since=last_checked.isoformat())
        new_messages = data.get('messages', [])
        new_messages = project_model_context_after_compaction(new_messages)

        # Drop sub-agent internal work-stream rows before crossing the activity
        # boundary. Every downstream caller filters them anyway (see
        # loop/context_utils.py and workflows/agent_workflow.py); doing it here
        # keeps the Temporal payload under the 2 MB cap when sub-agents have
        # produced large transcripts (e.g. post-DAG verifier polling from epoch).
        new_messages = filter_internal_subagent_messages(new_messages)

        if new_messages:
            logger.info(
                f"New messages found: agent_id={agent_id}, count={len(new_messages)}, roles={set(m['role'] for m in new_messages)}"
            )

        return new_messages
        
    except Exception as e:
        logger.error(
            f"Failed to poll messages: agent_id={agent_id}, error={str(e)}"
        )
        raise


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
