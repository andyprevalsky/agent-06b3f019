"""Grep tool - search user's local data (message threads, etc.)

Follows the NEW_SIGNATURE pattern (like web_search):
  (execute_activity, tool_call, tool_call_id, agent_id, user_id) -> Dict

Calls POST /api/data/grep on the backend, which uses ILIKE + trigram indexes
for fast case-insensitive text search.

TODO: Full regex support skipped for now. ILIKE + trigram indexes are fast and cover
the majority of use cases. Arbitrary regex bypasses trigram indexes and causes full
table scans. If we add regex later, the backend validates the pattern and returns
descriptive failure messages that propagate to the LLM.
"""

from typing import Dict, Any, Optional, Callable, Awaitable
from temporalio import activity
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx
import time

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message
from helpers.handle_tool_event import handle_tool_event
from config import load_config

ExecuteActivityCallable = Callable[..., Awaitable[Any]]

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox."""
    try:
        return time.time()
    except Exception:
        return 0.0


class GrepManager(ToolManager):
    """Manager for grep operations over user's local data."""

    tool_name = "grep"
    read_only = True

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute grep search and post events via handle_tool_event."""
        pattern = tool_call.get("pattern", "")
        source = tool_call.get("source", "messages")
        person_id = tool_call.get("person_id")
        since = tool_call.get("since")

        display_pattern = pattern if len(pattern) <= 80 else pattern[:77] + "..."

        start_time = _safe_time()

        # IN_PROGRESS
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Grep: {display_pattern}" if display_pattern else "Grep: all messages",
                message="",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="grep",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        try:
            logger.info(
                "Calling grep_activity",
                pattern=pattern[:100],
                source=source,
                person_id=person_id[:8] if person_id else None,
                since=since,
            )

            result = await execute_activity(
                grep_activity,
                args=[pattern, source, person_id, since, user_id, agent_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=2,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=5),
                ),
            )

            elapsed_time = _safe_time() - start_time

            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=0,
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Grep: {display_pattern}" if display_pattern else "Grep completed",
                    message=message,
                    status=MessageStatus.FINISHED,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="grep",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": result,
                "usage": {
                    "llm": [],
                    "service": [],
                },
            }

        except Exception as e:
            elapsed_time = _safe_time() - start_time

            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0,
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Grep failed: {display_pattern}" if display_pattern else "Grep failed",
                    message=error_message,
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="grep",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[GrepManager] = None


def get_manager() -> GrepManager:
    global _manager
    if _manager is None:
        _manager = GrepManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================

async def grep(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute grep tool."""
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
async def grep_activity(
    pattern: str,
    source: str = "messages",
    person_id: Optional[str] = None,
    since: Optional[str] = None,
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Activity: Search user's local data via backend POST /api/data/grep.

    Args:
        pattern: Text to search for (plain text, not regex). Empty string returns all.
        source: Data source to search (default: "messages")
        person_id: Optional person ID to scope search to one thread
        since: Optional ISO 8601 timestamp cutoff. Defaults to 365 days ago.
        user_id: User ID for auth

    Returns:
        Dict with matches, total_matches, truncated, message
    """
    try:
        activity.heartbeat(f"Searching {source} for: {pattern[:80]}")

        config = load_config()

        payload: Dict[str, Any] = {
            "pattern": pattern,
            "source": source,
        }
        if since:
            payload["since"] = since
        if person_id:
            payload["person_id"] = person_id
        if user_id:
            payload["user_id"] = user_id
        if agent_id and source.startswith("agent_network_"):
            payload["agent_id"] = agent_id

        async with httpx.AsyncClient(timeout=25.0) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/data/grep",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "X-User-Id": user_id or "",
                    "Content-Type": "application/json",
                },
                json=payload,
            )

            # Propagate backend errors with descriptive messages
            if response.status_code != 200:
                error_data = response.json()
                error_msg = error_data.get("message", error_data.get("error", f"HTTP {response.status_code}"))
                raise ValueError(error_msg)

            data = response.json()

        total_matches = data.get("total_matches", 0)
        truncated = data.get("truncated", False)

        logger.info(
            "Grep completed",
            pattern=pattern[:80],
            source=source,
            total_matches=total_matches,
            threads=len(data.get("matches", [])),
            truncated=truncated,
        )

        return data

    except ValueError:
        raise
    except Exception as e:
        logger.error(
            "Grep failed",
            error=str(e),
            pattern=pattern[:80],
            source=source,
        )
        raise


# ========================================
# FETCH LOCAL DATA SUMMARY (for explore agent system prompt)
# ========================================

# Module-level cache
_data_summary_cache: Dict[str, Dict[str, Any]] = {}


@activity.defn
async def fetch_local_data_summary(user_id: str) -> str:
    """
    Fetch a filesystem-like summary of user's local data.
    Cached with 5-minute TTL.

    Returns formatted string for injection into explore agent system prompt.
    """
    from datetime import datetime

    global _data_summary_cache

    now = datetime.utcnow()
    if user_id in _data_summary_cache:
        cached = _data_summary_cache[user_id]
        from datetime import timedelta as td
        if (now - cached["fetched_at"]) < td(minutes=5):
            return cached["summary"]

    config = load_config()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                f"{config.backend.api_url}/api/data/summary",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "X-User-Id": user_id,
                },
            )
            response.raise_for_status()
            data = response.json()

        sources = data.get("sources", {})
        messages = sources.get("messages", {})

        total_threads = messages.get("total_threads", 0)
        total_messages = messages.get("total_messages", 0)

        if total_messages == 0:
            summary = "No local message data available."
            _data_summary_cache[user_id] = {"summary": summary, "fetched_at": now}
            return summary

        # Format channels
        channels = messages.get("channels", {})
        channel_str = ", ".join(f"{ch} ({count})" for ch, count in channels.items()) if channels else "unknown"

        # Format date range
        date_range = messages.get("date_range", {})
        from_date = date_range.get("from", "")[:10] if date_range.get("from") else "?"
        to_date = date_range.get("to", "")[:10] if date_range.get("to") else "?"

        # Format top threads
        threads = messages.get("threads", [])
        thread_lines = []
        for t in threads[:15]:  # Top 15 by volume
            thread_lines.append(
                f"    {t['name']:40s} {t['message_count']:>4d} msgs  (last: {t['last_message']})"
            )
        remaining = len(threads) - 15
        if remaining > 0:
            thread_lines.append(f"    ... {remaining} more threads")

        summary = f"""LOCAL DATA SOURCES:

messages/                              {total_threads} threads, {total_messages:,} messages
  Channels: {channel_str}
  Date range: {from_date} → {to_date}
  Threads by volume:
{chr(10).join(thread_lines)}"""

        _data_summary_cache[user_id] = {"summary": summary, "fetched_at": now}
        return summary

    except Exception as e:
        logger.error("Failed to fetch local data summary", user_id=user_id[:8], error=str(e))
        return ""
