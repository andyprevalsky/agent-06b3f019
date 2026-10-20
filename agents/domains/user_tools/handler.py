"""User tools domain handler - workflow-side pinning and execution.

Runs inside the AgentWorkflow sandbox: only deterministic code here; all I/O is
in the activities re-exported by the service layer.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict, List, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

from tools.base import (
    EventType,
    MessageStatus,
    ToolEvent,
    extract_root_error,
    format_error_message,
    format_tool_message,
)
from utils.user_tool_models import find_user_tool_spec, sorted_user_tool_specs

from .config import RESOLVE_ACTIVITY_MAX_ATTEMPTS, RESOLVE_ACTIVITY_TIMEOUT_SECONDS
from .service import (
    RUN_ACTIVITY_MAX_ATTEMPTS,
    empty_pinned,
    resolve_user_tools_activity,
    run_activity_timeout_seconds,
    run_user_tool_activity,
    user_tool_call_key,
)

logger = structlog.get_logger()


def declared_user_tools(workflow_instance: Any) -> List[Dict[str, Any]]:
    """Pinned specs to declare to the LLM (sorted; empty for sub-agents)."""
    pinned = getattr(workflow_instance, "user_tools", None) or {}
    return sorted_user_tool_specs(pinned.get("tools") if isinstance(pinned, dict) else None)


async def pin_user_tools(workflow_instance: Any, *, is_root: bool, wf_api: Any = workflow) -> None:
    """Resolve the user's published tools once per run (root agents only).

    Idempotent across continue_as_new: a restored pin (``user_tools_pinned``) is
    kept, so a version published mid-run never changes the declared set.
    A resolution failure leaves the agent without user tools rather than
    failing the run. ``wf_api`` is the caller's ``temporalio.workflow`` binding.
    """
    if getattr(workflow_instance, "user_tools_pinned", False):
        return
    if not is_root:
        workflow_instance.user_tools = empty_pinned("sub-agents do not get user tools in v1")
        workflow_instance.user_tools_pinned = True
        return
    try:
        pinned = await wf_api.execute_activity(
            resolve_user_tools_activity,
            args=[workflow_instance.agent_id, workflow_instance.user_id],
            start_to_close_timeout=timedelta(seconds=RESOLVE_ACTIVITY_TIMEOUT_SECONDS),
            retry_policy=RetryPolicy(maximum_attempts=RESOLVE_ACTIVITY_MAX_ATTEMPTS),
        )
    except ActivityError as exc:
        reason = extract_root_error(exc)
        logger.warning("[UserTools] resolution failed; continuing without user tools", error=reason[:200])
        pinned = empty_pinned(f"resolution failed: {reason[:200]}")
    workflow_instance.user_tools = pinned if isinstance(pinned, dict) else empty_pinned()
    workflow_instance.user_tools_pinned = True
    names = [spec.get("name") for spec in declared_user_tools(workflow_instance)]
    logger.info("[UserTools] pinned", version_id=workflow_instance.user_tools.get("version_id"), tools=names)


def _visible_params(tool_args: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in (tool_args or {}).items() if not str(key).startswith("_")}


async def run_user_tool(
    workflow_instance: Any,
    tool_name: str,
    tool_args: Dict[str, Any],
    tool_call_id: str,
    *,
    wf_api: Any = workflow,
) -> Dict[str, Any]:
    """Execute a pinned user tool and post its TOOL message.

    catch → format → emit error event → return an error dict (never raise).
    """
    pinned = getattr(workflow_instance, "user_tools", None) or {}
    spec: Optional[Dict[str, Any]] = find_user_tool_spec(pinned.get("tools"), tool_name)
    params = _visible_params(tool_args)
    started = wf_api.now()

    async def _emit_error(message: str, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        elapsed = (wf_api.now() - started).total_seconds()
        await workflow_instance._handle_tool_event(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"❌ {tool_name} failed",
                message=format_error_message(params, RuntimeError(message), elapsed),
                status=MessageStatus.ERROR,
                metadata={"userTool": {"name": tool_name, "versionId": pinned.get("version_id"), **(extra or {})}},
            ),
            tool_call_id,
            tool_name,
        )
        return {"error": True, "message": message}

    if spec is None:
        return await _emit_error(f"User tool {tool_name} is not available in this run's pinned tool set")

    source_name = str(spec.get("source_name") or tool_name)
    version_id = pinned.get("version_id")
    await workflow_instance._handle_tool_event(
        ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Running {source_name}",
            message="",
            status=MessageStatus.IN_PROGRESS,
            metadata={"userTool": {"name": tool_name, "versionId": version_id}},
        ),
        tool_call_id,
        tool_name,
    )
    activity_args: List[Any] = [
        workflow_instance.agent_id,
        workflow_instance.user_id,
        version_id,
        source_name,
        params,
        pinned.get("base_url"),
        spec,
    ]
    if spec.get("side_effects") is True:
        # Stable across activity retries, workflow replay and continue_as_new
        # (same workflow id, same tool call id), so a retry finds the stored result.
        activity_args.append(user_tool_call_key(wf_api.info().workflow_id, tool_call_id))
    try:
        outcome = await wf_api.execute_activity(
            run_user_tool_activity,
            args=activity_args,
            start_to_close_timeout=timedelta(seconds=run_activity_timeout_seconds(spec.get("timeout_s"))),
            retry_policy=RetryPolicy(maximum_attempts=RUN_ACTIVITY_MAX_ATTEMPTS),
        )
    except ActivityError as exc:
        outcome = {"ok": False, "error_kind": "activity", "error": extract_root_error(exc)}

    if not isinstance(outcome, dict) or not outcome.get("ok"):
        outcome = outcome if isinstance(outcome, dict) else {}
        return await _emit_error(
            str(outcome.get("error") or "user tool failed"),
            {"errorKind": outcome.get("error_kind")},
        )

    result = outcome.get("result") or {}
    elapsed = (wf_api.now() - started).total_seconds()
    metadata: Dict[str, Any] = {"userTool": {"name": tool_name, "versionId": version_id}}
    inline_view = outcome.get("inline_view")
    if isinstance(inline_view, dict):
        metadata["inlineView"] = inline_view
    await workflow_instance._handle_tool_event(
        ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"{source_name} complete",
            message=format_tool_message(params, result, elapsed, 0),
            status=MessageStatus.FINISHED,
            metadata=metadata,
        ),
        tool_call_id,
        tool_name,
    )
    return {"success": True, "message": f"{tool_name} completed", "result": result}
