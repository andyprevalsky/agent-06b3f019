"""Agent-to-agent tool helpers (legacy event-driven signature).

    send_message_to_agent(to, message)
        ├─ "parent" / own background task (address, path or bg id) → by id
        └─ anything else (a /root/... path, an agent id) → backend resolver
        a finished agent wakes with the message as its next task (backend);
        a finished own explore/browser/code task wakes here: its next run (same
        path) gets the message plus its previous result (_wake_background_task)
    kill_agent(to)                own task → killed here; else backend (descendants only)
    own task path: depth 0 → "/root"; otherwise resolved once via
        resolve_agent_address_activity and cached on the workflow instance.

CRITICAL: All imports MUST be at module level — this runs inside the Temporal
workflow sandbox.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.agent_messaging.config import ACTIVITY_TIMEOUT
from domains.agent_messaging.service import (
    kill_agent_activity,
    resolve_agent_address_activity,
    send_agent_message_activity,
    send_agent_message_to_address_activity,
)
from helpers.agent_addressing import ROOT_TASK_PATH
from tools.base import EventType, MessageStatus, ToolEvent


async def resolve_own_task_path(workflow_instance: Any) -> Optional[str]:
    """This agent's task path ("/root/..."), or None when it has none (pre-path agents)."""
    cached = getattr(workflow_instance, "_own_task_path", None)
    if cached is not None:
        return cached or None
    path: Optional[str] = None
    if int(getattr(workflow_instance, "depth", 0) or 0) == 0:
        path = ROOT_TASK_PATH
    else:
        try:
            resolved = await workflow.execute_activity(
                resolve_agent_address_activity,
                args=[workflow_instance.agent_id, workflow_instance.agent_id, workflow_instance.user_id],
                start_to_close_timeout=ACTIVITY_TIMEOUT,
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
        except Exception as exc:
            workflow.logger.warning(f"[agent_messaging] own task path lookup failed: {exc}")
            return None
        if isinstance(resolved, dict) and isinstance(resolved.get("path"), str):
            path = resolved["path"]
    workflow_instance._own_task_path = path or ""
    return path


def resolve_message_target(workflow_instance: Any, to: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """Locally resolvable targets: (target_agent_id, recipient_task_id, error).

    Returns (None, None, None) when the backend resolver must resolve ``to``.
    """
    to = (to or "").strip()
    if not to:
        return None, None, "`to` is required."
    if to == "parent":
        parent = getattr(workflow_instance, "parent_agent_id", None)
        if not parent:
            return None, None, "You are the root agent; you have no parent agent."
        return parent, None, None
    own_path = getattr(workflow_instance, "_own_task_path", None)
    if to == workflow_instance.agent_id or (own_path and to == own_path):
        return None, None, "You cannot send a message to yourself."
    own_task = workflow_instance._background_task_for_address(to)
    if own_task is not None and own_task.get("agent_type") == "for_each":
        return (
            None,
            None,
            "A for_each address has no inbox; message its child agents by their addresses (see your environment block).",
        )
    if own_task is not None and not own_task.get("child_workflow"):
        # In-activity agents read a parent-owned inbox addressed by the current
        # run's inbox id. A finished task's row is stored on that run's inbox
        # (never re-read) and the send wakes its next run.
        return (
            workflow_instance.agent_id,
            workflow_instance._background_inbox_address(own_task["background_task_id"]),
            None,
        )
    if own_task is not None:
        child_ids = own_task.get("child_agent_ids") or []
        if child_ids:
            return str(child_ids[0]), None, None
    return None, None, None


async def _post_result(workflow_instance: Any, tool_call_id: str, tool: str, title: str, text: str, status, **meta):
    await workflow_instance._handle_tool_event(
        ToolEvent(
            type=EventType.POST_MESSAGE,
            title=title,
            message=text,
            status=status,
            **({"metadata": meta["metadata"]} if meta.get("metadata") else {}),
        ),
        tool_call_id,
        tool,
    )
    return status, text


async def send_message_to_agent(
    workflow_instance: Any, tool_call: Dict[str, Any], tool_call_id: str
) -> Tuple[MessageStatus, str]:
    """Deliver one message to an address in this tree (path, "parent", agent id or own task)."""
    to = str(tool_call.get("to") or "").strip()
    message = str(tool_call.get("message") or "")
    target, recipient_task_id, error = resolve_message_target(workflow_instance, to)
    result: Dict[str, Any] = {}
    if error is None and not message.strip():
        error = "`message` must not be empty."
    idempotency_key = f"{workflow.info().workflow_id}:{tool_call_id}"
    if error is None:
        try:
            if target is not None:
                result = await workflow.execute_activity(
                    send_agent_message_activity,
                    args=[
                        target,
                        workflow_instance.agent_id,
                        message,
                        idempotency_key,
                        recipient_task_id,
                        workflow_instance.user_id,
                    ],
                    start_to_close_timeout=ACTIVITY_TIMEOUT,
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
            else:
                result = await workflow.execute_activity(
                    send_agent_message_to_address_activity,
                    args=[workflow_instance.agent_id, to, message, idempotency_key, workflow_instance.user_id],
                    start_to_close_timeout=ACTIVITY_TIMEOUT,
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
        except Exception as exc:
            error = f"Message delivery failed: {exc}"
        else:
            if isinstance(result, dict) and result.get("error"):
                error = f"Message delivery failed: {result['error']}"
    if error is not None:
        return await _post_result(
            workflow_instance,
            tool_call_id,
            "send_message_to_agent",
            "send_message_to_agent failed",
            error,
            MessageStatus.ERROR,
        )
    resolved = result.get("to") if isinstance(result.get("to"), dict) else {}
    target = target or resolved.get("agent_id")
    recipient_task_id = recipient_task_id or resolved.get("recipient_task_id")
    own_task = workflow_instance._background_task_for_address(to) if recipient_task_id else None
    if own_task is not None and own_task.get("status") != "running" and not own_task.get("child_workflow"):
        # Finished before (or while) the message was stored: start its next run.
        message_id = result.get("message_id") if isinstance(result.get("message_id"), str) else None
        wake = await workflow_instance._wake_background_task(
            own_task["background_task_id"],
            message,
            message_id=message_id or idempotency_key,
            sender=await resolve_own_task_path(workflow_instance),
        )
        result = {**result, "woke": bool(wake.get("woke"))}
        if not wake.get("woke"):
            result["wake_error"] = wake.get("reason")
    text = f"Message sent to {to}."
    if result.get("task_running") is False:
        text += " Note: that background task is no longer running, so it will not read this message."
    if result.get("woke") is True:
        text = (
            f"{to} had finished; this message started its next run. "
            "You will get a new FINAL_ANSWER agent message when it finishes again."
        )
    elif result.get("woke") is False:
        reason = result.get("wake_error") or "it could not be restarted"
        text = f"Message stored on {to}, but it had finished and was not woken ({reason})."
    return await _post_result(
        workflow_instance,
        tool_call_id,
        "send_message_to_agent",
        f"Message sent to {to[:40]}",
        text,
        MessageStatus.FINISHED,
        metadata=_delivery_metadata(to, message, resolved, target, recipient_task_id, result),
    )


def _delivery_metadata(
    to: str,
    message: str,
    resolved: Dict[str, Any],
    target: Optional[str],
    recipient_task_id: Optional[str],
    result: Dict[str, Any],
) -> Dict[str, Any]:
    """FE chip fields for one delivered send_message_to_agent."""
    path = resolved.get("path") or (to if to.startswith("/") else None)
    metadata: Dict[str, Any] = {
        "to": to,
        "message": message,
        "toAgentAddress": to,
        "toAgentPath": path,
        "resolvedPath": path,
        "targetAgentId": target,
        "recipientTaskId": recipient_task_id,
    }
    if isinstance(result.get("woke"), bool):
        metadata["woke"] = result["woke"]
    return metadata


def _self_address_error(workflow_instance: Any, to: str, verb: str) -> Optional[str]:
    if not to:
        return "`to` is required."
    own_path = getattr(workflow_instance, "_own_task_path", None)
    if to == workflow_instance.agent_id or (own_path and to == own_path):
        return f"You cannot {verb} yourself."
    return None


def _dict(result: Any) -> Dict[str, Any]:
    return result if isinstance(result, dict) else {}


async def kill_agent(workflow_instance: Any, tool_call: Dict[str, Any], tool_call_id: str) -> Tuple[MessageStatus, str]:
    """Kill a descendant agent and everything below it, or one of your background tasks."""
    to = str(tool_call.get("to") or "").strip()
    error = _self_address_error(workflow_instance, to, "kill")
    if error is None and to == "parent":
        error = "kill_agent only kills agents below you; you cannot kill your parent."
    text = ""
    meta: Dict[str, Any] = {"to": to}
    if error is None:
        record = workflow_instance._background_task_for_address(to)
        if record is not None:
            running = record.get("status") == "running"
            if not running:
                text = f"{to} already {record.get('status') or 'finished'}."
            else:
                await workflow_instance._kill_own_background_task(to, by={})
                text = f"Killed {to}" + (" and everything below it." if record.get("child_workflow") else ".")
            meta["killed"] = running
        else:
            idempotency_key = f"{workflow.info().workflow_id}:{tool_call_id}"
            try:
                result = _dict(
                    await workflow.execute_activity(
                        kill_agent_activity,
                        args=[workflow_instance.agent_id, to, idempotency_key, workflow_instance.user_id],
                        start_to_close_timeout=ACTIVITY_TIMEOUT,
                        retry_policy=RetryPolicy(maximum_attempts=3),
                    )
                )
            except Exception as exc:
                result = {"error": str(exc)}
            if result.get("error"):
                error = f"Could not kill {to}: {result['error']}"
            else:
                text = str(result.get("message") or f"Kill requested for {to}.")
                meta["killed"] = bool(result.get("killed"))
                resolved = result.get("to") if isinstance(result.get("to"), dict) else {}
                meta["resolvedPath"] = resolved.get("path")
                meta["targetAgentId"] = resolved.get("agent_id")
    if error is not None:
        return await _post_result(
            workflow_instance, tool_call_id, "kill_agent", "kill_agent failed", error, MessageStatus.ERROR
        )
    return await _post_result(
        workflow_instance, tool_call_id, "kill_agent", f"Killed {to[:40]}", text, MessageStatus.FINISHED, metadata=meta
    )
