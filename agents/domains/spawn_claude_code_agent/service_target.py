"""Code-agent run target: a cloud sandbox (default) or the user's Mac (C14).

A ``local`` run executes the same ws-server as the E2B template inside a folder
the user granted to the Rose Mac app, relayed through the backend. Cloud and Mac roots may explicitly select it; it never waits
for, or silently falls back to, the cloud: an unavailable Mac fails the tool
call at once with the exact text in ``config.py``.
"""

from typing import Any, Dict, Optional

import structlog
from temporalio import activity

from domains.spawn_claude_code_agent.config import (
    CODE_TARGET_CLOUD,
    CODE_TARGET_LOCAL,
    LOCAL_TARGET_DEVICE_DISCONNECTED,
    LOCAL_TARGET_DISCONNECTED_TEMPLATE,
    LOCAL_TARGET_NO_OWNED_DEVICE,
    LOCAL_TARGET_NO_OWNED_DEVICE_MESSAGE,
    LOCAL_TARGET_NOT_MAC_ORIGIN,
    LOCAL_TARGET_NOT_MAC_ORIGIN_MESSAGE,
    LOCAL_TARGET_SELECTION_REQUIRED,
    LOCAL_TARGET_SELECTION_REQUIRED_MESSAGE,
    LOCAL_TARGET_UNKNOWN_DEVICE_NAME,
)
from domains.spawn_claude_code_agent.repo import fetch_local_agent_target
from domains.spawn_claude_code_agent.types import CodeAgentTarget

logger = structlog.get_logger()


def normalize_code_target(raw: Any) -> str:
    """``local`` only when explicitly requested; anything else runs in the cloud."""
    if isinstance(raw, str) and raw.strip().lower() == CODE_TARGET_LOCAL:
        return CODE_TARGET_LOCAL
    return CODE_TARGET_CLOUD


def local_target_error(reason: Optional[str], device_name: Optional[str]) -> str:
    """The exact tool error for an unavailable local target."""
    if reason == LOCAL_TARGET_NO_OWNED_DEVICE:
        return LOCAL_TARGET_NO_OWNED_DEVICE_MESSAGE
    if reason == LOCAL_TARGET_SELECTION_REQUIRED:
        return LOCAL_TARGET_SELECTION_REQUIRED_MESSAGE
    if reason == LOCAL_TARGET_NOT_MAC_ORIGIN:
        return LOCAL_TARGET_NOT_MAC_ORIGIN_MESSAGE
    return LOCAL_TARGET_DISCONNECTED_TEMPLATE.format(device_name=device_name or LOCAL_TARGET_UNKNOWN_DEVICE_NAME)


def cloud_target() -> CodeAgentTarget:
    return {
        "target": CODE_TARGET_CLOUD,
        "available": True,
        "reason": None,
        "device_id": None,
        "device_name": None,
        "error": None,
    }


def code_agent_metadata(target: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The ``metadata.code_agent`` keys this lane owns: ``target``, ``device_name``, ``folder``."""
    if not target:
        return {"target": CODE_TARGET_CLOUD}
    metadata: Dict[str, Any] = {"target": target.get("target") or CODE_TARGET_CLOUD}
    if target.get("device_name"):
        metadata["device_name"] = target["device_name"]
    if target.get("folder"):
        metadata["folder"] = target["folder"]
    return metadata


def target_from_backend(payload: Dict[str, Any]) -> CodeAgentTarget:
    """Map the backend's agent-target answer to an activity result."""

    def _text(key: str) -> Optional[str]:
        value = payload.get(key)
        return value if isinstance(value, str) and value else None

    device_id = _text("device_id")
    device_name = _text("device_name")
    if payload.get("available") is True and device_id:
        return {
            "target": CODE_TARGET_LOCAL,
            "available": True,
            "reason": None,
            "device_id": device_id,
            "device_name": device_name,
            "error": None,
        }
    reason = _text("reason")
    if reason not in (
        LOCAL_TARGET_NOT_MAC_ORIGIN,
        LOCAL_TARGET_DEVICE_DISCONNECTED,
        LOCAL_TARGET_NO_OWNED_DEVICE,
        LOCAL_TARGET_SELECTION_REQUIRED,
    ):
        reason = LOCAL_TARGET_DEVICE_DISCONNECTED if device_id else LOCAL_TARGET_NOT_MAC_ORIGIN
    return {
        "target": CODE_TARGET_LOCAL,
        "available": False,
        "reason": reason,
        "device_id": device_id,
        "device_name": device_name,
        "error": local_target_error(reason, device_name),
    }


@activity.defn
async def resolve_code_agent_target_activity(agent_id: str, target: str) -> CodeAgentTarget:
    """Resolve the run target once, recorded in history for deterministic replay.

    A local request asks the backend which owned Mac this agent may use and whether
    its control channel is connected right now.
    """
    if normalize_code_target(target) != CODE_TARGET_LOCAL:
        return cloud_target()
    result = target_from_backend(await fetch_local_agent_target(agent_id))
    logger.info(
        "[ClaudeCode] Resolved local code-agent target",
        agent_id=agent_id,
        available=result["available"],
        reason=result["reason"],
        device_id=result["device_id"],
    )
    return result
