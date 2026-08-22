"""Attach the producing Temporal workflow generation to worker mutations."""

from typing import Any, Dict, Optional

from temporalio import activity


def current_workflow_generation() -> Optional[str]:
    """Return the Workflow ID for the activity's execution, if there is one."""
    try:
        workflow_id = activity.info().workflow_id
    except RuntimeError:
        return None
    return str(workflow_id) if workflow_id else None


def workflow_generation_headers() -> Dict[str, str]:
    """Return the generation fence header for mutations made by an activity."""
    generation = current_workflow_generation()
    return {"X-Agent-Workflow-Generation": generation} if generation else {}


def stamp_tool_workflow_generation(
    metadata: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Copy TOOL metadata and stamp its immutable producing workflow ID."""
    if metadata is None:
        return None
    stamped = dict(metadata)
    generation = current_workflow_generation()
    if generation:
        stamped["workflowGeneration"] = generation
    return stamped


class WorkflowGenerationSealed(Exception):
    """This worker's generation was replaced by a deploy; it must stop now.

    Raised when the backend answers a lifecycle write with 409. Temporal
    `terminate()` closes a workflow WITHOUT cancelling its in-flight activities,
    and the browser/explore activities have no cancellation poll — so a 409 is
    the only signal an orphaned activity ever receives that it is dead. It must
    propagate, not be swallowed: swallowing it is what let a replaced generation
    keep stepping and clobber its own chips.
    """


def raise_if_generation_sealed(status_code: int, context: str) -> None:
    """Abort the activity when the backend fenced this write as stale."""
    if status_code == 409:
        raise WorkflowGenerationSealed(
            f"{context}: workflow generation was replaced by a deploy; stopping"
        )
