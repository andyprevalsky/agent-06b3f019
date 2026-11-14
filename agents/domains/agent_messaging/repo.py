"""Data access for the agent-messaging domain.

    fetch_agent_tree               ──▶ GET  /api/agents/<self>/tree             (bounded view)
    resolve_agent_address          ──▶ GET  /api/agents/<self>/resolve-address  (one resolver)
    post_agent_message_to_address  ──▶ POST /api/agents/<self>/send-agent-message
    post_agent_message             ──▶ POST /api/agents/<target>/agent-messages (same-tree auth, idempotent)
    post_kill_agent                ──▶ POST /api/agents/<self>/kill-agent         (descendants only)
    fetch_project_agents           ──▶ GET  /api/data/project-agents             (own + team-shared projects)

Ownership and same-tree checks live in the backend.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import structlog

from config import load_config
from domains.agent_messaging.config import AGENT_MESSAGING_TIMEOUT_SECONDS, ERROR_TEXT_MAX_LEN
from helpers.http_client import get_http_client

logger = structlog.get_logger()


def _headers(user_id: Optional[str]) -> Dict[str, str]:
    config = load_config()
    if not config.backend.api_key:
        raise RuntimeError("BACKEND_API_KEY not configured")
    headers = {"X-API-Key": config.backend.api_key, "Content-Type": "application/json"}
    if user_id:
        headers["X-User-Id"] = user_id
    return headers


def _api_url(path: str) -> str:
    return f"{load_config().backend.api_url.rstrip('/')}{path}"


def _error_text(response: Any) -> str:
    try:
        body = response.json()
    except ValueError:
        return (response.text or "")[:ERROR_TEXT_MAX_LEN]
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return body["error"][:ERROR_TEXT_MAX_LEN]
    return str(body)[:ERROR_TEXT_MAX_LEN]


async def fetch_agent_tree(agent_id: str, user_id: Optional[str], params: Dict[str, str]) -> Dict[str, Any]:
    """One bounded tree view; 4xx answers return ``{"error", "status"}`` so the model sees why."""
    response = await get_http_client().get(
        _api_url(f"/api/agents/{agent_id}/tree"),
        params=params,
        headers=_headers(user_id),
        timeout=AGENT_MESSAGING_TIMEOUT_SECONDS,
    )
    logger.info("[AgentMessaging] tree listed", agent_id=agent_id, params=params, status=response.status_code)
    if 400 <= response.status_code < 500:
        return {"error": _error_text(response), "status": response.status_code}
    response.raise_for_status()
    body = response.json() or {}
    return body if isinstance(body, dict) else {}


async def fetch_project_agents(user_id: Optional[str], params: Dict[str, str]) -> Dict[str, Any]:
    """Metadata-only agents in own and team-shared projects; 4xx answers return ``{"error", "status"}``."""
    response = await get_http_client().get(
        _api_url("/api/data/project-agents"),
        params=params,
        headers=_headers(user_id),
        timeout=AGENT_MESSAGING_TIMEOUT_SECONDS,
    )
    logger.info("[AgentMessaging] project agents listed", params=params, status=response.status_code)
    if 400 <= response.status_code < 500:
        return {"error": _error_text(response), "status": response.status_code}
    response.raise_for_status()
    body = response.json() or {}
    return body if isinstance(body, dict) else {}


async def resolve_agent_address(agent_id: str, address: str, user_id: Optional[str]) -> Dict[str, Any]:
    """``{"agent_id", "recipient_task_id", "path", "type"}`` or ``{"error", "status"}`` on 4xx."""
    response = await get_http_client().get(
        _api_url(f"/api/agents/{agent_id}/resolve-address"),
        params={"address": address},
        headers=_headers(user_id),
        timeout=AGENT_MESSAGING_TIMEOUT_SECONDS,
    )
    logger.info("[AgentMessaging] address resolved", agent_id=agent_id, address=address, status=response.status_code)
    if 400 <= response.status_code < 500:
        return {"error": _error_text(response), "status": response.status_code}
    response.raise_for_status()
    body = response.json() or {}
    return body if isinstance(body, dict) else {}


async def post_agent_message_to_address(
    from_agent_id: str, payload: Dict[str, Any], user_id: Optional[str]
) -> Dict[str, Any]:
    """POST one path-addressed message; 4xx answers are returned (not raised)."""
    response = await get_http_client().post(
        _api_url(f"/api/agents/{from_agent_id}/send-agent-message"),
        json=payload,
        headers=_headers(user_id),
        timeout=AGENT_MESSAGING_TIMEOUT_SECONDS,
    )
    logger.info(
        "[AgentMessaging] message sent by address",
        from_agent_id=from_agent_id,
        to=payload.get("to"),
        status=response.status_code,
    )
    if 400 <= response.status_code < 500:
        return {"delivered": False, "error": _error_text(response), "status": response.status_code}
    response.raise_for_status()
    return _delivery(response.json() or {})


async def post_agent_message(target_agent_id: str, payload: Dict[str, Any], user_id: Optional[str]) -> Dict[str, Any]:
    """POST one agent message. 4xx answers are returned (not raised) so the model sees why."""
    response = await get_http_client().post(
        _api_url(f"/api/agents/{target_agent_id}/agent-messages"),
        json=payload,
        headers=_headers(user_id),
        timeout=AGENT_MESSAGING_TIMEOUT_SECONDS,
    )
    logger.info(
        "[AgentMessaging] message sent",
        target_agent_id=target_agent_id,
        from_agent_id=payload.get("from_agent_id"),
        recipient_task_id=payload.get("recipient_task_id"),
        status=response.status_code,
    )
    if 400 <= response.status_code < 500:
        return {"delivered": False, "error": _error_text(response), "status": response.status_code}
    response.raise_for_status()
    return _delivery(response.json() or {})


def _delivery(body: Dict[str, Any]) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "delivered": bool(body.get("delivered", True)),
        "message_id": body.get("message_id"),
        "task_running": body.get("task_running"),
        "to": body.get("to") if isinstance(body.get("to"), dict) else None,
    }
    if body.get("queued") is True:
        result["queued"] = True
        if body.get("queued_reason") == "direct_hold":
            result["queued_reason"] = "direct_hold"
    if isinstance(body.get("woke"), bool):
        result["woke"] = body["woke"]
    if isinstance(body.get("wake_error"), str):
        result["wake_error"] = body["wake_error"][:ERROR_TEXT_MAX_LEN]
    return result


async def _send(method: str, path: str, *, user_id: Optional[str], **kwargs: Any) -> Any:
    client = get_http_client()
    call = client.post if method == "POST" else client.get
    return await call(_api_url(path), headers=_headers(user_id), timeout=AGENT_MESSAGING_TIMEOUT_SECONDS, **kwargs)


async def post_kill_agent(from_agent_id: str, payload: Dict[str, Any], user_id: Optional[str]) -> Dict[str, Any]:
    """POST one kill request; ``{"killed", "status", "to", "message"}`` or ``{"error", "status"}``."""
    response = await _send("POST", f"/api/agents/{from_agent_id}/kill-agent", user_id=user_id, json=payload)
    logger.info(
        "[AgentMessaging] kill sent", from_agent_id=from_agent_id, to=payload.get("to"), status=response.status_code
    )
    if 400 <= response.status_code < 500:
        return {"error": _error_text(response), "status": response.status_code}
    response.raise_for_status()
    body = response.json() or {}
    return body if isinstance(body, dict) else {}
