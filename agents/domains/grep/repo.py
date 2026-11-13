"""Grep domain repo - data access via backend HTTP endpoints."""

from typing import Any, Dict, Optional

import structlog
from temporalio import activity

from config import load_config
from domains.grep.config import (
    GREP_HTTP_TIMEOUT,
    LOG_PATTERN_MAX_LENGTH,
    SUMMARY_HTTP_TIMEOUT,
)
from domains.grep.types import GrepResult
from helpers.http_client import get_http_client

logger = structlog.get_logger()

# Compatibility export for existing callers; authorization-bearing summaries are never cached.
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

        response = await get_http_client().post(
            f"{config.backend.api_url}/api/data/grep",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id or "",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=GREP_HTTP_TIMEOUT,
        )

        # Propagate backend errors with descriptive messages. The backend's grep
        # tool executor owns the summary source and the literal retry of an
        # invalid regex, so every grep surface shares them.
        if response.status_code != 200:
            error_data = response.json()
            raise ValueError(error_data.get("message", error_data.get("error", f"HTTP {response.status_code}")))
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
    Fetch the inventory of the user's local data (grep source ``summary``).
    Always fresh: the inventory includes revocable team account grants.

    The backend renders it, so this text and grep ``sources=["summary"]`` are
    one rendering. Returns formatted string for injection into explore agent
    system prompt; empty string when the backend is unreachable.
    """
    # Inventory contains team grants; fetch fresh on every exploration so a
    # revoked membership never survives in the five-minute prompt cache.

    config = load_config()
    try:
        response = await get_http_client().post(
            f"{config.backend.api_url}/api/data/grep",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
                "Content-Type": "application/json",
            },
            json={"sources": ["summary"], "user_id": user_id},
            timeout=SUMMARY_HTTP_TIMEOUT,
        )
        response.raise_for_status()
        summary = str(response.json().get("message") or "No local data available.")
        return summary

    except Exception as e:
        logger.error("Failed to fetch local data summary", user_id=user_id[:8], error=str(e))
        return ""
