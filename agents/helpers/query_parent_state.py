"""Activity to query parent workflow state via the Temporal client.

Workflow-to-workflow queries are not supported in Temporal's Python SDK
(ExternalWorkflowHandle only has signal/cancel, not query). This activity
uses the Temporal client — which does support queries — to bridge the gap.

Usage:
    # In worker.py, after connecting:
    from helpers.query_parent_state import set_temporal_client, query_parent_state_activity
    set_temporal_client(client)

    # In workflow:
    state = await workflow.execute_activity(
        query_parent_state_activity,
        args=[self.parent_workflow_id],
        start_to_close_timeout=timedelta(seconds=10),
    )
"""

from typing import Dict, Any, Optional
from temporalio import activity
from temporalio.client import Client
import structlog

logger = structlog.get_logger()

_temporal_client: Optional[Client] = None


def set_temporal_client(client: Client) -> None:
    """Store the Temporal client for use by activities. Called once at worker startup."""
    global _temporal_client
    _temporal_client = client


@activity.defn
async def query_parent_state_activity(parent_workflow_id: str) -> Dict[str, Any]:
    """Query a parent workflow's pause/cost-limit state via the Temporal client.

    Returns:
        Dict with is_paused and is_cost_limit_reached, or empty dict on failure.
    """
    if not _temporal_client:
        logger.error("Temporal client not set — call set_temporal_client() at worker startup")
        return {}

    try:
        handle = _temporal_client.get_workflow_handle(parent_workflow_id)
        state = await handle.query("parent_state_query")
        return state
    except Exception as e:
        logger.warning(
            "Failed to query parent state",
            parent_workflow_id=parent_workflow_id[:8],
            error=str(e),
        )
        return {}
