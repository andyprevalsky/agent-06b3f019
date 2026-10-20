"""Inspect-code data access: the backend inspection call (Temporal activity).

Idempotent by construction: the backend writes nothing outside a throwaway
sandbox that it kills, so a retry only asks the question again. A connection
failure raises (the inspection never started; the caller may retry). An HTTP
refusal or a timeout returns an error result and is not retried: a timed-out
inspection is still bounded and torn down by the backend.
"""

from __future__ import annotations

import time

import httpx
import structlog
from temporalio import activity

from config import load_config
from helpers.activity_heartbeat import safe_heartbeat
from helpers.http_client import get_http_client

from .config import INSPECT_HTTP_TIMEOUT_SECONDS
from .types import InspectResult

logger = structlog.get_logger()


@activity.defn
async def inspect_code_activity(
    code_session_id: str,
    question: str,
    user_id: str,
    agent_id: str,
) -> InspectResult:
    """POST /api/claude-code-session/code-sessions/:id/inspect for the caller's user."""
    config = load_config()
    base = config.backend.api_url.rstrip("/")
    safe_heartbeat(f"Inspecting code session {code_session_id}")
    started = time.monotonic()
    try:
        response = await get_http_client().post(
            f"{base}/api/claude-code-session/code-sessions/{code_session_id}/inspect",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
                "Content-Type": "application/json",
            },
            json={"agent_id": agent_id, "question": question, "user_id": user_id},
            timeout=INSPECT_HTTP_TIMEOUT_SECONDS,
        )
    except httpx.TimeoutException:
        logger.warning("[InspectCode] backend call timed out", code_session_id=code_session_id, agent_id=agent_id)
        return {
            "error": f"The code inspection did not finish within {INSPECT_HTTP_TIMEOUT_SECONDS} seconds.",
            "code": "CODE_INSPECT_TIMEOUT",
            "http_status": None,
        }
    duration_ms = int((time.monotonic() - started) * 1000)
    try:
        payload = response.json() if response.content else {}
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    logger.info(
        "[InspectCode] POST code-sessions/:id/inspect",
        code_session_id=code_session_id,
        agent_id=agent_id,
        status=response.status_code,
        duration_ms=duration_ms,
        inspect_status=payload.get("status"),
        startup_ms=(payload.get("timings") or {}).get("startup_ms")
        if isinstance(payload.get("timings"), dict)
        else None,
    )
    if response.status_code >= 400:
        return {
            "error": str(payload.get("error") or f"HTTP {response.status_code}")[:500],
            "code": payload.get("code"),
            "http_status": response.status_code,
        }
    return payload
