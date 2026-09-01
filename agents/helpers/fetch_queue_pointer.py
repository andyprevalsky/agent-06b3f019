"""Activity: fetch the live AgentQueuePointer for cooperative generation handoff."""

from __future__ import annotations

from typing import Any, Dict

import httpx
import structlog
from temporalio import activity

from config import load_config

logger = structlog.get_logger()
config = load_config()


@activity.defn
async def fetch_agent_queue_pointer() -> Dict[str, Any]:
    """Return the live routing pointer ``{task_queue, surface_hash}``.

    Used at the top of each ``run_agent`` iteration (before the next LLM call)
    so a workflow can cooperatively ``continue_as_new`` onto a new generation
    queue after the current tool/LLM/browser activity has finished.
    """
    backend_url = config.backend.api_url.rstrip("/")
    backend_api_key = config.backend.api_key
    if not backend_api_key:
        raise RuntimeError("BACKEND_API_KEY not configured")

    url = f"{backend_url}/api/agent-queue-pointer"
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            url,
            headers={
                "X-API-Key": backend_api_key,
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()
        payload = response.json()

    task_queue = payload.get("taskQueue") or payload.get("task_queue")
    surface_hash = payload.get("surfaceHash") or payload.get("surface_hash")
    if not isinstance(task_queue, str) or not task_queue.strip():
        raise RuntimeError(f"agent-queue-pointer response missing taskQueue: {payload!r}")

    result = {
        "task_queue": task_queue.strip(),
        "surface_hash": (surface_hash.strip() if isinstance(surface_hash, str) else "") or None,
    }
    logger.info(
        "Fetched agent queue pointer",
        task_queue=result["task_queue"],
        surface_hash=result["surface_hash"],
    )
    return result
