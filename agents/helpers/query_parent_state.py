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
        start_to_close_timeout=timedelta(seconds=60),
    )
"""

from typing import Any, Dict, Optional

import structlog
from temporalio import activity
from temporalio.client import Client, WorkflowExecutionStatus
from temporalio.service import RPCError, RPCStatusCode

logger = structlog.get_logger()

_temporal_client: Optional[Client] = None

# A parent in any of these states will never run again, so a child that inherited
# its pause from that parent is orphaned and must stop waiting for it. RUNNING and
# CONTINUED_AS_NEW mean the parent (or its continuation, same workflow id) is still
# live and queryable, so a query failure against them is transient.
_TERMINAL_PARENT_STATUSES = frozenset(
    {
        WorkflowExecutionStatus.COMPLETED,
        WorkflowExecutionStatus.FAILED,
        WorkflowExecutionStatus.CANCELED,
        WorkflowExecutionStatus.TERMINATED,
        WorkflowExecutionStatus.TIMED_OUT,
    }
)


def set_temporal_client(client: Client) -> None:
    """Store the Temporal client for use by activities. Called once at worker startup."""
    global _temporal_client
    _temporal_client = client


@activity.defn
async def query_parent_state_activity(parent_workflow_id: str) -> Dict[str, Any]:
    """Query a parent workflow's pause/cost-limit state via the Temporal client.

    Returns one of:
        {is_paused, is_cost_limit_reached, ...}  — parent is live and queryable
        {"parent_missing": True}                  — parent is gone (terminal / not found);
                                                    the caller should treat inheriting
                                                    children as orphaned and terminate them
        {}                                        — transient failure; caller keeps state

    Distinguishing "parent gone" from "transient blip" matters: a child that
    inherited a pause from its parent only unpauses when the parent reports
    running. If the parent is terminated the query fails forever, so without this
    signal the child stays paused indefinitely (busy-spin livelock).
    """
    if not _temporal_client:
        logger.error("Temporal client not set — call set_temporal_client() at worker startup")
        return {}

    handle = _temporal_client.get_workflow_handle(parent_workflow_id)
    try:
        state = await handle.query("parent_state_query")
        return state if isinstance(state, dict) else {}
    except Exception as query_err:
        # Query failed. Determine whether the parent is genuinely gone (orphan the
        # child) or merely transiently unreachable (keep waiting, retry later) by
        # describing the execution — describe works on closed workflows too.
        try:
            description = await handle.describe()
        except RPCError as desc_err:
            if desc_err.status == RPCStatusCode.NOT_FOUND:
                logger.info(
                    "Parent workflow not found — orphaned",
                    parent_workflow_id=parent_workflow_id[:8],
                )
                return {"parent_missing": True}
            logger.warning(
                "Parent state query failed; describe transient",
                parent_workflow_id=parent_workflow_id[:8],
                error=str(desc_err),
            )
            return {}
        except Exception as desc_err:
            logger.warning(
                "Parent state query failed; describe errored",
                parent_workflow_id=parent_workflow_id[:8],
                error=str(desc_err),
            )
            return {}

        if description.status in _TERMINAL_PARENT_STATUSES:
            logger.info(
                "Parent workflow terminal — orphaned",
                parent_workflow_id=parent_workflow_id[:8],
                status=getattr(description.status, "name", str(description.status)),
            )
            return {"parent_missing": True}

        # Parent is still RUNNING/CONTINUED_AS_NEW but the query itself failed — transient.
        logger.warning(
            "Parent running but state query failed (transient)",
            parent_workflow_id=parent_workflow_id[:8],
            error=str(query_err),
        )
        return {}
