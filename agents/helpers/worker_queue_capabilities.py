"""Record the workflow types this worker registers for its task queue (at worker start).

    worker start ─▶ PUT /api/agent-queue-pointer/capabilities {task_queue, workflow_types}

The backend checks a queue serves a workflow type before starting one that only
newer workers register (the code/browser resume runs): a deploy whose Fly lane is
held leaves the pointer on old workers, and a run started there would be stranded
(back-end/src/providers/workerQueueCapabilities.ts). Idempotent (a merge per queue)
and never blocking: it runs in the background and retries with capped backoff until
it is recorded (workers may activate before the backend that serves the route).
"""

from __future__ import annotations

import asyncio
from typing import Iterable, List, Optional

import structlog
from temporalio import workflow

from config import load_config
from helpers.http_client import get_http_client

logger = structlog.get_logger()

# Backoff between attempts; the last delay repeats until it is recorded.
RETRY_DELAYS_SECONDS = (2.0, 5.0, 15.0, 30.0, 60.0)


async def _sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


def workflow_type_names(workflow_classes: Iterable[type]) -> List[str]:
    """The registered Temporal workflow type names (the @workflow.defn names)."""
    names = []
    for cls in workflow_classes:
        definition = workflow._Definition.must_from_class(cls)
        if definition.name:
            names.append(definition.name)
    return sorted(set(names))


async def record_worker_queue_capabilities(
    task_queue: str, workflow_classes: Iterable[type], max_attempts: Optional[int] = None
) -> bool:
    """PUT this queue's workflow types to the backend until recorded; True once it is.

    ``max_attempts`` (tests) bounds the attempts; production retries until success.
    """
    config = load_config()
    types = workflow_type_names(workflow_classes)
    attempt = 0
    while max_attempts is None or attempt < max_attempts:
        if attempt > 0:
            await _sleep(RETRY_DELAYS_SECONDS[min(attempt - 1, len(RETRY_DELAYS_SECONDS) - 1)])
        attempt += 1
        try:
            response = await get_http_client().put(
                f"{config.backend.api_url.rstrip('/')}/api/agent-queue-pointer/capabilities",
                json={"task_queue": task_queue, "workflow_types": types},
                headers={"X-API-Key": config.backend.api_key, "Content-Type": "application/json"},
                timeout=15.0,
            )
            response.raise_for_status()
            logger.info("Recorded worker queue capabilities", task_queue=task_queue, workflow_types=types)
            return True
        except Exception as error:  # keep retrying: an unrecorded queue refuses resume starts
            logger.warning(
                "Could not record worker queue capabilities; retrying",
                task_queue=task_queue,
                attempt=attempt,
                error=str(error)[:200],
            )
    return False
