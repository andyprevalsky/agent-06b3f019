"""Grep domain repo - data access via backend HTTP endpoints."""

from datetime import datetime, timedelta
from typing import Any, Dict, Optional

import httpx
import structlog
from temporalio import activity

from config import load_config
from domains.grep.config import (
    GREP_HTTP_TIMEOUT,
    LOG_PATTERN_MAX_LENGTH,
    SUMMARY_CACHE_TTL_MINUTES,
    SUMMARY_HTTP_TIMEOUT,
    SUMMARY_MAX_THREADS,
)
from domains.grep.types import GrepResult

logger = structlog.get_logger()

# Module-level cache for data summaries
_data_summary_cache: Dict[str, Dict[str, Any]] = {}


@activity.defn
async def grep_activity(
    pattern: str,
    source: str = "messages",
    person_id: Optional[str] = None,
    since: Optional[str] = None,
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> GrepResult:
    """
    Activity: Search user's local data via backend POST /api/data/grep.

    Args:
        pattern: Text to search for (plain text, not regex). Empty string returns all.
        source: Data source to search (default: "messages")
        person_id: Optional person ID to scope search to one thread
        since: Optional ISO 8601 timestamp cutoff. Defaults to 365 days ago.
        user_id: User ID for auth
        agent_id: Agent ID (used for agent_network_ source scoping)

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

        async with httpx.AsyncClient(timeout=GREP_HTTP_TIMEOUT) as client:
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
            pattern=pattern[:LOG_PATTERN_MAX_LENGTH],
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
            pattern=pattern[:LOG_PATTERN_MAX_LENGTH],
            source=source,
        )
        raise


@activity.defn
async def fetch_local_data_summary(user_id: str) -> str:
    """
    Fetch a filesystem-like summary of user's local data.
    Cached with 5-minute TTL.

    Returns formatted string for injection into explore agent system prompt.
    """
    global _data_summary_cache

    now = datetime.utcnow()
    if user_id in _data_summary_cache:
        cached = _data_summary_cache[user_id]
        if (now - cached["fetched_at"]) < timedelta(minutes=SUMMARY_CACHE_TTL_MINUTES):
            return cached["summary"]

    config = load_config()
    try:
        async with httpx.AsyncClient(timeout=SUMMARY_HTTP_TIMEOUT) as client:
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
        for t in threads[:SUMMARY_MAX_THREADS]:
            thread_lines.append(f"    {t['name']:40s} {t['message_count']:>4d} msgs  (last: {t['last_message']})")
        remaining = len(threads) - SUMMARY_MAX_THREADS
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
