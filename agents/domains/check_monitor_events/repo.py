"""Check monitor events domain data access.

Temporal activity for fetching monitor events from Parallel AI.
Imports: own types, own config, external packages.
"""

from __future__ import annotations

import contextlib
from typing import Any, Dict

import httpx
import structlog
from temporalio import activity

from config import load_config

from .config import EVENTS_PATH_TEMPLATE, HTTP_TIMEOUT_SECONDS, PARALLEL_API_BASE_URL

logger = structlog.get_logger()


@activity.defn
async def check_monitor_events_activity(monitor_id: str, limit: int = 10) -> Dict[str, Any]:
    """Activity: Check events from a monitor using Parallel AI's Monitor API.

    Retrieves recent events detected by a monitor.

    Args:
        monitor_id: ID from a previous monitor call.
        limit: Maximum number of events to return.

    Returns:
        Dict with 'events' list.
    """
    try:
        with contextlib.suppress(RuntimeError):
            activity.heartbeat(f"Checking events for monitor: {monitor_id}")

        config = load_config()
        api_key = config.parallel.api_key

        headers = {"x-api-key": api_key, "Content-Type": "application/json"}

        path = EVENTS_PATH_TEMPLATE.format(monitor_id=monitor_id)

        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
            response = await client.get(
                f"{PARALLEL_API_BASE_URL}{path}",
                headers=headers,
                params={"limit": limit},
            )
            response.raise_for_status()
            data = response.json()

            events = data.get("events", [])

            logger.info("Monitor events retrieved", monitor_id=monitor_id, events_count=len(events))

            return {"events": events}

    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Check Monitor Events API error", error=error_msg, monitor_id=monitor_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Check Monitor Events failed", error=str(e), monitor_id=monitor_id)
        raise
