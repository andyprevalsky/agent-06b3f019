"""Monitor domain repo — data access via Parallel AI Monitor API."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, Optional

import httpx
import structlog

from config import load_config
from domains.monitor.config import BASE_URL, CREATE_ENDPOINT, REQUEST_TIMEOUT_SECONDS

if TYPE_CHECKING:
    from domains.monitor.types import MonitorActivityResult

logger = structlog.get_logger()


async def create_monitor(
    query: str,
    cadence: str,
    webhook_url: Optional[str] = None,
    metadata: Optional[Dict[str, str]] = None,
) -> MonitorActivityResult:
    """Create a monitor via the Parallel AI Monitor API.

    Args:
        query: Natural language query describing what to monitor.
        cadence: Frequency of monitoring (hourly/daily/weekly).
        webhook_url: Optional URL for webhook notifications.
        metadata: Optional metadata dict (keys/values must be strings).

    Returns:
        Dict with monitor_id and status.

    Raises:
        ValueError: On HTTP errors from the API.
    """
    config = load_config()
    api_key = config.parallel.api_key

    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }

    payload: Dict[str, Any] = {
        "query": query,
        "cadence": cadence,
    }

    if webhook_url:
        payload["webhook"] = webhook_url

    if metadata:
        payload["metadata"] = metadata

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f"{BASE_URL}{CREATE_ENDPOINT}",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
            data = response.json()

            monitor_id = data.get("monitor_id") or data.get("id")
            if not monitor_id:
                raise ValueError("No monitor_id returned from API")

            logger.info("Monitor created", monitor_id=monitor_id, cadence=cadence)

            # Handle status - could be string or dict
            status = data.get("status", {})
            if isinstance(status, str):
                status = {"status": status}

            return {"monitor_id": monitor_id, "status": status}

    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Monitor API error", error=error_msg, query=query)
        raise ValueError(error_msg) from e
    except ValueError:
        raise
    except Exception as e:
        logger.error("Monitor creation failed", error=str(e), query=query)
        raise
