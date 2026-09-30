"""Durable progress handoff from an explore activity to its parent workflow."""

from typing import Any, Dict, Optional

import structlog
from temporalio import activity
from temporalio.client import Client

logger = structlog.get_logger()
_temporal_client: Optional[Client] = None


def set_temporal_client(client: Optional[Client]) -> None:
    global _temporal_client
    _temporal_client = client


async def send_explore_progress(task_id: str, payload: Dict[str, Any]) -> None:
    """Checkpoint evidence in workflow history before an activity can be canceled."""
    if not _temporal_client or not task_id or not payload.get("result"):
        return
    try:
        workflow_id = activity.info().workflow_id
        await _temporal_client.get_workflow_handle(workflow_id).signal(
            "record_explore_progress", {"task_id": task_id, "payload": payload}
        )
    except Exception as exc:
        # Heartbeat details remain a fallback when a signal cannot be delivered.
        logger.warning("Explore progress checkpoint failed", task_id=task_id, error=str(exc))
