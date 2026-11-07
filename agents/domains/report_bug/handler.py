"""report_bug workflow helper and its root-only exposure.

CRITICAL: All imports MUST be at module level — this runs inside the Temporal
workflow sandbox.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.report_bug.config import ACTIVITY_TIMEOUT, REPORT_BUG_USER_IDS, TOOL_NAME
from domains.report_bug.service import report_bug_activity
from temporal_connection import PRODUCTION_TEMPORAL_NAMESPACE, is_production_task_queue
from tools.base import EventType, MessageStatus, ToolEvent


def _in_production() -> bool:
    """This workflow runs on production Temporal (namespace + queue; deterministic, no env read).

    Dev, devbox and benchmark stacks are refused the production namespace
    (temporal_connection.production_namespace_refusal), so their reports are only saved.
    """
    if not workflow.in_workflow():
        return False
    info = workflow.info()
    return info.namespace == PRODUCTION_TEMPORAL_NAMESPACE and is_production_task_queue(info.task_queue)


def can_report_bug(workflow_instance: Any) -> bool:
    """A real-world root agent whose owner may use Report Bug (any stack; see report_bug)."""
    return (
        int(getattr(workflow_instance, "depth", 0) or 0) == 0
        and not getattr(workflow_instance, "parent_workflow_id", None)
        and getattr(workflow_instance, "world_model_mode", "real") == "real"
        and getattr(workflow_instance, "user_id", None) in REPORT_BUG_USER_IDS
    )


def with_report_bug(tools: Sequence[str], workflow_instance: Any) -> List[str]:
    """``tools`` plus report_bug (ahead of attempt_completion) when this agent may report."""
    names = list(tools)
    if TOOL_NAME in names or not can_report_bug(workflow_instance):
        return names
    at = names.index("attempt_completion") if "attempt_completion" in names else len(names)
    return [*names[:at], TOOL_NAME, *names[at:]]


def _result_text(result: Dict[str, Any], description: str) -> str:
    """Truthful tool result: the filed or saved report (full description), or the run's earlier one."""
    title = str(result.get("name") or "bug report")
    run = str(result.get("run_id") or "")
    filed = (
        f'filed: "{title}" (boxes.dev run {run})'
        if result.get("mode") == "launched"
        else f'saved: "{title}" (outside production it is kept for a later /rca instead of starting one)'
    )
    if result.get("already_reported"):
        return f"This run already reported its one bug, {filed}; this description was not sent."
    # The title is cut at 60 chars; the tool card shows the whole report that was sent.
    report = f"\n\nReport sent:\n{description}"
    if result.get("mode") == "launched":
        return f"Bug report {filed}. An engineering agent will investigate it.{report}"
    return f"Bug report {filed}.{report}"


async def report_bug(workflow_instance: Any, tool_call: Dict[str, Any], tool_call_id: str) -> Tuple[MessageStatus, str]:
    """File a Rose bug for this root agent's run: launched in production, saved elsewhere."""
    description = str(tool_call.get("description") or "").strip()
    error = None
    result: Dict[str, Any] = {}
    if not can_report_bug(workflow_instance):
        error = "report_bug is only available to the root agent."
    elif not description:
        error = "`description` is required."
    else:
        try:
            result = await workflow.execute_activity(
                report_bug_activity,
                args=[workflow_instance.agent_id, workflow_instance.user_id, description, not _in_production()],
                start_to_close_timeout=ACTIVITY_TIMEOUT,
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
        except Exception as exc:
            result = {"error": str(exc)}
        if not isinstance(result, dict):
            result = {}
        if result.get("error"):
            error = f"Could not file the bug report: {result['error']}"
    if error is not None:
        status, title, text, metadata = MessageStatus.ERROR, "Bug report failed", error, None
    else:
        status, title, text = MessageStatus.FINISHED, "Reported bug", _result_text(result, description)
        metadata = {
            "bugReportTitle": result.get("name"),
            "bugReportRunId": result.get("run_id"),
            "bugReportUrl": result.get("url"),
            "bugReportMode": result.get("mode"),
            # Archived and cloud-benchmark transcripts outlive their DB; /rca reads this.
            "bugReportDescription": description,
            "alreadyReported": bool(result.get("already_reported")),
        }
    await workflow_instance._handle_tool_event(
        ToolEvent(
            type=EventType.POST_MESSAGE,
            title=title,
            message=text,
            status=status,
            **({"metadata": metadata} if metadata else {}),
        ),
        tool_call_id,
        TOOL_NAME,
    )
    return status, text
