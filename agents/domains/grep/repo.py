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

_GREP_HTTP_KEY_ALIASES = {
    "before": "-B",
    "after": "-A",
    "context_c": "-C",
    "line_numbers": "-n",
    "case_insensitive": "-i",
}
_GREP_INTERNAL_KEYS = {"tool", "tool_call_id"}


def _normalize_grep_payload(grep_params: Dict[str, Any]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    for key, value in grep_params.items():
        if key in _GREP_INTERNAL_KEYS or value is None:
            continue
        payload[_GREP_HTTP_KEY_ALIASES.get(key, key)] = value
    return payload


@activity.defn
async def grep_activity(
    grep_params: Dict[str, Any],
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> GrepResult:
    """
    Activity: Search user's local data via backend POST /api/data/grep.

    Args:
        grep_params: Grep request payload. Exposed keys are pattern, source,
            -A, -B, -C, context, -n, -i, head_limit, offset, multiline.
        user_id: User ID for auth
        agent_id: Agent ID for current-tree agent_network scoping

    Returns:
        Dict with matches, total_matches, truncated, message
    """
    try:
        pattern = str(grep_params.get("pattern", ""))
        source = grep_params.get("source", "all")
        activity.heartbeat(f"Searching {source} for: {pattern[:80]}")

        config = load_config()

        payload = _normalize_grep_payload(grep_params)
        if user_id:
            payload["user_id"] = user_id
        if agent_id:
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
            pattern=str(grep_params.get("pattern", ""))[:LOG_PATTERN_MAX_LENGTH],
            source=grep_params.get("source", "all"),
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
        transactions = sources.get("transactions", {})

        total_threads = messages.get("total_threads", 0)
        total_messages = messages.get("total_messages", 0)
        total_transactions = transactions.get("total_transactions", 0)

        if total_messages == 0 and total_transactions == 0:
            summary = "No local data available."
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

        transaction_lines = []
        if total_transactions > 0:
            transaction_date_range = transactions.get("date_range", {})
            transaction_from_date = (
                transaction_date_range.get("from", "")[:10] if transaction_date_range.get("from") else "?"
            )
            transaction_to_date = (
                transaction_date_range.get("to", "")[:10] if transaction_date_range.get("to") else "?"
            )
            institutions = transactions.get("institutions", [])
            institution_str = ", ".join(institutions) if institutions else "unknown"
            transaction_lines = [
                "",
                f"transactions/                          {transactions.get('account_count', 0)} accounts, {total_transactions:,} transactions",
                f"  Institutions: {institution_str}",
                f"  Date range: {transaction_from_date} → {transaction_to_date}",
            ]

        summary = f"""LOCAL DATA SOURCES:

messages/                              {total_threads} threads, {total_messages:,} messages
  Channels: {channel_str}
  Date range: {from_date} → {to_date}
  Threads by volume:
{chr(10).join(thread_lines)}{chr(10).join(transaction_lines)}"""

        _data_summary_cache[user_id] = {"summary": summary, "fetched_at": now}
        return summary

    except Exception as e:
        logger.error("Failed to fetch local data summary", user_id=user_id[:8], error=str(e))
        return ""
